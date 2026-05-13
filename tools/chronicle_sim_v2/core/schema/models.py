from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class NpcTier(str, Enum):
    S = "S"
    A = "A"
    B = "B"


class RunMeta(BaseModel):
    run_id: str
    name: str = ""
    start_week: int = 1
    total_weeks: int = 13
    pacing_profile_id: str = "default"
    llm_config_snapshot: dict[str, Any] = Field(default_factory=dict)


class AgentRow(BaseModel):
    id: str
    name: str
    initial_tier: NpcTier
    current_tier: NpcTier
    faction_id: str | None = None
    location_id: str | None = None
    personality_tags: list[str] = Field(default_factory=list)
    secret_tags: list[str] = Field(default_factory=list)
    style_fingerprint_id: str | None = None
    life_status: str = "alive"
    init_agent_suggested_tier: NpcTier | None = None
    init_agent_suggestion_reason: str = ""


class FactionRow(BaseModel):
    id: str
    name: str
    description: str = ""


class LocationRow(BaseModel):
    id: str
    name: str
    description: str = ""


class RelationshipRow(BaseModel):
    id: str
    from_agent_id: str
    to_agent_id: str
    rel_type: str
    strength: float = 0.5
    grudge: bool = False
    shared_secret_id: str | None = None


class SeedDraft(BaseModel):
    """InitializerAgent 产出的种子草稿（JSON 可序列化）。"""

    world_setting: dict[str, Any] = Field(
        default_factory=dict,
        description="世界观种子：title/logline/era_and_place/tone_and_themes/geography_overview/"
        "social_structure/supernatural_rules/friction_sources/player_promise/raw_author_notes 等自由键",
    )
    design_pillars: list[dict[str, Any]] = Field(
        default_factory=list,
        description="设计支柱 [{id,name,description,implications}]",
    )
    custom_sections: list[dict[str, Any]] = Field(
        default_factory=list,
        description="任意自定义区块 [{id,title,body}]，用于你还不想建模的粗糙设定",
    )
    agents: list[dict[str, Any]] = Field(default_factory=list)
    factions: list[dict[str, Any]] = Field(default_factory=list)
    locations: list[dict[str, Any]] = Field(default_factory=list)
    relationships: list[dict[str, Any]] = Field(default_factory=list)
    anchor_events: list[dict[str, Any]] = Field(default_factory=list)
    social_graph_edges: list[dict[str, Any]] = Field(default_factory=list)
    event_type_candidates: list[dict[str, Any]] = Field(default_factory=list)
