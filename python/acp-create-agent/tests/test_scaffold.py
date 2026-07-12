import ast
from pathlib import Path

import yaml
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


def test_rejects_bad_names_and_existing_dirs(tmp_path: Path) -> None:
    assert main(["Not_Kebab", "--dir", str(tmp_path)]) == 2
    assert main(["twice-agent", "--dir", str(tmp_path)]) == 0
    assert main(["twice-agent", "--dir", str(tmp_path)]) == 2
