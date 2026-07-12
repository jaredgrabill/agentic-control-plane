"""Typed capability failures (agent-patterns.md): the orchestrator's
behavior differs per class, and misclassifying errors as retryable is how
retry storms happen."""

from enum import StrEnum


class ErrorClass(StrEnum):
    RETRYABLE = "retryable"
    PERMANENT = "permanent"
    BUDGET_EXHAUSTED = "budget_exhausted"
    POLICY_DENIED = "policy_denied"
    NEEDS_INPUT = "needs_input"


class CapabilityError(Exception):
    """Raise from a handler to fail loudly and typed.

    RETRYABLE errors surface as retryable activity failures (Temporal
    retries on a healthy worker); every other class is a definitive step
    outcome returned to the orchestrator — retrying a policy denial or an
    ambiguous question burns budget without changing the answer.
    """

    def __init__(
        self,
        error_class: ErrorClass,
        message: str,
        details: dict[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.error_class = error_class
        self.details = details

    def to_protocol(self) -> dict[str, object]:
        body: dict[str, object] = {"class": self.error_class.value, "message": str(self)}
        if self.details is not None:
            body["details"] = self.details
        return body
