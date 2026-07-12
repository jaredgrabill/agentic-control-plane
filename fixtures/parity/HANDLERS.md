# Parity handlers — normative spec

Both language implementations (`tests/parity/src/handlers.ts` and
`python/parity/handlers.py`) MUST implement exactly this behavior. The parity
job runs each SDK's EvalHarness over `golden/cases.json` and diffs the
normalized reports; any behavioral drift — verdicts, failure strings, cited
docs, metrics — fails CI.

## `parity.answer(ctx, input)`

1. `q = str(input.question or "")`. If `q == ""` → raise/reject
   `CapabilityError(NEEDS_INPUT, "question is required")`.
2. `low = q.lowercase()`. If `low` contains `"unanswerable"` → return
   `builder.abstain("I don't have sufficient grounding in the corpus to answer this reliably.", 0.1)`.
3. Canned doc table, in this order:

   | key       | doc_id                    | version | lineage_id                             |
   | --------- | ------------------------- | ------- | -------------------------------------- |
   | freeze    | policy/change-management  | 3.2.0   | `11111111-1111-7111-8111-111111111111` |
   | oncall    | runbook/oncall-escalation | 3.0.0   | `22222222-2222-7222-8222-222222222222` |
   | retention | policy/data-retention     | 1.4.0   | `33333333-3333-7333-8333-333333333333` |

4. `matched` = rows whose `key` is a substring of `low`, in table order. If
   empty → return `builder.abstain(<same reason as step 2>, 0.2)`.
5. For each match:
   `marker = builder.cite({doc_id, version, lineage_id})` then
   `builder.paragraph("Grounded claim about " + key + ". [" + marker + "]")`.
6. `confidence = min(0.97, 0.6 + 0.15 * len(matched))`; return
   `builder.build(confidence)`. No model calls.

Confidence values are chosen to avoid 4-decimal rounding ties: Python rounds
half-to-even, TypeScript half-away-from-zero, and the parity gate must never
hinge on that difference.

## `parity.bad_output(ctx, input)`

Always return `{"wrong": true}` — the output violates the declared
`output_schema` both times, exercising repair-retry-then-permanent-failure in
both SDKs. The resulting failure string differs only in the validator tail
(Ajv vs jsonschema phrasing), which the comparator normalizes by the shared
`step failed: handler output does not conform to the declared output_schema`
prefix.

## String-formatting constraints

Failure strings must be byte-identical across SDKs, and one formatting gap
cannot be bridged from JavaScript: `JSON.parse` erases JSON's int/float
distinction, so a whole-number confidence renders `1` in TypeScript
(`String(1)`) but `1.0` in Python (`str(1.0)`). Therefore:

- Golden `min_confidence` values and handler-produced confidences MUST NOT be
  whole numbers (use e.g. `0.9`, never `1` or `1.0`).
- A completed output that omits `confidence` renders `undefined` in TypeScript
  vs `None` in Python inside the `confidence … below floor …` failure —
  missing-confidence cases are NOT parity-safe; handlers must always emit a
  confidence when a golden case sets `min_confidence`.

Needle quoting IS bridged: the TypeScript harness replicates Python's `{s!r}`
rule (single quotes, switching to double quotes when the needle contains an
apostrophe and no double quote), so apostrophes in `must_contain` needles are
fine.

## Report shape (`acp-parity-report/v1`)

```json
{
  "schema": "acp-parity-report/v1",
  "sdk": "typescript | python",
  "agent_id": "parity-agent",
  "metrics": { "pass_rate": 0.0, "citation_precision": 0.0, "abstention_accuracy": 0.0 },
  "cases": [{ "name": "...", "passed": true, "abstained": false, "cited_docs": [], "failures": [] }]
}
```

Cases appear in golden-file order with snake_case keys. Neither runner sets a
delegated token. Expected metrics for the current suite: pass_rate 4/9,
citation_precision 4/9, abstention_accuracy 8/9 (pinned by the TypeScript
harness's unit tests; CI only requires the two reports to agree).
