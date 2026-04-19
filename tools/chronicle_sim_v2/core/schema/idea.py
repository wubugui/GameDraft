"""设定库条目 schema。"""
from __future__ import annotations

from pydantic import BaseModel, Field


class IdeaEntry(BaseModel):
    id: str
    title: str
    body: str
    source: str = Field(default="manual")  # "manual" | "imported"
    source_file: str | None = None
    tags: list[str] = Field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""
