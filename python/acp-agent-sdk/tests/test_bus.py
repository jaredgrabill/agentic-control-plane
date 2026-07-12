"""BusTokenSource against httpx.MockTransport: the acp:bus mint it emits,
its non-2xx handling, the boot-race retry, and the on_refresh callback."""

import asyncio
import json

import httpx
import pytest
from acp_agent_sdk.bus import BUS_AUDIENCE, BusTokenSource


def _source(transport: httpx.MockTransport, **kw: object) -> BusTokenSource:
    return BusTokenSource(
        token_url="http://token.test",
        client_id="agent-knowledge-agent",
        client_secret="sekret",
        transport=transport,
        **kw,  # type: ignore[arg-type]
    )


class TestMint:
    async def test_mints_acp_bus_with_client_credentials(self) -> None:
        seen: list[dict[str, object]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(json.loads(request.content))
            return httpx.Response(200, json={"access_token": "bus-tok", "expires_in": 600})

        token, expires_in = await _source(httpx.MockTransport(handler)).mint()
        assert token == "bus-tok"
        assert expires_in == 600
        assert seen[0] == {
            "grant_type": "client_credentials",
            "client_id": "agent-knowledge-agent",
            "client_secret": "sekret",
            "audience": BUS_AUDIENCE,
        }

    async def test_non_2xx_raises(self) -> None:
        def refuse(request: httpx.Request) -> httpx.Response:
            return httpx.Response(403, json={"error": "suspended"})

        with pytest.raises(RuntimeError, match="403"):
            await _source(httpx.MockTransport(refuse)).mint()


class TestStart:
    async def test_token_requires_start(self) -> None:
        def ok(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"access_token": "t1", "expires_in": 600})

        source = _source(httpx.MockTransport(ok))
        with pytest.raises(RuntimeError, match="not yet minted"):
            source.token()
        await source.start()
        assert source.token() == "t1"
        # on_refresh fires on the initial mint too.
        await source.stop()

    async def test_retries_the_boot_race_then_succeeds(self) -> None:
        calls = {"n": 0}

        def flaky(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                raise httpx.ConnectError("boot race")
            return httpx.Response(200, json={"access_token": "t-ok", "expires_in": 600})

        source = _source(httpx.MockTransport(flaky), max_backoff_s=0.01)
        await source.start()
        assert source.token() == "t-ok"
        assert calls["n"] == 2
        await source.stop()

    async def test_on_refresh_callback_receives_each_token(self) -> None:
        def ok(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"access_token": "t1", "expires_in": 600})

        received: list[str] = []
        source = _source(httpx.MockTransport(ok))
        source.on_refresh = received.append
        await source.start()
        assert received == ["t1"]
        await source.stop()

    async def test_stop_is_idempotent_and_cancels_the_loop(self) -> None:
        def ok(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"access_token": "t1", "expires_in": 600})

        source = _source(httpx.MockTransport(ok))
        await source.start()
        await source.stop()
        # A second stop must not raise even with no live task.
        await source.stop()
        # The refresh task is done.
        assert source._task is None or source._task.done()
        await asyncio.sleep(0)
