# Load / soak harness (`tests/load`)

A standalone task-burst generator for the ACP gateway. It exercises the same
public ingress path as the E2E exit scenario — mint a JWT, `POST /v1/tasks`,
poll to a terminal state — and reports latency + success against the
[1.0 SLO targets](../../docs/standards/slo-targets.md).

> **This is a manual / nightly tool. It is deliberately NOT part of the build
> graph and NOT wired into the PR-gated CI path.** There is no `package.json`
> here on purpose, so turbo and `pnpm -r` never see it. It is a plain script you
> run with `node`.

## Prerequisites

The full platform must be running locally (or the harness pointed at a live
deployment):

```bash
make dev        # substrate: NATS, Temporal, Postgres, OTel, Jaeger
make platform   # control plane + agent workers (separate terminal)
```

To watch the SLOs while it runs, also bring up the observability overlay
(Prometheus + Grafana): see
[`deploy/compose/observability`](../../deploy/compose/observability/docker-compose.observability.yml).

## Running

```bash
# Load: hold ~5 rps for 60s, then assert p95 < 30s and success >= 99%.
node tests/load/task-burst.mjs load --rps 5 --duration 60

# Heavier burst with explicit SLO gates.
node tests/load/task-burst.mjs load --rps 10 --duration 120 --p95 30000 --success 0.99

# Soak: sustained low rate for an hour, gate on latency drift (leak/backlog).
node tests/load/task-burst.mjs soak --rps 1 --duration 3600 --drift 1.5
```

The process exits non-zero on an SLO breach (bad success rate, p95 over target,
or — in soak mode — p95 drift beyond `--drift`), so it can gate a nightly job.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--rps` | 5 | Target task submission rate (submissions/second) |
| `--duration` | 60 | Run length in seconds |
| `--p95` | 30000 | p95 task-latency SLO in ms (SLO 2a) |
| `--success` | 0.99 | Minimum task success ratio |
| `--timeout` | 60000 | Per-task poll timeout in ms |
| `--drift` | 1.5 | (soak) max allowed p95 growth first→last quartile |

### Auth / configuration (env)

By default the harness mints a dev JWT from the token service using the
`cli-jane` client (audience `acp:gateway`), matching `tests/e2e` support.

| Env var | Default | Purpose |
|---|---|---|
| `ACP_LOAD_TOKEN` | — | Pre-minted bearer token; skips minting |
| `ACP_LOAD_TOKEN_URL` | `http://localhost:7101` | Token service base URL |
| `ACP_LOAD_GATEWAY_URL` | `http://localhost:7100` | Gateway base URL |
| `ACP_LOAD_CLIENT_ID` | `cli-jane` | Client-credentials client id |
| `ACP_LOAD_CLIENT_SECRET` | `jane-dev-secret` | Client secret |
| `ACP_LOAD_AUDIENCE` | `acp:gateway` | Token audience |
| `ACP_LOAD_QUESTION` | change-freeze question | Task prompt text |

Against a real deployment, set the URLs and supply a real client (or
`ACP_LOAD_TOKEN`) — never the dev secret.

## Modes

- **load** — ramps to the target rate and holds it, measuring p50/p95/p99
  latency and success rate; asserts the p95 and success SLOs at the end.
- **soak** — holds a low sustained rate for a long duration and additionally
  checks for latency drift between the first and last quartile of the run, a
  proxy for a resource leak or a task queue that is not draining (see the
  queue-depth panel in the SLO dashboard).

## Notes for CI (deferred)

A nightly soak job (Linux runner, live stack) is the intended home for the
`soak` mode. It is intentionally left out of the PR gate — the local
16 GB-machine memory constraint and the PR-gated E2E suite already stress the
platform, and a soak run needs a fresh long-lived stack. The harness is
runnable individually today so a nightly workflow can call it directly.
