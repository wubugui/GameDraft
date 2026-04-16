"""Application setup: QApplication, dark theme, argument parsing."""
from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtWidgets import QApplication

from tools.copy_manager.main_window import MainWindow


def create_app() -> tuple[QApplication, Path]:
    """Create QApplication and resolve project root path."""
    app = QApplication(sys.argv)
    app.setApplicationName("Copy Manager")
    app.setOrganizationName("GameDraft")

    # Apply dark theme (reuses editor theme module)
    _apply_dark_theme(app)

    # Resolve project root
    if len(sys.argv) > 1:
        project_root = Path(sys.argv[1]).resolve()
    else:
        # Default: two levels up from this file (tools/copy_manager -> GameDraft)
        script_dir = Path(__file__).resolve().parent
        project_root = script_dir.parent.parent
        if not (project_root / "public" / "assets").is_dir():
            project_root = Path.cwd()

    return app, project_root


def _apply_dark_theme(app: QApplication) -> None:
    """Apply a dark Fusion theme (simplified version of editor theme)."""
    app.setStyle("Fusion")

    from PySide6.QtGui import QColor, QPalette

    p = QPalette()
    p.setColor(QPalette.ColorRole.Window, QColor(0x0F, 0x0F, 0x0F))
    p.setColor(QPalette.ColorRole.WindowText, QColor(0xE8, 0xE8, 0xE8))
    p.setColor(QPalette.ColorRole.Base, QColor(0x05, 0x05, 0x05))
    p.setColor(QPalette.ColorRole.AlternateBase, QColor(0x12, 0x12, 0x12))
    p.setColor(QPalette.ColorRole.Text, QColor(0xE8, 0xE8, 0xE8))
    p.setColor(QPalette.ColorRole.Button, QColor(0x22, 0x22, 0x22))
    p.setColor(QPalette.ColorRole.ButtonText, QColor(0xEE, 0xEE, 0xEE))
    p.setColor(QPalette.ColorRole.Highlight, QColor(61, 158, 255))
    p.setColor(QPalette.ColorRole.HighlightedText, QColor(255, 255, 255))
    p.setColor(QPalette.ColorRole.Link, QColor(130, 190, 255))
    p.setColor(QPalette.ColorRole.PlaceholderText, QColor(140, 140, 140))
    app.setPalette(p)

    qss = """
        QMainWindow { background-color: #0f0f0f; }
        QWidget { color: #e8e8e8; font-size: 13px; }
        QMenuBar { background-color: #0f0f0f; border-bottom: 1px solid #262626; padding: 2px; }
        QMenuBar::item { background: transparent; padding: 4px 10px; }
        QMenuBar::item:selected { background-color: #121212; }
        QMenu { background-color: #121212; border: 1px solid #3a3a3a; padding: 4px; }
        QMenu::item { padding: 6px 28px 6px 12px; }
        QMenu::item:selected { background-color: #3d9eff; color: #ffffff; }
        QToolBar { background-color: #121212; border: none; border-bottom: 1px solid #262626; spacing: 6px; padding: 4px; }
        QToolButton { background-color: transparent; border: 1px solid transparent; padding: 4px; }
        QToolButton:hover { background-color: #252525; border: 1px solid #262626; }
        QToolButton:pressed { background-color: #141414; }
        QStatusBar { background-color: #050505; border-top: 1px solid #262626; font-size: 12px; }
        QLineEdit, QPlainTextEdit, QTextEdit {
            background-color: #121212; color: #ececec; border: 1px solid #3a3a3a; padding: 5px 8px;
            selection-background-color: #3d9eff; selection-color: #ffffff;
        }
        QLineEdit:focus, QPlainTextEdit:focus, QTextEdit:focus { border: 1px solid #3d9eff; }
        QLineEdit:read-only { background-color: #050505; color: #a8a8a8; }
        QComboBox { background-color: #121212; color: #ececec; border: 1px solid #3a3a3a; padding: 4px 10px; }
        QComboBox QAbstractItemView { background-color: #121212; color: #ececec; selection-background-color: #3d9eff; selection-color: #ffffff; border: 1px solid #3a3a3a; }
        QTableView { background-color: #0c0c0c; alternate-background-color: #0a0a0a; color: #ececec; gridline-color: #262626; border: 1px solid #262626; }
        QTableView::item:selected { background-color: #3d9eff; color: #ffffff; }
        QHeaderView::section { background-color: #141414; color: #e8e8e8; padding: 5px; border: 1px solid #3a3a3a; }
        QPushButton { background-color: #242424; color: #ececec; border: 1px solid #3a3a3a; padding: 5px 14px; }
        QPushButton:hover { background-color: #323232; }
        QPushButton:pressed { background-color: #161616; }
        QGroupBox { border: 1px solid #3a3a3a; border-radius: 4px; margin-top: 8px; padding-top: 12px; font-weight: bold; }
        QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 5px; }
        QScrollBar:vertical { background: #050505; border: none; width: 12px; }
        QScrollBar::handle:vertical { background: #3a3a3a; min-height: 24px; }
        QScrollBar::handle:hover { background: #4a4a4a; }
        QScrollBar::add-line, QScrollBar::sub-line { border: none; background: none; height: 0; }
        QSplitter::handle { background-color: #262626; }
        QTabWidget::pane { border: 1px solid #262626; background-color: #0f0f0f; }
        QTabBar::tab { background-color: #181818; color: #e8e8e8; border: 1px solid #262626; padding: 6px 12px; }
        QTabBar::tab:selected { background-color: #0f0f0f; color: #ffffff; }
        QToolTip { color: #e8e8e8; background-color: #1a1a1a; border: 1px solid #3a3a3a; }
    """
    app.setStyleSheet(qss)
