"""离线 Stub：FunctionModel，分支逻辑与旧 StubLLMAdapter 一致。"""
from __future__ import annotations

import json
import uuid
from typing import Any

from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel


def _flatten_stub_context(messages: list[ModelMessage], info: AgentInfo) -> str:
    chunks: list[str] = []
    if info.instructions:
        chunks.append(str(info.instructions))
    for m in messages:
        if isinstance(m, ModelRequest):
            for p in m.parts:
                if isinstance(p, UserPromptPart):
                    c = p.content
                    if isinstance(c, str):
                        chunks.append(c)
                    else:
                        chunks.append(str(c))
                elif isinstance(p, SystemPromptPart):
                    sc = p.content
                    chunks.append(sc if isinstance(sc, str) else str(sc))
        elif isinstance(m, ModelResponse):
            for p in m.parts:
                if isinstance(p, TextPart) and p.content:
                    chunks.append(p.content)
    return "\n".join(chunks)


def _stub_text(joined: str) -> str:
    if "【传闻改写任务】" in joined:
        return "码头上有人风传，昨夜货栈闹出动静，细节对不上号，当不得真。"

    # GM arbitration: mentions truth, drafts, EventRecord, records
    if ("truth" in joined or "全知视角" in joined) and ("draft" in joined or "EventRecord" in joined or "records" in joined):
        rid = uuid.uuid4().hex[:12]
        payload = {
            "records": [
                {
                    "id": rid,
                    "week_number": 1,
                    "type_id": "river_dispute",
                    "location_id": "loc_teahouse",
                    "truth_json": {"note": "Stub GM 占位裁决：码头起了口角，未动手。", "what_happened": "Stub GM 占位裁决"},
                    "director_draft_json": {},
                    "witness_accounts": [
                        {
                            "agent_id": "npc_guan",
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
        return json.dumps(payload, ensure_ascii=False)

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
        return json.dumps(payload, ensure_ascii=False)

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
        return json.dumps(payload, ensure_ascii=False)

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
        return json.dumps(payload, ensure_ascii=False)

    # NPC intent (matches tier_s/a/b prompts: mentions JSON structure with agent_id, week, mood_delta, intent_text)
    if ("mood_delta" in joined or "intent_text" in joined) and ("agent_id" in joined or "week" in joined):
        # Extract agent_id and week from the joined context
        import re
        aid_match = re.search(r"角色id[=:]\s*(\S+?)[\s,，\n]", joined)
        week_match = re.search(r"本周[=:]\s*(\d+)", joined)
        aid = aid_match.group(1) if aid_match else "stub_npc"
        wk = int(week_match.group(1)) if week_match else 1

        payload = {
            "agent_id": aid,
            "week": wk,
            "mood_delta": "略紧",
            "intent_text": "本周想摸清码头动向，少惹袍哥。",
            "target_ids": [],
            "relationship_hints": [],
        }
        return json.dumps(payload, ensure_ascii=False)

    if (
        "请输出一个 JSON 对象" in joined
        and "mood_delta" in joined
        and "relationship_hints" in joined
    ):
        payload = {
            "agent_id": "stub_npc",
            "week": 1,
            "mood_delta": "略紧",
            "intent_text": "本周想摸清码头动向，少惹袍哥。",
            "target_ids": [],
            "relationship_hints": [],
        }
        return json.dumps(payload, ensure_ascii=False)

    # Week summary
    if "以下是第" in joined and "周的事件数据" in joined:
        return "本周江面风紧，茶馆里暗流涌动。关二狗在码头转了一圈，没表态。刘三娘闭门会客，不知盘算什么。"

    # Month history
    if "月志" in joined or "合成为一章月志" in joined:
        return "本月川渝风物如常，唯有码头几处暗斗。茶馆里闲话渐多，真真假假难辨。"

    # Style rewrite
    if "润色" in joined and "川渝" in joined:
        return "这个月江风紧得很，码头上的袍哥人家个个绷着脸。茶馆里头，堂倌儿掺茶递水的工夫，闲言碎语就跟江水一样往外淌。"

    return "（StubLLM）未识别任务。请改用 openai_compat 或 ollama。"


async def chronicle_stub_model_fn(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
    joined = _flatten_stub_context(messages, info)
    text = _stub_text(joined)
    return ModelResponse(
        parts=[TextPart(content=text)],
        provider_details={"finish_reason": "stop", "stub": True},
    )


def build_stub_function_model() -> FunctionModel:
    return FunctionModel(chronicle_stub_model_fn, model_name="chronicle_stub")
