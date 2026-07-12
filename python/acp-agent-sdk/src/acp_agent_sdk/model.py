"""ModelClient: the only door to LLMs (paved-road.md). Manifests declare
model classes, never model IDs; routing/caching/budget live behind this
seam. The alpha ships the FakeModel test seam (testing.md: LLM calls are
faked at the SDK seam) — provider routing through the LLM gateway lands
in Phase 2."""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from acp_agent_sdk.errors import CapabilityError, ErrorClass


@dataclass
class ModelResponse:
    text: str
    # Non-cached input tokens only; cache reads/writes are reported separately.
    input_tokens: int = 0
    output_tokens: int = 0
    # Input tokens served from / written to the provider's prompt cache.
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    # None for the FakeModel test seam (no concrete model → fallback-priced),
    # a concrete model id from the gateway. Mirrors the TS ModelResponse.model?.
    model: str | None = None


class ModelClient(Protocol):
    async def complete(self, prompt: str, *, max_tokens: int = 1024) -> ModelResponse: ...


@dataclass
class ModelCallContext:
    """Everything a gateway-bound model needs from the step: identity + correlation."""

    task_id: str
    step_id: str
    tenant: str
    capability: str
    # The step's delegated token — the ONLY credential a model call rides on.
    delegated_token: str | None = None


@runtime_checkable
class ContextualModel(Protocol):
    """Optional seam over ModelClient: a model that can bind itself to one
    step's call context. The SDK binds it in execute(); FakeModel is NOT
    contextual, so handler unit tests are untouched."""

    async def complete(self, prompt: str, *, max_tokens: int = 1024) -> ModelResponse: ...

    def with_call_context(self, context: ModelCallContext) -> ModelClient: ...


@dataclass
class FakeModel:
    """Scripted model responses for deterministic handler tests.

    Feed it strings, ModelResponses, callables (prompt → response), or
    exceptions — exhausting the script raises, because a handler making
    more LLM calls than its test scripted is a behavior change the test
    must catch, not absorb.
    """

    script: list[str | ModelResponse | Exception | Callable[[str], str]] = field(
        default_factory=list
    )
    calls: list[str] = field(default_factory=list)

    async def complete(self, prompt: str, *, max_tokens: int = 1024) -> ModelResponse:
        self.calls.append(prompt)
        if not self.script:
            raise CapabilityError(
                ErrorClass.PERMANENT,
                f"FakeModel script exhausted after {len(self.calls) - 1} calls — "
                "the handler made more model calls than the test scripted",
            )
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        if callable(step):
            step = step(prompt)
        if isinstance(step, str):
            step = ModelResponse(text=step, output_tokens=max(1, len(step) // 4))
        return step
