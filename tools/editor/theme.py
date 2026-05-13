"""Application themes for the Qt editor (Fusion + palette + QSS): light, near-black, VS Code–style modern dark."""
from __future__ import annotations

from typing import Final

from PySide6.QtCore import QSettings
from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import QApplication, QGraphicsView

THEME_LIGHT: Final[str] = "light"
THEME_DARK: Final[str] = "dark"
# 参考 VS Code Dark+：侧栏/编辑区层次、列表选中色、略圆角控件
THEME_MODERN: Final[str] = "modern"

_APP_PROP = "gameDraftEditorTheme"

ALL_THEME_IDS: Final[tuple[str, ...]] = (THEME_LIGHT, THEME_DARK, THEME_MODERN)

# 与 QSS 主区域一致，减少 Fusion 回退绘制色差（近黑主题，非中性灰）
_DARK_WINDOW = "#0f0f0f"
_DARK_BASE = "#050505"
_DARK_ALT_BASE = "#121212"
_DARK_BORDER = "#3a3a3a"
_DARK_BORDER_MUTED = "#262626"
_DARK_TEXT = "#e8e8e8"
_DARK_ACCENT = "#3d9eff"

_LIGHT_WINDOW = "#ececec"
_LIGHT_BASE = "#ffffff"
_LIGHT_ALT = "#f5f5f5"
_LIGHT_BORDER = "#b0b0b0"
_LIGHT_BORDER_MUTED = "#c8c8c8"
_LIGHT_TEXT = "#1a1a1a"
_LIGHT_ACCENT = "#2a82da"

_MODERN_WINDOW = "#2d2d30"
_MODERN_TOOLBAR = "#252526"
_MODERN_BASE = "#1e1e1e"
_MODERN_ALT = "#3c3c3c"
_MODERN_BORDER = "#474747"
_MODERN_BORDER_MUTED = "#3e3e42"
_MODERN_TEXT = "#cccccc"
_MODERN_ACCENT = "#0078d4"
_MODERN_LIST_SEL = "#04395e"
_MODERN_LIST_HOVER = "#2a2d2e"


def is_dark_theme(theme_id: str) -> bool:
    return theme_id in (THEME_DARK, THEME_MODERN)


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
    p.setColor(QPalette.ColorRole.ToolTipBase, QColor(0x1A, 0x1A, 0x1A))
    p.setColor(QPalette.ColorRole.ToolTipText, QColor(0xE8, 0xE8, 0xE8))
    return p


def _palette_modern() -> QPalette:
    p = QPalette()
    p.setColor(QPalette.ColorRole.Window, QColor(0x2D, 0x2D, 0x30))
    p.setColor(QPalette.ColorRole.WindowText, QColor(0xCC, 0xCC, 0xCC))
    p.setColor(QPalette.ColorRole.Base, QColor(0x1E, 0x1E, 0x1E))
    p.setColor(QPalette.ColorRole.AlternateBase, QColor(0x3C, 0x3C, 0x3C))
    p.setColor(QPalette.ColorRole.Text, QColor(0xCC, 0xCC, 0xCC))
    p.setColor(QPalette.ColorRole.Button, QColor(0x3C, 0x3C, 0x3C))
    p.setColor(QPalette.ColorRole.ButtonText, QColor(0xF0, 0xF0, 0xF0))
    p.setColor(QPalette.ColorRole.Highlight, QColor(4, 57, 94))
    p.setColor(QPalette.ColorRole.HighlightedText, QColor(255, 255, 255))
    p.setColor(QPalette.ColorRole.Link, QColor(55, 148, 255))
    p.setColor(QPalette.ColorRole.PlaceholderText, QColor(118, 118, 118))
    p.setColor(QPalette.ColorRole.ToolTipBase, QColor(0x25, 0x25, 0x26))
    p.setColor(QPalette.ColorRole.ToolTipText, QColor(0xCC, 0xCC, 0xCC))
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
        QToolButton:hover {{ background-color: #252525; border: 1px solid {brm}; }}
        QToolButton:pressed {{ background-color: #141414; }}
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
            background-color: #181818;
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
        QTabBar::tab:!selected:hover {{ background-color: #282828; }}
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
        QComboBox:hover {{ border: 1px solid #505050; }}
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
            background: #3a3a3a;
            border: none;
            min-height: 24px;
            min-width: 24px;
        }}
        QScrollBar::handle:hover {{ background: #4a4a4a; }}
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
        QTreeView::item:hover, QTreeWidget::item:hover {{ background-color: #1c1c1c; }}
        QListWidget {{
            background-color: {b};
            border: 1px solid {brm};
            outline: 0;
        }}
        QListWidget::item:selected {{ background-color: {ac}; color: #ffffff; }}
        QListWidget::item:hover {{ background-color: #1c1c1c; }}
        QAbstractItemView {{
            selection-background-color: {ac};
            selection-color: #ffffff;
        }}
        QTableWidget {{
            background-color: {ab};
            alternate-background-color: #0c0c0c;
            color: #ececec;
            gridline-color: {brm};
            border: 1px solid {brm};
        }}
        QTableWidget::item:selected {{ background-color: {ac}; color: #ffffff; }}
        QHeaderView::section {{
            background-color: #141414;
            color: {tx};
            padding: 5px;
            border: 1px solid {br};
        }}
        QPushButton {{
            background-color: #242424;
            color: #ececec;
            border: 1px solid {br};
            border-radius: 0px;
            padding: 5px 14px;
        }}
        QPushButton:hover {{ background-color: #323232; }}
        QPushButton:pressed {{ background-color: #161616; }}
        QPushButton:disabled {{ color: #666666; background-color: #141414; }}
        QCheckBox {{ spacing: 8px; }}
        QCheckBox::indicator {{
            width: 16px;
            height: 16px;
            border: 1px solid #4a4a4a;
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
            border: 1px solid #4a4a4a;
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
        QToolTip {{ color: #e8e8e8; background-color: #1a1a1a; border: 1px solid {br}; }}
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
            background: #383838;
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
            background: #383838;
            border: 1px solid {br};
            height: 14px;
            margin: 0 -5px;
            border-radius: 0px;
        }}
    """


def _stylesheet_flat_modern() -> str:
    w = _MODERN_WINDOW
    b = _MODERN_BASE
    ab = _MODERN_ALT
    br, brm = _MODERN_BORDER, _MODERN_BORDER_MUTED
    tx, ac = _MODERN_TEXT, _MODERN_ACCENT
    sel = _MODERN_LIST_SEL
    hov = _MODERN_LIST_HOVER
    tbar = _MODERN_TOOLBAR
    return f"""
        QMainWindow {{ background-color: {w}; }}
        QWidget {{
            color: {tx};
            font-size: 13px;
            font-family: "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif;
        }}
        QMenuBar {{
            background-color: {w};
            border-bottom: 1px solid {brm};
            padding: 2px;
        }}
        QMenuBar::item {{ background: transparent; padding: 4px 10px; }}
        QMenuBar::item:selected {{ background-color: {ab}; border-radius: 3px; }}
        QMenu {{
            background-color: {ab};
            border: 1px solid {br};
            padding: 4px;
            border-radius: 4px;
        }}
        QMenu::item {{ padding: 6px 28px 6px 12px; }}
        QMenu::item:selected {{ background-color: {ac}; color: #ffffff; border-radius: 3px; }}
        QMenu::separator {{ height: 1px; background: {brm}; margin: 4px 8px; }}
        QToolBar {{
            background-color: {tbar};
            border: none;
            border-bottom: 1px solid {brm};
            spacing: 6px;
            padding: 4px;
        }}
        QToolButton {{
            background-color: transparent;
            border: 1px solid transparent;
            border-radius: 4px;
            padding: 4px;
        }}
        QToolButton:hover {{ background-color: {hov}; border: 1px solid {brm}; }}
        QToolButton:pressed {{ background-color: {sel}; }}
        QStatusBar {{
            background-color: {tbar};
            border-top: 1px solid {brm};
            font-size: 12px;
        }}
        QTabWidget::pane {{
            border: 1px solid {brm};
            background-color: {b};
            top: -1px;
            border-radius: 0px;
        }}
        QTabBar::tab {{
            background-color: #2d2d30;
            color: {tx};
            border: 1px solid {brm};
            border-bottom: none;
            border-top-left-radius: 5px;
            border-top-right-radius: 5px;
            min-width: 8ex;
            padding: 6px 14px;
            margin-right: 2px;
        }}
        QTabBar::tab:selected {{
            background-color: {b};
            color: #ffffff;
            border-color: {brm};
        }}
        QTabBar::tab:!selected:hover {{ background-color: {hov}; }}
        QLineEdit, QPlainTextEdit, QTextEdit {{
            background-color: {ab};
            color: #f3f3f3;
            border: 1px solid {br};
            border-radius: 4px;
            padding: 5px 10px;
            selection-background-color: {sel};
            selection-color: #ffffff;
        }}
        QLineEdit:focus, QPlainTextEdit:focus, QTextEdit:focus {{
            border: 1px solid {ac};
        }}
        QLineEdit:read-only {{
            background-color: {b};
            color: #858585;
        }}
        QComboBox {{
            background-color: {ab};
            color: #f3f3f3;
            border: 1px solid {br};
            border-radius: 4px;
            padding: 4px 10px;
            min-height: 1.3em;
        }}
        QComboBox:hover {{ border: 1px solid #6e6e6e; }}
        QComboBox::drop-down {{ border: none; width: 22px; }}
        QComboBox QAbstractItemView {{
            background-color: {ab};
            color: #f3f3f3;
            selection-background-color: {sel};
            selection-color: #ffffff;
            border: 1px solid {br};
            outline: 0;
        }}
        QSpinBox, QDoubleSpinBox {{
            background-color: {ab};
            color: #f3f3f3;
            border: 1px solid {br};
            border-radius: 4px;
            padding: 3px 6px;
        }}
        QAbstractScrollArea {{ background-color: {b}; }}
        QScrollArea {{ border: none; }}
        QScrollBar:vertical, QScrollBar:horizontal {{
            background: {b};
            border: none;
            margin: 0;
        }}
        QScrollBar::handle:vertical, QScrollBar::handle:horizontal {{
            background: #686868;
            border: none;
            border-radius: 4px;
            min-height: 24px;
            min-width: 24px;
        }}
        QScrollBar::handle:hover {{ background: #7e7e7e; }}
        QScrollBar::add-line, QScrollBar::sub-line {{ border: none; background: none; height: 0; width: 0; }}
        QSplitter::handle {{ background-color: {brm}; }}
        QSplitter::handle:hover {{ background-color: {br}; }}
        QTreeView, QTreeWidget {{
            background-color: {tbar};
            border: 1px solid {brm};
            outline: 0;
        }}
        QTreeView::item, QTreeWidget::item {{ padding: 3px 2px; }}
        QTreeView::item:selected, QTreeWidget::item:selected {{
            background-color: {sel};
            color: #ffffff;
        }}
        QTreeView::item:hover, QTreeWidget::item:hover {{ background-color: {hov}; }}
        QListWidget {{
            background-color: {tbar};
            border: 1px solid {brm};
            outline: 0;
        }}
        QListWidget::item:selected {{ background-color: {sel}; color: #ffffff; }}
        QListWidget::item:hover {{ background-color: {hov}; }}
        QAbstractItemView {{
            selection-background-color: {sel};
            selection-color: #ffffff;
        }}
        QTableWidget {{
            background-color: {b};
            alternate-background-color: #252526;
            color: #f3f3f3;
            gridline-color: {brm};
            border: 1px solid {brm};
        }}
        QTableWidget::item:selected {{ background-color: {sel}; color: #ffffff; }}
        QHeaderView::section {{
            background-color: #2d2d30;
            color: {tx};
            padding: 6px;
            border: 1px solid {br};
        }}
        QPushButton {{
            background-color: #0e639c;
            color: #ffffff;
            border: 1px solid #1177bb;
            border-radius: 4px;
            padding: 5px 14px;
        }}
        QPushButton:hover {{ background-color: #1177bb; }}
        QPushButton:pressed {{ background-color: #0d5a8f; }}
        QPushButton:disabled {{ color: #6e6e6e; background-color: #3c3c3c; border-color: {brm}; }}
        QCheckBox {{ spacing: 8px; }}
        QCheckBox::indicator {{
            width: 16px;
            height: 16px;
            border: 1px solid #6e6e6e;
            border-radius: 3px;
            background-color: {ab};
        }}
        QCheckBox::indicator:checked {{
            background-color: {ac};
            border: 1px solid {ac};
        }}
        QRadioButton::indicator {{
            width: 16px;
            height: 16px;
            border: 1px solid #6e6e6e;
            border-radius: 8px;
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
            border-radius: 6px;
        }}
        QGroupBox::title {{
            subcontrol-origin: margin;
            left: 10px;
            padding: 0 5px;
        }}
        QToolTip {{ color: {tx}; background-color: #252526; border: 1px solid {br}; }}
        QProgressBar {{
            border: 1px solid {br};
            border-radius: 4px;
            text-align: center;
            background-color: {b};
        }}
        QProgressBar::chunk {{ background-color: {ac}; border-radius: 3px; }}
        QSlider::groove:horizontal {{
            border: 1px solid {br};
            height: 6px;
            background: {b};
            margin: 2px 0;
            border-radius: 3px;
        }}
        QSlider::handle:horizontal {{
            background: #c8c8c8;
            border: 1px solid {br};
            width: 14px;
            margin: -5px 0;
            border-radius: 4px;
        }}
        QSlider::groove:vertical {{
            border: 1px solid {br};
            width: 6px;
            background: {b};
            margin: 0 2px;
            border-radius: 3px;
        }}
        QSlider::handle:vertical {{
            background: #c8c8c8;
            border: 1px solid {br};
            height: 14px;
            margin: 0 -5px;
            border-radius: 4px;
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
        return THEME_MODERN
    v = app.property(_APP_PROP)
    if v in ALL_THEME_IDS:
        return str(v)
    return THEME_MODERN


def apply_application_theme(app: QApplication, theme_id: str) -> None:
    if theme_id not in ALL_THEME_IDS:
        theme_id = THEME_MODERN
    app.setStyle("Fusion")
    app.setProperty(_APP_PROP, theme_id)
    if theme_id == THEME_MODERN:
        app.setPalette(_palette_modern())
        app.setStyleSheet(_stylesheet_flat_modern())
    elif theme_id == THEME_DARK:
        app.setPalette(_palette_dark())
        app.setStyleSheet(_stylesheet_flat_dark())
    else:
        app.setPalette(_palette_light())
        app.setStyleSheet(_stylesheet_flat_light())


def apply_graphics_view_background(view: QGraphicsView, theme_id: str) -> None:
    from PySide6.QtGui import QBrush

    if theme_id == THEME_LIGHT:
        view.setBackgroundBrush(QBrush(QColor(0xF0, 0xF0, 0xF0)))
    elif theme_id == THEME_MODERN:
        view.setBackgroundBrush(QBrush(QColor(0x1E, 0x1E, 0x1E)))
    else:
        view.setBackgroundBrush(QBrush(QColor(0x10, 0x10, 0x10)))


def refresh_all_graphics_views(root, theme_id: str) -> None:
    for v in root.findChildren(QGraphicsView):
        apply_graphics_view_background(v, theme_id)


def settings_load_theme() -> str:
    s = QSettings("GameDraft", "Editor")
    v = s.value("theme", THEME_MODERN)
    if v in ALL_THEME_IDS:
        return str(v)
    return THEME_MODERN


def settings_save_theme(theme_id: str) -> None:
    if theme_id not in ALL_THEME_IDS:
        return
    s = QSettings("GameDraft", "Editor")
    s.setValue("theme", theme_id)


def secondary_label_stylesheet(theme_id: str) -> str:
    if theme_id == THEME_DARK:
        return "color: #9a9a9a;"
    if theme_id == THEME_MODERN:
        return "color: #858585;"
    return "color: #666666;"
