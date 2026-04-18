from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.chronicle_sim.core.llm.client_factory import LLMClient
from tools.chronicle_sim.core.runtime.agent_state import AgentState
from tools.chronicle_sim.core.runtime.base_agent import BaseAgent
from tools.chronicle_sim.core.runtime.event_bus import EventBus
from tools.chronicle_sim.core.runtime.history_buffer import HistoryBuffer
from tools.chronicle_sim.core.runtime.memory_store import MemoryStore


class StyleRewriterAgent(BaseAgent):
    def __init__(
        self,
        llm: LLMClient,
        memory: MemoryStore,
        history: HistoryBuffer,
        state: AgentState,
        bus: EventBus,
        prompts_dir: Path,
    ) -> None:
        super().__init__("style_rewriter", llm, memory, history, state, bus)
        self._prompts_dir = prompts_dir

    async def rewrite(self, text: str, fingerprint_hint: str = "") -> str:
        p = self._prompts_dir / "style_rewriter.md"
        system = p.read_text(encoding="utf-8") if p.is_file() else "将下文润色为川渝口语与民国江湖味，勿出现现代词。"
        messages = [
            {"role": "system", "content": system + "\n" + fingerprint_hint},
            {"role": "user", "content": text},
        ]
        resp = await self.llm.chat(messages, temperature=0.5)
        return resp.text

    async def step(self, week: int) -> Any:
        return None
