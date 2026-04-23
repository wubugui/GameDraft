"""csim CLI 总入口。

子命令在各自模块（cli.run / cli.llm 等）以 typer.Typer 子 app 形式注册，
本文件只负责装配与版本号；保持极薄，避免在导入期出现昂贵 IO。
"""
from __future__ import annotations

import typer

from tools.chronicle_sim_v3 import __version__

app = typer.Typer(
    name="csim",
    add_completion=False,
    help="ChronicleSim v3 — 图驱动的编年史模拟器（CLI）",
    no_args_is_help=True,
)


def _version_callback(value: bool) -> None:
    if value:
        typer.echo(f"csim {__version__}")
        raise typer.Exit()


@app.callback()
def _root(
    version: bool = typer.Option(
        False,
        "--version",
        callback=_version_callback,
        is_eager=True,
        help="显示版本号并退出。",
    ),
) -> None:
    """csim 顶层入口。"""


# 子命令在导入时挂载；放在末尾避免循环 import。
from tools.chronicle_sim_v3.cli import run as _run_mod  # noqa: E402
from tools.chronicle_sim_v3.cli import llm as _llm_mod  # noqa: E402
from tools.chronicle_sim_v3.cli import cook as _cook_mod  # noqa: E402
from tools.chronicle_sim_v3.cli import graph as _graph_mod  # noqa: E402
from tools.chronicle_sim_v3.cli import node as _node_mod  # noqa: E402
from tools.chronicle_sim_v3.cli import provider as _provider_mod  # noqa: E402
from tools.chronicle_sim_v3.cli import agent as _agent_mod  # noqa: E402

app.add_typer(_run_mod.app, name="run", help="Run 目录管理")
app.add_typer(_provider_mod.app, name="provider", help="Provider 管理与 ping")
app.add_typer(_llm_mod.app, name="llm", help="LLM 路由（开发调试入口）")
app.add_typer(_agent_mod.app, name="agent", help="Agent 路由 / 调用 / 用量 / 审计")
app.add_typer(_cook_mod.app, name="cook", help="Cook 执行与管理")
app.add_typer(_graph_mod.app, name="graph", help="Graph 文件管理与校验")
app.add_typer(_node_mod.app, name="node", help="Node 注册表查询")
