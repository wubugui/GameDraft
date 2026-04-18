from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from tools.chronicle_sim.core.llm.client_factory import LLMClient
from tools.chronicle_sim.core.runtime.agent_state import AgentState
from tools.chronicle_sim.core.runtime.event_bus import EventBus
from tools.chronicle_sim.core.runtime.history_buffer import HistoryBuffer
from tools.chronicle_sim.core.runtime.memory_store import MemoryStore


class BaseAgent(ABC):
    def __init__(
        self,
        agent_id: str,
        llm: LLMClient,
        memory: MemoryStore,
        history: HistoryBuffer,
        state: AgentState,
        bus: EventBus,
    ) -> None:
        self.id = agent_id
        self.llm = llm
        self.memory = memory
        self.history = history
        self.state = state
        self.bus = bus

    @abstractmethod
    async def step(self, week: int) -> Any:
        raise NotImplementedError

    async def perceive(self, week: int) -> dict[str, Any]:
        return {"week": week, "agent_id": self.id}

    async def remember(self, obs: dict[str, Any]) -> list[dict[str, Any]]:
        if self.memory._sql_lock is not None:
            return await self.memory.recent_locked(limit=10, caller_id=self.id)
        return self.memory.recent(limit=10, caller_id=self.id)

    async def reflect(self, obs: dict[str, Any], recalled: list[dict[str, Any]]) -> str:
        return ""

    async def plan(self, thought: str) -> str:
        return thought

    async def act(self, plan: str) -> Any:
        return None
