import sys
import argparse

from PySide6.QtWidgets import QApplication, QStyleFactory
from PySide6.QtGui import QPalette, QColor
from PySide6.QtCore import Qt

from tools.editor.shared.qt_combo_wheel_guard import install_global_combo_wheel_block

from .main_window import MainWindow


def setup_dark_theme(app: QApplication):
    # Windows 默认样式常忽略调色板，输入框仍为白底；Fusion + 样式表可统一深色控件。
    app.setStyle(QStyleFactory.create("Fusion"))

    palette = QPalette()
    palette.setColor(QPalette.ColorRole.Window, QColor(30, 30, 30))
    palette.setColor(QPalette.ColorRole.WindowText, QColor(220, 220, 220))
    palette.setColor(QPalette.ColorRole.Base, QColor(25, 25, 25))
    palette.setColor(QPalette.ColorRole.AlternateBase, QColor(40, 40, 40))
    palette.setColor(QPalette.ColorRole.ToolTipBase, QColor(50, 50, 50))
    palette.setColor(QPalette.ColorRole.ToolTipText, QColor(220, 220, 220))
    palette.setColor(QPalette.ColorRole.Text, QColor(220, 220, 220))
    palette.setColor(QPalette.ColorRole.PlaceholderText, QColor(140, 140, 140))
    palette.setColor(QPalette.ColorRole.Button, QColor(45, 45, 45))
    palette.setColor(QPalette.ColorRole.ButtonText, QColor(220, 220, 220))
    palette.setColor(QPalette.ColorRole.BrightText, QColor(255, 0, 0))
    palette.setColor(QPalette.ColorRole.Link, QColor(100, 149, 237))
    palette.setColor(QPalette.ColorRole.Highlight, QColor(65, 105, 225))
    palette.setColor(QPalette.ColorRole.HighlightedText, QColor(255, 255, 255))
    app.setPalette(palette)
    app.setStyleSheet("""
        QMainWindow { background-color: #1e1e1e; }
        QWidget { color: #e0e0e0; font-size: 13px; }
        QLineEdit, QPlainTextEdit, QTextEdit {
            background-color: #2d2d2d;
            color: #ececec;
            border: 1px solid #555;
            border-radius: 4px;
            padding: 5px 8px;
            selection-background-color: #4169e1;
            selection-color: #ffffff;
        }
        QLineEdit:focus, QPlainTextEdit:focus, QTextEdit:focus {
            border: 1px solid #6a9cff;
        }
        QLineEdit:read-only {
            background-color: #252525;
            color: #b0b0b0;
        }
        QComboBox {
            background-color: #2d2d2d;
            color: #ececec;
            border: 1px solid #555;
            border-radius: 4px;
            padding: 4px 10px;
            min-height: 1.3em;
        }
        QComboBox:hover { border: 1px solid #666; }
        QComboBox::drop-down { border: none; width: 22px; }
        QComboBox QAbstractItemView {
            background-color: #2d2d2d;
            color: #ececec;
            selection-background-color: #4169e1;
            selection-color: #ffffff;
            border: 1px solid #555;
            outline: 0;
        }
        QSpinBox, QDoubleSpinBox {
            background-color: #2d2d2d;
            color: #ececec;
            border: 1px solid #555;
            border-radius: 4px;
            padding: 3px;
        }
        QTableWidget {
            background-color: #2a2a2a;
            alternate-background-color: #323232;
            color: #ececec;
            gridline-color: #444;
            border: 1px solid #444;
        }
        QTableWidget::item:selected {
            background-color: #4169e1;
            color: #ffffff;
        }
        QHeaderView::section {
            background-color: #3a3a3a;
            color: #e0e0e0;
            padding: 5px;
            border: 1px solid #555;
        }
        QAbstractScrollArea { background-color: #252525; }
        QScrollArea { border: none; }
        QSplitter::handle { background-color: #3a3a3a; }
        QTreeWidget {
            font-size: 12px;
            background-color: #252525;
            border: 1px solid #444;
            outline: 0;
        }
        QTreeWidget::item { padding: 2px 0; }
        QTreeWidget::item:selected { background-color: #4169e1; color: #ffffff; }
        QTreeWidget::item:hover { background-color: #353535; }
        QPushButton {
            background-color: #404040;
            color: #ececec;
            border: 1px solid #555;
            border-radius: 4px;
            padding: 5px 14px;
        }
        QPushButton:hover { background-color: #4a4a4a; }
        QPushButton:pressed { background-color: #353535; }
        QPushButton:disabled { color: #777; background-color: #333; }
        QCheckBox { spacing: 8px; }
        QCheckBox::indicator {
            width: 16px;
            height: 16px;
            border: 1px solid #666;
            border-radius: 3px;
            background-color: #2d2d2d;
        }
        QCheckBox::indicator:checked {
            background-color: #4169e1;
            border: 1px solid #5a7fd9;
        }
        QGroupBox {
            border: 1px solid #555;
            margin-top: 10px;
            padding-top: 12px;
            font-weight: bold;
        }
        QGroupBox::title {
            subcontrol-origin: margin;
            left: 10px;
            padding: 0 5px;
        }
        QToolTip { color: #ddd; background-color: #333; border: 1px solid #555; }
        QToolBar {
            spacing: 6px;
            padding: 4px;
            background-color: #2a2a2a;
            border-bottom: 1px solid #444;
        }
        QStatusBar {
            font-size: 12px;
            background-color: #252525;
            border-top: 1px solid #444;
        }
        QLabel { color: #d4d4d4; }
    """)


def main():
    parser = argparse.ArgumentParser(description="Game Logic Graph Editor")
    parser.add_argument("--project", type=str, required=True, help="Path to game project root")
    args = parser.parse_args()

    app = QApplication(sys.argv)
    install_global_combo_wheel_block(app)
    setup_dark_theme(app)

    window = MainWindow(args.project)
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
