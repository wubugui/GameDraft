"""AgentResolver —— 把逻辑 agent id 解析为 ResolvedAgent。

ResolvedAgent.agent_hash 计算稳定指纹（不含 api_key），用于缓存键。
"""
from __future__ import annotations

from dataclasses import dataclass, field

from tools.chronicle_sim_v3.agents.config import AgentDef, AgentsConfig
from tools.chronicle_sim_v3.agents.errors import AgentConfigError, AgentRouteError
from tools.chronicle_sim_v3.engine.canonical import canonical_json, sha256_hex


@dataclass(frozen=True)
class ResolvedAgent:
    logical: str             # routes 的 key
    physical: str            # agents 的 key
    runner_kind: str         # cline / simple_chat / react / external
    provider_id: str | None  # cline / external 用
    llm_route: str | None    # simple_chat / react 用
    model_id: str
    timeout_sec: int
    config: dict = field(default_factory=dict)
    agent_hash: str = ""


class AgentResolver:
    def __init__(self, config: AgentsConfig) -> None:
        self.config = config

    def resolve(self, logical: str) -> ResolvedAgent:
        physical = self.config.routes.get(logical) or logical
        adef: AgentDef | None = self.config.agents.get(physical)
        if adef is None:
            raise AgentRouteError(
                f"未知 agent: logical={logical!r} physical={physical!r}; "
                f"已注册：{sorted(self.config.agents.keys())}"
            )
        payload = {
            "physical": physical,
            "runner": adef.runner,
            "provider": adef.provider,
            "llm_route": adef.llm_route,
            "model_id": adef.model_id,
            "config": dict(adef.config),
            "timeout_sec": adef.timeout_sec,
        }
        agent_hash = sha256_hex(canonical_json(payload))[:16]
        return ResolvedAgent(
            logical=logical,
            physical=physical,
            runner_kind=adef.runner,
            provider_id=adef.provider,
            llm_route=adef.llm_route,
            model_id=adef.model_id,
            timeout_sec=adef.timeout_sec,
            config=dict(adef.config),
            agent_hash=agent_hash,
        )

    def list_logical(self) -> list[str]:
        return sorted(self.config.routes.keys())

    def list_physical(self) -> list[str]:
        return sorted(self.config.agents.keys())
