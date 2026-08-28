"""构建输出面板：带等级着色与过滤的只读日志视图。

比 `production_workbench/console.py` 小一圈——那份还管跨会话落盘与 dock 归属，
这里只需要"把一次构建的输出看清楚"。落盘由 `release.mjs` 自己的报告负责。

等级从**文本**猜（构建输出没有结构化的 severity）。判据保守：
宁可把一条错误显示成普通行，也不要把一堆普通行染成红的——满屏红等于没有红。
"""
from __future__ import annotations

import html
import re
from PySide6.QtWidgets import (
    QCheckBox, QHBoxLayout, QLabel, QLineEdit, QPushButton, QTextEdit, QVBoxLayout, QWidget,
)

#: 认得出的等级与配色（对齐 UI 那套纸黄/夜底的暗色观感）
_COLORS = {
    "error": "#ff6b6b",
    "warn": "#ffc46b",
    "ok": "#8fd694",
    "step": "#7fc7ff",
    "info": "#d8d2c4",
}

_ERROR_RE = re.compile(r"(✖|\berror\b|\bfailed\b|failure|traceback|退出码|失败|不通过)", re.I)
_WARN_RE = re.compile(r"(⚠|\bwarn(ing)?\b|警告|跳过)", re.I)
_OK_RE = re.compile(r"(✓|\bok\b|通过|完成|成功)", re.I)
_STEP_RE = re.compile(r"^\s*(▶|\d/\d|===)")


def infer_severity(text: str) -> str:
    """从一行文本猜等级。顺序有讲究：错误优先，其次警告，再判成功/步骤。"""
    if _ERROR_RE.search(text):
        return "error"
    if _WARN_RE.search(text):
        return "warn"
    if _STEP_RE.search(text):
        return "step"
    if _OK_RE.search(text):
        return "ok"
    return "info"


class BuildConsole(QWidget):
    """一次构建的输出视图。`append(line)` 灌入，过滤/搜索/复制都在这。"""

    _MAX_LINES = 4000  # 构建输出不该无限涨；超了从头丢

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._lines: list[tuple[str, str]] = []  # (severity, text)

        self._only_problems = QCheckBox("只看问题")
        self._only_problems.setToolTip("只显示错误与警告")
        self._only_problems.toggled.connect(self._rerender)

        self._filter = QLineEdit()
        self._filter.setPlaceholderText("过滤（子串匹配）")
        self._filter.setClearButtonEnabled(True)
        self._filter.textChanged.connect(self._rerender)

        copy_btn = QPushButton("复制可见")
        copy_btn.clicked.connect(self._copy_visible)
        clear_btn = QPushButton("清空")
        clear_btn.clicked.connect(self.clear)

        self._count = QLabel("")

        top = QHBoxLayout()
        top.addWidget(self._only_problems)
        top.addWidget(self._filter, 1)
        top.addWidget(self._count)
        top.addWidget(copy_btn)
        top.addWidget(clear_btn)

        self._view = QTextEdit()
        self._view.setReadOnly(True)
        self._view.setLineWrapMode(QTextEdit.LineWrapMode.NoWrap)
        self._view.setStyleSheet(
            "QTextEdit{background:#14161a;color:#d8d2c4;"
            "font-family:Consolas,'Cascadia Mono',monospace;font-size:12px;}"
        )

        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addLayout(top)
        lay.addWidget(self._view, 1)

    # ------------------------------------------------------------- 写入

    def append(self, text: str) -> None:
        self._lines.append((infer_severity(text), text))
        if len(self._lines) > self._MAX_LINES:
            del self._lines[: len(self._lines) - self._MAX_LINES]
            self._rerender()
            return
        if self._visible(self._lines[-1]):
            self._append_html(self._lines[-1])
        self._update_count()

    def clear(self) -> None:
        self._lines.clear()
        self._view.clear()
        self._update_count()

    def to_plain_text(self) -> str:
        return "\n".join(t for _, t in self._lines)

    def has_errors(self) -> bool:
        return any(sev == "error" for sev, _ in self._lines)

    # ------------------------------------------------------------- 渲染

    def _visible(self, entry: tuple[str, str]) -> bool:
        sev, text = entry
        if self._only_problems.isChecked() and sev not in ("error", "warn"):
            return False
        needle = self._filter.text().strip()
        return not needle or needle.lower() in text.lower()

    def _append_html(self, entry: tuple[str, str]) -> None:
        sev, text = entry
        color = _COLORS.get(sev, _COLORS["info"])
        weight = "font-weight:600;" if sev in ("error", "step") else ""
        self._view.append(
            f'<span style="color:{color};{weight}white-space:pre">{html.escape(text)}</span>'
        )

    def _rerender(self) -> None:
        self._view.clear()
        for entry in self._lines:
            if self._visible(entry):
                self._append_html(entry)
        self._update_count()

    def _update_count(self) -> None:
        errs = sum(1 for s, _ in self._lines if s == "error")
        warns = sum(1 for s, _ in self._lines if s == "warn")
        parts = [f"{len(self._lines)} 行"]
        if errs:
            parts.append(f"错误 {errs}")
        if warns:
            parts.append(f"警告 {warns}")
        self._count.setText(" · ".join(parts))

    def _copy_visible(self) -> None:
        from PySide6.QtWidgets import QApplication
        visible = [t for e in self._lines if self._visible(e) for _, t in (e,)]
        QApplication.clipboard().setText("\n".join(visible))
