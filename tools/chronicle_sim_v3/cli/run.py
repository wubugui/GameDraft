"""csim run *  —  Run 目录管理。

Run 目录布局（RFC v3-engine.md §3.2 子集；P0 只建 meta + config）：
  <run>/
    meta.json
    config/
      llm.yaml
      cook.yaml
"""
from __future__ import annotations

import datetime as _dt
import json
import shutil
import uuid
from pathlib import Path

import typer

from tools.chronicle_sim_v3.engine.io import atomic_write_json

app = typer.Typer(no_args_is_help=True, help="Run 目录管理")

_TEMPLATES = Path(__file__).resolve().parents[1] / "data" / "templates"


def _utcnow_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat() + "Z"


def _run_meta(name: str) -> dict:
    return {
        "run_id": uuid.uuid4().hex,
        "name": name,
        "created_at": _utcnow_iso(),
        "engine_format_ver": "1",
        "graph_default": "",
    }


@app.command("init")
def init(
    run_dir: Path = typer.Argument(..., help="Run 目录（不存在会被创建）"),
    name: str = typer.Option(..., "--name", help="Run 显示名"),
    force: bool = typer.Option(False, "--force", help="若目录已存在则覆盖 meta.json"),
) -> None:
    """初始化一个新 Run 目录：建 meta.json + config/{llm,cook}.yaml。"""
    run_dir = run_dir.resolve()
    cfg_dir = run_dir / "config"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    meta_path = run_dir / "meta.json"
    if meta_path.is_file() and not force:
        typer.echo(f"已存在: {meta_path}（用 --force 覆盖）", err=True)
        raise typer.Exit(code=1)
    atomic_write_json(meta_path, _run_meta(name))
    llm_yaml = cfg_dir / "llm.yaml"
    if not llm_yaml.is_file() or force:
        shutil.copyfile(_TEMPLATES / "llm.example.yaml", llm_yaml)
    cook_yaml = cfg_dir / "cook.yaml"
    if not cook_yaml.is_file() or force:
        shutil.copyfile(_TEMPLATES / "cook.example.yaml", cook_yaml)
    typer.echo(f"Run 已初始化: {run_dir}")


@app.command("list")
def list_runs(
    parent: Path = typer.Argument(Path("runs"), help="Run 父目录"),
) -> None:
    """列出 parent 下所有 Run（按创建时间）。"""
    parent = parent.resolve()
    if not parent.is_dir():
        typer.echo(f"父目录不存在: {parent}", err=True)
        raise typer.Exit(code=1)
    rows: list[tuple[str, str, str]] = []
    for child in sorted(parent.iterdir()):
        meta = child / "meta.json"
        if meta.is_file():
            try:
                m = json.loads(meta.read_text(encoding="utf-8"))
                rows.append((child.name, m.get("name", ""), m.get("created_at", "")))
            except Exception:
                rows.append((child.name, "(meta error)", ""))
    if not rows:
        typer.echo("(空)")
        return
    width = max(len(r[0]) for r in rows)
    for d, n, t in rows:
        typer.echo(f"{d.ljust(width)}  {n}  {t}")


@app.command("show")
def show(run_dir: Path = typer.Argument(..., help="Run 目录")) -> None:
    meta = run_dir / "meta.json"
    if not meta.is_file():
        typer.echo(f"meta 不存在: {meta}", err=True)
        raise typer.Exit(code=1)
    typer.echo(meta.read_text(encoding="utf-8").rstrip())


@app.command("delete")
def delete(
    run_dir: Path = typer.Argument(..., help="Run 目录"),
    yes: bool = typer.Option(False, "--yes", "-y", help="跳过确认"),
) -> None:
    if not run_dir.is_dir():
        typer.echo(f"目录不存在: {run_dir}", err=True)
        raise typer.Exit(code=1)
    if not yes:
        if not typer.confirm(f"删除 {run_dir} 全部内容？"):
            raise typer.Exit(code=1)
    shutil.rmtree(run_dir)
    typer.echo(f"已删除 {run_dir}")


@app.command("fork")
def fork(
    src: Path = typer.Argument(..., help="源 Run 目录"),
    dst: Path = typer.Argument(..., help="目标 Run 目录"),
    name: str = typer.Option(..., "--name", help="新 Run 显示名"),
) -> None:
    """复制源 Run 到新目录并改写 meta（P0 最小版；P5 才扩展 cook 分支）。"""
    src = src.resolve()
    dst = dst.resolve()
    if not src.is_dir():
        typer.echo(f"源不存在: {src}", err=True)
        raise typer.Exit(code=1)
    if dst.exists():
        typer.echo(f"目标已存在: {dst}", err=True)
        raise typer.Exit(code=1)
    shutil.copytree(src, dst)
    atomic_write_json(dst / "meta.json", _run_meta(name))
    typer.echo(f"已 fork {src} → {dst}")
