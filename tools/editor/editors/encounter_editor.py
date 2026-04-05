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
        ci = self._data.get("consumeItems")
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
