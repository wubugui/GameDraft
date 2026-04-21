"""与 GUI「从设定库生成种子」同一路径：聚合 ideas → build_initializer_pa → run_initializer。

用法（在 GameDraft 根目录，cmd）::

    set PYTHONPATH=%CD%
    python tools\\chronicle_sim_v2\\scripts\\run_initializer_once.py <run_dir>
    python tools\\chronicle_sim_v2\\scripts\\run_initializer_once.py <run_dir> --stub

``--stub``：不调用 Cline，用内置 Stub 生成占位 SeedDraft（CI/无密钥验证链路）。

与界面一致会调用 ``ensure_mcp_for_run``；结束后打印 SeedDraft JSON 顶层键摘要。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path


async def _main() -> int:
    ap = argparse.ArgumentParser(description="从设定库跑 initializer（与 GUI 同路径）")
    ap.add_argument("run_dir", type=Path, help="Run 目录（含 ideas/、config/llm_config.json）")
    ap.add_argument(
        "--stub",
        action="store_true",
        help="强制 default 槽位为 stub，不调用 Cline（占位 JSON）",
    )
    args = ap.parse_args()
    run_dir = args.run_dir.resolve()
    if not run_dir.is_dir():
        print(f"not a directory: {run_dir}", file=sys.stderr)
        return 1

    from tools.chronicle_sim_v2.core.llm.cline_workspace import ensure_mcp_for_run
    from tools.chronicle_sim_v2.core.world.fs import read_json
    from tools.chronicle_sim_v2.core.world.idea_library import build_ideas_blob, list_ideas

    llm_path = run_dir / "config" / "llm_config.json"
    if not llm_path.is_file():
        print(f"missing {llm_path}", file=sys.stderr)
        return 1
    llm_config = read_json(run_dir, "config/llm_config.json")
    if not isinstance(llm_config, dict):
        print("llm_config must be a JSON object", file=sys.stderr)
        return 1

    if args.stub:
        llm_config = {**llm_config, "default": {"kind": "stub", "model": ""}}

    default_cfg = llm_config.get("default", {})
    if not isinstance(default_cfg, dict):
        default_cfg = {}
    kind = str(default_cfg.get("kind", "")).lower()
    if kind in ("", "stub") and not args.stub:
        print(
            "default.kind is stub/empty; configure LLM in config/llm_config.json，或加 --stub",
            file=sys.stderr,
        )
        return 1

    ideas = list_ideas(run_dir)
    if not ideas:
        print("ideas library empty (ideas/manifest.json + md)", file=sys.stderr)
        return 1

    ensure_mcp_for_run(run_dir)

    ideas_blob = build_ideas_blob(run_dir)
    print(f"[initializer] run_dir={run_dir}", file=sys.stderr)
    print(f"[initializer] ideas_blob_len={len(ideas_blob)}", file=sys.stderr)

    from tools.chronicle_sim_v2.core.agents.initializer_agent import (
        build_initializer_pa,
        run_initializer,
    )

    pa = build_initializer_pa(llm_config, run_dir)

    def _log(msg: str) -> None:
        print(msg, file=sys.stderr)

    try:
        result = await run_initializer(pa, run_dir, ideas_blob, log_callback=_log)
    finally:
        await pa.aclose()

    if not isinstance(result, dict):
        print(f"unexpected result type: {type(result)}", file=sys.stderr)
        return 1

    keys = sorted(result.keys())
    print(f"[initializer] ok top_level_keys={keys}", file=sys.stderr)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
