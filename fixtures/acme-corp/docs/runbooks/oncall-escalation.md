# On-Call Escalation Runbook

**Document ID:** runbook/oncall-escalation · **Version:** 3.0.0 ·
**Effective:** 2026-01-05 · **Owner:** team-sre · **Classification:** internal

## Severity Levels

| Sev | Definition | First response | Escalation |
| --- | --- | --- | --- |
| 1 | Customer-facing outage or active security breach | 5 min | Director within 30 min, VP within 60 |
| 2 | Degradation with workaround | 15 min | Director if > 2h |
| 3 | No customer impact | Next business day | — |

## Security Incidents

Suspected security incidents are always at least Sev 2 and page the
Security Operations Center (`soc-p1`) in parallel with the service on-call
(Information Security Policy §6: report within one hour).

## Handoffs

On-call handoff happens at 09:00 local with a written summary of open
incidents, silenced alerts (with expiry), and in-flight changes. Silences
without expiry are prohibited.

## Paging Hygiene

Every page must be actionable. Pages that fire more than three times a week
without action are review items in the weekly operational review, and the
alert is fixed or deleted — a quarantine list with owners, not a culture of
acking.
