"""`acp-create-agent <name>`: writes a runnable, eval-gated agent skeleton."""

import argparse
import re
import sys
from pathlib import Path

from acp_create_agent.template import render_template


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="acp-create-agent",
        description="Scaffold a compliant ACP Python agent (manifest, handler, evals, tests).",
    )
    parser.add_argument("name", help="agent id in kebab-case, e.g. incident-summary-agent")
    parser.add_argument(
        "--owner", default="team-CHANGEME", help="accountable team (required before registration)"
    )
    parser.add_argument("--dir", default=".", help="parent directory (default: cwd)")
    args = parser.parse_args(argv)

    if not re.fullmatch(r"[a-z][a-z0-9-]{1,62}[a-z0-9]", args.name):
        print(
            f"agent name {args.name!r} must be kebab-case (^[a-z][a-z0-9-]{{1,62}}[a-z0-9]$)",
            file=sys.stderr,
        )
        return 2

    target = Path(args.dir) / args.name
    if target.exists():
        print(f"{target} already exists — refusing to overwrite", file=sys.stderr)
        return 2

    files = render_template(args.name, args.owner)
    for rel, content in files.items():
        path = target / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")

    print(f"scaffolded {args.name} at {target}")
    print("next: cd", target, "&& uv run pytest")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
