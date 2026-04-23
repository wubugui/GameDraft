"""Node 抽象（RFC v3-engine.md §6）。

NodeKindSpec / Param 定义节点元信息；Node Protocol 定义运行期协议。
NodeServices 是 cook 时引擎注入的服务包；NodeOutput 含输出值与 mutation。
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

from tools.chronicle_sim_v3.engine.context import ContextRead, Mutation
from tools.chronicle_sim_v3.engine.errors import EngineError
from tools.chronicle_sim_v3.engine.types import PortSpec


# ---------- 元信息 ----------


@dataclass(frozen=True)
class Param:
    name: str
    type: Literal[
        "int", "float", "str", "bool", "json", "enum", "expr",
        "subgraph_ref", "preset_ref",
    ]
    required: bool = True
    default: Any = None
    enum_values: tuple[str, ...] | None = None
    doc: str = ""


@dataclass(frozen=True)
class NodeKindSpec:
    """Node 元信息。frozen 保证注册后不可变。"""

    kind: str
    category: str
    title: str
    description: str
    inputs: tuple[PortSpec, ...]
    outputs: tuple[PortSpec, ...]
    params: tuple[Param, ...] = ()
    reads: frozenset[str] = field(default_factory=frozenset)
    writes: frozenset[str] = field(default_factory=frozenset)
    version: str = "1"
    cacheable: bool = True
    deterministic: bool = True
    color: str = "#cbd5e0"
    icon: str = ""

    def output_names(self) -> set[str]:
        return {p.name for p in self.outputs}

    def input_names(self) -> set[str]:
        return {p.name for p in self.inputs}

    def param_by_name(self, name: str) -> Param | None:
        for p in self.params:
            if p.name == name:
                return p
        return None


# ---------- 节点输出 ----------


@dataclass
class NodeEvent:
    """节点自定义观测事件（services.eventbus.emit）。"""

    name: str
    payload: dict = field(default_factory=dict)


@dataclass
class NodeOutput:
    values: dict[str, Any] = field(default_factory=dict)
    mutations: list[Mutation] = field(default_factory=list)
    events: list[NodeEvent] = field(default_factory=list)


# ---------- 服务包（被 cook 注入）----------


class _NullChroma:
    """P1 占位 chroma；P2 chroma.* 节点接入时再实现。"""

    pass


class _NullEventBus:
    def emit(self, event: dict) -> None:
        return None


@dataclass
class NodeServices:
    """cook 时引擎传入的服务包。各服务可选 None 表示该 cook 未启用。

    三层架构后：
    - 业务节点只能用 `agents`（AgentService）做 LLM/Agent 调用
    - `_llm` 为内部字段，仅供 agents 层内部使用；CI lint 限制业务节点访问
    """

    agents: Any = None                         # AgentService
    _llm: Any = None                           # LLMService（仅内部使用）
    rng: random.Random = field(default_factory=random.Random)
    clock: Any = None
    chroma: Any = field(default_factory=_NullChroma)
    eventbus: Any = field(default_factory=_NullEventBus)
    artifacts: Any = None
    spec_search_root: Any = None               # 给 agent runner 找 spec 文件用


# ---------- Node Protocol ----------


@runtime_checkable
class Node(Protocol):
    spec: NodeKindSpec

    async def cook(
        self,
        ctx: ContextRead,
        inputs: dict[str, Any],
        params: dict[str, Any],
        services: NodeServices,
        cancel: Any,
    ) -> NodeOutput: ...


# ---------- 错误 ----------


class NodeBusinessError(EngineError):
    """节点业务错误：含 details，便于落 timeline / audit。"""

    def __init__(self, message: str, *, details: dict | None = None) -> None:
        super().__init__(message)
        self.details = details or {}


class NodeCookError(EngineError):
    """引擎包装：含 cook_id / node_id / 原异常。"""

    def __init__(
        self,
        message: str,
        *,
        cook_id: str = "",
        node_id: str = "",
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message)
        self.cook_id = cook_id
        self.node_id = node_id
        self.cause = cause
