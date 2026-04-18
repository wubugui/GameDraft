from __future__ import annotations

import re
import sqlite3
from typing import Any


def tokenize(text: str) -> set[str]:
    return set(re.findall(r"[\u4e00-\u9fff]{2,}|\w+", text.lower()))


class MemoryIndex:
    """无向量依赖的简单检索：按词重叠打分。"""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def search(
        self,
        owner_agent_id: str | None,
        query: str,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        qtok = tokenize(query)
        if not qtok:
            return []
        sql = "SELECT * FROM agent_memories WHERE 1=1"
        params: list[Any] = []
        if owner_agent_id:
            sql += " AND owner_agent_id = ?"
            params.append(owner_agent_id)
        rows = self._conn.execute(sql, params).fetchall()
        scored: list[tuple[float, dict[str, Any]]] = []
        for r in rows:
            content = r["content"] or ""
            ctok = tokenize(content)
            overlap = len(qtok & ctok)
            if overlap:
                scored.append((float(overlap), dict(r)))
        scored.sort(key=lambda x: -x[0])
        return [s[1] for s in scored[:limit]]
