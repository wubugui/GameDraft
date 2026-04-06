"""Application light/dark theme for the Qt editor (Fusion + palette)."""
from __future__ import annotations

from typing import Final

from PySide6.QtCore import QSettings
from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import QApplication, QGraphicsView

THEME_LIGHT: Final[str] = "light"
THEME_DARK: Final[str] = "dark"

_APP_PROP = "gameDraftEditorTheme"


def _palette_light() -> QPalette:
    p = QPalette()
    return p


def _palette_dark() -> QPalette:
    # Standard Fusion-friendly dark palette
    p = QPalette()
    p.setColor(QPalette.ColorRole.Window, QColor(53, 53, 53))
    p.setColor(QPalette.ColorRole.WindowText, QColor(220, 220, 220))
    p.setColor(QPalette.ColorRole.Base, QColor(35, 35, 35))
    p.setColor(QPalette.ColorRole.AlternateBase, QColor(45, 45, 45))
    p.setColor(QPalette.ColorRole.Text, QColor(220, 220, 220))
    p.setColor(QPalette.ColorRole.Button, QColor(53, 53, 53))
    p.setColor(QPalette.ColorRole.ButtonText, QColor(220, 220, 220))
    p.setColor(QPalette.ColorRole.Highlight, QColor(42, 130, 218))
    p.setColor(QPalette.ColorRole.HighlightedText, QColor(255, 255, 255))
    p.setColor(QPalette.ColorRole.Link, QColor(125, 180, 255))
    p.setColor(QPalette.ColorRole.PlaceholderText, QColor(160, 160, 160))
    p.setColor(QPalette.ColorRole.ToolTipBase, QColor(60, 60, 60))
    p.setColor(QPalette.ColorRole.ToolTipText, QColor(230, 230, 230))
    return p


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
    else:
        app.setPalette(_palette_light())


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


def ink_actions_label_stylesheet(theme_id: str) -> str:
    if theme_id == THEME_DARK:
        return "color: #C8B450; font-size: 9pt;"
    return "color: #8A6F20; font-size: 9pt;"


def ink_simulator_text_colors(theme_id: str) -> dict[str, QColor]:
    if theme_id == THEME_DARK:
        return {
            "choice": QColor(150, 220, 150),
            "speaker": QColor(100, 200, 255),
            "body": QColor(220, 220, 220),
            "plain": QColor(220, 220, 220),
            "system": QColor(140, 140, 160),
        }
    return {
        "choice": QColor(30, 110, 50),
        "speaker": QColor(0, 90, 180),
        "body": QColor(30, 30, 30),
        "plain": QColor(30, 30, 30),
        "system": QColor(90, 90, 110),
    }


def ink_syntax_base_colors(theme_id: str) -> dict[str, QColor]:
    if theme_id == THEME_DARK:
        return {
            "knot": QColor(100, 200, 255),
            "tag": QColor(200, 180, 80),
            "choice": QColor(150, 220, 150),
            "ext": QColor(200, 120, 120),
            "divert": QColor(180, 140, 220),
            "cond": QColor(220, 160, 100),
            "err_line": QColor(255, 80, 80),
            "warn_line": QColor(220, 180, 60),
        }
    return {
        "knot": QColor(0, 100, 170),
        "tag": QColor(130, 100, 0),
        "choice": QColor(30, 110, 50),
        "ext": QColor(160, 50, 50),
        "divert": QColor(100, 50, 150),
        "cond": QColor(160, 90, 30),
        "err_line": QColor(200, 40, 40),
        "warn_line": QColor(160, 120, 20),
    }
