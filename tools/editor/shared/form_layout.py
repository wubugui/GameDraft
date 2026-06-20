"""表单/字段紧凑化工具：统一房屋风格，短字段不再被拉满整行。

约定（与 scene_editor 既有写法一致）：QFormLayout 用 `FieldsStayAtSizeHint`，
字段按内容宽度排布；个别需要更宽的字段（路径 / 长文本 / 长 id）再显式 setMinimumWidth。
"""
from __future__ import annotations

from PySide6.QtWidgets import QFormLayout, QWidget


def compact_form(form: QFormLayout) -> QFormLayout:
    """字段按 sizeHint 宽度排布（短字段不撑满整行）。返回自身便于链式。"""
    form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.FieldsStayAtSizeHint)
    return form


def cap_width(widget: QWidget, max_w: int) -> QWidget:
    """给短字段设最大宽度（用于不在 QFormLayout 字段列、无法靠表单策略约束的包装行）。"""
    widget.setMaximumWidth(max_w)
    return widget
