"""主流程冒烟：从设定 MD 库生成种子，写入新 run，并依次运行第 1、2 周。

- LLM 配置同 GUI「载入 private」：`data/private_llm_defaults.json`。
- 缺失或空配置时退化为 Stub（种子抽取会失败或不可用，周次亦可能不完整）。

在项目根目录（GameDraft）执行::

    python -m tools.chronicle_sim.temp_main_flow_smoke

可选环境变量::

    CHRONICLE_LEGACY_MD=1 — 生成种子时附加项目根旧版 .md 列表（与 GUI 勾选一致）
    CHRONICLE_SMOKE_CLEANUP=1 — 结束后删除本次 run 目录

用完可删除本文件。
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path

from tools.chronicle_sim.core.agents.initializer_agent import InitializerAgent
from tools.chronicle_sim.core.llm.client_factory import ClientFactory
from tools.chronicle_sim.core.llm.config_resolve import provider_profile_for_agent
from tools.chronicle_sim.core.llm.private_defaults import load_private_llm_defaults
from tools.chronicle_sim.core.runtime.agent_state import AgentState
from tools.chronicle_sim.core.runtime.event_bus import EventBus
from tools.chronicle_sim.core.runtime.history_buffer import HistoryBuffer
from tools.chronicle_sim.core.runtime.memory_store import MemoryStore
from tools.chronicle_sim.core.schema.models import NpcTier, SeedDraft
from tools.chronicle_sim.core.simulation.orchestrator import WeekOrchestrator
from tools.chronicle_sim.core.simulation.run_manager import create_run
from tools.chronicle_sim.core.simulation.seed_apply import apply_seed_draft, set_agent_tier
from tools.chronicle_sim.core.storage.db import Database, init_schema


def _normalize_llm_config(raw: dict) -> dict:
    out = dict(raw)
    sem = out.get("semantic_memory")
    if not isinstance(sem, dict):
        out["semantic_memory"] = {"strict": False}
    if "default" not in out or not isinstance(out.get("default"), dict):
        out["default"] = {"kind": "stub", "model": "stub"}
    return out


def _build_llm_config() -> dict:
    raw = load_private_llm_defaults()
    if not raw:
        print("[冒烟] 未找到 private_llm_defaults.json 或为空，使用全 Stub（不访问网络）。")
        return _normalize_llm_config({})
    print("[冒烟] 已加载 private_llm_defaults.json，使用其中配置（default 槽为默认网关）。")
    print("[冒烟] default 摘要:", json.dumps(raw.get("default", {}), ensure_ascii=False)[:500])
    return _normalize_llm_config(raw)


def _apply_suggested_tiers(conn: sqlite3.Connection, draft: SeedDraft) -> None:
    """按种子 suggested_tier 设置 initial/current，便于 S/A/B 走对应 LLM 槽位。"""
    for a in draft.agents:
        aid = str(a.get("id") or "").strip()
        if not aid:
            continue
        st = str(a.get("suggested_tier") or "B").strip().upper()
        if st == "S":
            set_agent_tier(conn, aid, NpcTier.S)
        elif st == "A":
            set_agent_tier(conn, aid, NpcTier.A)
        else:
            set_agent_tier(conn, aid, NpcTier.B)


async def _run() -> int:
    llm_cfg = _build_llm_config()
    legacy = os.environ.get("CHRONICLE_LEGACY_MD", "").strip().lower() in ("1", "true", "yes")
    run_id, run_dir = create_run("temp_main_flow_smoke_md", total_weeks=8, llm_config=llm_cfg)
    print(f"[冒烟] run_id={run_id} 目录={run_dir}")

    db_path = run_dir / "run.db"
    prof = provider_profile_for_agent("initializer", llm_cfg)
    llm = ClientFactory.build_for_agent("initializer", prof, llm_cfg, run_dir=run_dir)

    def _log(msg: str) -> None:
        print(f"[种子] {msg}")

    try:
        mem_conn = sqlite3.connect(":memory:")
        init_schema(mem_conn)
        init = InitializerAgent(
            llm,
            MemoryStore(mem_conn, "initializer"),
            HistoryBuffer(),
            AgentState(),
            EventBus(),
        )
        if legacy:
            _log("已设 CHRONICLE_LEGACY_MD：附加项目根旧版 .md")
        _log("正在从 MD 库调用 LLM 抽取种子…")
        draft = await init.run_extraction(
            target_npc_count=32,
            use_legacy_project_blueprints=legacy,
            progress_log=_log,
        )
    finally:
        await llm.aclose()

    (run_dir / "seed_from_md.json").write_text(draft.model_dump_json(indent=2), encoding="utf-8")
    print(f"[冒烟] 种子已写入 {run_dir / 'seed_from_md.json'}")

    db = Database(db_path)
    try:
        apply_seed_draft(db.conn, draft)
        _apply_suggested_tiers(db.conn, draft)
        db.conn.commit()

        def _week_log(msg: str) -> None:
            print(f"[周次] {msg}")

        orch = WeekOrchestrator(db, run_dir, llm_cfg, progress_log=_week_log)
        r1 = await orch.run_week(1)
        print("[冒烟] run_week(1) 完成:", json.dumps(r1, ensure_ascii=False)[:2000])
        r2 = await orch.run_week(2)
        print("[冒烟] run_week(2) 完成:", json.dumps(r2, ensure_ascii=False)[:2000])
    finally:
        db.close()

    if os.environ.get("CHRONICLE_SMOKE_CLEANUP", "").strip() in ("1", "true", "yes"):
        shutil.rmtree(run_dir, ignore_errors=True)
        print(f"[冒烟] 已删除 {run_dir}（CHRONICLE_SMOKE_CLEANUP 已设）")
    else:
        print(f"[冒烟] 保留 run 目录便于检查；删除请设 CHRONICLE_SMOKE_CLEANUP=1")
    return 0


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    asyncio.run(_run())


if __name__ == "__main__":
    raise SystemExit(main())
