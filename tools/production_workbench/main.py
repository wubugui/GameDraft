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
    try:
        return int(app.exec())
    finally:
        # window 是局部量，函数退栈即析构；此时若还有后台 QThread 在跑，
        # Qt 会 qFatal 掉整个进程（用户看到崩溃而不是 traceback）。
        # closeEvent 那道"有线程就不给关"拦不住 QApplication.quit() 和
        # 槽函数里未捕获异常外抛这两条路，所以在这里兜。
        stuck = window.wait_for_background_threads()
        if stuck:
            print(
                "[workbench] 退出时这些后台线程仍未结束，进程可能被 Qt 强杀："
                + ", ".join(sorted(set(stuck))),
                file=sys.stderr,
                flush=True,
            )


if __name__ == "__main__":
    raise SystemExit(main())
