"""csim llm * ?? ?? / ?? / ?? / ???????????

?????? csim agent test???????? LLM ????????
Agent ????? limiter / cache / audit?agent-level ????
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import typer

from tools.chronicle_sim_v3.llm.service import LLMService
from tools.chronicle_sim_v3.llm.types import LLMRef, OutputSpec, Prompt
from tools.chronicle_sim_v3.providers.service import ProviderService

app = typer.Typer(
    no_args_is_help=True,
    help="LLM ?? / ?? / ?? / ?????????????? csim agent test?",
)


def _build_llm_service(run_dir: Path) -> LLMService:
    """?? ProviderService???? LLMService?"""
    provider_service = ProviderService(run_dir)
    return LLMService(run_dir, provider_service, spec_search_root=run_dir)


route_app = typer.Typer(no_args_is_help=True, help="LLM ???? / ??")
audit_app = typer.Typer(no_args_is_help=True, help="LLM ????")
cache_app = typer.Typer(no_args_is_help=True, help="LLM ????")
app.add_typer(route_app, name="route")
app.add_typer(audit_app, name="audit")
app.add_typer(cache_app, name="cache")


@app.command("test")
def test(
    prompt: str = typer.Option(..., "--prompt", help="user ???inline spec?"),
    model: str = typer.Option("offline", "--model", help="???? id?routes ?? key?"),
    run: Path = typer.Option(Path("."), "--run", help="Run ??"),
    role: str = typer.Option("test", "--role", help="audit role ??"),
    output_kind: str = typer.Option("text", "--output", help="text|json_object|json_array|jsonl"),
) -> None:
    """? inline spec ??? chat??????"""
    typer.echo(
        "[debug] csim llm test ???? LLM ??????? csim agent test",
        err=True,
    )
    svc = _build_llm_service(run.resolve())
    ref = LLMRef(role=role, model=model, output=OutputSpec(kind=output_kind))  # type: ignore[arg-type]
    pmt = Prompt(spec_ref="_inline", vars={"__system": "????", "__user": prompt})

    async def _go():
        try:
            return await svc.chat(ref, pmt)
        finally:
            await svc.aclose()

    result = asyncio.run(_go())
    typer.echo(result.text)


@app.command("test-emb")
def test_emb(
    texts: str = typer.Option(..., "--texts", help="?????????"),
    model: str = typer.Option("embed", "--model", help="?? embed ?? id"),
    run: Path = typer.Option(Path("."), "--run", help="Run ??"),
) -> None:
    """? embed ??????????"""
    svc = _build_llm_service(run.resolve())
    arr = [s for s in (t.strip() for t in texts.split(",")) if s]

    async def _go():
        try:
            return await svc.embed(model, arr)
        finally:
            await svc.aclose()

    out = asyncio.run(_go())
    for i, v in enumerate(out):
        typer.echo(f"#{i} dim={len(v)} head={v[:3]}")


@route_app.command("show")
def route_show(
    run: Path = typer.Option(Path("."), "--run", help="Run ??"),
) -> None:
    """?? routes ????? ? ????"""
    svc = _build_llm_service(run.resolve())
    for logical, physical in svc.list_routes().items():
        typer.echo(f"{logical:>10s}  ?  {physical}")


@route_app.command("set")
def route_set(
    logical: str = typer.Argument(..., help="???? id"),
    physical: str = typer.Argument(..., help="?? model id???? models ??"),
    run: Path = typer.Option(Path("."), "--run", help="Run ??"),
) -> None:
    """?? llm.yaml ?? routes[logical]?"""
    from ruamel.yaml import YAML

    p = (run / "config" / "llm.yaml").resolve()
    if not p.is_file():
        typer.echo(f"llm.yaml ???: {p}", err=True)
        raise typer.Exit(code=1)
    yaml = YAML(typ="rt")
    data = yaml.load(p.read_text(encoding="utf-8"))
    if "models" not in data or physical not in data["models"]:
        typer.echo(f"?????? model id: {physical}", err=True)
        raise typer.Exit(code=1)
    routes = data.setdefault("routes", {})
    routes[logical] = physical
    from io import StringIO

    buf = StringIO()
    yaml.dump(data, buf)
    p.write_text(buf.getvalue(), encoding="utf-8")
    typer.echo(f"??? {logical} ? {physical}")


@app.command("models")
def models(
    run: Path = typer.Option(Path("."), "--run", help="Run ??"),
) -> None:
    svc = _build_llm_service(run.resolve())
    for name, m in svc.list_models().items():
        typer.echo(
            f"{name}: provider={m['provider']} invocation={m['invocation']} "
            f"model_id={m['model_id']}"
        )


@app.command("usage")
def usage(
    run: Path = typer.Option(Path("."), "--run", help="Run ??"),
) -> None:
    svc = _build_llm_service(run.resolve())
    by = svc.usage.stats.by_route
    if not by:
        typer.echo("(????)")
        return
    for route, s in by.items():
        typer.echo(
            f"{route}: calls={s.calls} cache_hits={s.cache_hits} "
            f"tokens_in={s.tokens_in} tokens_out={s.tokens_out} "
            f"latency_ms={s.latency_ms_total} errors={s.errors}"
        )


@audit_app.command("tail")
def audit_tail(
    n: int = typer.Option(20, "-n", "--n", help="?? N ?"),
    run: Path = typer.Option(Path("."), "--run", help="Run ??"),
) -> None:
    svc = _build_llm_service(run.resolve())
    for ev in svc.audit.tail(n):
        typer.echo(json.dumps(ev, ensure_ascii=False))


@audit_app.command("show")
def audit_show(
    audit_id: str = typer.Argument(..., help="audit_id?ULID?"),
    run: Path = typer.Option(Path("."), "--run", help="Run ??"),
) -> None:
    svc = _build_llm_service(run.resolve())
    matched = [ev for ev in svc.audit.tail(10000) if ev.get("audit_id") == audit_id]
    if not matched:
        typer.echo(f"??? audit_id={audit_id}", err=True)
        raise typer.Exit(code=1)
    for ev in matched:
        typer.echo(json.dumps(ev, ensure_ascii=False, indent=2))


@cache_app.command("stats")
def cache_stats(run: Path = typer.Option(Path("."), "--run", help="Run ??")) -> None:
    svc = _build_llm_service(run.resolve())
    s = svc.cache.stats()
    typer.echo(f"chat={s['chat']} embed={s['embed']}")


@cache_app.command("clear")
def cache_clear(run: Path = typer.Option(Path("."), "--run", help="Run ??")) -> None:
    svc = _build_llm_service(run.resolve())
    n = svc.cache.clear()
    typer.echo(f"??? {n} ? LLM cache ??")


@cache_app.command("invalidate")
def cache_invalidate(
    route: str = typer.Argument(..., help="???? id?? route ???chat ?????"),
    run: Path = typer.Option(Path("."), "--run", help="Run ??"),
) -> None:
    """? route ???chat ????? route_hash ?????"""
    svc = _build_llm_service(run.resolve())
    rh = svc.resolve_route(route).route_hash
    base = svc.cache.base / "chat"
    n = 0
    if base.exists():
        for f in base.rglob("*.json"):
            try:
                d = json.loads(f.read_text(encoding="utf-8"))
                if d.get("route_hash") == rh:
                    f.unlink()
                    n += 1
            except Exception:
                continue
    typer.echo(f"??? route={route} ? {n} ? chat ??")
