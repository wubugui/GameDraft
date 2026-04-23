"""agents/ —— 三层架构的次顶层（Agent 抽象）。

业务节点的唯一接入；内部调度 4 种 Runner：
- ClineRunner：起 cline CLI 子进程；凭据从 ProviderService 取
- SimpleChatRunner：内部调 LLMService.chat 一次
- ReActRunner：多轮 ReAct loop（LLMService + 本地 tools）
- ExternalRunner：通用 subprocess（aider / codex 等）

LLMService 是本层的内部依赖；不暴露给业务节点。
"""
from __future__ import annotations

from tools.chronicle_sim_v3.agents.config import (
    AgentDef,
    AgentsConfig,
    load_agents_config,
    load_agents_config_text,
)
from tools.chronicle_sim_v3.agents.errors import (
    AgentConfigError,
    AgentError,
    AgentRunnerError,
    AgentTimeoutError,
)
from tools.chronicle_sim_v3.agents.resolver import AgentResolver, ResolvedAgent
from tools.chronicle_sim_v3.agents.service import AgentService
from tools.chronicle_sim_v3.agents.types import (
    AgentObserver,
    AgentRef,
    AgentResult,
    AgentTask,
    NullAgentObserver,
)

__all__ = [
    "AgentConfigError",
    "AgentDef",
    "AgentError",
    "AgentObserver",
    "AgentRef",
    "AgentResolver",
    "AgentResult",
    "AgentRunnerError",
    "AgentService",
    "AgentTask",
    "AgentTimeoutError",
    "AgentsConfig",
    "NullAgentObserver",
    "ResolvedAgent",
    "load_agents_config",
    "load_agents_config_text",
]
