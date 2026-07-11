# acme-corp — synthetic enterprise corpus v0

A fake enterprise for tests, local development, and CI. **No production data,
ever** ([testing standard](../../docs/standards/testing.md)): every document
here is invented for the fictional Acme Corporation.

- `corpus.json` — the source/document manifest the Knowledge Service ingests:
  source IDs, document IDs, versions, effective dates, classifications, URLs.
- `docs/` — the documents themselves (Markdown; one file per document).

The Phase 1 exit scenario ("What does our policy say about change freezes?")
grounds on `docs/policies/change-management.md` — treat that document's
change-freeze section as load-bearing for the E2E suite.

Growing the corpus: add the file under `docs/`, register it in
`corpus.json` with a bumped version and effective date. The ingestion
workflow treats `corpus.json` as the source of record for this fixture
connector.
