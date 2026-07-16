"""Application themes for the Qt editor (Fusion + palette + QSS): light, near-black, VS Code–style modern dark."""
from __future__ import annotations

from typing import Final

from PySide6.QtCore import QSettings
from PySide6.QtGui import QColor, QFont, QPalette
from PySide6.QtWidgets import QApplication, QGraphicsView, QWidget

THEME_LIGHT: Final[str] = "light"
THEME_DARK: Final[str] = "dark"
# 参考 VS Code Dark+：侧栏/编辑区层次、列表选中色、略圆角控件
THEME_MODERN: Final[str] = "modern"

_APP_PROP = "gameDraftEditorTheme"
_FONT_PX_PROP = "gameDraftEditorFontPx"

ALL_THEME_IDS: Final[tuple[str, ...]] = (THEME_LIGHT, THEME_DARK, THEME_MODERN)

# 全局基准字号(px)。小屏可调小;QSS 与 QApplication.setFont 同步用同一像素值。
DEFAULT_FONT_PX: Final[int] = 13
MIN_FONT_PX: Final[int] = 9
MAX_FONT_PX: Final[int] = 20

FONT_ROLE_BASE: Final[str] = "base"
FONT_ROLE_SECONDARY: Final[str] = "secondary"
FONT_ROLE_HINT: Final[str] = "hint"
FONT_ROLE_PROMINENT: Final[str] = "prominent"
FONT_ROLE_CANVAS_PROMINENT: Final[str] = "canvas-prominent"
FONT_ROLE_CANVAS_PRIMARY: Final[str] = "canvas-primary"
FONT_ROLE_CANVAS_SECONDARY: Final[str] = "canvas-secondary"
FONT_ROLE_CANVAS_MICRO: Final[str] = "canvas-micro"

_FONT_ROLE_SPECS: Final[dict[str, tuple[int, int]]] = {
    FONT_ROLE_BASE: (0, MIN_FONT_PX),
    FONT_ROLE_SECONDARY: (-1, 8),
    FONT_ROLE_HINT: (-2, 8),
    FONT_ROLE_PROMINENT: (2, MIN_FONT_PX + 2),
    FONT_ROLE_CANVAS_PROMINENT: (7, 16),
    FONT_ROLE_CANVAS_PRIMARY: (-1, 9),
    FONT_ROLE_CANVAS_SECONDARY: (-3, 8),
    FONT_ROLE_CANVAS_MICRO: (-5, 7),
}

_WEB_FONT_STEPS: Final[tuple[float, ...]] = (
    9.0, 10.0, 10.5, 11.0, 11.5, 12.0, 13.0, 14.0, 15.0, 18.0,
)

_EDITOR_FONT_ROLE_PROP = "editorFontRole"
_GRAPHICS_FONT_ROLE_ATTR = "_game_draft_font_role"
_GRAPHICS_FONT_FAMILY_ATTR = "_game_draft_font_family"
_GRAPHICS_FONT_WEIGHT_ATTR = "_game_draft_font_weight"
_GRAPHICS_FONT_STYLE_HINT_ATTR = "_game_draft_font_style_hint"


def _clamp_font_px(px: object) -> int:
    try:
        v = int(px)  # QSettings 在部分平台回传字符串
    except (TypeError, ValueError):
        return DEFAULT_FONT_PX
    return max(MIN_FONT_PX, min(MAX_FONT_PX, v))


def font_px_for_role(role: str, base_px: int | None = None) -> int:
    """Resolve an editor typography role from the current global pixel size."""
    base = current_font_px() if base_px is None else _clamp_font_px(base_px)
    offset, floor = _FONT_ROLE_SPECS.get(role, _FONT_ROLE_SPECS[FONT_ROLE_BASE])
    return max(floor, base + offset)


def font_role_tokens(base_px: int | None = None) -> dict[str, int]:
    return {role: font_px_for_role(role, base_px) for role in _FONT_ROLE_SPECS}


def make_editor_font(
    role: str = FONT_ROLE_BASE,
    *,
    family: str | None = None,
    weight: QFont.Weight | None = None,
    style_hint: QFont.StyleHint | None = None,
    base_px: int | None = None,
) -> QFont:
    app = QApplication.instance()
    font = QFont(app.font()) if app is not None else QFont()
    if family:
        font.setFamily(family)
    if weight is not None:
        font.setWeight(weight)
    if style_hint is not None:
        font.setStyleHint(style_hint)
    font.setPixelSize(font_px_for_role(role, base_px))
    return font


def set_editor_font_role(widget: QWidget, role: str) -> None:
    """Assign a QSS typography role without freezing the widget's current font."""
    widget.setProperty(_EDITOR_FONT_ROLE_PROP, role)
    style = widget.style()
    style.unpolish(widget)
    style.polish(widget)
    widget.update()


def set_graphics_text_font(
    item,
    role: str,
    *,
    family: str | None = None,
    weight: QFont.Weight | None = None,
    style_hint: QFont.StyleHint | None = None,
) -> None:
    """Tag graphics text so live theme changes can reapply its pixel font."""
    setattr(item, _GRAPHICS_FONT_ROLE_ATTR, role)
    setattr(item, _GRAPHICS_FONT_FAMILY_ATTR, family)
    setattr(item, _GRAPHICS_FONT_WEIGHT_ATTR, weight)
    setattr(item, _GRAPHICS_FONT_STYLE_HINT_ATTR, style_hint)
    item.setFont(make_editor_font(
        role,
        family=family,
        weight=weight,
        style_hint=style_hint,
    ))


def refresh_graphics_scene_fonts(scene) -> None:
    items = list(scene.items())
    font_cache: dict[tuple[object, ...], QFont] = {}
    for item in items:
        role = getattr(item, _GRAPHICS_FONT_ROLE_ATTR, None)
        if role:
            family = getattr(item, _GRAPHICS_FONT_FAMILY_ATTR, None)
            weight = getattr(item, _GRAPHICS_FONT_WEIGHT_ATTR, None)
            style_hint = getattr(item, _GRAPHICS_FONT_STYLE_HINT_ATTR, None)
            key = (role, family, weight, style_hint)
            font = font_cache.get(key)
            if font is None:
                font = make_editor_font(
                    role,
                    family=family,
                    weight=weight,
                    style_hint=style_hint,
                )
                font_cache[key] = font
            item.setFont(font)
    for item in items:
        refresh = getattr(item, "refresh_editor_font", None)
        if callable(refresh):
            refresh()


def css_font_px(role: str = FONT_ROLE_BASE, base_px: int | None = None) -> str:
    return f"{font_px_for_role(role, base_px)}px"


def web_font_css_tokens(base_px: int | None = None) -> dict[str, str]:
    """CSS variables that scale Web authoring text without zooming page geometry."""
    base = current_font_px() if base_px is None else _clamp_font_px(base_px)
    delta = base - DEFAULT_FONT_PX
    tokens = {
        "--editor-host-font-delta": f"{delta}px",
        "--editor-host-font-prominent": css_font_px(FONT_ROLE_PROMINENT, base),
    }
    for step in _WEB_FONT_STEPS:
        key = f"{step:g}".replace(".", "-")
        value = max(7.0, step + delta)
        tokens[f"--editor-host-font-{key}"] = f"{value:g}px"
    return tokens


def font_role_stylesheet(base_px: int = DEFAULT_FONT_PX) -> str:
    tokens = font_role_tokens(base_px)
    return "\n".join(
        f'QWidget[{_EDITOR_FONT_ROLE_PROP}="{role}"] {{ font-size: {px}px; }}'
        for role, px in tokens.items()
        if role != FONT_ROLE_BASE
    )


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


def _stylesheet_flat_dark(base_px: int = DEFAULT_FONT_PX) -> str:
    w, b, ab = _DARK_WINDOW, _DARK_BASE, _DARK_ALT_BASE
    br, brm = _DARK_BORDER, _DARK_BORDER_MUTED
    tx, ac = _DARK_TEXT, _DARK_ACCENT
    base_px = _clamp_font_px(base_px)
    sec_px = font_px_for_role(FONT_ROLE_SECONDARY, base_px)
    role_qss = font_role_stylesheet(base_px)
    return f"""
        QMainWindow {{ background-color: {w}; }}
        QWidget {{ color: {tx}; font-size: {base_px}px; }}
        {role_qss}
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
            font-size: {sec_px}px;
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
            padding: 4px 8px;
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
            margin-top: 6px;
            padding-top: 8px;
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


def _stylesheet_flat_modern(base_px: int = DEFAULT_FONT_PX) -> str:
    w = _MODERN_WINDOW
    b = _MODERN_BASE
    ab = _MODERN_ALT
    br, brm = _MODERN_BORDER, _MODERN_BORDER_MUTED
    tx, ac = _MODERN_TEXT, _MODERN_ACCENT
    sel = _MODERN_LIST_SEL
    hov = _MODERN_LIST_HOVER
    tbar = _MODERN_TOOLBAR
    base_px = _clamp_font_px(base_px)
    sec_px = font_px_for_role(FONT_ROLE_SECONDARY, base_px)
    role_qss = font_role_stylesheet(base_px)
    return f"""
        QMainWindow {{ background-color: {w}; }}
        QWidget {{
            color: {tx};
            font-size: {base_px}px;
            font-family: "PingFang SC", "Helvetica Neue";
        }}
        {role_qss}
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
            font-size: {sec_px}px;
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
            padding: 4px 10px;
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
            margin-top: 6px;
            padding-top: 8px;
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


def _stylesheet_flat_light(base_px: int = DEFAULT_FONT_PX) -> str:
    w, b, ab = _LIGHT_WINDOW, _LIGHT_BASE, _LIGHT_ALT
    br, brm = _LIGHT_BORDER, _LIGHT_BORDER_MUTED
    tx, ac = _LIGHT_TEXT, _LIGHT_ACCENT
    base_px = _clamp_font_px(base_px)
    sec_px = font_px_for_role(FONT_ROLE_SECONDARY, base_px)
    role_qss = font_role_stylesheet(base_px)
    return f"""
        QMainWindow {{ background-color: {w}; }}
        QWidget {{ color: {tx}; font-size: {base_px}px; }}
        {role_qss}
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
            font-size: {sec_px}px;
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
            padding: 4px 8px;
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
            margin-top: 6px;
            padding-top: 8px;
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


def apply_application_theme(
    app: QApplication, theme_id: str, font_px: int | None = None
) -> None:
    if theme_id not in ALL_THEME_IDS:
        theme_id = THEME_MODERN
    base_px = _clamp_font_px(settings_load_font_px() if font_px is None else font_px)
    app.setStyle("Fusion")
    app.setProperty(_APP_PROP, theme_id)
    app.setProperty(_FONT_PX_PROP, base_px)
    # QSS 的 font-size 会盖过 QApplication 字体,故两者用同一像素值保持一致;
    # app 字体兜底 QSS 未命中的控件(QToolTip 等)。
    f = app.font()
    f.setPixelSize(base_px)
    app.setFont(f)
    if theme_id == THEME_MODERN:
        app.setPalette(_palette_modern())
        app.setStyleSheet(_stylesheet_flat_modern(base_px))
    elif theme_id == THEME_DARK:
        app.setPalette(_palette_dark())
        app.setStyleSheet(_stylesheet_flat_dark(base_px))
    else:
        app.setPalette(_palette_light())
        app.setStyleSheet(_stylesheet_flat_light(base_px))


def apply_graphics_view_background(view: QGraphicsView, theme_id: str) -> None:
    from PySide6.QtGui import QBrush

    if theme_id == THEME_LIGHT:
        view.setBackgroundBrush(QBrush(QColor(0xF0, 0xF0, 0xF0)))
    elif theme_id == THEME_MODERN:
        view.setBackgroundBrush(QBrush(QColor(0x1E, 0x1E, 0x1E)))
    else:
        view.setBackgroundBrush(QBrush(QColor(0x10, 0x10, 0x10)))


def refresh_all_graphics_views(root, theme_id: str) -> None:
    seen_scenes: set[int] = set()
    for view in root.findChildren(QGraphicsView):
        apply_graphics_view_background(view, theme_id)
        scene = view.scene()
        if scene is not None and id(scene) not in seen_scenes:
            seen_scenes.add(id(scene))
            refresh_graphics_scene_fonts(scene)
        view.viewport().update()


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


def current_font_px() -> int:
    app = QApplication.instance()
    if app is None:
        return DEFAULT_FONT_PX
    return _clamp_font_px(app.property(_FONT_PX_PROP))


def settings_load_font_px() -> int:
    s = QSettings("GameDraft", "Editor")
    return _clamp_font_px(s.value("font_px", DEFAULT_FONT_PX))


def settings_save_font_px(px: int) -> None:
    s = QSettings("GameDraft", "Editor")
    s.setValue("font_px", _clamp_font_px(px))


def secondary_label_stylesheet(theme_id: str) -> str:
    if theme_id == THEME_DARK:
        return "color: #9a9a9a;"
    if theme_id == THEME_MODERN:
        return "color: #858585;"
    return "color: #666666;"
