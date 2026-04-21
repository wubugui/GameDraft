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
    # 每周抽样：相对权重，越大越容易进入当周候选（常见市井线可 0.9–1.2，稀有线可 0.08–0.35）
    pick_weight: float = 1.0
    cooldown_weeks: int = 0
    supernatural_prob: float = 0.0
    # 类型学说明（抽象）：戏剧母题与可能波及的叙事轴，不是具体剧情；场面由 Agent 按种子推演
    dramatic_brief: str = ""
    effect_brief: str = ""
    # 周期加码：当 week % period_every_n_weeks == period_phase 时，pick_weight 乘以 period_weight_mult
    period_every_n_weeks: int = 0
    period_phase: int = 0
    period_weight_mult: float = 2.0

    def model_dump_yaml_safe(self) -> dict[str, Any]:
        d = self.model_dump()
        return d
