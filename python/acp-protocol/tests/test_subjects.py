"""Subject rendering parity: both language bindings must produce the exact
strings recorded in the shared fixture, and reject the same bad inputs."""

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import pytest
from acp_protocol import subjects

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "protocol"
    / "fixtures"
    / "subjects"
    / "expected.json"
)

_RENDERERS: dict[str, Callable[..., str]] = {
    "task": subjects.task,
    "agent": subjects.agent,
    "audit": subjects.audit,
    "audit_corpus": subjects.audit_corpus,
    "ingest": subjects.ingest,
    "telemetry": subjects.telemetry,
    "registry": subjects.registry,
    "control": subjects.control,
    "svc": subjects.svc,
}


def _fixture() -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(FIXTURE.read_text(encoding="utf-8")))


@pytest.mark.parametrize("case", _fixture()["renders"], ids=lambda c: str(c["subject"]))
def test_renders(case: dict[str, Any]) -> None:
    assert _RENDERERS[case["entity"]](**case["args"]) == case["subject"]


@pytest.mark.parametrize("case", _fixture()["rejects"], ids=lambda c: str(c["why"]))
def test_rejects(case: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        _RENDERERS[case["entity"]](**case["args"])
