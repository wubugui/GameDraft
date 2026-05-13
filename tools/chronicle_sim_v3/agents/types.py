"""Agent 公共数据类。

`AgentTask` 是 Agent 任务的全部输入；`AgentResult` 是统一输出
（兼顾 Cline 子进程 / SimpleChat / ReAct / External 四种 runner）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol


@dataclass
class AgentRef:
    """节点端构造的 agent 调用引用（薄）。"""

    role: str          # 业务侧角色标签（npc / director / probe ...）
    agent: str         # 逻辑 agent id（agents.yaml routes 的 key）
    output_kind: Literal["text", "json_object", "json_array", "jsonl"] = "text"
    artifact_filename: str = ""
    json_schema: dict | None = None
    cache: Literal["off", "hash", "exact", "auto"] = "auto"
    timeout_sec: int | None = None


@dataclass
class AgentTask:
    """Agent 任务输入。"""

    spec_ref: str                              # data/agent_specs/<x>.toml or '_inline'
    vars: dict[str, Any] = field(default_factory=dict)
    system_extra: str = ""
    extra_argv: list[str] = field(default_factory=list)
    # extra_argv 用于 ExternalRunner 的额外命令行参数透传


@dataclass
class AgentResult:
    """Agent 调用统一输出。"""

    text: str
    parsed: Any = None
    tool_log: list[dict] = field(default_factory=list)
    exit_code: int = 0
    cache_hit: bool = False
    cached_at: str | None = None
    timings: dict[str, int] = field(default_factory=dict)
    audit_id: str = ""
    agent_run_id: str = ""             # ULID，agent-level 的运行标识
    physical_agent: str = ""           # 物理 agent_id
    runner_kind: str = ""              # cline / simple_chat / react / external
    llm_calls_count: int | None = None  # SimpleChat=1 / ReAct=N / Cline/External=None


class AgentObserver(Protocol):
    """Agent 流水观察者（流式日志 / debug UI 用）。"""

    def on_phase(self, phase: str, info: dict) -> None: ...

    def on_tool_call(self, tool: str, args: dict, result: Any) -> None: ...

    def on_log_line(self, source: str, line: str) -> None: ...


class NullAgentObserver:
    def on_phase(self, phase: str, info: dict) -> None:  # noqa: D401
        return None

    def on_tool_call(self, tool: str, args: dict, result: Any) -> None:
        return None

    def on_log_line(self, source: str, line: str) -> None:
        return None
