"""离线 Stub：不调用 Cline / 外部 API，用于无密钥或 CI。"""
from __future__ import annotations

import json
import re
import uuid
from typing import Any, Dict, List, Optional


def _flatten_messages(messages: List[Dict[str, str]]) -> str:
    chunks: list[str] = []
    for m in messages:
        c = m.get("content")
        if isinstance(c, str):
            chunks.append(c)
        elif c is not None:
            chunks.append(str(c))
    return "\n".join(chunks)


def stub_response_text(joined: str) -> str:
    """根据合并后的提示文本返回占位 JSON/正文（与旧 StubLLM 行为一致）。"""
    if "【传闻改写任务】" in joined:
        return "码头上有人风传，昨夜货栈闹出动静，细节对不上号，当不得真。"

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

    if "你是游戏世界策划助手" in joined or "种子抽取器" in joined or "SeedDraft" in joined:
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

    if ("mood_delta" in joined or "intent_text" in joined) and ("agent_id" in joined or "week" in joined):
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

    if "以下是第" in joined and "周的事件数据" in joined:
        return "本周江面风紧，茶馆里暗流涌动。关二狗在码头转了一圈，没表态。刘三娘闭门会客，不知盘算什么。"

    if "月志" in joined or "合成为一章月志" in joined:
        return "本月川渝风物如常，唯有码头几处暗斗。茶馆里闲话渐多，真真假假难辨。"

    if "润色" in joined and "川渝" in joined:
        return "这个月江风紧得很，码头上的袍哥人家个个绷着脸。茶馆里头，堂倌儿掺茶递水的工夫，闲言碎语就跟江水一样往外淌。"

    return "（StubLLM）未识别任务。请配置 Cline（非 stub）或改用有效提示。"


class ChronicleStubLLM:
    """占位类型标记；不与外部 API 通信。"""

    model = "chronicle_stub"

    def call(
        self,
        messages: List[Dict[str, str]],
        callbacks: Optional[List[Any]] = None,
    ) -> str:
        joined = _flatten_messages(messages)
        return stub_response_text(joined)


def build_chronicle_stub_llm() -> ChronicleStubLLM:
    return ChronicleStubLLM()
