"""csim node *  —  list / show / docs。"""
from __future__ import annotations

import typer

app = typer.Typer(no_args_is_help=True, help="Node 注册表查询")


def _ensure_registry():
    import tools.chronicle_sim_v3.nodes  # noqa: F401


@app.command("list")
def list_cmd(
    category: str | None = typer.Option(None, "--category"),
) -> None:
    _ensure_registry()
    from tools.chronicle_sim_v3.engine.registry import all_specs

    specs = all_specs()
    if category:
        specs = [s for s in specs if s.category == category]
    for s in specs:
        typer.echo(f"{s.kind}  ({s.category})  v{s.version}  cacheable={s.cacheable}")


@app.command("show")
def show_cmd(kind: str = typer.Argument(..., help="NodeKind id")) -> None:
    _ensure_registry()
    from tools.chronicle_sim_v3.engine.registry import get_node_class

    s = get_node_class(kind).spec
    typer.echo(f"# {s.kind}  ({s.category})")
    typer.echo(f"title:       {s.title}")
    typer.echo(f"version:     {s.version}")
    typer.echo(f"cacheable:   {s.cacheable}    deterministic: {s.deterministic}")
    typer.echo(f"description: {s.description}")
    if s.inputs:
        typer.echo("inputs:")
        for p in s.inputs:
            typer.echo(f"  - {p.name}: {p.type}{' (multi)' if p.multi else ''}{'' if p.required else ' [optional]'}")
    if s.outputs:
        typer.echo("outputs:")
        for p in s.outputs:
            typer.echo(f"  - {p.name}: {p.type}")
    if s.params:
        typer.echo("params:")
        for p in s.params:
            extra = f" enum={list(p.enum_values)}" if p.enum_values else ""
            typer.echo(f"  - {p.name}: {p.type}{'' if p.required else ' [optional, default=' + repr(p.default) + ']'}{extra}")
    if s.reads:
        typer.echo(f"reads:  {sorted(s.reads)}")
    if s.writes:
        typer.echo(f"writes: {sorted(s.writes)}")


@app.command("docs")
def docs_cmd(
    kind: str = typer.Argument(...),
    md: bool = typer.Option(False, "--md"),
) -> None:
    """打印节点 markdown 文档（占位实现：基于 spec）。"""
    _ensure_registry()
    from tools.chronicle_sim_v3.engine.registry import get_node_class

    s = get_node_class(kind).spec
    if md:
        typer.echo(f"# `{s.kind}` ({s.category})")
        typer.echo("")
        typer.echo(s.description)
        typer.echo("")
        if s.inputs:
            typer.echo("**Inputs**")
            for p in s.inputs:
                typer.echo(f"- `{p.name}`: `{p.type}`")
            typer.echo("")
        if s.outputs:
            typer.echo("**Outputs**")
            for p in s.outputs:
                typer.echo(f"- `{p.name}`: `{p.type}`")
            typer.echo("")
        if s.params:
            typer.echo("**Params**")
            for p in s.params:
                typer.echo(f"- `{p.name}`: `{p.type}`")
            typer.echo("")
    else:
        # 复用 show
        show_cmd(kind)
