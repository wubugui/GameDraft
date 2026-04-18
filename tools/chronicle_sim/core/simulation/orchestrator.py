from __future__ import annotations

import asyncio
import json
import shutil
import threading
import warnings
from collections.abc import Callable
from pathlib import Path
from typing import Any

from tools.chronicle_sim.core.agents.chronicle_director_agent import ChronicleDirectorAgent
from tools.chronicle_sim.core.agents.gm_agent import GMAgent
from tools.chronicle_sim.core.agents.npc_agent import NPCAgent
from tools.chronicle_sim.core.agents.rumor_agent import RumorAgent
from tools.chronicle_sim.core.agents.week_summarizer import WeekSummarizerAgent
from tools.chronicle_sim.core.llm.client_factory import ClientFactory, LLMClient
from tools.chronicle_sim.core.llm.config_resolve import (
    embedding_profile_from_config,
    provider_profile_for_agent,
)
from tools.chronicle_sim.core.runtime.agent_state import AgentState
from tools.chronicle_sim.core.runtime.event_bus import EventBus
from tools.chronicle_sim.core.runtime.history_buffer import HistoryBuffer
from tools.chronicle_sim.core.runtime.memory_store import SCHEMA_EMBED_DIM_KEY, MemoryStore
from tools.chronicle_sim.core.schema.models import NpcTier
from tools.chronicle_sim.core.schema.week_intent import WeekIntent
from tools.chronicle_sim.core.storage.db import Database
from tools.chronicle_sim.core.storage.tier_manager import TierManager
from tools.chronicle_sim.core.simulation.tier_sql import apply_tier_downgrade_sql, apply_tier_upgrade_sql
from tools.chronicle_sim.core.simulation.world_seed_context import load_world_bible_for_prompt
from tools.chronicle_sim.core.simulation.world_updates import (
    anchor_reminders_for_week,
    sync_beliefs_from_witnesses,
    touch_tier_b_state_cards,
)
from tools.chronicle_sim.core.storage.event_library import (
    load_event_types_yaml,
    pick_top_event_types,
    sync_event_types_to_db,
)
from tools.chronicle_sim.core.storage.snapshot import save_week_snapshot, write_snapshot_json
from tools.chronicle_sim.core.simulation.pacing_curve import load_pacing_profile, multiplier_for_week
from tools.chronicle_sim.core.simulation.persistence import (
    events_for_week_json,
    persist_event_record,
    persist_week_intent,
)
from tools.chronicle_sim.paths import DATA_DIR


def _agent_log_path(run_dir: Path, agent_id: str, week: int) -> Path:
    p = run_dir / "agent_logs" / agent_id / f"week_{week:03d}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _append_log(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


class WeekOrchestrator:
    def __init__(
        self,
        db: Database,
        run_dir: Path,
        llm_config: dict[str, Any] | None = None,
        *,
        cancel_flag: threading.Event | None = None,
        progress_log: Callable[[str], None] | None = None,
    ) -> None:
        self.db = db
        self.run_dir = run_dir
        self.conn = db.conn
        self.llm_config = llm_config or {}
        self._cancel_flag = cancel_flag
        self._progress_log = progress_log
        self.bus = EventBus()
        self.prompts_dir = DATA_DIR / "prompts"
        self.event_types = load_event_types_yaml(DATA_DIR / "event_types.yaml")
        sync_event_types_to_db(self.conn, self.event_types)
        self.conn.commit()
        self._chat_clients: list[LLMClient] = []
        self._sql_lock = asyncio.Lock()

    def _track_llm(self, client: LLMClient) -> LLMClient:
        self._chat_clients.append(client)
        return client

    async def _close_tracked_llms(self) -> None:
        for c in self._chat_clients:
            try:
                await c.aclose()
            except Exception as e:
                warnings.warn(f"关闭对话 LLM 客户端失败 ({getattr(c, 'agent_id', '?')}): {e}", UserWarning)
        self._chat_clients.clear()

    def _check_cancel(self) -> None:
        if self._cancel_flag is not None and self._cancel_flag.is_set():
            raise asyncio.CancelledError()

    def _emit_progress(self, msg: str) -> None:
        if self._progress_log:
            self._progress_log(msg)

    def _make_npc(self, row: Any) -> NPCAgent:
        tier = NpcTier(row["current_tier"])
        if tier == NpcTier.S:
            prof_key = "tier_s_npc"
        else:
            prof_key = "tier_a_npc"
        prof = provider_profile_for_agent(prof_key, self.llm_config)
        llm = self._track_llm(
            ClientFactory.build_for_agent(row["id"], prof, self.llm_config, run_dir=self.run_dir)
        )
        mem = MemoryStore(
            self.conn,
            row["id"],
            run_dir=self.run_dir,
            embedding=getattr(self, "_embed_backend", None),
            telemetry_log=lambda m, emit=self._emit_progress: emit(f"[记忆] {m}"),
            sql_lock=self._sql_lock,
        )
        hist = HistoryBuffer()
        st = AgentState()
        return NPCAgent(
            agent_id=row["id"],
            name=row["name"],
            tier=tier,
            llm=llm,
            memory=mem,
            history=hist,
            state=st,
            bus=self.bus,
            prompts_dir=self.prompts_dir,
        )

    def _make_gm(self) -> GMAgent:
        llm = self._track_llm(
            ClientFactory.build_for_agent(
                "gm_world",
                provider_profile_for_agent("gm", self.llm_config),
                self.llm_config,
                run_dir=self.run_dir,
            )
        )
        return GMAgent(
            llm=llm,
            memory=MemoryStore(self.conn, "gm_world"),
            history=HistoryBuffer(),
            state=AgentState(),
            bus=self.bus,
            prompts_dir=self.prompts_dir,
        )

    def _make_director(self) -> ChronicleDirectorAgent:
        llm = self._track_llm(
            ClientFactory.build_for_agent(
                "chronicle_director",
                provider_profile_for_agent("director", self.llm_config),
                self.llm_config,
                run_dir=self.run_dir,
            )
        )
        return ChronicleDirectorAgent(
            llm=llm,
            memory=MemoryStore(self.conn, "chronicle_director"),
            history=HistoryBuffer(),
            state=AgentState(),
            bus=self.bus,
            prompts_dir=self.prompts_dir,
        )

    def _make_rumor(self) -> RumorAgent:
        llm = self._track_llm(
            ClientFactory.build_for_agent(
                "rumor_agent",
                provider_profile_for_agent("rumor", self.llm_config),
                self.llm_config,
                run_dir=self.run_dir,
            )
        )
        return RumorAgent(
            llm=llm,
            memory=MemoryStore(self.conn, "rumor_agent"),
            history=HistoryBuffer(),
            state=AgentState(),
            bus=self.bus,
            prompts_dir=self.prompts_dir,
            llm_config=self.llm_config,
        )

    def _make_week_sum(self) -> WeekSummarizerAgent:
        llm = self._track_llm(
            ClientFactory.build_for_agent(
                "week_summarizer",
                provider_profile_for_agent("week_summarizer", self.llm_config),
                self.llm_config,
                run_dir=self.run_dir,
            )
        )
        return WeekSummarizerAgent(
            llm=llm,
            memory=MemoryStore(self.conn, "week_summarizer"),
            history=HistoryBuffer(),
            state=AgentState(),
            bus=self.bus,
            prompts_dir=self.prompts_dir,
        )

    def _sync_embed_profile_meta(self) -> None:
        prof = embedding_profile_from_config(self.llm_config)
        if prof is None:
            return
        key = "agent_memory_embed_profile"
        blob = json.dumps(
            {"kind": prof.kind, "model": prof.model},
            sort_keys=True,
            ensure_ascii=False,
        )
        row = self.conn.execute("SELECT value FROM schema_meta WHERE key=?", (key,)).fetchone()
        if row is None:
            self.conn.execute(
                "INSERT OR REPLACE INTO schema_meta (key,value) VALUES (?,?)",
                (key, blob),
            )
            return
        if row[0] != blob:
            warnings.warn(
                "嵌入配置（kind/model）与库内 schema_meta 记录不一致，可能已更换嵌入模型。已更新记录并清除已缓存的向量维度；"
                "若语义检索异常请删除本 run 目录下 chroma_memory，并清空 agent_memories.embedding_blob 后重新推进周次以回填。",
                UserWarning,
            )
            self.conn.execute("DELETE FROM schema_meta WHERE key = ?", (SCHEMA_EMBED_DIM_KEY,))
            self.conn.execute(
                "INSERT OR REPLACE INTO schema_meta (key,value) VALUES (?,?)",
                (key, blob),
            )

    async def run_week(self, week: int) -> dict[str, Any]:
        self._chat_clients.clear()
        self._check_cancel()
        self._emit_progress(f"第 {week} 周：准备嵌入后端…")
        self._embed_backend = ClientFactory.build_embedding_backend(
            embedding_profile_from_config(self.llm_config),
            self.llm_config,
        )
        sem = self.llm_config.get("semantic_memory")
        if (
            isinstance(sem, dict)
            and sem.get("strict")
            and self._embed_backend is None
        ):
            raise RuntimeError(
                "已开启 semantic_memory.strict，但未解析到可用的嵌入后端。请在「配置控制台」的 LLM 页填写「嵌入」为 Ollama 或 OpenAI 兼容，"
                "或关闭「语义记忆 strict」。"
            )
        if (
            isinstance(sem, dict)
            and sem.get("strict")
            and self._embed_backend is not None
        ):
            try:
                await self._embed_backend.embed(["__chronicle_sim_ping__"])
            except Exception as e:
                raise RuntimeError(
                    f"semantic_memory.strict：嵌入服务端不可用或模型失败（{e}）。请检查 Ollama/兼容 API 与嵌入模型是否已拉取。"
                ) from e
        self._check_cancel()
        self._emit_progress(f"第 {week} 周：同步嵌入元数据…")
        self._sync_embed_profile_meta()
        try:
            self._check_cancel()
            return await self._run_week_core(week)
        finally:
            await self._close_tracked_llms()
            eb = getattr(self, "_embed_backend", None)
            if eb is not None:
                try:
                    await eb.aclose()
                except Exception as e:
                    warnings.warn(f"关闭嵌入 HTTP 客户端失败: {e}", UserWarning)
            self._embed_backend = None

    async def _run_week_core(self, week: int) -> dict[str, Any]:
        from tools.chronicle_sim.core.runtime.memory_store import backfill_null_agent_memories

        self._check_cancel()
        self._emit_progress(f"第 {week} 周：应用 Tier 升降级…")
        tm = TierManager(self.conn)

        def _on_up(aid: str, _old: NpcTier, _new: NpcTier) -> None:
            apply_tier_upgrade_sql(self.conn, aid, week)

        def _on_down(aid: str, _old: NpcTier, _new: NpcTier) -> None:
            apply_tier_downgrade_sql(self.conn, aid, week, run_dir=self.run_dir)

        tm.apply_pending(week, on_upgrade=_on_up, on_downgrade=_on_down)
        self.conn.commit()

        if getattr(self, "_embed_backend", None) is not None:
            self._check_cancel()
            self._emit_progress(f"第 {week} 周：回填 NPC 记忆向量…")
            await backfill_null_agent_memories(
                self.conn, self.run_dir, self._embed_backend, sql_lock=self._sql_lock
            )
            self.conn.commit()

        self._check_cancel()
        meta = self.db.run_meta()
        pacing_id = (meta or {}).get("pacing_profile_id") or "default"
        profile = load_pacing_profile(str(pacing_id))
        mult = multiplier_for_week(profile, week)

        rows = self.conn.execute(
            "SELECT * FROM agents WHERE current_tier IN ('S','A','B') AND life_status = 'alive'"
        ).fetchall()
        npcs = [self._make_npc(r) for r in rows]
        self._emit_progress(f"第 {week} 周：收集 NPC 周意图（{len(npcs)} 人）…")

        intents: list[WeekIntent] = []

        async def _one(n: NPCAgent) -> WeekIntent:
            it = await n.step(week)
            async with self._sql_lock:
                persist_week_intent(
                    self.conn,
                    it.agent_id,
                    it.week,
                    it.mood_delta,
                    it.intent_text,
                    it.target_ids,
                    it.relationship_hints,
                )
            _append_log(
                _agent_log_path(self.run_dir, n.id, week),
                {"phase": "week_intent", "data": it.model_dump()},
            )
            return it

        # 与 LLM 全局串行门一致：NPC 周意图逐个收集，避免与门控叠加产生大量阻塞任务。
        intent_results: list[WeekIntent] = []
        for n in npcs:
            intent_results.append(await _one(n))
        intents.extend(intent_results)
        self.conn.commit()

        self._check_cancel()
        self._emit_progress(f"第 {week} 周：导演生成事件草案…")
        picked = pick_top_event_types(self.event_types, week, mult, self.conn, k=12)
        for et, score, reason in picked:
            self.conn.execute(
                """
                INSERT INTO director_decisions (week, candidate_event_type, score, chosen, reason)
                VALUES (?,?,?,?,?)
                """,
                (week, et.id, score, 1, reason),
            )

        anchor_txt = anchor_reminders_for_week(self.conn, week)
        bible = load_world_bible_for_prompt(self.conn)
        if bible:
            anchor_txt = bible + "\n\n" + anchor_txt
        prev_lines: list[str] = []
        if week > 1:
            for er in self.conn.execute(
                "SELECT type_id, truth_json FROM events WHERE week_number = ? ORDER BY id",
                (week - 1,),
            ).fetchall():
                tj = (er["truth_json"] or "")[:160]
                prev_lines.append(f"- {er['type_id']}: {tj}")
        extra_ctx = anchor_txt
        if prev_lines:
            extra_ctx += "\n【上周事件提要】\n" + "\n".join(prev_lines)

        director = self._make_director()
        drafts = await director.produce_drafts(
            week, intents, picked, pacing_note=str(pacing_id), extra_context=extra_ctx
        )
        dt_path = self.run_dir / "director_trace" / f"week_{week:03d}.jsonl"
        dt_path.parent.mkdir(parents=True, exist_ok=True)
        _append_log(dt_path, {"drafts": [d.model_dump() for d in drafts]})

        self._check_cancel()
        self._emit_progress(f"第 {week} 周：GM 裁定事件…")
        gm = self._make_gm()
        records = await gm.arbitrate(week, drafts, world_context=anchor_txt)
        allowed_type_ids = {
            r[0]
            for r in self.conn.execute("SELECT id FROM event_types").fetchall()
        }
        for rec in records:
            if rec.type_id not in allowed_type_ids:
                rec.type_id = "misc"
            persist_event_record(self.conn, rec)

        sync_beliefs_from_witnesses(self.conn, week, records)
        touch_tier_b_state_cards(self.conn, week, records)

        self._check_cancel()
        self._emit_progress(f"第 {week} 周：谣言传播…")
        holder_ids = [
            r["id"]
            for r in self.conn.execute(
                "SELECT id FROM agents WHERE current_tier IN ('S','A','B') AND life_status = 'alive'"
            ).fetchall()
        ]
        rumor = self._make_rumor()
        await rumor.spread(self.conn, week, records, holder_ids, sql_lock=self._sql_lock)

        self._check_cancel()
        self._emit_progress(f"第 {week} 周：周总结…")
        wsum = self._make_week_sum()
        blob = events_for_week_json(self.conn, week)
        summary_text = await wsum.summarize_week(week, blob)
        self.conn.execute(
            "INSERT INTO summaries (scope, week_start, week_end, text, style_applied) VALUES (?,?,?,?,0)",
            ("week", week, week, summary_text),
        )

        self.conn.execute("UPDATE runs SET current_week = ?", (week,))
        save_week_snapshot(self.conn, week)
        snap_dir = self.run_dir / "snapshots"
        snap_dir.mkdir(parents=True, exist_ok=True)
        write_snapshot_json(snap_dir / f"week_{week:03d}.json", week, self.conn)
        try:
            shutil.copy2(self.db.path, snap_dir / f"week_{week:03d}.db")
        except OSError:
            pass
        if week % 4 == 0:
            self._check_cancel()
            self._emit_progress(f"第 {week} 周：月度史（每4 周）…")
            from tools.chronicle_sim.core.agents.month_historian import MonthHistorianAgent
            from tools.chronicle_sim.core.agents.style_rewriter import StyleRewriterAgent

            mh = MonthHistorianAgent(
                llm=self._track_llm(
                    ClientFactory.build_for_agent(
                        "month_historian",
                        provider_profile_for_agent("month_historian", self.llm_config),
                        self.llm_config,
                        run_dir=self.run_dir,
                    )
                ),
                memory=MemoryStore(self.conn, "month_historian"),
                history=HistoryBuffer(),
                state=AgentState(),
                bus=self.bus,
                prompts_dir=self.prompts_dir,
            )
            ws = max(1, week - 3)
            rows = self.conn.execute(
                "SELECT text FROM summaries WHERE scope='week' AND week_start >= ? AND week_end <= ? ORDER BY week_start",
                (ws, week),
            ).fetchall()
            prior = "\n".join(r[0] for r in rows)
            month_text = await mh.summarize_month(ws, week, prior)
            sty = StyleRewriterAgent(
                llm=self._track_llm(
                    ClientFactory.build_for_agent(
                        "style_rewriter",
                        provider_profile_for_agent("style_rewriter", self.llm_config),
                        self.llm_config,
                        run_dir=self.run_dir,
                    )
                ),
                memory=MemoryStore(self.conn, "style_rewriter"),
                history=HistoryBuffer(),
                state=AgentState(),
                bus=self.bus,
                prompts_dir=self.prompts_dir,
            )
            polished = await sty.rewrite(month_text)
            self.conn.execute(
                "INSERT INTO summaries (scope, week_start, week_end, text, style_applied) VALUES (?,?,?,?,1)",
                ("month", ws, week, polished),
            )

        self._check_cancel()
        self.conn.commit()
        self._emit_progress(f"第 {week} 周：已完成并提交数据库。")
        return {"week": week, "intents": [i.model_dump() for i in intents], "events": len(records)}

    def run_week_sync(self, week: int) -> dict[str, Any]:
        return asyncio.run(self.run_week(week))
