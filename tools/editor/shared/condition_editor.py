"""Reusable Condition[] editor: flag via FlagPickerDialog only."""
from __future__ import annotations

from typing import TYPE_CHECKING

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton,
    QComboBox, QLabel, QFrame,
)
from PySide6.QtCore import Signal

from .flag_key_field import FlagKeyPickField
from .flag_value_edit import FlagValueEdit

if TYPE_CHECKING:
    from ..project_model import ProjectModel


class ConditionRow(QWidget):
    removed = Signal(object)
    changed = Signal()

    def __init__(
        self,
        data: dict | None = None,
        model: ProjectModel | None = None,
        scene_id: str | None = None,
        parent: QWidget | None = None,
    ):
        super().__init__(parent)
        self._model = model
        self._scene_id = scene_id
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)

        self._val = FlagValueEdit(self, model.flag_registry if model else {})
        cur = (data.get("flag", "") if data else "")
        self._field = FlagKeyPickField(model, scene_id, str(cur) if cur else "", self)
        self._field.setMinimumWidth(220)
        self._field.valueChanged.connect(self._on_flag_key_changed)

        self.op_combo = QComboBox()
        self.op_combo.addItems(["==", "!=", ">", "<", ">=", "<="])
        if data and "op" in data:
            self.op_combo.setCurrentText(data["op"])
        self.op_combo.setMaximumWidth(56)

        init_v = data.get("value", True) if data else True
        self._val.set_flag_key(self._field.key())
        self._val.set_value(init_v)

        self.del_btn = QPushButton("\u2212")
        self.del_btn.setFixedWidth(24)
        self.del_btn.clicked.connect(lambda: self.removed.emit(self))

        lay.addWidget(self._field, stretch=1)
        lay.addWidget(self.op_combo)
        lay.addWidget(self._val)
        lay.addWidget(self.del_btn)

        self.op_combo.currentTextChanged.connect(self.changed)
        self._val.valueChanged.connect(self.changed)

    def _on_flag_key_changed(self) -> None:
        self._val.set_flag_key(self._field.key())
        self.changed.emit()

    def set_picker_context(self, model: ProjectModel | None, scene_id: str | None) -> None:
        self._model = model
        self._scene_id = scene_id
        self._field.set_context(model, scene_id)
        self._val.set_registry(model.flag_registry if model else {})
        self._val.set_flag_key(self._field.key())

    def current_flag(self) -> str:
        return self._field.key()

    def set_flag_key(self, key: str) -> None:
        self._field.set_key(key)

    def to_dict(self) -> dict:
        fk = self.current_flag()
        if not fk:
            return {}
        result: dict = {"flag": fk}
        op = self.op_combo.currentText()
        if op != "==":
            result["op"] = op
        v = self._val.get_value()
        if isinstance(v, bool):
            if op == "==" and v is True:
                pass
            else:
                result["value"] = v
        else:
            result["value"] = float(v)
        return result


class ConditionEditor(QWidget):
    changed = Signal()

    def __init__(self, label: str = "Conditions", parent: QWidget | None = None):
        super().__init__(parent)
        self._rows: list[ConditionRow] = []
        self._ctx_model: ProjectModel | None = None
        self._ctx_scene_id: str | None = None

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(QLabel(f"<b>{label}</b>"))
        self._rows_layout = QVBoxLayout()
        self._rows_layout.setSpacing(2)
        root.addLayout(self._rows_layout)

        self._pattern_frame = QFrame()
        self._pattern_frame.setVisible(False)
        pr = QVBoxLayout(self._pattern_frame)
        pr.setContentsMargins(0, 4, 0, 0)
        pr.addWidget(QLabel("行内快速拼装（复杂请用每行「选择…」里「编辑登记表」）"))
        ph = QHBoxLayout()
        self._pat_combo = QComboBox()
        self._pat_combo.setMinimumWidth(160)
        self._id_combo = QComboBox()
        self._id_combo.setEditable(False)
        self._id_combo.setMinimumWidth(120)
        apply_btn = QPushButton("填入选中行 / 末行")
        apply_btn.setToolTip("优先填入当前焦点所在行的 flag；否则填入最后一行空 flag；否则追加一行")
        apply_btn.clicked.connect(self._apply_pattern_to_row)
        ph.addWidget(self._pat_combo, stretch=1)
        ph.addWidget(self._id_combo, stretch=1)
        ph.addWidget(apply_btn)
        pr.addLayout(ph)
        root.addWidget(self._pattern_frame)
        self._pat_combo.currentIndexChanged.connect(self._on_pattern_combo_changed)

        add_btn = QPushButton(f"+ {label}")
        add_btn.clicked.connect(self._add_empty)
        root.addWidget(add_btn)

    def set_flag_pattern_context(self, model: ProjectModel | None, scene_id: str | None) -> None:
        self._ctx_model = model
        self._ctx_scene_id = scene_id
        for row in self._rows:
            row.set_picker_context(model, scene_id)
        self._pat_combo.blockSignals(True)
        self._pat_combo.clear()
        self._pat_combo.addItem("(选择模板…)", None)
        regs = (model.flag_registry.get("patterns") if model else None) or []
        for p in regs:
            if isinstance(p, dict) and p.get("id"):
                label = str(p["id"])
                pre = p.get("prefix", "")
                suf = p.get("suffix") or ""
                hint = f"{label}  ({pre}…{suf})" if suf else f"{label}  ({pre}…)"
                self._pat_combo.addItem(hint, p)
        self._pat_combo.blockSignals(False)
        has = model is not None and len(regs) > 0
        self._pattern_frame.setVisible(has)
        self._on_pattern_combo_changed(0)

    def _on_pattern_combo_changed(self, _idx: int) -> None:
        self._id_combo.clear()
        data = self._pat_combo.currentData()
        if not data or not self._ctx_model:
            return
        from ..flag_registry import ids_for_registry_pattern_source
        src = data.get("idSource")
        ids = ids_for_registry_pattern_source(
            self._ctx_model, scene_id=self._ctx_scene_id, id_source=src,
        )
        self._id_combo.addItems(ids)

    def _focused_condition_row(self) -> ConditionRow | None:
        fw = self.window().focusWidget() if self.window() else None
        w = fw
        while w is not None:
            if isinstance(w, ConditionRow) and w in self._rows:
                return w
            w = w.parentWidget()
        return None

    def _apply_pattern_to_row(self) -> None:
        p = self._pat_combo.currentData()
        if not p or not self._ctx_model:
            return
        rid = self._id_combo.currentText().strip()
        if not rid:
            return
        pre = p.get("prefix", "")
        suf = p.get("suffix") or ""
        key = f"{pre}{rid}{suf}"
        target = self._focused_condition_row()
        if target is not None:
            target.set_flag_key(key)
            return
        for row in reversed(self._rows):
            if not row.current_flag():
                row.set_flag_key(key)
                return
        self._add_row({"flag": key, "value": True})
        self.changed.emit()

    def set_flags(self, *_args, **_kwargs) -> None:
        """Deprecated: no-op for old call sites."""

    def set_data(self, conditions: list[dict]) -> None:
        self._clear()
        for c in conditions:
            self._add_row(c)

    def to_list(self) -> list[dict]:
        return [r.to_dict() for r in self._rows if r.to_dict().get("flag")]

    def _clear(self) -> None:
        for r in self._rows:
            self._rows_layout.removeWidget(r)
            r.deleteLater()
        self._rows.clear()

    def _add_row(self, data: dict | None = None) -> None:
        row = ConditionRow(data, self._ctx_model, self._ctx_scene_id)
        row.removed.connect(self._remove_row)
        row.changed.connect(self.changed)
        self._rows.append(row)
        self._rows_layout.addWidget(row)

    def _add_empty(self) -> None:
        self._add_row({"flag": "", "value": True})
        self.changed.emit()

    def _remove_row(self, row: ConditionRow) -> None:
        if row in self._rows:
            self._rows.remove(row)
            self._rows_layout.removeWidget(row)
            row.deleteLater()
            self.changed.emit()
