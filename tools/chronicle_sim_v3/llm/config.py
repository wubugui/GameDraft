"""LLMConfig 加载与校验（RFC v3-llm.md §2.2，三层架构版）。

关键变更（vs 旧版）：
- 删除 `ApiKeyRef`（搬到 providers/，以下 re-export 仅为向后兼容）
- `ModelDef.backend / base_url / api_key_ref / ollama_host` 删除
- 新字段：`provider`（指 providers.yaml 中的 provider_id），`model_id`，
  `invocation`（取代 backend）
- 加载阶段会调用 ProviderService 校验 provider_id 存在；若未提供则推迟到
  Resolver.resolve_route 时再校验

安全约束：仍禁字面 `api_key:`（即便 llm.yaml 现在不该写 key，也防御一层）。
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from tools.chronicle_sim_v3.engine.io import read_yaml
from tools.chronicle_sim_v3.llm.errors import LLMConfigError
from tools.chronicle_sim_v3.providers.config import ApiKeyRef as _ApiKeyRef

# 向后兼容 re-export（旧测试与外部代码可能 from llm.config import ApiKeyRef）
ApiKeyRef = _ApiKeyRef


_INVOCATIONS = {
    "openai_compat_chat",
    "openai_compat_embed",
    "ollama_chat",
    "ollama_embed",
    "stub",
}


class ModelDef(BaseModel):
    """逻辑模型 = (provider_id, model_id, invocation)。"""

    provider: str
    model_id: str = ""
    invocation: str
    extra: dict = Field(default_factory=dict)

    @field_validator("invocation")
    @classmethod
    def _invocation_known(cls, v: str) -> str:
        if v not in _INVOCATIONS:
            raise ValueError(
                f"未知 invocation {v!r}；允许：{sorted(_INVOCATIONS)}"
            )
        return v


class RetryConfigEntry(BaseModel):
    max_attempts: int = 3
    backoff: Literal["exp", "fixed"] = "exp"
    base_ms: int = 800
    retry_on: list[str] = Field(default_factory=lambda: [
        "timeout", "network", "rate_limit", "server_5xx", "cline_libuv_crash",
    ])
    no_retry_on: list[str] = Field(default_factory=lambda: [
        "auth_error", "bad_request",
    ])


class RateLimitEntry(BaseModel):
    qpm: int | None = None
    tpm: int | None = None


class CacheConfig(BaseModel):
    enabled: bool = True
    default_mode: Literal["off", "hash", "exact"] = "off"
    per_route: dict[str, Literal["off", "hash", "exact"]] = Field(default_factory=dict)


class ConcurrencyConfig(BaseModel):
    enabled: bool = True
    max_inflight: int = 4


class AuditConfig(BaseModel):
    enabled: bool = True
    log_user_prompt: bool = False
    log_user_prompt_max_chars: int = 4000


class LLMConfig(BaseModel):
    schema_version: str = Field(alias="schema")
    models: dict[str, ModelDef]
    routes: dict[str, str]
    concurrency: ConcurrencyConfig = Field(default_factory=ConcurrencyConfig)
    rate_limits: dict = Field(default_factory=dict)
    retry: dict = Field(default_factory=dict)
    cache: CacheConfig = Field(default_factory=CacheConfig)
    timeout: dict = Field(default_factory=dict)
    audit: AuditConfig = Field(default_factory=AuditConfig)
    stub: dict = Field(default_factory=dict)
    # 引用 providers.yaml 路径（默认 config/providers.yaml）；预留字段
    providers_ref: str = "config/providers.yaml"

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _check_routes(self) -> "LLMConfig":
        if "embed" not in self.routes:
            raise ValueError("routes 必须包含 embed")
        non_embed = [k for k in self.routes if k != "embed"]
        if not non_embed:
            raise ValueError("routes 必须含至少一个非 embed 路由")
        for logical, physical in self.routes.items():
            if physical not in self.models:
                raise ValueError(
                    f"路由 {logical}→{physical} 但 {physical} 未在 models 注册"
                )
        return self


_LITERAL_KEY_RE = re.compile(r"(?m)^\s*api_key\s*:")


def _scan_literal_api_key(text: str) -> None:
    for m in _LITERAL_KEY_RE.finditer(text):
        line_end = text.find("\n", m.end())
        line = text[m.start(): line_end if line_end >= 0 else len(text)]
        if "api_key_ref" in line:
            continue
        raise LLMConfigError(
            "llm.yaml 出现字面 'api_key:'，凭据请放 providers.yaml 并通过 "
            "api_key_ref: env:VAR 引用"
        )


def load_llm_config(run_dir: Path) -> LLMConfig:
    """从 <run>/config/llm.yaml 读取并校验。"""
    p = (Path(run_dir) / "config" / "llm.yaml").resolve()
    if not p.is_file():
        raise LLMConfigError(f"llm.yaml 不存在: {p}")
    text = p.read_text(encoding="utf-8")
    _scan_literal_api_key(text)
    raw = read_yaml(p)
    if not isinstance(raw, dict):
        raise LLMConfigError("llm.yaml 顶层必须是 mapping")
    try:
        return LLMConfig.model_validate(_to_plain(raw))
    except Exception as e:
        raise LLMConfigError(f"llm.yaml 校验失败: {e}") from e


def load_llm_config_text(text: str) -> LLMConfig:
    """从字符串加载（测试用）。"""
    _scan_literal_api_key(text)
    from tools.chronicle_sim_v3.engine.io import read_yaml_text

    raw = read_yaml_text(text)
    if not isinstance(raw, dict):
        raise LLMConfigError("llm.yaml 顶层必须是 mapping")
    try:
        return LLMConfig.model_validate(_to_plain(raw))
    except Exception as e:
        raise LLMConfigError(f"llm.yaml 校验失败: {e}") from e


def _to_plain(value: Any) -> Any:
    """ruamel CommentedMap / CommentedSeq → 纯 dict / list。"""
    if isinstance(value, dict):
        return {str(k): _to_plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_plain(v) for v in value]
    return value
