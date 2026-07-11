import asyncio
from pathlib import Path

from acp_agent_sdk import Agent

from knowledge_agent.capabilities.answer import register

agent = Agent.from_manifest(Path(__file__).resolve().parents[2] / "manifest.yaml")
register(agent)

if __name__ == "__main__":
    asyncio.run(agent.run())
