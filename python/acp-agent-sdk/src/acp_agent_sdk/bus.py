"""BusTokenSource (item 0c): mints and refreshes the acp:bus token an agent
presents to the NATS auth callout.

The token is a client_credentials mint against the agent's own client
(scopes stay []), audience acp:bus, <=15min. A background asyncio task
re-mints at ~2/3 TTL and pushes the new token through an on_refresh callback
so the live NATS connection presents a fresh token on reconnect (the minted
bus identity dies with its token). The connection wiring is E2E-covered;
the mint + scheduling logic is unit-tested here."""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field

import httpx

BUS_AUDIENCE = "acp:bus"


@dataclass
class BusTokenSource:
    token_url: str
    client_id: str
    client_secret: str
    audience: str = BUS_AUDIENCE
    transport: httpx.AsyncBaseTransport | None = None
    refresh_ratio: float = 2 / 3
    max_backoff_s: float = 30.0
    # Called with the new token after every successful (re-)mint. The agent
    # runtime wires this to update the NATS connection's token option so a
    # reconnect presents the fresh credential.
    on_refresh: Callable[[str], None] | None = None
    _current: str = ""
    _task: asyncio.Task[None] | None = field(default=None, repr=False)
    _stopped: bool = False

    def token(self) -> str:
        if not self._current:
            raise RuntimeError("bus token not yet minted — call start() first")
        return self._current

    async def mint(self) -> tuple[str, int]:
        """One mint attempt; raises on network error or non-2xx."""
        async with httpx.AsyncClient(timeout=10.0, transport=self.transport) as http:
            res = await http.post(
                f"{self.token_url}/v1/token",
                json={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "audience": self.audience,
                },
            )
        if res.status_code != 200:
            raise RuntimeError(f"bus token mint refused ({res.status_code}): {res.text}")
        body = res.json()
        return body["access_token"], int(body["expires_in"])

    async def start(self) -> None:
        """Mints the first token (retrying the boot race) and starts refresh."""
        backoff = 0.5
        while True:
            try:
                first_expiry = await self._refresh_once()
                break
            except Exception:
                if self._stopped:
                    return
                await asyncio.sleep(min(backoff, self.max_backoff_s))
                backoff = min(backoff * 2, self.max_backoff_s)
        self._task = asyncio.create_task(self._refresh_loop(first_expiry))

    async def stop(self) -> None:
        self._stopped = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _refresh_once(self) -> int:
        token, expires_in = await self.mint()
        self._current = token
        if self.on_refresh is not None:
            self.on_refresh(token)
        return expires_in

    async def _refresh_loop(self, first_expiry: int) -> None:  # pragma: no cover — timing loop
        expires_in = first_expiry
        while not self._stopped:
            # stop() cancels this task, so a CancelledError from the sleep is
            # the exit path mid-wait; the loop condition catches a clean stop.
            await asyncio.sleep(max(1.0, expires_in * self.refresh_ratio))
            try:
                expires_in = await self._refresh_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                # Keep the last good token; retry shortly.
                expires_in = int(5.0 / self.refresh_ratio)
