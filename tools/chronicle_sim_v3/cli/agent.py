"""csim agent * —— Agent 业务入口（路由 / 调用 / 用量 / 审计 / 缓存）。

把 ProviderService + LLMService（按需）+ AgentService 装好；
test 子命令端到端跑一次 AgentService.run（业务唯一入口）。
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import typer

from tools.chronicle_sim_v3.agents.errors import AgentError
from tools.chronicle_sim_v3.agents.service import AgentService
from tools.chronicle_sim_v3.agents.types import AgentRef, AgentTask
from tools.chronicle_sim_v3.providers.errors import ProviderError
from tools.chronicle_sim_v3.providers.service import ProviderService

app = typer.Typer(no_args_is_help=True, help="Agent 路由 / 调用 / 用量 / 审计")


def _build(run: Path) -> tuple[AgentService, ProviderService]:
    run = run.resolve()
    provider_service = ProviderService(run)
    llm_service = None
    if (run / "config" / "llm.yaml").is_file():
        from tools.chronicle_sim_v3.llm.service import LLMService

        llm_service = LLMService(run, provider_service, spec_search_root=run)
    svc = AgentService(
        run,
        provider_service=provider_service,
        llm_service=llm_service,
        spec_search_root=run,
    )
    return svc, provider_service


def _parse_vars(items: list[str]) -> dict:
    out: dict = {}
    for it in items:
        if "=" not in it:
            continue
        k, _, v = it.partition("=")
        k = k.strip()
        v = v.strip()
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


@app.command("list")
def list_agents(
    run: Path = typer.Option(Path("."), "--run", help="Run 目录"),
) -> None:
    """列出 agents.yaml 中注册的所有 agent。"""
    svc, _ = _build(run)
    for name, info in svc.list_agents().items():
        provider = info["provider"] or "-"
        route = info["llm_route"] or "-"
        typer.echo(
            f"{name}: runner={info['runner']} provider={provider} "
            f"llm_route={route} model={info['model_id'] or '-'} "
            f"timeout={info['timeout_sec']}s"
        )


@app.command("show")
def show_agent(
    agent_id: str = typer.Argument(..., help="agent_id（agents.yaml 中物理名）"),
    run: Path = typer.Option(Path("."), "--run", help="Run 目录"),
) -> None:
    """展开 agent 配置（脱敏；不显示 raw key）。"""
    svc, _ = _build(run)
    try:
        resolved = svc.resolve_route(agent_id)
    except AgentError as e:
        typer.echo(f"ERROR: {e}", err=True)
        raise typer.Exit(2) from e
    body = {
        "logical": resolved.logical,
        "physical": resolved.physical,
        "runner_kind": resolved.runner_kind,
        "provider_id": resolved.provider_id,
        "llm_route": resolved.llm_route,
        "model_id": resolved.model_id,
        "timeout_sec": resolved.timeout_sec,
        "agent_hash": resolved.agent_hash,
        "config_keys": sorted((resolved.config or {}).keys()),
    }
    typer.echo(json.dumps(body, ensure_ascii=False, indent=2))


@app.command("test")
def test_agent(
    agent_id: str = typer.Option(..., "--agent", help="逻辑 agent id"),
    spec: str = typer.Option(..., "--spec", help="agent_spec TOML 路径"),
    var: list[str] = typer.Option([], "--var", help="vars k=v；可重复"),
    output: str = typer.Option("text", "--output", help="text|json_object|json_array|jsonl"),
    cache: str = typer.Option("auto", "--cache", help="auto|off|hash|exact"),
    role: str = typer.Option("test", "--role"),
    artifact_filename: str = typer.Option("", "--artifact-filename"),
    timeout: int | None = typer.Option(None, "--timeout"),
    run: Path = typer.Option(Path("."), "--run", help="Run 目录"),
) -> None:
    """端到端跑一次 agent；打印 text / runner_kind / cache_hit / llm_calls_count。"""
    svc, _ = _build(run)
    ref = AgentRef(
        agent=agent_id, role=role, output_kind=output,
        artifact_filename=artifact_filename, cache=cache, timeout_sec=timeout,
    )
    task = AgentTask(spec_ref=spec, vars=_parse_vars(var))
    try:
        result = asyncio.run(svc.run(ref, task))
    except (AgentError, ProviderError) as e:
        typer.echo(f"ERROR: {type(e).__name__}: {e}", err=True)
        raise typer.Exit(1) from e
    body = {
        "text": result.text,
        "runner_kind": result.runner_kind,
        "physical_agent": result.physical_agent,
        "cache_hit": result.cache_hit,
        "exit_code": result.exit_code,
        "agent_run_id": result.agent_run_id,
        "audit_id": result.audit_id,
        "llm_calls_count": result.llm_calls_count,
        "timings": result.timings,
    }
    typer.echo(json.dumps(body, ensure_ascii=False, indent=2))


route_app = typer.Typer(no_args_is_help=True, help="逻辑路由名映射")
app.add_typer(route_app, name="route")


@route_app.command("show")
def route_show(
    run: Path = typer.Option(Path("."), "--run", help="Run 目录"),
) -> None:
    svc, _ = _build(run)
    for logical, physical in sorted(svc.list_routes().items()):
        typer.echo(f"{logical}: {physical}")


@route_app.command("set")
def route_set(
    logical: str = typer.Argument(..., help="逻辑名"),
    physical: str = typer.Argument(..., help="物理 agent_id"),
    run: Path = typer.Option(Path("."), "--run", help="Run 目录"),
) -> None:
    """改写 routes 是 yaml 操作，CLI 不直接动盘；提示用户编辑 agents.yaml。"""
    typer.echo(
        f"请编辑 {run}/config/agents.yaml 的 routes：\n  {logical}: {physical}",
        err=True,
    )
    raise typer.Exit(0)


@app.command("usage")
def usage(
    run: Path = typer.Option(Path("."), "--run", help="Run 目录"),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """打印 in-process usage 统计。

    注意：usage 只在 csim agent test 期间累计；跨进程不持久化。
    """
    svc, _ = _build(run)
    snap = svc.usage.snapshot()
    if json_out:
        typer.echo(json.dumps(snap, ensure_ascii=False, indent=2))
        return
    for agent_id, stats in sorted(snap.items()):
        typer.echo(
            f"{agent_id}: calls={stats['calls']} cache_hits={stats['cache_hits']} "
            f"errors={stats['errors']} total_ms={stats['total_ms']} "
            f"llm_calls={stats['llm_calls_total']}"
        )


audit_app = typer.Typer(no_args_is_help=True, help="agent 审计文件查看")
app.add_typer(audit_app, name="audit")


@audit_app.command("tail")
def audit_tail(
    n: int = typer.Option(20, "--n"),
    run: Path = typer.Option(Path("."), "--run", help="Run 目录"),
) -> None:
    base = run.resolve() / "audit" / "agents"
    if not base.exists():
        typer.echo("(no audit yet)")
        return
    files = sorted(base.glob("*.jsonl"))
    if not files:
        typer.echo("(no audit yet)")
        return
    target = files[-1]
    lines = target.read_text(encoding="utf-8").splitlines()
    for ln in lines[-n:]:
        typer.echo(ln)


cache_app = typer.Typer(no_args_is_help=True, help="agent cache stats / clear / invalidate")
app.add_typer(cache_app, name="cache")


@cache_app.command("stats")
def cache_stats(
    run: Path = typer.Option(Path("."), "--run", help="Run 目录"),
) -> None:
    svc, _ = _build(run)
    typer.echo(json.dumps(svc.cache.stats(), ensure_ascii=False, indent=2))


@cache_app.command("clear")
def cache_clear(
    run: Path = typer.Option(Path("."), "--run", help="Run 目录"),
) -> None:
    svc, _ = _build(run)
    n = svc.cache.clear()
    typer.echo(f"cleared={n}")


@cache_app.command("invalidate")
def cache_invalidate(
    agent_id: str = typer.Argument(..., help="物理 agent_id"),
    run: Path = typer.Option(Path("."), "--run", help="Run 目录"),
) -> None:
    svc, _ = _build(run)
    n = svc.cache.invalidate_by_agent(agent_id)
    typer.echo(f"invalidated={n}")
