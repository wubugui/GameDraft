"""与 GUI「模拟」标签同一路径：按周调用 ``simulation_pipeline.run_week_async``。

在 GameDraft 根目录（cmd）::

    set PYTHONPATH=%CD%
    python tools\\chronicle_sim_v2\\scripts\\run_simulation_once.py <run_dir> --week 1
    python tools\\chronicle_sim_v2\\scripts\\run_simulation_once.py <run_dir> --from 1 --to 3

LLM 配置仅读取 ``<run_dir>\\config\\llm_config.json``；与界面一致会先 ``ensure_mcp_for_run``。
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="ChronicleSim v2：命令行周模拟（与 GUI 共用 simulation_pipeline）")
    ap.add_argument("run_dir", type=Path, help="Run 目录（含 config/llm_config.json）")
    ap.add_argument("--week", type=int, default=None, metavar="N", help="只运行第 N 周")
    ap.add_argument(
        "--from",
        dest="week_from",
        type=int,
        default=None,
        metavar="START",
        help="范围起点周（须与 --to 同时使用）",
    )
    ap.add_argument("--to", type=int, default=None, metavar="END", help="范围终点周（须与 --from 同时使用）")
    return ap.parse_args()


async def _main() -> int:
    args = _parse_args()
    run_dir = args.run_dir.resolve()
    if not run_dir.is_dir():
        print(f"not a directory: {run_dir}", file=sys.stderr)
        return 1
    cfg_path = run_dir / "config" / "llm_config.json"
    if not cfg_path.is_file():
        print(f"missing {cfg_path}", file=sys.stderr)
        return 1

    if args.week is not None:
        if args.week_from is not None or args.to is not None:
            print("use either --week N or --from/--to, not both", file=sys.stderr)
            return 2
        start = end = args.week
    elif args.week_from is not None and args.to is not None:
        start = args.week_from
        end = args.to
        if end < start:
            print("--to must be >= --from", file=sys.stderr)
            return 2
    else:
        print("specify --week N or both --from START and --to END", file=sys.stderr)
        return 2

    from tools.chronicle_sim_v2.core.llm.cline_workspace import ensure_mcp_for_run
    from tools.chronicle_sim_v2.core.sim.simulation_pipeline import run_week_async

    ensure_mcp_for_run(run_dir)

    def _log(msg: str) -> None:
        print(msg, flush=True)

    for w in range(start, end + 1):
        _log(f"\n===== week {w} =====")
        result = await run_week_async(run_dir, w, progress_log=_log)
        _log(f"week {w} done: {result}")
    _log("\nall done")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
