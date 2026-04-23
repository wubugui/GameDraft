"""EngineServices —— 引擎注入给所有节点的服务包。

三层架构后：
- 业务节点只能通过 `agents`（AgentService）发起 LLM/Agent 调用
- `_llm` 为内部字段，仅供 agent 层内部 / 调试节点使用；业务节点 lint 禁止访问
- ProviderService 不在这里暴露（仅 agents/llm 内部依赖；业务无需可见）
"""
from __future__ import annotations

import datetime as _dt
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


def _default_chroma():
    from tools.chronicle_sim_v3.engine.chroma_stub import InMemoryChroma

    return InMemoryChroma()


@dataclass
class EngineServices:
    """共享服务；NodeServices 由 Engine 在每节点 cook 时基于此派生。"""

    agents: Any = None        # AgentService（业务唯一接入）
    _llm: Any = None          # LLMService（内部字段；仅 agents/llm 内部 + 调试用）
    chroma: Any = field(default_factory=_default_chroma)
    clock: Callable[[], _dt.datetime] = field(
        default_factory=lambda: lambda: _dt.datetime.now(_dt.timezone.utc)
    )
    rng_factory: Callable[[bytes], random.Random] = field(
        default_factory=lambda: lambda seed: random.Random(int.from_bytes(seed[:8], "big"))
    )
    spec_search_root: Path | None = None
