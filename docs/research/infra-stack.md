# Research Brief: NATS, Temporal, pgvector, and OSS Project Standards

> Compiled 2026-07-10 as input to the platform architecture. Facts verified via
> web search unless flagged. See [README](README.md) for the research index.

## 1. NATS

### Licensing/governance: resolved, stay on Apache 2.0

In April 2025, Synadia attempted to reclaim the NATS project from CNCF and relicense future server releases under BSL; CNCF pushed back publicly. The dispute was **settled on May 1, 2025**: Synadia assigned its NATS trademark registrations to the Linux Foundation, CNCF retains the nats.io domain and GitHub repos, and **the NATS server remains Apache 2.0 under CNCF stewardship** with Synadia's continued involvement ([CNCF blog](https://www.cncf.io/blog/2025/05/01/protecting-nats-and-the-integrity-of-open-source-cncfs-commitment-to-the-community/), [The Register](https://www.theregister.com/2025/05/02/cncf_synadia_nats/), [InfoQ](https://www.infoq.com/news/2025/05/nats-cncf-open-source/)). Risk for adopters is now low; note that Synadia's commercial layer (Synadia Cloud/Platform) remains proprietary. NATS maintainers have since moved to a **6-month server release cycle** ([NATS 2.12 blog](https://nats.io/blog/nats-server-2.12-release/)).

### JetStream current capabilities (server 2.11/2.12)

Current server line is **2.12** (2.13 pending under the 6-month cadence). Notable recent JetStream features:

- **2.11** ([release notes](https://docs.nats.io/release-notes/whats_new/whats_new_211)): per-message TTLs (`Nats-TTL` header), consumer pausing (`PauseUntil`), pull-consumer **priority groups** with pinning/overflow (failover and regional-affinity patterns), stream ingest rate limiting (`max_buffered_size/msgs`), distributed message tracing (`Nats-Trace-Dest`).
- **2.12** ([release notes](https://docs.nats.io/release-notes/whats_new/whats_new_212), [GitHub](https://github.com/nats-io/nats-server/releases/tag/v2.12.0)): **atomic batch publish** (`AllowAtomicPublish`), **distributed counter CRDTs** (`AllowMsgCounter`), delayed/scheduled messages (`AllowMsgSchedules`), mirror promotion for DR, and **strict mode on by default** (invalid JetStream API requests are rejected, not just logged) — validate client payloads before upgrading.

### Services framework ("micro")

The `micro` package (Go/Python/TS/Rust/C/…) gives request-reply services **built-in discovery, PING, INFO, and STATS endpoints** with zero external registry; `nats micro ls/stats` inspects live services, and horizontal scaling is just queue-group subscription ([NATS by Example](https://natsbyexample.com/examples/services/intro/go/), [oneuptime guide](https://oneuptime.com/blog/post/2026-02-02-nats-microservices/view)). This is the idiomatic replacement for Consul/etcd-style discovery in a NATS-native platform.

### Request-reply vs streams

Rule of thumb (consistent with [NATS docs](https://docs.nats.io/nats-concepts/jetstream) and Synadia's ["Rethinking Microservices"](https://www.synadia.com/blog/rethinking-microservices)): use **core NATS request-reply** for synchronous, ephemeral RPC (agent tool invocation, control-plane commands) — at-most-once, microsecond overhead; use **JetStream streams** where you need durability, replay, exactly-once processing (dedup windows + double-ack), work-queue retention, or audit trails (agent event logs, task queues). Don't put RPC through JetStream "for safety" — it adds Raft consensus cost to every message; 2.11's priority groups and 2.12's batch publish narrow the remaining gaps for queue workloads.

### KV and Object Store

Both are JetStream abstractions (a KV bucket is a stream with per-subject message limits) and are production-grade, inheriting replication/clustering ([KV docs](https://docs.nats.io/nats-concepts/jetstream/key-value-store)). Constraints to design around: KV history caps at **64 revisions** (use a raw stream if you need more); KV/Object stores guarantee monotonic reads/writes but **not read-your-writes** when direct gets are served by followers/mirrors; Object Store chunks large payloads (values >1MB default message limit) but is best for internal artifacts, not an S3 replacement, and many-small-object workloads can be cheaper in KV ([Synadia: KV vs Object Store](https://www.synadia.com/blog/choosing-nats-kv-or-object-store-for-many-small-objects)). Sub-millisecond hot counters are still better in Redis — though 2.12 counter CRDTs cover many counting cases.

### Multi-tenancy, subjects, and security

- **Accounts are the tenancy primitive**: each account is an isolated subject namespace; cross-tenant sharing is explicit via subject exports/imports (streams and services) ([docs](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/accounts)). Official guidance is to scope accounts by application/service offered; for an agent platform, account-per-tenant (or per-environment) with a shared "platform" account exporting services is the standard shape.
- **Subject hierarchy**: within an account, use consistent token positions, e.g. `<domain>.<tenant>.<entity>.<id>.<verb>` so user permissions can be templated with wildcards (`agents.{{tenant}}.>`). Specific-to-general token ordering and avoiding unbounded subject cardinality per stream are widely repeated community guidance (*from training data — no single canonical doc; the docs' subject-based messaging page covers wildcard mechanics*).
- **Decentralized auth**: three-tier NKEY/JWT trust chain — Operator → Account → User; JWTs are signed offline and servers need no user database. For fleets of clients, have each generate its NKey locally and get a signed user JWT from an onboarding service ([JWT guide](https://docs.nats.io/running-a-nats-service/nats_admin/security/jwt), [Synadia onboarding post](https://www.synadia.com/blog/onboarding-distributed-nats-clients-nkeys-jwts)).
- **Composing with application JWT/RBAC**: the bridge is **auth callout** — the server invokes your auth service on each connection; it validates whatever credential the client presents (your app JWT, OAuth token, API key), consults your RBAC, and mints a NATS user JWT with pub/sub permissions for that session. **Scoped signing keys** let the account define permission templates so the callout only picks a role rather than embedding permissions ([auth callout docs](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/auth_callout), [Synadia on dynamic permissions](https://www.synadia.com/blog/changing-nats-permissions-dynamically-auth-callout)). Recommended pattern: application JWT (OIDC) at the API edge → auth callout translates claims → subject-level NATS permissions; keep NATS permissions coarse (tenant prefix) and enforce fine-grained RBAC in services.

## 2. Temporal

### AI-agent orchestration patterns

Temporal has leaned hard into agents as a flagship use case ([temporal.io/solutions/ai](https://temporal.io/solutions/ai)). The canonical shape, per [temporal-community/temporal-ai-agent](https://github.com/temporal-community/temporal-ai-agent) and the [AI cookbook](https://docs.temporal.io/ai-cookbook/human-in-the-loop-python):

- **Agent loop as a workflow**: LLM calls and tool calls are Activities (retryable, timeboxed); the workflow holds conversation state. Human-in-the-loop = `workflow.wait_condition` on a Signal — waits hours/days at zero compute cost.
- **Signals/Queries/Updates**: Queries = non-blocking reads; Signals = async writes; **Updates** (GA) = synchronous, tracked writes with validators — the right primitive for "user sends a message and awaits the agent's reply" ([message-passing docs](https://docs.temporal.io/encyclopedia/workflow-message-passing)). Best practice from the entity/actor pattern: signal handlers only enqueue; the main loop drains queues ([actor workflows blog](https://temporal.io/blog/actor-workflow-player-sessions)).
- **Child workflows / Nexus** for sub-agents: the community workshop demonstrates a supervisor agent delegating to specialists via child workflow and via Nexus (cross-namespace calls, now **GA in Python**) ([ai-agents-workshop-python](https://github.com/temporal-community/ai-agents-workshop-python)).
- **Continue-as-new for long agent loops**: event history is capped at **50k events / 50 MB**; long conversations must periodically continue-as-new, carrying summarized state, after waiting for handlers to drain ([very-long-running workflows](https://temporal.io/blog/very-long-running-workflows)). Large transcripts should live outside history (payload limits ~2MB/blob) — store in your DB/object store and pass references (*last point from training data, consistent with docs guidance*).

### OpenAI Agents SDK integration

Temporal + OpenAI Agents SDK (Python) shipped public preview in 2025 and went **GA March 23, 2026**: each agent/LLM invocation runs as an Activity inside a workflow, giving automatic retry on rate limits and crash resume without re-burning tokens ([announcement](https://temporal.io/blog/announcing-openai-agents-sdk-integration), [cookbook](https://docs.temporal.io/ai-cookbook/openai-agents-sdk-python), [InfoQ](https://www.infoq.com/news/2025/09/temporal-aiagent/)). There are also Temporal integrations with **Pydantic AI** ([pydantic docs](https://pydantic.dev/docs/ai/integrations/durable_execution/temporal/)) and **Vercel AI SDK** for TypeScript ([blog](https://temporal.io/blog/building-durable-agents-with-temporal-and-ai-sdk-by-vercel)), plus an April 2026 sandboxed-execution direction with OpenAI ([blog](https://temporal.io/blog/introducing-temporal-and-agentic-sandboxes-openai-agents-sdk)).

### Versioning safely

Two mechanisms ([versioning docs](https://docs.temporal.io/develop/python/workflows/versioning)):

- **Patching** (`workflow.patched("my-change")`): branch old/new code paths; deprecate patches after old executions drain. Works everywhere but accumulates branches.
- **Worker Versioning** (now **GA**): pin workflows to a Worker Deployment Version; old workers run old code, new workers new code — the default recommendation when you can run versioned deployments. **Upgrade-on-Continue-as-New** (public preview) lets long-running/entity workflows adopt new versions at the CaN boundary with zero patches — ideal for perpetual agent loops ([announcement](https://temporal.io/blog/ga-worker-versioning-public-preview-upgrade-on-continue-as-new)). Note: the pre-2025 experimental worker-versioning API is removed from the server as of March 2026.

### Workers, task queues, rate limiting, sagas

- One task queue per rate-limited downstream (each LLM provider gets its own) so `max_task_queue_activities_per_second` (server-enforced, global across workers) caps calls; `max_activities_per_second` is the per-worker knob ([rate-limit blog](https://temporal.io/blog/rate-limit-downstream-apis), [worker tuning reference](https://docs.temporal.io/develop/worker-tuning-reference)). SDKs now support **poller autoscaling**, recommended for most deployments ([worker performance](https://docs.temporal.io/develop/worker-performance)).
- **Saga/compensation**: idiomatic implementation is a compensation stack in the workflow (append undo-activities as steps succeed, run them in reverse in a catch block); Python/TS have no dedicated Saga class à la Java — pattern documented in community guides ([DZone patterns overview](https://dzone.com/articles/temporal-workflow-design-patterns); *specifics from training data*).
- **SDK maturity**: Python SDK is GA and now among the best-supported (Nexus GA, OpenAI Agents GA, standalone Activities in preview); TypeScript SDK is GA for core features but trails Python on the newest capabilities (Nexus public preview, standalone Activities pre-release) ([changelog](https://temporal.io/change-log/product-area/python-sdk), [SDK docs](https://docs.temporal.io/develop)).

## 3. pgvector

### Current capabilities

Latest tag is **v0.8.5 (July 8, 2026)**; 0.8.x is a steady maintenance line since 0.8.0 (Oct 2024) ([tags](https://github.com/pgvector/pgvector/tags)). Feature set: HNSW + IVFFlat indexes; types `vector`, **`halfvec`** (fp16, ~half the storage/RAM with minimal recall loss), `bit`, `sparsevec`; six distance operators ([0.8.0 announcement](https://www.postgresql.org/about/news/pgvector-080-released-2952/)). The headline 0.8 feature is **iterative index scans**: for filtered queries, the index keeps fetching candidates until the filter yields enough rows or a scan budget is hit (`hnsw.iterative_scan = strict_order|relaxed_order`), fixing the classic "over-filtered ANN returns too few rows" failure ([AWS deep dive](https://aws.amazon.com/blogs/database/supercharging-vector-search-performance-and-relevance-with-pgvector-0-8-0-on-amazon-aurora-postgresql/)). Common quantization recipe: index `halfvec` casts of full-precision columns for smaller/faster HNSW; binary quantization via `bit` + Hamming rerank (*recipe from training data, matches pgvector README*).

### Metadata filtering strategies

ANN indexes don't natively pre-filter; post-filtering reduces recall ([discussion](https://dev.to/mongodb/no-pre-filtering-in-pgvector-means-reduced-ann-recall-1aa1)). In order of preference: (1) rely on 0.8 iterative scans plus B-tree indexes on filter columns; (2) **partial HNSW indexes** per high-value category — measured ~11x smaller / ~20x faster builds ([index patterns](https://medium.com/@bhagyarana80/10-pgvector-index-patterns-to-keep-postgres-snappy-a1514cf44696)); (3) **partition by strongest natural key (tenant)** so each partition carries its own small index ([dbi-services guide](https://www.dbi-services.com/blog/pgvector-a-guide-for-dba-part-2-indexes-update-march-2026/)); (4) raise `hnsw.ef_search` when recall dips. For multi-tenant agent memory, partition-per-tenant (or partial indexes keyed on tenant) plus RLS is the standard pattern (*composition from training data*).

### Scaling limits and off-ramps

pgvector comfortably serves ~1M vectors at sub-20ms with 95%+ recall; at **tens of millions**, HNSW's in-RAM graph becomes the constraint ([pecollective review](https://pecollective.com/tools/pgvector/)). **pgvectorscale** (Timescale/TigerData, PostgreSQL-licensed extension) adds **StreamingDiskANN** — disk-resident graph + statistical binary quantization — extending viability to hundreds of millions of vectors, with published claims of 28x lower p95 vs Pinecone's storage-optimized index ([overview](https://www.softwareseni.com/pgvector-pgvectorscale-and-the-postgres-vector-search-stack-explained/), [analysis](https://thebuild.com/blog/on-pgvectorscale-and-hybrid-search-without-an-elasticsearch-sidecar/)). Don't shard prematurely: the industry lesson (OpenAI runs a single primary + read replicas at 800M users) is to optimize the actual bottleneck; reach for Citus/sharding only at 1TB+ multi-tenant write-heavy scale, and consider a dedicated vector DB only beyond ~500M vectors or when index rebuild/ingest rates dominate ([scaling guide](https://www.velodb.io/glossary/ways-to-scale-postgresql), [OpenAI case](https://dbadataverse.com/tech/postgresql/2026/02/postgresql-scaling-what-openai-proved-wrong-at-800m-users)).

### Hybrid search

Standard 2026 pattern: BM25-style ranking + vector similarity fused with **Reciprocal Rank Fusion** in SQL. Native Postgres `tsvector`/`ts_rank` works but isn't true BM25; extensions **pg_textsearch** (TigerData) and ParadeDB's pg_search bring real BM25, and TigerData ships a documented BM25+pgvectorscale+RRF stack ([tigerdata hybrid search](https://www.tigerdata.com/blog/elasticsearchs-hybrid-search-now-in-postgres-bm25-vector-rrf), [100-line RRF example](https://dev.to/gabrielanhaia/hybrid-search-in-100-lines-bm25-pgvector-with-rrf-merge-58cn), [pedroalonso.net](https://www.pedroalonso.net/blog/postgres-bm25-search/)). RRF with k=60 remains the default fusion constant (*from training data*).

### Chunking/embedding pipeline (largely training data — flag accordingly)

Consensus practice, not tied to one authoritative doc: structure-aware chunking (headings/paragraphs/code blocks) at ~200–500 tokens with 10–15% overlap; store chunk text + metadata (tenant, source, doc id, position) alongside the embedding; hash-based change detection to avoid re-embedding; embed asynchronously via a queue (a NATS/Temporal stack fits: Temporal workflow per document, embedding calls as rate-limited activities); keep embedding-model name+version as a column so you can dual-write during model migrations and reindex online with `CREATE INDEX CONCURRENTLY`.

## 4. Python + TypeScript OSS monorepo standards

### Layout & tooling

- **TypeScript side**: pnpm workspaces + Turborepo is the 2026 default (`apps/` + `packages/`, never import app code from packages); Nx if you outgrow it ([turborepo docs](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository), [comparison](https://viadreams.cc/en/blog/monorepo-tools-2026/)).
- **Python side**: **uv workspaces** are now the standard analogue (single lockfile, member packages under `packages/` or `libs/`); gotcha: a virtual root needs a `[project]` name that doesn't collide with a member ([uv monorepo issue](https://github.com/astral-sh/uv/issues/10960), [AWS dev.to writeup](https://dev.to/aws/3-things-i-wish-i-knew-before-setting-up-a-uv-workspace-30j6)). Typical combined layout: `apps/`, `packages/` (TS), `libs/` or `python/` (uv workspace), `docs/`, `.github/` (*combined-layout convention from training data*).

### Licensing & governance

MIT hygiene: root `LICENSE`, `license = "MIT"` (SPDX expression) in each `pyproject.toml`/`package.json`, and license headers optional but SPDX identifiers encouraged. Governance file set that OpenSSF criteria and GitHub community standards expect: `README`, `CONTRIBUTING.md` (must explain the contribution process and acceptance requirements), `CODE_OF_CONDUCT.md` (Contributor Covenant, standard location), `SECURITY.md` (vulnerability reporting channel), `GOVERNANCE.md` (decision-making + key roles), and `CODEOWNERS` for review routing ([OpenSSF criteria](https://www.bestpractices.dev/en/criteria/0); *CODEOWNERS specifics from training data*).

### Versioning & release automation

Conventional Commits + SemVer is table stakes; tooling choice ([comparison](https://www.pkgpulse.com/guides/semantic-release-vs-changesets-vs-release-it-release-2026)):

- **Changesets** (~3M weekly downloads): PR-based intent files, best-in-class for multi-package monorepos, and workable for **polyglot** repos with some glue ([polyglot changesets writeup](https://luke.hsiao.dev/blog/changesets-polyglot-monorepo/)).
- **release-please** (Google): derives versions/changelogs from Conventional Commits via release PRs; supports both `node` and `python` release types in one manifest config — often the lower-friction choice for mixed Python+TS repos (*manifest-config detail from training data*).

Pick one: release-please if you enforce Conventional Commits (add commitlint in CI), Changesets if you prefer explicit human-authored change intents.

### CI quality gates

Standard 2026 gate set: Python — **ruff** (lint+format), **mypy** (or pyright) strict on `src/`, **pytest** + coverage; TypeScript — **eslint** (flat config), `tsc --noEmit`, **vitest**; plus turbo/uv-aware caching so only affected packages run (*consensus from training data; tool choices corroborated across the monorepo guides above*). Supply-chain gates: pinned actions, `dependabot`/`renovate`, and **OpenSSF Scorecard** as a scheduled action (0–10 scores across branch protection, token permissions, pinned dependencies, SAST, etc.) ([scorecard.dev](https://scorecard.dev/)), plus self-certifying the **OpenSSF Best Practices badge** (passing level covers change control, reporting, quality, security basics; the newer "Baseline" series is a MUST-only checklist) ([badge program](https://openssf.org/projects/best-practices-badge/), [criteria](https://www.bestpractices.dev/en/criteria)).

### Docs & ADRs

- **mkdocs-material** (with mkdocstrings for Python API docs) is the default for Python-centric platforms; **Docusaurus** wins when you want a React-based product-docs site with versioned docs and MDX; either is defensible — choose based on who writes docs (*comparison from training data; both projects remain actively maintained as of 2026*).
- **ADRs**: keep `docs/adr/NNNN-title.md` using MADR or Nygard format; ADRs are immutable once accepted and superseded by new ones (*from training data; canonical reference [adr.github.io](https://adr.github.io/)*).
