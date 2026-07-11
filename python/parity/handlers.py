"""Python implementation of fixtures/parity/HANDLERS.md — the normative
spec both language runtimes must follow. Change that file first."""

from typing import Any

from acp_agent_sdk import Agent, CapabilityContext, CapabilityError, ErrorClass

_DOCS: list[tuple[str, str, str, str]] = [
    ("freeze", "policy/change-management", "3.2.0", "11111111-1111-7111-8111-111111111111"),
    ("oncall", "runbook/oncall-escalation", "3.0.0", "22222222-2222-7222-8222-222222222222"),
    ("retention", "policy/data-retention", "1.4.0", "33333333-3333-7333-8333-333333333333"),
]

_ABSTAIN_REASON = "I don't have sufficient grounding in the corpus to answer this reliably."


def register_parity_handlers(agent: Agent) -> None:
    @agent.capability("parity.answer")
    async def answer(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
        question = str(input.get("question") or "")
        if question == "":
            raise CapabilityError(ErrorClass.NEEDS_INPUT, "question is required")
        low = question.lower()
        builder = agent.answer_builder()
        if "unanswerable" in low:
            return builder.abstain(_ABSTAIN_REASON, 0.1)
        matched = [doc for doc in _DOCS if doc[0] in low]
        if not matched:
            return builder.abstain(_ABSTAIN_REASON, 0.2)
        for key, doc_id, version, lineage_id in matched:
            marker = builder.cite({"doc_id": doc_id, "version": version, "lineage_id": lineage_id})
            builder.paragraph(f"Grounded claim about {key}. [{marker}]")
        confidence = min(0.97, 0.6 + 0.15 * len(matched))
        return builder.build(confidence)

    @agent.capability("parity.bad_output")
    async def bad_output(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
        return {"wrong": True}
