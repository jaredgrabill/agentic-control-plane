# Standard: Agent Patterns

Normative standard for building agents on the platform. **MUST/SHOULD/MAY**
per RFC 2119. The SDK templates implement all MUSTs by construction — the
fastest way to build an agent is the compliant way.

## Anatomy of an Agent

Every agent is exactly these parts:

```
my-agent/
├── manifest.yaml          # capability manifest (the contract)
├── src/
│   ├── capabilities/      # one handler per capability
│   ├── prompts/           # versioned prompt templates
│   └── tools.ts|py        # MCP tool bindings (declared, not ad hoc)
├── evals/
│   ├── golden/            # four-bucket golden dataset
│   ├── rubrics/           # judge rubrics per capability
│   └── redteam/           # adversarial cases
└── README.md              # charter, owner, runbook links
```

Scaffolded by `pnpm create @acp/agent` (TypeScript) or
`uvx acp-create-agent` (Python). Both templates are functionally identical:
manifest, handler skeletons, eval harness, telemetry, structured logging,
CI config — working out of the box.

## Capability Rules

- A capability **MUST** have JSON Schema input and output, a risk class
  (R0–R3), and ≥ 3 examples (used for semantic discovery and eval seeds).
- Capabilities **MUST** be narrow. "Answer questions about the network" is
  not a capability; `netsec.exposure_analysis` is. Rule of thumb: if you
  can't write a golden dataset for it, it's too broad.
- R2+ capabilities **MUST** declare a compensator or the `irreversible`
  flag ([orchestration.md](../architecture/orchestration.md)).
- Handlers **MUST** be stateless between invocations: all state arrives in
  the request (task context) or lives in platform stores. Agent-local
  memory (caches, session files) is forbidden — it breaks replay, shadow
  comparison, and horizontal scaling.
- Handlers **MUST** return structured results conforming to the output
  schema; the SDK enforces one structured-repair retry, then fails the step.
  Free-text answers ride *inside* a schema (`{answer, citations[], confidence}`).

## Prompt Standards

- Prompts are **versioned artifacts** in `src/prompts/`, reviewed like code.
  No inline string prompts in handlers; no runtime prompt assembly beyond
  declared template variables.
- Layout **MUST** be cache-aware: static instructions and tool schemas
  first, volatile context last.
- Untrusted content (retrievals, tool outputs, user input) **MUST** be
  delimited with the SDK's trust-tier markers — never concatenated bare.
- System prompts **MUST NOT** contain secrets, credentials, or
  tenant-specific data.
- Every factual claim in an answer **MUST** be attributable: cite retrieval
  chunks or tool outputs. The SDK's answer builder makes citation the path
  of least resistance; the eval suite gates citation precision.

## Composition Rules

- Agents **MUST NOT** call other agents directly. Needing another agent's
  capability means returning a **delegation request** to the orchestrator
  (or declaring the dependency in the manifest so the planner composes it).
  This keeps policy, budgets, and audit on every hop.
- Workers return **conclusions, not transcripts** — a delegated step's
  result is a typed summary, not the chat log.
- Hierarchies stay shallow: platform default max delegation depth is 3;
  exceeding it is a planning failure, not a retry.

## Model Usage

- Manifests declare model **classes**, not model IDs; the LLM gateway binds.
- All LLM calls go through the SDK client (which is how routing, caching,
  token accounting, and budget checks happen). Direct provider SDK use
  fails review and — because credentials aren't available to agents —
  fails at runtime too.
- Temperature/decoding parameters are prompt-template metadata, versioned
  with the prompt.

## Error Handling

- Fail loudly and typed: `CapabilityError` taxonomy
  (`retryable | permanent | budget_exhausted | policy_denied | needs_input`).
  The orchestrator's behavior differs per class; misclassifying errors as
  retryable is how retry storms happen.
- **Abstention is a success mode:** below-confidence results return
  `needs_input` or an explicit low-confidence answer — never a confident
  guess. Eval suites include abstention cases.
- Timeouts: every handler declares its SLA; the SDK enforces it locally
  before Temporal's activity timeout does it remotely.

## Review Checklist (enforced in PR template)

- [ ] Manifest diff reviewed (capability/scope/risk changes highlighted)
- [ ] Prompts diffed and reviewed like code
- [ ] Eval suite updated for the change; baselines re-run
- [ ] Red-team cases updated if tools/scopes changed
- [ ] No direct provider/tool calls outside SDK bindings
- [ ] Compensators exist for new R2 capabilities
- [ ] Two approvals; owner team sign-off for risk-class increases
