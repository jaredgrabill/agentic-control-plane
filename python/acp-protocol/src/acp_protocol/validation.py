"""JSON Schema (2020-12) validation against the shipped schema documents.

Pydantic models are the typed binding; this module is the authoritative
wire-level check, byte-for-byte equivalent to the TypeScript (ajv) side —
the cross-language contract tests hold both to the same verdicts.
"""

import json
from functools import cache
from importlib import resources
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

SCHEMA_NAMES = ("agent-manifest", "agent-card", "task-contract", "audit-event")
_BASE = "https://acp.dev/schemas/v1"


class ProtocolValidationError(ValueError):
    """A document that does not conform to its protocol schema.

    Raised at boundaries; consumers never repair protocol messages —
    fix the producing side.
    """

    def __init__(self, schema: str, errors: list[str]) -> None:
        self.schema = schema
        self.errors = errors
        super().__init__(
            f"document does not conform to {schema}: {'; '.join(errors)}. "
            "Fix the producing side — consumers never repair protocol messages."
        )


@cache
def schema_document(name: str) -> dict[str, Any]:
    """Returns the raw schema document by short name (e.g. 'task-contract')."""
    if name not in SCHEMA_NAMES:
        raise KeyError(f"unknown schema {name!r}; available: {', '.join(SCHEMA_NAMES)}")
    ref = resources.files("acp_protocol").joinpath(f"schemas/{name}.schema.json")
    doc: dict[str, Any] = json.loads(ref.read_text(encoding="utf-8"))
    return doc


@cache
def _validator(name: str, pointer: str | None = None) -> Draft202012Validator:
    registry = Registry().with_resources(
        (f"{_BASE}/{n}.schema.json", Resource.from_contents(schema_document(n)))
        for n in SCHEMA_NAMES
    )
    schema: dict[str, Any] = schema_document(name)
    if pointer:
        schema = {"$ref": f"{_BASE}/{name}.schema.json{pointer}"}
    return Draft202012Validator(schema, registry=registry, format_checker=FormatChecker())


def validation_errors(name: str, doc: object, pointer: str | None = None) -> list[str]:
    """Returns human-readable schema violations ('' means the root path)."""
    return [
        f"/{'/'.join(str(p) for p in e.absolute_path)} {e.message}"
        for e in _validator(name, pointer).iter_errors(doc)
    ]


def validate(name: str, doc: object, pointer: str | None = None) -> None:
    """Raises ProtocolValidationError unless doc conforms to the named schema."""
    errors = validation_errors(name, doc, pointer)
    if errors:
        raise ProtocolValidationError(name, errors)
