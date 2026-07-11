# Domain Agents

The launch set of specialized agents. Each follows the same anatomy (see
[standards/agent-patterns.md](standards/agent-patterns.md)): a capability
manifest, a set of MCP tool bindings, domain evals, and a risk classification
per capability that drives policy.

Capabilities are classified by side-effect risk:

- **R0 read** — pure retrieval/analysis (default: allowed, logged)
- **R1 draft** — produces artifacts for humans (change drafts, PR comments)
- **R2 write-gated** — mutates a system of record behind an approval gate
- **R3 write-auto** — mutates without a human gate (earned per-capability via
  eval history; disabled platform-wide by default)

## Knowledge & Policy Agent

**Charter:** authoritative retrieval and interpretation of organizational
knowledge — policies, standards, runbooks, design docs — with citations.

- **Tools:** pgvector hybrid search over the document corpus; document
  fetchers (wiki, SharePoint/Drive, Git-backed docs); policy metadata store.
- **Capabilities:** `knowledge.search` (R0), `knowledge.answer_with_citations`
  (R0), `policy.applicable_policies` (R0), `policy.compliance_check` (R0 —
  advisory, never authoritative).
- **Special role:** other agents call it to ground their work ("what does
  policy say about change freezes?"), making it the most-composed agent and
  the first to build. The underlying Knowledge Service is also exposed as a
  standard **MCP tool server**, so developer CLIs and IDE agents consume the
  same governed corpus directly ([architecture/knowledge-and-rag.md](architecture/knowledge-and-rag.md)).
- **Hard requirements:** every answer carries citations with document version
  and effective date; answers without sufficient retrieval confidence must
  abstain rather than guess. Eval suite measures citation precision and
  abstention behavior, not just answer quality.

## Change / ITSM Agent

**Charter:** the change and incident lifecycle — drafting, risk context,
calendar conflicts, approvals status, post-incident timelines.

- **Tools:** ITSM API (ServiceNow/Jira SM class), change calendar, CMDB,
  on-call schedule.
- **Capabilities:** `change.draft` (R1), `change.conflict_check` (R0),
  `change.risk_context` (R0 — composes Network Security + Cloud + Source Code
  agents for impact), `change.submit` (R2), `incident.timeline` (R0).
- **Composition example:** `change.risk_context` fans out — "what does this
  change touch?" (CMDB) → "what's the network exposure?" (NetSec agent) →
  "what depends on it?" (Source Code agent) — and synthesizes a risk brief.

## Network Security Agent

**Charter:** read-and-explain over the network security estate — firewall
rules, segmentation, exposure analysis, policy verification.

- **Tools:** firewall managers, cloud security groups, IPAM, vulnerability
  scanner read APIs.
- **Capabilities:** `netsec.rule_search` (R0), `netsec.exposure_analysis`
  (R0), `netsec.change_impact` (R0), `netsec.rule_draft` (R1),
  `netsec.rule_apply` (R2 — requires change record + approval; late roadmap).
- **Risk posture:** highest-consequence domain; write capabilities ship last
  and only behind dual controls (policy engine + human approval + linked
  change record).

## Cloud Agent

**Charter:** multi-cloud inventory, configuration, and cost intelligence.

- **Tools:** cloud provider read APIs (AWS/Azure/GCP), cost/billing exports,
  IaC state (read), tagging/asset inventory.
- **Capabilities:** `cloud.inventory_query` (R0), `cloud.cost_analysis` (R0),
  `cloud.config_check` (R0), `cloud.rightsizing_draft` (R1),
  `cloud.tag_apply` (R2 — first low-blast-radius write capability on the
  roadmap, used to prove the R2 machinery).

## Source Code Agent

**Charter:** the code estate as a queryable system — dependencies, ownership,
CI health, change blast radius.

- **Tools:** Git forge APIs (GitHub/GitLab), dependency graph / SBOM store,
  CI system, code search.
- **Capabilities:** `code.dependency_query` (R0), `code.ownership` (R0),
  `code.change_blast_radius` (R0), `code.ci_health` (R0), `code.pr_annotate`
  (R1).

## Cross-Domain Scenarios (Acceptance Scenarios)

These scenarios define "the platform works" and become end-to-end evals:

1. **Change risk brief** — "We want to upgrade the payment service's TLS
   config tonight. What's the risk?" → Change agent orchestrates NetSec
   (exposure), Cloud (affected infra), Source Code (dependents), Knowledge
   (change-freeze policy) and returns a cited brief with a draft change record.
2. **Cost spike forensics** — "Why did spend jump 30% last week?" → Cloud
   agent identifies the resources; Source Code agent links the deploy that
   created them; Change agent finds the associated change record.
3. **Policy exposure audit** — "Are any internet-exposed services running
   images with critical CVEs, and what does policy require?" → NetSec ×
   Cloud × Source Code × Knowledge composition, with an auditable trail of
   every sub-question.
4. **Governed patch rollout** (the write-path scenario) — "Deploy the
   security patch for CVE-X to affected cloud infrastructure and log it in
   the ITSM system." → ITSM agent opens the change record (R2, gated);
   Cloud + NetSec agents scan and produce an execution plan; the plan hits
   a `require-approval` gate and a human approves from Slack/ITSM; the
   Cloud agent executes the gated write; a deliberately-injected failure on
   a later step must unwind the compensation stack (temporary access torn
   down, change record updated) and report honestly. Exercises approvals,
   sagas, and kill-switch interaction — the Phase 3 machinery.

Each scenario must complete with: full trace (every agent hop and tool call),
citations for every factual claim, policy decisions logged, and cost recorded
against the requesting principal. Scenario 4 additionally proves the failure
path: compensation, approval audit, and partial-result honesty.
