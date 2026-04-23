"""Provider health check —— 各 ProviderKind 的最小连通性 ping。

设计：
- openai_compat / dashscope_compat：GET <base>/models
- ollama：GET <base>/api/tags
- stub：始终返回 ok
- 错误统一抛 ProviderHealthError；含 status_code / 简短原因
- 默认 timeout 10s；可参数化
"""
from __future__ import annotations

from tools.chronicle_sim_v3.providers.errors import ProviderHealthError
from tools.chronicle_sim_v3.providers.types import ResolvedProvider


async def ping(resolved: ResolvedProvider, timeout_sec: float = 10.0) -> dict:
    """返回 {ok: bool, kind, base_url, status, message}；失败抛 ProviderHealthError。"""
    info = {
        "ok": False,
        "provider_id": resolved.provider_id,
        "kind": resolved.kind,
        "base_url": resolved.base_url,
        "status": None,
        "message": "",
    }
    if resolved.kind == "stub":
        info.update(ok=True, status=200, message="stub")
        return info
    import httpx

    base = resolved.base_url.rstrip("/")
    if resolved.kind == "ollama":
        url = f"{base}/api/tags"
        headers = {}
    else:
        url = f"{base}/models"
        headers = {"Authorization": f"Bearer {resolved.api_key}"} if resolved.api_key else {}

    try:
        # 强制禁用系统代理：trust_env=False 不读 HTTP(S)_PROXY/.netrc；
        # 全系统所有连接都不许走代理（用户硬约束）。
        async with httpx.AsyncClient(
            timeout=timeout_sec, trust_env=False,
        ) as client:
            resp = await client.get(url, headers=headers)
    except (httpx.TimeoutException, httpx.NetworkError) as e:
        raise ProviderHealthError(f"网络错误 {url}: {e!r}") from e
    except Exception as e:  # pragma: no cover —— 未知 httpx 异常
        raise ProviderHealthError(f"未知错误 {url}: {e!r}") from e

    info["status"] = resp.status_code
    if 200 <= resp.status_code < 300:
        info["ok"] = True
        info["message"] = "ok"
        return info
    info["message"] = f"HTTP {resp.status_code}: {resp.text[:200]}"
    raise ProviderHealthError(info["message"])
