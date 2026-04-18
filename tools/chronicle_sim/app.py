from __future__ import annotations

import sys
from pathlib import Path

try:
    import PySide6.QtWebEngineWidgets  # noqa: F401
except ImportError:
    pass

from PySide6.QtWidgets import QApplication

from tools.editor.shared.qt_combo_wheel_guard import install_global_combo_wheel_block
from tools.editor import theme

from tools.chronicle_sim.core.runtime.memory_store import release_all_chroma_clients
from tools.chronicle_sim.gui.console_errors import install_stderr_excepthook
from tools.chronicle_sim.gui.main_window import MainWindow


def main() -> None:
    install_stderr_excepthook()
    app = QApplication(sys.argv)
    app.aboutToQuit.connect(release_all_chroma_clients)
    install_global_combo_wheel_block(app)
    app.setApplicationName("ChronicleSim")
    theme.apply_application_theme(app, theme.settings_load_theme())
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
