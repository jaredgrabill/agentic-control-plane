# Standard: The Paved Road

The paved road is the deal we offer agent teams: **stay on it and the
platform does governance, observability, evaluation, and cost for you; a new
agent is days of domain work, not weeks of plumbing.** Going off-road isn't
forbidden by fiat — it's forbidden by economics: off the road you must
reimplement everything below, and registration gates check for it.

## What You Get for Free

| Concern | Provided by | Your effort |
|---|---|---|
| Scaffold | `pnpm create @acp/agent` / `uvx acp-create-agent` | pick a name |
| Telemetry (OTel `gen_ai.*`, cost attribution) | SDK, on by construction | none |
| Structured logging + redaction | SDK logger | none |
| LLM access (routing, caching, budgets, failover) | SDK model client → LLM gateway | declare model class |
| Tool calling (auth, policy, audit, schemas) | SDK tool client → tool gateway | declare bindings in manifest |
| Task plumbing (Temporal worker, queues, retries, heartbeats) | SDK runtime | write handlers |
| Discovery & lifecycle (registration, health, canary/shadow) | Registry + Deployment Controller | write the manifest |
| Eval harness (runner, judge integration, baselines, CI wiring) | Evaluation Service + template | write golden cases & rubrics |
| Dashboards & alerts | auto-provisioned at registration | none |
| Local dev environment | `deploy/` docker-compose: NATS, Temporal, Postgres, mock tool servers, fake corpus | `make dev` |

## The Golden Path, End to End

```
1. scaffold        create-agent → runnable skeleton with a hello capability
2. define          manifest: capabilities, schemas, risk classes, tools, model class
3. implement       handlers + prompts (templates, cache-aware layout)
4. evaluate        golden cases + rubrics; `acp eval run` locally
5. propose         PR → CI: lint, types, tests, evals, red-team, semantic manifest diff
6. register        merge → CI registers version → `registered`
7. earn traffic    shadow → canary → active, gates automated, owner watches dashboards
8. operate         SLOs, error budgets, quarterly review — with the platform doing the measuring
```

Time target (a platform SLO on ourselves): **scaffold → shadow in under one
week** for an R0 agent by a team that has never used the platform, with no
platform-team hand-holding. We measure this with each new domain agent and
treat regressions as paved-road bugs.

## Base Abstractions (the SDK's spine)

- `Agent` — manifest binding + lifecycle hooks; you never touch transport.
- `Capability` — typed handler: `(ctx, input) → output`; ctx carries the
  delegated identity, budget, trace, and clients.
- `ModelClient` — the only door to LLMs (classes, not model IDs).
- `ToolClient` — the only door to tools (manifest bindings only).
- `Retriever` — the only door to the knowledge store (citation-carrying
  results).
- `AnswerBuilder` — structured answers with citations and confidence;
  makes the compliant answer shape the easy one.
- `EvalHarness` — golden-set runner usable locally and in CI, identical
  semantics.

Parity between the Python and TypeScript SDKs is a release requirement:
one protocol package generates both; a capability handler ports between
languages with mechanical changes only.

## Escape Hatches

Real systems need them; ours are explicit and visible:

- **Custom framework internals** (LangGraph, a bespoke loop) are fine
  *inside* a handler — the platform contract is the manifest + handler
  signature, not your internal graph.
- **`experimental` capability flag:** relaxed eval-baseline requirements,
  but shadow-only routing — you can iterate on production traffic shape
  without production consequences.
- **Waivers:** any MUST in the standards can be waived by two platform
  maintainers via a recorded waiver with an expiry date. No permanent
  waivers; expired waivers block the next registration.

## What Keeps the Road Paved

The platform team's standing priorities, in order: (1) registration gates
stay honest, (2) SDK upgrades are non-breaking or ship codemods,
(3) paved-road friction reports from agent teams are triaged weekly like
bugs — because a paved road nobody drives is just governance theater.
