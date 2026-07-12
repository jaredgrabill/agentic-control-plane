"""Emit the Python-side parity report (acp-parity-report/v1).

Run from python/: uv run python parity/runner.py --fixtures ../fixtures/parity --out <file>
"""

import argparse
import asyncio
import json
from pathlib import Path

from acp_agent_sdk import Agent, EvalHarness, load_golden
from handlers import register_parity_handlers


async def build_report(fixtures: Path) -> dict[str, object]:
    agent = Agent.from_manifest(fixtures / "manifest.yaml")
    register_parity_handlers(agent)
    cases = load_golden(fixtures / "golden")
    report = await EvalHarness(agent).run(cases)
    return {
        "schema": "acp-parity-report/v1",
        "sdk": "python",
        "agent_id": agent.agent_id,
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
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Emit the Python parity report over the shared fixtures."
    )
    parser.add_argument("--fixtures", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    report = asyncio.run(build_report(args.fixtures))
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
