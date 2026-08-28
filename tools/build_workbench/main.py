"""构建管理工作台入口。

    npm run build:gui
    # 或
    sh scripts/py.sh -m tools.build_workbench <project_root>

**整个系统只跑一个实例。** 再启动一次不会开出第二个窗口，而是把已经在跑的那个
唤到前台然后自己退出——理由见 `single_instance.py`（两个实例各有一个调度定时器，
到点会同时起两次构建，抢同一个输出目录）。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PySide6.QtWidgets import QApplication

from .single_instance import SingleInstanceGuard
from .window import BuildWorkbenchWindow


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "project_root", nargs="?", default=".",
        help="GameDraft 仓库根（含 public/、scripts/）",
    )
    args = parser.parse_args(argv)
    root = Path(args.project_root).resolve()
    if not (root / "scripts" / "release.mjs").is_file():
        print(f"这里不像 GameDraft 仓库根（找不到 scripts/release.mjs）：{root}", file=sys.stderr)
        return 2

    # QLocalSocket 需要一个 QApplication 才能用；所以先建 app 再问"有没有人在跑"
    app = QApplication.instance() or QApplication(sys.argv[:1])

    if SingleInstanceGuard.try_notify_existing(root):
        print("构建工作台已经在运行，已把它唤到前台。")
        return 0

    guard = SingleInstanceGuard()
    if not guard.acquire():
        # 占不住名字又连不上——说不清现状，与其开出第二个来，不如停下说清楚
        print(
            "占不住单实例锁，也连不上已有实例。可能有一个卡住的工作台进程；"
            "在任务管理器里结束它再试。",
            file=sys.stderr,
        )
        return 3

    window = BuildWorkbenchWindow(root)
    guard.activate_requested.connect(window.activate_from_other_instance)
    window.show()
    try:
        return app.exec()
    finally:
        guard.release()
        # QThread 仍 running 时随栈析构会让 Qt qFatal 掉整个进程
        window.wait_for_background_threads()


if __name__ == "__main__":
    raise SystemExit(main())
