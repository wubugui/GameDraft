"""叙事清单 JSON：scenarios.json、document_reveals.json（主编辑器内嵌）。"""
from __future__ import annotations

import json

from PySide6.QtCore import Qt
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

from ..project_model import ProjectModel
from ..shared.flag_key_field import FlagKeyPickField
from ..shared.flag_value_edit import FlagValueEdit
from ..shared.image_path_picker import CutsceneImagePathRow
from ..shared.blend_overlay_preview import BlendOverlayPreviewWidget
from ..shared.condition_expr_tree import ConditionExprTreeRootWidget

# 与叙事文档、运行时 string 比较一致；策划仅允许选这些（勿手写大小写变体）
SCENARIO_PHASE_STATUSES: tuple[str, ...] = ("pending", "active", "done", "locked")
QUEST_STATUSES: tuple[str, ...] = ("Inactive", "Active", "Completed")


class ScenariosCatalogEditor(QWidget):
    """结构化编辑 public/assets/data/scenarios.json（内存：ProjectModel.scenarios_catalog）。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._loading_ui = False

        root = QVBoxLayout(self)
        tip = QLabel(
            "按规范填写 scenario / phase / status（status 仅允许四种枚举）。"
            "修改后点 Apply 写入内存；保存工程（Ctrl+S）写入 data/scenarios.json。"
            "图对话里的 setScenarioPhase、scenario 条件须与本页 id、phase 名、status 一致。",
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
        self._f_id = QLineEdit()
        self._f_id.setPlaceholderText("scenarioId，与图内 setScenarioPhase.scenarioId 一致")
        self._f_desc = QLineEdit()
        self._f_desc.setPlaceholderText("描述（可选）")
        self._f_requires = QLineEdit()
        self._f_requires.setPlaceholderText(
            "进线门槛（可选）：整条 scenario 开始前须已为 done 的 phase，逗号分隔；"
            "单 phase 依赖请用下表「requires」列",
        )
        self._f_expose_after = QComboBox()
        self._f_expose_after.setEditable(False)
        self._f_expose_after.setToolTip(
            "当该 phase 被设为 status=done 时，将 exposes 中的 flag 写入全局（与运行时 ScenarioStateManager 一致）",
        )
        for w in (self._f_id, self._f_desc, self._f_requires):
            w.textChanged.connect(self._on_detail_edited)
        self._f_expose_after.currentIndexChanged.connect(self._on_detail_edited)
        form.addRow("id", self._f_id)
        form.addRow("description", self._f_desc)
        form.addRow("scenario 进线 requires", self._f_requires)
        form.addRow("exposeAfterPhase", self._f_expose_after)
        rfl.addLayout(form)

        exp_g = QGroupBox("exposes（完成 exposeAfterPhase 后写入的 flag）")
        exp_l = QVBoxLayout(exp_g)
        self._tbl_exposes = QTableWidget(0, 2)
        self._tbl_exposes.setHorizontalHeaderLabels(["flag 键名", "置为 true"])
        self._tbl_exposes.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self._tbl_exposes.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.ResizeToContents)
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
        self._tbl_phases.setMinimumHeight(160)
        self._tbl_phases.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        ph_l.addWidget(self._tbl_phases)
        pr = QHBoxLayout()
        pb_a = QPushButton("添加阶段")
        pb_a.clicked.connect(self._phases_add_row)
        pb_d = QPushButton("删除所选阶段")
        pb_d.clicked.connect(self._phases_del_row)
        pr.addWidget(pb_a)
        pr.addWidget(pb_d)
        pr.addStretch()
        ph_l.addLayout(pr)
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
            self._f_id.setText(str(d.get("id", "")))
            self._f_desc.setText(str(d.get("description", "")))
            req = d.get("requires")
            if isinstance(req, list):
                self._f_requires.setText(", ".join(str(x).strip() for x in req if str(x).strip()))
            else:
                self._f_requires.setText("")

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
        self._f_id.clear()
        self._f_desc.clear()
        self._f_requires.clear()
        self._f_expose_after.clear()
        self._f_expose_after.addItem("（不配置）", "")
        self._tbl_exposes.setRowCount(0)
        self._tbl_phases.setRowCount(0)

    def _fill_exposes_table(self, exposes: dict) -> None:
        self._tbl_exposes.setRowCount(0)
        for k, v in exposes.items():
            if not str(k).strip():
                continue
            r = self._tbl_exposes.rowCount()
            self._tbl_exposes.insertRow(r)
            ke = QLineEdit(str(k))
            ke.textChanged.connect(self._on_detail_edited)
            self._tbl_exposes.setCellWidget(r, 0, ke)
            cb = QComboBox()
            cb.addItem("true", True)
            cb.addItem("false", False)
            cb.setCurrentIndex(0 if v else 1)
            cb.currentIndexChanged.connect(self._on_detail_edited)
            self._tbl_exposes.setCellWidget(r, 1, cb)

    def _fill_phases_table(self, phases: dict) -> None:
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
            re = QLineEdit(", ".join(req_parts))
            re.setPlaceholderText("依赖的 phase，逗号分隔")
            re.textChanged.connect(self._on_phases_or_exposes_structure_changed)
            self._tbl_phases.setCellWidget(r, 2, re)

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

        sid = self._f_id.text().strip()
        d["id"] = sid
        desc = self._f_desc.text().strip()
        if desc:
            d["description"] = desc
        elif "description" in d:
            del d["description"]

        req_text = self._f_requires.text().strip()
        if req_text:
            d["requires"] = [x.strip() for x in req_text.split(",") if x.strip()]
        elif "requires" in d:
            del d["requires"]

        eat = self._f_expose_after.currentData()
        if isinstance(eat, str) and eat.strip():
            d["exposeAfterPhase"] = eat.strip()
        elif "exposeAfterPhase" in d:
            del d["exposeAfterPhase"]

        exposes: dict[str, bool] = {}
        for r in range(self._tbl_exposes.rowCount()):
            kw = self._tbl_exposes.cellWidget(r, 0)
            cw = self._tbl_exposes.cellWidget(r, 1)
            if not isinstance(kw, QLineEdit):
                continue
            key = kw.text().strip()
            if not key:
                continue
            val = True
            if isinstance(cw, QComboBox):
                v = cw.currentData()
                val = bool(v)
            exposes[key] = val
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
            if isinstance(rw, QLineEdit):
                req_text = rw.text().strip()
                if req_text:
                    entry["requires"] = [x.strip() for x in req_text.split(",") if x.strip()]
            phases[name] = entry
        d["phases"] = phases

        item = self._sc_list.item(row)
        if item is not None:
            item.setText(sid or "(无 id)")

    def _add_scenario(self) -> None:
        self._sync_current_row_from_ui()
        new_id = f"新scenario_{len(self._scenarios_data) + 1}"
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
        ke = QLineEdit()
        ke.setPlaceholderText("flag键名")
        ke.textChanged.connect(self._on_detail_edited)
        self._tbl_exposes.setCellWidget(r, 0, ke)
        cb = QComboBox()
        cb.addItem("true", True)
        cb.addItem("false", False)
        cb.currentIndexChanged.connect(self._on_detail_edited)
        self._tbl_exposes.setCellWidget(r, 1, cb)

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
        re = QLineEdit()
        re.setPlaceholderText("requires，逗号分隔")
        re.textChanged.connect(self._on_phases_or_exposes_structure_changed)
        self._tbl_phases.setCellWidget(r, 2, re)

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
            "按条目编辑文档揭示；revealCondition 支持 Scenario / flag / 任务 或 JSON（ConditionExpr）。"
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
        self._dr_id = QLineEdit(rh)
        self._dr_id.setPlaceholderText("documentId，与 revealDocument 参数一致")
        self._dr_id.textChanged.connect(self._dr_on_edit)
        form.addRow("id", self._dr_id)

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
        self._dr_q_id = QLineEdit()
        self._dr_q_id.setPlaceholderText("quest id（quests.json）")
        self._dr_q_id.textChanged.connect(self._dr_on_edit)
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
        self._dr_rflag = QLineEdit()
        self._dr_rflag.setPlaceholderText("可选 revealedFlag")
        self._dr_oid = QLineEdit()
        self._dr_oid.setPlaceholderText("可选 overlayId")
        self._dr_x = QSpinBox()
        self._dr_x.setRange(0, 100)
        self._dr_x.setValue(50)
        self._dr_y = QSpinBox()
        self._dr_y.setRange(0, 100)
        self._dr_y.setValue(50)
        self._dr_w = QSpinBox()
        self._dr_w.setRange(1, 100)
        self._dr_w.setValue(40)
        for w in (self._dr_rflag, self._dr_oid):
            w.textChanged.connect(self._dr_on_edit)
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
        self._dr_id.setEnabled(row >= 0)
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
            self._dr_id.setText(str(d.get("id", "")))
            self._dr_blur.set_path(str(d.get("blurredImagePath", "")))
            self._dr_clear.set_path(str(d.get("clearImagePath", "")))
            anim = d.get("animation") if isinstance(d.get("animation"), dict) else {}
            self._dr_dur.setValue(int(anim.get("durationMs", 2000) or 0))
            self._dr_delay.setValue(int(anim.get("delayMs", 0) or 0))
            self._dr_rflag.setText(str(d.get("revealedFlag", "")))
            self._dr_oid.setText(str(d.get("overlayId", "")))
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
                self._dr_q_id.setText(str(expr.get("quest", "")))
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
        d["id"] = self._dr_id.text().strip()
        d["blurredImagePath"] = self._dr_blur.path()
        d["clearImagePath"] = self._dr_clear.path()
        d["animation"] = {
            "durationMs": int(self._dr_dur.value()),
            "delayMs": int(self._dr_delay.value()),
        }
        rf = self._dr_rflag.text().strip()
        if rf:
            d["revealedFlag"] = rf
        elif "revealedFlag" in d:
            del d["revealedFlag"]
        oid = self._dr_oid.text().strip()
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
            qid = self._dr_q_id.text().strip()
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
        n = len(self._reveals) + 1
        first = ""
        ids = self._model.scenario_ids_ordered()
        if ids:
            first = ids[0]
        phases = self._model.phases_for_scenario(first)
        ph0 = phases[0] if phases else ""
        new_e = {
            "id": f"新揭示_{n}",
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
