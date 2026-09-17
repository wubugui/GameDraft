"""表单/字段紧凑化工具：统一房屋风格，短字段不再被拉满整行。

约定（与 scene_editor 既有写法一致）：QFormLayout 用 `FieldsStayAtSizeHint`，
字段按内容宽度排布；个别需要更宽的字段（路径 / 长文本 / 长 id）再显式 setMinimumWidth。
"""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QFormLayout, QPushButton, QWidget

from ..theme import mark_compact_button

#: 窄图标按钮的宽度：够画一个全角字形（＋ / － / ↑ / ↓ / −）+ 紧凑内边距，再窄就开始糊。
COMPACT_ICON_BUTTON_W = 30


def compact_form(form: QFormLayout) -> QFormLayout:
    """紧凑表单：字段按 sizeHint 宽度排布（短字段不撑满整行），标签左对齐、整体顶左
    锚定（不在大面板里居中漂浮），行距收紧。返回自身便于链式。"""
    form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.FieldsStayAtSizeHint)
    # 标签左对齐：紧贴字段，去掉右对齐留下的「标签—空隙—字段」间距感。
    form.setLabelAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
    # 表单顶左锚定：字段窄时整块靠左上，不被布局居中。
    form.setFormAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
    form.setHorizontalSpacing(10)
    form.setVerticalSpacing(6)
    return form


def cap_width(widget: QWidget, max_w: int) -> QWidget:
    """给短字段设最大宽度（用于不在 QFormLayout 字段列、无法靠表单策略约束的包装行）。"""
    widget.setMaximumWidth(max_w)
    return widget


def fit_width_cap(widget: QWidget, max_w: int) -> QWidget:
    """设宽度上限，但**不许低于控件自己画得下的宽度**。

    宽度上限是布局纪律（短字段别撑满整行），可上限比 `sizeHint()` 还小就不是纪律而是
    裁字：下拉里最长那一项（常常正是「（不限）」这种缺省项）被切一半，作者读到的是
    半句话。所以一律取 `max(上限, sizeHint)`。
    """
    widget.ensurePolished()   # QSS 的内边距要 polish 过才算进 sizeHint
    widget.setMaximumWidth(max(int(max_w), widget.sizeHint().width()))
    return widget


def compact_icon_button(text: str, tooltip: str, parent: QWidget | None = None,
                        *, width: int = COMPACT_ICON_BUTTON_W) -> QPushButton:
    """只放一个字形的窄按钮（＋ / － / ↑ / ↓ / −）。

    ⚠ 直接 `QPushButton(...)` + `setFixedWidth(28)` 画出来是**空白按钮**：主题给
    QPushButton 的左右内边距合计 28px，比按钮本身还宽，字形被挤到没有。必须带上
    `mark_compact_button` 给的紧凑内边距（见 `theme.COMPACT_BUTTON_PROP`）。
    """
    button = QPushButton(text, parent)
    button.setToolTip(tooltip)
    mark_compact_button(button)
    button.ensurePolished()   # QSS 的内边距要 polish 过才算进 sizeHint
    button.setFixedWidth(max(int(width), button.sizeHint().width()))
    return button
