"""共用：紧凑三态立绘选择器（无头像 / 跟随说话人 / 指定立绘集）+ 表情。

供 playScriptedDialogue 行、图对话 choice 的 promptLine 等复用；行节点 line 的立绘另有
带图片预览的内联实现（node_inspector），本控件不动它、只给这些较简上下文一个统一紧凑入口。

portrait dict 语义（与运行时 ``DialoguePortraitRef`` 一致）：
  None                       → 不显头像
  {"emotion": e}             → 跟随说话人（运行时按 speaker 的 NPC.portraitSlug / 玩家装扮解析）
  {"slug": s, "emotion": e}  → 指定立绘集
"""
from __future__ import annotations

import copy
from pathlib import Path

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QComboBox, QHBoxLayout, QLabel, QWidget

from .portrait_catalog import (
    PORTRAIT_EMOTIONS_FALLBACK,
    load_portrait_emotions,
    load_portrait_sets,
)

_FOLLOW = "@follow"
# 畸形 portrait（缺 emotion 等表单表达不了的形状）走只读透传：不吃键、不补值、原样回写。
_RAW = "@raw"


class PortraitRefField(QWidget):
    """三态立绘 + 表情；``to_ref()`` 返回运行时可用的 portrait dict 或 None。"""

    changed = Signal()

    def __init__(
        self,
        project_root: Path | None,
        initial: dict | None = None,
        parent: QWidget | None = None,
    ):
        super().__init__(parent)
        self._root = project_root
        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, 0)
        row.addWidget(QLabel("立绘"))
        self._slug = QComboBox()
        self._slug.setToolTip(
            "无头像 / 跟随说话人（运行时按 speaker 对应 NPC 的 portraitSlug 或玩家装扮解析）/ 指定立绘集"
        )
        self._slug.addItem("（无头像）", "")
        self._slug.addItem("跟随说话人", _FOLLOW)
        if project_root is not None:
            for s in load_portrait_sets(project_root):
                self._slug.addItem(s, s)
        row.addWidget(self._slug)
        self._emo = QComboBox()
        self._emo.setToolTip("表情")
        row.addWidget(self._emo)
        row.addStretch(1)

        ref = initial if isinstance(initial, dict) else None
        slug = str((ref or {}).get("slug") or "").strip()
        emo = str((ref or {}).get("emotion") or "").strip()
        # 畸形形状保值（审查 P3）：数据里是 dict 但缺 emotion（表单无法表达）——
        # 过去 `not emo` 直接归零成「无头像」，to_ref 返回 None，静默吃掉整条 portrait。
        # 改为只读透传：存原值，slug 下拉显示「(数据) <slug/…>」，to_ref 原样回写。
        self._raw_passthrough: dict | None = None
        if ref is not None and not emo:
            self._raw_passthrough = copy.deepcopy(ref)
            _lbl = slug if slug else "…"
            self._slug.addItem(f"(数据) {_lbl}", _RAW)
            self._set_slug_key(_RAW)
        elif ref is None:
            self._set_slug_key("")
        elif slug:
            if self._slug.findData(slug) < 0:
                self._slug.addItem(f"{slug}（缺集）", slug)
            self._set_slug_key(slug)
        else:
            self._set_slug_key(_FOLLOW)
        self._reload_emotions(want=emo)

        self._slug.currentIndexChanged.connect(self._on_slug_changed)
        self._emo.currentIndexChanged.connect(lambda *_: self.changed.emit())

    def _set_slug_key(self, key: str) -> None:
        self._slug.setCurrentIndex(max(0, self._slug.findData(key)))

    def _current_slug_key(self) -> str:
        return str(self._slug.currentData() or "")

    def _reload_emotions(self, want: str = "") -> None:
        self._emo.blockSignals(True)
        self._emo.clear()
        key = self._current_slug_key()
        if key in ("", _RAW):
            # 无头像 / 畸形透传：表情不可选（透传保原值，不自动补首表情）。
            self._emo.setEnabled(False)
            self._emo.blockSignals(False)
            return
        self._emo.setEnabled(True)
        if key == _FOLLOW or self._root is None:
            pairs = list(PORTRAIT_EMOTIONS_FALLBACK)
        else:
            pairs = load_portrait_emotions(self._root, key) or list(PORTRAIT_EMOTIONS_FALLBACK)
        for emo, label in pairs:
            self._emo.addItem(f"{label}（{emo}）", emo)
        if want and self._emo.findData(want) < 0:
            self._emo.addItem(f"{want}（缺图）", want)
        self._emo.setCurrentIndex(self._emo.findData(want) if want and self._emo.findData(want) >= 0 else 0)
        self._emo.blockSignals(False)

    def _on_slug_changed(self, *_) -> None:
        # 用户主动改选立绘集 = 放弃畸形透传，回到正常表单编辑。
        if self._current_slug_key() != _RAW:
            self._raw_passthrough = None
        self._reload_emotions()
        self.changed.emit()

    def to_ref(self) -> dict | None:
        key = self._current_slug_key()
        if key == _RAW:
            # 畸形形状：原样透传载入时的原始 dict（保值，不改写）。
            return copy.deepcopy(self._raw_passthrough) if self._raw_passthrough is not None else None
        if key == "":
            return None
        emo = str(self._emo.currentData() or "").strip()
        if not emo:
            return None
        if key == _FOLLOW:
            return {"emotion": emo}
        return {"slug": key, "emotion": emo}
