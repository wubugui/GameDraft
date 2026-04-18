from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.chronicle_sim.core.llm.client_factory import LLMClient
from tools.chronicle_sim.core.runtime.agent_state import AgentState
from tools.chronicle_sim.core.runtime.base_agent import BaseAgent
from tools.chronicle_sim.core.runtime.event_bus import EventBus
from tools.chronicle_sim.core.runtime.history_buffer import HistoryBuffer
from tools.chronicle_sim.core.runtime.memory_store import MemoryStore


class MonthHistorianAgent(BaseAgent):
    def __init__(
        self,
        llm: LLMClient,
        memory: MemoryStore,
        history: HistoryBuffer,
        state: AgentState,
        bus: EventBus,
        prompts_dir: Path,
    ) -> None:
        super().__init__("month_historian", llm, memory, history, state, bus)
        self._prompts_dir = prompts_dir

    async def summarize_month(self, week_start: int, week_end: int, prior_text: str) -> str:
        p = self._prompts_dir / "month_historian.md"
        system = p.read_text(encoding="utf-8") if p.is_file() else "你是月度史官，综合数周纪要写一章编年体摘要。"
        messages = [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": f"周次 {week_start}-{week_end} 的周报合集：\n{prior_text}\n请写月度编年摘要。",
            },
        ]
        resp = await self.llm.chat(messages, temperature=0.55)
        return resp.text

    async def step(self, week: int) -> Any:
        return None
