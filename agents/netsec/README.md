# Network Security Agent

Network-security analysis over the mock `netsec` MCP server (firewall
ruleset, security groups, IPAM, vuln scans). Deterministic and extractive in
v0 (no model calls) — and deliberately **read-only plus a side-effect-free
draft**: this is a new write-capable *domain*, but v0 ships zero write
surface.

## Capabilities

| Capability | Risk | Tool(s) | Notes |
| --- | --- | --- | --- |
| `netsec.rule_search` | R0 | `firewall_rules_search` | Rules by service/CIDR/port/direction; abstains when a service is outside ruleset coverage. |
| `netsec.exposure_analysis` | R0 | `security_group_get`, `ipam_lookup` | Internet-facing exposure (0.0.0.0/0 ingress × public IPAM); abstains when the service is absent from both snapshots. |
| `netsec.change_impact` | R0 | `firewall_rules_search` | What a *proposed* change opens/closes — pure analysis, mutates nothing. |
| `netsec.rule_draft` | R1 | `firewall_rules_search` | Human-reviewable proposed rule + rationale. Calls only read tools, passes no idempotency key, writes nothing. |

`netsec.rule_draft` is R1 because it emits a proposed-change artifact (the R1
draft contract), not because anything mutates — keeping the write-adjacent
surface visible to policy and evals. There is **no** `netsec.rule_apply` in
v0: applying a firewall rule is R2 on the highest-consequence domain and
requires dual controls (human approval + a linked approved change record);
the design lives in `docs/rule-apply-dual-control.md` and ships in a
follow-on phase. No compensator is declared anywhere — R0/R1 declares none
(registration Rule 6).

## Security posture

- **No write door**: all four netsec tools are reads (risk R0 at the
  gateway); the mock has no store, no ledger, no idempotency/dry_run
  parameters. The gateway's structural risk-class check refuses any R2+ tool
  call without a matching signed capability claim — and no netsec tool is
  declared above R0 anyway.
- **Injection-as-data**: free-text `intent` is quoted verbatim into the
  rationale and never parsed into the drafted rule; the rule comes only from
  structured fields, and an unspecified source defaults to `10.0.0.0/8`
  (internal), never `0.0.0.0/0`.
- **Refusing enactment**: `rule_draft` rejects unknown input fields (e.g.
  `apply: true`) with a typed `needs_input` naming the missing capability.
- **Genuine abstention**: out-of-coverage services abstain — never a
  confident "no exposure".
- **Least privilege**: the agent's own token-service client carries
  `scopes: []` (all authority is delegated per step); `data_classification:
  confidential`.

## Environment

| Variable | Default |
| --- | --- |
| `ACP_TOOL_SERVER_NETSEC_URL` | `http://localhost:7106/mcp/netsec` |
| `ACP_AGENT_CLIENT_ID` / `_SECRET` | `agent-netsec-agent` / dev secret |
| `ACP_TOKEN_URL` | `http://localhost:7101` |

## Evals

`evals/golden` and `evals/redteam` run hermetically over the fixture netsec
server (`src/fixture-tools.ts`) — the same mock the dev platform serves.
`evals/baseline.json` is the committed baseline the evaluation service gates
candidate reports against; regenerate it when the golden suite changes (the
suite digest is gated exactly). Gates are zero-tolerance: the suite is fully
deterministic, so any metric drop is a real behavioral regression.
