"""周模拟统一入口：CLI 与 GUI 共用同一异步流程，LLM 配置仅从磁盘读取。

``run_dir/config/llm_config.json`` 为唯一配置源；不在此模块缓存表单或内存快照。
"""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Callable

from tools.chronicle_sim_v2.core.sim.orchestrator import WeekOrchestrator


async def run_week_async(
    run_dir: Path,
    week: int,
    *,
    progress_log: Callable[[str], None] | None = None,
    cancel_flag: threading.Event | None = None,
) -> dict[str, Any]:
    """运行单周模拟；编排器在内部每次需要时从磁盘加载 LLM 配置。"""
    orch = WeekOrchestrator(
        run_dir.resolve(),
        cancel_flag=cancel_flag,
        progress_log=progress_log,
    )
    return await orch.run_week(week)
