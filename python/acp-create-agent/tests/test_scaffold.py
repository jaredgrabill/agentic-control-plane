import ast
from pathlib import Path
from typing import Any

import yaml
from acp_agent_sdk import Agent, EvalHarness, load_golden
from acp_create_agent.main import main
from acp_create_agent.template import render_template
from acp_protocol import validate


def test_scaffolds_the_full_anatomy(tmp_path: Path) -> None:
    assert main(["incident-summary-agent", "--dir", str(tmp_path), "--owner", "team-ops"]) == 0
    root = tmp_path / "incident-summary-agent"
    for required in [
        "manifest.yaml",
        "src/main.py",
        "src/capabilities/hello.py",
        "src/prompts/README.md",
        "evals/golden/cases.json",
        "evals/redteam/cases.json",
        "tests/test_evals.py",
        "pyproject.toml",
        "README.md",
    ]:
        assert (root / required).exists(), f"missing {required}"


def test_scaffolded_manifest_conforms_to_the_protocol_schema() -> None:
    files = render_template("incident-summary-agent", "team-ops")
    manifest = yaml.safe_load(files["manifest.yaml"])
    validate("agent-manifest", manifest)
    assert manifest["owner"] == "team-ops"
    assert manifest["capabilities"][0]["name"] == "incident_summary.hello"


def test_scaffolded_python_parses() -> None:
    files = render_template("my-agent", "team-x")
    for rel, content in files.items():
        if rel.endswith(".py"):
            ast.parse(content, filename=rel)


async def test_rendered_golden_suite_passes_through_the_eval_harness(tmp_path: Path) -> None:
    """The scaffolded agent must pass its own generated eval gate out of the box."""
    files = render_template("incident-summary-agent", "team-ops")
    agent = Agent(manifest=yaml.safe_load(files["manifest.yaml"]))

    namespace: dict[str, Any] = {}
    exec(compile(files["src/capabilities/hello.py"], "hello.py", "exec"), namespace)  # noqa: S102
    namespace["register"](agent)

    for suite in ("golden", "redteam"):
        suite_dir = tmp_path / suite
        suite_dir.mkdir()
        (suite_dir / "cases.json").write_text(files[f"evals/{suite}/cases.json"], encoding="utf-8")
        report = await EvalHarness(agent).run(load_golden(suite_dir))
        assert report.passed, f"{suite}: {report.summary()}"


def test_rejects_bad_names_and_existing_dirs(tmp_path: Path) -> None:
    assert main(["Not_Kebab", "--dir", str(tmp_path)]) == 2
    assert main(["twice-agent", "--dir", str(tmp_path)]) == 0
    assert main(["twice-agent", "--dir", str(tmp_path)]) == 2
