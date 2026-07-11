"""AnswerBuilder: makes the compliant answer shape (text + citations +
confidence, abstention as a success mode) the path of least resistance."""

from dataclasses import dataclass, field
from typing import Any

# Answers below this confidence must abstain rather than guess
# (knowledge-and-rag.md); agents may only raise the floor.
DEFAULT_CONFIDENCE_FLOOR = 0.35


@dataclass
class AnswerBuilder:
    confidence_floor: float = DEFAULT_CONFIDENCE_FLOOR
    _paragraphs: list[str] = field(default_factory=list)
    _citations: list[dict[str, Any]] = field(default_factory=list)

    def cite(self, citation: dict[str, Any]) -> int:
        """Registers a citation and returns its 1-based marker number.

        The same lineage_id cites once — repeated grounding on one chunk
        should not inflate the citation list.
        """
        for i, existing in enumerate(self._citations):
            if existing.get("lineage_id") == citation.get("lineage_id"):
                return i + 1
        self._citations.append(citation)
        return len(self._citations)

    def paragraph(self, text: str) -> None:
        self._paragraphs.append(text.strip())

    def build(self, confidence: float) -> dict[str, Any]:
        if confidence < self.confidence_floor:
            return self.abstain(
                "I don't have sufficient grounding in the corpus to answer this reliably.",
                confidence,
            )
        return {
            "text": "\n\n".join(self._paragraphs),
            "citations": self._citations,
            "confidence": round(confidence, 4),
        }

    def abstain(self, reason: str, confidence: float = 0.0) -> dict[str, Any]:
        """Abstention is a success mode, never a confident guess."""
        return {
            "text": reason,
            "citations": [],
            "confidence": round(min(confidence, self.confidence_floor), 4),
            "abstained": True,
        }
