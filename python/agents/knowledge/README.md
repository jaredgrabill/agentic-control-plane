# Knowledge & Policy Agent

**Charter:** authoritative retrieval and interpretation of organizational
knowledge — policies, standards, runbooks — with citations carrying document
version and effective date ([domains.md](../../../docs/domains.md)).
**Owner:** team-platform. **Risk:** R0 only.

- `knowledge.search` — cited passages from the governed corpus.
- `knowledge.answer_with_citations` — extract-and-cite synthesis; abstains
  below the confidence floor rather than guessing. Synthesis is
  deterministic in v0; model-polished phrasing arrives with the Phase 2 LLM
  gateway without touching the gated metrics.

**Evals:** `uv run pytest agents/knowledge/tests` runs the golden set
(citation precision ≥ 0.9 and abstention accuracy 1.0 are gated) and the
red-team suite hermetically against the fixture corpus. The full-stack
path — real retrieval, policy checks, audit — is the E2E exit scenario
(`make e2e`).

**Runbook:** suspend with
`node scripts/kill-switch.mjs suspend knowledge-agent --reason "<why>"`
(tier 1; propagates in seconds; reinstate with the same script).
