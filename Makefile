# Developer entry points. `make dev` brings up the full local substrate.
COMPOSE_FILE := deploy/compose/docker-compose.yml
COMPOSE := docker compose -f $(COMPOSE_FILE)

.PHONY: dev dev-down dev-logs dev-clean lint test build gen

dev:
	$(COMPOSE) up -d
	bash deploy/compose/wait-for-stack.sh

dev-down:
	$(COMPOSE) down

dev-logs:
	$(COMPOSE) logs -f --tail 100

# Also removes volumes: fresh corpus, fresh streams, fresh Temporal history.
dev-clean:
	$(COMPOSE) down -v

lint:
	pnpm lint && pnpm format:check
	cd python && uv run ruff check . && uv run ruff format --check . && uv run mypy

test:
	pnpm test
	cd python && uv run pytest --cov --cov-fail-under=85

build:
	pnpm build

gen:
	pnpm gen
