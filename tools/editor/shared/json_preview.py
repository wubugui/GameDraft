"""JSON source preview / diff panel."""
from __future__ import annotations

import json
from PySide6.QtWidgets import QTextEdit, QWidget
from PySide6.QtGui import QFont


class JsonPreview(QTextEdit):
    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setReadOnly(True)
        self.setFont(QFont("Consolas", 10))
        self.setLineWrapMode(QTextEdit.LineWrapMode.NoWrap)

    def show_data(self, data: dict | list | None) -> None:
        if data is None:
            self.setPlainText("")
            return
        self.setPlainText(json.dumps(data, ensure_ascii=False, indent=2))
