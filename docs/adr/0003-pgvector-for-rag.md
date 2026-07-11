# ADR-0003: Postgres + pgvector for Retrieval

- **Status:** Proposed
- **Date:** 2026-07-10
- **Deciders:** platform architecture group

## Context

The Knowledge Service needs vector + lexical retrieval with strict tenant
isolation, provenance metadata on every chunk, and classification-aware
filtering — and the platform already commits to Postgres as its system of
record. Expected scale: 10⁵–10⁷ chunks per tenant. Candidates: pgvector,
dedicated vector DBs (Qdrant, Weaviate, Milvus, Pinecone), Elasticsearch/
OpenSearch hybrid.

pgvector 0.8.x brings HNSW, `halfvec`, and iterative index scans (fixing
filtered-ANN recall); hybrid BM25+vector+RRF stacks in Postgres are
well-documented; pgvectorscale extends to 10⁸+ vectors if needed
([research](../research/infra-stack.md)).

## Decision

We will build retrieval on **Postgres + pgvector**, behind a Knowledge
Service API that owns the storage choice:

- Hybrid search (lexical + HNSW vector, RRF fusion) as the default mode.
- `halfvec` HNSW indexes; iterative index scans; tenant partitioning + RLS.
- Embedding model name+version as a column; migrations by dual-write +
  concurrent reindex.
- No agent touches the store directly — the service API is the contract.

## Alternatives Considered

- **Dedicated vector DB (Qdrant/Weaviate/Milvus/Pinecone):** better raw ANN
  scale, but a second stateful system to operate, secure, and tenant-isolate;
  joins between vectors and relational governance metadata (versions,
  classifications, citations) become application-side; Pinecone additionally
  conflicts with open-source self-hosting.
- **Elasticsearch/OpenSearch:** strong hybrid search, heavy operational
  footprint, and we'd still need Postgres — two sources of truth for
  document state.
- **pgvectorscale from day one:** unnecessary complexity before scale
  demands it; it is the designated first off-ramp, not the start.

## Consequences

- One database technology for relational state, vectors, and audit —
  transactional consistency between chunks and their governance metadata,
  RLS as a uniform isolation backstop, one backup/DR story.
- We accept ANN performance ceilings: the designed envelope is ~10M vectors
  per tenant partition; beyond that, pgvectorscale, then a dedicated store —
  both invisible behind the Knowledge Service API.
- True BM25 requires an extension (ParadeDB `pg_search` / pg_textsearch);
  we start with native full-text and upgrade when relevance metrics say so.
- Revisit if: corpus growth or ingest rates breach the envelope, or
  relevance evals show hybrid-in-Postgres materially trailing a dedicated
  engine on our workloads.
