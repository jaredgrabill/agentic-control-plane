# Multi-tenancy

Phase 4 item 1 makes tenancy operational: any number of tenants, each with its
own NATS account, budget cap, and kill-switch tier — with `acme` and `globex`
provisioned in dev/CI as the living proof.

## Isolation model (what a tenant can never do)

The platform stacks four independent boundaries; a tenant identity crossing
any one of them is refused structurally, not by convention:

1. **Bus accounts.** Every tenant gets its own NATS account. The account
   exports EXACTLY `acp.<tenant>.>` and imports only three read-side platform
   surfaces (`acp.platform.svc.>`, `.registry.>`, `.control.>`); PLATFORM
   imports each tenant's traffic per-tenant exact. Tenant agents have no
   static users — the auth callout mints a session identity from a verified
   platform JWT (`aud acp:bus`), places it in `tenantAccounts[claims.tenant]`,
   and confines it to the `acp.${tenant}.…` permission template
   (`apps/token/src/bus-auth/core.ts`).
2. **Claims-bound routes.** Write paths stamp `tenant = claims.tenant`
   (gateway intake); read paths either scope lookups by the caller's tenant
   (task/approval ids read as absent cross-tenant) or take a REQUIRED tenant
   parameter bound by `assertTenantAccess` — platform-family roles may name
   any tenant, everyone else only their own.
3. **Cedar policies.** Delegation and tool permits compare
   `principal.tenant == resource.tenant` / `context.tenant`.
4. **Workflow ids.** Temporal task workflows are `task-{tenant}-{taskId}`, so
   a foreign task id is structurally `not_found`.

## Onboarding a tenant (dev/CI)

The registry `deploy/dev/tenants.json` is the single source of truth; the
NATS accounts block and `ACP_BUS_TENANT_ACCOUNTS` are both derived from it.

```
node scripts/onboard-tenant.mjs initech            # registry + regenerated conf
docker compose -f deploy/compose/docker-compose.yml -p acp-dev up -d   # account exists
# add the tenant's clients to deploy/dev/token-clients.json (tenant: initech)
# set the cap in deploy/dev/tenant-budgets.json (absent = uncapped)
# restart the platform (run-platform.mjs re-derives the account map)
```

`scripts/gen-nats-accounts.mjs` VALIDATES before it writes and fails on any
widening: a non-`[a-z0-9-]+` tenant id, a wildcarded or platform-subject
export, a shared/duplicated account, or a tenant claiming `SYS`/`PLATFORM`.
The generated `deploy/compose/nats/nats-accounts.gen.conf` is committed so CI
gets every tenant without a generation step. There is deliberately NO
self-serve onboarding route — tenancy is platform configuration.

## Per-tenant budgets

Postgres is authoritative; there is no read-then-write window anywhere:

- **Reserve (gateway intake).** One atomic conditional UPDATE:
  `reserved += est WHERE committed + reserved + est <= cap` under the
  `(tenant, period)` row lock (`apps/gateway/src/budget.ts`). Over budget →
  HTTP 402 + a `task.rejected{budget_exhausted}` audit. The tenant is the
  VERIFIED `claims.tenant`; caps live in `deploy/dev/tenant-budgets.json`
  (platform config, applied by the evaluation service at boot for the current
  UTC calendar month). No cap row = uncapped = admission skipped.
- **Commit (evaluation service).** The durable `acp-budget-ledger` JetStream
  consumer over `acp.*.audit.task.completed` books the ACTUAL cost exactly
  once per `task_id` (charge-marker PK dedups redelivery), keyed by the
  SUBJECT's tenant and cross-checked against the reservation's tenant.
- **Release.** A failed workflow start compensates immediately; the interval
  reaper (`ACP_TASK_RESERVATION_MAX_AGE_SECONDS`, default 86400) frees
  reservations whose task never completed.
- **Showback.** `node scripts/showback.mjs <tenant> [--json]` rolls up the
  audit-derived spend and reports the live budget row (cap / committed /
  reserved) via `GET /v1/tenants/:tenant/budget` (eval:read, tenant-bound).

Quality is budget-adjacent and equally tenant-keyed: `quality_state` is
PK `(tenant, agent_id)` and every SLI/budget/drift query filters by tenant,
so one tenant's degradation never freezes an agent for another. The
deployment freeze/gate reads quality for the DEPLOYMENT's tenant.

## Per-tenant kill switch

`killswitch.tenant.{tenant}` is a fleet halt scoped to one tenant — monotonic
and compensator-exempt exactly like the fleet tier. Enforcement points match
the key against VERIFIED tenants only: the bus callout (`claims.tenant`,
refuses new sessions), gateway intake (`claims.tenant`, 503 +
`task.rejected{tenant_halt}`), and the auto-canceller (tenant parsed from the
gateway's own workflow-id scheme; cancels covered TaskWorkflows with trigger
`tenant_killswitch`). Platform-admin CLI only:

```
node scripts/kill-switch.mjs tenant halt globex --reason "tenant incident"
node scripts/kill-switch.mjs tenant resume globex --reason "incident closed"
```

## GA account path (documented, not built)

Dev/CI use static server config (an account IS configuration in server-config
mode; one issuer nkey signs every minted session user). A deployment where
tenants are onboarded without a server restart — or where per-tenant signing
keys must be vaulted separately — moves to NATS decentralized auth: an
operator + per-account JWTs managed with `nsc`, pushed to the built-in
account resolver. The callout contract is unchanged (it already binds by
account NAME); what changes is that accounts become signed JWTs instead of
config blocks, and each tenant account gets its own signing key. That is the
1.0 hardening item, tracked in the roadmap — the isolation INVARIANTS proved
by `tests/e2e/src/multitenancy.test.ts` are identical in both modes.

## Residual risks (threat-model backlog)

- Audit events are not producer-signed: an agent can fabricate a
  `task.completed` for its OWN tenant (cost 0) to free its own reservation
  early — bounded by that tenant's own cap; cross-tenant forgery is blocked
  by the subject/reservation tenant cross-check.
- The budget estimate defaults to `ACP_BUDGET_DEFAULT_EST_USD` when a task
  sets no `max_cost_usd`; admission is a hard bound only when tasks declare
  their cost cap (the orchestrator ledger then enforces actual ≤ estimate).
