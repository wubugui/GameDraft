from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.chronicle_sim.core.llm.client_factory import LLMClient
from tools.chronicle_sim.core.llm.json_extract import LLMJSONError, parse_json_object
from tools.chronicle_sim.core.runtime.agent_state import AgentState
from tools.chronicle_sim.core.runtime.base_agent import BaseAgent
from tools.chronicle_sim.core.runtime.event_bus import EventBus
from tools.chronicle_sim.core.runtime.history_buffer import HistoryBuffer
from tools.chronicle_sim.core.runtime.memory_store import MemoryStore
from tools.chronicle_sim.core.schema.models import NpcTier
from tools.chronicle_sim.core.schema.week_intent import WeekIntent


def _load_prompt(path: Path, fallback: str) -> str:
    if path.is_file():
        return path.read_text(encoding="utf-8")
    return fallback


class NPCAgent(BaseAgent):
    def __init__(
        self,
        agent_id: str,
        name: str,
        tier: NpcTier,
        llm: LLMClient,
        memory: MemoryStore,
        history: HistoryBuffer,
        state: AgentState,
        bus: EventBus,
        prompts_dir: Path,
        profile_extras: str = "",
    ) -> None:
        super().__init__(agent_id, llm, memory, history, state, bus)
        self.name = name
        self.tier = tier
        self._prompts_dir = prompts_dir
        self._profile_extras = profile_extras

    def _system_prompt(self) -> str:
        if self.tier == NpcTier.S:
            base = _load_prompt(
                self._prompts_dir / "npc_tier_s.md",
                "你是民国川渝背景的 NPC，只输出合法 JSON，对应 WeekIntent 字段。",
            )
        elif self.tier == NpcTier.B:
            base = _load_prompt(
                self._prompts_dir / "npc_tier_b.md",
                "你是龙套 NPC，输出简短 WeekIntent JSON。",
            )
        else:
            base = _load_prompt(
                self._prompts_dir / "npc_tier_a.md",
                "你是配角 NPC，输出简化 WeekIntent JSON：mood_delta、intent_text、对主角关系的 hints。",
            )
        return f"{base}\n\n身份：{self.name}（id={self.id}，tier={self.tier.value}）\n{self._profile_extras}"

    async def remember(self, obs: dict[str, Any]) -> list[dict[str, Any]]:
        week = int(obs.get("week", 0))
        query = (
            f"{self.name}（{self.id}）第{week}周：人际、恩怨、计划、所见所闻、与剧情相关的关切"
        )
        if self.memory.has_vector_memory:
            rows = await self.memory.recall_semantic(
                query, limit=10, recency_k=2, caller_id=self.id
            )
            if rows:
                return rows
        return await self.memory.recent_locked(limit=10, caller_id=self.id)

    async def step(self, week: int) -> WeekIntent:
        obs = await self.perceive(week)
        recalled = await self.remember(obs)
        recall_txt = "\n".join(
            f"[第{r.get('week', '?')}周] {(r.get('content') or '')[:420]}"
            for r in recalled[:8]
        )
        user = (
            f"本周={week}。记忆片段（含语义检索与最近周次）：\n{recall_txt}\n"
            "请输出一个 JSON 对象，键：agent_id, week, mood_delta, intent_text, target_ids, relationship_hints。"
            "类型：mood_delta 为短字符串（勿用数值）；target_ids 与 relationship_hints 均为字符串数组（单句也写 [\"……\"]）。"
        )
        self.history.append("user", user)
        messages = [
            {"role": "system", "content": self._system_prompt()},
            {"role": "user", "content": user},
        ]
        last_err: Exception | None = None
        data: dict[str, Any] | None = None
        for attempt in range(3):
            try:
                resp = await self.llm.chat(messages, json_schema={"type": "object"}, temperature=0.6)
                data = parse_json_object(resp.text)
                break
            except LLMJSONError as e:
                last_err = e
                if attempt < 2:
                    if attempt == 0:
                        hint = (
                            f"上次输出非合法 JSON 对象：{e}。请仅输出一个 JSON 对象，键：agent_id, week, mood_delta, "
                            "intent_text, target_ids, relationship_hints；mood_delta 为字符串，后二者为字符串数组。"
                        )
                    else:
                        hint = (
                            f"仍无法解析：{e}。下一回复仅输出 JSON对象：从首字符即为 {{，无围栏无说明；键名用双引号。"
                        )
                    messages = list(messages) + [{"role": "user", "content": hint}]
                    continue
                raise RuntimeError(f"NPC {self.id} WeekIntent JSON 无效：{e}") from e
        if data is None:
            raise RuntimeError(f"NPC {self.id} 无有效意图：{last_err}")
        data["agent_id"] = self.id
        data["week"] = week
        intent = WeekIntent.model_validate(data)
        summary = await self.reflect(obs, recalled)
        if not summary:
            summary = f"意图：{intent.intent_text}"
        await self.memory.write_with_embedding(week, summary, caller_id=self.id)
        await self.bus.publish(
            "week_intent",
            {"agent_id": self.id, "week": week, "intent": intent.model_dump()},
        )
        return intent
