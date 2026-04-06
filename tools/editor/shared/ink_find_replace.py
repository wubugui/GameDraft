"""当前文档内的查找与替换（供对话浏览器 Ink 编辑器使用）。

所有操作均通过 QTextCursor 完成，天然支持 Ctrl+Z 撤销。
"""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtGui import QTextCursor, QTextDocument
from PySide6.QtWidgets import (
    QCheckBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)


class InkFindReplaceBar(QWidget):
    """贴在 QPlainTextEdit 上方的紧凑查找/替换条。"""

    def __init__(
        self,
        editor: QPlainTextEdit,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._editor = editor

        row1 = QHBoxLayout()
        row1.addWidget(QLabel("查找:"))
        self._find = QLineEdit()
        self._find.setPlaceholderText("查找内容")
        self._find.returnPressed.connect(self.find_next)
        row1.addWidget(self._find, stretch=1)

        self._case = QCheckBox("区分大小写")
        row1.addWidget(self._case)
        self._whole = QCheckBox("全字匹配")
        row1.addWidget(self._whole)

        self._btn_next = QPushButton("下一个")
        self._btn_next.clicked.connect(self.find_next)
        row1.addWidget(self._btn_next)
        self._btn_prev = QPushButton("上一个")
        self._btn_prev.clicked.connect(self.find_prev)
        row1.addWidget(self._btn_prev)

        row2 = QHBoxLayout()
        row2.addWidget(QLabel("替换:"))
        self._repl = QLineEdit()
        self._repl.setPlaceholderText("替换为")
        self._repl.returnPressed.connect(self.replace_one)
        row2.addWidget(self._repl, stretch=1)

        self._btn_rep = QPushButton("替换")
        self._btn_rep.clicked.connect(self.replace_one)
        row2.addWidget(self._btn_rep)
        self._btn_rep_all = QPushButton("全部替换")
        self._btn_rep_all.clicked.connect(self.replace_all)
        row2.addWidget(self._btn_rep_all)

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 4, 0, 4)
        root.addLayout(row1)
        root.addLayout(row2)

    def focus_find(self) -> None:
        self._find.setFocus(Qt.FocusReason.ShortcutFocusReason)
        self._find.selectAll()

    def focus_replace(self) -> None:
        self._repl.setFocus(Qt.FocusReason.ShortcutFocusReason)
        self._repl.selectAll()

    def _q_flags(self) -> QTextDocument.FindFlag:
        f = QTextDocument.FindFlag(0)
        if self._case.isChecked():
            f |= QTextDocument.FindFlag.FindCaseSensitively
        if self._whole.isChecked():
            f |= QTextDocument.FindFlag.FindWholeWords
        return f

    def find_next(self) -> bool:
        needle = self._find.text()
        if not needle:
            return False
        flags = self._q_flags()
        if self._editor.find(needle, flags):
            return True
        c = QTextCursor(self._editor.document())
        c.movePosition(QTextCursor.MoveOperation.Start)
        self._editor.setTextCursor(c)
        return self._editor.find(needle, flags)

    def find_prev(self) -> bool:
        needle = self._find.text()
        if not needle:
            return False
        flags = self._q_flags() | QTextDocument.FindFlag.FindBackward
        if self._editor.find(needle, flags):
            return True
        c = QTextCursor(self._editor.document())
        c.movePosition(QTextCursor.MoveOperation.End)
        self._editor.setTextCursor(c)
        return self._editor.find(needle, flags)

    def _selection_matches_needle(self) -> bool:
        needle = self._find.text()
        if not needle:
            return False
        c = self._editor.textCursor()
        if not c.hasSelection():
            return False
        sel = c.selectedText().replace("\u2029", "\n")
        if self._case.isChecked():
            return sel == needle
        return sel.lower() == needle.lower()

    def replace_one(self) -> None:
        needle = self._find.text()
        if not needle:
            return
        if self._selection_matches_needle():
            self._editor.textCursor().insertText(self._repl.text())
        self.find_next()

    def replace_all(self) -> None:
        needle = self._find.text()
        if not needle:
            return
        flags = self._q_flags()
        doc = self._editor.document()
        repl = self._repl.text()

        c = QTextCursor(doc)
        c.movePosition(QTextCursor.MoveOperation.Start)
        first = doc.find(needle, c, flags)
        if first.isNull():
            return

        c.beginEditBlock()
        cursor = first
        while not cursor.isNull():
            cursor.insertText(repl)
            cursor = doc.find(needle, cursor, flags)
        c.endEditBlock()
