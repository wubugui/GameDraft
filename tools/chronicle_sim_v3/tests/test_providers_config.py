"""providers.yaml 加载、字段校验、安全约束（字面 api_key 拒绝）。"""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.providers.config import (
    ProviderDef,
    ProvidersConfig,
    load_providers_config,
    load_providers_config_text,
)
from tools.chronicle_sim_v3.providers.errors import ProviderConfigError
from tools.chronicle_sim_v3.providers.types import PROVIDER_KINDS


_OK_FOUR_KINDS = """\
schema: chronicle_sim_v3/providers@1
providers:
  open_ai:
    kind: openai_compat
    base_url: https://api.openai.com/v1
    api_key_ref: env:OPENAI_API_KEY
  ds:
    kind: dashscope_compat
    base_url: https://dashscope.aliyuncs.com/v1
    api_key_ref: env:DASHSCOPE_API_KEY
  llama_local:
    kind: ollama
    base_url: http://127.0.0.1:11434
  stub_local:
    kind: stub
"""


def test_load_minimal_ok() -> None:
    cfg = load_providers_config_text(_OK_FOUR_KINDS)
    assert isinstance(cfg, ProvidersConfig)
    assert set(cfg.providers.keys()) == {"open_ai", "ds", "llama_local", "stub_local"}
    assert cfg.providers["open_ai"].kind == "openai_compat"
    assert cfg.providers["ds"].kind == "dashscope_compat"
    assert cfg.providers["llama_local"].kind == "ollama"
    assert cfg.providers["stub_local"].kind == "stub"


def test_provider_kinds_constant_consistent() -> None:
    assert "openai_compat" in PROVIDER_KINDS
    assert "dashscope_compat" in PROVIDER_KINDS
    assert "ollama" in PROVIDER_KINDS
    assert "stub" in PROVIDER_KINDS
    assert len(PROVIDER_KINDS) == 4


def test_unknown_kind_rejected() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/providers@1
        providers:
          x: {kind: anthropic}
        """)
    with pytest.raises(ProviderConfigError):
        load_providers_config_text(bad)


def test_openai_compat_requires_base_url() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/providers@1
        providers:
          x:
            kind: openai_compat
            api_key_ref: env:K
        """)
    with pytest.raises(ProviderConfigError, match="base_url"):
        load_providers_config_text(bad)


def test_openai_compat_requires_api_key_ref() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/providers@1
        providers:
          x:
            kind: openai_compat
            base_url: https://x.example
        """)
    with pytest.raises(ProviderConfigError, match="api_key_ref"):
        load_providers_config_text(bad)


def test_dashscope_compat_requires_api_key_ref() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/providers@1
        providers:
          x:
            kind: dashscope_compat
            base_url: https://dashscope.aliyuncs.com/v1
        """)
    with pytest.raises(ProviderConfigError, match="api_key_ref"):
        load_providers_config_text(bad)


def test_ollama_does_not_need_api_key() -> None:
    ok = textwrap.dedent("""\
        schema: chronicle_sim_v3/providers@1
        providers:
          local_llama:
            kind: ollama
            base_url: http://127.0.0.1:11434
        """)
    cfg = load_providers_config_text(ok)
    assert cfg.providers["local_llama"].api_key_ref is None


def test_ollama_needs_base_url() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/providers@1
        providers:
          x: {kind: ollama}
        """)
    with pytest.raises(ProviderConfigError, match="base_url"):
        load_providers_config_text(bad)


def test_stub_needs_nothing() -> None:
    ok = textwrap.dedent("""\
        schema: chronicle_sim_v3/providers@1
        providers:
          stub_local: {kind: stub}
        """)
    cfg = load_providers_config_text(ok)
    p = cfg.providers["stub_local"]
    assert p.kind == "stub"
    assert p.base_url == ""
    assert p.api_key_ref is None


def test_literal_api_key_rejected() -> None:
    bad = _OK_FOUR_KINDS + "    api_key: AKIAabc\n"
    with pytest.raises(ProviderConfigError, match="api_key"):
        load_providers_config_text(bad)


def test_literal_api_key_ref_allowed() -> None:
    ok = textwrap.dedent("""\
        schema: chronicle_sim_v3/providers@1
        providers:
          x:
            kind: openai_compat
            base_url: https://x.example
            api_key_ref: env:K
        """)
    cfg = load_providers_config_text(ok)
    assert cfg.providers["x"].api_key_ref == "env:K"


def test_empty_providers_rejected() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/providers@1
        providers: {}
        """)
    with pytest.raises(ProviderConfigError, match="不能为空"):
        load_providers_config_text(bad)


def test_load_from_file(tmp_path: Path) -> None:
    cfg_dir = tmp_path / "config"
    cfg_dir.mkdir()
    (cfg_dir / "providers.yaml").write_text(_OK_FOUR_KINDS, encoding="utf-8")
    cfg = load_providers_config(tmp_path)
    assert "stub_local" in cfg.providers


def test_load_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(ProviderConfigError, match="不存在"):
        load_providers_config(tmp_path)


def test_provider_def_extra_carried() -> None:
    ok = textwrap.dedent("""\
        schema: chronicle_sim_v3/providers@1
        providers:
          x:
            kind: openai_compat
            base_url: https://x.example
            api_key_ref: env:K
            extra:
              org_id: my-org
              region: cn-hangzhou
        """)
    cfg = load_providers_config_text(ok)
    assert cfg.providers["x"].extra == {"org_id": "my-org", "region": "cn-hangzhou"}


def test_top_level_must_be_mapping(tmp_path: Path) -> None:
    cfg_dir = tmp_path / "config"
    cfg_dir.mkdir()
    (cfg_dir / "providers.yaml").write_text("- not-a-mapping\n", encoding="utf-8")
    with pytest.raises(ProviderConfigError, match="顶层"):
        load_providers_config(tmp_path)


def test_provider_def_direct_construction() -> None:
    p = ProviderDef(kind="stub")
    assert p.kind == "stub"
    assert p.base_url == ""
    assert p.api_key_ref is None
    assert p.extra == {}
