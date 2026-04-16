"""Entry point: python -m tools.copy_manager [--project <path>]"""
from __future__ import annotations

import sys

from tools.copy_manager.app import create_app


def main() -> None:
    app, project_root = create_app()
    from tools.copy_manager.main_window import MainWindow

    win = MainWindow(project_root)
    win.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
