from __future__ import annotations

from typing import Any


class HistoryBuffer:
    """短期多轮对话，step 结束 compress 成摘要。"""

    def __init__(self, max_rounds: int = 12) -> None:
        self._messages: list[dict[str, str]] = []
        self._max_rounds = max_rounds

    def append(self, role: str, content: str) -> None:
        self._messages.append({"role": role, "content": content})
        while len(self._messages) > self._max_rounds * 2:
            self._messages.pop(0)

    def snapshot(self) -> list[dict[str, str]]:
        return list(self._messages)

    def compress(self, summary_prefix: str = "[摘要] ") -> str:
        if not self._messages:
            return ""
        joined = "\n".join(f"{m['role']}: {m['content']}" for m in self._messages[-8:])
        summary = summary_prefix + joined[:2000]
        self._messages.clear()
        return summary

    def clear(self) -> None:
        self._messages.clear()
