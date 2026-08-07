"""叙事调试器入口。

    ./dev.sh narrative-debugger

然后在游戏地址后面加 ``?ndbg=1``（例如 http://localhost:5173/?ndbg=1&mode=dev），
两边自动接上。调试器不开的时候，游戏侧探针整条链路休眠，运行时零负担。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="narrative-debugger", description="GameDraft 叙事调试器")
    parser.add_argument("--port", type=int, default=5211, help="WebSocket 端口（默认 5211）")
    parser.add_argument("--root", type=Path, default=None, help="项目根目录")
    parser.add_argument("--check", action="store_true", help="只做自检，不开窗")
    args = parser.parse_args(argv)
    root = args.root or repo_root()

    from tools.narrative_debugger.model import NarrativeIndex

    index = NarrativeIndex(root)
    index.load()

    if args.check:
        print(f"narrative-debugger: {len(index.graphs)} 图 / {len(index.states)} 状态 / {len(index.beats)} 拍")
        for err in index.load_errors[:5]:
            print(f"  ! {err}")
        return 0 if index.states else 1

    from PySide6.QtWidgets import QApplication, QMessageBox

    from tools.narrative_debugger.hub import DebugHub
    from tools.narrative_debugger.savepoints import SavepointStore
    from tools.narrative_debugger.ui.main_window import MainWindow

    app = QApplication(sys.argv[:1])
    app.setApplicationName("GameDraft 叙事调试器")

    if not index.states:
        QMessageBox.critical(
            None,
            "读不到叙事数据",
            f"在 {root} 下找不到 narrative_graphs.json。\n用 --root 指定项目根目录。",
        )
        return 2

    hub = DebugHub(index, port=args.port)
    if not hub.start():
        QMessageBox.critical(
            None,
            f"端口 {args.port} 被占用了",
            f"{hub.listen_error}\n\n换个端口：--port 5212\n游戏那边相应加 ?ndbg=1&ndbg_port=5212",
        )
        return 3

    store = SavepointStore(root, index.fingerprint, index.graph_fingerprints)
    window = MainWindow(index, hub, store, root)
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
