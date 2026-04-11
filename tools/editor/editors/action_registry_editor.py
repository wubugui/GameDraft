"""Centralized Action registry: browse, filter, edit, and navigate to source."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QTableWidget,
    QTableWidgetItem, QLineEdit, QPushButton, QLabel,
    QHeaderView, QAbstractItemView, QFrame, QScrollArea,
)
from PySide6.QtCore import Qt, Signal

from ..project_model import ProjectModel
from ..shared.action_editor import ACTION_TYPES, FilterableTypeCombo

if TYPE_CHECKING:
    pass


@dataclass
class ActionRecord:
    action: dict
    action_type: str
    source_type: str
    source_id: str
    scene_id: str
    container_field: str
    container_index: int

    @property
    def source_label(self) -> str:
        labels = {
            "quest": "Quest",
            "encounter": "Encounter",
            "scene_hotspot": "Hotspot",
            "scene_zone": "Zone",
            "scene_zone_rule": "ZoneRule",
        }
        return labels.get(self.source_type, self.source_type)

    @property
    def full_source(self) -> str:
        parts = [self.source_label]
        if self.scene_id:
            parts.append(self.scene_id)
        parts.append(self.source_id)
        if self.container_field:
            parts.append(self.container_field)
        return " > ".join(parts)

    @property
    def params_summary(self) -> str:
        p = self.action.get("params", {})
        if not p:
            return ""
        parts = [f"{k}={v}" for k, v in p.items()]
        text = ", ".join(parts)
        return text if len(text) <= 60 else text[:57] + "..."


def _scan_actions(model: ProjectModel) -> list[ActionRecord]:
    records: list[ActionRecord] = []

    for q in model.quests:
        qid = q.get("id", "?")
        for i, act in enumerate(q.get("acceptActions", [])):
            records.append(ActionRecord(
                action=act, action_type=act.get("type", ""),
                source_type="quest", source_id=qid, scene_id="",
                container_field="acceptActions", container_index=i,
            ))
        for i, act in enumerate(q.get("rewards", [])):
            records.append(ActionRecord(
                action=act, action_type=act.get("type", ""),
                source_type="quest", source_id=qid, scene_id="",
                container_field="rewards", container_index=i,
            ))

    for enc in model.encounters:
        eid = enc.get("id", "?")
        for oi, opt in enumerate(enc.get("options", [])):
            for i, act in enumerate(opt.get("resultActions", [])):
                records.append(ActionRecord(
                    action=act, action_type=act.get("type", ""),
                    source_type="encounter", source_id=eid, scene_id="",
                    container_field=f"opt{oi}.resultActions",
                    container_index=i,
                ))

    for sid, sc in model.scenes.items():
        for hs in sc.get("hotspots", []):
            hid = hs.get("id", "?")
            for i, act in enumerate((hs.get("data") or {}).get("actions", [])):
                records.append(ActionRecord(
                    action=act, action_type=act.get("type", ""),
                    source_type="scene_hotspot", source_id=hid,
                    scene_id=sid, container_field="actions",
                    container_index=i,
                ))

        for zone in sc.get("zones", []):
            zid = zone.get("id", "?")
            for ev in ("onEnter", "onStay", "onExit"):
                for i, act in enumerate(zone.get(ev, []) or []):
                    records.append(ActionRecord(
                        action=act, action_type=act.get("type", ""),
                        source_type="scene_zone", source_id=zid,
                        scene_id=sid, container_field=ev,
                        container_index=i,
                    ))
                    if act.get("type") == "enableRuleOffers":
                        slots = (act.get("params") or {}).get("slots") or []
                        for si, slot in enumerate(slots):
                            for j, ract in enumerate(slot.get("resultActions", []) or []):
                                records.append(ActionRecord(
                                    action=ract, action_type=ract.get("type", ""),
                                    source_type="scene_zone_rule", source_id=zid,
                                    scene_id=sid,
                                    container_field=f"{ev}[{i}].slots[{si}].resultActions",
                                    container_index=j,
                                ))

    return records


_SOURCE_TYPES = ["全部", "Quest", "Encounter", "Hotspot", "Zone", "ZoneRule"]
_SOURCE_MAP = {
    "Quest": "quest", "Encounter": "encounter",
    "Hotspot": "scene_hotspot", "Zone": "scene_zone",
    "ZoneRule": "scene_zone_rule",
}


class ActionRegistryEditor(QWidget):
    navigate_to_source = Signal(str, str, str)

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._records: list[ActionRecord] = []
        self._filtered: list[ActionRecord] = []
        self._current_record: ActionRecord | None = None
        self._needs_refresh = True

        root = QHBoxLayout(self)
        root.setContentsMargins(4, 4, 4, 4)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        # ---- left: filters + table ----
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)

        filter_row = QHBoxLayout()
        filter_row.addWidget(QLabel("类型:"))
        self._type_filter = FilterableTypeCombo(
            [("全部", "全部")] + [(t, t) for t in ACTION_TYPES],
        )
        self._type_filter.set_committed_type("全部")
        self._type_filter.typeCommitted.connect(self._apply_filter)
        filter_row.addWidget(self._type_filter)

        filter_row.addWidget(QLabel("来源:"))
        self._source_filter = FilterableTypeCombo([(s, s) for s in _SOURCE_TYPES])
        self._source_filter.set_committed_type("全部")
        self._source_filter.typeCommitted.connect(self._apply_filter)
        filter_row.addWidget(self._source_filter)

        self._search = QLineEdit()
        self._search.setPlaceholderText("搜索...")
        self._search.textChanged.connect(self._apply_filter)
        filter_row.addWidget(self._search)

        btn_refresh = QPushButton("刷新")
        btn_refresh.clicked.connect(self._full_scan)
        filter_row.addWidget(btn_refresh)

        ll.addLayout(filter_row)

        self._count_label = QLabel("共 0 条")
        ll.addWidget(self._count_label)

        self._table = QTableWidget()
        self._table.setColumnCount(4)
        self._table.setHorizontalHeaderLabels(["类型", "来源", "来源ID", "参数摘要"])
        self._table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self._table.horizontalHeader().setStretchLastSection(True)
        self._table.horizontalHeader().setSectionResizeMode(
            0, QHeaderView.ResizeMode.ResizeToContents)
        self._table.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.ResizeToContents)
        self._table.horizontalHeader().setSectionResizeMode(
            2, QHeaderView.ResizeMode.ResizeToContents)
        self._table.currentCellChanged.connect(self._on_row_changed)
        ll.addWidget(self._table)

        # ---- right: detail ----
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(4, 0, 0, 0)

        self._detail_label = QLabel("选择一条 Action 查看详情")
        self._detail_label.setStyleSheet("font-weight: bold; padding: 4px;")
        rl.addWidget(self._detail_label)

        self._detail_frame = QFrame()
        self._detail_frame.setFrameShape(QFrame.Shape.StyledPanel)
        dl = QVBoxLayout(self._detail_frame)
        dl.setContentsMargins(8, 8, 8, 8)

        self._info_lines: list[QLabel] = []
        for _ in range(5):
            lbl = QLabel()
            lbl.setWordWrap(True)
            dl.addWidget(lbl)
            self._info_lines.append(lbl)

        dl.addStretch()

        btn_row = QHBoxLayout()
        self._btn_goto = QPushButton("跳转到来源")
        self._btn_goto.clicked.connect(self._goto_source)
        self._btn_goto.setEnabled(False)
        btn_row.addWidget(self._btn_goto)
        btn_row.addStretch()
        dl.addLayout(btn_row)

        rl.addWidget(self._detail_frame)
        rl.addStretch()

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([700, 400])
        root.addWidget(splitter)

        self._model.data_changed.connect(self._mark_needs_refresh)

    def showEvent(self, event):
        super().showEvent(event)
        if self._needs_refresh:
            self._full_scan()

    def _mark_needs_refresh(self, *_args):
        self._needs_refresh = True

    def _full_scan(self) -> None:
        self._records = _scan_actions(self._model)
        self._needs_refresh = False
        self._apply_filter()

    def _apply_filter(self) -> None:
        type_f = self._type_filter.committed_type()
        source_f = self._source_filter.committed_type()
        search_f = self._search.text().strip().lower()

        filtered: list[ActionRecord] = []
        for r in self._records:
            if type_f != "全部" and r.action_type != type_f:
                continue
            if source_f != "全部":
                expected = _SOURCE_MAP.get(source_f, "")
                if r.source_type != expected:
                    continue
            if search_f:
                haystack = f"{r.action_type} {r.source_id} {r.scene_id} {r.params_summary}".lower()
                if search_f not in haystack:
                    continue
            filtered.append(r)

        self._filtered = filtered
        self._rebuild_table()

    def _rebuild_table(self) -> None:
        self._table.setRowCount(len(self._filtered))
        for i, r in enumerate(self._filtered):
            self._table.setItem(i, 0, QTableWidgetItem(r.action_type))
            self._table.setItem(i, 1, QTableWidgetItem(r.source_label))
            src_id = r.source_id
            if r.scene_id:
                src_id = f"{r.scene_id}/{src_id}"
            self._table.setItem(i, 2, QTableWidgetItem(src_id))
            self._table.setItem(i, 3, QTableWidgetItem(r.params_summary))
        self._count_label.setText(f"共 {len(self._filtered)} 条 (全部 {len(self._records)} 条)")

    def _on_row_changed(self, row: int, _col: int, _prev_row: int, _prev_col: int):
        if row < 0 or row >= len(self._filtered):
            self._current_record = None
            self._btn_goto.setEnabled(False)
            self._detail_label.setText("选择一条 Action 查看详情")
            for lbl in self._info_lines:
                lbl.setText("")
            return

        r = self._filtered[row]
        self._current_record = r
        self._btn_goto.setEnabled(True)
        self._detail_label.setText(f"Action: {r.action_type}")

        params = r.action.get("params", {})
        param_lines = [f"  {k} = {v}" for k, v in params.items()]
        param_text = "\n".join(param_lines) if param_lines else "(无参数)"

        self._info_lines[0].setText(f"类型: {r.action_type}")
        self._info_lines[1].setText(f"来源: {r.full_source}")
        self._info_lines[2].setText(f"容器: {r.container_field}[{r.container_index}]")
        self._info_lines[3].setText(f"参数:\n{param_text}")
        self._info_lines[4].setText("")

    def _goto_source(self) -> None:
        r = self._current_record
        if not r:
            return
        self.navigate_to_source.emit(r.source_type, r.source_id, r.scene_id)
