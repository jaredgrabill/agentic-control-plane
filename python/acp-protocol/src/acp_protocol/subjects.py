"""NATS subject rendering from the shared vocabulary (schemas/subjects.json).

Mirrors the TypeScript binding exactly; the cross-language contract tests
assert both render identical strings for identical inputs.
"""

import json
import re
from functools import cache
from importlib import resources
from typing import Any

_TOKEN_RE = re.compile(r"^[a-z0-9_.-]+$")
_EVENT_TYPE_RE = re.compile(r"^[a-z_]+(\.[a-z_]+)+$")


@cache
def _data() -> dict[str, Any]:
    ref = resources.files("acp_protocol").joinpath("schemas/subjects.json")
    loaded: dict[str, Any] = json.loads(ref.read_text(encoding="utf-8"))
    return loaded


def _token(name: str, value: str) -> str:
    # `.`, `*`, `>` are structural in NATS; a caller-supplied ID containing
    # them could widen a subscription, so reject rather than sanitize.
    if not _TOKEN_RE.match(value) or ".." in value:
        raise ValueError(f"invalid subject token {name}={value!r}: must match {_TOKEN_RE.pattern}")
    return value


def _verb(entity: str, verb: str) -> str:
    verbs: list[str] = _data()["entities"][entity]["verbs"]
    if verb not in verbs:
        raise ValueError(
            f"unknown {entity} verb {verb!r}: closed vocabulary is [{', '.join(verbs)}]"
        )
    return verb


def task(tenant: str, task_id: str, verb: str) -> str:
    return f"acp.{_token('tenant', tenant)}.task.{_token('task_id', task_id)}.{_verb('task', verb)}"


def agent(tenant: str, agent_id: str, verb: str) -> str:
    return (
        f"acp.{_token('tenant', tenant)}.agent."
        f"{_token('agent_id', agent_id)}.{_verb('agent', verb)}"
    )


def audit(tenant: str, event_type: str) -> str:
    if not _EVENT_TYPE_RE.match(event_type):
        raise ValueError(f"invalid audit event_type {event_type!r}")
    return f"acp.{_token('tenant', tenant)}.audit.{event_type}"


def audit_corpus(tenant: str, source_id: str) -> str:
    return f"acp.{_token('tenant', tenant)}.audit.corpus.{_token('source_id', source_id)}"


def ingest(tenant: str, source_id: str) -> str:
    return f"acp.{_token('tenant', tenant)}.ingest.{_token('source_id', source_id)}"


def telemetry(tenant: str, signal: str) -> str:
    return f"acp.{_token('tenant', tenant)}.telemetry.{_token('signal', signal)}"


def registry(agent_id: str, verb: str) -> str:
    return f"acp.platform.registry.{_token('agent_id', agent_id)}.{_verb('registry', verb)}"


def control(verb: str) -> str:
    return f"acp.platform.control.{_verb('control', verb)}"
