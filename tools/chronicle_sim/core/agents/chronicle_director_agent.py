from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter

from tools.chronicle_sim.core.llm.client_factory import LLMClient
from tools.chronicle_sim.core.llm.json_extract import LLMJSONError, parse_json_object
from tools.chronicle_sim.core.runtime.agent_state import AgentState
from tools.chronicle_sim.core.runtime.base_agent import BaseAgent
from tools.chronicle_sim.core.runtime.event_bus import EventBus
from tools.chronicle_sim.core.runtime.history_buffer import HistoryBuffer
from tools.chronicle_sim.core.runtime.memory_store import MemoryStore
from tools.chronicle_sim.core.schema.event_draft import EventDraft
from tools.chronicle_sim.core.schema.event_type import EventTypeDef
from tools.chronicle_sim.core.schema.week_intent import WeekIntent

_DIRECTOR_CTX_MAX_CHARS = 48_000

_drafts_adapter = TypeAdapter(list[EventDraft])


class ChronicleDirectorAgent(BaseAgent):
    def __init__(
        self,
        llm: LLMClient,
        memory: MemoryStore,
        history: HistoryBuffer,
        state: AgentState,
        bus: EventBus,
        prompts_dir: Path,
    ) -> None:
        super().__init__("chronicle_director", llm, memory, history, state, bus)
        self._prompts_dir = prompts_dir

    def _system(self) -> str:
        p = self._prompts_dir / "chronicle_director.md"
        if p.is_file():
            return p.read_text(encoding="utf-8")
        return "你是编年史编导，根据事件类型与 NPC 意图，产出 EventDraft 列表 JSON。"

    async def produce_drafts(
        self,
        week: int,
        intents: list[WeekIntent],
        picked_types: list[tuple[EventTypeDef, float, str]],
        pacing_note: str = "",
        extra_context: str = "",
    ) -> list[EventDraft]:
        ctx = extra_context
        truncated = False
        if len(ctx) > _DIRECTOR_CTX_MAX_CHARS:
            ctx = ctx[:_DIRECTOR_CTX_MAX_CHARS]
            truncated = True
        payload = {
            "week": week,
            "intents": [i.model_dump() for i in intents],
            "event_types": [t[0].id for t in picked_types],
            "pacing_note": pacing_note,
            "extra_context": ctx,
            "_context_truncated": truncated,
            "_context_original_chars": len(extra_context),
        }
        user_tail = (
            "\n输出 JSON：{ \"drafts\": [ {type_id, week, location_id, actor_ids, summary, draft_json} ] }"
            "\n草案数量应与 event_types 条目数大致相当（每条类型至少一条草案），勿合并为单条。"
        )
        messages = [
            {"role": "system", "content": self._system()},
            {
                "role": "user",
                "content": json.dumps(payload, ensure_ascii=False) + user_tail,
            },
        ]
        last_err: Exception | None = None
        for attempt in range(3):
            try:
                resp = await self.llm.chat(messages, json_schema={"type": "object"}, temperature=0.75)
                data = parse_json_object(resp.text)
                drafts_raw = data.get("drafts") or []
                if not isinstance(drafts_raw, list):
                    raise ValueError("drafts 必须为数组")
                out = _drafts_adapter.validate_python(drafts_raw)
                if not out:
                    raise ValueError("drafts 为空")
                return out
            except (LLMJSONError, ValueError, TypeError) as e:
                last_err = e
                if attempt < 2:
                    if attempt == 0:
                        hint = (
                            f"上次输出无法通过校验：{e}。请仅输出顶层含 drafts 数组的 JSON，元素符合 EventDraft 字段。"
                        )
                    else:
                        hint = (
                            f"仍无法通过：{e}。下一回复仅输出 JSON：从首字符即为 {{，无围栏无说明；顶层 drafts 为数组。"
                        )
                    messages = list(messages) + [{"role": "user", "content": hint}]
                    continue
                raise RuntimeError(f"导演输出无法解析为 EventDraft 列表：{e}") from e
        raise RuntimeError(f"导演失败：{last_err}") from last_err

    async def step(self, week: int) -> Any:
        return None
