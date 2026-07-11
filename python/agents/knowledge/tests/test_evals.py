"""Eval gates 1-2 (evaluation.md): the golden set and red-team suite run
hermetically against the fixture corpus. Citation precision and abstention
behavior are the gated metrics for this agent (domains.md)."""

from pathlib import Path

from acp_agent_sdk import Agent, EvalHarness, load_golden
from knowledge_agent.capabilities.answer import register
from knowledge_agent.fixture_retriever import FixtureRetriever

AGENT_DIR = Path(__file__).resolve().parents[1]
CORPUS = AGENT_DIR.parents[2] / "fixtures" / "acme-corp"


def make_agent() -> Agent:
    agent = Agent.from_manifest(AGENT_DIR / "manifest.yaml", retriever=FixtureRetriever(CORPUS))
    register(agent)
    agent.assert_complete()
    return agent


async def test_golden_set_with_gated_metrics() -> None:
    report = await EvalHarness(make_agent(), delegated_token="eval-token").run(
        load_golden(AGENT_DIR / "evals" / "golden")
    )
    assert report.passed, report.summary()
    # The gated metrics, not just answer vibes:
    assert report.citation_precision >= 0.9, report.summary()
    assert report.abstention_accuracy == 1.0, report.summary()


async def test_redteam_suite_blocks() -> None:
    report = await EvalHarness(make_agent(), delegated_token="eval-token").run(
        load_golden(AGENT_DIR / "evals" / "redteam")
    )
    assert report.passed, report.summary()


async def test_answers_carry_version_and_effective_date() -> None:
    agent = make_agent()
    result = await agent.execute(
        {
            "kind": "step_request",
            "step_id": "0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44",
            "task_id": "0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40",
            "tenant": "acme",
            "agent_id": "knowledge-agent",
            "capability": "knowledge.answer_with_citations",
            "input": {"question": "What does our policy say about change freezes?"},
            "delegated_token": "eval-token",
        }
    )
    assert result["status"] == "completed"
    citation = result["output"]["citations"][0]
    # Hard requirement (domains.md): citations carry document version and
    # effective date.
    assert citation["version"] == "3.2.0"
    assert citation["effective_date"] == "2026-01-15"
    assert citation["lineage_id"]
