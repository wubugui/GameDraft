"""Command-line entry point for the GameDraft production workbench."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PySide6.QtWidgets import QApplication

from .workbench_window import WorkbenchWindow


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m tools.production_workbench",
        description="Open the GameDraft production workbench.",
    )
    parser.add_argument(
        "project_root",
        nargs="?",
        help="GameDraft project root. Defaults to the current working directory.",
    )
    args = parser.parse_args(argv)

    project_root = Path(args.project_root).resolve() if args.project_root else None
    app = QApplication.instance() or QApplication(sys.argv[:1])
    window = WorkbenchWindow(project_root)
    window.show()
    return int(app.exec())


if __name__ == "__main__":
    raise SystemExit(main())
