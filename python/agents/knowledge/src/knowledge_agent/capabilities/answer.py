"""knowledge.answer_with_citations: extract-and-cite synthesis.

Deterministic extractive grounding: the answer quotes the most relevant
sentences from retrieved chunks and cites each one. A configured model can
polish phrasing later (Phase 2 LLM gateway); the citation and abstention
behavior — the gated metrics — do not depend on it.
"""

import os
import re
from typing import Any

from acp_agent_sdk import Agent, CapabilityContext, CapabilityError, ErrorClass

STOPWORDS = frozenset(
    "a about all also an and any are as at be but by do does for from has have how in is it "
    "of on or our say says the their there this to what when where which who whom why will "
    "with your".split()
)

CONFIDENCE_FLOOR = 0.35


def register(agent: Agent) -> None:
    @agent.capability("knowledge.search")
    async def search(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
        results = await ctx.retrieve(input["query"], k=int(input.get("k", 8)))
        return {"results": results}

    @agent.capability("knowledge.answer_with_citations")
    async def answer(ctx: CapabilityContext, input: dict[str, Any]) -> dict[str, Any]:
        # Deployment-rehearsal failure directive (item 4): a v3 candidate worker
        # set with ACP_KNOWLEDGE_AGENT_FAILURE=permanent fails every answer, so a
        # canary gate breaches and the controller auto-rolls back. Runtime-only —
        # the golden suite (no env set) is unaffected, so the baseline still
        # regenerates cleanly.
        if os.environ.get("ACP_KNOWLEDGE_AGENT_FAILURE") == "permanent":
            raise CapabilityError(
                ErrorClass.PERMANENT,
                "knowledge agent failure directive active (deployment rehearsal)",
            )
        question = input["question"]
        results = await ctx.retrieve(question, k=6)
        builder = agent.answer_builder()

        terms = query_terms(question)
        # Sentence-level term overlap plus the retriever's own (normalized)
        # ranking: a middling sentence in the most relevant document beats a
        # perfect-overlap sentence in a document that merely references it.
        max_score = max((r.get("score", 0.0) for r in results), default=1.0) or 1.0
        scored = []
        for r in results:
            for sentence in sentences(r["content"]):
                overlap = sentence_score(sentence, terms)
                if overlap > 0:
                    combined = overlap + r.get("score", 0.0) / max_score
                    scored.append((combined, overlap, sentence, r))
        scored.sort(key=lambda s: s[0], reverse=True)
        relevant = scored[:3]

        if not relevant:
            return builder.abstain(
                "I don't have sufficient grounding in the corpus to answer this reliably. "
                "The retrieved documents don't address the question."
            )

        for _combined, _overlap, sentence, result in relevant:
            marker = builder.cite(result["citation"])
            builder.paragraph(f"{sentence} [{marker}]")

        # Confidence reflects grounding quality only (sentence-term overlap
        # and term coverage) — retrieval rank must not launder a weakly
        # grounded sentence into a confident answer. build() abstains below
        # the floor.
        confidence = answer_confidence(relevant, terms, results)
        return builder.build(confidence)


def query_terms(question: str) -> set[str]:
    return {
        t.rstrip("s")
        for t in re.split(r"[^a-z0-9-]+", question.lower())
        if len(t) > 2 and t not in STOPWORDS
    }


def sentences(content: str) -> list[str]:
    # Strip markdown structure; keep prose sentences whole.
    text = re.sub(r"^#{1,4}\s.*$", "", content, flags=re.MULTILINE)
    text = re.sub(r"\s+", " ", text)
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if len(s.strip()) > 30]


def sentence_score(sentence: str, terms: set[str]) -> float:
    if not terms:
        return 0.0
    words = {w.rstrip("s") for w in re.split(r"[^a-z0-9-]+", sentence.lower())}
    overlap = len(terms & words)
    # Require more than incidental overlap: a sentence sharing one term
    # with the question is not grounding, it's coincidence.
    if overlap < min(2, len(terms)):
        return 0.0
    return overlap / len(terms)


def answer_confidence(
    relevant: list[tuple[float, float, str, dict[str, Any]]],
    terms: set[str],
    results: list[dict[str, Any]],
) -> float:
    best = max(overlap for _, overlap, _, _ in relevant)
    # Coverage counts only terms the retrieved corpus contains at all:
    # vocabulary the corpus has never seen (typos, injected instructions)
    # measures the corpus, not the answer's grounding.
    corpus_words = {
        w.rstrip("s") for r in results for w in re.split(r"[^a-z0-9-]+", r["content"].lower())
    }
    groundable = terms & corpus_words
    if not groundable:
        return 0.0
    covered = {
        t
        for _, _, sentence, _ in relevant
        for t in groundable
        if t in {w.rstrip("s") for w in re.split(r"[^a-z0-9-]+", sentence.lower())}
    }
    coverage = len(covered) / len(groundable)
    return round(min(0.98, 0.5 * best + 0.5 * coverage), 4)
