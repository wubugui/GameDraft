"""Resolver：路由解析、policy 合并、route_hash 不含 api_key（三层架构版）。"""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.llm.config import load_llm_config_text
from tools.chronicle_sim_v3.llm.errors import LLMRouteError
from tools.chronicle_sim_v3.llm.resolver import Resolver
from tools.chronicle_sim_v3.llm.types import LLMRef, OutputSpec
from tools.chronicle_sim_v3.providers.config import load_providers_config_text
from tools.chronicle_sim_v3.providers.service import ProviderService


def _cfg(text: str):
    return load_llm_config_text(textwrap.dedent(text))


_PROVIDERS = """\
schema: chronicle_sim_v3/providers@1
providers:
  p1:
    kind: openai_compat
    base_url: https://m1.example
    api_key_ref: env:K1
  p2:
    kind: openai_compat
    base_url: https://m2.example
    api_key_ref: env:K2
  stub_local:
    kind: stub
"""


_BASE = """\
schema: chronicle_sim_v3/llm@1
models:
  m1:
    provider: p1
    invocation: openai_compat_chat
    model_id: alpha
  m2:
    provider: p2
    invocation: openai_compat_chat
    model_id: beta
  embed-stub:
    provider: stub_local
    invocation: stub
routes:
  smart: m1
  fast: m2
  embed: embed-stub
retry:
  default:
    max_attempts: 3
    backoff: exp
    base_ms: 200
  smart:
    max_attempts: 5
    backoff: fixed
    base_ms: 100
rate_limits:
  default: {qpm: 60}
  routes:
    smart: {qpm: 30, tpm: 1000}
timeout:
  default_sec: 30
  per_route:
    smart: 60
cache:
  enabled: true
  default_mode: off
  per_route:
    smart: hash
"""


def _make_provider_service(text: str, tmp_path: Path) -> ProviderService:
    pcfg = load_providers_config_text(textwrap.dedent(text))
    return ProviderService(tmp_path, config=pcfg)


def test_resolve_route_basic(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("K1", "secret_one")
    monkeypatch.setenv("K2", "secret_two")
    cfg = _cfg(_BASE)
    provs = _make_provider_service(_PROVIDERS, tmp_path)
    r = Resolver(cfg, provs)
    rm = r.resolve_route("smart")
    assert rm.physical == "m1"
    assert rm.invocation == "openai_compat_chat"
    assert rm.model_id == "alpha"
    assert rm.api_key == "secret_one"
    assert rm.base_url == "https://m1.example"
    assert len(rm.route_hash) == 16


def test_route_hash_independent_of_api_key(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("K1", "first_value")
    monkeypatch.setenv("K2", "v2")
    cfg = _cfg(_BASE)
    provs = _make_provider_service(_PROVIDERS, tmp_path)
    r = Resolver(cfg, provs)
    h1 = r.resolve_route("smart").route_hash
    monkeypatch.setenv("K1", "different_value")
    # 重新构造 ProviderService 以重新解析 env
    provs2 = _make_provider_service(_PROVIDERS, tmp_path)
    r2 = Resolver(cfg, provs2)
    h2 = r2.resolve_route("smart").route_hash
    assert h1 == h2  # api_key 不进 hash


def test_route_hash_changes_on_base_url(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("K1", "k")
    monkeypatch.setenv("K2", "k2")
    cfg = _cfg(_BASE)
    provs1 = _make_provider_service(_PROVIDERS, tmp_path)
    provs2 = _make_provider_service(
        _PROVIDERS.replace("https://m1.example", "https://m1-other.example"),
        tmp_path,
    )
    r1 = Resolver(cfg, provs1)
    r2 = Resolver(cfg, provs2)
    h1 = r1.resolve_route("smart").route_hash
    h2 = r2.resolve_route("smart").route_hash
    assert h1 != h2


def test_unknown_logical_raises(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("K1", "k")
    monkeypatch.setenv("K2", "k2")
    cfg = _cfg(_BASE)
    provs = _make_provider_service(_PROVIDERS, tmp_path)
    r = Resolver(cfg, provs)
    with pytest.raises(LLMRouteError):
        r.resolve_route("nonexistent")


def test_policy_merging_per_route_overrides(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("K1", "k")
    monkeypatch.setenv("K2", "k2")
    cfg = _cfg(_BASE)
    provs = _make_provider_service(_PROVIDERS, tmp_path)
    r = Resolver(cfg, provs)
    p_smart = r.policy_for("smart")
    assert p_smart.timeout_sec == 60
    assert p_smart.retry.max_attempts == 5
    assert p_smart.retry.backoff == "fixed"
    assert p_smart.rate_limit.qpm == 30
    assert p_smart.rate_limit.tpm == 1000
    assert p_smart.cache_mode == "hash"


def test_policy_falls_back_to_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("K1", "k")
    monkeypatch.setenv("K2", "k2")
    cfg = _cfg(_BASE)
    provs = _make_provider_service(_PROVIDERS, tmp_path)
    r = Resolver(cfg, provs)
    p_fast = r.policy_for("fast")
    assert p_fast.timeout_sec == 30
    assert p_fast.retry.max_attempts == 3
    assert p_fast.retry.backoff == "exp"
    assert p_fast.rate_limit.qpm == 60
    assert p_fast.cache_mode == "off"


def test_policy_ref_overrides(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("K1", "k")
    monkeypatch.setenv("K2", "k2")
    cfg = _cfg(_BASE)
    provs = _make_provider_service(_PROVIDERS, tmp_path)
    r = Resolver(cfg, provs)
    ref = LLMRef(
        role="dummy",
        model="fast",
        output=OutputSpec(kind="text"),
        cache="exact",
        timeout_sec=999,
        retry_max_attempts=10,
    )
    p = r.policy_for("fast", ref)
    assert p.timeout_sec == 999
    assert p.retry.max_attempts == 10
    assert p.cache_mode == "exact"
