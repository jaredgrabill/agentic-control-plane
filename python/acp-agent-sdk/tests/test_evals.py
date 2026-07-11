import json
from pathlib import Path
from typing import Any

import pytest
from acp_agent_sdk import Agent, CapabilityContext, EvalHarness, GoldenCase, load_golden

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
