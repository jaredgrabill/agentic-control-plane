---
rfc: 0000
title: <short descriptive title>
status: draft # draft | accepted | rejected | superseded
author: <name / handle>
created: <YYYY-MM-DD>
tracking-issue: <link>
---

# RFC 0000: <title>

## Summary

One paragraph. What is being proposed, in plain terms.

## Motivation

Why now? What problem or opportunity forces this change? What is the concrete
harm or cost of the status quo? Link the issue(s) and any prior discussion.

## Guide-level explanation

Explain the proposal as you would to someone using the platform, not building
it: the new concept, the new API/CLI/behavior, worked examples. If it changes
the paved road for agent teams, show the before/after.

## Reference-level design

The precise mechanics: schema/subject changes, new components or services,
data flows, failure modes, migration and rollout. Be specific enough that an
implementer could build it and a reviewer could find the holes. Note any
[API-versioning](../standards/api-versioning.md) impact (additive vs breaking)
and the deploy/rollback story
([rolling upgrade](../runbooks/upgrade-rolling.md)).

## Trust-boundary & security impact (required)

Does this add, move, or weaken a trust boundary? Walk the relevant entries of
the [threat model](../architecture/threat-model.md) (ASI01–10) and the
[security self-assessment](../architecture/security-self-assessment.md):

- New external surface, credential path, or egress?
- Effect on tenant isolation, policy enforcement, the write-path dual controls,
  or the audit trail?
- New residual risks — name them so review is a decision, not a discovery.

If the answer is genuinely "none," say so and why.

## Drawbacks

Why might we *not* do this? Cost, complexity, lock-in, maintenance burden.

## Alternatives

What else was considered, and why is this shape preferred? Include "do nothing."

## Unresolved questions

What must be settled before/while implementing, and what is explicitly out of
scope for this RFC.

## Prior art

Comparable designs in other systems, relevant standards (MCP, A2A, OTel,
RFC 8693, OWASP ASI), and lessons borrowed or rejected.
