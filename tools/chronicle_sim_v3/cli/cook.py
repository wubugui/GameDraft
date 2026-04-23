"""csim cook *  —  cook 执行 / 列举 / 时间线 / 输出。

P1 范围：run / list / show / cancel / resume / timeline / output / inputs / artifact
（branch / gc 留 P5）
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import typer

from tools.chronicle_sim_v3.engine.cancel import CancelToken
from tools.chronicle_sim_v3.engine.cook import CookManager
from tools.chronicle_sim_v3.engine.engine import Engine
from tools.chronicle_sim_v3.engine.graph import GraphLoader
from tools.chronicle_sim_v3.engine.services import EngineServices

app = typer.Typer(no_args_is_help=True, help="Cook 执行与管理")


def _parse_inputs(items: list[str]) -> dict:
    """k=v 列表 → dict；自动按字面量推断 int/bool/json。"""
    out: dict = {}
    for it in items:
        if "=" not in it:
            continue
        k, _, v = it.partition("=")
        k = k.strip()
        v = v.strip()
        # 尝试 int / bool / json
        if v.lower() in ("true", "false"):
            out[k] = v.lower() == "true"
        elif v.lstrip("-").isdigit():
            out[k] = int(v)
        else:
            try:
                out[k] = json.loads(v)
            except Exception:
                out[k] = v
    return out


def _build_engine(run_dir: Path) -> Engine:
    """按需构造三层服务并注入 EngineServices.agents。

    依赖装配顺序（最底 → 最顶）：
        ProviderService  →  LLMService  →  AgentService
    业务节点只见 services.agents；llm/provider 是内部依赖。
    """
    services = EngineServices(spec_search_root=run_dir)

    has_providers = (run_dir / "config" / "providers.yaml").is_file()
    has_llm = (run_dir / "config" / "llm.yaml").is_file()
    has_agents = (run_dir / "config" / "agents.yaml").is_file()

    provider_service = None
    if has_providers:
        try:
            from tools.chronicle_sim_v3.providers.service import ProviderService

            provider_service = ProviderService(run_dir)
        except Exception as e:
            typer.echo(
                f"[warn] ProviderService 加载失败，agent/llm 节点不可用: {e}",
                err=True,
            )

    llm_service = None
    if has_llm:
        if provider_service is None:
            typer.echo(
                "[warn] llm.yaml 存在但 providers.yaml 缺失；LLMService 不可用",
                err=True,
            )
        else:
            try:
                from tools.chronicle_sim_v3.llm.service import LLMService

                llm_service = LLMService(
                    run_dir, provider_service, spec_search_root=run_dir
                )
            except Exception as e:
                typer.echo(
                    f"[warn] LLMService 加载失败，agent simple_chat/react 不可用: {e}",
                    err=True,
                )

    if has_agents:
        if provider_service is None:
            typer.echo(
                "[warn] agents.yaml 存在但 providers.yaml 缺失；AgentService 不可用",
                err=True,
            )
        else:
            try:
                from tools.chronicle_sim_v3.agents.service import AgentService

                services.agents = AgentService(
                    run_dir,
                    provider_service=provider_service,
                    llm_service=llm_service,
                    chroma=services.chroma,
                    spec_search_root=run_dir,
                )
            except Exception as e:
                typer.echo(
                    f"[warn] AgentService 加载失败，agent.* 节点不可用: {e}",
                    err=True,
                )

    services._llm = llm_service

    import tools.chronicle_sim_v3.nodes  # noqa: F401

    return Engine(run_dir, services)


@app.command("run")
def run(
    graph: Path = typer.Argument(..., help="graph yaml 路径"),
    run_dir: Path = typer.Option(..., "--run", help="Run 目录"),
    inputs: list[str] = typer.Option([], "--input", help="顶层输入 k=v；可重复"),
    cook_id: str | None = typer.Option(None, "--cook-id"),
    no_cache: bool = typer.Option(False, "--no-cache"),
    no_concurrency: bool = typer.Option(False, "--no-concurrency"),
    max_inflight: int = typer.Option(4, "--max-inflight"),
) -> None:
    """跑一次 cook；打印 cook_id / status / outputs。"""
    spec = GraphLoader().load(graph)
    eng = _build_engine(run_dir.resolve())
    parsed_inputs = _parse_inputs(inputs)

    async def _go():
        try:
            return await eng.run(
                spec, parsed_inputs,
                cook_id=cook_id,
                cancel=CancelToken(),
                cache_enabled=not no_cache,
                concurrency_enabled=not no_concurrency,
                max_inflight=max_inflight,
                graph_path=str(graph),
            )
        finally:
            if eng.services.agents:
                await eng.services.agents.aclose()
            if eng.services._llm:
                await eng.services._llm.aclose()

    res = asyncio.run(_go())
    typer.echo(f"cook_id: {res.cook_id}")
    typer.echo(f"status:  {res.status}")
    if res.failed_nodes:
        typer.echo(f"failed:  {res.failed_nodes}")
    typer.echo(f"outputs: {json.dumps(res.outputs, ensure_ascii=False)}")
    if res.status != "completed":
        raise typer.Exit(code=1)


@app.command("resume")
def resume_cmd(
    graph: Path = typer.Argument(..., help="graph yaml 路径"),
    cook_id: str = typer.Argument(..., help="要恢复的 cook id"),
    run_dir: Path = typer.Option(..., "--run"),
) -> None:
    spec = GraphLoader().load(graph)
    eng = _build_engine(run_dir.resolve())

    async def _go():
        try:
            return await eng.resume(cook_id, spec)
        finally:
            if eng.services.agents:
                await eng.services.agents.aclose()
            if eng.services._llm:
                await eng.services._llm.aclose()

    res = asyncio.run(_go())
    typer.echo(f"status: {res.status}")
    typer.echo(f"outputs: {json.dumps(res.outputs, ensure_ascii=False)}")


@app.command("list")
def list_cmd(
    run_dir: Path = typer.Option(..., "--run"),
    last: int = typer.Option(0, "--last", help="0 = 全部"),
) -> None:
    mgr = CookManager(run_dir.resolve())
    ids = mgr.list_cook_ids()
    if last:
        ids = ids[-last:]
    for cid in ids:
        cook = mgr.load(cid)
        try:
            state = cook.load_state()
            typer.echo(f"{cid}  status={state.status}  nodes={len(state.nodes)}")
        except FileNotFoundError:
            typer.echo(f"{cid}  (state 缺失)")


@app.command("show")
def show_cmd(
    cook_id: str = typer.Argument(...),
    run_dir: Path = typer.Option(..., "--run"),
) -> None:
    cook = CookManager(run_dir.resolve()).load(cook_id)
    typer.echo(json.dumps(cook.read_manifest(), ensure_ascii=False, indent=2))


@app.command("timeline")
def timeline_cmd(
    cook_id: str = typer.Argument(...),
    run_dir: Path = typer.Option(..., "--run"),
    n: int = typer.Option(0, "--n", help="0 = 全部"),
) -> None:
    cook = CookManager(run_dir.resolve()).load(cook_id)
    rows = cook.read_timeline(n=n if n > 0 else None)
    for ev in rows:
        typer.echo(json.dumps(ev, ensure_ascii=False))


@app.command("output")
def output_cmd(
    cook_id: str = typer.Argument(...),
    node_id: str = typer.Argument(...),
    run_dir: Path = typer.Option(..., "--run"),
    port: str | None = typer.Option(None, "--port"),
) -> None:
    cook = CookManager(run_dir.resolve()).load(cook_id)
    p = cook.dir / node_id / "output.json"
    if not p.is_file():
        typer.echo(f"output 不存在: {p}", err=True)
        raise typer.Exit(code=1)
    data = json.loads(p.read_text(encoding="utf-8"))
    if port:
        if port not in data:
            typer.echo(f"端口 {port!r} 不存在；可用：{sorted(data.keys())}", err=True)
            raise typer.Exit(code=1)
        typer.echo(json.dumps(data[port], ensure_ascii=False, indent=2))
    else:
        typer.echo(json.dumps(data, ensure_ascii=False, indent=2))


@app.command("inputs")
def inputs_cmd(
    cook_id: str = typer.Argument(...),
    node_id: str = typer.Argument(...),
    run_dir: Path = typer.Option(..., "--run"),
) -> None:
    cook = CookManager(run_dir.resolve()).load(cook_id)
    p = cook.dir / node_id / "inputs.json"
    if not p.is_file():
        typer.echo(f"inputs 不存在: {p}", err=True)
        raise typer.Exit(code=1)
    typer.echo(p.read_text(encoding="utf-8"))


@app.command("cancel")
def cancel_cmd(
    cook_id: str = typer.Argument(...),
    run_dir: Path = typer.Option(..., "--run"),
) -> None:
    """标记 state.status = cancelled（cook 进程外管理；P1 简化版）。"""
    cook = CookManager(run_dir.resolve()).load(cook_id)
    state = cook.load_state()
    state.status = "cancelled"
    cook.save_state(state)
    typer.echo(f"cook {cook_id} 已标记取消")


@app.command("artifact")
def artifact_cmd(
    cook_id: str = typer.Argument(...),
    node_id: str = typer.Argument(...),
    run_dir: Path = typer.Option(..., "--run"),
) -> None:
    """打印节点产物目录路径。"""
    cook = CookManager(run_dir.resolve()).load(cook_id)
    typer.echo(str(cook.dir / node_id))
