"""入口: 在项目根目录执行 python -m tools.chronicle_sim_v2"""
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
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
