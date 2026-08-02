"""Run with: .tools/venv/bin/python -m tools.task_orchestration_editor [project]."""
from __future__ import annotations

import sys
from pathlib import Path

try:
    import PySide6.QtWebEngineWidgets  # noqa: F401 - import before QApplication
except ImportError:
    pass

from PySide6.QtWidgets import QApplication

from tools.editor import theme
from tools.editor.shared.qt_combo_wheel_guard import install_global_combo_wheel_block

from .window import TaskOrchestrationWindow


def main() -> None:
    app = QApplication(sys.argv)
    app.setApplicationName("GameDraft Task Orchestration")
    install_global_combo_wheel_block(app)
    theme.apply_application_theme(app, theme.settings_load_theme())
    window = TaskOrchestrationWindow()
    if len(sys.argv) > 1:
        window.load_project(Path(sys.argv[1]))
    else:
        root = Path(__file__).resolve().parents[2]
        if (root / "public" / "assets").is_dir():
            window.load_project(root)
    window.showMaximized()
    raise SystemExit(app.exec())


if __name__ == "__main__":
    main()

