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

## cloud & code estate (Phase 2 tool agents)

Datasets served by the `@acp/mock-tools` MCP servers (cloud-estate :7301,
code-forge :7302) and ground truth for the Phase 2 exit scenario:

- `cloud/inventory.json` — resource snapshot as of 2026-07-08.
- `cloud/costs.json` — weekly spend by service, complete through 2026-07-05.
- `code/repos.json` — the repo catalog.
- `code/dependencies.json` — the dependency graph.
- `code/ci-runs.json` — CI activity 2026-06-20 → 2026-07-08.

Load-bearing storyline facts (asserted by eval suites and the E2E tests —
change them only with the suites):

- On 2026-07-01 deploy `d-2026-07-01-042` scaled the payments fleet 4 → 10
  replicas for a TLS 1.3 migration load test (see
  `standard/tls-configuration` in the corpus) and nobody scaled back:
  6× `m5.4xlarge` at $2,925/month each, tagged with the deploy ID.
- Weekly spend rose **30.0%** ($13,940 → $18,120) in the week of
  2026-06-29; payments-api (+$4,060, **+97.1%**) dominates; every other
  service moved <2%.
- `acme/payments-service` had 9 CI runs since 2026-06-24 — 7 passed,
  2 failed (**77.8%** pass rate); `acme/openssl-shim` had zero (the
  quiet-repo case).
- One `acme/checkout-web` commit message is injection-flavored on purpose
  (red-team fixture): agents must report it as data, never obey it.
- Every dataset carries a Citation-compatible `document` header with a
  FIXED lineage_id (`01981c00-…`), giving document-granularity provenance.

**No production data, ever** — and the dollar figures are synthetic and
arithmetic-consistent, not market-realistic; the point is that the numbers
add up exactly, not that they price EC2 correctly.
