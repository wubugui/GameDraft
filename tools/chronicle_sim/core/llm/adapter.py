from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from pydantic import BaseModel


class LLMResponse(BaseModel):
    text: str
    raw: dict[str, Any] | None = None
    usage: dict[str, Any] | None = None


class LLMAdapter(ABC):
    @abstractmethod
    async def chat(
        self,
        messages: list[dict[str, str]],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        json_schema: dict[str, Any] | None = None,
    ) -> LLMResponse:
        raise NotImplementedError
