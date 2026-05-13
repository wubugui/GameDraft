"""启动资源浏览器（PySide6）。"""
from __future__ import annotations

import sys
from pathlib import Path

if __package__ is None:
    _repo = Path(__file__).resolve().parents[2]
    if str(_repo) not in sys.path:
        sys.path.insert(0, str(_repo))

from PySide6.QtWidgets import QApplication

from tools.editor.shared.qt_combo_wheel_guard import install_global_combo_wheel_block

if __package__ is None:
    from tools.asset_browser.browser_window import BrowserWindow
else:
    from .browser_window import BrowserWindow


def main() -> None:
    app = QApplication(sys.argv)
    install_global_combo_wheel_block(app)
    w = BrowserWindow()
    w.show()
    raise SystemExit(app.exec())


if __name__ == "__main__":
    main()
