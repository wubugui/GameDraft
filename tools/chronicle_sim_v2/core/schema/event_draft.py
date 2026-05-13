from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class EventDraft(BaseModel):
    type_id: str
    week: int
    location_id: str | None = None
    actor_ids: list[str] = Field(default_factory=list)
    summary: str = ""
    draft_json: dict[str, Any] = Field(default_factory=dict)
