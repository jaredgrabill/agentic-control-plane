# @acp/create-agent

Scaffolds a compliant ACP TypeScript agent — manifest, capability handler,
golden/red-team eval suites, tests, and package config — working out of the
box, mirroring the Python `acp-create-agent` anatomy.

```
create-agent <name> [--owner <team>] [--dir <parent>]
```

The name must be kebab-case (`^[a-z][a-z0-9-]{1,62}[a-z0-9]$`). An existing
target directory is never overwritten (exit 2).

## In-repo usage

The package is unpublished (alpha); inside this monorepo run the built CLI
directly, scaffolding into `agents/` (the pnpm workspace already globs it and
the generated `tsconfig.json` extends the repo base config two levels up):

```
pnpm --filter @acp/create-agent build
node packages/create-agent/dist/main.js my-agent --dir agents --owner team-me
pnpm install
pnpm --filter my-agent test
```

Once published, `pnpm create @acp/agent my-agent` resolves to this package's
`create-agent` bin by the npm create convention.

## What you get

- `manifest.yaml` — the contract: one R0 greeting capability with full
  input/output schemas and 3 examples; replace it with your first real one.
- `src/main.ts` / `src/capabilities/hello.ts` — manifest-bound Agent with a
  handler that answers typed (`needs_input` on empty input) or cited.
- `evals/golden` + `evals/redteam` — seed suites run through the EvalHarness
  by `tests/evals.test.ts`; they gate registration. Grow them with every
  incident.
- `src/prompts/`, `evals/rubrics/` — versioned prompt and rubric homes.
