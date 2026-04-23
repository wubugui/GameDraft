"""Agent 子系统错误体系。"""
from __future__ import annotations


class AgentError(Exception):
    """所有 Agent 错误的基类。"""


class AgentConfigError(AgentError):
    """agents.yaml 加载 / 字段不合法。"""


class AgentRouteError(AgentError):
    """逻辑 agent id 找不到 / runner 未注册。"""


class AgentRunnerError(AgentError):
    """Runner 内部错误（包装 LLMError / 子进程异常）。"""


class AgentTimeoutError(AgentError):
    """整体调用超时。"""


class AgentCancelledError(AgentError):
    """显式取消。"""
