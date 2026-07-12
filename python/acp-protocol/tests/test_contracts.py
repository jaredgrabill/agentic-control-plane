"""Cross-language contract tests: the shared fixture files in
packages/protocol/fixtures must reach the same verdicts here (jsonschema +
pydantic) as in the TypeScript binding (ajv). Same bytes, same meaning."""

import json
from pathlib import Path
from typing import Any

import pytest
from acp_protocol import ProtocolValidationError, validate, validation_errors
from acp_protocol.generated.agent_card import AgentCard
from acp_protocol.generated.agent_manifest import AgentManifest
from acp_protocol.generated.audit_event import AuditEvent
from acp_protocol.generated.eval_report import EvalReport
from acp_protocol.generated.task_contract import TaskMessage
from pydantic import BaseModel, RootModel, ValidationError

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "protocol" / "fixtures"

MODELS: dict[str, type[BaseModel]] = {
    "agent-manifest": AgentManifest,
    "agent-card": AgentCard,
    "task-contract": TaskMessage,
    "audit-event": AuditEvent,
    "eval-report": EvalReport,
}


def _cases() -> list[dict[str, Any]]:
    doc = json.loads((FIXTURES / "expectations.json").read_text(encoding="utf-8"))
    cases: list[dict[str, Any]] = doc["cases"]
    return cases


def test_fixture_coverage() -> None:
    cases = _cases()
    for schema in MODELS:
        assert any(c["schema"] == schema and c["valid"] for c in cases)
        assert any(c["schema"] == schema and not c["valid"] for c in cases)


@pytest.mark.parametrize("case", _cases(), ids=lambda c: str(c["file"]))
def test_schema_verdict(case: dict[str, Any]) -> None:
    doc = json.loads((FIXTURES / case["file"]).read_text(encoding="utf-8"))
    errors = validation_errors(case["schema"], doc)
    if case["valid"]:
        assert errors == []
        validate(case["schema"], doc)
    else:
        assert errors, "expected schema violations, got none"
        with pytest.raises(ProtocolValidationError):
            validate(case["schema"], doc)


@pytest.mark.parametrize(
    "case",
    [c for c in _cases() if c["valid"]],
    ids=lambda c: str(c["file"]),
)
def test_pydantic_roundtrip(case: dict[str, Any]) -> None:
    """Valid documents must parse into the generated models and survive a
    dump→reparse round trip without semantic drift."""
    doc = json.loads((FIXTURES / case["file"]).read_text(encoding="utf-8"))
    model_cls = MODELS[case["schema"]]
    parsed = model_cls.model_validate(doc)
    dumped = _dump(parsed)
    assert validation_errors(case["schema"], dumped) == []
    assert model_cls.model_validate(dumped) == parsed


@pytest.mark.parametrize(
    "case",
    [c for c in _cases() if not c["valid"]],
    ids=lambda c: str(c["file"]),
)
def test_pydantic_rejects(case: dict[str, Any]) -> None:
    doc = json.loads((FIXTURES / case["file"]).read_text(encoding="utf-8"))
    with pytest.raises(ValidationError):
        MODELS[case["schema"]].model_validate(doc)


def _dump(model: BaseModel) -> Any:
    if isinstance(model, RootModel):
        inner = model.root
        if isinstance(inner, BaseModel):
            return _dump(inner)
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)
