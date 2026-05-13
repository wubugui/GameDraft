"""agents.yaml 加载 + 校验。

约束（plan §5.3 / §16）：
- 每个 agent 必须 **且只能** 有 `provider` 之一或 `llm_route` 之一
  - cline / external 用 `provider`（直接拿凭据，不经 LLMService）
  - simple_chat / react 用 `llm_route`（走 LLMService.Resolver）
- runner ∈ {cline, simple_chat, react, external}
- routes 必须把所有引用过的逻辑 agent 名映射到注册的物理 agent
- 生产逻辑角色必须走 cline（npc/director/gm/rumor/summary/initializer）
- 字面 api_key 拒绝（即便 agents.yaml 不该写 key）
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from tools.chronicle_sim_v3.agents.errors import AgentConfigError
from tools.chronicle_sim_v3.engine.io import read_yaml

_RUNNER_KINDS = {"cline", "simple_chat", "react", "external"}
_PRODUCTION_LOGICAL_ROUTES = frozenset(
    {"npc", "director", "gm", "rumor", "summary", "initializer"}
)


class AgentDef(BaseModel):
    runner: str
    # 二选一：cline / external 用 provider；simple_chat / react 用 llm_route
    provider: str | None = None
    llm_route: str | None = None
    model_id: str = ""
    timeout_sec: int = 600
    config: dict = Field(default_factory=dict)

    @field_validator("runner")
    @classmethod
    def _runner_known(cls, v: str) -> str:
        if v not in _RUNNER_KINDS:
            raise ValueError(
                f"未知 runner {v!r}；允许：{sorted(_RUNNER_KINDS)}"
            )
        return v

    @model_validator(mode="after")
    def _check_provider_or_llm_route(self) -> "AgentDef":
        has_p = bool(self.provider)
        has_r = bool(self.llm_route)
        if has_p == has_r:
            raise ValueError(
                f"runner={self.runner} 必须且只能配 provider 或 llm_route 之一"
            )
        if self.runner in ("cline", "external") and not has_p:
            raise ValueError(
                f"runner={self.runner} 必须配 provider（直接拿凭据，不经 LLM 层）"
            )
        if self.runner in ("simple_chat", "react") and not has_r:
            raise ValueError(
                f"runner={self.runner} 必须配 llm_route（走 LLMService）"
            )
        return self


class AgentLimiterConfig(BaseModel):
    per_runner: dict[str, int] = Field(
        default_factory=lambda: {
            "cline": 1,
            "simple_chat": 4,
            "react": 2,
            "external": 1,
        }
    )


class AgentCacheConfig(BaseModel):
    enabled: bool = True
    default_mode: Literal["off", "hash", "exact"] = "hash"
    per_route: dict[str, Literal["off", "hash", "exact"]] = Field(default_factory=dict)


class AgentAuditConfig(BaseModel):
    enabled: bool = True
    log_user_prompt: bool = False
    log_user_prompt_max_chars: int = 4000


class AgentsConfig(BaseModel):
    schema_version: str = Field(alias="schema")
    agents: dict[str, AgentDef]
    routes: dict[str, str] = Field(default_factory=dict)
    limiter: AgentLimiterConfig = Field(default_factory=AgentLimiterConfig)
    cache: AgentCacheConfig = Field(default_factory=AgentCacheConfig)
    audit: AgentAuditConfig = Field(default_factory=AgentAuditConfig)

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _check_routes(self) -> "AgentsConfig":
        for logical, physical in self.routes.items():
            if physical not in self.agents:
                raise ValueError(
                    f"routes {logical}→{physical} 但 {physical} 未在 agents 注册"
                )
            adef = self.agents[physical]
            if logical in _PRODUCTION_LOGICAL_ROUTES and adef.runner != "cline":
                raise ValueError(
                    f"逻辑 route {logical!r} 必须指向 runner=cline 的 agent，"
                    f"当前为 {physical!r} (runner={adef.runner})"
                )
        return self


_LITERAL_KEY_RE = re.compile(r"(?m)^\s*api_key\s*:")


def _scan_literal_api_key(text: str) -> None:
    for m in _LITERAL_KEY_RE.finditer(text):
        line_end = text.find("\n", m.end())
        line = text[m.start(): line_end if line_end >= 0 else len(text)]
        if "api_key_ref" in line:
            continue
        raise AgentConfigError(
            "agents.yaml 出现字面 'api_key:'，凭据请放 providers.yaml 并通过 "
            "provider_id 引用"
        )


def _to_plain(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _to_plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_plain(v) for v in value]
    return value


def load_agents_config(run_dir: Path) -> AgentsConfig:
    p = (Path(run_dir) / "config" / "agents.yaml").resolve()
    if not p.is_file():
        raise AgentConfigError(f"agents.yaml 不存在: {p}")
    text = p.read_text(encoding="utf-8")
    _scan_literal_api_key(text)
    raw = read_yaml(p)
    if not isinstance(raw, dict):
        raise AgentConfigError("agents.yaml 顶层必须是 mapping")
    try:
        return AgentsConfig.model_validate(_to_plain(raw))
    except Exception as e:
        raise AgentConfigError(f"agents.yaml 校验失败: {e}") from e


def load_agents_config_text(text: str) -> AgentsConfig:
    _scan_literal_api_key(text)
    from tools.chronicle_sim_v3.engine.io import read_yaml_text

    raw = read_yaml_text(text)
    if not isinstance(raw, dict):
        raise AgentConfigError("agents.yaml 顶层必须是 mapping")
    try:
        return AgentsConfig.model_validate(_to_plain(raw))
    except Exception as e:
        raise AgentConfigError(f"agents.yaml 校验失败: {e}") from e
