from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter

from tools.chronicle_sim.core.llm.client_factory import LLMClient
from tools.chronicle_sim.core.llm.json_extract import LLMJSONError, parse_json_lenient
from tools.chronicle_sim.core.runtime.agent_state import AgentState
from tools.chronicle_sim.core.runtime.base_agent import BaseAgent
from tools.chronicle_sim.core.runtime.event_bus import EventBus
from tools.chronicle_sim.core.runtime.history_buffer import HistoryBuffer
from tools.chronicle_sim.core.runtime.memory_store import MemoryStore
from tools.chronicle_sim.core.schema.event_draft import EventDraft
from tools.chronicle_sim.core.schema.event_record import EventRecord, WitnessAccount


_records_adapter = TypeAdapter(list[EventRecord])


class GMAgent(BaseAgent):
    def __init__(
        self,
        llm: LLMClient,
        memory: MemoryStore,
        history: HistoryBuffer,
        state: AgentState,
        bus: EventBus,
        prompts_dir: Path,
    ) -> None:
        super().__init__("gm_world", llm, memory, history, state, bus)
        self._prompts_dir = prompts_dir

    def _system(self) -> str:
        p = self._prompts_dir / "gm_agent.md"
        if p.is_file():
            return p.read_text(encoding="utf-8")
        return "你是世界机器 GM，裁决事件草案，输出 EventRecord 的 JSON：truth_json、witness_accounts 列表。"

    async def arbitrate(
        self,
        week: int,
        drafts: list[EventDraft],
        world_context: str = "",
    ) -> list[EventRecord]:
        payload = {
            "week": week,
            "drafts": [d.model_dump() for d in drafts],
            "context": world_context,
        }
        messages = [
            {"role": "system", "content": self._system()},
            {
                "role": "user",
                "content": "输入：\n"
                + json.dumps(payload, ensure_ascii=False)
                + "\n请输出 JSON 数组 records，每项含 id,type_id,week_number,location_id,truth_json,director_draft_json,witness_accounts[{agent_id,account_text,supernatural_hint}],tags,supernatural_level",
            },
        ]
        last_err: Exception | None = None
        for attempt in range(3):
            try:
                resp = await self.llm.chat(messages, json_schema={"type": "object"}, temperature=0.4)
                parsed = parse_json_lenient(resp.text)
                if isinstance(parsed, list):
                    records_raw: Any = parsed
                elif isinstance(parsed, dict):
                    records_raw = parsed.get("records")
                    if records_raw is None:
                        raise ValueError("JSON 对象缺少 records 数组")
                    if isinstance(records_raw, dict):
                        records_raw = [records_raw]
                    elif not isinstance(records_raw, list):
                        raise ValueError("records 必须为数组")
                else:
                    raise ValueError(f"无法解析 GM 输出，得到 {type(parsed).__name__}")
                out = _records_adapter.validate_python(records_raw)
                if not out:
                    raise ValueError("records 为空")
                return out
            except (LLMJSONError, ValueError, TypeError) as e:
                last_err = e
                if attempt < 2:
                    if attempt == 0:
                        hint = (
                            f"上次输出无法通过校验：{e}。请仅输出合法 JSON，顶层含 records 数组，"
                            "字段类型与 WitnessAccount 一致。"
                        )
                    else:
                        hint = (
                            f"仍无法通过：{e}。下一回复仅输出 JSON：从首字符即为 {{ 或 [，无围栏无说明；"
                            "顶层须含 records 数组。"
                        )
                    messages = list(messages) + [{"role": "user", "content": hint}]
                    continue
                raise RuntimeError(f"GM 输出无法解析为 EventRecord 列表：{e}") from e
        raise RuntimeError(f"GM 失败：{last_err}") from last_err

    async def step(self, week: int) -> Any:
        return None
