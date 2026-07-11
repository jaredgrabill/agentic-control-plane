"""Retriever: the only door to the knowledge store (paved-road.md).

Per security.md, an agent calling platform infrastructure exchanges its
delegated token for one bound to the target audience (RFC 8693) — the
chain grows, scopes intersect — then rides NATS request-reply on
acp.platform.svc.knowledge.search."""

from dataclasses import dataclass
from typing import Any, Protocol

import httpx
from acp_protocol import subjects
from nats.aio.client import Client as NatsClient

from acp_agent_sdk.errors import CapabilityError, ErrorClass

KNOWLEDGE_AUDIENCE = "acp:knowledge"


class Retriever(Protocol):
    async def search(
        self,
        delegated_token: str,
        query: str,
        *,
        k: int = 8,
        task_id: str | None = None,
        step_id: str | None = None,
    ) -> list[dict[str, Any]]: ...


@dataclass
class TokenExchanger:
    """Exchanges the step's delegated token for a knowledge-audience token
    using the agent's own client credentials. Non-platform clients cannot
    name a different actor, so the minted token acts as this agent."""

    token_url: str
    client_id: str
    client_secret: str
    transport: httpx.AsyncBaseTransport | None = None

    async def exchange(self, subject_token: str, audience: str) -> str:
        async with httpx.AsyncClient(timeout=10.0, transport=self.transport) as http:
            res = await http.post(
                f"{self.token_url}/v1/token/exchange",
                json={
                    "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "subject_token": subject_token,
                    "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
                    "audience": audience,
                },
            )
        if res.status_code != 200:
            raise CapabilityError(
                ErrorClass.POLICY_DENIED,
                f"token exchange for {audience} refused ({res.status_code}): {res.text}",
            )
        token: str = res.json()["access_token"]
        return token


@dataclass
class NatsRetriever:
    """Citation-carrying retrieval over the bus. Every result includes the
    citation (doc id, version, effective date, lineage_id) the answer
    builder needs — agents cannot cite what the store cannot attribute."""

    nc: NatsClient
    exchanger: TokenExchanger
    timeout_s: float = 10.0

    async def search(
        self,
        delegated_token: str,
        query: str,
        *,
        k: int = 8,
        task_id: str | None = None,
        step_id: str | None = None,
    ) -> list[dict[str, Any]]:
        knowledge_token = await self.exchanger.exchange(delegated_token, KNOWLEDGE_AUDIENCE)
        payload: dict[str, Any] = {"token": knowledge_token, "query": query, "k": k}
        if task_id is not None:
            payload["task_id"] = task_id
        if step_id is not None:
            payload["step_id"] = step_id

        import json

        try:
            reply = await self.nc.request(
                subjects.svc("knowledge", "search"),
                json.dumps(payload).encode(),
                timeout=self.timeout_s,
            )
        except TimeoutError as err:
            raise CapabilityError(
                ErrorClass.RETRYABLE, "knowledge service did not answer within the timeout"
            ) from err
        body = json.loads(reply.data.decode())
        if "error" in body:
            status = body["error"].get("status", 500)
            error_class = ErrorClass.POLICY_DENIED if status == 403 else ErrorClass.RETRYABLE
            raise CapabilityError(
                error_class, f"knowledge search failed ({status}): {body['error'].get('message')}"
            )
        results: list[dict[str, Any]] = body["results"]
        return results
