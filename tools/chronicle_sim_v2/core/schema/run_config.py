"""Run 配置 schema（替代旧版 run.db 中的 runs 表）。"""
from __future__ import annotations

from pydantic import BaseModel, Field


class RunConfig(BaseModel):
    run_id: str
    name: str
    start_week: int = 1
    total_weeks: int = 52
    current_week: int = 0
    pacing_profile_id: str = Field(default="default")
    created_at: str = ""
