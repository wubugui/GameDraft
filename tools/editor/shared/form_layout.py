"""表单/字段紧凑化工具：统一房屋风格，短字段不再被拉满整行。

约定（与 scene_editor 既有写法一致）：QFormLayout 用 `FieldsStayAtSizeHint`，
字段按内容宽度排布；个别需要更宽的字段（路径 / 长文本 / 长 id）再显式 setMinimumWidth。
"""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QFormLayout, QWidget


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
