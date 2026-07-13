# Runbook — Deploying with Helm

**Owner:** `<platform-sre>`
**Scope:** installing and upgrading the control plane on Kubernetes with the
umbrella chart at `deploy/helm/acp`. The chart is scoped 1.0 ("runs on a
cluster") — nine HTTP control-plane services plus the orchestrator (Temporal)
worker. Full HA operators are post-1.0.

The compose stack (`make dev`) remains the canonical local/eval substrate. This
chart is for cluster deploys and is validated in CI by a `helm lint` +
`helm template | kubeconform` gate (no live cluster).

## What the chart ships

| Object | Count | Notes |
|---|---|---|
| Deployment + Service | 9 | token, registry, policy, audit, knowledge, tool-gateway, llm-gateway, gateway, evaluation — each `/healthz` readiness + liveness on its port |
| Deployment (no Service) | 1 | orchestrator — Temporal worker, no HTTP door |
| ConfigMap | 1 | non-secret seed docs mounted at `/etc/acp` |
| Secret | 0 (prod) / 3 (dev) | credentials, token-clients, datastore — see below |

One monorepo image serves every service; the per-service `args` select the
entrypoint (mirrors `scripts/run-platform.mjs`).

## Prerequisites (human-provisioned)

1. **Kubernetes** 1.27+ and Helm 3.13+.
2. **The monorepo container image** — build and push it before installing. No
   CI job builds or publishes it yet, and the chart defaults to
   `ghcr.io/jaredgrabill/agentic-control-plane:<appVersion>`; without the image
   present every pod `ImagePullBackOff`s. All ten services share ONE image (the
   per-service `args` select the entrypoint, mirroring
   `scripts/run-platform.mjs`), so a single build/push suffices. Override
   `global.image.registry` / `global.image.repository` / `global.image.tag` to
   point at your own registry. **Fast-follow:** a committed multi-service
   Dockerfile + a publish workflow are out of scope for 1.0 and tracked
   separately; until then this is a manual step.
3. **Data stores** — the chart is BYO by default (`postgresql.enabled`,
   `nats.enabled`, `temporal.enabled` all `false`):
   - **Postgres** with `pgvector` (shared by all services; also Temporal's
     backing store if you self-host Temporal).
   - **NATS** with **JetStream enabled** and the **per-tenant accounts + auth
     callout** configured (the platform's tenant isolation lives in the NATS
     account boundary — mirror `deploy/compose/nats/`). A vanilla NATS install
     is not sufficient.
   - **Temporal** frontend reachable at `config.temporalAddress`.
4. **A secret store** (Vault, cloud secret manager) fronted by ExternalSecrets
   or pre-provisioned `Secret`s. Production sets `devSecrets.create=false`
   (default) and supplies the Secrets below out of band.

### Enabling in-cluster data stores (optional)

Subcharts are intentionally **not** active dependencies in `Chart.yaml` so the
offline CI `helm template` gate renders without fetching archives. To run
batteries-included, uncomment the `dependencies:` block in `Chart.yaml`, then:

```
helm dependency update deploy/helm/acp
helm install acp deploy/helm/acp \
  --set postgresql.enabled=true --set nats.enabled=true --set temporal.enabled=true
```

You still must configure NATS JetStream + accounts on the subchart values.

## Secrets (the credential-broker posture)

No secret values live in the chart. Every credential is pulled via
`secretKeyRef`. Production provides three Secrets (names default to
`<release>-…`, overridable):

| Secret | Keys | Holds |
|---|---|---|
| `<release>-credentials` | `nats-auth-issuer-seed`, `nats-auth-xkey-seed`, `<svc>-client-secret`, `<svc>-nats-password`, `orchestrator-client-secret`, `prober-client-secret` | per-service client secrets + NATS auth seeds |
| `<release>-token-clients` | `token-clients.json` | the token-service client table |
| `<release>-datastore` | `database-url` | the Postgres DSN (carries the password) |

Each service still fetches its own client-credentials token at boot (no shared
static bearer), matching the broker design — the chart only wires the boot
credential.

## Install

Production (Secrets pre-provisioned, external stores):

```
helm install acp deploy/helm/acp \
  --namespace acp --create-namespace \
  --set config.natsUrl=nats://nats.acp.svc.cluster.local:4222 \
  --set config.temporalAddress=temporal-frontend.temporal.svc.cluster.local:7233 \
  --set config.database.secretName=acp-datastore \
  --set-file runtimeConfig.toolServers=deploy/dev/tool-servers.json \
  --set-file runtimeConfig.modelClasses=deploy/dev/model-classes.json
```

Dev cluster (self-contained, dev Secrets created in-cluster — never production):

```
helm install acp deploy/helm/acp -f deploy/helm/acp/values-dev.yaml \
  --namespace acp --create-namespace \
  --set devSecrets.create=true \
  --set-file devSecrets.tokenClients=deploy/dev/token-clients.json
```

### Values you MUST override for production

- `config.tokenIssuer`, `config.natsUrl`, `config.temporalAddress`
- `config.otel.endpoint`
- `config.busTenantAccounts` — the tenant → NATS account NAME map; **must match
  the NATS server accounts block** or callout minting and the account boundary
  drift apart.
- `global.image.registry` / `repository` / `tag`
- The three Secrets above (or their `secretName` overrides).
- `runtimeConfig.*` — your real seed documents (tenants, tool servers, model
  classes, budgets, a2a exposure).

## Verify

```
kubectl -n acp get pods -l app.kubernetes.io/instance=acp
kubectl -n acp port-forward svc/acp-gateway 7100
curl -s localhost:7100/healthz
```

Every HTTP pod must go `Ready` (its `/healthz` probe passing). The orchestrator
pod has no probe — confirm it is `Running` and polling in the Temporal UI.

## Upgrade

Rolling upgrades on a **shared Postgres** are data-sensitive. Do **not**
`helm upgrade` blind. Follow
[the rolling-upgrade runbook](upgrade-rolling.md): expand-then-contract
migrations, the shared advisory-lock DDL, protocol-parity deploy order, and the
append-only audit enum rule. In short:

1. Deploy the schema/protocol-compatible image to **one** service first; confirm
   the parity gate is green for the release.
2. `helm upgrade` rolls each Deployment one pod at a time behind `/healthz`
   (`maxUnavailable` low). The orchestrator drains via Temporal task-queue
   versioning, not a hard restart.
3. Roll forward service-by-service; never remove a column/enum value within a
   minor.

## Rollback

```
helm rollback acp <previous-revision> -n acp
```

Application rollback is safe only if the migrations were expand-then-contract
(additive). If a contract-phase migration already ran, restore per
[the Postgres DR runbook](dr-postgres-backup-restore.md) and re-run the audit
chain-verify acceptance check before reopening ingress.

## Ingress

The `gateway` Service is the public door but stays `ClusterIP`. Wire an
Ingress / Gateway API route to `acp-gateway:7100` out of band; keep the other
eight services cluster-internal.

## Observability

Point `config.otel.endpoint` at your collector. SLO dashboards and Prometheus
rules ship under `deploy/observability/` — see
[the SLO targets](../standards/slo-targets.md).
