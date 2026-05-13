"""providers.yaml 加载 + 校验。

关键安全约束（与 llm.yaml 相同）：
- 字面 `api_key:` 拒绝；只接受 `api_key_ref: env:VAR | file:path`
- file:path 是相对 `<run>/config/`
- stub / ollama kind 可省略 api_key_ref；其它必填
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from tools.chronicle_sim_v3.engine.io import read_yaml
from tools.chronicle_sim_v3.providers.errors import ProviderConfigError
from tools.chronicle_sim_v3.providers.types import PROVIDER_KINDS


class ApiKeyRef(BaseModel):
    """env:VAR | file:path（path 相对 <run>/config/）。

    与 v3-llm 旧版 ApiKeyRef 等价；现在是 Provider 层的内置类型。
    """

    kind: Literal["env", "file"]
    value: str

    @classmethod
    def parse(cls, raw: str) -> "ApiKeyRef":
        if not isinstance(raw, str):
            raise ProviderConfigError(
                f"api_key_ref 必须是字符串，得到 {type(raw).__name__}"
            )
        if raw.startswith("env:"):
            return cls(kind="env", value=raw[4:].strip())
        if raw.startswith("file:"):
            return cls(kind="file", value=raw[5:].strip())
        raise ProviderConfigError(
            f"api_key_ref 必须以 env: 或 file: 开头，得到 {raw!r}"
        )

    def resolve(self, run_dir: Path) -> str:
        if self.kind == "env":
            v = os.environ.get(self.value, "")
            if not v:
                raise ProviderConfigError(
                    f"环境变量 {self.value} 未设置或为空"
                )
            return v
        p = (Path(run_dir) / "config" / self.value).resolve()
        if not p.is_file():
            raise ProviderConfigError(f"密钥文件不存在: {p}")
        return p.read_text(encoding="utf-8").strip()


class ProviderDef(BaseModel):
    kind: str
    base_url: str = ""
    api_key_ref: str | None = None
    extra: dict = Field(default_factory=dict)

    @field_validator("kind")
    @classmethod
    def _kind_known(cls, v: str) -> str:
        if v not in PROVIDER_KINDS:
            raise ValueError(
                f"未知 provider kind {v!r}；允许：{list(PROVIDER_KINDS)}"
            )
        return v

    @model_validator(mode="after")
    def _check_required_fields(self) -> "ProviderDef":
        # stub 不需要 base_url / api_key
        if self.kind == "stub":
            return self
        # 其它需要 base_url
        if not self.base_url:
            raise ValueError(f"provider kind={self.kind} 需要 base_url")
        # ollama 不需要 api_key
        if self.kind == "ollama":
            return self
        # openai_compat / dashscope_compat 需要 api_key_ref
        if not self.api_key_ref:
            raise ValueError(
                f"provider kind={self.kind} 需要 api_key_ref（env:VAR 或 file:path）"
            )
        return self


class ProvidersConfig(BaseModel):
    schema_version: str = Field(alias="schema")
    providers: dict[str, ProviderDef]

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _check_non_empty(self) -> "ProvidersConfig":
        if not self.providers:
            raise ValueError("providers 不能为空")
        return self


_LITERAL_KEY_RE = re.compile(r"(?m)^\s*api_key\s*:")


def _scan_literal_api_key(text: str) -> None:
    for m in _LITERAL_KEY_RE.finditer(text):
        line_end = text.find("\n", m.end())
        line = text[m.start(): line_end if line_end >= 0 else len(text)]
        if "api_key_ref" in line:
            continue
        raise ProviderConfigError(
            "providers.yaml 出现字面 'api_key:'，必须改为 "
            "'api_key_ref: env:VAR' 或 'file:path'"
        )


def _to_plain(value: Any) -> Any:
    """ruamel CommentedMap / CommentedSeq → 纯 dict / list。"""
    if isinstance(value, dict):
        return {str(k): _to_plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_plain(v) for v in value]
    return value


def load_providers_config(run_dir: Path) -> ProvidersConfig:
    """从 <run>/config/providers.yaml 读取并校验。"""
    p = (Path(run_dir) / "config" / "providers.yaml").resolve()
    if not p.is_file():
        raise ProviderConfigError(f"providers.yaml 不存在: {p}")
    text = p.read_text(encoding="utf-8")
    _scan_literal_api_key(text)
    raw = read_yaml(p)
    if not isinstance(raw, dict):
        raise ProviderConfigError("providers.yaml 顶层必须是 mapping")
    try:
        return ProvidersConfig.model_validate(_to_plain(raw))
    except Exception as e:
        raise ProviderConfigError(f"providers.yaml 校验失败: {e}") from e


def load_providers_config_text(text: str) -> ProvidersConfig:
    """字符串加载（测试用）。"""
    _scan_literal_api_key(text)
    from tools.chronicle_sim_v3.engine.io import read_yaml_text

    raw = read_yaml_text(text)
    if not isinstance(raw, dict):
        raise ProviderConfigError("providers.yaml 顶层必须是 mapping")
    try:
        return ProvidersConfig.model_validate(_to_plain(raw))
    except Exception as e:
        raise ProviderConfigError(f"providers.yaml 校验失败: {e}") from e
