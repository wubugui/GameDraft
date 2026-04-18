from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from tools.chronicle_sim.core.llm.client_factory import ClientFactory, LLMClient
from tools.chronicle_sim.core.llm.config_resolve import embedding_profile_from_config
from tools.chronicle_sim.core.runtime.agent_state import AgentState
from tools.chronicle_sim.core.runtime.base_agent import BaseAgent
from tools.chronicle_sim.core.runtime.event_bus import EventBus
from tools.chronicle_sim.core.runtime.history_buffer import HistoryBuffer
from tools.chronicle_sim.core.runtime.memory_store import MemoryStore
from tools.chronicle_sim.core.storage.belief_store import BeliefStore
from tools.chronicle_sim.core.storage.probe_world_index import ensure_probe_world_index, search_probe_world
from tools.chronicle_sim.core.storage.sql_like import escape_like_pattern
from tools.chronicle_sim.core.storage.vector_store import MemoryIndex


def _search_events_sql(conn: Any, q: str, limit: int = 8) -> list[dict[str, Any]]:
    pat = escape_like_pattern(q)
    like = f"%{pat}%"
    rows = conn.execute(
        r"""
        SELECT id, week_number, type_id, substr(truth_json, 1, 220) AS sn
        FROM events
        WHERE truth_json LIKE ? ESCAPE '\' OR type_id LIKE ? ESCAPE '\' OR id LIKE ? ESCAPE '\'
        ORDER BY week_number DESC
        LIMIT ?
        """,
        (like, like, like, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def _search_summaries_sql(
    conn: Any,
    q: str,
    limit: int = 6,
    week_min: int | None = None,
    week_max: int | None = None,
) -> list[dict[str, Any]]:
    pat = escape_like_pattern(q)
    like = f"%{pat}%"
    conds = [r"text LIKE ? ESCAPE '\'"]
    params: list[Any] = [like]
    if week_min is not None:
        conds.append("week_end >= ?")
        params.append(week_min)
    if week_max is not None:
        conds.append("week_start <= ?")
        params.append(week_max)
    params.append(limit)
    sql = f"""
        SELECT scope, week_start, week_end, substr(text, 1, 280) AS sn
        FROM summaries
        WHERE {' AND '.join(conds)}
        ORDER BY week_start DESC
        LIMIT ?
    """
    rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def _dedupe_refs(refs: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[tuple[str, str]] = set()
    out: list[dict[str, str]] = []
    for r in refs:
        kind = str(r.get("kind", ""))
        rid = str(
            r.get("id", "")
            or f"{r.get('holder', '')}|{r.get('topic', '')}|{r.get('scope', '')}|{r.get('ref', '')}"
        )
        key = (kind, rid)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


class ProbeAgent(BaseAgent):
    def __init__(
        self,
        llm: LLMClient,
        memory: MemoryStore,
        history: HistoryBuffer,
        state: AgentState,
        bus: EventBus,
        prompts_dir: Path,
        *,
        run_dir: Path | None = None,
        llm_config: dict[str, Any] | None = None,
    ) -> None:
        super().__init__("probe_agent", llm, memory, history, state, bus)
        self._prompts_dir = prompts_dir
        self._run_dir = run_dir
        self._llm_config = llm_config

    async def answer(
        self,
        conn: Any,
        user_message: str,
        focus_agent_id: str | None = None,
        history: list[dict[str, str]] | None = None,
        week_min: int | None = None,
        week_max: int | None = None,
    ) -> tuple[str, list[dict[str, str]]]:
        p = self._prompts_dir / "probe_agent.md"
        system = p.read_text(encoding="utf-8") if p.is_file() else "你是素材探针，根据检索片段给支线灵感，标注引用来源。"
        embed_backend = ClientFactory.build_embedding_backend(
            embedding_profile_from_config(self._llm_config or {}),
            self._llm_config,
        )
        refs: list[dict[str, str]] = []
        try:
            if self._run_dir and embed_backend is not None:
                await ensure_probe_world_index(conn, self._run_dir, embed_backend)
                for h in await search_probe_world(
                    conn,
                    self._run_dir,
                    embed_backend,
                    user_message,
                    week_min=week_min,
                    week_max=week_max,
                    limit=10,
                ):
                    if h.get("kind") == "event":
                        refs.append(
                            {
                                "kind": "event",
                                "id": str(h.get("id", "")),
                                "week": str(h.get("week", "")),
                                "snippet": str(h.get("snippet", "")),
                                "ref": "chroma",
                            }
                        )
                    else:
                        refs.append(
                            {
                                "kind": "summary",
                                "scope": str(h.get("scope", "")),
                                "snippet": str(h.get("snippet", "")),
                                "ref": "chroma",
                            }
                        )

            if focus_agent_id and self._run_dir and embed_backend is not None:
                ms = MemoryStore(
                    conn,
                    focus_agent_id,
                    run_dir=self._run_dir,
                    embedding=embed_backend,
                )
                mem_hits = await ms.recall_semantic(user_message, limit=6, recency_k=2, caller_id=focus_agent_id)
            else:
                idx = MemoryIndex(conn)
                mem_hits = idx.search(focus_agent_id, user_message, limit=5)
            for m in mem_hits:
                refs.append(
                    {"kind": "memory", "id": str(m.get("id")), "snippet": (m.get("content") or "")[:200]}
                )
            bel = BeliefStore(conn)
            bel_hits = bel.search_text(user_message, limit=8)
            for b in bel_hits:
                refs.append(
                    {
                        "kind": "belief",
                        "holder": str(b.get("holder_id", "")),
                        "topic": str(b.get("topic", "")),
                        "snippet": (b.get("claim_text") or "")[:200],
                    }
                )
            ev_hits = _search_events_sql(conn, user_message, limit=8)
            for e in ev_hits:
                wk = int(e.get("week_number", 0))
                if week_min is not None and wk < week_min:
                    continue
                if week_max is not None and wk > week_max:
                    continue
                refs.append(
                    {
                        "kind": "event",
                        "id": str(e.get("id", "")),
                        "week": str(wk),
                        "snippet": f"{e.get('type_id')} {e.get('sn', '')}"[:220],
                        "ref": "sql",
                    }
                )
            sum_hits = _search_summaries_sql(
                conn, user_message, limit=5, week_min=week_min, week_max=week_max
            )
            for s in sum_hits:
                refs.append(
                    {
                        "kind": "summary",
                        "scope": str(s.get("scope", "")),
                        "snippet": str(s.get("sn", "")),
                        "ref": "sql",
                    }
                )
            refs = _dedupe_refs(refs)
        finally:
            if embed_backend is not None:
                await embed_backend.aclose()

        ctx = json.dumps(refs, ensure_ascii=False)
        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        if history:
            messages.extend(history[-8:])
        messages.append(
            {
                "role": "user",
                "content": f"用户问：{user_message}\n检索：{ctx}\n请分条回答并标注引用 kind/id。",
            }
        )
        resp = await self.llm.chat(messages, temperature=0.7)
        return resp.text, refs

    async def step(self, week: int) -> Any:
        return None
