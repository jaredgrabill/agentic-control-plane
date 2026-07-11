"""The eval report emitter is CI tooling: its payload must validate against
the protocol schema, agree with a direct harness run, and carry the suite
digest the gate compares baselines by."""

import json
from pathlib import Path

from acp_agent_sdk import Agent, EvalHarness, load_golden, suite_digest
from acp_protocol import validate
from knowledge_agent import eval_report
from knowledge_agent.capabilities.answer import register
from knowledge_agent.fixture_retriever import FixtureRetriever

AGENT_DIR = Path(__file__).resolve().parents[1]
GOLDEN = AGENT_DIR / "evals" / "golden"
CORPUS = AGENT_DIR.parents[2] / "fixtures" / "acme-corp"


def make_agent() -> Agent:
    agent = Agent.from_manifest(AGENT_DIR / "manifest.yaml", retriever=FixtureRetriever(CORPUS))
    register(agent)
    agent.assert_complete()
    return agent


async def test_payload_validates_and_matches_a_direct_run() -> None:
    report, payload = await eval_report.build_report()
    validate("eval-report", payload)

    direct = await EvalHarness(make_agent(), delegated_token="eval-token").run(load_golden(GOLDEN))
    assert payload["metrics"]["pass_rate"] == direct.pass_rate
    assert payload["metrics"]["citation_precision"] == direct.citation_precision
    assert payload["metrics"]["abstention_accuracy"] == direct.abstention_accuracy
    assert payload["suite"]["digest"] == suite_digest(GOLDEN)
    assert payload["suite"]["case_count"] == len(direct.results) == len(report.results)
    assert [c["name"] for c in payload["cases"]] == [r.name for r in direct.results]


def test_agent_version_matches_the_registered_contract() -> None:
    # The E2E suite registers the agent as 0.1.0; the registry rejects
    # baselines recorded against any other version.
    assert eval_report.AGENT_VERSION == "0.1.0"


def test_main_writes_a_valid_report_file(tmp_path: Path) -> None:
    out = tmp_path / "report.json"
    assert eval_report.main(["--out", str(out)]) == 0
    payload = json.loads(out.read_text(encoding="utf-8"))
    validate("eval-report", payload)
    assert payload["agent_id"] == "knowledge-agent"
    assert payload["agent_version"] == eval_report.AGENT_VERSION
    assert payload["sdk"] == "acp-agent-sdk-py@0.1.0"
