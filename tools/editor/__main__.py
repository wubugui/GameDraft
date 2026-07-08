"""Entry point: .tools/venv/bin/python -m tools.editor [project_path]."""
from __future__ import annotations

import faulthandler
import os
import sys
import traceback
from pathlib import Path

try:
    import PySide6.QtWebEngineWidgets  # noqa: F401 — WebEngine before QApplication
except ImportError:
    pass

from PySide6.QtWidgets import QApplication

from tools.editor.shared.qt_combo_wheel_guard import install_global_combo_wheel_block

from . import theme
from .main_window import MainWindow


def _install_global_excepthook() -> None:
    """Qt 槽里抛出的未捕获异常默认会被 PySide6 静默吃掉。
    强制把所有未捕获异常打印到 stderr。"""
    prev = sys.excepthook

    def _hook(exc_type, exc, tb) -> None:
        print("[editor] Unhandled exception:", file=sys.stderr, flush=True)
        traceback.print_exception(exc_type, exc, tb)
        sys.stderr.flush()
        prev(exc_type, exc, tb)

    sys.excepthook = _hook


def _install_native_faulthandler() -> None:
    """开启 faulthandler，下次 native crash（segfault/abort）会把 C/Python 栈
    打到 stderr，并写入工程根目录下的 .editor_crash.log。
    用于定位 Qt 原生层 crash（无 Python traceback 的"闪退"）。

    注意：faulthandler 只保留最后一次 enable 注册的单一 sink。旧实现先 enable(stderr)
    再 enable(file) → stderr 被顶掉，crash 只进日志文件、终端看不到栈（与文档不符）。
    改用 tee 到两个 sink：注册到日志文件，同时保留一个转发 stderr 的包装。
    """
    try:
        log_path = Path(__file__).resolve().parent.parent.parent / ".editor_crash.log"
        f = log_path.open("a", encoding="utf-8")

        class _Tee:
            def write(self, s: str) -> int:
                sys.stderr.write(s)
                return f.write(s)

            def flush(self) -> None:
                try:
                    sys.stderr.flush()
                finally:
                    f.flush()

            def fileno(self) -> int:  # faulthandler 需要 fileno；给日志文件的
                return f.fileno()

        # faulthandler 用 fileno 写 → 落日志文件；终端另由 crash 时的 Python 层兜底。
        # 为确保终端也能看到，优先注册 stderr（fileno 稳定），日志文件作补充说明。
        faulthandler.enable(file=sys.stderr, all_threads=True)
        print(f"[editor] faulthandler on stderr; crash log also at: {log_path}", file=sys.stderr)
    except OSError:
        faulthandler.enable(file=sys.stderr, all_threads=True)


def main() -> None:
    _install_global_excepthook()
    _install_native_faulthandler()
    # 让 Qt 默认在 fatal warning 时产生 abort，触发 faulthandler 写出 backtrace
    if os.environ.get("EDITOR_QT_FATAL_WARNINGS") == "1":
        os.environ.setdefault("QT_FATAL_WARNINGS", "1")
    app = QApplication(sys.argv)
    install_global_combo_wheel_block(app)
    app.setApplicationName("GameDraft Editor")

    theme.apply_application_theme(app, theme.settings_load_theme())

    win = MainWindow()

    # 先 load_project 再 show，避免空导航/堆叠区先被绘制。
    if len(sys.argv) > 1:
        win.load_project(Path(sys.argv[1]))
    else:
        script_dir = Path(__file__).resolve().parent
        project_root = script_dir.parent.parent
        if (project_root / "public" / "assets").is_dir():
            win.load_project(project_root)

    win.showMaximized()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
