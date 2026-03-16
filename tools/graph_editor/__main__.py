import sys
import argparse

from PySide6.QtWidgets import QApplication
from PySide6.QtGui import QPalette, QColor
from PySide6.QtCore import Qt

from .main_window import MainWindow


def setup_dark_theme(app: QApplication):
    palette = QPalette()
    palette.setColor(QPalette.ColorRole.Window, QColor(30, 30, 30))
    palette.setColor(QPalette.ColorRole.WindowText, QColor(220, 220, 220))
    palette.setColor(QPalette.ColorRole.Base, QColor(25, 25, 25))
    palette.setColor(QPalette.ColorRole.AlternateBase, QColor(40, 40, 40))
    palette.setColor(QPalette.ColorRole.ToolTipBase, QColor(50, 50, 50))
    palette.setColor(QPalette.ColorRole.ToolTipText, QColor(220, 220, 220))
    palette.setColor(QPalette.ColorRole.Text, QColor(220, 220, 220))
    palette.setColor(QPalette.ColorRole.Button, QColor(45, 45, 45))
    palette.setColor(QPalette.ColorRole.ButtonText, QColor(220, 220, 220))
    palette.setColor(QPalette.ColorRole.BrightText, QColor(255, 0, 0))
    palette.setColor(QPalette.ColorRole.Link, QColor(100, 149, 237))
    palette.setColor(QPalette.ColorRole.Highlight, QColor(65, 105, 225))
    palette.setColor(QPalette.ColorRole.HighlightedText, QColor(255, 255, 255))
    app.setPalette(palette)
    app.setStyleSheet("""
        QToolTip { color: #ddd; background-color: #333; border: 1px solid #555; }
        QToolBar { spacing: 4px; padding: 2px; }
        QTreeWidget { font-size: 12px; }
        QStatusBar { font-size: 12px; }
    """)


def main():
    parser = argparse.ArgumentParser(description="Game Logic Graph Editor")
    parser.add_argument("--project", type=str, required=True, help="Path to game project root")
    args = parser.parse_args()

    app = QApplication(sys.argv)
    setup_dark_theme(app)

    window = MainWindow(args.project)
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
