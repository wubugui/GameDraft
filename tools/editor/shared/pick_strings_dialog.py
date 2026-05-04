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
    QWidget,
    QLineEdit,
)

from ..project_model import ProjectModel


def pick_strings_multi(
    parent: QWidget | None,
    title: str,
    choices: list[str],
    preselected: list[str],
    *,
    label: str = "",
    sort_choices: bool = True,
) -> list[str] | None:
    """返回勾选的字符串列表（顺序与 choices 一致）；取消返回 None。条目为复选框，可全部取消勾选以清空。"""
    dlg = QDialog(parent)
    dlg.setWindowTitle(title)
    dlg.resize(420, 360)
    root = QVBoxLayout(dlg)
    if label:
        lb = QLabel(label)
        lb.setWordWrap(True)
        root.addWidget(lb)
    lw = QListWidget()
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
        it.setFlags(it.flags() | Qt.ItemFlag.ItemIsUserCheckable)
        it.setCheckState(
            Qt.CheckState.Checked if s in pick else Qt.CheckState.Unchecked,
        )
        lw.addItem(it)
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
    for i in range(lw.count()):
        it = lw.item(i)
        if it.checkState() == Qt.CheckState.Checked:
            out.append(it.text())
    return out


def pick_string_tag_marker(
    parent: QWidget | None,
    model: ProjectModel,
    *,
    title: str = "选择 Strings 词条",
    hint: str = "",
    current_marker: str = "",
) -> str | None:
    """从 TagCatalog 清单中单选一条 string，返回 `[tag:string:cat:key]`；取消返回 None。"""
    from .tag_catalog import TagCatalog

    cat = TagCatalog(model)
    items = cat.list_string_keys()
    dlg = QDialog(parent)
    dlg.setWindowTitle(title)
    dlg.resize(520, 420)
    root = QVBoxLayout(dlg)
    if hint:
        lb = QLabel(hint)
        lb.setWordWrap(True)
        root.addWidget(lb)

    sel_ref = ""
    cur = (current_marker or "").strip()
    for ti in items:
        if cat.marker_for(ti) == cur:
            sel_ref = ti.ref_id
            break

    search = QLineEdit()
    search.setPlaceholderText("筛选 category.key 或预览文案…")
    root.addWidget(search)

    lw = QListWidget()

    def refill(q: str) -> None:
        lw.clear()
        qq = q.strip().lower()
        for ti in items:
            hay = f"{ti.ref_id} {ti.label} {ti.hint}".lower()
            if qq and qq not in hay:
                continue
            marker = cat.marker_for(ti)
            row = QListWidgetItem(f"{ti.label}  →  {marker}")
            row.setData(Qt.ItemDataRole.UserRole, marker)
            lw.addItem(row)
            if ti.ref_id == sel_ref:
                lw.setCurrentItem(row)

    refill("")
    search.textChanged.connect(refill)
    root.addWidget(lw)

    bb = QDialogButtonBox(
        QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
    )
    bb.accepted.connect(dlg.accept)
    bb.rejected.connect(dlg.reject)
    root.addWidget(bb)

    if lw.count() > 0 and lw.currentItem() is None:
        lw.setCurrentRow(0)

    if dlg.exec() != QDialog.DialogCode.Accepted:
        return None
    it = lw.currentItem()
    if it is None:
        return None
    m = it.data(Qt.ItemDataRole.UserRole)
    return str(m) if m else None
