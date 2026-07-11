#!/usr/bin/env bash
# Gates on every dev-stack dependency actually answering, not just running.
# Used by `make dev` and by the E2E suite in CI.
set -euo pipefail

TIMEOUT="${ACP_DEV_WAIT_TIMEOUT:-180}"
COMPOSE_FILE="$(dirname "$0")/docker-compose.yml"

check_postgres() { docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U "${ACP_PG_USER:-acp}" -d acp; }
check_nats() { curl -fsS http://localhost:8222/healthz; }
check_otel() { curl -fsS http://localhost:13133/healthz; }
check_jaeger() { curl -fsS http://localhost:16686/; }
# Temporal's frontend is gRPC; a completed TCP handshake plus the UI's HTTP
# 200 together indicate the server accepted connections and found its store.
check_temporal() { (exec 3<>/dev/tcp/localhost/7233) 2>/dev/null; }
check_temporal_ui() { curl -fsS http://localhost:8233/; }

wait_for() {
  local name="$1" fn="$2" deadline=$((SECONDS + TIMEOUT))
  until "$fn" >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then
      echo "TIMEOUT waiting for ${name} after ${TIMEOUT}s" >&2
      echo "--- ${name} logs ---" >&2
      docker compose -f "$COMPOSE_FILE" logs --tail 40 "$name" >&2 || true
      exit 1
    fi
    sleep 2
  done
  echo "ready: ${name}"
}

wait_for postgres check_postgres
wait_for nats check_nats
wait_for otel-collector check_otel
wait_for jaeger check_jaeger
wait_for temporal check_temporal
wait_for temporal-ui check_temporal_ui

echo "dev stack is up: NATS :4222/:8222, Postgres :5432, Temporal :7233 (UI :8233), OTLP :4317/:4318, Jaeger UI :16686"
