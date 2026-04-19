from __future__ import annotations

from pydantic import BaseModel


class BeliefRecord(BaseModel):
    holder_id: str
    subject_id: str  # 事件 id（对应 events.id），非角色 id
    topic: str
    claim_text: str
    source_event_id: str | None = None
    distortion_level: int = 0
    first_heard_week: int = 0
    last_updated_week: int = 0
    confidence: float = 0.5
