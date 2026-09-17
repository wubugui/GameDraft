"""场景实体剪贴板的 Qt 读写面（两个场景画布共用）。

规则（取号 / 落位 / 跨场景引用口径）全在 `entity_refactor` 的剪贴板一节，这里只管
把载荷放进系统剪贴板、再取出来。MIME 面给编辑器自己认；文本面写同一份 JSON——
跨编辑器进程也能粘，排查时贴到任何文本框里也看得见拷走的到底是什么。
"""
from __future__ import annotations

from typing import Any

from PySide6.QtCore import QMimeData
from PySide6.QtWidgets import QApplication

from .entity_refactor import (
    ENTITY_CLIP_MIME,
    entity_clip_to_text,
    parse_entity_clip,
)

__all__ = ["write_entity_clip", "read_entity_clip"]


def write_entity_clip(clip: dict[str, Any]) -> None:
    text = entity_clip_to_text(clip)
    mime = QMimeData()
    mime.setData(ENTITY_CLIP_MIME, text.encode("utf-8"))
    mime.setText(text)
    QApplication.clipboard().setMimeData(mime)


def read_entity_clip() -> dict[str, Any] | None:
    """剪贴板里的场景实体载荷；没有 / 不是本格式返回 None。"""
    mime = QApplication.clipboard().mimeData()
    if mime is None:
        return None
    if mime.hasFormat(ENTITY_CLIP_MIME):
        raw = bytes(mime.data(ENTITY_CLIP_MIME))
        parsed = parse_entity_clip(raw.decode("utf-8", errors="replace"))
        if parsed is not None:
            return parsed
    return parse_entity_clip(mime.text() if mime.hasText() else "")
