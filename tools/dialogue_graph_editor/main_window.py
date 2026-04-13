"""独立运行的图对话编辑器窗口。"""
from __future__ import annotations

from PySide6.QtWidgets import QMainWindow
from PySide6.QtGui import QAction, QKeySequence

from .editor_widget import DialogueGraphEditorWidget


class MainWindow(QMainWindow):
    def __init__(self, project_path: str):
        super().__init__()
        self._panel = DialogueGraphEditorWidget(project_path)
        self.setCentralWidget(self._panel)
        self._panel.title_changed.connect(self.setWindowTitle)
        self.resize(1400, 820)
        self._build_menu()

    def _build_menu(self) -> None:
        bar = self.menuBar()
        assert bar is not None
        m = bar.addMenu("文件")
        m.addAction(self._action("打开…", lambda: self._panel.open_file_dialog(), QKeySequence("Ctrl+O")))
        m.addAction(self._action("保存", lambda: self._panel.save(), QKeySequence("Ctrl+S")))
        m.addAction(self._action("另存为…", lambda: self._panel.save_as()))
        m.addSeparator()
        m.addAction(self._action("退出", lambda: self.close(), QKeySequence("Ctrl+Q")))

        v = bar.addMenu("校验")
        v.addAction(self._action("检查当前图", lambda: self._panel.run_validate()))

    def _action(self, text: str, slot, shortcut: QKeySequence | None = None) -> QAction:
        a = QAction(text, self)
        a.triggered.connect(slot)
        if shortcut is not None:
            a.setShortcut(shortcut)
        return a

    def closeEvent(self, event) -> None:
        if not self._panel.confirm_discard_or_save_before_close(self):
            event.ignore()
            return
        event.accept()
