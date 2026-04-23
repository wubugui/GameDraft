"""csim provider * —— Provider 层凭据管理与连通性检查。

注意：
- show 命令永不显示 raw api_key；只显示 has_api_key_ref / provider_hash
- test 子命令 ping endpoint，验证 base_url 与凭据有效（GET /models 或 /api/tags）
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import typer

from tools.chronicle_sim_v3.providers.errors import (
    ProviderError,
    ProviderHealthError,
    ProviderNotFoundError,
)
from tools.chronicle_sim_v3.providers.service import ProviderService

app = typer.Typer(no_args_is_help=True, help="Provider（API 提供商）管理与 ping")


def _build(run: Path) -> ProviderService:
    return ProviderService(run.resolve())


@app.command("list")
def list_cmd(
    run: Path = typer.Option(Path("."), "--run", help="Run 目录"),
) -> None:
    """打印 providers.yaml 注册的所有 provider（脱敏）。"""
    svc = _build(run)
    rows = svc.list_providers()
    if not rows:
        typer.echo("(无注册 provider)")
        return
    for r in rows:
        typer.echo(
            f"{r['provider_id']:>20s}  kind={r['kind']:<18s}  "
            f"base_url={r['base_url']:<60s}  has_key={r['has_api_key_ref']}"
        )


@app.command("show")
def show_cmd(
    provider_id: str = typer.Argument(..., help="provider_id"),
    run: Path = typer.Option(Path("."), "--run", help="Run 目录"),
) -> None:
    """展开单个 provider 配置（不显 raw key，只显 fingerprint）。"""
    svc = _build(run)
    if not svc.has(provider_id):
        typer.echo(f"未注册: {provider_id}", err=True)
        raise typer.Exit(code=1)
    try:
        resolved = svc.resolve(provider_id)
    except ProviderError as e:
        typer.echo(f"解析失败: {e}", err=True)
        raise typer.Exit(code=1) from e
    body = {
        "provider_id": resolved.provider_id,
        "kind": resolved.kind,
        "base_url": resolved.base_url,
        "provider_hash": resolved.provider_hash,
        "has_api_key": bool(resolved.api_key),
        "api_key_fingerprint": (
            f"...{resolved.api_key[-4:]}" if resolved.api_key else None
        ),
        "extra": resolved.extra,
    }
    typer.echo(json.dumps(body, ensure_ascii=False, indent=2))


@app.command("test")
def test_cmd(
    provider_id: str = typer.Argument(..., help="provider_id"),
    run: Path = typer.Option(Path("."), "--run", help="Run 目录"),
    timeout: float = typer.Option(10.0, "--timeout", help="ping 超时秒"),
) -> None:
    """对单个 provider 做最小连通性 ping。"""
    svc = _build(run)
    if not svc.has(provider_id):
        typer.echo(f"未注册: {provider_id}", err=True)
        raise typer.Exit(code=1)

    async def _go():
        return await svc.health_check(provider_id, timeout_sec=timeout)

    try:
        info = asyncio.run(_go())
    except ProviderNotFoundError as e:
        typer.echo(f"未注册: {e}", err=True)
        raise typer.Exit(code=1) from e
    except ProviderHealthError as e:
        typer.echo(f"FAIL  {provider_id}: {e}", err=True)
        raise typer.Exit(code=2) from e
    except Exception as e:
        typer.echo(f"FAIL  {provider_id}: {e!r}", err=True)
        raise typer.Exit(code=2) from e

    typer.echo(
        f"OK    {info['provider_id']}  kind={info['kind']}  "
        f"status={info['status']}  message={info['message']}"
    )
