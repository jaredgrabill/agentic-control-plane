"""GatewayModel against httpx.MockTransport: the prompt layout it emits,
the normative error mapping (429/5xx -> RETRYABLE, 403 -> POLICY_DENIED,
other 4xx -> PERMANENT), and the with_call_context() binding through
Agent.execute() — including proof the FakeModel path is untouched."""

import json
from typing import Any

import httpx
import pytest
from acp_agent_sdk import (
    Agent,
    CapabilityContext,
    CapabilityError,
    ContextualModel,
    ErrorClass,
    FakeModel,
    GatewayModel,
    ModelCallContext,
)

from .conftest import MANIFEST, step_request

CONTEXT = ModelCallContext(
    task_id="0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40",
    step_id="0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44",
    tenant="acme",
    capability="test.echo",
    delegated_token="delegated-jwt",
)


def gateway_response(text: str = "gateway says hi") -> dict[str, Any]:
    return {
        "text": text,
        "model_class": "default-tier",
        "model": "dev-echo@1",
        "provider": "dev",
        "model_classes_version": "2026.07",
        "usage": {
            "input_tokens": 10,
            "output_tokens": 4,
            "cache_read_input_tokens": 30,
            "cache_creation_input_tokens": 5,
        },
        "attempts": [{"provider": "dev", "model": "dev-echo@1", "outcome": "ok", "duration_ms": 2}],
    }


def transport_returning(
    status: int, body: dict[str, Any], recorded: list[httpx.Request] | None = None
) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if recorded is not None:
            recorded.append(request)
        return httpx.Response(status, json=body)

    return httpx.MockTransport(handler)


def bound_model(
    transport: httpx.MockTransport,
    static_prefix: list[dict[str, str]] | None = None,
) -> GatewayModel:
    return GatewayModel(
        url="http://gateway.test",
        model_class="default-tier",
        static_prefix=static_prefix,
        transport=transport,
        context=CONTEXT,
    )


class TestComplete:
    async def test_sends_static_prefix_and_prompt_as_variable_tail(self) -> None:
        recorded: list[httpx.Request] = []
        model = bound_model(
            transport_returning(200, gateway_response(), recorded),
            static_prefix=[{"role": "system", "text": "You are the test agent."}],
        )
        response = await model.complete("what changed?", max_tokens=256)

        request = recorded[0]
        assert str(request.url) == "http://gateway.test/v1/complete"
        assert request.headers["authorization"] == "Bearer delegated-jwt"
        assert request.headers["x-acp-task-id"] == CONTEXT.task_id
        assert request.headers["x-acp-step-id"] == CONTEXT.step_id
        assert json.loads(request.content) == {
            "model_class": "default-tier",
            "prompt": {
                "static": [{"role": "system", "text": "You are the test agent."}],
                "variable": [{"role": "user", "text": "what changed?"}],
            },
            "max_tokens": 256,
            "metadata": {
                "task_id": CONTEXT.task_id,
                "step_id": CONTEXT.step_id,
                "capability": "test.echo",
                "purpose": "agent",
            },
        }

        assert response.text == "gateway says hi"
        # Cache reads/writes are real processed input — the budget counts them.
        assert response.input_tokens == 45
        assert response.output_tokens == 4
        assert response.model == "dev-echo@1"

    async def test_defaults_max_tokens_and_empty_prefix(self) -> None:
        recorded: list[httpx.Request] = []
        await bound_model(transport_returning(200, gateway_response(), recorded)).complete("q")
        body = json.loads(recorded[0].content)
        assert body["max_tokens"] == 1024
        assert body["prompt"]["static"] == []

    async def test_unbound_model_fails_permanent(self) -> None:
        unbound = GatewayModel(
            url="http://gateway.test",
            model_class="default-tier",
            transport=transport_returning(200, gateway_response()),
        )
        with pytest.raises(CapabilityError, match="not bound to a call context") as exc:
            await unbound.complete("q")
        assert exc.value.error_class is ErrorClass.PERMANENT

    async def test_maps_429_and_5xx_to_retryable(self) -> None:
        limited = bound_model(
            transport_returning(
                429,
                {
                    "error": {
                        "class": "rate_limited",
                        "message": "every binding 429",
                        "status": 429,
                        "retry_after_s": 3,
                    }
                },
            )
        )
        with pytest.raises(CapabilityError, match="every binding 429") as exc:
            await limited.complete("q")
        assert exc.value.error_class is ErrorClass.RETRYABLE
        assert exc.value.details is not None
        assert exc.value.details["retry_after_s"] == 3

        down = bound_model(
            transport_returning(
                503,
                {
                    "error": {
                        "class": "unavailable",
                        "message": "all bindings failed",
                        "status": 503,
                    }
                },
            )
        )
        with pytest.raises(CapabilityError) as exc2:
            await down.complete("q")
        assert exc2.value.error_class is ErrorClass.RETRYABLE

    async def test_maps_403_to_policy_denied_and_other_4xx_to_permanent(self) -> None:
        denied = bound_model(
            transport_returning(
                403,
                {
                    "error": {
                        "class": "model_not_allowed",
                        "message": "not in models.allowed",
                        "status": 403,
                    }
                },
            )
        )
        with pytest.raises(CapabilityError, match="not in models.allowed") as exc:
            await denied.complete("q")
        assert exc.value.error_class is ErrorClass.POLICY_DENIED

        bad = bound_model(
            transport_returning(
                400,
                {
                    "error": {
                        "class": "model_class_unknown",
                        "message": "unknown class",
                        "status": 400,
                    }
                },
            )
        )
        with pytest.raises(CapabilityError) as exc2:
            await bad.complete("q")
        assert exc2.value.error_class is ErrorClass.PERMANENT

    async def test_untyped_error_body_falls_back_to_status_message(self) -> None:
        model = bound_model(transport_returning(503, {"weird": True}))
        with pytest.raises(CapabilityError, match=r"llm gateway request failed \(503\)"):
            await model.complete("q")

    async def test_malformed_200_body_is_retryable(self) -> None:
        model = bound_model(transport_returning(200, {"text": "no usage block"}))
        with pytest.raises(CapabilityError, match="malformed completion response") as exc:
            await model.complete("q")
        assert exc.value.error_class is ErrorClass.RETRYABLE

    async def test_network_failure_is_retryable(self) -> None:
        def explode(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("ECONNREFUSED", request=request)

        model = GatewayModel(
            url="http://gateway.test",
            model_class="default-tier",
            transport=httpx.MockTransport(explode),
            context=CONTEXT,
        )
        with pytest.raises(CapabilityError, match="llm gateway unreachable") as exc:
            await model.complete("q")
        assert exc.value.error_class is ErrorClass.RETRYABLE


class TestAgentBinding:
    async def test_binds_contextual_model_to_the_step_context(self) -> None:
        recorded: list[httpx.Request] = []
        agent = Agent(
            manifest=MANIFEST,
            model=GatewayModel(
                url="http://gateway.test",
                model_class="default-tier",
                transport=transport_returning(200, gateway_response("bound answer"), recorded),
            ),
        )

        @agent.capability("test.echo")
        async def handler(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
            completion = await ctx.model.complete("inner prompt")
            return {"text": completion.text, "citations": [], "confidence": 0.9}

        result = await agent.execute(step_request(delegated_token="step-jwt"))
        assert result["status"] == "completed"
        assert recorded[0].headers["authorization"] == "Bearer step-jwt"
        assert json.loads(recorded[0].content)["metadata"]["capability"] == "test.echo"
        # Usage flowed through _CountingModel from the gateway's counters.
        assert result["usage"] == {"llm_calls": 1, "input_tokens": 45, "output_tokens": 4}

    def test_is_contextual_gateway_yes_fake_no(self) -> None:
        assert isinstance(
            GatewayModel(url="http://gateway.test", model_class="default-tier"),
            ContextualModel,
        )
        assert not isinstance(FakeModel(), ContextualModel)

    async def test_agent_without_model_executes_on_the_lazy_fake_fallback(self) -> None:
        agent = Agent(manifest=MANIFEST)
        assert agent.model is None

        @agent.capability("test.echo")
        async def handler(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
            # The fallback FakeModel with an empty script raises on use — but
            # a handler that never calls the model works exactly as before.
            return {"text": "no model needed", "citations": [], "confidence": 0.9}

        result = await agent.execute(step_request())
        assert result["status"] == "completed"
        assert result["usage"] == {"llm_calls": 0, "input_tokens": 0, "output_tokens": 0}
