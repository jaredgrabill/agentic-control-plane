# Vision

## The Problem

Answering a real operational question in an enterprise — *"Can we roll out this
firewall change tonight?"*, *"Why did cloud spend jump 30% last week?"*, *"Is
this service change compliant with our data-residency policy?"* — today means
an engineer manually stitching together answers from a half-dozen systems:
the CMDB, the ITSM tool, the firewall manager, the cloud console, the wiki,
and the source repository. Each hop loses context, each tool has its own
access model, and the institutional knowledge of *how* to stitch them together
lives in people's heads.

Single-purpose AI assistants don't fix this. A chatbot over the wiki can't
check the change calendar; a cloud-cost copilot can't read the security
policy that explains the spend. The value is in **composition across
domains** — and composition without governance is how you get an agent that
confidently opens a firewall port because a wiki page told it to.

## What We Are Building

An open-source (MIT) **control plane for composable, governed AI agents**:
the shared services, protocols, and standards that let specialized agents —
each expert in one technical domain — discover each other, delegate work,
and produce auditable, policy-compliant results.

Initial domain agents:

| Agent | Domain | Example capability |
|---|---|---|
| Knowledge & Policy | Documents, standards, runbooks | "What does our policy say about X, with citations?" |
| Change / ITSM | Changes, incidents, approvals | "Draft the change request and check calendar conflicts" |
| Network Security | Firewalls, segmentation, exposure | "What would this rule change expose?" |
| Cloud | Inventory, cost, configuration | "Which accounts run affected instance types?" |
| Source Code | Repos, dependencies, CI | "Which services depend on this library version?" |

The platform is domain-agnostic: these five prove the model, and the paved
road makes the sixth agent a week of work, not a quarter.

## Design Principles

1. **Governance is the product.** Policy checks, audit trails, and blast-radius
   controls are enforced by the platform, not requested of agent authors.
   An agent cannot opt out of governance because governance does not live in
   the agent.
2. **Composition over monoliths.** Small agents with narrow, well-described
   capabilities, composed dynamically — never one giant agent with every tool.
3. **Deterministic where it matters.** LLMs decide *what* to do; a workflow
   engine (Temporal) controls *that it happens* — retries, timeouts,
   compensation, approvals — deterministically and durably.
4. **Paved road, not gates.** The fastest way to build an agent is also the
   safest: scaffolded templates, built-in telemetry, eval harnesses, and
   staged rollout come free with the SDK.
5. **Everything is versioned, everything can be rolled back.** Agents, prompts,
   policies, and tool contracts are versioned artifacts with canary and shadow
   deployment paths.
6. **Trust is earned continuously.** Evaluation, drift detection, and cost
   tracking run for the life of an agent, not just at launch. An agent that
   regresses gets demoted automatically.
7. **Open standards first.** MCP for tools, A2A-compatible agent cards for
   discovery, OpenTelemetry for observability. We build the control plane,
   not a proprietary ecosystem.

## What Success Looks Like

- An engineer asks one question; the answer arrives with citations, the list
  of agents consulted, and the policy checks that were applied — in less time
  than opening the first of six tools.
- A new domain agent goes from `create-agent` scaffold to shadow-mode
  production in days, and to full traffic only after passing eval gates.
- A security engineer can answer "what can agent X do, who approved it, and
  what did it actually do last Tuesday?" from one place.
- Platform operators can set a per-tenant monthly token budget and trust it.

## Non-Goals

- We do not build or fine-tune models; the platform is model-agnostic.
- We do not replace systems of record (ITSM, CMDB, cloud consoles); agents
  read from and write to them through governed tool servers.
- We do not target consumer or single-user use; this is organizational
  infrastructure.
- Fully autonomous remediation is not a goal until the trust machinery
  (evals, canary, audit) proves out; write actions ship behind approval gates
  first.
