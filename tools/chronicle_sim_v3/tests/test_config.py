"""LLMConfig 加载与校验（三层架构版）。

models 字段语义：每个 model 引用 providers.yaml 中的 provider_id。
本文件不再持有 base_url / api_key_ref。
"""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.llm.config import (
    LLMConfig,
    load_llm_config,
    load_llm_config_text,
)
from tools.chronicle_sim_v3.llm.errors import LLMConfigError


_MIN_OK = """\
schema: chronicle_sim_v3/llm@1
models:
  stub:
    provider: stub_local
    invocation: stub
  embed-stub:
    provider: stub_local
    invocation: stub
routes:
  offline: stub
  embed: embed-stub
"""


def test_load_minimal_ok() -> None:
    cfg = load_llm_config_text(_MIN_OK)
    assert isinstance(cfg, LLMConfig)
    assert cfg.routes["offline"] == "stub"
    assert cfg.routes["embed"] == "embed-stub"
    assert cfg.models["stub"].provider == "stub_local"
    assert cfg.models["stub"].invocation == "stub"


def test_literal_api_key_rejected() -> None:
    bad = _MIN_OK + "    api_key: AKIAabc123\n"
    with pytest.raises(LLMConfigError, match="api_key"):
        load_llm_config_text(bad)


def test_routes_must_have_embed() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/llm@1
        models:
          stub: {provider: stub_local, invocation: stub}
        routes:
          offline: stub
        """)
    with pytest.raises(LLMConfigError, match="embed"):
        load_llm_config_text(bad)


def test_routes_must_have_non_embed() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/llm@1
        models:
          stub: {provider: stub_local, invocation: stub}
        routes:
          embed: stub
        """)
    with pytest.raises(LLMConfigError, match="非 embed"):
        load_llm_config_text(bad)


def test_route_target_must_exist_in_models() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/llm@1
        models:
          stub: {provider: stub_local, invocation: stub}
        routes:
          offline: missing
          embed: stub
        """)
    with pytest.raises(LLMConfigError):
        load_llm_config_text(bad)


def test_unknown_invocation_rejected() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/llm@1
        models:
          x: {provider: p, invocation: weird_invocation}
          stub: {provider: stub_local, invocation: stub}
        routes:
          offline: x
          embed: stub
        """)
    with pytest.raises(LLMConfigError):
        load_llm_config_text(bad)


def test_load_from_file(tmp_path: Path) -> None:
    cfg_dir = tmp_path / "config"
    cfg_dir.mkdir()
    (cfg_dir / "llm.yaml").write_text(_MIN_OK, encoding="utf-8")
    cfg = load_llm_config(tmp_path)
    assert cfg.routes["offline"] == "stub"


def test_load_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(LLMConfigError):
        load_llm_config(tmp_path)


def test_template_file_loadable() -> None:
    """data/templates/llm.example.yaml 必须能被解析。"""
    src = (
        Path(__file__).resolve().parents[1] / "data" / "templates" / "llm.example.yaml"
    )
    text = src.read_text(encoding="utf-8")
    cfg = load_llm_config_text(text)
    assert "embed" in cfg.routes
    assert "smart" in cfg.routes
