from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ActorSlotDef(BaseModel):
    role: str = "any"
    tier_min: str = "B"
    tier_max: str = "S"
    relation_hint: str | None = None


class EventTypeDef(BaseModel):
    id: str
    category: str
    tier: str = "minor"
    conditions: str = "true"
    actor_slots: list[ActorSlotDef] = Field(default_factory=list)
    weight: float = 1.0
    cooldown_weeks: int = 0
    supernatural_prob: float = 0.0
    narrative_template: str = ""
    consequences_template: str = ""

    def model_dump_yaml_safe(self) -> dict[str, Any]:
        d = self.model_dump()
        return d
