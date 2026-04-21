"""WeekOrchestrator：周模拟编排器（文件式，无 SQLite）。"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import uuid
from pathlib import Path
from typing import Any, Callable

from tools.chronicle_sim_v2.core.llm.client_factory import ClientFactory, PAChatResources
from tools.chronicle_sim_v2.core.llm.config_resolve import (
    effective_connection_block,
    provider_profile_for_agent,
)
from tools.chronicle_sim_v2.core.sim.event_types import load_event_types, pick_top_event_types, event_types_text_for_prompt
from tools.chronicle_sim_v2.core.sim.pacing import load_pacing_profile, multiplier_for_week
from tools.chronicle_sim_v2.core.sim.tier_manager import apply_pending_tier_changes
from tools.chronicle_sim_v2.core.world.chroma import add_world_doc
from tools.chronicle_sim_v2.core.world.fs import write_json, write_text, read_text, read_json
from tools.chronicle_sim_v2.core.world.seed_reader import (
    load_active_agent_ids_with_tier,
    read_agent,
    build_world_bible_text,
)
from tools.chronicle_sim_v2.core.world.week_state import (
    week_dir_name,
    write_week_intent,
    read_week_intents,
    write_event_record,
    read_week_events,
    write_week_summary,
    write_week_rumors,
    write_agent_memory,
    write_week_trace,
)


class WeekLock:
    """周级锁。"""

    def __init__(self, run_dir: Path):
        self.run_dir = run_dir
        self.lock_file = run_dir / ".week_lock"

    def acquire(self, week: int) -> bool:
        if self.lock_file.is_file():
            return False
        import datetime
        data = {
            "week": week,
            "pid": os.getpid(),
            "started_at": datetime.datetime.now().isoformat(),
        }
        with open(self.lock_file, "w", encoding="utf-8") as f:
            json.dump(data, f)
        return True

    def release(self) -> None:
        try:
            os.unlink(self.lock_file)
        except OSError:
            pass


class WeekOrchestrator:
    def __init__(
        self,
        run_dir: Path,
        llm_config: dict[str, Any] | None,
        cancel_flag: threading.Event | None = None,
        progress_log: Callable[[str], None] | None = None,
    ):
        self.run_dir = run_dir
        self.llm_config = llm_config or {}
        self.cancel_flag = cancel_flag or threading.Event()
        self.progress_log = progress_log or (lambda s: print(s))
        self.event_types = load_event_types()
        self._embed_backend: Any | None = None

    def _log(self, msg: str) -> None:
        self.progress_log(msg)

    def _is_cancelled(self) -> bool:
        return self.cancel_flag.is_set()

    def _build_pa(self, agent_kind: str) -> PAChatResources:
        """为指定 Agent 类型构建 PAChatResources。"""
        profile = provider_profile_for_agent(agent_kind, self.llm_config)
        return ClientFactory.build_pa_chat(
            agent_id=agent_kind,
            profile=profile,
            llm_config=self.llm_config,
            run_dir=self.run_dir,
        )

    async def run_week(self, week: int) -> dict[str, Any]:
        """运行一周模拟。"""
        # 加锁
        lock = WeekLock(self.run_dir)
        if not lock.acquire(week):
            raise RuntimeError(f"周 {week} 正在运行中（存在 .week_lock）")

        try:
            self._log(f"[Week {week}] 开始")

            # 1. 应用 pending tier 变更
            if self._is_cancelled():
                return {}
            self._log(f"[Week {week}] Phase 1: 应用 Tier 变更...")
            changes = apply_pending_tier_changes(self.run_dir)
            for aid, old, new in changes:
                self._log(f"  Tier 变更: {aid} {old} -> {new}")
            if not changes:
                self._log("  无 Tier 变更")

            # 2. 加载活跃 NPC
            if self._is_cancelled():
                return {}
            self._log(f"[Week {week}] Phase 2: 加载活跃 NPC...")
            agents = load_active_agent_ids_with_tier(self.run_dir)
            s_agents = [(aid, t) for aid, t in agents if str(t).upper() == "S"]
            a_agents = [(aid, t) for aid, t in agents if str(t).upper() == "A"]
            b_agents = [(aid, t) for aid, t in agents if str(t).upper() in ("B", "C")]
            self._log(f"  活跃 NPC: S={len(s_agents)}, A={len(a_agents)}, B/C={len(b_agents)}")
            if s_agents:
                self._log(f"  S 类: {', '.join(aid for aid, _ in s_agents)}")
            if a_agents:
                self._log(f"  A 类: {', '.join(aid for aid, _ in a_agents)}")
            if b_agents:
                self._log(f"  B/C 类: {', '.join(aid for aid, _ in b_agents)}")
            if not agents:
                self._log("  警告: 没有活跃 NPC，请先在种子编辑中添加 NPC 并设置 life_status=alive")

            # 确保周目录
            wdir = week_dir_name(week)
            for sub in ["intents", "events", "memories", "drafts"]:
                (self.run_dir / "chronicle" / wdir / sub).mkdir(parents=True, exist_ok=True)

            # 3. S 类 NPC 意图生成
            if self._is_cancelled():
                return {}
            all_intents = []
            for aid, _ in s_agents:
                if self._is_cancelled():
                    return {}
                self._log(f"[Week {week}] Phase 3: 计算 S 类 NPC {aid} 意图...")
                pa = self._build_pa("tier_s_npc")
                context = self._build_npc_context(aid, week)
                from tools.chronicle_sim_v2.core.agents.npc_agent_s import run_npc_s_intent
                intent = await run_npc_s_intent(pa, self.run_dir, aid, week, context)
                write_week_intent(self.run_dir, week, aid, intent)
                all_intents.append(intent)
                self._log(f"    {aid}: {intent.get('intent_text', '')[:60]}")

                # 写入 S 类 NPC 本周记忆
                memory = {
                    "agent_id": aid,
                    "week": week,
                    "intent": intent,
                    "notes": context,
                }
                write_agent_memory(self.run_dir, week, aid, memory)
            if not s_agents:
                self._log(f"[Week {week}] Phase 3: 无 S 类 NPC，跳过")

            # 4. A 类 NPC 意图生成
            if self._is_cancelled():
                return {}
            if a_agents:
                self._log(f"[Week {week}] Phase 4: 计算 A 类 NPC 意图...")
                pa = self._build_pa("tier_a_npc")
                for aid, _ in a_agents:
                    if self._is_cancelled():
                        return {}
                    self._log(f"  计算 {aid} 意图...")
                    context = self._build_npc_context(aid, week)
                    from tools.chronicle_sim_v2.core.agents.npc_agent_a import run_npc_a_intent
                    intent = await run_npc_a_intent(pa, self.run_dir, aid, week, context)
                    write_week_intent(self.run_dir, week, aid, intent)
                    all_intents.append(intent)
                    self._log(f"    {aid}: {intent.get('intent_text', '')[:60]}")
            else:
                self._log(f"[Week {week}] Phase 4: 无 A 类 NPC，跳过")

            # 5. B/C 类 NPC 意图生成
            if self._is_cancelled():
                return {}
            if b_agents:
                self._log(f"[Week {week}] Phase 5: 计算 B/C 类 NPC 群体意图...")
                pa = self._build_pa("tier_b_npc")
                b_text = self._build_b_context(b_agents)
                from tools.chronicle_sim_v2.core.agents.npc_agent_b import run_npc_b_intent
                b_intent = await run_npc_b_intent(
                    pa, self.run_dir, b_text, week, log_callback=self._log
                )
                write_json(self.run_dir, f"chronicle/{wdir}/intents/tier_b_group.json", b_intent)
                all_intents.append(b_intent)
                self._log(f"  B/C 群体意图: {str(b_intent.get('intent_text', ''))[:60]}")
            else:
                self._log(f"[Week {week}] Phase 5: 无 B/C 类 NPC，跳过")

            # 6. Director 生成事件草稿
            if self._is_cancelled():
                return {}
            self._log(f"[Week {week}] Phase 6: Director 生成事件草稿...")
            pacing_profile = load_pacing_profile(
                (self._load_run_meta() or {}).get("pacing_profile_id", "default")
            )
            pacing_mult = multiplier_for_week(pacing_profile, week)
            ev_text = event_types_text_for_prompt(self.event_types)
            self._log(f"  节奏系数={pacing_mult}, 可用事件类型={len(self.event_types)}")
            from tools.chronicle_sim_v2.core.agents.director_agent import run_director_drafts
            pa_dir = self._build_pa("director")
            drafts = await run_director_drafts(pa_dir, self.run_dir, all_intents, ev_text, week, pacing_mult)
            self._log(f"  Director 生成 {len(drafts)} 条草稿")
            for d in drafts:
                did = d.get("type_id", uuid.uuid4().hex[:8])
                write_json(self.run_dir, f"chronicle/{wdir}/drafts/{did}.json", d)

            # 7. GM 仲裁
            if self._is_cancelled():
                return {}
            self._log(f"[Week {week}] Phase 7: GM 仲裁...")
            world_ctx = build_world_bible_text(self.run_dir)
            pa_gm = self._build_pa("gm")
            from tools.chronicle_sim_v2.core.agents.gm_agent import run_gm_arbitrate
            records = await run_gm_arbitrate(pa_gm, self.run_dir, drafts, world_ctx, week)
            for rec in records:
                write_event_record(self.run_dir, week, rec)
                self._log(f"    事件: {rec.get('type_id', '')}")
            self._log(f"  GM 产出 {len(records)} 条事件记录")

            # 8. 谣言传播
            if self._is_cancelled():
                return {}
            self._log(f"[Week {week}] Phase 8: 谣言传播...")
            pa_rumor = self._build_pa("rumor")
            from tools.chronicle_sim_v2.core.agents.rumor_agent import run_rumor_spread
            rumors = await run_rumor_spread(pa_rumor, self.run_dir, records, week)
            write_week_rumors(self.run_dir, week, rumors)
            self._log(f"  传播 {len(rumors)} 条谣言")

            # 9. 周总结
            if self._is_cancelled():
                return {}
            self._log(f"[Week {week}] Phase 9: 周总结...")
            events = read_week_events(self.run_dir, week)
            intents = read_week_intents(self.run_dir, week)
            pa_sum = self._build_pa("week_summarizer")
            from tools.chronicle_sim_v2.core.agents.week_summarizer_agent import run_week_summary
            summary_text = await run_week_summary(pa_sum, self.run_dir, events, intents, week)
            write_week_summary(self.run_dir, week, summary_text)
            self._log(f"  周总结: {summary_text[:80]}...")

            # 10. 月志（每 4 周）
            if self._is_cancelled():
                return {}
            if week % 4 == 0:
                self._log(f"[Week {week}] Phase 10: 月志编纂...")
                await self._run_month_history(week)

            # 10.5. 更新 world/agents 状态（从事件中提取 NPC 位置、关系变化）
            self._log(f"[Week {week}] Phase 10.5: 更新世界状态...")
            self._update_world_from_events(week)

            # 11. 索引新内容到 ChromaDB
            self._log(f"[Week {week}] Phase 11: 索引到 ChromaDB...")
            events = read_week_events(self.run_dir, week)
            for ev in events:
                eid = ev.get("id", ev.get("type_id", ""))
                truth = ev.get("truth_json", {})
                if isinstance(truth, dict):
                    doc = truth.get("what_happened", truth.get("note", ""))
                else:
                    doc = str(truth)
                if doc:
                    add_world_doc(self.run_dir, f"event:{week}:{eid}", str(doc)[:2000], {"kind": "event", "week": week})

            # 更新当前周
            meta = self._load_run_meta()
            if meta:
                meta["current_week"] = week
                from tools.chronicle_sim_v2.core.sim.run_manager import save_run_meta
                save_run_meta(self.run_dir, meta)

            self._log(f"[Week {week}] 完成 — {len(records)} 事件, {len(rumors)} 谣言")
            return {"week": week, "events": len(records), "rumors": len(rumors)}

        finally:
            lock.release()

    async def _run_month_history(self, week: int) -> None:
        """每 4 周合成月志。"""
        start_week = week - 3
        summaries = []
        for w in range(start_week, week + 1):
            text = read_text(self.run_dir, f"chronicle/{week_dir_name(w)}/summary.md")
            if text:
                summaries.append((w, text))
        if not summaries:
            return

        pa_hist = self._build_pa("month_historian")
        from tools.chronicle_sim_v2.core.agents.month_historian_agent import run_month_summary
        month_num = week // 4
        month_text = await run_month_summary(pa_hist, self.run_dir, summaries, month_num)

        # 文风润色
        pa_rw = self._build_pa("style_rewriter")
        from tools.chronicle_sim_v2.core.agents.style_rewriter_agent import run_style_rewrite
        polished = await run_style_rewrite(pa_rw, self.run_dir, month_text)

        write_text(self.run_dir, f"chronicle/month_{month_num:02d}.md", polished)

    def _build_npc_context(self, agent_id: str, week: int) -> str:
        """构建 NPC 上下文文本。"""
        parts = []

        # 世界背景
        world = read_json(self.run_dir, "world/world_setting.json")
        if world:
            parts.append("【世界】\n" + json.dumps(world, ensure_ascii=False))

        # NPC 个人设定
        agent = read_agent(self.run_dir, agent_id)
        if agent:
            parts.append("【个人设定】\n" + json.dumps(agent, ensure_ascii=False))

        # 上周意图回顾
        prev_week = week - 1
        prev_intent = read_json(self.run_dir, f"chronicle/{week_dir_name(prev_week)}/intents/{agent_id}.json")
        if prev_intent:
            parts.append("【上周意图】\n" + json.dumps(prev_intent, ensure_ascii=False))

        # 相关事件
        prev_events = read_week_events(self.run_dir, prev_week)
        if prev_events:
            parts.append("【近期事件】\n" + json.dumps(prev_events, ensure_ascii=False))

        # 个人记忆
        mem = read_json(self.run_dir, f"chronicle/{week_dir_name(week)}/memories/{agent_id}.json")
        if mem:
            parts.append("【记忆】\n" + json.dumps(mem, ensure_ascii=False))

        return "\n\n".join(parts)

    def _build_b_context(self, b_agents: list[tuple[str, str]]) -> str:
        """构建 B/C 类上下文。"""
        parts = []
        for aid, _ in b_agents:
            agent = read_agent(self.run_dir, aid)
            if agent:
                parts.append(json.dumps(agent, ensure_ascii=False))
        return "\n\n".join(parts)

    def _load_run_meta(self) -> dict[str, Any] | None:
        from tools.chronicle_sim_v2.core.sim.run_manager import load_run_meta
        return load_run_meta(self.run_dir)

    def _update_world_from_events(self, week: int) -> None:
        """从本周事件中提取 NPC 状态变更，更新 world/agents/。"""
        events = read_week_events(self.run_dir, week)
        for ev in events:
            truth = ev.get("truth_json", {})
            if not isinstance(truth, dict):
                continue
            # 从 truth 中提取可能的位置/状态变更
            new_location = truth.get("location_update") or truth.get("moved_to")
            new_notes = truth.get("state_change") or truth.get("notes")
            if not new_location and not new_notes:
                continue
            # 从 witness_accounts 和 actor_ids 提取涉及的 NPC
            involved = set()
            for w in ev.get("witness_accounts", []):
                wid = w.get("agent_id")
                if wid:
                    involved.add(wid)
            for aid in ev.get("actor_ids", []):
                if aid:
                    involved.add(aid)
            # 更新涉及的 NPC 文件
            for aid in involved:
                agent_path = f"world/agents/{aid}.json"
                agent_data = read_json(self.run_dir, agent_path)
                if not agent_data:
                    continue
                if new_location:
                    agent_data["current_location"] = new_location
                if new_notes:
                    existing = agent_data.get("history_notes", [])
                    if isinstance(existing, str):
                        existing = [existing]
                    existing.append(f"[W{week}] {new_notes}")
                    agent_data["history_notes"] = existing
                write_json(self.run_dir, agent_path, agent_data)

