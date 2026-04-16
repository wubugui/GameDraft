"""Application light/dark theme for the Qt editor (Fusion + palette + flat QSS)."""
from __future__ import annotations

from typing import Final

from PySide6.QtCore import QSettings
from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import QApplication, QGraphicsView

THEME_LIGHT: Final[str] = "light"
THEME_DARK: Final[str] = "dark"

_APP_PROP = "gameDraftEditorTheme"

# 与 QSS 主区域一致，减少 Fusion 回退绘制色差
_DARK_WINDOW = "#353535"
_DARK_BASE = "#232323"
_DARK_ALT_BASE = "#2d2d2d"
_DARK_BORDER = "#555555"
_DARK_BORDER_MUTED = "#444444"
_DARK_TEXT = "#dcdcdc"
_DARK_ACCENT = "#2a82da"

_LIGHT_WINDOW = "#ececec"
_LIGHT_BASE = "#ffffff"
_LIGHT_ALT = "#f5f5f5"
_LIGHT_BORDER = "#b0b0b0"
_LIGHT_BORDER_MUTED = "#c8c8c8"
_LIGHT_TEXT = "#1a1a1a"
_LIGHT_ACCENT = "#2a82da"


def _palette_light() -> QPalette:
    p = QPalette()
    p.setColor(QPalette.ColorRole.Window, QColor(0xEC, 0xEC, 0xEC))
    p.setColor(QPalette.ColorRole.WindowText, QColor(0x1A, 0x1A, 0x1A))
    p.setColor(QPalette.ColorRole.Base, QColor(0xFF, 0xFF, 0xFF))
    p.setColor(QPalette.ColorRole.AlternateBase, QColor(0xF5, 0xF5, 0xF5))
    p.setColor(QPalette.ColorRole.Text, QColor(0x1A, 0x1A, 0x1A))
    p.setColor(QPalette.ColorRole.Button, QColor(0xE8, 0xE8, 0xE8))
    p.setColor(QPalette.ColorRole.ButtonText, QColor(0x1A, 0x1A, 0x1A))
    p.setColor(QPalette.ColorRole.Highlight, QColor(42, 130, 218))
    p.setColor(QPalette.ColorRole.HighlightedText, QColor(255, 255, 255))
    p.setColor(QPalette.ColorRole.Link, QColor(0x1A, 0x6C, 0xC4))
    p.setColor(QPalette.ColorRole.PlaceholderText, QColor(0x80, 0x80, 0x80))
    p.setColor(QPalette.ColorRole.ToolTipBase, QColor(0xFF, 0xFF, 0xFA))
    p.setColor(QPalette.ColorRole.ToolTipText, QColor(0x1A, 0x1A, 0x1A))
    return p


def _palette_dark() -> QPalette:
    p = QPalette()
    p.setColor(QPalette.ColorRole.Window, QColor(0x35, 0x35, 0x35))
    p.setColor(QPalette.ColorRole.WindowText, QColor(0xDC, 0xDC, 0xDC))
    p.setColor(QPalette.ColorRole.Base, QColor(0x23, 0x23, 0x23))
    p.setColor(QPalette.ColorRole.AlternateBase, QColor(0x2D, 0x2D, 0x2D))
    p.setColor(QPalette.ColorRole.Text, QColor(0xDC, 0xDC, 0xDC))
    p.setColor(QPalette.ColorRole.Button, QColor(0x40, 0x40, 0x40))
    p.setColor(QPalette.ColorRole.ButtonText, QColor(0xE8, 0xE8, 0xE8))
    p.setColor(QPalette.ColorRole.Highlight, QColor(42, 130, 218))
    p.setColor(QPalette.ColorRole.HighlightedText, QColor(255, 255, 255))
    p.setColor(QPalette.ColorRole.Link, QColor(125, 180, 255))
    p.setColor(QPalette.ColorRole.PlaceholderText, QColor(160, 160, 160))
    p.setColor(QPalette.ColorRole.ToolTipBase, QColor(0x3C, 0x3C, 0x3C))
    p.setColor(QPalette.ColorRole.ToolTipText, QColor(0xE6, 0xE6, 0xE6))
    return p


def _stylesheet_flat_dark() -> str:
    w, b, ab = _DARK_WINDOW, _DARK_BASE, _DARK_ALT_BASE
    br, brm = _DARK_BORDER, _DARK_BORDER_MUTED
    tx, ac = _DARK_TEXT, _DARK_ACCENT
    return f"""
        QMainWindow {{ background-color: {w}; }}
        QWidget {{ color: {tx}; font-size: 13px; }}
        QMenuBar {{
            background-color: {w};
            border-bottom: 1px solid {brm};
            padding: 2px;
        }}
        QMenuBar::item {{ background: transparent; padding: 4px 10px; }}
        QMenuBar::item:selected {{ background-color: {ab}; }}
        QMenu {{
            background-color: {ab};
            border: 1px solid {br};
            padding: 4px;
        }}
        QMenu::item {{ padding: 6px 28px 6px 12px; }}
        QMenu::item:selected {{ background-color: {ac}; color: #ffffff; }}
        QMenu::separator {{ height: 1px; background: {brm}; margin: 4px 8px; }}
        QToolBar {{
            background-color: {ab};
            border: none;
            border-bottom: 1px solid {brm};
            spacing: 6px;
            padding: 4px;
        }}
        QToolButton {{
            background-color: transparent;
            border: 1px solid transparent;
            border-radius: 0px;
            padding: 4px;
        }}
        QToolButton:hover {{ background-color: #404040; border: 1px solid {brm}; }}
        QToolButton:pressed {{ background-color: #2a2a2a; }}
        QStatusBar {{
            background-color: {b};
            border-top: 1px solid {brm};
            font-size: 12px;
        }}
        QTabWidget::pane {{
            border: 1px solid {brm};
            background-color: {w};
            top: -1px;
        }}
        QTabBar::tab {{
            background-color: #3a3a3a;
            color: {tx};
            border: 1px solid {brm};
            border-bottom: none;
            border-top-left-radius: 0px;
            border-top-right-radius: 0px;
            min-width: 8ex;
            padding: 6px 12px;
            margin-right: 2px;
        }}
        QTabBar::tab:selected {{
            background-color: {w};
            color: #ffffff;
            border-color: {brm};
        }}
        QTabBar::tab:!selected:hover {{ background-color: #444444; }}
        QLineEdit, QPlainTextEdit, QTextEdit {{
            background-color: {ab};
            color: #ececec;
            border: 1px solid {br};
            border-radius: 0px;
            padding: 5px 8px;
            selection-background-color: {ac};
            selection-color: #ffffff;
        }}
        QLineEdit:focus, QPlainTextEdit:focus, QTextEdit:focus {{
            border: 1px solid {ac};
        }}
        QLineEdit:read-only {{
            background-color: {b};
            color: #a8a8a8;
        }}
        QComboBox {{
            background-color: {ab};
            color: #ececec;
            border: 1px solid {br};
            border-radius: 0px;
            padding: 4px 10px;
            min-height: 1.3em;
        }}
        QComboBox:hover {{ border: 1px solid #666666; }}
        QComboBox::drop-down {{ border: none; width: 22px; }}
        QComboBox QAbstractItemView {{
            background-color: {ab};
            color: #ececec;
            selection-background-color: {ac};
            selection-color: #ffffff;
            border: 1px solid {br};
            outline: 0;
        }}
        QSpinBox, QDoubleSpinBox {{
            background-color: {ab};
            color: #ececec;
            border: 1px solid {br};
            border-radius: 0px;
            padding: 3px;
        }}
        QAbstractScrollArea {{ background-color: {b}; }}
        QScrollArea {{ border: none; }}
        QScrollBar:vertical, QScrollBar:horizontal {{
            background: {b};
            border: none;
            margin: 0;
        }}
        QScrollBar::handle:vertical, QScrollBar::handle:horizontal {{
            background: #505050;
            border: none;
            min-height: 24px;
            min-width: 24px;
        }}
        QScrollBar::handle:hover {{ background: #5a5a5a; }}
        QScrollBar::add-line, QScrollBar::sub-line {{ border: none; background: none; height: 0; width: 0; }}
        QSplitter::handle {{ background-color: {brm}; }}
        QSplitter::handle:hover {{ background-color: {br}; }}
        QTreeView, QTreeWidget {{
            background-color: {b};
            border: 1px solid {brm};
            outline: 0;
        }}
        QTreeView::item, QTreeWidget::item {{ padding: 2px 0; }}
        QTreeView::item:selected, QTreeWidget::item:selected {{
            background-color: {ac};
            color: #ffffff;
        }}
        QTreeView::item:hover, QTreeWidget::item:hover {{ background-color: #3a3a3a; }}
        QListWidget {{
            background-color: {b};
            border: 1px solid {brm};
            outline: 0;
        }}
        QListWidget::item:selected {{ background-color: {ac}; color: #ffffff; }}
        QListWidget::item:hover {{ background-color: #3a3a3a; }}
        QAbstractItemView {{
            selection-background-color: {ac};
            selection-color: #ffffff;
        }}
        QTableWidget {{
            background-color: {ab};
            alternate-background-color: #323232;
            color: #ececec;
            gridline-color: {brm};
            border: 1px solid {brm};
        }}
        QTableWidget::item:selected {{ background-color: {ac}; color: #ffffff; }}
        QHeaderView::section {{
            background-color: #3a3a3a;
            color: {tx};
            padding: 5px;
            border: 1px solid {br};
        }}
        QPushButton {{
            background-color: #404040;
            color: #ececec;
            border: 1px solid {br};
            border-radius: 0px;
            padding: 5px 14px;
        }}
        QPushButton:hover {{ background-color: #4a4a4a; }}
        QPushButton:pressed {{ background-color: #2a2a2a; }}
        QPushButton:disabled {{ color: #777777; background-color: #333333; }}
        QCheckBox {{ spacing: 8px; }}
        QCheckBox::indicator {{
            width: 16px;
            height: 16px;
            border: 1px solid #666666;
            border-radius: 0px;
            background-color: {ab};
        }}
        QCheckBox::indicator:checked {{
            background-color: {ac};
            border: 1px solid {ac};
        }}
        QRadioButton::indicator {{
            width: 16px;
            height: 16px;
            border: 1px solid #666666;
            border-radius: 0px;
            background-color: {ab};
        }}
        QRadioButton::indicator:checked {{
            background-color: {ac};
            border: 1px solid {ac};
        }}
        QGroupBox {{
            border: 1px solid {br};
            margin-top: 10px;
            padding-top: 12px;
            font-weight: bold;
            border-radius: 0px;
        }}
        QGroupBox::title {{
            subcontrol-origin: margin;
            left: 10px;
            padding: 0 5px;
        }}
        QToolTip {{ color: #dddddd; background-color: #3c3c3c; border: 1px solid {br}; }}
        QProgressBar {{
            border: 1px solid {br};
            border-radius: 0px;
            text-align: center;
            background-color: {b};
        }}
        QProgressBar::chunk {{ background-color: {ac}; }}
        QSlider::groove:horizontal {{
            border: 1px solid {br};
            height: 6px;
            background: {b};
            margin: 2px 0;
        }}
        QSlider::handle:horizontal {{
            background: #505050;
            border: 1px solid {br};
            width: 14px;
            margin: -5px 0;
            border-radius: 0px;
        }}
        QSlider::groove:vertical {{
            border: 1px solid {br};
            width: 6px;
            background: {b};
            margin: 0 2px;
        }}
        QSlider::handle:vertical {{
            background: #505050;
            border: 1px solid {br};
            height: 14px;
            margin: 0 -5px;
            border-radius: 0px;
        }}
    """


def _stylesheet_flat_light() -> str:
    w, b, ab = _LIGHT_WINDOW, _LIGHT_BASE, _LIGHT_ALT
    br, brm = _LIGHT_BORDER, _LIGHT_BORDER_MUTED
    tx, ac = _LIGHT_TEXT, _LIGHT_ACCENT
    return f"""
        QMainWindow {{ background-color: {w}; }}
        QWidget {{ color: {tx}; font-size: 13px; }}
        QMenuBar {{
            background-color: {w};
            border-bottom: 1px solid {brm};
            padding: 2px;
        }}
        QMenuBar::item {{ background: transparent; padding: 4px 10px; }}
        QMenuBar::item:selected {{ background-color: {ab}; }}
        QMenu {{
            background-color: {b};
            border: 1px solid {br};
            padding: 4px;
        }}
        QMenu::item {{ padding: 6px 28px 6px 12px; }}
        QMenu::item:selected {{ background-color: {ac}; color: #ffffff; }}
        QMenu::separator {{ height: 1px; background: {brm}; margin: 4px 8px; }}
        QToolBar {{
            background-color: {ab};
            border: none;
            border-bottom: 1px solid {brm};
            spacing: 6px;
            padding: 4px;
        }}
        QToolButton {{
            background-color: transparent;
            border: 1px solid transparent;
            border-radius: 0px;
            padding: 4px;
        }}
        QToolButton:hover {{ background-color: #e0e0e0; border: 1px solid {brm}; }}
        QToolButton:pressed {{ background-color: #d0d0d0; }}
        QStatusBar {{
            background-color: {ab};
            border-top: 1px solid {brm};
            font-size: 12px;
        }}
        QTabWidget::pane {{
            border: 1px solid {brm};
            background-color: {w};
            top: -1px;
        }}
        QTabBar::tab {{
            background-color: #e0e0e0;
            color: {tx};
            border: 1px solid {brm};
            border-bottom: none;
            border-top-left-radius: 0px;
            border-top-right-radius: 0px;
            min-width: 8ex;
            padding: 6px 12px;
            margin-right: 2px;
        }}
        QTabBar::tab:selected {{
            background-color: {w};
            color: #000000;
            border-color: {brm};
        }}
        QTabBar::tab:!selected:hover {{ background-color: #d8d8d8; }}
        QLineEdit, QPlainTextEdit, QTextEdit {{
            background-color: {b};
            color: {tx};
            border: 1px solid {br};
            border-radius: 0px;
            padding: 5px 8px;
            selection-background-color: {ac};
            selection-color: #ffffff;
        }}
        QLineEdit:focus, QPlainTextEdit:focus, QTextEdit:focus {{
            border: 1px solid {ac};
        }}
        QLineEdit:read-only {{
            background-color: {ab};
            color: #666666;
        }}
        QComboBox {{
            background-color: {b};
            color: {tx};
            border: 1px solid {br};
            border-radius: 0px;
            padding: 4px 10px;
            min-height: 1.3em;
        }}
        QComboBox:hover {{ border: 1px solid #909090; }}
        QComboBox::drop-down {{ border: none; width: 22px; }}
        QComboBox QAbstractItemView {{
            background-color: {b};
            color: {tx};
            selection-background-color: {ac};
            selection-color: #ffffff;
            border: 1px solid {br};
            outline: 0;
        }}
        QSpinBox, QDoubleSpinBox {{
            background-color: {b};
            color: {tx};
            border: 1px solid {br};
            border-radius: 0px;
            padding: 3px;
        }}
        QAbstractScrollArea {{ background-color: {ab}; }}
        QScrollArea {{ border: none; }}
        QScrollBar:vertical, QScrollBar:horizontal {{
            background: {ab};
            border: none;
            margin: 0;
        }}
        QScrollBar::handle:vertical, QScrollBar::handle:horizontal {{
            background: #c0c0c0;
            border: none;
            min-height: 24px;
            min-width: 24px;
        }}
        QScrollBar::handle:hover {{ background: #a8a8a8; }}
        QScrollBar::add-line, QScrollBar::sub-line {{ border: none; background: none; height: 0; width: 0; }}
        QSplitter::handle {{ background-color: {brm}; }}
        QSplitter::handle:hover {{ background-color: {br}; }}
        QTreeView, QTreeWidget {{
            background-color: {b};
            border: 1px solid {brm};
            outline: 0;
        }}
        QTreeView::item, QTreeWidget::item {{ padding: 2px 0; }}
        QTreeView::item:selected, QTreeWidget::item:selected {{
            background-color: {ac};
            color: #ffffff;
        }}
        QTreeView::item:hover, QTreeWidget::item:hover {{ background-color: #e8f2fc; }}
        QListWidget {{
            background-color: {b};
            border: 1px solid {brm};
            outline: 0;
        }}
        QListWidget::item:selected {{ background-color: {ac}; color: #ffffff; }}
        QListWidget::item:hover {{ background-color: #e8f2fc; }}
        QAbstractItemView {{
            selection-background-color: {ac};
            selection-color: #ffffff;
        }}
        QTableWidget {{
            background-color: {b};
            alternate-background-color: {ab};
            color: {tx};
            gridline-color: {brm};
            border: 1px solid {brm};
        }}
        QTableWidget::item:selected {{ background-color: {ac}; color: #ffffff; }}
        QHeaderView::section {{
            background-color: #e0e0e0;
            color: {tx};
            padding: 5px;
            border: 1px solid {br};
        }}
        QPushButton {{
            background-color: #e8e8e8;
            color: {tx};
            border: 1px solid {br};
            border-radius: 0px;
            padding: 5px 14px;
        }}
        QPushButton:hover {{ background-color: #dedede; }}
        QPushButton:pressed {{ background-color: #d0d0d0; }}
        QPushButton:disabled {{ color: #a0a0a0; background-color: #f0f0f0; }}
        QCheckBox {{ spacing: 8px; }}
        QCheckBox::indicator {{
            width: 16px;
            height: 16px;
            border: 1px solid {br};
            border-radius: 0px;
            background-color: {b};
        }}
        QCheckBox::indicator:checked {{
            background-color: {ac};
            border: 1px solid {ac};
        }}
        QRadioButton::indicator {{
            width: 16px;
            height: 16px;
            border: 1px solid {br};
            border-radius: 0px;
            background-color: {b};
        }}
        QRadioButton::indicator:checked {{
            background-color: {ac};
            border: 1px solid {ac};
        }}
        QGroupBox {{
            border: 1px solid {br};
            margin-top: 10px;
            padding-top: 12px;
            font-weight: bold;
            border-radius: 0px;
        }}
        QGroupBox::title {{
            subcontrol-origin: margin;
            left: 10px;
            padding: 0 5px;
        }}
        QToolTip {{ color: #1a1a1a; background-color: #fffffa; border: 1px solid {br}; }}
        QProgressBar {{
            border: 1px solid {br};
            border-radius: 0px;
            text-align: center;
            background-color: {ab};
        }}
        QProgressBar::chunk {{ background-color: {ac}; }}
        QSlider::groove:horizontal {{
            border: 1px solid {br};
            height: 6px;
            background: {ab};
            margin: 2px 0;
        }}
        QSlider::handle:horizontal {{
            background: #d0d0d0;
            border: 1px solid {br};
            width: 14px;
            margin: -5px 0;
            border-radius: 0px;
        }}
        QSlider::groove:vertical {{
            border: 1px solid {br};
            width: 6px;
            background: {ab};
            margin: 0 2px;
        }}
        QSlider::handle:vertical {{
            background: #d0d0d0;
            border: 1px solid {br};
            height: 14px;
            margin: 0 -5px;
            border-radius: 0px;
        }}
    """


def current_theme_id() -> str:
    app = QApplication.instance()
    if app is None:
        return THEME_DARK
    v = app.property(_APP_PROP)
    if v in (THEME_LIGHT, THEME_DARK):
        return str(v)
    return THEME_DARK


def apply_application_theme(app: QApplication, theme_id: str) -> None:
    if theme_id not in (THEME_LIGHT, THEME_DARK):
        theme_id = THEME_DARK
    app.setStyle("Fusion")
    app.setProperty(_APP_PROP, theme_id)
    if theme_id == THEME_DARK:
        app.setPalette(_palette_dark())
        app.setStyleSheet(_stylesheet_flat_dark())
    else:
        app.setPalette(_palette_light())
        app.setStyleSheet(_stylesheet_flat_light())


def apply_graphics_view_background(view: QGraphicsView, theme_id: str) -> None:
    from PySide6.QtGui import QBrush

    if theme_id == THEME_DARK:
        view.setBackgroundBrush(QBrush(QColor(0x2D, 0x2D, 0x2D)))
    else:
        view.setBackgroundBrush(QBrush(QColor(0xF0, 0xF0, 0xF0)))


def refresh_all_graphics_views(root, theme_id: str) -> None:
    for v in root.findChildren(QGraphicsView):
        apply_graphics_view_background(v, theme_id)


def settings_load_theme() -> str:
    s = QSettings("GameDraft", "Editor")
    v = s.value("theme", THEME_DARK)
    if v in (THEME_LIGHT, THEME_DARK):
        return str(v)
    return THEME_DARK


def settings_save_theme(theme_id: str) -> None:
    if theme_id not in (THEME_LIGHT, THEME_DARK):
        return
    s = QSettings("GameDraft", "Editor")
    s.setValue("theme", theme_id)


def secondary_label_stylesheet(theme_id: str) -> str:
    if theme_id == THEME_DARK:
        return "color: #A0A0A0;"
    return "color: #666666;"
