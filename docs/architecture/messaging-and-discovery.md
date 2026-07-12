# Messaging and Discovery (NATS)

NATS is the platform's nervous system: RPC, discovery, and durable eventing
in one substrate. Decision record: [ADR-0001](../adr/0001-nats-messaging-and-discovery.md).

## Usage Split

| Need | Mechanism | Why |
|---|---|---|
| Control-plane RPC (registry queries, policy checks, agent dispatch signals) | **Core NATS request-reply** | At-most-once, microsecond overhead; retries belong to the caller (or to Temporal, which owns durability for task steps) |
| Service discovery & health | **NATS services framework (`micro`)** | Built-in discovery/PING/INFO/STATS endpoints, no external registry; horizontal scale = queue groups |
| Audit events, task events, telemetry events | **JetStream streams** | Durable, replayable, exactly-once consumption (dedup + double-ack) |
| Registry cache, feature/policy flags, kill-switch state, session context cache | **JetStream KV** | Watchable keys; caveat: no read-your-writes from followers — authoritative reads go to Postgres. Session cache buckets are TTL-bound and permission-snapshot keyed ([knowledge-and-rag.md](knowledge-and-rag.md)) |
| Large artifacts (documents, transcripts) | **Not NATS.** Postgres/object storage; pass references | Keep messages small; JetStream is not a blob store |

Durability discipline: **don't route RPC through JetStream "for safety."**
Anything that must survive a crash is a Temporal workflow step, not a durable
message. JetStream is for events that are facts (things that happened), not
commands.

State discipline: **KV is never execution state.** Workflow and agent
execution state (loop position, plan progress, conversation state) lives in
Temporal history — the single source of truth that makes replay, crash
recovery, and shadow comparison work. Putting "active execution variables"
or prompt memory in KV creates a second source of truth that races with
history and silently breaks determinism. KV holds platform *control* state
(flags, kill switch, registry cache) and the governed
[Session Context Cache](knowledge-and-rag.md) — read-mostly, loss-tolerant,
reconstructable.

## Scaling Model

Agent workers are **stateless microservices**; burst absorption is queue
mechanics, not autoscaling heroics:

- Work dispatched as Temporal activities load-balances across every worker
  polling the agent's task queue; a spike of 1,000 patch tasks becomes
  queue backlog — visible, alertable, and drained by adding worker pods.
- Request-reply paths (registry, policy, knowledge fast path) scale via
  **NATS queue groups**: N replicas subscribe as one group, NATS
  load-balances per message.
- Because no worker holds session state (see state discipline above), any
  pod can serve any step — horizontal scale and crash recovery are the same
  property.

## Subject Hierarchy

Consistent token positions so permissions template with wildcards:

```
acp.<tenant>.task.<task_id>.<verb>          # task lifecycle events
acp.<tenant>.agent.<agent_id>.<verb>        # agent dispatch/status
acp.<tenant>.audit.<event_type>             # audit stream (JetStream)
acp.<tenant>.audit.corpus.<source_id>       # corpus lineage ledger (JetStream, deny-delete)
acp.<tenant>.ingest.<source_id>             # ingestion triggers (git hooks, CI, doc sources)
acp.<tenant>.telemetry.<signal>             # telemetry events (JetStream)
acp.platform.registry.<agent_id>.<verb>     # registry announcements (all tenants read)
acp.platform.control.<verb>                 # kill switch, flags
```

Rules:

- Tenant is always token 2; a tenant principal's NATS permissions are the
  wildcard `acp.<tenant>.>` plus explicit imports of `acp.platform.*` reads.
- Verbs are closed vocabularies per entity (documented in the protocol
  schema package), never free-form.
- Subject cardinality per stream is bounded — IDs appear in subjects only
  where per-ID consumption is needed.

## Multi-Tenancy and Bus Security

- **NATS accounts** are the hard isolation boundary: one account per tenant
  (and per environment), plus a `platform` account exporting control-plane
  services (registry, policy, token) as cross-account service exports.
- **Auth callout** bridges platform identity to bus identity: on connection,
  the callout responder validates the presented platform JWT (same JWKS as the
  Gateway), consults RBAC, and mints a session-scoped NATS user JWT from a
  **scoped signing key** template (role → subject permissions). Bus
  permissions stay coarse (tenant prefix + role template); fine-grained
  authorization happens at the Policy Service per call.
- No agent ever holds long-lived bus credentials; NATS JWTs expire with the
  platform token that produced them.
- **Implemented in Phase 3 item 0c** (dev stack): the callout responder lives
  in the token service (`apps/token/src/bus-auth/`) — zero-network local
  KeyStore verification over the existing NATS connection. An agent mints an
  `acp:bus` token with its own client (`client_credentials`, ≤15min) and
  connects presenting it; the responder accepts only `aud acp:bus` + role
  `agent` + a versioned `agent:{id}@…` sub + a mapped tenant + not
  kill-switched, then mints a `TENANT_ACME` user JWT whose exp equals the
  platform token's and whose pub/sub template is parameterized per agent (no
  permission reaches another agent or a platform-internal subject). Requests
  are xkey-sealed. Platform services keep static bypass users; the static
  tenant user is gone. A background refresh re-mints at ~2/3 TTL so reconnects
  present a live token (`BusTokenSource`, both SDKs).

## Discovery Flow

1. Agent worker starts → connects (auth callout) → registers with the NATS
   services framework (`micro`) → Registry confirms the agent record is in a
   routable state.
2. Registry publishes `acp.platform.registry.<id>.updated`; consumers update
   their local cache (KV bucket `registry` holds the current snapshot for
   cold start).
3. Orchestrator discovery = Registry query (structured filter + optional
   semantic ranking), **never** bus scanning. The bus provides liveness;
   the Registry provides truth (state, version weights, policy visibility).
4. Kill switch: Deployment Controller writes `suspended` to Postgres, then
   publishes the registry event and flips the KV flag — routers react in
   seconds without polling.

## External Interop

Inside the platform, agent-to-agent communication is orchestrated delegation
over NATS/Temporal — not point-to-point HTTP. At the platform edge:

- Each agent's card is exportable as an **A2A v1.0 Agent Card**, and the
  Gateway can expose selected agents as A2A endpoints (JSON-RPC binding) for
  external consumers. A2A task states map onto orchestrator task states
  (`input-required` ⇔ approval gate / elicitation).
- External A2A agents can be onboarded as **proxy agents**: a registry record
  whose worker is a thin adapter calling the remote endpoint, so policy,
  budgets, and audit still apply at our boundary.

This keeps the internal substrate efficient while remaining protocol-citizens
externally. See [research brief](../research/protocols-and-interop.md).
