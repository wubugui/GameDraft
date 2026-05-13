"""agents/runners/ —— 4 种 Runner 实现。

ClineRunner / SimpleChatRunner / ReActRunner / ExternalRunner

由 AgentService 在 _build_runner 中懒构造；外部不直接 import 具体 runner。
"""
from __future__ import annotations

from tools.chronicle_sim_v3.agents.runners.base import (
    AgentRunner,
    AgentRunnerContext,
    SubprocessAgentRunner,
)

__all__ = [
    "AgentRunner",
    "AgentRunnerContext",
    "SubprocessAgentRunner",
]
