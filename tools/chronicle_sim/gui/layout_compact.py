"""统一收紧布局边距与间距，避免默认 Qt 留白过大。"""
from __future__ import annotations

from PySide6.QtWidgets import QFormLayout, QLayout


def tighten(layout: QLayout, *, margins: tuple[int, int, int, int] = (6, 6, 6, 6), spacing: int = 4) -> None:
    layout.setContentsMargins(*margins)
    layout.setSpacing(spacing)


def tighten_form(form: QFormLayout, *, vertical: int = 4, horizontal: int = 8) -> None:
    form.setVerticalSpacing(vertical)
    form.setHorizontalSpacing(horizontal)
