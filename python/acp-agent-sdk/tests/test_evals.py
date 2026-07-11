import json
from pathlib import Path
from typing import Any

import pytest
from acp_agent_sdk import (
    Agent,
    CapabilityContext,
    CapabilityError,
    ErrorClass,
    EvalHarness,
    GoldenCase,
    load_golden,
    report_payload,
    suite_digest,
)
from acp_protocol import validate

from .conftest import MANIFEST


def make_agent() -> Agent:
    agent = Agent(manifest=MANIFEST)

    @agent.capability("test.echo")
    async def handler(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
        question = input.get("text", "")
        if "unanswerable" in question:
            return {
                "text": "I don't have sufficient grounding to answer this.",
                "citations": [],
                "confidence": 0.1,
                "abstained": True,
            }
        return {
            "text": f"The change freeze applies. (asked: {question}) [1]",
            "citations": [
                {"doc_id": "policy/change-management", "version": "3.2.0", "lineage_id": "x"},
                {"doc_id": "runbook/oncall-escalation", "version": "3.0.0", "lineage_id": "y"},
            ],
            "confidence": 0.9,
        }

    return agent


def case(**overrides: Any) -> GoldenCase:
    base: dict[str, Any] = {
        "name": "case",
        "capability": "test.echo",
        "input": {"text": "what about change freezes?"},
        "expect": {},
    }
    base.update(overrides)
    return GoldenCase.from_dict(base)


class TestEvalHarness:
    async def test_passing_and_failing_content_assertions(self) -> None:
        report = await EvalHarness(make_agent()).run(
            [
                case(name="mentions freeze", expect={"must_contain": ["change freeze"]}),
                case(name="mentions unicorns", expect={"must_contain": ["unicorns"]}),
            ]
        )
        assert [r.passed for r in report.results] == [True, False]
        assert "unicorns" in report.summary()
        assert report.pass_rate == 0.5

    async def test_apostrophe_needles_render_double_quoted(self) -> None:
        # Pins {needle!r}'s quote-switching rule (apostrophe and no double
        # quote -> double-quoted repr). The TypeScript SDK replicates it and
        # asserts the identical string, keeping the parity comparator honest.
        report = await EvalHarness(make_agent()).run(
            [case(name="apostrophe needle", expect={"must_contain": ["unicorn's horn"]})]
        )
        assert report.results[0].failures == ['answer does not mention "unicorn\'s horn"']

    async def test_citation_precision_counts_expected_docs_only(self) -> None:
        report = await EvalHarness(make_agent()).run(
            [case(expect={"must_cite_docs": ["policy/change-management"]})]
        )
        # Two docs cited, one expected → precision 0.5, but the expected doc
        # IS cited so the case itself passes.
        assert report.results[0].passed
        assert report.citation_precision == 0.5

    async def test_abstention_scoring_both_directions(self) -> None:
        report = await EvalHarness(make_agent()).run(
            [
                case(
                    name="should abstain", input={"text": "unanswerable"}, expect={"abstain": True}
                ),
                case(name="wrongly abstains", input={"text": "unanswerable"}, expect={}),
                case(name="answers fine", expect={"min_confidence": 0.8}),
            ]
        )
        assert report.results[0].passed
        assert not report.results[1].passed
        assert report.results[2].passed
        assert report.abstention_accuracy == pytest.approx(2 / 3)

    async def test_expected_error_class_accepts_a_matching_typed_failure(self) -> None:
        agent = Agent(manifest=MANIFEST)

        @agent.capability("test.echo")
        async def handler(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
            raise CapabilityError(ErrorClass.NEEDS_INPUT, "which audience do you mean?")

        report = await EvalHarness(agent).run(
            [case(name="needs input", expect={"error_class": "needs_input"})]
        )
        assert report.results[0].passed, report.summary()

    async def test_expected_error_class_mismatch_names_the_actual_outcome(self) -> None:
        completed = await EvalHarness(make_agent()).run(
            [case(name="wanted a failure", expect={"error_class": "needs_input"})]
        )
        assert not completed.results[0].passed
        assert completed.results[0].failures == [
            "expected a needs_input failure, got a completed step"
        ]

        agent = Agent(manifest=MANIFEST)

        @agent.capability("test.echo")
        async def handler(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
            raise CapabilityError(ErrorClass.PERMANENT, "wrong class")

        wrong_class = await EvalHarness(agent).run(
            [case(name="wrong class", expect={"error_class": "needs_input"})]
        )
        assert not wrong_class.results[0].passed
        assert wrong_class.results[0].failures == ["expected a needs_input failure, got permanent"]

    async def test_load_golden_reads_files_and_rejects_empty(self, tmp_path: Path) -> None:
        (tmp_path / "cases.json").write_text(
            json.dumps(
                {"cases": [{"name": "n", "capability": "test.echo", "input": {}, "expect": {}}]}
            ),
            encoding="utf-8",
        )
        cases = load_golden(tmp_path)
        assert cases[0].name == "n"
        with pytest.raises(ValueError, match="no golden cases"):
            load_golden(tmp_path / "empty")


class TestSuiteDigest:
    PARITY_GOLDEN = Path(__file__).resolve().parents[3] / "fixtures" / "parity" / "golden"
    # The same literal is pinned in the TypeScript SDK's evals.test.ts — the
    # digest is a cross-language contract, not an implementation detail.
    PARITY_GOLDEN_DIGEST = "sha256:4c9ffc28c5b4e231bffc3d796c46fac1d9e75149b7c69c2e504801a2a07241fb"

    def test_matches_the_pinned_cross_language_digest(self) -> None:
        assert suite_digest(self.PARITY_GOLDEN) == self.PARITY_GOLDEN_DIGEST

    def test_crlf_and_lf_checkouts_hash_identically(self, tmp_path: Path) -> None:
        lf_dir = tmp_path / "lf"
        crlf_dir = tmp_path / "crlf"
        lf_dir.mkdir()
        crlf_dir.mkdir()
        body = '{\n  "cases": []\n}\n'
        (lf_dir / "cases.json").write_bytes(body.encode("utf-8"))
        (crlf_dir / "cases.json").write_bytes(body.replace("\n", "\r\n").encode("utf-8"))
        assert suite_digest(crlf_dir) == suite_digest(lf_dir)
        assert suite_digest(lf_dir).startswith("sha256:")

    def test_hashes_files_sorted_by_basename_with_separation(self, tmp_path: Path) -> None:
        (tmp_path / "b.json").write_text("B", encoding="utf-8")
        (tmp_path / "a.json").write_text("A", encoding="utf-8")
        (tmp_path / "ignored.txt").write_text("nope", encoding="utf-8")
        digest = suite_digest(tmp_path)
        # Moving content between files must change the digest even though
        # the concatenated bytes stay the same.
        (tmp_path / "b.json").write_text("A", encoding="utf-8")
        (tmp_path / "a.json").write_text("B", encoding="utf-8")
        assert suite_digest(tmp_path) != digest


class TestReportPayload:
    PARITY_GOLDEN = Path(__file__).resolve().parents[3] / "fixtures" / "parity" / "golden"

    async def test_emits_a_valid_report_with_cases_in_run_order(self) -> None:
        report = await EvalHarness(make_agent()).run(
            [
                case(name="first", expect={"must_contain": ["change freeze"]}),
                case(name="second", expect={"must_contain": ["unicorns"]}),
            ]
        )
        payload = report_payload(
            report,
            agent_id="knowledge-agent",
            agent_version="0.1.0",
            suite_dir=self.PARITY_GOLDEN,
        )
        validate("eval-report", payload)
        assert payload["sdk"] == "acp-agent-sdk-py@0.1.0"
        assert payload["agent_id"] == "knowledge-agent"
        assert payload["suite"]["digest"] == suite_digest(self.PARITY_GOLDEN)
        assert payload["suite"]["case_count"] == 2
        assert [c["name"] for c in payload["cases"]] == ["first", "second"]
        assert payload["cases"][1]["passed"] is False
        assert payload["cases"][1]["failures"] == ["answer does not mention 'unicorns'"]
        assert payload["metrics"]["pass_rate"] == 0.5

    async def test_honors_an_explicit_sdk_string(self) -> None:
        report = await EvalHarness(make_agent()).run([case()])
        payload = report_payload(
            report,
            agent_id="knowledge-agent",
            agent_version="0.1.0",
            suite_dir=self.PARITY_GOLDEN,
            sdk="custom-harness@9.9.9",
        )
        assert payload["sdk"] == "custom-harness@9.9.9"
        validate("eval-report", payload)
