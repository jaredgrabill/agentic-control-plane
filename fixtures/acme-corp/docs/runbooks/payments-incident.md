# Payments Service Incident Runbook

**Document ID:** runbook/payments-incident · **Version:** 1.9.0 ·
**Effective:** 2026-06-11 · **Owner:** team-sre · **Classification:** internal

## Triggers

- `payments-api` availability SLO burn rate > 14.4 over 1h
- Payment authorization error rate > 2% for 5 minutes
- Settlement batch job missed its 02:00 UTC window

## Immediate Actions

1. Declare an incident in #inc-payments; page the payments on-call via the
   escalation policy `payments-p1`.
2. Check the change calendar for deploys to `payments-api`,
   `payments-settlement`, or the payments database in the last 24h — if one
   correlates, roll it back first (`helm rollback`, see Helm Deployment
   Standard §2.5) and verify SLO recovery before deeper diagnosis.
3. Check upstream: card-network sandbox status page and the egress gateway
   error dashboard.

## Diagnosis

- Dashboards: `payments-api` golden signals, database connection pool,
  settlement queue depth.
- Logs: `service:payments-api level:error` in the log explorer, correlated
  by `trace_id`.

## Escalation

If not mitigated within 30 minutes, escalate to the engineering director
on-call. Customer-visible impact beyond 60 minutes requires the incident
commander to trigger the status-page update workflow.

## Post-Incident

File the post-incident review within five business days. Failed changes
feed the Change Management Policy §6 review.
