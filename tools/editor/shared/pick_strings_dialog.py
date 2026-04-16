"""多选字符串对话框：从给定清单勾选，禁止自由输入。"""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QDialog,
    QVBoxLayout,
    QListWidget,
    QListWidgetItem,
    QDialogButtonBox,
    QLabel,
    QAbstractItemView,
    QWidget,
)


def pick_strings_multi(
    parent: QWidget | None,
    title: str,
    choices: list[str],
    preselected: list[str],
    *,
    label: str = "",
    sort_choices: bool = True,
) -> list[str] | None:
    """返回勾选的字符串列表（顺序与 choices 一致）；取消返回 None。"""
    dlg = QDialog(parent)
    dlg.setWindowTitle(title)
    dlg.resize(420, 360)
    root = QVBoxLayout(dlg)
    if label:
        lb = QLabel(label)
        lb.setWordWrap(True)
        root.addWidget(lb)
    lw = QListWidget()
    lw.setSelectionMode(QAbstractItemView.SelectionMode.MultiSelection)
    pick = {str(x).strip() for x in preselected if str(x).strip()}
    ch = [str(c).strip() for c in choices if str(c).strip()]
    if sort_choices:
        ch = sorted(set(ch), key=lambda s: s.casefold())
    else:
        seen: set[str] = set()
        uniq: list[str] = []
        for s in ch:
            if s not in seen:
                seen.add(s)
                uniq.append(s)
        ch = uniq
    for s in ch:
        it = QListWidgetItem(s)
        lw.addItem(it)
        if s in pick:
            it.setSelected(True)
    root.addWidget(lw)
    bb = QDialogButtonBox(
        QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
    )
    bb.accepted.connect(dlg.accept)
    bb.rejected.connect(dlg.reject)
    root.addWidget(bb)
    if dlg.exec() != QDialog.DialogCode.Accepted:
        return None
    out: list[str] = []
    sel = {it.text() for it in lw.selectedItems()}
    for s in ch:
        if s in sel:
            out.append(s)
    return out
