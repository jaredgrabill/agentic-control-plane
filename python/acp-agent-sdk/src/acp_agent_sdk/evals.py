"""EvalHarness: golden-set runner usable locally and in CI with identical
semantics (paved-road.md). Deterministic checks first (testing.md):
citation precision, abstention correctness, content assertions — judge
rubrics arrive with the Evaluation Service in Phase 2."""

import hashlib
import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from acp_agent_sdk.agent import Agent


@dataclass
class GoldenCase:
    name: str
    capability: str
    input: dict[str, Any]
    must_contain: list[str] = field(default_factory=list)
    must_cite_docs: list[str] = field(default_factory=list)
    expect_abstain: bool = False
    min_confidence: float | None = None
    expect_error_class: str | None = None

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "GoldenCase":
        expect = raw.get("expect", {})
        return cls(
            name=raw["name"],
            capability=raw["capability"],
            input=raw["input"],
            must_contain=expect.get("must_contain", []),
            must_cite_docs=expect.get("must_cite_docs", []),
            expect_abstain=expect.get("abstain", False),
            min_confidence=expect.get("min_confidence"),
            expect_error_class=expect.get("error_class"),
        )


def suite_digest(directory: str | Path) -> str:
    """Content digest identifying a golden suite (acp-eval-report/v1 suite.digest).

    Normative algorithm, byte-identical across the TypeScript and Python
    SDKs: take the basenames of the ``*.json`` files directly under
    ``directory``, sorted ascending by code point; for each file feed
    sha256 with utf8(basename), 0x00, utf8(text with CRLF normalized to
    LF), 0x00; return ``"sha256:" + hexdigest``. CRLF normalization keeps
    the digest stable across checkout line-ending policies (Windows).
    """
    suite_dir = Path(directory)
    if not suite_dir.is_dir():
        # Path.glob on a nonexistent directory yields nothing, which would
        # produce the (plausible-looking) empty-input digest for a mistyped
        # suite_dir. The TypeScript twin throws ENOENT here; match it.
        raise FileNotFoundError(f"golden suite directory not found: {suite_dir}")
    h = hashlib.sha256()
    for path in sorted(suite_dir.glob("*.json"), key=lambda p: p.name):
        # Bytes, not text mode: universal newlines would also fold lone \r,
        # which the TypeScript twin does not do.
        text = path.read_bytes().decode("utf-8").replace("\r\n", "\n")
        h.update(path.name.encode("utf-8"))
        h.update(b"\x00")
        h.update(text.encode("utf-8"))
        h.update(b"\x00")
    return "sha256:" + h.hexdigest()


def load_golden(directory: str | Path) -> list[GoldenCase]:
    cases: list[GoldenCase] = []
    for path in sorted(Path(directory).glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        cases.extend(GoldenCase.from_dict(c) for c in doc["cases"])
    if not cases:
        raise ValueError(
            f"no golden cases found under {directory} — no eval suite, no registration"
        )
    return cases


@dataclass
class CaseResult:
    name: str
    passed: bool
    failures: list[str]
    cited_docs: list[str]
    abstained: bool


@dataclass
class EvalReport:
    results: list[CaseResult]
    citation_precision: float
    abstention_accuracy: float
    pass_rate: float

    @property
    def passed(self) -> bool:
        return all(r.passed for r in self.results)

    def summary(self) -> str:
        failed = [r for r in self.results if not r.passed]
        lines = [
            f"golden cases: {len(self.results)}  pass_rate={self.pass_rate:.2f}  "
            f"citation_precision={self.citation_precision:.2f}  "
            f"abstention_accuracy={self.abstention_accuracy:.2f}"
        ]
        lines.extend(f"FAIL {r.name}: {'; '.join(r.failures)}" for r in failed)
        return "\n".join(lines)


class EvalHarness:
    def __init__(self, agent: Agent, *, delegated_token: str | None = None) -> None:
        self.agent = agent
        self.delegated_token = delegated_token

    async def run(self, cases: list[GoldenCase]) -> EvalReport:
        results: list[CaseResult] = []
        precisions: list[float] = []
        abstention_hits: list[bool] = []
        for case in cases:
            result = await self._run_case(case)
            results.append(result)
            if case.must_cite_docs:
                cited = set(result.cited_docs)
                expected = set(case.must_cite_docs)
                precisions.append(len(cited & expected) / len(cited) if cited else 0.0)
            abstention_hits.append(result.abstained == case.expect_abstain)
        return EvalReport(
            results=results,
            citation_precision=sum(precisions) / len(precisions) if precisions else 1.0,
            abstention_accuracy=sum(abstention_hits) / len(abstention_hits)
            if abstention_hits
            else 1.0,
            pass_rate=sum(1 for r in results if r.passed) / len(results) if results else 0.0,
        )

    async def _run_case(self, case: GoldenCase) -> CaseResult:
        request: dict[str, Any] = {
            "kind": "step_request",
            "step_id": str(uuid.uuid4()),
            "task_id": str(uuid.uuid4()),
            "tenant": "acme",
            "agent_id": self.agent.agent_id,
            "capability": case.capability,
            "input": case.input,
        }
        if self.delegated_token is not None:
            request["delegated_token"] = self.delegated_token
        step = await self.agent.execute(request)

        failures: list[str] = []
        output = step.get("output", {}) if step["status"] == "completed" else {}
        text: str = output.get("text", "")
        citations: list[dict[str, Any]] = output.get("citations", [])
        cited_docs = [c["doc_id"] for c in citations]
        abstained = bool(output.get("abstained", False))

        if case.expect_error_class is not None:
            # A typed failure IS the expected behavior; any other outcome fails.
            actual = step.get("error", {}).get("class") if step["status"] != "completed" else None
            if actual != case.expect_error_class:
                failures.append(
                    f"expected a {case.expect_error_class} failure, "
                    f"got {actual or 'a completed step'}"
                )
        elif step["status"] != "completed":
            failures.append(f"step failed: {step.get('error', {}).get('message', 'unknown')}")
        for needle in case.must_contain:
            if needle.lower() not in text.lower():
                failures.append(f"answer does not mention {needle!r}")
        for doc in case.must_cite_docs:
            if doc not in cited_docs:
                failures.append(f"answer does not cite {doc}")
        if case.expect_abstain and not abstained:
            failures.append("expected abstention, got a confident answer")
        if not case.expect_abstain and abstained:
            failures.append("abstained on an answerable question")
        if case.min_confidence is not None and output.get("confidence", 0) < case.min_confidence:
            failures.append(
                f"confidence {output.get('confidence')} below floor {case.min_confidence}"
            )

        return CaseResult(
            name=case.name,
            passed=not failures,
            failures=failures,
            cited_docs=cited_docs,
            abstained=abstained,
        )


def report_payload(
    report: EvalReport,
    *,
    agent_id: str,
    agent_version: str,
    suite_dir: str | Path,
    sdk: str = "acp-agent-sdk-py@0.1.0",
) -> dict[str, Any]:
    """Renders a harness run as an acp-eval-report/v1 wire document.

    Cases stay in run order; ``suite.digest`` is :func:`suite_digest` over
    ``suite_dir``, so gates can refuse comparison when the suite changed.
    """
    return {
        "schema": "acp-eval-report/v1",
        "sdk": sdk,
        "agent_id": agent_id,
        "agent_version": agent_version,
        "suite": {
            "digest": suite_digest(suite_dir),
            "case_count": len(report.results),
        },
        "metrics": {
            "pass_rate": report.pass_rate,
            "citation_precision": report.citation_precision,
            "abstention_accuracy": report.abstention_accuracy,
        },
        "cases": [
            {
                "name": result.name,
                "passed": result.passed,
                "abstained": result.abstained,
                "cited_docs": result.cited_docs,
                "failures": result.failures,
            }
            for result in report.results
        ],
        "generated_at": datetime.now(UTC).isoformat(),
    }
