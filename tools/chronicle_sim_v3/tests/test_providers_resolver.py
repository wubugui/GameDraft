"""ProviderResolver / ProviderService：resolve、provider_hash 不含 api_key、未知 id 报错。"""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.providers.config import load_providers_config_text
from tools.chronicle_sim_v3.providers.errors import (
    ProviderConfigError,
    ProviderNotFoundError,
)
from tools.chronicle_sim_v3.providers.resolver import (
    ProviderResolver,
    compute_provider_hash,
)
from tools.chronicle_sim_v3.providers.service import ProviderService


_PROVIDERS = """\
schema: chronicle_sim_v3/providers@1
providers:
  ds:
    kind: dashscope_compat
    base_url: https://dashscope.aliyuncs.com/v1
    api_key_ref: env:DASHSCOPE_KEY
  llama:
    kind: ollama
    base_url: http://127.0.0.1:11434
  stub_local:
    kind: stub
"""


def _svc(text: str, tmp_path: Path) -> ProviderService:
    cfg = load_providers_config_text(textwrap.dedent(text))
    return ProviderService(tmp_path, config=cfg)


def test_resolve_openai_compat_kind(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("DASHSCOPE_KEY", "sk-xyz")
    svc = _svc(_PROVIDERS, tmp_path)
    r = svc.resolve("ds")
    assert r.provider_id == "ds"
    assert r.kind == "dashscope_compat"
    assert r.base_url == "https://dashscope.aliyuncs.com/v1"
    assert r.api_key == "sk-xyz"
    assert len(r.provider_hash) == 16


def test_resolve_ollama_no_api_key(tmp_path: Path) -> None:
    svc = _svc(_PROVIDERS, tmp_path)
    r = svc.resolve("llama")
    assert r.kind == "ollama"
    assert r.api_key == ""
    assert r.base_url == "http://127.0.0.1:11434"


def test_resolve_stub(tmp_path: Path) -> None:
    svc = _svc(_PROVIDERS, tmp_path)
    r = svc.resolve("stub_local")
    assert r.kind == "stub"
    assert r.api_key == ""
    assert r.base_url == ""
    assert len(r.provider_hash) == 16


def test_resolve_unknown_id(tmp_path: Path) -> None:
    svc = _svc(_PROVIDERS, tmp_path)
    with pytest.raises(ProviderNotFoundError):
        svc.resolve("nope")


def test_resolve_env_missing_raises(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("DASHSCOPE_KEY", raising=False)
    svc = _svc(_PROVIDERS, tmp_path)
    with pytest.raises(ProviderConfigError):
        svc.resolve("ds")


def test_resolve_via_file_ref(tmp_path: Path) -> None:
    cfg_dir = tmp_path / "config"
    cfg_dir.mkdir()
    (cfg_dir / "ds.key").write_text("sk-from-file\n", encoding="utf-8")
    text = textwrap.dedent("""\
        schema: chronicle_sim_v3/providers@1
        providers:
          ds:
            kind: dashscope_compat
            base_url: https://dashscope.aliyuncs.com/v1
            api_key_ref: file:ds.key
        """)
    cfg = load_providers_config_text(text)
    svc = ProviderService(tmp_path, config=cfg)
    r = svc.resolve("ds")
    assert r.api_key == "sk-from-file"


def test_provider_hash_independent_of_api_key(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("DASHSCOPE_KEY", "first")
    svc = _svc(_PROVIDERS, tmp_path)
    h1 = svc.resolve("ds").provider_hash
    monkeypatch.setenv("DASHSCOPE_KEY", "second")
    svc2 = _svc(_PROVIDERS, tmp_path)
    h2 = svc2.resolve("ds").provider_hash
    assert h1 == h2


def test_provider_hash_changes_on_base_url(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("DASHSCOPE_KEY", "k")
    svc1 = _svc(_PROVIDERS, tmp_path)
    svc2 = _svc(_PROVIDERS.replace("aliyuncs.com", "other.example"), tmp_path)
    assert svc1.resolve("ds").provider_hash != svc2.resolve("ds").provider_hash


def test_provider_hash_changes_on_kind(tmp_path: Path) -> None:
    a = compute_provider_hash("openai_compat", "https://x", {})
    b = compute_provider_hash("dashscope_compat", "https://x", {})
    assert a != b


def test_provider_hash_changes_on_extra() -> None:
    a = compute_provider_hash("openai_compat", "https://x", {})
    b = compute_provider_hash("openai_compat", "https://x", {"region": "cn"})
    assert a != b


def test_resolver_list_ids(tmp_path: Path) -> None:
    svc = _svc(_PROVIDERS, tmp_path)
    assert svc.resolver.list_ids() == sorted(["ds", "llama", "stub_local"])


def test_service_has(tmp_path: Path) -> None:
    svc = _svc(_PROVIDERS, tmp_path)
    assert svc.has("ds")
    assert svc.has("stub_local")
    assert not svc.has("nope")


def test_service_list_providers_redacts_api_key(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("DASHSCOPE_KEY", "should-not-appear")
    svc = _svc(_PROVIDERS, tmp_path)
    rows = svc.list_providers()
    ids = [r["provider_id"] for r in rows]
    assert sorted(ids) == sorted(["ds", "llama", "stub_local"])
    for r in rows:
        for k, v in r.items():
            assert "should-not-appear" not in str(v)
        assert "api_key" not in r  # 永远不暴露 raw key 字段
        assert "has_api_key_ref" in r


def test_resolver_direct_construction(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("DASHSCOPE_KEY", "k")
    cfg = load_providers_config_text(textwrap.dedent(_PROVIDERS))
    r = ProviderResolver(cfg, tmp_path)
    out = r.resolve("ds")
    assert out.kind == "dashscope_compat"
    assert out.api_key == "k"
