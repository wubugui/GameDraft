from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from tools.chronicle_sim.core.llm.client_factory import LLMClient
from tools.chronicle_sim.core.runtime.agent_state import AgentState
from tools.chronicle_sim.core.runtime.base_agent import BaseAgent
from tools.chronicle_sim.core.runtime.event_bus import EventBus
from tools.chronicle_sim.core.runtime.history_buffer import HistoryBuffer
from tools.chronicle_sim.core.runtime.memory_store import MemoryStore
from tools.chronicle_sim.core.schema.belief import BeliefRecord
from tools.chronicle_sim.core.schema.event_record import EventRecord
from tools.chronicle_sim.core.storage.belief_store import BeliefStore
from tools.chronicle_sim.core.storage.social_graph import SocialGraph


def _rumor_distort_cap(llm_config: dict[str, Any] | None) -> int:
    block = (llm_config or {}).get("rumor")
    if not isinstance(block, dict):
        return 64
    raw = block.get("max_distortion_llm_calls_per_week", 64)
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return 64
    if n <= 0:
        return 10**9
    return n


class RumorAgent(BaseAgent):
    def __init__(
        self,
        llm: LLMClient,
        memory: MemoryStore,
        history: HistoryBuffer,
        state: AgentState,
        bus: EventBus,
        prompts_dir: Path,
        llm_config: dict[str, Any] | None = None,
    ) -> None:
        super().__init__("rumor_agent", llm, memory, history, state, bus)
        self._prompts_dir = prompts_dir
        self._llm_config = llm_config

    async def _distort_snippet_llm(self, snippet: str, hops: int, event_type_id: str) -> str:
        if not snippet.strip():
            return snippet
        p = self._prompts_dir / "rumor_agent.md"
        rules = p.read_text(encoding="utf-8") if p.is_file() else ""
        user = (
            f"【传闻改写任务】传播跳数={hops}，事件类型={event_type_id}\n"
            f"原句：{snippet}\n"
            "改写成一条简短中文街头传闻（不超过90字）：允许省略、添油加醋、细节对不上号；"
            "保留一点可追查的线索；禁止全知叙事与「我亲眼」式口吻。\n"
            "只输出改写后的那一句话，不要引号或解释。"
        )
        messages = [
            {"role": "system", "content": (rules[:3000] if rules else "你是流言转述者。")},
            {"role": "user", "content": user},
        ]
        try:
            resp = await self.llm.chat(messages, temperature=0.85)
            text = (resp.text or "").strip().strip('"').strip("「」").strip()
            if text:
                return text[:220]
        except Exception:
            pass
        return snippet[:80] + "……（传闻走样）"

    async def spread(
        self,
        conn: Any,
        week: int,
        records: list[EventRecord],
        holder_ids: list[str],
        *,
        sql_lock: asyncio.Lock | None = None,
    ) -> None:
        graph = SocialGraph(conn)
        beliefs = BeliefStore(conn)
        cap = _rumor_distort_cap(self._llm_config)
        cache: dict[tuple[str, int, str], str] = {}
        llm_used = 0
        sem = asyncio.Semaphore(5)

        async def _twist(snippet: str, hops: int, event_type_id: str) -> str:
            nonlocal llm_used
            key = (snippet.strip()[:300], int(hops), str(event_type_id))
            if key in cache:
                return cache[key]
            if llm_used >= cap:
                out = snippet[:80] + "……（传闻走样）"
                cache[key] = out
                return out
            async with sem:
                llm_used += 1
                out = await self._distort_snippet_llm(snippet, hops, event_type_id)
            cache[key] = out
            return out

        pending_rumors: list[tuple[Any, ...]] = []
        pending_beliefs: list[BeliefRecord] = []

        for rec in records:
            seeds = [w.agent_id for w in rec.witness_accounts]
            for start in seeds:
                paths = graph.bfs_paths(start, max_hops=2)
                for target, (hops, _) in paths.items():
                    if target == start or target not in holder_ids:
                        continue
                    distortion = min(3, hops)
                    snippet = ""
                    for w in rec.witness_accounts:
                        if w.agent_id == start:
                            snippet = w.account_text
                            break
                    if not snippet and rec.witness_accounts:
                        snippet = rec.witness_accounts[0].account_text
                    if not snippet:
                        snippet = str(rec.truth_json.get("note", ""))
                    twisted = snippet
                    if distortion > 1 and snippet:
                        twisted = await _twist(snippet, hops, rec.type_id)
                    pending_rumors.append(
                        (rec.id, week, start, target, twisted, distortion, hops)
                    )
                    pending_beliefs.append(
                        BeliefRecord(
                            holder_id=target,
                            subject_id=rec.id,
                            topic="事件传闻",
                            claim_text=twisted,
                            source_event_id=rec.id,
                            distortion_level=distortion,
                            first_heard_week=week,
                            last_updated_week=week,
                            confidence=0.4 / hops,
                        )
                    )
            rv = list(rec.rumor_versions or [])
            rv.append(f"第{week}周流传：{rec.type_id}")
            rec.rumor_versions = rv

        def _flush_sql() -> None:
            if not pending_rumors:
                return
            # 不得在此 BEGIN/COMMIT：WeekOrchestrator 在 Python 3.10 默认隐式事务下
            # 自 director_decisions 起可能已处于未提交事务中；嵌套 BEGIN 会触发 sqlite错误。
            for args in pending_rumors:
                conn.execute(
                    """
                    INSERT INTO rumors (originating_event_id, week_emerged, teller_id, hearer_id, content, distortion_level, propagation_hop)
                    VALUES (?,?,?,?,?,?,?)
                    """,
                    args,
                )
            for b in pending_beliefs:
                beliefs.upsert(b)

        if sql_lock is not None:
            async with sql_lock:
                _flush_sql()
        else:
            _flush_sql()

    async def step(self, week: int) -> Any:
        return None
