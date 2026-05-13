"""ApiKeyRef.parse / resolve（三层架构后已搬到 providers 层）。"""
from __future__ import annotations

from pathlib import Path

import pytest

from tools.chronicle_sim_v3.providers.config import ApiKeyRef
from tools.chronicle_sim_v3.providers.errors import ProviderConfigError


def test_parse_env_ok() -> None:
    r = ApiKeyRef.parse("env:DASHSCOPE_API_KEY")
    assert r.kind == "env"
    assert r.value == "DASHSCOPE_API_KEY"


def test_parse_file_ok() -> None:
    r = ApiKeyRef.parse("file:secrets/moonshot.key")
    assert r.kind == "file"
    assert r.value == "secrets/moonshot.key"


def test_parse_strips_whitespace() -> None:
    r = ApiKeyRef.parse("env:   FOO  ")
    assert r.value == "FOO"


def test_parse_bad_prefix_raises() -> None:
    with pytest.raises(ProviderConfigError):
        ApiKeyRef.parse("DASHSCOPE_API_KEY")
    with pytest.raises(ProviderConfigError):
        ApiKeyRef.parse("envFOO")
    with pytest.raises(ProviderConfigError):
        ApiKeyRef.parse("os:FOO")


def test_parse_non_string_raises() -> None:
    with pytest.raises(ProviderConfigError):
        ApiKeyRef.parse(123)  # type: ignore[arg-type]


def test_resolve_env_present(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("FOO_KEY", "secret123")
    r = ApiKeyRef.parse("env:FOO_KEY")
    assert r.resolve(tmp_path) == "secret123"


def test_resolve_env_missing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("MISSING_FOO", raising=False)
    r = ApiKeyRef.parse("env:MISSING_FOO")
    with pytest.raises(ProviderConfigError):
        r.resolve(tmp_path)


def test_resolve_file_present(tmp_path: Path) -> None:
    cfg = tmp_path / "config"
    cfg.mkdir()
    key = cfg / "x.key"
    key.write_text("filekey-abc\n", encoding="utf-8")
    r = ApiKeyRef.parse("file:x.key")
    assert r.resolve(tmp_path) == "filekey-abc"


def test_resolve_file_missing(tmp_path: Path) -> None:
    r = ApiKeyRef.parse("file:nope.key")
    with pytest.raises(ProviderConfigError):
        r.resolve(tmp_path)
