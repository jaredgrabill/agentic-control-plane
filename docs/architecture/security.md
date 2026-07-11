# Security

Threat model anchors: **OWASP Top 10 for Agentic Applications 2026 (ASI01–10)**,
OWASP LLM Top 10 2025, MITRE ATLAS agent techniques. Governance scaffold:
NIST AI RMF + GenAI Profile; ISO/IEC 42001 alignment as a target.
Research basis: [governance-safety-security brief](../research/governance-safety-security.md).

> **Start with [threat-model.md](threat-model.md)** — the one-page mapping
> from each threat to its controls and residual risk. This document holds
> the control designs it references.

## Identity

Every actor — human, service, **and each agent version** — is a first-class
principal with its own credential. No shared API keys, ever (ASI03).

**Stateless JWT + RBAC** ([ADR-0004](../adr/0004-stateless-jwt-rbac.md)):

- Short-lived (≤ 15 min), audience-bound, asymmetrically signed (JWKS
  rotation); verification is local to every service — no session store, no
  central bottleneck.
- Roles are coarse archetypes (platform-admin, agent-operator, agent,
  tool-server, tenant-user); **scopes are per-capability and per-tool**
  (`tool:firewall-mgr:rules:read`), not per-agent.
- Revocation despite statelessness: short TTLs bound the exposure window; a
  small denylist of revoked principals/agents (kill switch) is distributed
  via NATS KV and checked by the Gateway and tool gateway — the one
  deliberate exception to pure statelessness.

**Delegation chains (RFC 8693 token exchange).** When the orchestrator
delegates to an agent, and when an agent calls a tool, the Token Service
exchanges the current token for a narrower one: new audience, scopes =
**intersection** of the delegator's effective permissions and the target's
manifest — never the union. The full chain (user → orchestrator → agent →
tool) rides in nested `act` claims, so every tool server knows exactly who is
ultimately asking, and audit gets provenance for free. This tracks the IETF
on-behalf-of-for-agents draft direction.

**Workload attestation (hardening tier).** SPIFFE/SPIRE issuance of workload
identities for agent workers and tool servers, mTLS on all service links.
Designed in from the start as the deployment-hardened profile; the dev
profile runs platform JWTs only.

## Boundary Controls

| ASI threat | Control |
|---|---|
| ASI01 goal hijack / LLM01 injection | Plan-then-execute (plan recorded before execution; replans re-run policy); untrusted content delimited and labeled by trust tier; injection classifiers at gateway and on retrieved content; policy checks in code, never delegated to the model |
| ASI02 tool misuse | Cedar PDP on **every** tool call (see [governance-and-policy.md](governance-and-policy.md)); schemas validated both directions; per-tool scopes |
| ASI03 privilege abuse | Scope intersection on every delegation; short TTLs; per-agent-version identities |
| ASI04 supply chain | Agents/tools only from the internal registry with signed cards and 2-human review; SBOM + pinned deps + OpenSSF Scorecard in CI |
| ASI05 code execution | Agent-executed code (if a capability requires it) runs in microVM/gVisor sandboxes with egress allowlists — plain containers don't qualify |
| ASI06 memory/context poisoning | Ingestion trust gates and provenance ([knowledge-and-rag.md](knowledge-and-rag.md)); session isolation — no cross-tenant or cross-session memory |
| ASI07 inter-agent comms | No direct agent-to-agent paths; all delegation via orchestrator with authenticated, schema-validated contracts over the bus |
| ASI08 cascading failures | Blast-radius controls: step caps, token budgets, per-session action quotas, task-queue isolation per downstream; circuit breakers on tool servers |
| ASI09 human-trust exploitation | Citations mandatory for factual claims; confidence/abstention surfaced; AI-interaction disclosure (EU AI Act Art. 50) |
| ASI10 rogue agents | Lifecycle governance: TTL heartbeats, synthetic probes, kill switch, drift demotion ([agent-lifecycle.md](agent-lifecycle.md)) |

## Content Guardrails

Layered, and layered means each layer is allowed to be imperfect:

1. **Gateway inbound:** injection-pattern classifier, PII detection/redaction
   (Presidio-class) per tenant policy.
2. **Retrieval:** trust labels + injection screening at ingestion (above).
3. **Agent outbound:** schema validation, output-handling rules (LLM05 —
   agent output is untrusted input to whatever consumes it; no
   string-interpolated execution), secret/PII egress scanning.
4. **System prompts** are hardened (instruction hierarchy, delimiting) but
   treated as bypassable — never the control.

## Secrets and Credential Brokering

Agents hold **no tool credentials.** The tool gateway brokers: it holds
system-of-record credentials (vault-backed), validates the caller's delegated
token, and injects downstream credentials per call. A fully compromised agent
yields scoped, expiring platform tokens — not ITSM passwords or cloud keys.

## Platform SDLC Security

- Mandatory review (2 humans) for: manifests, prompts, policies, tool-server
  code — same bar as code.
- CI: secret scanning, dependency audit (pip-audit / npm audit), pinned
  GitHub Actions, OpenSSF Scorecard scheduled, CodeQL SAST.
- Red-team suite (prompt injection, extraction, jailbreak, tool-abuse cases)
  is a **blocking CI gate** for agent changes and a recurring production
  probe — see [evaluation.md](evaluation.md).
- Vulnerability handling per [SECURITY.md](../../SECURITY.md) — agentic
  bypasses (policy evasion, injection-based privilege escalation, audit
  evasion) are explicitly in scope as vulnerabilities.

## Compliance Posture

Built to make adopters' compliance easy rather than claiming it ourselves:
audit trails and human-oversight hooks satisfying EU AI Act Art. 12/14/26
patterns and Art. 50 transparency (AI-interaction disclosure on by default);
control mapping to NIST AI RMF and ISO/IEC 42001 documented per release;
SOC 2-friendly evidence (change management over prompts/models/policies is
just git + CI history).
