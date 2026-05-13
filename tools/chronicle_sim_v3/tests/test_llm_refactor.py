"""三层重构后 LLM 层补充测试：

- ModelDef 必须引用 provider_id（旧字段 backend/base_url/api_key_ref/ollama_host 已删）
- Resolver 必须通过 ProviderService 拿凭据
- ResolvedModel 包含 provider_id；旧别名 .backend == .invocation
- route_hash 在 provider_id / model_id / invocation 变更时变化
- bad provider_id 在 resolve_route 报 LLMConfigError
"""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.llm.config import (
    LLMConfig,
    ModelDef,
    load_llm_config_text,
)
from tools.chronicle_sim_v3.llm.errors import LLMConfigError
from tools.chronicle_sim_v3.llm.resolver import Resolver
from tools.chronicle_sim_v3.providers.config import load_providers_config_text
from tools.chronicle_sim_v3.providers.service import ProviderService


_PROVIDERS = """\
schema: chronicle_sim_v3/providers@1
providers:
  p1:
    kind: openai_compat
    base_url: https://shared.example/v1
    api_key_ref: env:K_P1
  p2:
    kind: openai_compat
    base_url: https://shared.example/v1
    api_key_ref: env:K_P2
  stub_local:
    kind: stub
"""


_LLM = """\
schema: chronicle_sim_v3/llm@1
models:
  m_a:
    provider: p1
    invocation: openai_compat_chat
    model_id: alpha
  m_b:
    provider: p2
    invocation: openai_compat_chat
    model_id: alpha
  m_c:
    provider: p1
    invocation: openai_compat_chat
    model_id: beta
  m_d:
    provider: p1
    invocation: stub
  embed-stub:
    provider: stub_local
    invocation: stub
routes:
  ra: m_a
  rb: m_b
  rc: m_c
  rd: m_d
  embed: embed-stub
"""


def _make(monkeypatch, tmp_path):
    monkeypatch.setenv("K_P1", "k1")
    monkeypatch.setenv("K_P2", "k2")
    pcfg = load_providers_config_text(textwrap.dedent(_PROVIDERS))
    lcfg = load_llm_config_text(textwrap.dedent(_LLM))
    return Resolver(lcfg, ProviderService(tmp_path, config=pcfg))


def test_model_def_no_legacy_fields() -> None:
    """ModelDef 已移除 backend/base_url/api_key_ref/ollama_host。"""
    fields = set(ModelDef.model_fields.keys())
    assert "provider" in fields
    assert "invocation" in fields
    assert "model_id" in fields
    assert "backend" not in fields
    assert "base_url" not in fields
    assert "api_key_ref" not in fields
    assert "ollama_host" not in fields


def test_resolved_model_includes_provider_id(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    r = _make(monkeypatch, tmp_path)
    rm = r.resolve_route("ra")
    assert rm.provider_id == "p1"
    assert rm.api_key == "k1"
    assert rm.model_id == "alpha"


def test_resolved_model_backend_alias_equals_invocation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    r = _make(monkeypatch, tmp_path)
    rm = r.resolve_route("ra")
    assert rm.backend == rm.invocation == "openai_compat_chat"


def test_route_hash_changes_on_provider_id(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """ra 与 rb 共用 invocation/model_id/base_url，仅 provider_id 不同 → hash 仍应不同。"""
    r = _make(monkeypatch, tmp_path)
    h_a = r.resolve_route("ra").route_hash
    h_b = r.resolve_route("rb").route_hash
    assert h_a != h_b


def test_route_hash_changes_on_model_id(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    r = _make(monkeypatch, tmp_path)
    h_a = r.resolve_route("ra").route_hash  # alpha
    h_c = r.resolve_route("rc").route_hash  # beta
    assert h_a != h_c


def test_route_hash_changes_on_invocation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    r = _make(monkeypatch, tmp_path)
    h_a = r.resolve_route("ra").route_hash  # openai_compat_chat
    h_d = r.resolve_route("rd").route_hash  # stub
    assert h_a != h_d


def test_unknown_provider_id_raises_llm_config_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("K_P1", "k1")
    pcfg = load_providers_config_text(textwrap.dedent(_PROVIDERS))
    bad_llm = textwrap.dedent("""\
        schema: chronicle_sim_v3/llm@1
        models:
          x:
            provider: nonexistent_provider
            invocation: openai_compat_chat
            model_id: m
          embed-stub:
            provider: stub_local
            invocation: stub
        routes:
          off: x
          embed: embed-stub
        """)
    lcfg = load_llm_config_text(bad_llm)
    resolver = Resolver(lcfg, ProviderService(tmp_path, config=pcfg))
    with pytest.raises(LLMConfigError, match="nonexistent_provider"):
        resolver.resolve_route("off")


def test_llm_yaml_no_backends_block_supported() -> None:
    """旧版 backends/cline_config_dir 已删；不出现在 LLMConfig 字段中。"""
    fields = set(LLMConfig.model_fields.keys())
    assert "backends" not in fields
    assert "cline_config_dir" not in fields
    assert "providers_ref" in fields


def test_llm_resolver_uses_injected_provider_service(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """注入不同 ProviderService 应得到不同 base_url；证明凭据来源是 Provider 层。"""
    monkeypatch.setenv("K_P1", "k1")
    monkeypatch.setenv("K_P2", "k2")
    pcfg = load_providers_config_text(textwrap.dedent(_PROVIDERS))
    lcfg = load_llm_config_text(textwrap.dedent(_LLM))
    r1 = Resolver(lcfg, ProviderService(tmp_path, config=pcfg))
    rm = r1.resolve_route("ra")
    assert rm.base_url == "https://shared.example/v1"

    pcfg2 = load_providers_config_text(
        textwrap.dedent(_PROVIDERS).replace(
            "https://shared.example/v1", "https://other.example/v1"
        )
    )
    r2 = Resolver(lcfg, ProviderService(tmp_path, config=pcfg2))
    rm2 = r2.resolve_route("ra")
    assert rm2.base_url == "https://other.example/v1"
