from __future__ import annotations

import json
import uuid
from typing import Any

from tools.chronicle_sim.core.llm.adapter import LLMAdapter, LLMResponse


class StubLLMAdapter(LLMAdapter):
    """离线占位：按任务类型显式分支，禁止用语义含糊的 drafts 子串误伤 GM。"""

    async def chat(
        self,
        messages: list[dict[str, str]],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        json_schema: dict[str, Any] | None = None,
    ) -> LLMResponse:
        joined = "\n".join(m.get("content", "") for m in messages)
        if "【传闻改写任务】" in joined:
            return LLMResponse(text="码头上有人风传，昨夜货栈闹出动静，细节对不上号，当不得真。")

        if "请输出 JSON 数组 records" in joined:
            rid = uuid.uuid4().hex[:12]
            payload = {
                "records": [
                    {
                        "id": rid,
                        "week_number": 1,
                        "type_id": "misc",
                        "location_id": None,
                        "truth_json": {"note": "Stub GM 占位裁决"},
                        "director_draft_json": {},
                        "witness_accounts": [
                            {
                                "agent_id": "stub_witness",
                                "account_text": "风闻码头有动静，细节说不清。",
                                "supernatural_hint": "",
                            }
                        ],
                        "rumor_versions": [],
                        "tags": [],
                        "supernatural_level": "none",
                    }
                ]
            }
            return LLMResponse(text=json.dumps(payload, ensure_ascii=False))

        if "每条类型至少一条草案" in joined or (
            "event_types" in joined and "pacing_note" in joined and '"drafts"' in joined
        ):
            payload = {
                "drafts": [
                    {
                        "type_id": "river_dispute",
                        "week": 1,
                        "location_id": "dock_east",
                        "actor_ids": [],
                        "summary": "东码头因分货起口角，尚未动手。",
                        "draft_json": {},
                    },
                    {
                        "type_id": "teahouse_gossip",
                        "week": 1,
                        "location_id": None,
                        "actor_ids": [],
                        "summary": "茶馆里有人嚼舌根。",
                        "draft_json": {},
                    },
                ]
            }
            return LLMResponse(text=json.dumps(payload, ensure_ascii=False))

        if "你是游戏世界策划助手" in joined:
            payload = {
                "world_setting": {
                    "title": "Stub 世界观",
                    "logline": "离线占位种子",
                    "era_and_place": "民国",
                    "tone_and_themes": "江湖",
                    "raw_author_notes": "stub",
                },
                "design_pillars": [
                    {
                        "id": "p1",
                        "name": "占位支柱",
                        "description": "stub",
                        "implications": "",
                    }
                ],
                "custom_sections": [],
                "agents": [
                    {
                        "id": "stub_npc_a",
                        "name": "路人甲",
                        "suggested_tier": "B",
                        "reason": "stub",
                        "faction_hint": "",
                        "location_hint": "",
                        "personality_tags": [],
                        "secret_tags": [],
                    }
                ],
                "factions": [],
                "locations": [],
                "relationships": [],
                "anchor_events": [],
                "social_graph_edges": [],
                "event_type_candidates": [],
            }
            return LLMResponse(text=json.dumps(payload, ensure_ascii=False))

        if "请输出一个 JSON 对象" in joined and "mood_delta" in joined and "relationship_hints" in joined:
            payload = {
                "agent_id": "stub_npc",
                "week": 1,
                "mood_delta": "略紧",
                "intent_text": "本周想摸清码头动向，少惹袍哥。",
                "target_ids": [],
                "relationship_hints": [],
            }
            return LLMResponse(text=json.dumps(payload, ensure_ascii=False))

        return LLMResponse(text="（StubLLM）未识别任务。请改用 openai_compat 或 ollama。")
