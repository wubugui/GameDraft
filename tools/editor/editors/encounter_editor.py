"""Encounter editor with option branches."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QComboBox, QTextEdit, QPushButton, QLabel,
    QScrollArea, QGroupBox, QSpinBox,
)
from PySide6.QtCore import Qt

from ..project_model import ProjectModel
from ..shared.condition_editor import ConditionEditor
from ..shared.action_editor import ActionEditor
from ..shared.id_ref_selector import IdRefSelector


# ---------------------------------------------------------------------------
# Consume-items editor (list of {id, count} rows)
# ---------------------------------------------------------------------------

class _ConsumeItemRow(QWidget):
    def __init__(
        self,
        data: dict,
        model: ProjectModel,
        parent: QWidget | None = None,
    ):
        super().__init__(parent)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)

        self._item_sel = IdRefSelector(allow_empty=False)
        self._item_sel.set_items(model.all_item_ids())
        self._item_sel.set_current(data.get("id", ""))
        lay.addWidget(self._item_sel, stretch=1)

        self._count = QSpinBox()
        self._count.setRange(1, 9999)
        self._count.setValue(data.get("count", 1))
        self._count.setPrefix("x")
        lay.addWidget(self._count)

        self._del_btn = QPushButton("\u2212")
        self._del_btn.setFixedWidth(24)
        lay.addWidget(self._del_btn)

    def to_dict(self) -> dict:
        return {"id": self._item_sel.current_id(), "count": self._count.value()}


class ConsumeItemsEditor(QGroupBox):
    def __init__(self, title: str = "Consume Items",
                 parent: QWidget | None = None):
        super().__init__(title, parent)
        self._model: ProjectModel | None = None
        self._rows: list[_ConsumeItemRow] = []

        outer = QVBoxLayout(self)
        outer.setContentsMargins(4, 8, 4, 4)
        self._rows_layout = QVBoxLayout()
        outer.addLayout(self._rows_layout)

        btn = QPushButton("+ Item")
        btn.clicked.connect(self._add_row)
        outer.addWidget(btn)

    def set_model(self, model: ProjectModel) -> None:
        self._model = model

    def set_data(self, items: list[dict]) -> None:
        self._clear()
        for entry in items:
            self._add_row(entry)

    def to_list(self) -> list[dict]:
        out: list[dict] = []
        for row in self._rows:
            d = row.to_dict()
            if d["id"]:
                out.append(d)
        return out

    def _add_row(self, data: dict | None = None) -> None:
        if self._model is None:
            return
        if data is None or isinstance(data, bool):
            data = {"id": "", "count": 1}
        row = _ConsumeItemRow(data, self._model)
        row._del_btn.clicked.connect(lambda: self._remove_row(row))
        self._rows.append(row)
        self._rows_layout.addWidget(row)

    def _remove_row(self, row: _ConsumeItemRow) -> None:
        self._rows_layout.removeWidget(row)
        self._rows.remove(row)
        row.deleteLater()

    def _clear(self) -> None:
        for row in self._rows:
            self._rows_layout.removeWidget(row)
            row.deleteLater()
        self._rows.clear()


# ---------------------------------------------------------------------------
# Option widget
# ---------------------------------------------------------------------------

class OptionWidget(QGroupBox):
    def __init__(self, idx: int, data: dict, model: ProjectModel,
                 parent: QWidget | None = None):
        super().__init__(f"Option {idx + 1}", parent)
        self._data = data
        lay = QVBoxLayout(self)
        f = QFormLayout()
        self._text = QLineEdit(data.get("text", "")); f.addRow("text", self._text)
        self._type = QComboBox(); self._type.addItems(["general", "rule", "special"])
        self._type.setCurrentText(data.get("type", "general")); f.addRow("type", self._type)
        self._rule = IdRefSelector(allow_empty=True)
        self._rule.set_items(model.all_rule_ids())
        self._rule.set_current(data.get("requiredRuleId", ""))
        f.addRow("requiredRuleId", self._rule)
        self._result_text = QTextEdit(data.get("resultText", ""))
        self._result_text.setMaximumHeight(60)
        f.addRow("resultText", self._result_text)
        lay.addLayout(f)
        self._conds = ConditionEditor("Conditions")
        self._conds.set_flag_pattern_context(model, None)
        self._conds.set_data(data.get("conditions", []))
        lay.addWidget(self._conds)
        self._consume = ConsumeItemsEditor("Consume Items")
        self._consume.set_model(model)
        self._consume.set_data(data.get("consumeItems", []))
        lay.addWidget(self._consume)
        self._actions = ActionEditor("Result Actions")
        self._actions.set_project_context(model, None)
        self._actions.set_data(data.get("resultActions", []))
        lay.addWidget(self._actions)

    def to_dict(self) -> dict:
        d: dict = {
            "text": self._text.text(),
            "type": self._type.currentText(),
            "conditions": self._conds.to_list(),
            "resultActions": self._actions.to_list(),
        }
        rid = self._rule.current_id()
        if rid:
            d["requiredRuleId"] = rid
        rt = self._result_text.toPlainText()
        if rt:
            d["resultText"] = rt
        ci = self._consume.to_list()
        if ci:
            d["consumeItems"] = ci
        return d


class EncounterEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx: int = -1

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Encounter"); btn_add.clicked.connect(self._add)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        ll.addWidget(self._list)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        self._detail = QWidget()
        self._detail_layout = QVBoxLayout(self._detail)
        f = QFormLayout()
        self._e_id = QLineEdit(); f.addRow("id", self._e_id)
        self._e_narr = QTextEdit(); self._e_narr.setMaximumHeight(80)
        f.addRow("narrative", self._e_narr)
        self._detail_layout.addLayout(f)
        self._opts_layout = QVBoxLayout()
        self._detail_layout.addLayout(self._opts_layout)
        opt_btns = QHBoxLayout()
        add_opt = QPushButton("+ Option"); add_opt.clicked.connect(self._add_option)
        opt_btns.addWidget(add_opt)
        self._detail_layout.addLayout(opt_btns)
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply)
        self._detail_layout.addWidget(apply_btn)
        self._detail_layout.addStretch()
        scroll.setWidget(self._detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([250, 700])
        root.addWidget(splitter)
        self._opt_widgets: list[OptionWidget] = []
        self._refresh()

    def _refresh(self) -> None:
        self._list.clear()
        for enc in self._model.encounters:
            self._list.addItem(f"{enc.get('id', '?')}")

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.encounters):
            return
        self._current_idx = row
        enc = self._model.encounters[row]
        self._e_id.setText(enc.get("id", ""))
        self._e_narr.setPlainText(enc.get("narrative", ""))
        self._rebuild_options(enc.get("options", []))

    def _rebuild_options(self, options: list[dict]) -> None:
        for w in self._opt_widgets:
            self._opts_layout.removeWidget(w)
            w.deleteLater()
        self._opt_widgets.clear()
        for i, opt in enumerate(options):
            ow = OptionWidget(i, opt, self._model)
            self._opt_widgets.append(ow)
            self._opts_layout.addWidget(ow)

    def _add_option(self) -> None:
        ow = OptionWidget(len(self._opt_widgets),
                          {"text": "", "type": "general", "conditions": [], "resultActions": []},
                          self._model)
        self._opt_widgets.append(ow)
        self._opts_layout.addWidget(ow)

    def _apply(self) -> None:
        if self._current_idx < 0:
            return
        enc = self._model.encounters[self._current_idx]
        enc["id"] = self._e_id.text().strip()
        enc["narrative"] = self._e_narr.toPlainText()
        enc["options"] = [ow.to_dict() for ow in self._opt_widgets]
        self._model.mark_dirty("encounter")
        self._refresh()

    def _add(self) -> None:
        self._model.encounters.append({
            "id": f"encounter_{len(self._model.encounters)}",
            "narrative": "", "options": [],
        })
        self._model.mark_dirty("encounter")
        self._refresh()

    def _delete(self) -> None:
        if self._current_idx >= 0:
            self._model.encounters.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("encounter")
            self._refresh()

    def select_by_id(self, item_id: str, _scene_id: str = "") -> None:
        for i, enc in enumerate(self._model.encounters):
            if enc.get("id") == item_id:
                self._list.setCurrentRow(i)
                return
