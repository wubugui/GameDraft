"""启动素材入库工具（PySide6）。"""
from __future__ import annotations

import sys
from pathlib import Path

if __package__ is None:
    _repo = Path(__file__).resolve().parents[2]
    _r = str(_repo)
    if _r not in sys.path:
        sys.path.insert(0, _r)

from PySide6.QtWidgets import QApplication

from tools.editor.shared.qt_combo_wheel_guard import install_global_combo_wheel_block

if __package__ is None:
    from tools.asset_ingest.ingest_window import IngestWindow
else:
    from .ingest_window import IngestWindow


def main() -> None:
    app = QApplication(sys.argv)
    install_global_combo_wheel_block(app)
    w = IngestWindow()
    w.show()
    raise SystemExit(app.exec())


if __name__ == "__main__":
    main()
