from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.chronicle_sim.core.llm.client_factory import LLMClient
from tools.chronicle_sim.core.runtime.agent_state import AgentState
from tools.chronicle_sim.core.runtime.base_agent import BaseAgent
from tools.chronicle_sim.core.runtime.event_bus import EventBus
from tools.chronicle_sim.core.runtime.history_buffer import HistoryBuffer
from tools.chronicle_sim.core.runtime.memory_store import MemoryStore


class WeekSummarizerAgent(BaseAgent):
    def __init__(
        self,
        llm: LLMClient,
        memory: MemoryStore,
        history: HistoryBuffer,
        state: AgentState,
        bus: EventBus,
        prompts_dir: Path,
    ) -> None:
        super().__init__("week_summarizer", llm, memory, history, state, bus)
        self._prompts_dir = prompts_dir

    async def summarize_week(self, week: int, events_blob: str) -> str:
        sys_p = self._prompts_dir / "week_summarizer.md"
        system = sys_p.read_text(encoding="utf-8") if sys_p.is_file() else "你是周史官，用川渝民国口吻写本周纪要。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"第{week}周事件 JSON：\n{events_blob}\n请写3-8 段周纪。"},
        ]
        resp = await self.llm.chat(messages, temperature=0.65)
        return resp.text

    async def step(self, week: int) -> Any:
        return None
