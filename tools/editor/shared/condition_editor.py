"""Reusable Condition[] editor: flag keys only from flag_registry (picker + template)."""
from __future__ import annotations

from typing import TYPE_CHECKING

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLineEdit,
    QComboBox, QLabel, QFrame,
)
from PySide6.QtCore import Signal

from .flag_key_selector import populate_flag_key_combo

if TYPE_CHECKING:
    from ..project_model import ProjectModel


class ConditionRow(QWidget):
    removed = Signal(object)
    changed = Signal()

    def __init__(self, data: dict | None = None, flags: list[str] | None = None,
                 parent: QWidget | None = None):
        super().__init__(parent)
        self._allowed: list[str] = list(flags or [])
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)

        self.flag_combo = QComboBox()
        self.flag_combo.setEditable(False)
        self.flag_combo.setMinimumWidth(200)
        cur = (data.get("flag", "") if data else "")
        populate_flag_key_combo(self.flag_combo, self._allowed, str(cur) if cur else "")

        self.op_combo = QComboBox()
        self.op_combo.addItems(["==", "!=", ">", "<", ">=", "<="])
        if data and "op" in data:
            self.op_combo.setCurrentText(data["op"])
        self.op_combo.setMaximumWidth(56)

        self.val_edit = QLineEdit(str(data.get("value", "true")) if data else "true")
        self.val_edit.setMaximumWidth(80)

        self.del_btn = QPushButton("\u2212")
        self.del_btn.setFixedWidth(24)
        self.del_btn.clicked.connect(lambda: self.removed.emit(self))

        lay.addWidget(self.flag_combo, stretch=1)
        lay.addWidget(self.op_combo)
        lay.addWidget(self.val_edit)
        lay.addWidget(self.del_btn)

        self.flag_combo.currentIndexChanged.connect(self.changed)
        self.op_combo.currentTextChanged.connect(self.changed)
        self.val_edit.textChanged.connect(self.changed)

    def current_flag(self) -> str:
        d = self.flag_combo.currentData()
        return str(d) if d else ""

    def apply_allowed_flags(self, flags: list[str]) -> None:
        self._allowed = list(flags)
        populate_flag_key_combo(self.flag_combo, self._allowed, self.current_flag())

    def set_flag_key(self, key: str) -> None:
        populate_flag_key_combo(self.flag_combo, self._allowed, key)

    def to_dict(self) -> dict:
        fk = self.current_flag()
        if not fk:
            return {}
        result: dict = {"flag": fk}
        op = self.op_combo.currentText()
        if op != "==":
            result["op"] = op
        raw = self.val_edit.text().strip()
        if raw == "true":
            pass
        elif raw == "false":
            result["value"] = False
        else:
            try:
                result["value"] = int(raw)
            except ValueError:
                try:
                    result["value"] = float(raw)
                except ValueError:
                    result["value"] = raw
        return result


class ConditionEditor(QWidget):
    changed = Signal()

    def __init__(self, label: str = "Conditions", parent: QWidget | None = None):
        super().__init__(parent)
        self._rows: list[ConditionRow] = []
        self._flags: list[str] = []
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
        pr.addWidget(QLabel("按登记表模板拼装 flag（须先在 Flags 登记）"))
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
        src = data.get("idSource")
        ids: list[str] = []
        m = self._ctx_model
        if src == "rule":
            ids = [t[0] for t in m.all_rule_ids()]
        elif src == "fragment":
            ids = [t[0] for t in m.all_fragment_ids()]
        elif src == "quest":
            ids = [t[0] for t in m.all_quest_ids()]
        elif src == "item":
            ids = [t[0] for t in m.all_item_ids()]
        elif src in ("hotspot_any_scene", "hotspot_in_scene"):
            sid = self._ctx_scene_id
            if src == "hotspot_in_scene" and sid and sid in m.scenes:
                sc = m.scenes[sid]
                ids = [str(hs["id"]) for hs in sc.get("hotspots", []) if hs.get("id")]
            else:
                all_hs: set[str] = set()
                for sc in m.scenes.values():
                    for hs in sc.get("hotspots", []) or []:
                        if hs.get("id"):
                            all_hs.add(str(hs["id"]))
                ids = sorted(all_hs)
        elif src == "archive_character":
            ids = [c["id"] for c in m.archive_characters if c.get("id")]
        elif src == "archive_lore":
            ent = m.archive_lore
            if isinstance(ent, dict):
                ent = ent.get("entries", [])
            ids = [e["id"] for e in ent or [] if isinstance(e, dict) and e.get("id")]
        elif src == "archive_document":
            ids = [d["id"] for d in m.archive_documents if d.get("id")]
        elif src == "archive_book":
            ids = [b["id"] for b in m.archive_books if b.get("id")]
        elif src == "encounter":
            ids = [t[0] for t in m.all_encounter_ids()]
        elif src == "cutscene":
            ids = [t[0] for t in m.all_cutscene_ids()]
        self._id_combo.addItems(sorted(ids))

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
            self.changed.emit()
            return
        for row in reversed(self._rows):
            if not row.current_flag():
                row.set_flag_key(key)
                self.changed.emit()
                return
        self._add_row({"flag": key, "value": True})
        self.changed.emit()

    def set_flags(self, flags: list[str]) -> None:
        self._flags = flags
        for row in self._rows:
            row.apply_allowed_flags(flags)

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
        row = ConditionRow(data, self._flags)
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
