"""一次性：对已有 run 目录执行 run_week（用于复现/修复后验证）。

用法（在 GameDraft 根目录）:
  set PYTHONPATH=F:\GameDraft
  python tools/chronicle_sim/_replay_run_once.py [run_dir]

未传参则选 runs 下最近修改的含 run.db 的目录。
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.chronicle_sim.core.simulation.orchestrator import WeekOrchestrator
from tools.chronicle_sim.core.simulation.run_manager import open_database
from tools.chronicle_sim.paths import RUNS_DIR


def _pick_run_dir(arg: str | None) -> Path:
    if arg:
        p = Path(arg).resolve()
        if not (p / "run.db").is_file():
            raise SystemExit(f"无 run.db: {p}")
        return p
    cand: list[Path] = []
    for d in RUNS_DIR.iterdir():
        if d.is_dir() and (d / "run.db").is_file():
            cand.append(d)
    if not cand:
        raise SystemExit(f"runs 下无可用目录: {RUNS_DIR}")
    cand.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return cand[0]


async def main() -> int:
    run_dir = _pick_run_dir(sys.argv[1] if len(sys.argv) > 1 else None)
    db = open_database(run_dir)
    try:
        row = db.conn.execute("SELECT llm_config_json, current_week, total_weeks FROM runs LIMIT 1").fetchone()
        if not row:
            raise SystemExit("runs 表无记录")
        raw_cfg = row["llm_config_json"] or "{}"
        llm_cfg = json.loads(raw_cfg) if isinstance(raw_cfg, str) else dict(raw_cfg)
        cur = int(row["current_week"] or 0)
        total = int(row["total_weeks"] or 13)
        nxt = cur + 1
        if nxt > total:
            print(f"[replay] current_week={cur} total={total}，已完成全部周次，改为重跑第1 周做冒烟（可能重复写入）")
            nxt = 1
        else:
            print(f"[replay] run_dir={run_dir} current_week={cur} -> 将执行 week={nxt}")

        def log(m: str) -> None:
            print(m)

        orch = WeekOrchestrator(db, run_dir, llm_cfg, progress_log=log)
        out = await orch.run_week(nxt)
        print("[replay] 完成:", json.dumps(out, ensure_ascii=False)[:2000])
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
