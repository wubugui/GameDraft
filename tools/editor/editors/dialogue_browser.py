"""Ink dialogue browser with knot tree and tag highlighting."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QTextEdit, QPushButton, QLabel,
)
from PySide6.QtGui import QFont, QColor, QTextCharFormat, QSyntaxHighlighter, QTextDocument
from PySide6.QtCore import Qt, QRegularExpression

from ..project_model import ProjectModel
from ..file_io import read_text


class InkHighlighter(QSyntaxHighlighter):
    def __init__(self, parent: QTextDocument):
        super().__init__(parent)
        self._rules: list[tuple[QRegularExpression, QTextCharFormat]] = []

        fmt_knot = QTextCharFormat()
        fmt_knot.setForeground(QColor(100, 200, 255))
        fmt_knot.setFontWeight(QFont.Weight.Bold)
        self._rules.append((QRegularExpression(r"^===.*===$"), fmt_knot))

        fmt_tag = QTextCharFormat()
        fmt_tag.setForeground(QColor(200, 180, 80))
        self._rules.append((QRegularExpression(r"#\s*\S+.*$"), fmt_tag))

        fmt_choice = QTextCharFormat()
        fmt_choice.setForeground(QColor(150, 220, 150))
        self._rules.append((QRegularExpression(r"^\s*[\+\*].*$"), fmt_choice))

        fmt_ext = QTextCharFormat()
        fmt_ext.setForeground(QColor(200, 120, 120))
        self._rules.append((QRegularExpression(r"^EXTERNAL\s+.*$"), fmt_ext))

    def highlightBlock(self, text: str) -> None:
        for pattern, fmt in self._rules:
            it = pattern.globalMatch(text)
            while it.hasNext():
                m = it.next()
                self.setFormat(m.capturedStart(), m.capturedLength(), fmt)


class DialogueBrowser(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        ll.addWidget(QLabel("<b>Ink Files</b>"))
        self._file_list = QListWidget()
        self._file_list.currentTextChanged.connect(self._on_file_selected)
        ll.addWidget(self._file_list)

        ll.addWidget(QLabel("<b>Knots</b>"))
        self._knot_list = QListWidget()
        ll.addWidget(self._knot_list)

        btn_open = QPushButton("Open in VS Code")
        btn_open.clicked.connect(self._open_vscode)
        ll.addWidget(btn_open)

        self._editor = QTextEdit()
        self._editor.setReadOnly(True)
        self._editor.setFont(QFont("Consolas", 10))

        splitter.addWidget(left)
        splitter.addWidget(self._editor)
        splitter.setSizes([220, 600])
        root.addWidget(splitter)
        self._current_path: Path | None = None
        self._refresh()

    def _refresh(self) -> None:
        self._file_list.clear()
        for name in self._model.all_ink_files():
            self._file_list.addItem(name)

    def _on_file_selected(self, name: str) -> None:
        if not name:
            return
        path = self._model.dialogues_path / name
        if not path.exists():
            return
        self._current_path = path
        text = read_text(path)
        self._editor.setPlainText(text)
        InkHighlighter(self._editor.document())

        self._knot_list.clear()
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("===") and line.endswith("==="):
                knot = line.strip("= ").strip()
                self._knot_list.addItem(knot)

    def _open_vscode(self) -> None:
        if self._current_path and self._current_path.exists():
            try:
                subprocess.Popen(["code", str(self._current_path)])
            except FileNotFoundError:
                pass
