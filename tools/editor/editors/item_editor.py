"""Item definition editor."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QComboBox, QPushButton, QSpinBox,
    QDoubleSpinBox, QScrollArea, QGroupBox, QLabel, QStyle,
)
from PySide6.QtCore import Qt

from ..project_model import ProjectModel
from ..shared.condition_editor import ConditionEditor
from ..shared.rich_text_field import RichTextLineEdit, RichTextTextEdit
from ..shared.qt_icon_buttons import outline_row_tool_button, delete_standard_pixmap


class DynDescWidget(QGroupBox):
    def __init__(self, idx: int, data: dict,
                 model: ProjectModel | None = None, parent: QWidget | None = None):
        super().__init__(f"Dynamic Desc {idx + 1}", parent)
        self._idx = idx
        lay = QVBoxLayout(self)

        head = QHBoxLayout()
        self._btn_up = outline_row_tool_button(
            self, "上移", std=QStyle.StandardPixmap.SP_ArrowUp, fallback_text="上")
        self._btn_down = outline_row_tool_button(
            self, "下移", std=QStyle.StandardPixmap.SP_ArrowDown, fallback_text="下")
        self._btn_del = outline_row_tool_button(
            self, "删除该动态描述", std=delete_standard_pixmap(), fallback_text="删")
        head.addStretch(1)
        head.addWidget(self._btn_up)
        head.addWidget(self._btn_down)
        head.addWidget(self._btn_del)
        lay.addLayout(head)

        self._cond = ConditionEditor("Conditions")
        self._cond.set_flag_pattern_context(model, None)
        self._cond.set_data(data.get("conditions", []))
        lay.addWidget(self._cond)
        pm = model if model is not None else ProjectModel()
        self._text = RichTextTextEdit(pm)
        self._text.setPlainText(data.get("text", ""))
        self._text.setMaximumHeight(100)
        lay.addWidget(self._text)

    def set_dyn_index(self, idx: int) -> None:
        self._idx = idx
        self.setTitle(f"Dynamic Desc {idx + 1}")

    def to_dict(self) -> dict:
        return {"conditions": self._cond.to_list(), "text": self._text.toPlainText()}


class ItemEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx: int = -1

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Item"); btn_add.clicked.connect(self._add)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        ll.addWidget(self._list)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        dl = QVBoxLayout(detail)
        f = QFormLayout()
        self._i_id = QLineEdit(); f.addRow("id", self._i_id)
        self._i_name = RichTextLineEdit(self._model); f.addRow("name", self._i_name)
        self._i_type = QComboBox(); self._i_type.addItems(["consumable", "key"])
        f.addRow("type", self._i_type)
        self._i_desc = RichTextTextEdit(self._model); self._i_desc.setMaximumHeight(100)
        f.addRow("description", self._i_desc)
        self._i_stack = QSpinBox(); self._i_stack.setRange(1, 999)
        f.addRow("maxStack", self._i_stack)
        self._i_price = QSpinBox(); self._i_price.setRange(0, 99999)
        f.addRow("buyPrice", self._i_price)
        dl.addLayout(f)

        dl.addWidget(QLabel("<b>Dynamic Descriptions</b>"))
        self._dyn_layout = QVBoxLayout()
        dl.addLayout(self._dyn_layout)
        add_dyn = QPushButton("+ Dynamic Desc"); add_dyn.clicked.connect(self._add_dyn)
        dl.addWidget(add_dyn)

        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply)
        dl.addWidget(apply_btn)
        dl.addStretch()
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([220, 600])
        root.addWidget(splitter)
        self._dyn_widgets: list[DynDescWidget] = []
        self._refresh()

    def _refresh(self) -> None:
        self._list.clear()
        for it in self._model.items:
            tag = "[K]" if it.get("type") == "key" else "[C]"
            self._list.addItem(f"{tag} {it.get('id', '?')}  {it.get('name', '')}")

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.items):
            return
        self._current_idx = row
        it = self._model.items[row]
        self._i_id.setText(it.get("id", ""))
        self._i_name.setText(it.get("name", ""))
        self._i_type.setCurrentText(it.get("type", "consumable"))
        self._i_desc.setPlainText(it.get("description", ""))
        self._i_stack.setValue(it.get("maxStack", 1))
        self._i_price.setValue(it.get("buyPrice", 0))
        self._rebuild_dyn(it.get("dynamicDescriptions", []))

    def _rebuild_dyn(self, dyns: list[dict]) -> None:
        for w in self._dyn_widgets:
            self._dyn_layout.removeWidget(w)
            w.deleteLater()
        self._dyn_widgets.clear()
        for i, d in enumerate(dyns):
            dw = DynDescWidget(i, d, self._model)
            self._connect_dyn(dw)
            self._dyn_widgets.append(dw)
            self._dyn_layout.addWidget(dw)

    def _connect_dyn(self, dw: DynDescWidget) -> None:
        dw._btn_up.clicked.connect(self._move_dyn_up)
        dw._btn_down.clicked.connect(self._move_dyn_down)
        dw._btn_del.clicked.connect(self._remove_dyn_sender)

    def _dyn_widget_from_sender(self) -> DynDescWidget | None:
        w = self.sender()
        while w is not None and not isinstance(w, DynDescWidget):
            w = w.parent()
        return w if isinstance(w, DynDescWidget) else None

    def _move_dyn_up(self) -> None:
        dw = self._dyn_widget_from_sender()
        if dw is None:
            return
        try:
            idx = self._dyn_widgets.index(dw)
        except ValueError:
            return
        if idx <= 0:
            return
        self._swap_dyn(idx, idx - 1)

    def _move_dyn_down(self) -> None:
        dw = self._dyn_widget_from_sender()
        if dw is None:
            return
        try:
            idx = self._dyn_widgets.index(dw)
        except ValueError:
            return
        if idx >= len(self._dyn_widgets) - 1:
            return
        self._swap_dyn(idx, idx + 1)

    def _swap_dyn(self, a: int, b: int) -> None:
        self._dyn_widgets[a], self._dyn_widgets[b] = (
            self._dyn_widgets[b], self._dyn_widgets[a])
        for w in self._dyn_widgets:
            self._dyn_layout.removeWidget(w)
        for i, w in enumerate(self._dyn_widgets):
            w.set_dyn_index(i)
            self._dyn_layout.addWidget(w)

    def _remove_dyn_sender(self) -> None:
        dw = self._dyn_widget_from_sender()
        if dw is None:
            return
        try:
            idx = self._dyn_widgets.index(dw)
        except ValueError:
            return
        self._dyn_layout.removeWidget(dw)
        self._dyn_widgets.pop(idx)
        dw.deleteLater()
        for i, w in enumerate(self._dyn_widgets):
            w.set_dyn_index(i)

    def _add_dyn(self) -> None:
        dw = DynDescWidget(len(self._dyn_widgets), {"conditions": [], "text": ""}, self._model)
        self._connect_dyn(dw)
        self._dyn_widgets.append(dw)
        self._dyn_layout.addWidget(dw)

    def _apply(self) -> None:
        if self._current_idx < 0:
            return
        it = self._model.items[self._current_idx]
        it["id"] = self._i_id.text().strip()
        it["name"] = self._i_name.text()
        it["type"] = self._i_type.currentText()
        it["description"] = self._i_desc.toPlainText()
        it["maxStack"] = self._i_stack.value()
        bp = self._i_price.value()
        if bp > 0:
            it["buyPrice"] = bp
        elif "buyPrice" in it:
            del it["buyPrice"]
        dyns = [dw.to_dict() for dw in self._dyn_widgets]
        if dyns:
            it["dynamicDescriptions"] = dyns
        elif "dynamicDescriptions" in it:
            del it["dynamicDescriptions"]
        self._model.mark_dirty("item")
        row = self._current_idx
        tag = "[K]" if it.get("type") == "key" else "[C]"
        iw = self._list.item(row)
        if iw is not None:
            iw.setText(f"{tag} {it.get('id', '?')}  {it.get('name', '')}")

    def _add(self) -> None:
        self._model.items.append({
            "id": f"item_{len(self._model.items)}", "name": "New Item",
            "type": "consumable", "description": "", "maxStack": 1,
        })
        self._model.mark_dirty("item")
        self._refresh()

    def _delete(self) -> None:
        if self._current_idx >= 0:
            self._model.items.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("item")
            self._refresh()
