"""Entry point: run with .tools/venv/bin/python -m tools.chronicle_sim_v2."""
from __future__ import annotations

import os

# 本机 opentelemetry 与 logfire 的 pydantic 插件版本不一致时会反复 UserWarning，禁用插件即可。
os.environ.setdefault("PYDANTIC_DISABLE_PLUGINS", "1")


def main() -> None:
    from tools.chronicle_sim_v2.gui.main_window import MainWindow  # noqa: F811
    import sys
    from PySide6.QtWidgets import QApplication

    app = QApplication(sys.argv)
    app.setApplicationName("ChronicleSim v2")
    from tools.editor.shared.qt_combo_wheel_guard import install_global_combo_wheel_block
    install_global_combo_wheel_block(app)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
