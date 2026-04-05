"""Item definition editor."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QComboBox, QTextEdit, QPushButton, QSpinBox,
    QDoubleSpinBox, QScrollArea, QGroupBox, QLabel,
)
from PySide6.QtCore import Qt

from ..project_model import ProjectModel
from ..shared.condition_editor import ConditionEditor


class DynDescWidget(QGroupBox):
    def __init__(self, idx: int, data: dict, flags: list[str],
                 model: ProjectModel | None = None, parent: QWidget | None = None):
        super().__init__(f"Dynamic Desc {idx + 1}", parent)
        lay = QVBoxLayout(self)
        self._cond = ConditionEditor("Conditions")
        self._cond.set_flag_pattern_context(model, None)
        self._cond.set_flags(flags)
        self._cond.set_data(data.get("conditions", []))
        lay.addWidget(self._cond)
        self._text = QTextEdit(data.get("text", ""))
        self._text.setMaximumHeight(60)
        lay.addWidget(self._text)

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
        self._i_name = QLineEdit(); f.addRow("name", self._i_name)
        self._i_type = QComboBox(); self._i_type.addItems(["consumable", "key"])
        f.addRow("type", self._i_type)
        self._i_desc = QTextEdit(); self._i_desc.setMaximumHeight(80)
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
        flags = self._model.registry_flag_choices(None)
        for i, d in enumerate(dyns):
            dw = DynDescWidget(i, d, flags, self._model)
            self._dyn_widgets.append(dw)
            self._dyn_layout.addWidget(dw)

    def _add_dyn(self) -> None:
        flags = self._model.registry_flag_choices(None)
        dw = DynDescWidget(len(self._dyn_widgets), {"conditions": [], "text": ""}, flags, self._model)
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
        self._refresh()

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
