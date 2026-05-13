from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class NpcStateCard(BaseModel):
    agent_id: str
    traits: dict[str, Any] = Field(default_factory=dict)
    current_location_id: str | None = None
    relationship_summary: str = ""
    last_touched_week: int = 0
