"""小号工具栏图标按钮（QStyle pixmap + freedesktop.icon 备选），供多编辑器复用。"""
from __future__ import annotations

from collections.abc import Sequence

from PySide6.QtWidgets import QWidget, QStyle, QToolButton
from PySide6.QtCore import Qt, QSize
from PySide6.QtGui import QIcon


def delete_standard_pixmap() -> QStyle.StandardPixmap:
    return getattr(
        QStyle.StandardPixmap,
        "SP_TrashIcon",
        QStyle.StandardPixmap.SP_DialogCancelButton,
    )


def outline_row_tool_button(
    parent: QWidget,
    tip: str,
    *,
    std: QStyle.StandardPixmap | None = None,
    theme_names: Sequence[str] | None = None,
    fallback_text: str = "",
    fixed_width: int = 28,
    fixed_height: int = 26,
) -> QToolButton:
    """图标优先；无任何图标时改用 fallback_text。"""
    st = parent.style()
    ic = QIcon()
    for name in theme_names or ():
        t = QIcon.fromTheme(str(name))
        if not t.isNull():
            ic = t
            break
    if ic.isNull() and std is not None:
        ic = st.standardIcon(std)
    btn = QToolButton(parent)
    btn.setToolTip(tip)
    btn.setAutoRaise(True)
    btn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
    btn.setFixedSize(fixed_width, fixed_height)
    iw = max(14, min(18, fixed_width - 10))
    ih = max(14, min(18, fixed_height - 8))
    btn.setIconSize(QSize(iw, ih))
    if not ic.isNull():
        btn.setIcon(ic)
        btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonIconOnly)
    elif fallback_text:
        btn.setText(fallback_text)
        btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextOnly)
    return btn
