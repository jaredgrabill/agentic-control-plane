"""CapabilityContext: everything a handler may touch. Handlers are
stateless between invocations — all state arrives here or lives in
platform stores (agent-patterns.md)."""

from dataclasses import dataclass
from typing import Any

import structlog

from acp_agent_sdk.model import ModelClient
from acp_agent_sdk.retriever import Retriever


@dataclass
class CapabilityContext:
    tenant: str
    task_id: str
    step_id: str
    capability: str
    delegated_token: str | None
    budget: dict[str, Any] | None
    model: ModelClient
    _retriever: Retriever | None
    log: structlog.stdlib.BoundLogger

    async def retrieve(self, query: str, *, k: int = 8) -> list[dict[str, Any]]:
        """Citation-carrying retrieval under the step's delegated identity."""
        if self._retriever is None:
            raise RuntimeError(
                "no retriever configured — pass one to Agent(...) or use the eval harness's"
                " fixture retriever in tests"
            )
        if self.delegated_token is None:
            raise RuntimeError(
                "step carries no delegated token — retrieval requires the delegated identity"
            )
        return await self._retriever.search(
            self.delegated_token, query, k=k, task_id=self.task_id, step_id=self.step_id
        )
