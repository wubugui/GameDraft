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
    rumor_versions: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    supernatural_level: str = "none"
