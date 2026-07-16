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
from ..shared.action_editor import ACTION_TYPES, ActionTypePickerField, FilterableTypeCombo

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
    navigable: bool = True

    @property
    def source_label(self) -> str:
        labels = {
            "quest": "Quest",
            "encounter": "Encounter",
            "scene": "Scene",
            "scene_hotspot": "Hotspot",
            "scene_zone": "Zone",
            "scene_zone_rule": "ZoneRule",
            "pressure_hold": "长按",
            "signal_cue": "信号Cue",
            "water_minigame": "捞尸",
            "sugar_wheel": "糖画",
            "paper_craft": "扎纸",
            "archive": "档案",
            "dialogueGraph": "图对话",
            "cutscene": "过场",
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


def _flatten_actions(actions, prefix: str):
    """展开一个 action 列表（含嵌套容器），yield (路径, action dict)。
    嵌套口径对齐 validator._walk_action_defs：runActions/addDelayedEvent.params.actions、
    chooseAction options[].actions、randomBranch above/below、enableRuleOffers slots.resultActions。
    这样总计数与运行时/校验器实际会执行的动作站点一致（复核 P2 ⑤，"共 N 条"如实）。"""
    out: list[tuple[str, dict]] = []
    for i, act in enumerate(actions or []):
        if not isinstance(act, dict):
            continue
        path = f"{prefix}[{i}]"
        out.append((path, act))
        p = act.get("params") or {}
        t = act.get("type")
        if t in ("runActions", "addDelayedEvent"):
            out += _flatten_actions(p.get("actions"), f"{path}.actions")
        elif t == "chooseAction":
            for oi, opt in enumerate(p.get("options") or []):
                if isinstance(opt, dict):
                    out += _flatten_actions(opt.get("actions"), f"{path}.options[{oi}]")
        elif t == "randomBranch":
            out += _flatten_actions(p.get("aboveActions"), f"{path}.aboveActions")
            out += _flatten_actions(p.get("belowActions"), f"{path}.belowActions")
        elif t == "enableRuleOffers":
            for si, slot in enumerate(p.get("slots") or []):
                if isinstance(slot, dict):
                    out += _flatten_actions(
                        slot.get("resultActions"), f"{path}.slots[{si}].resultActions")
    return out


def _emit(records: list, actions, *, source_type: str, source_id: str,
          scene_id: str, field: str, navigable: bool = True) -> None:
    for path, act in _flatten_actions(actions, field):
        records.append(ActionRecord(
            action=act, action_type=act.get("type", ""),
            source_type=source_type, source_id=source_id, scene_id=scene_id,
            container_field=path, container_index=-1, navigable=navigable,
        ))


def _scan_actions(model: ProjectModel) -> list[ActionRecord]:
    records: list[ActionRecord] = []

    for q in model.quests:
        qid = q.get("id", "?")
        _emit(records, q.get("acceptActions"), source_type="quest",
              source_id=qid, scene_id="", field="acceptActions")
        _emit(records, q.get("rewards"), source_type="quest",
              source_id=qid, scene_id="", field="rewards")

    for enc in model.encounters:
        eid = enc.get("id", "?")
        for oi, opt in enumerate(enc.get("options", []) or []):
            if isinstance(opt, dict):
                _emit(records, opt.get("resultActions"), source_type="encounter",
                      source_id=eid, scene_id="", field=f"options[{oi}].resultActions")
        _emit(records, enc.get("rewards"), source_type="encounter",
              source_id=eid, scene_id="", field="rewards")

    for sid, sc in model.scenes.items():
        _emit(records, sc.get("onEnter"), source_type="scene",
              source_id=sid, scene_id=sid, field="onEnter")
        for hs in sc.get("hotspots", []) or []:
            hid = hs.get("id", "?")
            _emit(records, (hs.get("data") or {}).get("actions"),
                  source_type="scene_hotspot", source_id=hid, scene_id=sid,
                  field="actions")
        for zone in sc.get("zones", []) or []:
            zid = zone.get("id", "?")
            for ev in ("onEnter", "onStay", "onExit"):
                _emit(records, zone.get(ev), source_type="scene_zone",
                      source_id=zid, scene_id=sid, field=ev)

    # 长按 pressure_holds：onComplete + 各 interrupts[].actions
    for h in getattr(model, "pressure_holds", None) or []:
        if not isinstance(h, dict):
            continue
        hid = str(h.get("id") or "?")
        _emit(records, h.get("onComplete"), source_type="pressure_hold",
              source_id=hid, scene_id="", field="onComplete", navigable=False)
        for ii, it in enumerate(h.get("interrupts") or []):
            if isinstance(it, dict):
                _emit(records, it.get("actions"), source_type="pressure_hold",
                      source_id=hid, scene_id="", field=f"interrupts[{ii}].actions",
                      navigable=False)

    # 信号 Cue：actions
    for c in getattr(model, "signal_cues", None) or []:
        if isinstance(c, dict):
            _emit(records, c.get("actions"), source_type="signal_cue",
                  source_id=str(c.get("id") or "?"), scene_id="", field="actions",
                  navigable=False)

    # 捞尸小游戏实例：entities[].onPick/onPullSuccess/onPullFail
    for iid, doc in (getattr(model, "water_minigames_instances", None) or {}).items():
        if not isinstance(doc, dict):
            continue
        for ent in doc.get("entities") or []:
            if not isinstance(ent, dict):
                continue
            eid = str(ent.get("id") or "?")
            for hook in ("onPick", "onPullSuccess", "onPullFail"):
                _emit(records, ent.get(hook), source_type="water_minigame",
                      source_id=f"{iid}:{eid}", scene_id="", field=hook,
                      navigable=False)

    # 糖画转盘实例：sectors[].actionsOnPointerDrag/actionsOnSpinLanding
    for iid, doc in (getattr(model, "sugar_wheel_instances", None) or {}).items():
        if not isinstance(doc, dict):
            continue
        for si, sec in enumerate(doc.get("sectors") or []):
            if not isinstance(sec, dict):
                continue
            for hook in ("actionsOnPointerDrag", "actionsOnSpinLanding"):
                _emit(records, sec.get(hook), source_type="sugar_wheel",
                      source_id=f"{iid}:sector{si}", scene_id="", field=hook,
                      navigable=False)

    # 扎纸小游戏实例：orders[].onSuccess/Warn/BadActions
    for iid, doc in (getattr(model, "paper_craft_instances", None) or {}).items():
        if not isinstance(doc, dict):
            continue
        for order in doc.get("orders") or []:
            if not isinstance(order, dict):
                continue
            oid = str(order.get("id") or "?")
            for hook in ("onSuccessActions", "onWarnActions", "onBadActions"):
                _emit(records, order.get(hook), source_type="paper_craft",
                      source_id=f"{iid}:{oid}", scene_id="", field=hook,
                      navigable=False)

    # 档案 firstViewActions：人物 / 传说 / 文档 / 书页与书页子条目
    for ch in getattr(model, "archive_characters", None) or []:
        if isinstance(ch, dict):
            _emit(records, ch.get("firstViewActions"), source_type="archive",
                  source_id=str(ch.get("id") or "?"), scene_id="",
                  field="firstViewActions", navigable=False)
    lore = getattr(model, "archive_lore", None)
    lore_entries = lore.get("entries") if isinstance(lore, dict) else lore
    for le in lore_entries or []:
        if isinstance(le, dict):
            _emit(records, le.get("firstViewActions"), source_type="archive",
                  source_id=str(le.get("id") or "?"), scene_id="",
                  field="firstViewActions", navigable=False)
    for doc in getattr(model, "archive_documents", None) or []:
        if isinstance(doc, dict):
            _emit(records, doc.get("firstViewActions"), source_type="archive",
                  source_id=str(doc.get("id") or "?"), scene_id="",
                  field="firstViewActions", navigable=False)
    for bk in getattr(model, "archive_books", None) or []:
        if not isinstance(bk, dict):
            continue
        bid = str(bk.get("id") or "?")
        for pg in bk.get("pages") or []:
            if not isinstance(pg, dict):
                continue
            pnum = pg.get("pageNum", "?")
            _emit(records, pg.get("firstViewActions"), source_type="archive",
                  source_id=f"{bid}/page/{pnum}", scene_id="",
                  field="firstViewActions", navigable=False)
            for ent in pg.get("entries") or []:
                if isinstance(ent, dict):
                    _emit(records, ent.get("firstViewActions"), source_type="archive",
                          source_id=f"{bid}/entry/{ent.get('id', '?')}", scene_id="",
                          field="firstViewActions", navigable=False)

    # 图对话 runActions 节点（可跳转到该图）
    for gid, g, _pending in _iter_dialogue_graph_docs(model):
        nodes = g.get("nodes")
        if not isinstance(nodes, dict):
            continue
        for nid, node in nodes.items():
            if isinstance(node, dict) and node.get("type") == "runActions":
                _emit(records, node.get("actions"), source_type="dialogueGraph",
                      source_id=gid, scene_id="", field=f"{nid}.actions")

    # 过场 cutscene：action-kind 步骤（含 parallel 子轨）
    for cs in getattr(model, "cutscenes", None) or []:
        if isinstance(cs, dict):
            cid = str(cs.get("id") or "?")
            acts = list(_iter_cutscene_step_actions(cs.get("steps"), ""))
            for path, act in acts:
                records.append(ActionRecord(
                    action=act, action_type=act.get("type", ""),
                    source_type="cutscene", source_id=cid, scene_id="",
                    container_field=path, container_index=-1, navigable=False,
                ))

    return records


def _iter_dialogue_graph_docs(model):
    from .flag_registry_editor import iter_dialogue_graph_docs
    yield from iter_dialogue_graph_docs(model)


def _iter_cutscene_step_actions(steps, prefix: str):
    """cutscene 步骤里 kind=='action' 的步（递归 parallel 子轨），yield (路径, 伪 action dict)。"""
    for i, step in enumerate(steps or []):
        if not isinstance(step, dict):
            continue
        path = f"{prefix}step[{i}]"
        if step.get("kind") == "action":
            yield path, {"type": step.get("type", ""), "params": step.get("params") or {}}
        elif step.get("kind") == "parallel":
            for ti, track in enumerate(step.get("tracks") or []):
                if isinstance(track, dict):
                    yield from _iter_cutscene_step_actions([track], f"{path}.track[{ti}].")


_SOURCE_TYPES = [
    "全部", "Quest", "Encounter", "Scene", "Hotspot", "Zone", "ZoneRule",
    "长按", "信号Cue", "捞尸", "糖画", "扎纸", "档案", "图对话", "过场",
]
_SOURCE_MAP = {
    "Quest": "quest", "Encounter": "encounter", "Scene": "scene",
    "Hotspot": "scene_hotspot", "Zone": "scene_zone",
    "ZoneRule": "scene_zone_rule",
    "长按": "pressure_hold", "信号Cue": "signal_cue",
    "捞尸": "water_minigame", "糖画": "sugar_wheel", "扎纸": "paper_craft",
    "档案": "archive", "图对话": "dialogueGraph", "过场": "cutscene",
}

# 覆盖这些脏桶变更时标记需重扫（扩大自 scene/quest/encounter，含新纳入的动作站点）。
_ACTION_REGISTRY_DIRTY_TYPES = frozenset({
    "scene", "quest", "encounter", "pressure_holds", "signal_cues",
    "water_minigames", "sugar_wheel", "paper_craft", "archive",
    "cutscene", "dialogue_graph_edits",
})


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
        self._type_filter = ActionTypePickerField(
            [("全部", "全部")] + [(t, t) for t in ACTION_TYPES],
            self,
        )
        self._type_filter.set_committed_type("全部")
        self._type_filter.typeCommitted.connect(self._apply_filter)
        filter_row.addWidget(self._type_filter)

        filter_row.addWidget(QLabel("来源:"))
        self._source_filter = FilterableTypeCombo(
            [(s, s) for s in _SOURCE_TYPES],
            select_only=True,
        )
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
        coverage = QLabel(
            "本页覆盖范围：Quest / Encounter(含 rewards) / Scene onEnter / Hotspot / Zone / "
            "长按 / 信号Cue / 捞尸·糖画·扎纸小游戏 / 档案 firstViewActions / 图对话 runActions / "
            "过场步骤（含 runActions 等嵌套容器递归展开）。灰色行不支持「跳转到来源」。"
        )
        coverage.setWordWrap(True)
        coverage.setStyleSheet("color:#888;")
        ll.addWidget(coverage)

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
        splitter.setSizes([600, 380])  # 合计≈980，嵌入面板(~1050)可容；可拖动
        root.addWidget(splitter)

        self._model.data_changed.connect(self._mark_needs_refresh)

    def showEvent(self, event):
        super().showEvent(event)
        if self._needs_refresh:
            self._full_scan()

    def _mark_needs_refresh(self, data_type: str, *_args) -> None:
        if data_type not in _ACTION_REGISTRY_DIRTY_TYPES:
            return
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
        from PySide6.QtGui import QBrush, QColor
        gray = QBrush(QColor("#888"))
        self._table.setRowCount(len(self._filtered))
        for i, r in enumerate(self._filtered):
            cells = [
                QTableWidgetItem(r.action_type),
                QTableWidgetItem(r.source_label),
                QTableWidgetItem(f"{r.scene_id}/{r.source_id}" if r.scene_id else r.source_id),
                QTableWidgetItem(r.params_summary),
            ]
            for c, it in enumerate(cells):
                if not r.navigable:
                    it.setForeground(gray)  # 不支持跳转的来源灰显（覆盖说明已写明）
                self._table.setItem(i, c, it)
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
        # startDialogueGraph 即使来源不可跳，也能按 graphId 跳到目标图（下方特判）。
        self._btn_goto.setEnabled(r.navigable or r.action_type == "startDialogueGraph")
        self._detail_label.setText(f"Action: {r.action_type}")

        params = r.action.get("params", {})
        param_lines = [f"  {k} = {v}" for k, v in params.items()]
        param_text = "\n".join(param_lines) if param_lines else "(无参数)"

        container = r.container_field
        if r.container_index >= 0:
            container = f"{r.container_field}[{r.container_index}]"
        self._info_lines[0].setText(f"类型: {r.action_type}")
        self._info_lines[1].setText(f"来源: {r.full_source}")
        self._info_lines[2].setText(f"容器: {container}")
        self._info_lines[3].setText(f"参数:\n{param_text}")
        self._info_lines[4].setText(
            "" if r.navigable else "（此来源暂不支持跳转，用左侧搜索或到对应编辑器定位）"
        )

    def _goto_source(self) -> None:
        r = self._current_record
        if not r:
            return
        if r.action_type == "startDialogueGraph":
            gid = (r.action.get("params") or {}).get("graphId")
            if gid:
                self.navigate_to_source.emit("dialogue_graph", str(gid), "")
                return
        if r.source_type == "dialogueGraph":
            self.navigate_to_source.emit("dialogue_graph", r.source_id, "")
            return
        if not r.navigable:
            return  # 来源不在主窗导航映射里（长按/信号Cue/小游戏/档案/过场），只读不跳
        self.navigate_to_source.emit(r.source_type, r.source_id, r.scene_id)
