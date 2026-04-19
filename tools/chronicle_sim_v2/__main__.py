"""入口: 在项目根目录执行 python -m tools.chronicle_sim_v2"""
from __future__ import annotations


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
