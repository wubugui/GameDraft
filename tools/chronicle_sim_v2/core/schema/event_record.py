from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class WitnessAccount(BaseModel):
    agent_id: str
    account_text: str
    supernatural_hint: str = ""


class EventRecord(BaseModel):
    id: str
    week_number: int
    type_id: str
    location_id: str | None = None
    truth_json: dict[str, Any] = Field(default_factory=dict)
    director_draft_json: dict[str, Any] = Field(default_factory=dict)
    witness_accounts: list[WitnessAccount] = Field(default_factory=list)
    """与事件直接相关的 NPC 口供（``agent_id`` 须为相关人）。"""
    related_agents: list[str] = Field(default_factory=list)
    """与事件事理直接相关的 NPC id（入库前可由管线补全）。"""
    spread_agents: list[str] = Field(default_factory=list)
    """会参与口头扩散的 NPC id，须为 ``related_agents`` 子集。"""
    actor_ids: list[str] = Field(default_factory=list)
    """事件当事人等（可选，供相关人/传播人推断）。"""
    rumor_versions: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    supernatural_level: str = "none"
