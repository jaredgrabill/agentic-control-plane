"""Agent: manifest binding + capability handlers + runtime. You never
touch transport (paved-road.md) — work arrives as Temporal activities on
this agent's task queue, and the SDK owns the polyglot contract with the
orchestrator."""

import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import structlog
import yaml
from acp_protocol import validate, validation_errors
from jsonschema import Draft202012Validator
from opentelemetry import trace
from temporalio.exceptions import ApplicationError

from acp_agent_sdk.answer import AnswerBuilder
from acp_agent_sdk.context import CapabilityContext
from acp_agent_sdk.errors import CapabilityError, ErrorClass
from acp_agent_sdk.model import (
    ContextualModel,
    FakeModel,
    ModelCallContext,
    ModelClient,
    ModelResponse,
)
from acp_agent_sdk.retriever import Retriever
from acp_agent_sdk.telemetry import configure_logging

Handler = Callable[[CapabilityContext, dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass
class _CountingModel:
    """Wraps the configured model so usage lands in the StepResult."""

    inner: ModelClient
    llm_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    # Last non-None resolved model id across completions (v0 last-write-wins).
    model: str | None = None

    async def complete(self, prompt: str, *, max_tokens: int = 1024) -> ModelResponse:
        self.llm_calls += 1
        response = await self.inner.complete(prompt, max_tokens=max_tokens)
        self.input_tokens += response.input_tokens
        self.output_tokens += response.output_tokens
        self.cache_read_tokens += response.cache_read_tokens
        self.cache_write_tokens += response.cache_write_tokens
        if response.model is not None:
            self.model = response.model
        return response


@dataclass
class Agent:
    """One agent = manifest + handlers + tool bindings + eval suite."""

    manifest: dict[str, Any]
    # Mutable: run() installs a GatewayModel when none was configured.
    model: ModelClient | None = None
    retriever: Retriever | None = None
    handlers: dict[str, Handler] = field(default_factory=dict)

    def __post_init__(self) -> None:
        configure_logging()
        self.log: structlog.stdlib.BoundLogger = structlog.get_logger(self.manifest["id"])
        # Lazy unit-test fallback: an unconfigured, unserved agent still fakes.
        self._fallback_fake: FakeModel | None = None

    @classmethod
    def from_manifest(
        cls,
        manifest_path: str | Path,
        *,
        model: ModelClient | None = None,
        retriever: Retriever | None = None,
    ) -> "Agent":
        raw = yaml.safe_load(Path(manifest_path).read_text(encoding="utf-8"))
        validate("agent-manifest", raw)
        return cls(manifest=raw, model=model, retriever=retriever)

    @property
    def agent_id(self) -> str:
        agent_id: str = self.manifest["id"]
        return agent_id

    @property
    def task_queue(self) -> str:
        return f"agent-{self.agent_id}"

    def capability(self, name: str) -> Callable[[Handler], Handler]:
        """Registers the handler for a manifest-declared capability."""
        declared = {c["name"] for c in self.manifest["capabilities"]}
        if name not in declared:
            raise ValueError(
                f"capability {name} is not declared in the manifest for {self.agent_id} — "
                f"declared: {', '.join(sorted(declared))}. Add it to manifest.yaml first; "
                "the manifest is the contract."
            )
        if name in self.handlers:
            raise ValueError(f"capability {name} already has a handler")

        def register(handler: Handler) -> Handler:
            self.handlers[name] = handler
            return handler

        return register

    def assert_complete(self) -> None:
        """Every declared capability must have a handler before serving."""
        missing = [
            c["name"] for c in self.manifest["capabilities"] if c["name"] not in self.handlers
        ]
        if missing:
            raise RuntimeError(
                f"manifest declares capabilities with no handler: {', '.join(missing)}"
            )

    async def execute(self, request: dict[str, Any]) -> dict[str, Any]:
        """The execute_capability activity body: StepRequest → StepResult.

        Output is validated against the capability's declared
        output_schema with one structured-repair retry, then the step
        fails typed — never a best-effort parse (orchestration.md).
        """
        errors = validation_errors("task-contract", request, "#/$defs/step_request")
        if errors:
            raise ApplicationError(
                f"malformed StepRequest: {'; '.join(errors)}", type="Permanent", non_retryable=True
            )
        capability = request["capability"]
        handler = self.handlers.get(capability)
        if handler is None:
            return self._failed(
                request,
                CapabilityError(
                    ErrorClass.PERMANENT,
                    f"agent {self.agent_id} has no handler for {capability}",
                ),
            )

        # A contextual model (the GatewayModel) is bound to THIS step's
        # delegated identity + correlation before it reaches the handler;
        # FakeModel is not contextual, so unit tests see zero change.
        base: ModelClient
        if self.model is not None:
            base = self.model
        else:
            if self._fallback_fake is None:
                self._fallback_fake = FakeModel()
            base = self._fallback_fake
        if isinstance(base, ContextualModel):
            base = base.with_call_context(
                ModelCallContext(
                    task_id=request["task_id"],
                    step_id=request["step_id"],
                    tenant=request["tenant"],
                    capability=capability,
                    delegated_token=request.get("delegated_token"),
                )
            )

        counting = _CountingModel(base)
        ctx = CapabilityContext(
            tenant=request["tenant"],
            task_id=request["task_id"],
            step_id=request["step_id"],
            capability=capability,
            delegated_token=request.get("delegated_token"),
            budget=request.get("budget"),
            model=counting,
            _retriever=self.retriever,
            log=self.log.bind(task_id=request["task_id"], step_id=request["step_id"]),
        )

        tracer = trace.get_tracer("acp-agent-sdk")
        with tracer.start_as_current_span(f"invoke_agent {capability}") as span:
            span.set_attributes(
                {
                    "gen_ai.operation.name": "invoke_agent",
                    "gen_ai.agent.name": self.agent_id,
                    "acp.tenant": request["tenant"],
                    "acp.task_id": request["task_id"],
                    "acp.capability": capability,
                }
            )
            try:
                output = await self._execute_validated(handler, ctx, request)
            except CapabilityError as err:
                if err.error_class is ErrorClass.RETRYABLE:
                    # Temporal owns retries; surface as a retryable failure.
                    raise ApplicationError(str(err), type="Retryable") from err
                span.set_attribute("acp.step_status", "failed")
                return self._failed(request, err, counting)
            span.set_attribute("acp.step_status", "completed")

        return {
            "kind": "step_result",
            "step_id": request["step_id"],
            "task_id": request["task_id"],
            "tenant": request["tenant"],
            "status": "completed",
            "output": output,
            "usage": self._usage(counting),
        }

    async def _execute_validated(
        self, handler: Handler, ctx: CapabilityContext, request: dict[str, Any]
    ) -> dict[str, Any]:
        declared = next(c for c in self.manifest["capabilities"] if c["name"] == ctx.capability)
        validator = Draft202012Validator(declared["output_schema"])
        output = await handler(ctx, request.get("input", {}))
        violations = [e.message for e in validator.iter_errors(output)]
        if not violations:
            return output
        ctx.log.warning(
            "output failed schema validation; structured-repair retry", errors=violations
        )
        output = await handler(ctx, request.get("input", {}))
        violations = [e.message for e in validator.iter_errors(output)]
        if violations:
            raise CapabilityError(
                ErrorClass.PERMANENT,
                f"handler output does not conform to the declared output_schema after one repair "
                f"retry: {'; '.join(violations[:3])}",
            )
        return output

    def _failed(
        self,
        request: dict[str, Any],
        err: CapabilityError,
        counting: _CountingModel | None = None,
    ) -> dict[str, Any]:
        result: dict[str, Any] = {
            "kind": "step_result",
            "step_id": request["step_id"],
            "task_id": request["task_id"],
            "tenant": request["tenant"],
            "status": "failed",
            "error": err.to_protocol(),
        }
        if counting is not None:
            result["usage"] = self._usage(counting)
        return result

    @staticmethod
    def _usage(counting: _CountingModel) -> dict[str, int | str]:
        # Cache tokens and model id are emitted only when present, keeping
        # zero-LLM usage byte-identical to before the cache fields existed and
        # matching the TypeScript SDK's usageOf().
        usage: dict[str, int | str] = {
            "llm_calls": counting.llm_calls,
            "input_tokens": counting.input_tokens,
            "output_tokens": counting.output_tokens,
        }
        if counting.cache_read_tokens > 0:
            usage["cache_read_tokens"] = counting.cache_read_tokens
        if counting.cache_write_tokens > 0:
            usage["cache_write_tokens"] = counting.cache_write_tokens
        if counting.model is not None:
            usage["model"] = counting.model
        return usage

    def answer_builder(self) -> AnswerBuilder:
        return AnswerBuilder()

    async def run(self) -> None:  # pragma: no cover — needs live Temporal+NATS; E2E covers it
        """Serves this agent's task queue until cancelled."""
        from nats.aio.client import Client as NatsClient
        from temporalio.client import Client as TemporalClient
        from temporalio.contrib.opentelemetry import TracingInterceptor
        from temporalio.worker import Worker

        from acp_agent_sdk.bus import BusTokenSource
        from acp_agent_sdk.retriever import NatsRetriever, TokenExchanger
        from acp_agent_sdk.telemetry import configure_tracing

        self.assert_complete()
        configure_tracing(self.agent_id)

        # A served agent with no configured model completes through the LLM
        # Gateway on its manifest's first allowed class (the NatsRetriever
        # precedent). Unit-tested agents keep the FakeModel fallback.
        if self.model is None:
            from acp_agent_sdk.gateway_model import GatewayModel

            allowed = (self.manifest.get("models") or {}).get("allowed") or []
            self.model = GatewayModel(
                url=os.environ.get("ACP_LLM_GATEWAY_URL", "http://localhost:7107"),
                model_class=allowed[0] if allowed else "default-tier",
            )

        if self.retriever is None:
            token_url = os.environ.get("ACP_TOKEN_URL", "http://localhost:7101")
            client_id = os.environ.get("ACP_AGENT_CLIENT_ID", f"agent-{self.agent_id}")
            client_secret = os.environ["ACP_AGENT_CLIENT_SECRET"]
            # Item 0c: the bus identity is minted from a platform JWT via the
            # auth callout — no static NATS user. A background refresh keeps
            # the token live and pushes each new one onto the connection so a
            # reconnect presents a fresh credential.
            bus_tokens = BusTokenSource(
                token_url=token_url, client_id=client_id, client_secret=client_secret
            )
            await bus_tokens.start()
            nc = NatsClient()

            def _update_token(token: str) -> None:
                nc.options["token"] = token

            bus_tokens.on_refresh = _update_token
            await nc.connect(
                servers=os.environ.get("ACP_NATS_URL", "nats://localhost:4222"),
                token=bus_tokens.token(),
            )
            self.retriever = NatsRetriever(
                nc=nc,
                exchanger=TokenExchanger(
                    token_url=token_url,
                    client_id=client_id,
                    client_secret=client_secret,
                ),
            )

        client = await TemporalClient.connect(
            os.environ.get("ACP_TEMPORAL_ADDRESS", "localhost:7233"),
            namespace=os.environ.get("ACP_TEMPORAL_NAMESPACE", "default"),
            interceptors=[TracingInterceptor()],
        )

        async def execute_capability(request: dict[str, Any]) -> dict[str, Any]:
            return await self.execute(request)

        from temporalio import activity as temporal_activity

        activity_impl = temporal_activity.defn(name="execute_capability")(execute_capability)

        worker = Worker(
            client,
            task_queue=self.task_queue,
            activities=[activity_impl],
            interceptors=[TracingInterceptor()],
        )
        self.log.info("agent worker serving", task_queue=self.task_queue)
        await worker.run()
