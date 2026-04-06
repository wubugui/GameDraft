"""Entry point: python -m tools.editor [project_path]"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    import PySide6.QtWebEngineWidgets  # noqa: F401 — WebEngine before QApplication
except ImportError:
    pass

from PySide6.QtWidgets import QApplication

from . import theme
from .main_window import MainWindow


def main() -> None:
    app = QApplication(sys.argv)
    app.setApplicationName("GameDraft Editor")

    theme.apply_application_theme(app, theme.settings_load_theme())

    win = MainWindow()
    win.show()

    if len(sys.argv) > 1:
        win.load_project(Path(sys.argv[1]))
    else:
        script_dir = Path(__file__).resolve().parent
        project_root = script_dir.parent.parent
        if (project_root / "public" / "assets").is_dir():
            win.load_project(project_root)

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
