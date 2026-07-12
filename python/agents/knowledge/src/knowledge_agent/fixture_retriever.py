"""Hermetic retriever over the acme-corp fixture corpus: the golden set
runs in CI with no dev stack, exercising exactly the retrieval contract
(citation-carrying results). The full-stack path is the E2E suite's job."""

import json
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class FixtureRetriever:
    corpus_dir: Path

    def __post_init__(self) -> None:
        manifest = json.loads((self.corpus_dir / "corpus.json").read_text(encoding="utf-8"))
        self.chunks: list[dict[str, Any]] = []
        for source in manifest["sources"]:
            for doc in source["documents"]:
                content = (self.corpus_dir / doc["path"]).read_text(encoding="utf-8")
                for i, section in enumerate(self._sections(content)):
                    self.chunks.append(
                        {
                            "content": section,
                            "citation": {
                                "doc_id": doc["doc_id"],
                                "version": doc["version"],
                                "effective_date": doc["effective_date"],
                                "url": doc["url"],
                                # Deterministic stand-in for the ledger key.
                                "lineage_id": str(
                                    uuid.uuid5(uuid.NAMESPACE_URL, f"{doc['doc_id']}#{i}")
                                ),
                            },
                        }
                    )

    @staticmethod
    def _sections(markdown: str) -> list[str]:
        parts = re.split(r"\n(?=#{1,4}\s)", markdown)
        return [p.strip() for p in parts if p.strip()]

    async def search(
        self,
        delegated_token: str,
        query: str,
        *,
        k: int = 8,
        task_id: str | None = None,
        step_id: str | None = None,
    ) -> list[dict[str, Any]]:
        # Term-frequency scoring with light stemming — the same shape as the
        # real store's ts_rank_cd lexical leg, so eval behavior predicts
        # production behavior instead of diverging from it.
        terms = {t.rstrip("s") for t in re.split(r"[^a-z0-9-]+", query.lower()) if len(t) > 2}
        scored = []
        for chunk in self.chunks:
            words = [w.rstrip("s") for w in re.split(r"[^a-z0-9-]+", chunk["content"].lower())]
            tf = sum(1 for w in words if w in terms)
            if tf > 0:
                scored.append((float(tf), chunk))
        scored.sort(key=lambda s: s[0], reverse=True)
        top = scored[:k]
        max_score = top[0][0] if top else 1.0
        return [
            {"content": c["content"], "score": round(s / max_score, 4), "citation": c["citation"]}
            for s, c in top
        ]
