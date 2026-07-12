import json
from typing import Any

import httpx
import pytest
from acp_agent_sdk import (
    AnswerBuilder,
    CapabilityError,
    ErrorClass,
    FakeModel,
    ModelResponse,
    NatsRetriever,
    TokenExchanger,
)


class TestFakeModel:
    async def test_scripts_strings_callables_and_exceptions(self) -> None:
        model = FakeModel(
            script=[
                "plain",
                lambda prompt: f"echo:{prompt}",
                ModelResponse(text="typed", input_tokens=5, output_tokens=7),
                CapabilityError(ErrorClass.RETRYABLE, "simulated 429"),
            ]
        )
        assert (await model.complete("a")).text == "plain"
        assert (await model.complete("b")).text == "echo:b"
        assert (await model.complete("c")).output_tokens == 7
        with pytest.raises(CapabilityError, match="429"):
            await model.complete("d")
        assert model.calls == ["a", "b", "c", "d"]

    async def test_exhaustion_is_a_loud_failure(self) -> None:
        model = FakeModel(script=["only one"])
        await model.complete("a")
        with pytest.raises(CapabilityError, match="script exhausted"):
            await model.complete("b")


class TestAnswerBuilder:
    def test_deduplicates_citations_by_lineage(self) -> None:
        builder = AnswerBuilder()
        first = builder.cite({"doc_id": "a", "lineage_id": "x"})
        second = builder.cite({"doc_id": "a", "lineage_id": "x"})
        third = builder.cite({"doc_id": "b", "lineage_id": "y"})
        assert (first, second, third) == (1, 1, 2)
        builder.paragraph("grounded claim [1][2]")
        answer = builder.build(confidence=0.9)
        assert len(answer["citations"]) == 2
        assert answer["confidence"] == 0.9

    def test_low_confidence_becomes_abstention(self) -> None:
        builder = AnswerBuilder()
        builder.paragraph("weak claim")
        answer = builder.build(confidence=0.1)
        assert answer["abstained"] is True
        assert answer["citations"] == []
        assert "sufficient grounding" in answer["text"]


class FakeMsg:
    def __init__(self, body: dict[str, Any]) -> None:
        self.data = json.dumps(body).encode()


class FakeNats:
    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response
        self.requests: list[tuple[str, dict[str, Any]]] = []

    async def request(self, subject: str, payload: bytes, timeout: float = 0) -> FakeMsg:
        self.requests.append((subject, json.loads(payload.decode())))
        return FakeMsg(self.response)


def exchanger(handler: Any) -> TokenExchanger:
    return TokenExchanger(
        token_url="http://token.test",
        client_id="agent-test",
        client_secret="s",
        transport=httpx.MockTransport(handler),
    )


class TestRetriever:
    async def test_exchanges_then_queries_the_bus(self) -> None:
        def token_ok(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            assert body["audience"] == "acp:knowledge"
            assert body["subject_token"] == "delegated.jwt"
            return httpx.Response(200, json={"access_token": "knowledge.jwt"})

        nc = FakeNats(
            {"results": [{"content": "text", "score": 0.03, "citation": {"doc_id": "d"}}]}
        )
        retriever = NatsRetriever(nc=nc, exchanger=exchanger(token_ok))  # type: ignore[arg-type]
        results = await retriever.search("delegated.jwt", "change freeze", k=4, task_id="t1")
        assert results[0]["citation"]["doc_id"] == "d"
        subject, payload = nc.requests[0]
        assert subject == "acp.platform.svc.knowledge.search"
        assert payload["token"] == "knowledge.jwt"
        assert payload["k"] == 4
        assert payload["task_id"] == "t1"

    async def test_exchange_refusal_is_policy_denied(self) -> None:
        def refuse(request: httpx.Request) -> httpx.Response:
            return httpx.Response(403, json={"error": "no"})

        retriever = NatsRetriever(nc=FakeNats({}), exchanger=exchanger(refuse))  # type: ignore[arg-type]
        with pytest.raises(CapabilityError) as err:
            await retriever.search("t", "q")
        assert err.value.error_class is ErrorClass.POLICY_DENIED

    async def test_search_errors_map_to_typed_classes(self) -> None:
        def token_ok(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"access_token": "k"})

        denied = NatsRetriever(
            nc=FakeNats({"error": {"status": 403, "message": "Cedar: deny"}}),  # type: ignore[arg-type]
            exchanger=exchanger(token_ok),
        )
        with pytest.raises(CapabilityError) as err:
            await denied.search("t", "q")
        assert err.value.error_class is ErrorClass.POLICY_DENIED

        flaky = NatsRetriever(
            nc=FakeNats({"error": {"status": 500, "message": "db down"}}),  # type: ignore[arg-type]
            exchanger=exchanger(token_ok),
        )
        with pytest.raises(CapabilityError) as err2:
            await flaky.search("t", "q")
        assert err2.value.error_class is ErrorClass.RETRYABLE
