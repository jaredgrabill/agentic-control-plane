"""GatewayModel: ModelClient over the LLM Gateway (Phase 3 Item 0a), the
Python twin of the TypeScript SDK's gateway-model.ts. The static prefix is
fixed at construction and complete(prompt) always sends the prompt as the
variable tail — an agent physically cannot order volatile content ahead of
the cacheable prefix. Calls ride the step's delegated token via
with_call_context(); FakeModel remains the unit-test seam, untouched."""

from typing import Any

import httpx

from acp_agent_sdk.errors import CapabilityError, ErrorClass
from acp_agent_sdk.model import ModelCallContext, ModelResponse

# Wire-shape parity with @acp/llm-client's completionResponseSchema (Ajv):
# same required keys, additionalProperties: false at every level, same
# per-field constraints. A response the TS client would refuse must be
# refused here too (malformed -> RETRYABLE), never partially trusted.
_RESPONSE_KEYS = frozenset(
    ("text", "model_class", "model", "provider", "model_classes_version", "usage", "attempts")
)
_USAGE_KEYS = frozenset(
    (
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    )
)
_ATTEMPT_KEYS = frozenset(("provider", "model", "outcome", "duration_ms"))


class GatewayModel:
    """The one door from a served agent to model providers.

    Error mapping mirrors the TS GatewayModel byte for byte in class
    terms: 429/5xx -> RETRYABLE (Temporal owns the retry after the
    gateway's own failover gave up), 403 -> POLICY_DENIED, every other
    4xx -> PERMANENT.
    """

    def __init__(
        self,
        *,
        url: str,
        model_class: str,
        static_prefix: list[dict[str, str]] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        context: ModelCallContext | None = None,
    ) -> None:
        self._url = url.rstrip("/")
        self._model_class = model_class
        self._static_prefix = static_prefix if static_prefix is not None else []
        self._transport = transport
        self._context = context

    def with_call_context(self, context: ModelCallContext) -> "GatewayModel":
        """A bound twin carrying one step's identity + correlation."""
        return GatewayModel(
            url=self._url,
            model_class=self._model_class,
            static_prefix=self._static_prefix,
            transport=self._transport,
            context=context,
        )

    async def complete(self, prompt: str, *, max_tokens: int = 1024) -> ModelResponse:
        context = self._context
        if context is None or context.delegated_token is None:
            raise CapabilityError(
                ErrorClass.PERMANENT,
                "llm gateway calls require the step delegated token — "
                "the model is not bound to a call context",
            )
        request = {
            "model_class": self._model_class,
            "prompt": {
                "static": self._static_prefix,
                "variable": [{"role": "user", "text": prompt}],
            },
            "max_tokens": max_tokens,
            "metadata": {
                "task_id": context.task_id,
                "step_id": context.step_id,
                "capability": context.capability,
                "purpose": "agent",
            },
        }
        headers = {
            "authorization": f"Bearer {context.delegated_token}",
            "x-acp-task-id": context.task_id,
            "x-acp-step-id": context.step_id,
        }
        try:
            async with httpx.AsyncClient(transport=self._transport) as client:
                res = await client.post(
                    f"{self._url}/v1/complete", json=request, headers=headers, timeout=70.0
                )
        except httpx.HTTPError as err:
            raise CapabilityError(ErrorClass.RETRYABLE, f"llm gateway unreachable: {err}") from err

        if res.status_code != 200:
            raise _to_capability_error(res)

        body = res.json()
        if not _is_valid_completion(body):
            raise CapabilityError(
                ErrorClass.RETRYABLE,
                "llm gateway returned a malformed completion response",
            )
        usage = body["usage"]
        return ModelResponse(
            text=body["text"],
            # input_tokens is non-cached input only; cache reads/writes are
            # reported separately and priced at their own rates. They do NOT
            # count toward max_tokens (Cost Meter convention, coordinated with
            # the gateway wire shape).
            input_tokens=usage["input_tokens"],
            output_tokens=usage["output_tokens"],
            cache_read_tokens=usage["cache_read_input_tokens"],
            cache_write_tokens=usage["cache_creation_input_tokens"],
            model=body["model"],
        )


def _to_capability_error(res: httpx.Response) -> CapabilityError:
    status = res.status_code
    message = f"llm gateway request failed ({status})"
    details: dict[str, object] = {"status": status}
    try:
        error = res.json().get("error")
    except ValueError:
        error = None
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        message = error["message"]
        if isinstance(error.get("class"), str):
            details["error_class"] = error["class"]
        if isinstance(error.get("retry_after_s"), int | float):
            details["retry_after_s"] = error["retry_after_s"]
    if status == 429 or status >= 500:
        return CapabilityError(ErrorClass.RETRYABLE, message, details)
    if status == 403:
        return CapabilityError(ErrorClass.POLICY_DENIED, message, details)
    return CapabilityError(ErrorClass.PERMANENT, message, details)


def _is_nonneg_int(value: Any) -> bool:
    # bool is an int subclass in Python; the wire type is integer, not boolean.
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _is_nonneg_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and value >= 0


def _is_nonempty_str(value: Any) -> bool:
    return isinstance(value, str) and value != ""


def _is_valid_attempt(attempt: Any) -> bool:
    if not isinstance(attempt, dict) or set(attempt) != _ATTEMPT_KEYS:
        return False
    return (
        _is_nonempty_str(attempt["provider"])
        and _is_nonempty_str(attempt["model"])
        and _is_nonempty_str(attempt["outcome"])
        and _is_nonneg_number(attempt["duration_ms"])
    )


def _is_valid_completion(body: Any) -> bool:
    """Mirror of the TS Ajv completionResponseSchema: all required keys
    present, no unknown keys anywhere, same field constraints."""
    if not isinstance(body, dict) or set(body) != _RESPONSE_KEYS:
        return False
    if not isinstance(body["text"], str):
        return False
    if not all(
        _is_nonempty_str(body[key])
        for key in ("model_class", "model", "provider", "model_classes_version")
    ):
        return False
    usage = body["usage"]
    if not isinstance(usage, dict) or set(usage) != _USAGE_KEYS:
        return False
    if not all(_is_nonneg_int(usage[key]) for key in _USAGE_KEYS):
        return False
    attempts = body["attempts"]
    if not isinstance(attempts, list) or len(attempts) == 0:
        return False
    return all(_is_valid_attempt(attempt) for attempt in attempts)
