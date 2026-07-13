# Knowledge and Retrieval (pgvector)

The Knowledge Service is shared infrastructure: one governed ingestion and
retrieval path that the Knowledge & Policy agent is built on and every other
agent may call. Decision record: [ADR-0003](../adr/0003-pgvector-for-rag.md).

## Retrieval Architecture

**Hybrid search by default.** Lexical ranking (Postgres full-text now; a
BM25 extension such as ParadeDB `pg_search` when relevance demands it) plus
vector similarity (pgvector HNSW), executed in parallel and fused with
Reciprocal Rank Fusion (k=60) in SQL. Pure vector search loses exact
identifiers — policy numbers, CVE IDs, hostnames, version strings — which
are precisely what enterprise questions contain.

Worked example: *"Show me the deployment steps for the core payments
microservice using Helm chart v2.4.0."* Vector search carries the concept
("deployment steps for core payments"); the exact tokens `Helm` and
`v2.4.0` are matched by two distinct mechanisms, chosen deliberately:

- **Structured identifiers → metadata filter columns.** Where an identifier
  is extractable at ingestion (chart version, service name, doc type), it
  becomes an indexed chunk-metadata column and the query plans it as an
  exact filter — cheaper and stricter than any ranking.
- **In-text tokens → lexical leg.** Identifiers buried in prose that
  ingestion didn't extract are BM25's job, fused with the vector leg via
  RRF.

Both legs run in parallel; iterative index scans (below) keep the filters
from starving ANN recall.

**Index strategy.**

- `halfvec` (fp16) HNSW indexes — half the RAM for negligible recall loss.
- **Iterative index scans** (pgvector ≥ 0.8) + B-tree indexes on filter
  columns, so tenant/classification/source filters don't starve ANN results.
- **Partition by tenant**; row-level security as backstop. Each partition
  carries its own small index — tenant isolation and index performance from
  the same decision.
- `hnsw.ef_search` per-query tunable: retrieval-heavy agents may trade
  latency for recall explicitly.

**Scale posture.** pgvector to ~10M vectors per tenant partition is the
designed envelope. Off-ramps, in order: pgvectorscale (StreamingDiskANN) on
the same Postgres, then a dedicated vector store — behind the same Knowledge
Service API, which is the abstraction consumers depend on. No agent queries
pgvector directly.

## Ingestion Pipeline

**Event-driven first.** Freshness is a product feature — developers stop
trusting a RAG system the first time it cites last week's runbook. Source
systems emit tiny change events onto `acp.<tenant>.ingest.<source_id>`
(git push/merge webhooks, CI completion, wiki page saves, ticket
resolutions); each event triggers a Temporal `IngestionWorkflow` that
fetches and processes just the changed artifact. Target: seconds-to-minutes
from merge to retrievable, not nightly batch.

**Reconciliation sweep second.** Events alone drift: webhooks drop,
connectors break silently, sources don't always emit. A scheduled per-source
sweep diffs content hashes against the corpus and backfills whatever the
event path missed — events deliver freshness, the sweep guarantees the
staleness SLO.

A Temporal `IngestionWorkflow` per source document:

```
fetch → classify/label → chunk → embed → index → verify
```

Large documents (the 500-page security policy) fan chunks across parallel
embedding activities; provider rate limits are absorbed by the dedicated
task queue ([orchestration.md](orchestration.md)), so a bulk ingest
backpressures cleanly instead of melting the embedding API or starving
interactive traffic.

- **Structure-aware chunking** (~200–500 tokens, 10–15% overlap, headings and
  code blocks kept intact), chunk metadata: tenant, source system, document
  ID, version, effective date, classification, position.
- **Hash-based change detection** — unchanged chunks are never re-embedded.
- **Embedding calls are rate-limited activities** on the provider task queue,
  batched where the provider supports it.
- **Model versioning:** embedding model name+version is a column. Migrations
  dual-write to a new column, reindex with `CREATE INDEX CONCURRENTLY`, flip
  reads, then drop — zero-downtime re-embedding is a designed operation, not
  an incident.

## Corpus Lineage: the Ingest Ledger

Regulated adopters (finance, healthcare) must answer: *"why did the agent
make this decision, and what exact version of the documentation did it read
at that second?"* LLMs are non-deterministic; the compensating control is a
**fully reconstructable data pipeline** — every corpus mutation lands on an
immutable ledger, and every retrieval records exactly which ledger entries
it served.

```
[doc update / git push] ─► NATS: acp.<tenant>.ingest.<source_id>
                              │
                              ▼
                      IngestionWorkflow (Temporal)
                        │ assigns lineage_id (UUIDv7) per chunk
                        ├─► write 1: audit block → acp.<tenant>.audit.corpus.<source_id>
                        │            (raw chunk text, chunker version, embedding
                        │             model+version, author, doc version, lineage_id)
                        └─► write 2: embedding + metadata + lineage_id → pgvector
                              │
                              ▼
                   JetStream (append-only, deny-delete/deny-purge, R3)
                              │  tiered consumer
                              ▼
                   WORM object storage (hash-chained, 7y+ retention tier)
```

Design points:

- **`lineage_id` is a UUIDv7** — time-ordered, so the ID itself embeds when
  the corpus changed, and index-friendly in both Postgres and the ledger.
  It is also the **idempotency key** for both writes: the Temporal workflow
  retries until both complete, and replays cannot fork history.
- **Write ordering:** the audit block publishes *before* the vector write.
  A crash between the writes leaves an audited intent with no serving
  vector (harmless, retried) — never a serving vector with no provenance.
- **JetStream is the capture ledger, not the archive.** The
  `audit.corpus.>` stream is file-backed, replicated, and configured
  deny-delete/deny-purge — but retains weeks-to-months. Long-horizon
  retention (7+ years where regulation demands) lives in the WORM tier
  (object-lock compliance mode, hash-chained), which is what examiners and
  legal holds actually need. Same pipeline as the agent-action audit trail
  ([governance-and-policy.md](governance-and-policy.md)).
- **The ledger stores the raw chunk text** plus chunker version and
  embedding model+version — reconstructability does not depend on
  re-running an embedding model that may no longer exist. Consequence: the
  ledger inherits the corpus's data classification, and erasure obligations
  (GDPR) are met by **crypto-shredding** (chunks encrypted per-source;
  destroy the key), never by deleting ledger entries.
- **The auditor's join path:** agent trace → retrieval event (which records
  the served `lineage_id`s — already required, see below) → ledger entries
  → exact corpus state at that instant, including who changed it and when.
  One query, no forensics project.

## Governance of Knowledge

Retrieval is a governed surface, not a free-for-all (OWASP LLM08 — vector
and embedding weaknesses; ASI06 — context poisoning):

- **Provenance required:** every chunk carries source, version, effective
  date, and `lineage_id`; every retrieved passage used in an answer becomes
  a citation, and every retrieval event records the `lineage_id`s it served.
  Agents cannot cite what the store cannot attribute.
- **Ingestion is the trust gate:** only registered source connectors with
  owner sign-off feed the corpus; direct writes are disabled. Content from
  low-trust sources (e.g., ticket comments) is labeled and excluded from
  policy-interpretation retrievals by default.
- **Classification-aware retrieval:** the Knowledge Service filters by the
  *caller's* effective permissions (from the delegated token) — an agent
  acting for a user never retrieves documents that user couldn't read.
  Access checks happen in the query, not in the prompt.
- **Staleness SLOs:** each source declares a freshness target; the ingestion
  scheduler alerts when a source lags. Answers surface document effective
  dates so stale grounding is visible to users, not hidden.
- **Poisoning defense:** new/changed chunks from lower-trust sources pass
  content guardrails (injection-pattern screening) before indexing; the
  retrieval API tags each passage with its trust label so agents can weigh —
  and prompts can delimit — untrusted content.

## Session Context Cache

Multi-step tasks re-retrieve the same context repeatedly — the repository's
structural overview, the open incident, the relevant policy section — once
per sub-task. A **platform-managed Session Context Cache** fixes redundant
deep retrievals and Postgres load without ever weakening the access check.

It lives **inside the Knowledge Service** (`apps/knowledge/src/session-cache.ts`),
because `SearchService.search` is the single retrieval door: the SDK
`Retriever` and the MCP tool server both funnel through it. It memoizes
**only** the expensive, permission-invariant half of a search —
`embedder.embed()` + `store.search()`. **Authorization is never cached:**
every call still runs `verifier.verify()` and the Cedar `policy.authorize()`
gate, and a cache hit still emits `retrieval.served` with the exact
`lineage_id`s it served. The cache cannot serve what authorization would
reject.

This is not agent-local memory (which the standards ban — it breaks replay
and shadow comparison). The value holds only reconstructable retrieval
context (chunk text + citations), never execution state (loop position,
plan progress, conversation memory). It is Knowledge Service infrastructure
with the same governance as retrieval itself:

- **Permission-snapshot keyed (the security crux):** the entry key is
  `<tenant>.<permHash>.<queryHash>`, where `permHash = sha256(stable JSON of
  {v, tenant, actor, sorted scopes, sorted classifications, embedding_model})`
  is derived from VERIFIED claims only. Two principals share a key **iff**
  their effective permissions are identical — i.e. the same principal with
  the same grant, whose authorized view is identical by construction. No
  request path supplies a `permHash` or reads by a foreign prefix, so a
  cross-principal or cross-tenant hit is *structurally impossible*, not merely
  hash-improbable. A narrowed scope or dropped classification changes the
  key, so the pre-change (broader) entry is unreachable.
- **TTL ≤ token TTL:** `expires_at = min(now + ttl, claims.exp*1000)`,
  enforced on read. Cached content never outlives the authorization that
  admitted it.
- **Lineage-invalidated:** a durable consumer on `acp.*.audit.corpus.>`
  bumps `gen.<tenant>.<source_id>` (to the audit stream sequence) on every
  `corpus.mutation`; entries capture the generation of each source they drew
  from, and any mismatch is a stale miss + evict. Eviction keys on the stable
  `source_id`, not the per-version `lineage_id`. If a runbook changes
  mid-incident, the next step sees the update, not the stale copy.
- **Kill-switch & revocation:** a fleet or tenant halt, or a principal
  denial, bypasses the cache entirely (live retrieval, no marker); an
  operator force-purge (`SessionCacheControl.purgeTenant`) removes a tenant's
  entries immediately for hard-delete / legal-hold, leaving generations
  intact.
- **Memory storage, fail-safe degradation:** the bucket is MEMORY-backed, so
  classified context never touches disk and a restart resets entries and
  their captured generations together (self-consistent). Every failure mode —
  disabled, watcher not yet seeded, any KV error, oversize entry, wiped
  bucket — degrades to correct LIVE retrieval, never an error and never a
  stale-wrong serve.
- **Provenance-preserving:** every hit re-emits `retrieval.served` with the
  served `lineage_id`s and a `details.cache` marker (`hit`/`miss`), so replay
  and the dashboards know exactly what each step saw. The honest win is fewer
  deep retrievals and Postgres load shed, not KV latency.

**Design deviation (recorded):** the earlier sketch imagined a *bucket per
task session*. The shipped design instead uses a single permission-snapshot-
keyed bucket. A per-session bucket would fragment the cross-session reuse win
and multiply streams (thousands of task sessions); the permission-binding
security property is fully preserved either way, and session-end / permission
change is handled by TTL ≤ token-exp + lineage eviction + kill-switch bypass.
`task_id`/`step_id` are deliberately excluded from the key (they are passed
only for the audit reason) so intra-task and cross-task identical retrievals
share one entry; freshness comes from lineage eviction, not key fragmentation.

**Configuration (default OFF):**

| Env var | Default | Meaning |
| --- | --- | --- |
| `ACP_SESSION_CACHE_ENABLED` | `false` | Master switch. Off ⇒ correct-but-uncached; the existing E2E suite is unaffected. |
| `ACP_SESSION_CACHE_TTL_MS` | `60000` | Per-entry TTL before clamping to the token expiry. |
| `ACP_SESSION_CACHE_MAX_VALUE_BYTES` | `262144` | Oversize entries are skipped (served live), never truncated. |
| `ACP_SESSION_CACHE_MAX_BYTES` | `67108864` | Bucket size cap (memory storage). |

## Retrieval API (sketch)

```
knowledge.search(query, k, filters {source, classification, as_of}, mode {hybrid|vector|lexical})
  → [{chunk, score, citation {doc_id, version, effective_date, url, lineage_id}}]
```

**Three doors, one governance regime:**

1. **SDK `Retriever`** — how agents consume knowledge; rides NATS
   request-reply internally as the low-latency path.
2. **MCP tool server** — the same API exposed as standard MCP tools
   (Streamable HTTP) behind the tool gateway, per
   [ADR-0006](../adr/0006-mcp-tools-a2a-agent-cards.md). This is what makes
   the corpus consumable by **developer CLIs and IDE agents** (terminal
   coding agents, editor assistants) — with the caller's identity,
   classification-aware filtering, policy decisions, and audit applied
   exactly as for platform agents.
3. **Knowledge agent capabilities** — `knowledge.answer_with_citations`
   etc., for composed, synthesized answers rather than raw chunks.

All three converge on the same service; transport is an implementation
detail, the permission check is not.

Answers built on retrieval must abstain below a confidence floor rather than
guess — enforced by the Knowledge agent's eval suite (citation precision and
abstention behavior are gated metrics; see [evaluation.md](evaluation.md)).
