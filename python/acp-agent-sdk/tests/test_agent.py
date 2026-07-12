from typing import Any

import pytest
from acp_agent_sdk import (
    Agent,
    CapabilityContext,
    CapabilityError,
    ErrorClass,
    FakeModel,
    ModelResponse,
    agent_task_queue,
)
from temporalio.exceptions import ApplicationError

from .conftest import MANIFEST, step_request


class TestTaskQueue:
    def test_agent_task_queue_pins_cross_language_string(self) -> None:
        # MUST match the TypeScript SDK's agentTaskQueue and the orchestrator's
        # agentTaskQueue for the same (id, version).
        assert agent_task_queue("knowledge-agent", "0.2.0") == "agent-knowledge-agent@0.2.0"

    def test_task_queue_is_version_qualified_from_env(
        self, agent: Agent, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("ACP_AGENT_VERSION", "0.4.0")
        assert agent.task_queue == "agent-test-agent@0.4.0"

    def test_task_queue_requires_env(
        self, agent: Agent, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("ACP_AGENT_VERSION", raising=False)
        with pytest.raises(RuntimeError, match="ACP_AGENT_VERSION is required"):
            _ = agent.task_queue


def good_output(text: str = "hello [1]") -> dict[str, Any]:
    return {"text": text, "citations": [], "confidence": 0.9}


class TestRegistration:
    def test_rejects_undeclared_capability(self, agent: Agent) -> None:
        with pytest.raises(ValueError, match="not declared in the manifest"):

            @agent.capability("test.undeclared")
            async def handler(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
                return good_output()

    def test_rejects_duplicate_handlers(self, agent: Agent) -> None:
        @agent.capability("test.echo")
        async def handler(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
            return good_output()

        with pytest.raises(ValueError, match="already has a handler"):
            agent.capability("test.echo")(handler)

    def test_assert_complete_names_missing_handlers(self, agent: Agent) -> None:
        with pytest.raises(RuntimeError, match="test.echo"):
            agent.assert_complete()

    def test_manifest_validation_fails_loudly(self) -> None:
        from acp_protocol import ProtocolValidationError

        bad = dict(MANIFEST)
        del bad["owner"]
        import tempfile
        from pathlib import Path

        import yaml

        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "manifest.yaml"
            path.write_text(yaml.safe_dump(bad), encoding="utf-8")
            with pytest.raises(ProtocolValidationError):
                Agent.from_manifest(path)


class TestExecute:
    async def test_happy_path_returns_completed_step_result(self, agent: Agent) -> None:
        @agent.capability("test.echo")
        async def handler(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
            assert ctx.tenant == "acme"
            assert ctx.capability == "test.echo"
            return good_output(f"echo: {input['text']}")

        result = await agent.execute(step_request())
        assert result["status"] == "completed"
        assert result["output"]["text"] == "echo: hello"
        assert result["kind"] == "step_result"
        assert result["usage"] == {"llm_calls": 0, "input_tokens": 0, "output_tokens": 0}

    async def test_malformed_step_request_is_non_retryable(self, agent: Agent) -> None:
        with pytest.raises(ApplicationError) as err:
            await agent.execute({"kind": "step_request"})
        assert err.value.non_retryable

    async def test_missing_handler_fails_typed(self, agent: Agent) -> None:
        result = await agent.execute(step_request())
        assert result["status"] == "failed"
        assert result["error"]["class"] == "permanent"
        assert "no handler" in result["error"]["message"]

    async def test_output_schema_repair_retry_then_success(self, agent: Agent) -> None:
        calls = {"n": 0}

        @agent.capability("test.echo")
        async def handler(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
            calls["n"] += 1
            if calls["n"] == 1:
                return {"wrong": "shape"}
            return good_output()

        result = await agent.execute(step_request())
        assert result["status"] == "completed"
        assert calls["n"] == 2

    async def test_output_schema_failure_after_repair_is_typed_permanent(
        self, agent: Agent
    ) -> None:
        @agent.capability("test.echo")
        async def handler(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
            return {"wrong": "shape"}

        result = await agent.execute(step_request())
        assert result["status"] == "failed"
        assert result["error"]["class"] == "permanent"
        assert "output_schema" in result["error"]["message"]

    async def test_needs_input_is_a_definitive_step_outcome(self, agent: Agent) -> None:
        @agent.capability("test.echo")
        async def handler(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
            raise CapabilityError(ErrorClass.NEEDS_INPUT, "which policy do you mean?")

        result = await agent.execute(step_request())
        assert result["status"] == "failed"
        assert result["error"]["class"] == "needs_input"

    async def test_retryable_errors_surface_as_retryable_activity_failures(
        self, agent: Agent
    ) -> None:
        @agent.capability("test.echo")
        async def handler(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
            raise CapabilityError(ErrorClass.RETRYABLE, "provider 429")

        with pytest.raises(ApplicationError) as err:
            await agent.execute(step_request())
        assert not err.value.non_retryable

    async def test_usage_counts_model_calls(self) -> None:
        agent = Agent(manifest=MANIFEST, model=FakeModel(script=["one", "two"]))

        @agent.capability("test.echo")
        async def handler(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
            await ctx.model.complete("first")
            await ctx.model.complete("second")
            return good_output()

        result = await agent.execute(step_request())
        assert result["usage"]["llm_calls"] == 2
        assert result["usage"]["output_tokens"] > 0
        # FakeModel reports no concrete model and no cache tokens: usage omits
        # model/cache_* entirely, so the step is fallback-priced and zero-LLM
        # usage stays byte-identical to before the cache fields existed.
        assert "model" not in result["usage"]
        assert "cache_read_tokens" not in result["usage"]
        assert "cache_write_tokens" not in result["usage"]

    async def test_usage_carries_model_and_cache_tokens_when_reported(self) -> None:
        agent = Agent(
            manifest=MANIFEST,
            model=FakeModel(
                script=[
                    ModelResponse(
                        text="first",
                        input_tokens=100,
                        output_tokens=40,
                        cache_read_tokens=200,
                        model="x@1",
                    ),
                    ModelResponse(
                        text="second",
                        input_tokens=10,
                        output_tokens=5,
                        cache_write_tokens=512,
                        model="y@2",
                    ),
                ]
            ),
        )

        @agent.capability("test.echo")
        async def handler(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
            await ctx.model.complete("first")
            await ctx.model.complete("second")
            return good_output()

        result = await agent.execute(step_request())
        assert result["usage"] == {
            "llm_calls": 2,
            "input_tokens": 110,
            "output_tokens": 45,
            "cache_read_tokens": 200,
            "cache_write_tokens": 512,
            # Last non-None model wins (v0 last-write-wins approximation).
            "model": "y@2",
        }

    async def test_retrieval_requires_configuration_and_token(self, agent: Agent) -> None:
        captured: dict[str, Any] = {}

        @agent.capability("test.echo")
        async def handler(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
            try:
                await ctx.retrieve("q")
            except RuntimeError as err:
                captured["error"] = str(err)
            return good_output()

        await agent.execute(step_request())
        assert "no retriever configured" in captured["error"]
