"""叙事清单 JSON：scenarios.json、document_reveals.json（主编辑器内嵌）。"""
from __future__ import annotations

import json

from PySide6.QtCore import Qt, QEvent, QObject, QItemSelectionModel
from PySide6.QtGui import QKeySequence, QMouseEvent, QShortcut
from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QPushButton,
    QMessageBox,
    QListWidget,
    QListWidgetItem,
    QSplitter,
    QScrollArea,
    QFormLayout,
    QLineEdit,
    QComboBox,
    QTableWidget,
    QHeaderView,
    QAbstractItemView,
    QGroupBox,
    QStackedWidget,
    QSpinBox,
)

from ..flag_registry import scenario_exposes_flag_errors
from ..project_model import ProjectModel
from ..shared.flag_key_field import FlagKeyPickField
from ..shared.flag_value_edit import FlagValueEdit
from ..shared.id_ref_selector import IdRefSelector
from ..shared.image_path_picker import CutsceneImagePathRow
from ..shared.blend_overlay_preview import BlendOverlayPreviewWidget
from ..shared.condition_expr_tree import ConditionExprTreeRootWidget
from ..shared.pick_strings_dialog import pick_strings_multi

# 与叙事文档、运行时 string 比较一致；策划仅允许选这些（勿手写大小写变体）
SCENARIO_PHASE_STATUSES: tuple[str, ...] = ("pending", "active", "done", "locked")
QUEST_STATUSES: tuple[str, ...] = ("Inactive", "Active", "Completed")


class _PhaseRequiresCell(QWidget):
    """阶段 requires：只读摘要 +「选择…」打开多选（禁止手写逗号列表）。"""

    def __init__(
        self,
        table: QTableWidget,
        on_structure_changed,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._table = table
        self._on_structure_changed = on_structure_changed
        lay = QHBoxLayout(self)
        lay.setContentsMargins(2, 2, 2, 2)
        self._line = QLineEdit()
        self._line.setReadOnly(True)
        self._line.setPlaceholderText("点击「选择…」指定依赖 phase")
        self._btn = QPushButton("选择…")
        self._btn.setFixedWidth(72)
        lay.addWidget(self._line, stretch=1)
        lay.addWidget(self._btn)
        self._btn.clicked.connect(self._pick)

    def _resolve_row(self) -> int:
        for r in range(self._table.rowCount()):
            if self._table.cellWidget(r, 2) is self:
                return r
        return -1

    def _pick(self) -> None:
        r = self._resolve_row()
        if r < 0:
            return
        nw = self._table.cellWidget(r, 0)
        self_name = nw.text().strip() if isinstance(nw, QLineEdit) else ""
        ordered: list[str] = []
        seen: set[str] = set()
        for rr in range(self._table.rowCount()):
            w0 = self._table.cellWidget(rr, 0)
            if not isinstance(w0, QLineEdit):
                continue
            t = w0.text().strip()
            if not t or t == self_name or t in seen:
                continue
            seen.add(t)
            ordered.append(t)
        if not ordered:
            QMessageBox.information(
                self, "phase requires",
                "没有其它可依赖的 phase：请先添加更多阶段，或填写本行「phase 名」。",
            )
            return
        cur = [x.strip() for x in self._line.text().split(",") if x.strip()]
        picked = pick_strings_multi(
            self,
            "选择本 phase 的 requires",
            ordered,
            cur,
            label="勾选：推进本阶段前须已为 done 的其它 phase。",
            sort_choices=False,
        )
        if picked is None:
            return
        self._line.setText(", ".join(picked))
        self._on_structure_changed()

    def set_requires_text(self, text: str) -> None:
        self._line.setText(text)

    def requires_text(self) -> str:
        return self._line.text().strip()


class ScenariosCatalogEditor(QWidget):
    """结构化编辑 public/assets/data/scenarios.json（内存：ProjectModel.scenarios_catalog）。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._loading_ui = False

        root = QVBoxLayout(self)
        tip = QLabel(
            "scenarioId、进线 requires、阶段 requires、exposes 的 flag 均通过下拉/对话框选择，勿手写 id；"
            "exposes 的写入值控件随该 flag 在 flag_registry 中的类型切换（布尔 / 数值 / 字符串）。"
            "phase 名称与 description 为策划文案仅可手写。"
            "status 仅四种枚举。Apply 写入内存；保存工程写入 data/scenarios.json。"
            "图对话 setScenarioPhase、scenario 条件须与本页一致。",
        )
        tip.setWordWrap(True)
        root.addWidget(tip)

        split = QSplitter(Qt.Orientation.Horizontal)
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.addWidget(QLabel("Scenario 列表"))
        self._sc_list = QListWidget()
        self._sc_list.currentRowChanged.connect(self._on_row_changed)
        ll.addWidget(self._sc_list)
        lr = QHBoxLayout()
        self._btn_add = QPushButton("添加")
        self._btn_add.clicked.connect(self._add_scenario)
        self._btn_del = QPushButton("删除")
        self._btn_del.clicked.connect(self._del_scenario)
        lr.addWidget(self._btn_add)
        lr.addWidget(self._btn_del)
        ll.addLayout(lr)

        right_scroll = QScrollArea()
        right_scroll.setWidgetResizable(True)
        right_host = QWidget()
        self._detail_form_host = right_host
        rfl = QVBoxLayout(right_host)

        form = QFormLayout()
        self._f_id_row = QWidget()
        _idl = QHBoxLayout(self._f_id_row)
        _idl.setContentsMargins(0, 0, 0, 0)
        self._f_id_sel = IdRefSelector(
            self._f_id_row, allow_empty=True, editable=False,
        )
        self._f_id_sel.setToolTip(
            "须与图内 setScenarioPhase.scenarioId、条件里的 scenario 一致；从下拉选择或生成唯一 id。",
        )
        self._f_id_sel.value_changed.connect(self._on_detail_edited)
        self._f_id_new = QPushButton("生成唯一 id")
        self._f_id_new.setToolTip("分配未占用的 scenarioId（仍可在下拉里改选其它空闲 id）")
        self._f_id_new.clicked.connect(self._on_gen_scenario_id)
        _idl.addWidget(self._f_id_sel, stretch=1)
        _idl.addWidget(self._f_id_new)
        self._f_desc = QLineEdit()
        self._f_desc.setPlaceholderText("描述（可选，仅说明文案可手写）")
        self._f_requires_row = QWidget()
        _srl = QHBoxLayout(self._f_requires_row)
        _srl.setContentsMargins(0, 0, 0, 0)
        self._f_requires_disp = QLineEdit()
        self._f_requires_disp.setReadOnly(True)
        self._f_requires_disp.setPlaceholderText("点击「选择…」指定进线所需的 phase（须已列于下方 phases）")
        self._f_requires_btn = QPushButton("选择…")
        self._f_requires_btn.setFixedWidth(72)
        self._f_requires_btn.clicked.connect(self._pick_scenario_requires)
        _srl.addWidget(self._f_requires_disp, stretch=1)
        _srl.addWidget(self._f_requires_btn)
        self._f_expose_after = QComboBox()
        self._f_expose_after.setEditable(False)
        self._f_expose_after.setToolTip(
            "当该 phase 被设为 status=done 时，将 exposes 中的键值写入全局 FlagStore；"
            "值的类型须与 flag_registry 中该键的 valueType 一致（bool / 数值 / 字符串）。",
        )
        self._f_desc.textChanged.connect(self._on_detail_edited)
        self._f_expose_after.currentIndexChanged.connect(self._on_detail_edited)
        form.addRow("id", self._f_id_row)
        form.addRow("description", self._f_desc)
        form.addRow("scenario 进线 requires", self._f_requires_row)
        form.addRow("exposeAfterPhase", self._f_expose_after)
        rfl.addLayout(form)

        exp_g = QGroupBox("exposes（完成 exposeAfterPhase 后写入的 flag 与值）")
        exp_l = QVBoxLayout(exp_g)
        self._tbl_exposes = QTableWidget(0, 2)
        self._tbl_exposes.setHorizontalHeaderLabels(["flag 键名", "写入值（随登记表类型）"])
        self._tbl_exposes.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self._tbl_exposes.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.Stretch)
        self._tbl_exposes.setMinimumHeight(120)
        exp_l.addWidget(self._tbl_exposes)
        er = QHBoxLayout()
        eb_a = QPushButton("添加行")
        eb_a.clicked.connect(self._exposes_add_row)
        eb_d = QPushButton("删除所选行")
        eb_d.clicked.connect(self._exposes_del_row)
        er.addWidget(eb_a)
        er.addWidget(eb_d)
        er.addStretch()
        exp_l.addLayout(er)
        rfl.addWidget(exp_g)

        ph_g = QGroupBox(
            "phases（阶段清单；requires=推进该 phase 前须 done 的其它 phase，逗号分隔）",
        )
        ph_l = QVBoxLayout(ph_g)
        self._tbl_phases = QTableWidget(0, 3)
        self._tbl_phases.setHorizontalHeaderLabels(["phase 名", "清单默认 status", "requires（逗号）"])
        self._tbl_phases.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self._tbl_phases.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.ResizeToContents)
        self._tbl_phases.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        self._tbl_phases.setMinimumHeight(200)
        self._tbl_phases.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._tbl_phases.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        vh = self._tbl_phases.verticalHeader()
        vh.setSectionsMovable(True)
        vh.setMinimumWidth(28)
        vh.sectionMoved.connect(self._on_phases_section_moved)
        ph_hint = QLabel(
            "在单元格内点击也会选中该行（Ctrl 加选、Shift 范围选）；拖曳左侧行号可调整顺序；"
            "选中后按 Delete 或点「删除所选阶段」删除。",
        )
        ph_hint.setWordWrap(True)
        ph_hint.setStyleSheet("color: #666; font-size: 12px;")
        ph_l.addWidget(self._tbl_phases)
        _ph_del_sc = QShortcut(QKeySequence(Qt.Key.Key_Delete), self._tbl_phases)
        _ph_del_sc.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        _ph_del_sc.activated.connect(self._phases_del_row)
        pr = QHBoxLayout()
        pb_a = QPushButton("添加阶段")
        pb_a.clicked.connect(self._phases_add_row)
        pb_d = QPushButton("删除所选阶段")
        pb_d.clicked.connect(self._phases_del_row)
        pr.addWidget(pb_a)
        pr.addWidget(pb_d)
        pr.addStretch()
        ph_l.addLayout(pr)
        ph_l.addWidget(ph_hint)
        rfl.addWidget(ph_g)

        rfl.addStretch()
        right_scroll.setWidget(right_host)

        split.addWidget(left)
        split.addWidget(right_scroll)
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        root.addWidget(split, stretch=1)

        row = QHBoxLayout()
        reload_btn = QPushButton("从内存重载")
        reload_btn.clicked.connect(self.reload_from_model)
        apply_btn = QPushButton("Apply")
        apply_btn.clicked.connect(self._apply)
        row.addWidget(reload_btn)
        row.addWidget(apply_btn)
        row.addStretch()
        root.addLayout(row)

        self._scenarios_data: list[dict] = []
        self.reload_from_model()

    # ---- status combo helper ---------------------------------------------

    def _make_status_combo(self, current: str) -> QComboBox:
        cb = QComboBox()
        for s in SCENARIO_PHASE_STATUSES:
            cb.addItem(s, s)
        idx = cb.findData(current)
        if idx >= 0:
            cb.setCurrentIndex(idx)
        else:
            cb.addItem(f"（数据）{current}", current)
            cb.setCurrentIndex(cb.count() - 1)
        cb.currentIndexChanged.connect(lambda _i: self._on_detail_edited())
        return cb

    def _phase_names_from_phases_table(self) -> list[str]:
        ordered: list[str] = []
        seen: set[str] = set()
        for r in range(self._tbl_phases.rowCount()):
            w = self._tbl_phases.cellWidget(r, 0)
            if isinstance(w, QLineEdit):
                t = w.text().strip()
                if t and t not in seen:
                    seen.add(t)
                    ordered.append(t)
        return ordered

    def _scenario_id_choice_tuples(self, editing_row: int) -> list[tuple[str, str]]:
        if editing_row < 0 or editing_row >= len(self._scenarios_data):
            return []
        cur = str(self._scenarios_data[editing_row].get("id", "")).strip()
        used_elsewhere: set[str] = set()
        for i, e in enumerate(self._scenarios_data):
            if i == editing_row:
                continue
            s = str(e.get("id", "")).strip()
            if s:
                used_elsewhere.add(s)
        pool: list[str] = []
        seen: set[str] = set()
        for sid in self._model.scenario_ids_ordered():
            s = str(sid).strip()
            if s and s not in seen:
                seen.add(s)
                pool.append(s)
        for e in self._scenarios_data:
            s = str(e.get("id", "")).strip()
            if s and s not in seen:
                seen.add(s)
                pool.append(s)
        candidates: list[str] = []
        if cur:
            candidates.append(cur)
        for s in pool:
            if s == cur:
                continue
            if s not in used_elsewhere:
                candidates.append(s)
        return [(s, s) for s in candidates]

    def _suggest_unique_scenario_id(self) -> str:
        used = {str(e.get("id", "")).strip() for e in self._scenarios_data}
        used.discard("")
        pool = {str(x).strip() for x in self._model.scenario_ids_ordered()}
        n = 1
        while True:
            cand = f"新scenario_{n}"
            if cand not in used and cand not in pool:
                return cand
            n += 1

    def _on_gen_scenario_id(self) -> None:
        if self._loading_ui:
            return
        row = self._sc_list.currentRow()
        if row < 0:
            return
        new_id = self._suggest_unique_scenario_id()
        self._scenarios_data[row]["id"] = new_id
        self._loading_ui = True
        try:
            self._f_id_sel.blockSignals(True)
            self._f_id_sel.set_items(self._scenario_id_choice_tuples(row))
            self._f_id_sel.set_current(new_id)
            self._f_id_sel.blockSignals(False)
        finally:
            self._loading_ui = False
        it = self._sc_list.item(row)
        if it is not None:
            it.setText(new_id or "(无 id)")
        self._on_detail_edited()

    def _pick_scenario_requires(self) -> None:
        if self._loading_ui:
            return
        names = self._phase_names_from_phases_table()
        if not names:
            QMessageBox.information(
                self, "进线 requires",
                "请先在下方 phases 表中添加至少一个 phase。",
            )
            return
        cur = [x.strip() for x in self._f_requires_disp.text().split(",") if x.strip()]
        picked = pick_strings_multi(
            self,
            "选择 scenario 进线 requires",
            names,
            cur,
            label="勾选：整条 scenario 开始前须已为 done 的 phase（须已出现在 phases 清单中）。",
            sort_choices=False,
        )
        if picked is None:
            return
        self._f_requires_disp.setText(", ".join(picked))
        self._on_detail_edited()

    def _on_phases_section_moved(self, _logical: int, _old_v: int, _new_v: int) -> None:
        if self._loading_ui:
            return
        self._on_phases_or_exposes_structure_changed()

    def _install_phase_cell_event_filters(self, row: int) -> None:
        for col in range(3):
            w = self._tbl_phases.cellWidget(row, col)
            if w is not None:
                w.removeEventFilter(self)
                w.installEventFilter(self)
                if isinstance(w, _PhaseRequiresCell):
                    w._line.removeEventFilter(self)
                    w._line.installEventFilter(self)
                    w._btn.removeEventFilter(self)
                    w._btn.installEventFilter(self)

    def _apply_phase_table_row_selection(self, row: int, event: QMouseEvent) -> None:
        sel = self._tbl_phases.selectionModel()
        if sel is None:
            self._tbl_phases.selectRow(row)
            return
        idx0 = self._tbl_phases.model().index(row, 0)
        mods = event.modifiers()
        if mods & Qt.KeyboardModifier.ControlModifier:
            sel.select(
                idx0,
                QItemSelectionModel.SelectionFlag.Toggle | QItemSelectionModel.SelectionFlag.Rows,
            )
        elif mods & Qt.KeyboardModifier.ShiftModifier:
            anchor = self._tbl_phases.currentRow()
            if anchor < 0:
                sel.select(
                    idx0,
                    QItemSelectionModel.SelectionFlag.ClearAndSelect
                    | QItemSelectionModel.SelectionFlag.Rows,
                )
            else:
                r0, r1 = sorted((anchor, row))
                sel.clearSelection()
                for rr in range(r0, r1 + 1):
                    ix = self._tbl_phases.model().index(rr, 0)
                    sel.select(
                        ix,
                        QItemSelectionModel.SelectionFlag.Select
                        | QItemSelectionModel.SelectionFlag.Rows,
                    )
        else:
            sel.select(
                idx0,
                QItemSelectionModel.SelectionFlag.ClearAndSelect
                | QItemSelectionModel.SelectionFlag.Rows,
            )
        self._tbl_phases.setCurrentIndex(idx0)

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:
        if (
            event.type() == QEvent.Type.MouseButtonPress
            and isinstance(event, QMouseEvent)
            and event.button() == Qt.MouseButton.LeftButton
        ):
            for r in range(self._tbl_phases.rowCount()):
                for c in range(3):
                    if self._tbl_phases.cellWidget(r, c) is watched:
                        self._apply_phase_table_row_selection(r, event)
                        return False
        return super().eventFilter(watched, event)

    def reload_from_model(self) -> None:
        raw = getattr(self._model, "scenarios_catalog", None) or {}
        if not isinstance(raw, dict):
            raw = {}
        arr = raw.get("scenarios") or []
        if not isinstance(arr, list):
            arr = []
        self._scenarios_data = []
        for e in arr:
            if isinstance(e, dict):
                self._scenarios_data.append(json.loads(json.dumps(e, ensure_ascii=False)))
        self._loading_ui = True
        try:
            self._sc_list.clear()
            for e in self._scenarios_data:
                sid = str(e.get("id", "")).strip()
                it = QListWidgetItem(sid or "(无 id)")
                self._sc_list.addItem(it)
            self._sc_list.setCurrentRow(0 if self._sc_list.count() else -1)
        finally:
            self._loading_ui = False
        self._refresh_detail_panel()

    def _on_row_changed(self, row: int) -> None:
        if self._loading_ui:
            return
        self._refresh_detail_panel()

    def _refresh_detail_panel(self) -> None:
        row = self._sc_list.currentRow()
        self._detail_form_host.setEnabled(row >= 0)
        if row < 0 or row >= len(self._scenarios_data):
            self._clear_detail_fields()
            return
        d = self._scenarios_data[row]
        self._loading_ui = True
        try:
            self._f_id_sel.blockSignals(True)
            self._f_id_sel.set_items(self._scenario_id_choice_tuples(row))
            self._f_id_sel.set_current(str(d.get("id", "")).strip())
            self._f_id_sel.blockSignals(False)
            self._f_desc.setText(str(d.get("description", "")))
            req = d.get("requires")
            if isinstance(req, list):
                self._f_requires_disp.setText(
                    ", ".join(str(x).strip() for x in req if str(x).strip()),
                )
            else:
                self._f_requires_disp.clear()

            phases = d.get("phases") if isinstance(d.get("phases"), dict) else {}
            phase_names = [str(k) for k in phases.keys()]

            self._f_expose_after.blockSignals(True)
            self._f_expose_after.clear()
            self._f_expose_after.addItem("（不配置）", "")
            for pn in phase_names:
                self._f_expose_after.addItem(pn, pn)
            eat = str(d.get("exposeAfterPhase", "")).strip()
            idx = self._f_expose_after.findData(eat)
            self._f_expose_after.setCurrentIndex(idx if idx >= 0 else 0)
            self._f_expose_after.blockSignals(False)

            self._fill_exposes_table(d.get("exposes") if isinstance(d.get("exposes"), dict) else {})
            self._fill_phases_table(phases)
        finally:
            self._loading_ui = False

    def _clear_detail_fields(self) -> None:
        self._f_id_sel.blockSignals(True)
        self._f_id_sel.set_items([])
        self._f_id_sel.blockSignals(False)
        self._f_desc.clear()
        self._f_requires_disp.clear()
        self._f_expose_after.clear()
        self._f_expose_after.addItem("（不配置）", "")
        self._tbl_exposes.setRowCount(0)
        vh = self._tbl_phases.verticalHeader()
        vh.blockSignals(True)
        try:
            self._tbl_phases.setRowCount(0)
        finally:
            vh.blockSignals(False)

    def _fill_exposes_table(self, exposes: dict) -> None:
        self._tbl_exposes.setRowCount(0)
        for k, v in exposes.items():
            if not str(k).strip():
                continue
            r = self._tbl_exposes.rowCount()
            self._tbl_exposes.insertRow(r)
            fk = FlagKeyPickField(self._model, None, str(k), self)
            fk.valueChanged.connect(self._on_detail_edited)
            self._tbl_exposes.setCellWidget(r, 0, fk)
            fv = FlagValueEdit(self, self._model.flag_registry)
            fv.set_flag_key(str(k))
            fv.set_value(v)
            fv.valueChanged.connect(self._on_detail_edited)
            self._tbl_exposes.setCellWidget(r, 1, fv)
            self._wire_exposes_key_to_value(fk, fv)

    def _wire_exposes_key_to_value(self, fk: FlagKeyPickField, fv: FlagValueEdit) -> None:
        """键变化时按登记表刷新值控件的类型（bool / 数值 / 字符串）。"""

        def _sync() -> None:
            fv.set_registry(self._model.flag_registry)
            fv.set_flag_key(fk.key())

        fk.valueChanged.connect(_sync)
        _sync()

    def _fill_phases_table(self, phases: dict) -> None:
        vh = self._tbl_phases.verticalHeader()
        vh.blockSignals(True)
        try:
            self._tbl_phases.setRowCount(0)
            for ph_name, ph_val in phases.items():
                st = "pending"
                req_parts: list[str] = []
                if isinstance(ph_val, dict):
                    if isinstance(ph_val.get("status"), str):
                        st = ph_val["status"]
                    raw_req = ph_val.get("requires")
                    if isinstance(raw_req, list):
                        req_parts = [str(x).strip() for x in raw_req if str(x).strip()]
                r = self._tbl_phases.rowCount()
                self._tbl_phases.insertRow(r)
                ne = QLineEdit(str(ph_name))
                ne.textChanged.connect(self._on_phases_or_exposes_structure_changed)
                self._tbl_phases.setCellWidget(r, 0, ne)
                self._tbl_phases.setCellWidget(r, 1, self._make_status_combo(st))
                dep = _PhaseRequiresCell(
                    self._tbl_phases, self._on_phases_or_exposes_structure_changed, self,
                )
                dep.set_requires_text(", ".join(req_parts))
                self._tbl_phases.setCellWidget(r, 2, dep)
                self._install_phase_cell_event_filters(r)
        finally:
            vh.blockSignals(False)

    def _on_detail_edited(self) -> None:
        if self._loading_ui:
            return
        self._sync_current_row_from_ui()

    def _on_phases_or_exposes_structure_changed(self) -> None:
        if self._loading_ui:
            return
        self._sync_current_row_from_ui()
        self._refresh_expose_after_combo_only()

    def _refresh_expose_after_combo_only(self) -> None:
        row = self._sc_list.currentRow()
        if row < 0 or row >= len(self._scenarios_data):
            return
        cur_eat = self._f_expose_after.currentData()
        phase_names: list[str] = []
        for r in range(self._tbl_phases.rowCount()):
            w = self._tbl_phases.cellWidget(r, 0)
            if isinstance(w, QLineEdit):
                t = w.text().strip()
                if t:
                    phase_names.append(t)
        self._loading_ui = True
        try:
            self._f_expose_after.blockSignals(True)
            self._f_expose_after.clear()
            self._f_expose_after.addItem("（不配置）", "")
            for pn in phase_names:
                self._f_expose_after.addItem(pn, pn)
            idx = self._f_expose_after.findData(cur_eat)
            self._f_expose_after.setCurrentIndex(idx if idx >= 0 else 0)
            self._f_expose_after.blockSignals(False)
        finally:
            self._loading_ui = False

    def _sync_current_row_from_ui(self) -> None:
        row = self._sc_list.currentRow()
        if row < 0:
            return
        d: dict = self._scenarios_data[row]

        sid = self._f_id_sel.current_id().strip()
        d["id"] = sid
        desc = self._f_desc.text().strip()
        if desc:
            d["description"] = desc
        elif "description" in d:
            del d["description"]

        req_text = self._f_requires_disp.text().strip()
        if req_text:
            d["requires"] = [x.strip() for x in req_text.split(",") if x.strip()]
        elif "requires" in d:
            del d["requires"]

        eat = self._f_expose_after.currentData()
        if isinstance(eat, str) and eat.strip():
            d["exposeAfterPhase"] = eat.strip()
        elif "exposeAfterPhase" in d:
            del d["exposeAfterPhase"]

        exposes: dict[str, object] = {}
        for r in range(self._tbl_exposes.rowCount()):
            kw = self._tbl_exposes.cellWidget(r, 0)
            cw = self._tbl_exposes.cellWidget(r, 1)
            if isinstance(kw, FlagKeyPickField):
                key = kw.key().strip()
            elif isinstance(kw, QLineEdit):
                key = kw.text().strip()
            else:
                continue
            if not key:
                continue
            if isinstance(cw, FlagValueEdit):
                exposes[key] = cw.get_value()
            elif isinstance(cw, QComboBox):
                v = cw.currentData()
                exposes[key] = bool(v)
            else:
                continue
        if exposes:
            d["exposes"] = exposes
        elif "exposes" in d:
            del d["exposes"]

        phases: dict[str, dict] = {}
        for r in range(self._tbl_phases.rowCount()):
            nw = self._tbl_phases.cellWidget(r, 0)
            sw = self._tbl_phases.cellWidget(r, 1)
            rw = self._tbl_phases.cellWidget(r, 2)
            if not isinstance(nw, QLineEdit):
                continue
            name = nw.text().strip()
            if not name:
                continue
            st = "pending"
            if isinstance(sw, QComboBox):
                dv = sw.currentData()
                if isinstance(dv, str):
                    st = dv
            entry: dict = {"status": st}
            req_cell = ""
            if isinstance(rw, _PhaseRequiresCell):
                req_cell = rw.requires_text()
            elif isinstance(rw, QLineEdit):
                req_cell = rw.text().strip()
            if req_cell:
                entry["requires"] = [x.strip() for x in req_cell.split(",") if x.strip()]
            phases[name] = entry
        d["phases"] = phases

        item = self._sc_list.item(row)
        if item is not None:
            item.setText(sid or "(无 id)")

    def _add_scenario(self) -> None:
        self._sync_current_row_from_ui()
        new_id = self._suggest_unique_scenario_id()
        self._scenarios_data.append({
            "id": new_id,
            "phases": {"起始": {"status": "pending"}},
        })
        self._loading_ui = True
        try:
            self._sc_list.addItem(QListWidgetItem(new_id))
            self._sc_list.setCurrentRow(self._sc_list.count() - 1)
        finally:
            self._loading_ui = False
        self._refresh_detail_panel()

    def _del_scenario(self) -> None:
        row = self._sc_list.currentRow()
        if row < 0:
            return
        self._scenarios_data.pop(row)
        self._loading_ui = True
        try:
            self._sc_list.takeItem(row)
            self._sc_list.setCurrentRow(min(row, self._sc_list.count() - 1))
        finally:
            self._loading_ui = False
        self._refresh_detail_panel()

    def _exposes_add_row(self) -> None:
        if self._sc_list.currentRow() < 0:
            return
        r = self._tbl_exposes.rowCount()
        self._tbl_exposes.insertRow(r)
        fk = FlagKeyPickField(self._model, None, "", self)
        fk.valueChanged.connect(self._on_detail_edited)
        self._tbl_exposes.setCellWidget(r, 0, fk)
        fv = FlagValueEdit(self, self._model.flag_registry)
        fv.set_flag_key("")
        fv.set_value(False)
        fv.valueChanged.connect(self._on_detail_edited)
        self._tbl_exposes.setCellWidget(r, 1, fv)
        self._wire_exposes_key_to_value(fk, fv)

    def _exposes_del_row(self) -> None:
        rows = sorted({i.row() for i in self._tbl_exposes.selectedIndexes()}, reverse=True)
        if not rows:
            r = self._tbl_exposes.currentRow()
            if r >= 0:
                rows = [r]
        for r in rows:
            self._tbl_exposes.removeRow(r)
        self._on_detail_edited()

    def _phases_add_row(self) -> None:
        if self._sc_list.currentRow() < 0:
            return
        r = self._tbl_phases.rowCount()
        self._tbl_phases.insertRow(r)
        ne = QLineEdit()
        ne.setPlaceholderText("phase 名")
        ne.textChanged.connect(self._on_phases_or_exposes_structure_changed)
        self._tbl_phases.setCellWidget(r, 0, ne)
        self._tbl_phases.setCellWidget(r, 1, self._make_status_combo("pending"))
        dep = _PhaseRequiresCell(
            self._tbl_phases, self._on_phases_or_exposes_structure_changed, self,
        )
        self._tbl_phases.setCellWidget(r, 2, dep)
        self._install_phase_cell_event_filters(r)

    def _phases_del_row(self) -> None:
        rows = sorted({i.row() for i in self._tbl_phases.selectedIndexes()}, reverse=True)
        if not rows:
            r = self._tbl_phases.currentRow()
            if r >= 0:
                rows = [r]
        for r in rows:
            self._tbl_phases.removeRow(r)
        self._on_phases_or_exposes_structure_changed()

    def _validate(self) -> str | None:
        seen: set[str] = set()
        for i, e in enumerate(self._scenarios_data):
            sid = str(e.get("id", "")).strip()
            if not sid:
                return f"第 {i + 1} 条 scenario 的 id 不能为空"
            if sid in seen:
                return f"scenario id 重复：{sid!r}"
            seen.add(sid)
            phases = e.get("phases") if isinstance(e.get("phases"), dict) else {}
            pnames = [str(k) for k in phases.keys()]
            dup_ph = {x for x in pnames if pnames.count(x) > 1}
            if dup_ph:
                return f"{sid!r} 下 phase 名重复：{dup_ph!r}"
            req = e.get("requires")
            if isinstance(req, list):
                for rp in req:
                    rs = str(rp).strip()
                    if rs and rs not in phases:
                        return (
                            f"{sid!r} 的 requires 引用未知 phase {rs!r}（请先在 phases 表中添加）"
                        )
            eat = str(e.get("exposeAfterPhase", "")).strip()
            if eat and eat not in phases:
                return f"{sid!r} 的 exposeAfterPhase {eat!r} 不在 phases 中"
            pset = set(phases.keys())
            adj: dict[str, list[str]] = {}
            for pname, pval in phases.items():
                pn = str(pname)
                req_list: list[str] = []
                if isinstance(pval, dict):
                    pr = pval.get("requires")
                    if isinstance(pr, list):
                        for x in pr:
                            xs = str(x).strip()
                            if not xs:
                                continue
                            if xs not in pset:
                                return (
                                    f"{sid!r} 的 phase {pn!r} requires 引用未知 phase {xs!r}"
                                )
                            req_list.append(xs)
                adj[pn] = req_list
            white, grey, black = 0, 1, 2
            color = {n: white for n in adj}

            def _cyc(u: str) -> bool:
                color[u] = grey
                for v in adj.get(u, []):
                    if v not in color:
                        continue
                    if color.get(v) == grey:
                        return True
                    if color.get(v) == white and _cyc(v):
                        return True
                color[u] = black
                return False

            for n in adj:
                if color.get(n) == white and _cyc(n):
                    return f"{sid!r} 的 phases.requires 存在循环依赖"
            exp_err = scenario_exposes_flag_errors(
                e.get("exposes"),
                getattr(self._model, "flag_registry", None) or {},
                self._model,
                scenario_id=sid,
            )
            if exp_err:
                return exp_err
        return None

    def _build_catalog_dict(self) -> dict:
        self._sync_current_row_from_ui()
        return {"scenarios": json.loads(json.dumps(self._scenarios_data, ensure_ascii=False))}

    def _apply(self) -> None:
        err = self._validate()
        if err:
            QMessageBox.warning(self, "scenarios.json", err)
            return
        self._model.scenarios_catalog = self._build_catalog_dict()
        self._model.mark_dirty("scenarios")

    def flush_to_model(self) -> None:
        err = self._validate()
        if err:
            raise ValueError(f"scenarios.json：{err}")
        self._model.scenarios_catalog = self._build_catalog_dict()
        self._model.mark_dirty("scenarios")


class DocumentRevealsEditor(QWidget):
    """结构化编辑 public/assets/data/document_reveals.json（与运行时 DocumentRevealDef 一致）。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._loading_ui = False
        self._reveals: list[dict] = []

        root = QVBoxLayout(self)
        tip = QLabel(
            "条目 id、任务条件 quest、revealedFlag、overlayId 均从工程清单选择；"
            "Scenario/phase/status 用下拉；outcome 与 JSON/表达式树模式仍为专家手写。"
            "Apply 写入内存；保存工程写入 data/document_reveals.json。",
        )
        tip.setWordWrap(True)
        root.addWidget(tip)

        split = QSplitter(Qt.Orientation.Horizontal)
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.addWidget(QLabel("揭示条目"))
        self._dr_list = QListWidget()
        self._dr_list.currentRowChanged.connect(self._dr_on_row_changed)
        ll.addWidget(self._dr_list)
        lr = QHBoxLayout()
        b_add = QPushButton("添加")
        b_add.clicked.connect(self._dr_add)
        b_del = QPushButton("删除")
        b_del.clicked.connect(self._dr_del)
        lr.addWidget(b_add)
        lr.addWidget(b_del)
        ll.addLayout(lr)

        right_scroll = QScrollArea()
        right_scroll.setWidgetResizable(True)
        rh = QWidget()
        rfl = QVBoxLayout(rh)

        form = QFormLayout()
        self._dr_id_row = QWidget(rh)
        _drl = QHBoxLayout(self._dr_id_row)
        _drl.setContentsMargins(0, 0, 0, 0)
        self._dr_id_sel = IdRefSelector(self._dr_id_row, allow_empty=True, editable=False)
        self._dr_id_sel.setToolTip(
            "与 revealDocument 的 documentId、archive/documents 条目 id 对齐；从档案或已有揭示中选。",
        )
        self._dr_id_sel.value_changed.connect(self._dr_on_edit)
        self._dr_id_new = QPushButton("生成唯一 id")
        self._dr_id_new.setToolTip("分配未占用的揭示 id")
        self._dr_id_new.clicked.connect(self._dr_on_gen_document_id)
        _drl.addWidget(self._dr_id_sel, stretch=1)
        _drl.addWidget(self._dr_id_new)
        form.addRow("id", self._dr_id_row)

        self._dr_blur = CutsceneImagePathRow(
            self._model, "", self, external_copy_subdir="illustrations",
            external_copy_hint="模糊图：可 Browse，外部图复制到 assets/images/illustrations/",
        )
        self._dr_blur.changed.connect(self._dr_on_edit)
        form.addRow("blurredImagePath", self._dr_blur)

        self._dr_clear = CutsceneImagePathRow(
            self._model, "", self, external_copy_subdir="illustrations",
            external_copy_hint="清晰图：同上",
        )
        self._dr_clear.changed.connect(self._dr_on_edit)
        form.addRow("clearImagePath", self._dr_clear)

        rfl.addLayout(form)

        cond_g = QGroupBox("revealCondition")
        cg = QVBoxLayout(cond_g)
        self._dr_cond_kind = QComboBox()
        self._dr_cond_kind.addItem("Scenario 阶段", 0)
        self._dr_cond_kind.addItem("Flag条件", 1)
        self._dr_cond_kind.addItem("任务状态", 2)
        self._dr_cond_kind.addItem("JSON（高级 ConditionExpr）", 3)
        self._dr_cond_kind.addItem("表达式树（all/any/not…）", 4)
        self._dr_cond_kind.currentIndexChanged.connect(self._dr_cond_kind_changed)
        cg.addWidget(self._dr_cond_kind)

        self._dr_cond_stack = QStackedWidget()
        w0 = QWidget()
        w0l = QFormLayout(w0)
        self._dr_sc_scen = QComboBox()
        self._dr_sc_scen.setEditable(False)
        self._dr_sc_scen.currentIndexChanged.connect(self._dr_scenario_changed)
        self._dr_sc_phase = QComboBox()
        self._dr_sc_phase.setEditable(False)
        self._dr_sc_st = QComboBox()
        for s in SCENARIO_PHASE_STATUSES:
            self._dr_sc_st.addItem(s, s)
        self._dr_sc_out = QLineEdit()
        self._dr_sc_out.setPlaceholderText("可选 outcome（字符串/数字，与运行时一致）")
        for w in (self._dr_sc_phase, self._dr_sc_st):
            w.currentIndexChanged.connect(self._dr_on_edit)
        self._dr_sc_out.textChanged.connect(self._dr_on_edit)
        w0l.addRow("scenario", self._dr_sc_scen)
        w0l.addRow("phase", self._dr_sc_phase)
        w0l.addRow("status", self._dr_sc_st)
        w0l.addRow("outcome（可选）", self._dr_sc_out)

        w1 = QWidget()
        w1l = QHBoxLayout(w1)
        self._dr_fl_key = FlagKeyPickField(self._model, None, "", self)
        self._dr_fl_key.setMinimumWidth(120)
        self._dr_fl_key.valueChanged.connect(self._dr_flag_key_changed)
        self._dr_fl_op = QComboBox()
        self._dr_fl_op.addItems(["==", "!=", ">", "<", ">=", "<="])
        self._dr_fl_op.currentTextChanged.connect(self._dr_on_edit)
        self._dr_fl_val = FlagValueEdit(self, self._model.flag_registry)
        self._dr_fl_val.valueChanged.connect(self._dr_on_edit)
        w1l.addWidget(self._dr_fl_key, stretch=1)
        w1l.addWidget(self._dr_fl_op)
        w1l.addWidget(self._dr_fl_val)

        w2 = QWidget()
        w2l = QFormLayout(w2)
        self._dr_q_id = IdRefSelector(w2, allow_empty=True, editable=False)
        self._dr_q_id.setToolTip("quests.json 中的任务 id")
        self._dr_q_id.value_changed.connect(self._dr_on_edit)
        self._dr_q_st = QComboBox()
        for qs in QUEST_STATUSES:
            self._dr_q_st.addItem(qs, qs)
        self._dr_q_st.currentIndexChanged.connect(self._dr_on_edit)
        w2l.addRow("quest", self._dr_q_id)
        w2l.addRow("questStatus", self._dr_q_st)

        w3 = QWidget()
        w3l = QVBoxLayout(w3)
        self._dr_cond_json = QPlainTextEdit()
        self._dr_cond_json.setPlaceholderText('例如 {"all":[...]} 或任意 ConditionExpr JSON')
        self._dr_cond_json.setMaximumHeight(140)
        self._dr_cond_json.textChanged.connect(self._dr_on_edit)
        w3l.addWidget(self._dr_cond_json)

        w4 = QWidget()
        w4l = QVBoxLayout(w4)
        self._dr_cond_tree = ConditionExprTreeRootWidget(
            model_getter=lambda: self._model,
        )
        self._dr_cond_tree.changed.connect(self._dr_on_edit)
        w4l.addWidget(self._dr_cond_tree)

        self._dr_cond_stack.addWidget(w0)
        self._dr_cond_stack.addWidget(w1)
        self._dr_cond_stack.addWidget(w2)
        self._dr_cond_stack.addWidget(w3)
        self._dr_cond_stack.addWidget(w4)
        cg.addWidget(self._dr_cond_stack)
        rfl.addWidget(cond_g)

        anim = QFormLayout()
        self._dr_dur = QSpinBox()
        self._dr_dur.setRange(0, 600_000)
        self._dr_dur.setSingleStep(100)
        self._dr_dur.setValue(2000)
        self._dr_delay = QSpinBox()
        self._dr_delay.setRange(0, 600_000)
        self._dr_delay.setSingleStep(100)
        for sp in (self._dr_dur, self._dr_delay):
            sp.valueChanged.connect(self._dr_on_edit)
        anim.addRow("animation.durationMs", self._dr_dur)
        anim.addRow("animation.delayMs", self._dr_delay)
        rfl.addLayout(anim)

        opt = QFormLayout()
        self._dr_rflag = FlagKeyPickField(self._model, None, "", rh)
        self._dr_rflag.setToolTip("可选：揭示完成后写入的 flag（与登记表一致）")
        self._dr_rflag.valueChanged.connect(self._dr_on_edit)
        self._dr_oid = IdRefSelector(rh, allow_empty=True, editable=False)
        self._dr_oid.setToolTip("可选：overlay_images.json 中已登记的 overlayId")
        self._dr_oid.value_changed.connect(self._dr_on_edit)
        self._dr_x = QSpinBox()
        self._dr_x.setRange(0, 100)
        self._dr_x.setValue(50)
        self._dr_y = QSpinBox()
        self._dr_y.setRange(0, 100)
        self._dr_y.setValue(50)
        self._dr_w = QSpinBox()
        self._dr_w.setRange(1, 100)
        self._dr_w.setValue(40)
        for sp in (self._dr_x, self._dr_y, self._dr_w):
            sp.valueChanged.connect(self._dr_on_edit)
        opt.addRow("revealedFlag", self._dr_rflag)
        opt.addRow("overlayId", self._dr_oid)
        opt.addRow("xPercent", self._dr_x)
        opt.addRow("yPercent", self._dr_y)
        opt.addRow("widthPercent", self._dr_w)
        rfl.addLayout(opt)

        prev_g = QGroupBox("揭示过渡预览（Qt 近似，语义同 blendOverlayImage：模糊图 from → 清晰图 to）")
        prev_gl = QVBoxLayout(prev_g)
        self._dr_blend_preview = BlendOverlayPreviewWidget(
            self._model, self._dr_blend_preview_params, rh,
        )
        prev_gl.addWidget(self._dr_blend_preview)
        rfl.addWidget(prev_g)
        self._dr_blur.changed.connect(self._dr_blend_preview.schedule_refresh)
        self._dr_clear.changed.connect(self._dr_blend_preview.schedule_refresh)
        self._dr_dur.valueChanged.connect(self._dr_blend_preview.schedule_refresh)
        self._dr_delay.valueChanged.connect(self._dr_blend_preview.schedule_refresh)
        self._dr_x.valueChanged.connect(self._dr_blend_preview.schedule_refresh)
        self._dr_y.valueChanged.connect(self._dr_blend_preview.schedule_refresh)
        self._dr_w.valueChanged.connect(self._dr_blend_preview.schedule_refresh)

        exp = QGroupBox("专家：本条原始 JSON（只读对照）")
        exl = QVBoxLayout(exp)
        self._dr_json_preview = QPlainTextEdit()
        self._dr_json_preview.setReadOnly(True)
        self._dr_json_preview.setMaximumHeight(120)
        exl.addWidget(self._dr_json_preview)
        rfl.addWidget(exp)

        rfl.addStretch()
        right_scroll.setWidget(rh)
        split.addWidget(left)
        split.addWidget(right_scroll)
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        root.addWidget(split, stretch=1)

        row = QHBoxLayout()
        reload_btn = QPushButton("从内存重载")
        reload_btn.clicked.connect(self.reload_from_model)
        apply_btn = QPushButton("Apply")
        apply_btn.clicked.connect(self._apply)
        row.addWidget(reload_btn)
        row.addWidget(apply_btn)
        row.addStretch()
        root.addLayout(row)

        self.reload_from_model()

    def _dr_blend_preview_params(self) -> dict:
        """与 BlendOverlayPreviewWidget / 运行时 DocumentRevealManager 叠化参数对齐。"""
        return {
            "from_url": self._dr_blur.path(),
            "to_url": self._dr_clear.path(),
            "x_pct": float(self._dr_x.value()),
            "y_pct": float(self._dr_y.value()),
            "width_pct": float(self._dr_w.value()),
            "delay_ms": int(self._dr_delay.value()),
            "duration_ms": int(self._dr_dur.value()),
        }

    def _dr_document_id_choice_tuples(self, editing_row: int) -> list[tuple[str, str]]:
        if editing_row < 0 or editing_row >= len(self._reveals):
            return []
        cur = str(self._reveals[editing_row].get("id", "")).strip()
        used_elsewhere = {
            str(self._reveals[i].get("id", "")).strip()
            for i in range(len(self._reveals))
            if i != editing_row
        }
        used_elsewhere.discard("")
        seen: set[str] = set()
        pool: list[tuple[str, str]] = []
        for rid, name in self._model.all_archive_document_ids():
            if rid not in seen:
                seen.add(rid)
                pool.append((rid, name if name else rid))
        for rid in self._model.document_reveal_ids():
            r = str(rid).strip()
            if r and r not in seen:
                seen.add(r)
                pool.append((r, r))
        for e in self._reveals:
            r = str(e.get("id", "")).strip()
            if r and r not in seen:
                seen.add(r)
                pool.append((r, r))
        candidates: list[tuple[str, str]] = []
        if cur:
            candidates.append((cur, cur))
        for rid, name in pool:
            if rid == cur:
                continue
            if rid not in used_elsewhere:
                candidates.append((rid, name))
        return candidates

    def _dr_suggest_unique_reveal_id(self) -> str:
        used = {str(e.get("id", "")).strip() for e in self._reveals}
        used.discard("")
        arch = {t[0] for t in self._model.all_archive_document_ids()}
        disk_rev = {str(x).strip() for x in self._model.document_reveal_ids()}
        n = 1
        while True:
            c = f"新揭示_{n}"
            if c not in used and c not in arch and c not in disk_rev:
                return c
            n += 1

    def _dr_on_gen_document_id(self) -> None:
        if self._loading_ui:
            return
        row = self._dr_list.currentRow()
        if row < 0:
            return
        new_id = self._dr_suggest_unique_reveal_id()
        self._reveals[row]["id"] = new_id
        self._loading_ui = True
        try:
            self._dr_id_sel.blockSignals(True)
            self._dr_id_sel.set_items(self._dr_document_id_choice_tuples(row))
            self._dr_id_sel.set_current(new_id)
            self._dr_id_sel.blockSignals(False)
        finally:
            self._loading_ui = False
        it = self._dr_list.item(row)
        if it is not None:
            it.setText(new_id or "(无 id)")
        self._dr_on_edit()

    def _dr_overlay_choice_tuples(self) -> list[tuple[str, str]]:
        ov = getattr(self._model, "overlay_images", None) or {}
        if not isinstance(ov, dict):
            return []
        keys = sorted({str(k).strip() for k in ov if str(k).strip()}, key=lambda s: s.casefold())
        return [(k, k) for k in keys]

    def _dr_on_edit(self) -> None:
        if self._loading_ui:
            return
        self._dr_sync_row_from_ui()
        self._dr_refresh_json_preview()

    def _dr_flag_key_changed(self) -> None:
        self._dr_fl_val.set_flag_key(self._dr_fl_key.key())
        self._dr_on_edit()

    def _dr_cond_kind_changed(self, _i: int) -> None:
        k = self._dr_cond_kind.currentData()
        if isinstance(k, int):
            self._dr_cond_stack.setCurrentIndex(k)
        self._dr_on_edit()

    def _dr_scenario_changed(self, _i: int) -> None:
        if self._loading_ui:
            return
        self._dr_fill_phase_combo()
        self._dr_on_edit()

    def _dr_fill_scenario_combo(self) -> None:
        self._dr_sc_scen.blockSignals(True)
        self._dr_sc_scen.clear()
        self._dr_sc_scen.addItem("（选择）", "")
        for sid in self._model.scenario_ids_ordered():
            self._dr_sc_scen.addItem(sid, sid)
        self._dr_sc_scen.blockSignals(False)

    def _dr_fill_phase_combo(self) -> None:
        sid = self._dr_sc_scen.currentData()
        if not isinstance(sid, str):
            sid = ""
        sid = sid.strip()
        self._dr_sc_phase.blockSignals(True)
        self._dr_sc_phase.clear()
        self._dr_sc_phase.addItem("（选择）", "")
        for ph in self._model.phases_for_scenario(sid):
            self._dr_sc_phase.addItem(ph, ph)
        self._dr_sc_phase.blockSignals(False)

    def _dr_on_row_changed(self, row: int) -> None:
        if self._loading_ui:
            return
        self._dr_refresh_right()

    def reload_from_model(self) -> None:
        raw = getattr(self._model, "document_reveals", None) or []
        if not isinstance(raw, list):
            raw = []
        self._reveals = [json.loads(json.dumps(x, ensure_ascii=False))
                         for x in raw if isinstance(x, dict)]
        self._loading_ui = True
        try:
            self._dr_list.clear()
            for e in self._reveals:
                rid = str(e.get("id", "")).strip()
                self._dr_list.addItem(QListWidgetItem(rid or "(无 id)"))
            self._dr_list.setCurrentRow(0 if self._dr_list.count() else -1)
        finally:
            self._loading_ui = False
        self._dr_refresh_right()

    def _dr_refresh_right(self) -> None:
        row = self._dr_list.currentRow()
        self._dr_id_sel.setEnabled(row >= 0)
        self._dr_id_new.setEnabled(row >= 0)
        en = row >= 0
        for w in (
            self._dr_blur, self._dr_clear, self._dr_cond_kind, self._dr_cond_stack,
            self._dr_cond_tree, self._dr_dur, self._dr_delay, self._dr_rflag, self._dr_oid,
            self._dr_x, self._dr_y, self._dr_w,
            self._dr_blend_preview,
        ):
            w.setEnabled(en)
        if row < 0 or row >= len(self._reveals):
            self._dr_json_preview.clear()
            self._dr_blend_preview.schedule_refresh_immediate()
            return
        d = self._reveals[row]
        self._loading_ui = True
        try:
            self._dr_fill_scenario_combo()
            self._dr_cond_tree.set_model_refresh()
            self._dr_q_id.blockSignals(True)
            self._dr_q_id.set_items(self._model.all_quest_ids())
            self._dr_q_id.blockSignals(False)
            self._dr_id_sel.blockSignals(True)
            self._dr_id_sel.set_items(self._dr_document_id_choice_tuples(row))
            self._dr_id_sel.set_current(str(d.get("id", "")).strip())
            self._dr_id_sel.blockSignals(False)
            self._dr_blur.set_path(str(d.get("blurredImagePath", "")))
            self._dr_clear.set_path(str(d.get("clearImagePath", "")))
            anim = d.get("animation") if isinstance(d.get("animation"), dict) else {}
            self._dr_dur.setValue(int(anim.get("durationMs", 2000) or 0))
            self._dr_delay.setValue(int(anim.get("delayMs", 0) or 0))
            self._dr_rflag.blockSignals(True)
            self._dr_rflag.set_key(str(d.get("revealedFlag", "")))
            self._dr_rflag.blockSignals(False)
            self._dr_oid.blockSignals(True)
            cur_ov = str(d.get("overlayId", "")).strip()
            o_items = self._dr_overlay_choice_tuples()
            if cur_ov and cur_ov not in {t[0] for t in o_items}:
                o_items = [(cur_ov, f"{cur_ov}（数据）")] + o_items
            self._dr_oid.set_items(o_items)
            self._dr_oid.set_current(cur_ov)
            self._dr_oid.blockSignals(False)
            self._dr_x.setValue(int(d.get("xPercent", 50) or 50))
            self._dr_y.setValue(int(d.get("yPercent", 50) or 50))
            self._dr_w.setValue(int(d.get("widthPercent", 40) or 40))

            expr = d.get("revealCondition")
            kind = self._dr_infer_cond_kind(expr)
            ki = self._dr_cond_kind.findData(kind)
            self._dr_cond_kind.setCurrentIndex(ki if ki >= 0 else 0)
            self._dr_cond_stack.setCurrentIndex(kind)

            if kind == 0 and isinstance(expr, dict):
                sc = str(expr.get("scenario", "")).strip()
                idx = self._dr_sc_scen.findData(sc)
                self._dr_sc_scen.setCurrentIndex(idx if idx >= 0 else 0)
                self._dr_fill_phase_combo()
                ph = str(expr.get("phase", "")).strip()
                idx2 = self._dr_sc_phase.findData(ph)
                self._dr_sc_phase.setCurrentIndex(idx2 if idx2 >= 0 else 0)
                st = str(expr.get("status", "done"))
                idx3 = self._dr_sc_st.findData(st)
                if idx3 < 0:
                    self._dr_sc_st.addItem(f"（数据）{st}", st)
                    idx3 = self._dr_sc_st.count() - 1
                self._dr_sc_st.setCurrentIndex(idx3)
                oc = expr.get("outcome")
                if oc is None:
                    self._dr_sc_out.clear()
                elif isinstance(oc, str):
                    self._dr_sc_out.setText(oc)
                else:
                    self._dr_sc_out.setText(json.dumps(oc, ensure_ascii=False))
            elif kind == 1 and isinstance(expr, dict):
                self._dr_fl_key.blockSignals(True)
                self._dr_fl_key.set_key(str(expr.get("flag", "")))
                self._dr_fl_key.blockSignals(False)
                self._dr_fl_val.set_flag_key(self._dr_fl_key.key())
                op = str(expr.get("op", "=="))
                iop = self._dr_fl_op.findText(op)
                self._dr_fl_op.setCurrentIndex(max(0, iop))
                self._dr_fl_val.set_value(expr.get("value", True))
            elif kind == 2 and isinstance(expr, dict):
                self._dr_q_id.blockSignals(True)
                self._dr_q_id.set_items(self._model.all_quest_ids())
                self._dr_q_id.set_current(str(expr.get("quest", "")).strip())
                self._dr_q_id.blockSignals(False)
                qs = str(expr.get("questStatus", expr.get("status", "Completed")))
                iqs = self._dr_q_st.findData(qs)
                if iqs < 0:
                    iqs = self._dr_q_st.findText(qs)
                self._dr_q_st.setCurrentIndex(iqs if iqs >= 0 else 2)
            elif kind == 4 and isinstance(expr, dict):
                self._dr_cond_tree.set_expr(expr)
            else:
                try:
                    self._dr_cond_json.setPlainText(
                        json.dumps(expr, ensure_ascii=False, indent=2) if expr else "{}",
                    )
                except (TypeError, ValueError):
                    self._dr_cond_json.setPlainText(str(expr))

            try:
                self._dr_json_preview.setPlainText(
                    json.dumps(d, ensure_ascii=False, indent=2),
                )
            except (TypeError, ValueError):
                self._dr_json_preview.setPlainText("(无法序列化)")
        finally:
            self._loading_ui = False
            self._dr_blend_preview.schedule_refresh_immediate()

    @staticmethod
    def _dr_infer_cond_kind(expr: object) -> int:
        if not isinstance(expr, dict):
            return 3
        if "all" in expr or "any" in expr or "not" in expr:
            return 4
        if isinstance(expr.get("scenario"), str) and str(expr.get("scenario")).strip():
            return 0
        if expr.get("flag") is not None and str(expr.get("flag", "")).strip() != "":
            return 1
        if isinstance(expr.get("quest"), str) and str(expr.get("quest")).strip():
            return 2
        return 3

    def _dr_refresh_json_preview(self) -> None:
        row = self._dr_list.currentRow()
        if row < 0 or row >= len(self._reveals):
            return
        self._dr_sync_row_from_ui()
        try:
            self._dr_json_preview.setPlainText(
                json.dumps(self._reveals[row], ensure_ascii=False, indent=2),
            )
        except (TypeError, ValueError):
            self._dr_json_preview.setPlainText("(无法序列化)")

    def _dr_sync_row_from_ui(self) -> None:
        row = self._dr_list.currentRow()
        if row < 0 or row >= len(self._reveals):
            return
        d = self._reveals[row]
        d["id"] = self._dr_id_sel.current_id().strip()
        d["blurredImagePath"] = self._dr_blur.path()
        d["clearImagePath"] = self._dr_clear.path()
        d["animation"] = {
            "durationMs": int(self._dr_dur.value()),
            "delayMs": int(self._dr_delay.value()),
        }
        rf = self._dr_rflag.key().strip()
        if rf:
            d["revealedFlag"] = rf
        elif "revealedFlag" in d:
            del d["revealedFlag"]
        oid = self._dr_oid.current_id().strip()
        if oid:
            d["overlayId"] = oid
        elif "overlayId" in d:
            del d["overlayId"]
        d["xPercent"] = int(self._dr_x.value())
        d["yPercent"] = int(self._dr_y.value())
        d["widthPercent"] = int(self._dr_w.value())

        kind = self._dr_cond_kind.currentData()
        if not isinstance(kind, int):
            kind = 0
        if kind == 0:
            sc = self._dr_sc_scen.currentData()
            if not isinstance(sc, str):
                sc = ""
            sc = sc.strip()
            phd = self._dr_sc_phase.currentData()
            ph = phd.strip() if isinstance(phd, str) else ""
            st_d = self._dr_sc_st.currentData()
            st = str(st_d) if st_d is not None else self._dr_sc_st.currentText()
            cond = {"scenario": sc, "phase": ph, "status": st}
            ot = self._dr_sc_out.text().strip()
            if ot:
                try:
                    cond["outcome"] = json.loads(ot)
                except json.JSONDecodeError:
                    if ot.lower() in ("true", "false"):
                        cond["outcome"] = ot.lower() == "true"
                    else:
                        try:
                            cond["outcome"] = int(ot)
                        except ValueError:
                            cond["outcome"] = ot
            d["revealCondition"] = cond
        elif kind == 1:
            fk = self._dr_fl_key.key().strip()
            if fk:
                out: dict = {"flag": fk}
                op = self._dr_fl_op.currentText()
                if op != "==":
                    out["op"] = op
                v = self._dr_fl_val.get_value()
                if not (op == "==" and v is True):
                    out["value"] = v
                d["revealCondition"] = out
            else:
                d["revealCondition"] = {"flag": "", "op": "==", "value": True}
        elif kind == 2:
            qid = self._dr_q_id.current_id().strip()
            qs = self._dr_q_st.currentData()
            if not isinstance(qs, str):
                qs = self._dr_q_st.currentText()
            d["revealCondition"] = {"quest": qid, "questStatus": qs}
        elif kind == 3:
            raw = self._dr_cond_json.toPlainText().strip()
            if not raw:
                d["revealCondition"] = {}
            else:
                try:
                    d["revealCondition"] = json.loads(raw)
                except json.JSONDecodeError:
                    pass
        elif kind == 4:
            te = self._dr_cond_tree.get_expr()
            d["revealCondition"] = te if te is not None else {"all": []}
        else:
            d["revealCondition"] = {}

        it = self._dr_list.item(row)
        if it is not None:
            it.setText(d.get("id") or "(无 id)")

    def _dr_add(self) -> None:
        self._dr_sync_row_from_ui()
        first = ""
        ids = self._model.scenario_ids_ordered()
        if ids:
            first = ids[0]
        phases = self._model.phases_for_scenario(first)
        ph0 = phases[0] if phases else ""
        new_id = self._dr_suggest_unique_reveal_id()
        new_e = {
            "id": new_id,
            "blurredImagePath": "",
            "clearImagePath": "",
            "revealCondition": {
                "scenario": first,
                "phase": ph0,
                "status": "done",
            },
            "animation": {"durationMs": 2000, "delayMs": 0},
        }
        self._reveals.append(new_e)
        self._loading_ui = True
        try:
            self._dr_list.addItem(QListWidgetItem(new_e["id"]))
            self._dr_list.setCurrentRow(self._dr_list.count() - 1)
        finally:
            self._loading_ui = False
        self._dr_refresh_right()

    def _dr_del(self) -> None:
        row = self._dr_list.currentRow()
        if row < 0:
            return
        self._reveals.pop(row)
        self._loading_ui = True
        try:
            self._dr_list.takeItem(row)
            self._dr_list.setCurrentRow(min(row, self._dr_list.count() - 1))
        finally:
            self._loading_ui = False
        self._dr_refresh_right()

    def _dr_validate(self) -> str | None:
        seen: set[str] = set()
        for i, e in enumerate(self._reveals):
            rid = str(e.get("id", "")).strip()
            if not rid:
                return f"第 {i + 1} 条 id 不能为空"
            if rid in seen:
                return f"document id 重复：{rid!r}"
            seen.add(rid)
            if not str(e.get("blurredImagePath", "")).strip():
                return f"{rid!r}：blurredImagePath 不能为空"
            if not str(e.get("clearImagePath", "")).strip():
                return f"{rid!r}：clearImagePath 不能为空"
            rc = e.get("revealCondition")
            if rc is None:
                return f"{rid!r}：缺少 revealCondition"
            if not isinstance(rc, dict):
                return f"{rid!r}：revealCondition 须为 JSON 对象（高级模式请检查语法）"
            if isinstance(rc.get("scenario"), str):
                sid = rc.get("scenario", "").strip()
                ph = str(rc.get("phase", "")).strip()
                if sid and ph:
                    valid_ph = set(self._model.phases_for_scenario(sid))
                    if valid_ph and ph not in valid_ph:
                        return f"{rid!r}：phase {ph!r} 不在 scenario {sid!r} 的清单中"
        return None

    def _apply(self) -> None:
        self._dr_sync_row_from_ui()
        err = self._dr_validate()
        if err:
            QMessageBox.warning(self, "document_reveals.json", err)
            return
        try:
            payload = json.loads(json.dumps(self._reveals, ensure_ascii=False))
        except (TypeError, ValueError) as e:
            QMessageBox.warning(self, "document_reveals.json", str(e))
            return
        self._model.document_reveals = payload
        self._model.mark_dirty("document_reveals")

    def flush_to_model(self) -> None:
        self._dr_sync_row_from_ui()
        err = self._dr_validate()
        if err:
            raise ValueError(f"document_reveals.json：{err}")
        self._model.document_reveals = json.loads(json.dumps(self._reveals, ensure_ascii=False))
        self._model.mark_dirty("document_reveals")
