from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator


class WeekIntent(BaseModel):
    agent_id: str
    week: int
    mood_delta: str = ""
    intent_text: str = ""
    target_ids: list[str] = Field(default_factory=list)
    relationship_hints: list[str] = Field(default_factory=list)

    @field_validator("mood_delta", mode="before")
    @classmethod
    def _coerce_mood_delta(cls, v: Any) -> str:
        """LLM 常输出数值（如 -0.2）；落库与编导侧仍用短句字符串。"""
        if v is None:
            return ""
        if isinstance(v, bool):
            return "是" if v else "否"
        if isinstance(v, (int, float)):
            return str(v)
        return str(v).strip() if isinstance(v, str) else str(v)

    @field_validator("relationship_hints", mode="before")
    @classmethod
    def _coerce_relationship_hints(cls, v: Any) -> list[str]:
        """LLM 常输出单条字符串而非数组。"""
        if v is None:
            return []
        if isinstance(v, str):
            s = v.strip()
            return [s] if s else []
        if isinstance(v, list):
            out: list[str] = []
            for x in v:
                if x is None:
                    continue
                sx = str(x).strip()
                if sx:
                    out.append(sx)
            return out
        sx = str(v).strip()
        return [sx] if sx else []
