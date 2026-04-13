import argparse
import sys

from PySide6.QtWidgets import QApplication, QStyleFactory
from PySide6.QtGui import QPalette, QColor

from tools.editor.shared.qt_combo_wheel_guard import install_global_combo_wheel_block

from .main_window import MainWindow


def setup_dark_theme(app: QApplication):
    app.setStyle(QStyleFactory.create("Fusion"))
    palette = QPalette()
    palette.setColor(QPalette.ColorRole.Window, QColor(30, 30, 30))
    palette.setColor(QPalette.ColorRole.WindowText, QColor(220, 220, 220))
    palette.setColor(QPalette.ColorRole.Base, QColor(25, 25, 25))
    palette.setColor(QPalette.ColorRole.Text, QColor(220, 220, 220))
    palette.setColor(QPalette.ColorRole.Button, QColor(45, 45, 45))
    palette.setColor(QPalette.ColorRole.Highlight, QColor(65, 105, 225))
    palette.setColor(QPalette.ColorRole.HighlightedText, QColor(255, 255, 255))
    app.setPalette(palette)
    app.setStyleSheet(
        """
        QMainWindow { background-color: #1e1e1e; }
        QWidget { color: #e0e0e0; font-size: 13px; }
        QListWidget {
            background-color: #252525;
            border: 1px solid #444;
            outline: 0;
        }
        QListWidget::item:selected { background-color: #4169e1; color: #fff; }
        QLineEdit, QPlainTextEdit, QTextEdit {
            background-color: #2d2d2d;
            color: #ececec;
            border: 1px solid #555;
            border-radius: 4px;
            padding: 5px 8px;
        }
        QGroupBox { border: 1px solid #555; margin-top: 10px; padding-top: 12px; font-weight: bold; }
        QPushButton {
            background-color: #404040;
            color: #ececec;
            border: 1px solid #555;
            border-radius: 4px;
            padding: 5px 14px;
        }
        QScrollArea { border: none; }
        """
    )


def main():
    parser = argparse.ArgumentParser(description="图对话 JSON 编辑器")
    parser.add_argument("--project", type=str, required=True, help="游戏工程根目录（含 public/assets）")
    args = parser.parse_args()

    app = QApplication(sys.argv)
    install_global_combo_wheel_block(app)
    setup_dark_theme(app)
    w = MainWindow(args.project)
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
