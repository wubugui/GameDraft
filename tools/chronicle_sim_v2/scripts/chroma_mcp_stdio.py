"""Chroma 语义检索的 MCP stdio 服务（由 Cline 通过 cline_mcp_settings.json 启动）。

入口 argv：`--run-dir <绝对路径>`，无环境变量依赖。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_RUN_DIR: Path | None = None


def _run_dir() -> Path:
    if _RUN_DIR is None:
        raise RuntimeError("run_dir 尚未初始化（应由 main() 在 argparse 后注入）")
    return _RUN_DIR


def main() -> None:
    global _RUN_DIR

    parser = argparse.ArgumentParser(description="Chronicle chroma MCP stdio server")
    parser.add_argument(
        "--run-dir",
        required=True,
        help="Run 根目录的绝对路径（由 cline_mcp_settings.json args 注入）",
    )
    ns, _ = parser.parse_known_args()
    run_dir = Path(ns.run_dir).expanduser().resolve()
    if not run_dir.is_dir():
        raise SystemExit(f"--run-dir 指向的目录不存在：{run_dir}")
    _RUN_DIR = run_dir

    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError:
        print("缺少依赖 mcp，请执行: pip install mcp", file=sys.stderr)
        raise SystemExit(1) from None

    app = FastMCP("chronicle_sim")

    @app.tool()
    def chroma_search_world(query: str, n_results: int = 5) -> str:
        """语义检索已索引的世界内容（事件/总结/谣言等）。"""
        from tools.chronicle_sim_v2.core.world import chroma as chroma_mod

        rd = _run_dir()
        rows = chroma_mod.search_world(rd, query, max(1, min(int(n_results), 50)))
        return json.dumps(rows, ensure_ascii=False)

    @app.tool()
    def chroma_search_ideas(query: str, n_results: int = 5) -> str:
        """语义检索设定库 MD（ideas 索引）。"""
        from tools.chronicle_sim_v2.core.world import chroma as chroma_mod

        rd = _run_dir()
        rows = chroma_mod.search_ideas(rd, query, max(1, min(int(n_results), 50)))
        return json.dumps(rows, ensure_ascii=False)

    app.run(transport="stdio")


if __name__ == "__main__":
    main()
