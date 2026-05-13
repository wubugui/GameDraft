"""Provider health.ping：stub 永真；openai/ollama 走 httpx，用 monkeypatch 模拟。"""
from __future__ import annotations

import pytest

from tools.chronicle_sim_v3.providers.errors import ProviderHealthError
from tools.chronicle_sim_v3.providers.health import ping
from tools.chronicle_sim_v3.providers.types import ResolvedProvider


def _resolved(kind, base_url="", api_key="") -> ResolvedProvider:
    return ResolvedProvider(
        provider_id="x", kind=kind, base_url=base_url, api_key=api_key,
        extra={}, provider_hash="h" * 16,
    )


@pytest.mark.asyncio
async def test_ping_stub_always_ok() -> None:
    info = await ping(_resolved("stub"))
    assert info["ok"] is True
    assert info["kind"] == "stub"
    assert info["status"] == 200


class _FakeResp:
    def __init__(self, status_code: int, text: str = "") -> None:
        self.status_code = status_code
        self.text = text


class _FakeAsyncClient:
    def __init__(self, *, response: _FakeResp | None = None, exc: Exception | None = None,
                 **_kwargs):
        self._resp = response
        self._exc = exc
        self.last_url: str | None = None
        self.last_headers: dict | None = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def get(self, url, headers=None):
        self.last_url = url
        self.last_headers = headers or {}
        if self._exc is not None:
            raise self._exc
        assert self._resp is not None
        return self._resp


@pytest.mark.asyncio
async def test_ping_openai_compat_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    def _factory(**kw):
        c = _FakeAsyncClient(response=_FakeResp(200, "ok"))
        captured["client"] = c
        return c

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", _factory)
    info = await ping(_resolved("openai_compat", "https://api.example/v1", "sk-secret"))
    assert info["ok"] is True
    assert info["status"] == 200
    c = captured["client"]
    assert c.last_url == "https://api.example/v1/models"
    assert c.last_headers["Authorization"] == "Bearer sk-secret"


@pytest.mark.asyncio
async def test_ping_ollama_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    def _factory(**kw):
        c = _FakeAsyncClient(response=_FakeResp(200, "{}"))
        captured["client"] = c
        return c

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", _factory)
    info = await ping(_resolved("ollama", "http://127.0.0.1:11434"))
    assert info["ok"] is True
    c = captured["client"]
    assert c.last_url == "http://127.0.0.1:11434/api/tags"
    assert c.last_headers == {}


@pytest.mark.asyncio
async def test_ping_dashscope_uses_models_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def _factory(**kw):
        c = _FakeAsyncClient(response=_FakeResp(200, "ok"))
        captured["client"] = c
        return c

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", _factory)
    await ping(_resolved("dashscope_compat", "https://dashscope.example/v1/", "sk"))
    assert captured["client"].last_url == "https://dashscope.example/v1/models"


@pytest.mark.asyncio
async def test_ping_http_error_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def _factory(**kw):
        return _FakeAsyncClient(response=_FakeResp(401, "unauthorized"))

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", _factory)
    with pytest.raises(ProviderHealthError, match="401"):
        await ping(_resolved("openai_compat", "https://x.example/v1", "bad-key"))


@pytest.mark.asyncio
async def test_ping_network_error_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    import httpx

    def _factory(**kw):
        return _FakeAsyncClient(exc=httpx.ConnectError("connection refused"))

    monkeypatch.setattr(httpx, "AsyncClient", _factory)
    with pytest.raises(ProviderHealthError, match="网络错误"):
        await ping(_resolved("openai_compat", "https://x.example/v1", "k"))


@pytest.mark.asyncio
async def test_ping_timeout_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    import httpx

    def _factory(**kw):
        return _FakeAsyncClient(exc=httpx.ConnectTimeout("timeout"))

    monkeypatch.setattr(httpx, "AsyncClient", _factory)
    with pytest.raises(ProviderHealthError, match="网络错误"):
        await ping(_resolved("openai_compat", "https://x.example/v1", "k"))
