"""Eval report emitter: runs the golden suite hermetically (fixture corpus,
no dev stack) and writes an acp-eval-report/v1 document for the Evaluation
Service gate (apps/evaluation). The payload is schema-validated before it is
written — a malformed report must fail here, on the producing side.

CLI: uv run --directory python python -m knowledge_agent.eval_report --out <file>
"""

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from acp_agent_sdk import Agent, EvalHarness, load_golden, report_payload
from acp_agent_sdk.evals import EvalReport
from acp_protocol import validate

from knowledge_agent.capabilities.answer import register
from knowledge_agent.fixture_retriever import FixtureRetriever

# Must equal the version the agent registers with (the E2E suite registers
# 0.1.0); the registry refuses baselines recorded for any other version.
AGENT_VERSION = "0.1.0"

AGENT_DIR = Path(__file__).resolve().parents[2]
GOLDEN_DIR = AGENT_DIR / "evals" / "golden"
CORPUS_DIR = AGENT_DIR.parents[2] / "fixtures" / "acme-corp"


async def build_report(agent_version: str = AGENT_VERSION) -> tuple[EvalReport, dict[str, Any]]:
    """Runs the golden suite and returns (harness report, validated wire payload)."""
    agent = Agent.from_manifest(AGENT_DIR / "manifest.yaml", retriever=FixtureRetriever(CORPUS_DIR))
    register(agent)
    agent.assert_complete()
    harness = EvalHarness(agent, delegated_token="eval-token")  # noqa: S106 — fixture, not a secret
    report = await harness.run(load_golden(GOLDEN_DIR))
    payload = report_payload(
        report,
        agent_id=agent.agent_id,
        agent_version=agent_version,
        suite_dir=GOLDEN_DIR,
    )
    validate("eval-report", payload)
    return report, payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Emit the knowledge agent's eval report (acp-eval-report/v1)."
    )
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--agent-version", default=AGENT_VERSION)
    args = parser.parse_args(argv)
    _report, payload = asyncio.run(build_report(args.agent_version))
    args.out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
