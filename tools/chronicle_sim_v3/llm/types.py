"""LLM 公共数据类（RFC v3-llm.md §3.1 / §4.1 / §4.3）。

三层架构调整后：
- ResolvedModel 不再含 `backend`，改用 `invocation`（physical 调用方式）
- 同时携带 `provider_id` 便于审计 / 缓存
- 不再含 `ollama_host`（统一用 `base_url`）
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass
class Prompt:
    """渲染前的 prompt 描述。"""

    spec_ref: str
    vars: dict[str, Any] = field(default_factory=dict)
    system_extra: str = ""


@dataclass
class OutputSpec:
    kind: Literal["text", "json_object", "json_array", "jsonl"]
    artifact_filename: str = ""
    json_schema: dict | None = None

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "artifact_filename": self.artifact_filename,
            "json_schema": self.json_schema,
        }


@dataclass
class LLMRef:
    """节点端构造的调用引用。"""

    role: str
    model: str
    output: OutputSpec
    # "auto" = 沿用 cache.per_route[route] 或 cache.default_mode；
    # "off"/"hash"/"exact" = 显式覆盖
    cache: Literal["off", "hash", "exact", "auto"] = "auto"
    timeout_sec: int | None = None
    retry_max_attempts: int | None = None
    extra_argv: list[str] = field(default_factory=list)


@dataclass
class LLMResult:
    text: str
    parsed: Any = None
    tool_log: list[dict] = field(default_factory=list)
    exit_code: int = 0
    cache_hit: bool = False
    cached_at: str | None = None
    timings: dict[str, int] = field(default_factory=dict)
    audit_id: str = ""
    raw_response: dict | None = None
    physical_model: str = ""
    tokens_in: int | None = None
    tokens_out: int | None = None


@dataclass(frozen=True)
class ResolvedModel:
    """逻辑路由 → (provider, model_id, invocation) 解析结果。

    `invocation` 取代旧 `backend` 概念，明确表示 LLM 层使用的调用方式：
    `openai_compat_chat` / `openai_compat_embed` / `ollama_chat` / `ollama_embed` / `stub`
    """

    logical: str
    physical: str
    provider_id: str
    invocation: str
    base_url: str
    api_key: str
    model_id: str
    extra: dict
    route_hash: str

    # 向后兼容只读别名：旧代码读 .backend → invocation
    @property
    def backend(self) -> str:
        return self.invocation


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 3
    backoff: Literal["exp", "fixed"] = "exp"
    base_ms: int = 800
    retry_on: tuple[str, ...] = (
        "timeout", "network", "rate_limit", "server_5xx", "cline_libuv_crash",
    )
    no_retry_on: tuple[str, ...] = ("auth_error", "bad_request")


@dataclass(frozen=True)
class RateLimit:
    qpm: int | None = None
    tpm: int | None = None


@dataclass(frozen=True)
class CallPolicy:
    timeout_sec: int
    retry: RetryPolicy
    rate_limit: RateLimit
    cache_mode: Literal["off", "hash", "exact"]
    audit_log_user_prompt: bool
    audit_log_user_prompt_max_chars: int = 4000
