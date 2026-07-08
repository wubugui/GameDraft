"""叙事清单 JSON：scenarios.json、document_reveals.json（主编辑器内嵌）。"""
from __future__ import annotations

import json
from collections.abc import Callable

from PySide6.QtCore import Qt, QEvent, QObject, QItemSelectionModel
from PySide6.QtGui import QKeySequence, QMouseEvent, QShortcut
from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QLabel,
    QDialog,
    QDialogButtonBox,
    QPlainTextEdit,
    QPushButton,
    QMessageBox,
    QListWidget,
    QListWidgetItem,
    QMenu,
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
    QCheckBox,
)

from ..project_model import ProjectModel
from ..scenarios_catalog_validate import validate_scenarios_list
from ..shared import confirm
from ..shared.collapsible_section import CollapsibleSection
from ..shared.form_layout import compact_form
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


class ScenarioRequiresExprEdit(QWidget):
    """requires：与(数组)/或({any})/JSON含非与嵌套；叶子为 phase 名（语义为该 phase 已为 done）。"""

    MODE_AND = "and"
    MODE_OR = "or"
    MODE_JSON = "json"

    def __init__(
        self,
        parent: QWidget | None,
        on_change: Callable[[], None],
        *,
        phase_table: QTableWidget | None,
        scenario_choices: Callable[[], list[str]] | None,
    ) -> None:
        super().__init__(parent)
        if bool(phase_table) == bool(scenario_choices):
            raise ValueError("须指定 phase_table 或 scenario_choices 之一")
        self._on_change = on_change
        self._phase_table = phase_table
        self._scenario_choices = scenario_choices
        self._json_doc = ""

        outer = QHBoxLayout(self)
        outer.setContentsMargins(2, 2, 2, 2)
        self._mode_cb = QComboBox()
        self._mode_cb.addItem("与", self.MODE_AND)
        self._mode_cb.addItem("或", self.MODE_OR)
        self._mode_cb.addItem("JSON", self.MODE_JSON)
        self._mode_cb.setMaximumWidth(88)
        self._mode_cb.setToolTip("与=数组；或={\"any\":[...]}；JSON=含非/嵌套")
        self._mode_cb.currentIndexChanged.connect(self._on_mode_index)
        outer.addWidget(self._mode_cb)

        self._stack = QStackedWidget()
        list_w = QWidget()
        hl = QHBoxLayout(list_w)
        hl.setContentsMargins(0, 0, 0, 0)
        self._line = QLineEdit()
        self._line.setReadOnly(True)
        self._line.setPlaceholderText("点「选择…」勾选 phase")
        self._btn_clear = QPushButton("清空")
        self._btn_clear.setFixedWidth(44)
        self._btn_clear.setToolTip("清除与/或列表")
        self._btn = QPushButton("选择…")
        self._btn.setFixedWidth(72)
        hl.addWidget(self._line, stretch=1)
        hl.addWidget(self._btn_clear)
        hl.addWidget(self._btn)
        self._stack.addWidget(list_w)

        json_w = QWidget()
        jh = QHBoxLayout(json_w)
        jh.setContentsMargins(0, 0, 0, 0)
        self._json_line = QLineEdit()
        self._json_line.setReadOnly(True)
        self._json_line.setPlaceholderText("点「编辑…」写 JSON")
        self._json_btn = QPushButton("编辑…")
        self._json_btn.setFixedWidth(52)
        self._json_btn.setToolTip("在弹出窗口中编辑 requires 表达式 JSON")
        self._json_btn.clicked.connect(self._open_json_dialog)
        jh.addWidget(self._json_line, stretch=1)
        jh.addWidget(self._json_btn)
        self._stack.addWidget(json_w)

        outer.addWidget(self._stack, stretch=1)

        self._btn_clear.clicked.connect(self._clear_list)
        self._btn.clicked.connect(self._pick)

    @classmethod
    def for_phase_row(
        cls,
        parent: QWidget | None,
        on_change: Callable[[], None],
        table: QTableWidget,
    ) -> ScenarioRequiresExprEdit:
        return cls(parent, on_change, phase_table=table, scenario_choices=None)

    @classmethod
    def for_scenario_entry(
        cls,
        parent: QWidget | None,
        on_change: Callable[[], None],
        get_choices: Callable[[], list[str]],
    ) -> ScenarioRequiresExprEdit:
        return cls(parent, on_change, phase_table=None, scenario_choices=get_choices)

    def _resolve_row(self) -> int:
        if self._phase_table is None:
            return -1
        for r in range(self._phase_table.rowCount()):
            if self._phase_table.cellWidget(r, 2) is self:
                return r
        return -1

    def _choice_names(self) -> list[str]:
        ex = ""
        if self._phase_table is not None:
            r = self._resolve_row()
            if r >= 0:
                w0 = self._phase_table.cellWidget(r, 0)
                if isinstance(w0, QLineEdit):
                    ex = w0.text().strip()
            ordered: list[str] = []
            seen: set[str] = set()
            for rr in range(self._phase_table.rowCount()):
                w0 = self._phase_table.cellWidget(rr, 0)
                if not isinstance(w0, QLineEdit):
                    continue
                t = w0.text().strip()
                if not t or t == ex or t in seen:
                    continue
                seen.add(t)
                ordered.append(t)
            return ordered
        raw = self._scenario_choices() if self._scenario_choices else []
        return [str(x).strip() for x in raw if str(x).strip()]

    def _on_mode_index(self, _i: int) -> None:
        mode = self._mode_cb.currentData()
        self._stack.setCurrentIndex(1 if mode == self.MODE_JSON else 0)
        self._on_change()

    def _clear_list(self) -> None:
        self._line.clear()
        self._on_change()

    def _refresh_json_line_preview(self) -> None:
        s = self._json_doc.strip()
        if not s:
            self._json_line.clear()
            self._json_line.setPlaceholderText("点「编辑…」写 JSON")
            return
        one = " ".join(s.split())
        if len(one) > 72:
            one = one[:69] + "…"
        self._json_line.setText(one)

    def _open_json_dialog(self) -> None:
        dlg = QDialog(self)
        dlg.setWindowTitle("requires JSON")
        dlg.resize(520, 320)
        root = QVBoxLayout(dlg)
        tip = QLabel("requires 表达式 JSON")
        tip.setWordWrap(True)
        root.addWidget(tip)
        te = QPlainTextEdit()
        te.setPlaceholderText(
            "对象仅允许单键 all / any / not；叶子为 phase 名字符串（语义为该 phase 已为 done）。",
        )
        te.setToolTip(
            "对象仅允许单键 all / any / not；叶子为 phase 名字符串（语义为该 phase 已为 done）。",
        )
        te.setPlainText(self._json_doc)
        root.addWidget(te)
        bb = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
        )
        bb.accepted.connect(dlg.accept)
        bb.rejected.connect(dlg.reject)
        root.addWidget(bb)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        self._json_doc = te.toPlainText()
        self._refresh_json_line_preview()
        self._on_change()

    def _pick(self) -> None:
        mode = self._mode_cb.currentData()
        if mode == self.MODE_JSON:
            return
        ordered = self._choice_names()
        if not ordered:
            QMessageBox.information(
                self, "requires",
                "没有可选 phase：请先在 phases 表中添加阶段并填写名称。",
            )
            return
        cur = [x.strip() for x in self._line.text().split(",") if x.strip()]
        label = (
            "勾选：这些 phase 须全部为 done（与）。"
            if mode == self.MODE_AND
            else "勾选：至少一个 phase 为 done 即可（或）。"
        )
        picked = pick_strings_multi(
            self,
            "选择 requires 中的 phase",
            ordered,
            cur,
            label=label,
            sort_choices=False,
        )
        if picked is None:
            return
        self._line.setText(", ".join(picked))
        self._on_change()

    def set_requires_value(self, raw: object | None) -> None:
        self._mode_cb.blockSignals(True)
        try:
            self._line.clear()
            self._json_doc = ""
            if raw is None:
                self._mode_cb.setCurrentIndex(0)
            elif isinstance(raw, list):
                self._mode_cb.setCurrentIndex(0)
                self._line.setText(
                    ", ".join(str(x).strip() for x in raw if str(x).strip()),
                )
            elif isinstance(raw, dict):
                keys = set(raw.keys())
                if keys == {"all"} and isinstance(raw.get("all"), list):
                    al = raw["all"]
                    if all(isinstance(x, str) for x in al):
                        self._mode_cb.setCurrentIndex(0)
                        self._line.setText(
                            ", ".join(str(x).strip() for x in al if str(x).strip()),
                        )
                    else:
                        self._mode_cb.setCurrentIndex(
                            self._mode_cb.findData(self.MODE_JSON),
                        )
                        self._json_doc = json.dumps(raw, ensure_ascii=False, indent=2)
                elif keys == {"any"} and isinstance(raw.get("any"), list):
                    al = raw["any"]
                    if all(isinstance(x, str) for x in al):
                        self._mode_cb.setCurrentIndex(1)
                        self._line.setText(
                            ", ".join(str(x).strip() for x in al if str(x).strip()),
                        )
                    else:
                        self._mode_cb.setCurrentIndex(
                            self._mode_cb.findData(self.MODE_JSON),
                        )
                        self._json_doc = json.dumps(raw, ensure_ascii=False, indent=2)
                else:
                    self._mode_cb.setCurrentIndex(
                        self._mode_cb.findData(self.MODE_JSON),
                    )
                    self._json_doc = json.dumps(raw, ensure_ascii=False, indent=2)
            else:
                self._mode_cb.setCurrentIndex(self._mode_cb.findData(self.MODE_JSON))
                self._json_doc = json.dumps(raw, ensure_ascii=False, indent=2)
        finally:
            self._mode_cb.blockSignals(False)
        mode = self._mode_cb.currentData()
        self._stack.setCurrentIndex(1 if mode == self.MODE_JSON else 0)
        self._refresh_json_line_preview()

    def get_requires_value(self) -> object | None:
        mode = self._mode_cb.currentData()
        if mode == self.MODE_JSON:
            text = self._json_doc.strip()
            if not text:
                return None
            try:
                return json.loads(text)
            except json.JSONDecodeError as e:
                raise ValueError(f"requires JSON 无法解析：{e}") from e
        parts = [x.strip() for x in self._line.text().split(",") if x.strip()]
        if not parts:
            return None
        if mode == self.MODE_AND:
            return parts
        return {"any": parts}


class ScenariosCatalogEditor(QWidget):
    """结构化编辑 public/assets/data/scenarios.json（内存：ProjectModel.scenarios_catalog）。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._loading_ui = False

        root = QVBoxLayout(self)
        tip = QLabel("scenarios.json：scenarioId / exposes flag 须从清单选择；requires 叶子为 phase 名（须已 done）。")
        tip.setWordWrap(True)
        tip.setToolTip(
            "与/或可用表单多选；含非或嵌套请用 JSON 模式。"
            "phase 名称与 description 可手写。status 仅四种枚举。Apply 写入内存；保存工程写入 data/scenarios.json。"
            "图对话 setScenarioPhase、scenario 条件须与本页一致。"
            "若勾选整条线手动生命周期，须在游戏中用 activateScenario / completeScenario 包住 phase 推进。"
        )
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

        form = compact_form(QFormLayout())
        self._f_id_row = QWidget()
        _idl = QHBoxLayout(self._f_id_row)
        _idl.setContentsMargins(0, 0, 0, 0)
        self._f_id_sel = IdRefSelector(
            self._f_id_row, allow_empty=True, editable=True,
        )
        self._f_id_sel.setToolTip(
            "须与图内 setScenarioPhase.scenarioId、条件里的 scenario 一致；"
            "可从下拉选常见 id，也可在框内直接输入自定义 id；"
            "空 id 或与另一条重复时，Apply/保存工程会校验失败。",
        )
        self._f_id_sel.value_changed.connect(self._on_detail_edited)
        self._f_id_sel.editTextChanged.connect(self._on_detail_edited)
        _id_le = self._f_id_sel.lineEdit()
        if _id_le is not None:
            _id_le.setPlaceholderText("手输或从下拉选择…")
        self._f_id_new = QPushButton("生成唯一 id")
        self._f_id_new.setToolTip(
            "分配未占用的 scenarioId；生成后仍可在左侧框内改为任意自定义 id。",
        )
        self._f_id_new.clicked.connect(self._on_gen_scenario_id)
        _idl.addWidget(self._f_id_sel, stretch=1)
        _idl.addWidget(self._f_id_new)
        self._f_manual_line = QCheckBox(
            "整条线手动激活 / 完成（activateScenario … completeScenario）",
        )
        self._f_manual_line.setToolTip(
            "勾选后：须先在同一存档内执行 activateScenario（校验进线 requires）才能 setScenarioPhase，"
            "completeScenario 之后禁止再改 phase；可由任意图或任务等在运行时先后触发，编辑器不做跨图静态顺序校验。",
        )
        self._f_manual_line.stateChanged.connect(self._on_detail_edited)
        self._f_desc = QLineEdit()
        self._f_desc.setPlaceholderText("描述（可选，仅说明文案可手写）")
        self._f_requires_edit = ScenarioRequiresExprEdit.for_scenario_entry(
            self,
            self._on_detail_edited,
            lambda: self._phase_names_from_phases_table(),
        )
        self._f_requires_edit.setToolTip(
            "进线条件：与=数组；或={\"any\":[...]}；非/嵌套用 JSON。",
        )
        self._f_expose_after = QComboBox()
        self._f_expose_after.setEditable(False)
        self._f_expose_after.setToolTip(
            "当该 phase 被设为 status=done 时，将 exposes 中的键值写入全局 FlagStore；"
            "值的类型须与 flag_registry 中该键的 valueType 一致（bool / 数值 / 字符串）。",
        )
        self._f_desc.textChanged.connect(self._on_detail_edited)
        self._f_expose_after.currentIndexChanged.connect(self._on_detail_edited)
        form.addRow("id", self._f_id_row)
        form.addRow("manualLineLifecycle", self._f_manual_line)
        form.addRow("description", self._f_desc)
        form.addRow("scenario 进线 requires", self._f_requires_edit)
        form.addRow("exposeAfterPhase", self._f_expose_after)
        rfl.addLayout(form)

        dg_g = QGroupBox("关联图对话（dialogueGraphIds）")
        dg_g.setToolTip(
            "与归属本 scenario 的图一致，由图 JSON 的 meta.scenarioId 与工程内同步逻辑维护；"
            "只读；双击列表项打开「图对话」页。",
        )
        dg_l = QVBoxLayout(dg_g)
        self._lw_linked_graphs = QListWidget()
        self._lw_linked_graphs.setMinimumHeight(70)
        self._lw_linked_graphs.setSelectionMode(
            QAbstractItemView.SelectionMode.SingleSelection,
        )
        self._lw_linked_graphs.itemDoubleClicked.connect(
            self._on_linked_graph_double_clicked,
        )
        dg_l.addWidget(self._lw_linked_graphs)
        rfl.addWidget(dg_g)

        exp_g = QGroupBox("exposes（完成 exposeAfterPhase 后写入的 flag 与值）")
        exp_l = QVBoxLayout(exp_g)
        self._tbl_exposes = QTableWidget(0, 2)
        self._tbl_exposes.setHorizontalHeaderLabels(["flag 键名", "写入值（随登记表类型）"])
        self._tbl_exposes.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self._tbl_exposes.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.Stretch)
        self._tbl_exposes.setMinimumHeight(120)
        self._tbl_exposes.setToolTip("选中行后按 Delete、右键菜单或点「删除所选行」删除。")
        self._tbl_exposes.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._tbl_exposes.customContextMenuRequested.connect(self._exposes_context_menu)
        _exp_del_sc = QShortcut(QKeySequence(Qt.Key.Key_Delete), self._tbl_exposes)
        _exp_del_sc.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        _exp_del_sc.activated.connect(self._exposes_del_row)
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
            "phases（阶段清单；requires=与/或/JSON，叶子为 phase 名=须已为 done）",
        )
        ph_l = QVBoxLayout(ph_g)
        self._tbl_phases = QTableWidget(0, 3)
        self._tbl_phases.setHorizontalHeaderLabels(["phase 名", "清单默认 status", "requires"])
        _status_hdr = self._tbl_phases.horizontalHeaderItem(1)
        if _status_hdr is not None:
            _status_hdr.setToolTip(
                "仅作清单展示/文档默认值：运行时不会用它播种初始状态——任一 phase 在被 "
                "setScenarioPhase 写入前，条件求值一律视为 pending。设成 active/done 不会让该线"
                "开局就处于该状态；初始推进请用动作 setScenarioPhase。",
            )
        _ph_h = self._tbl_phases.horizontalHeader()
        _ph_h.setSectionResizeMode(0, QHeaderView.ResizeMode.Interactive)
        _ph_h.resizeSection(0, 92)
        _ph_h.setMinimumSectionSize(56)
        _ph_h.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        _ph_h.setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        self._tbl_phases.setMinimumHeight(200)
        self._tbl_phases.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._tbl_phases.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        vh = self._tbl_phases.verticalHeader()
        vh.setSectionsMovable(True)
        vh.setMinimumWidth(28)
        vh.setMinimumSectionSize(34)
        vh.sectionMoved.connect(self._on_phases_section_moved)
        self._tbl_phases.setToolTip(
            "在单元格内点击也会选中该行（Ctrl 加选、Shift 范围选）；拖曳左侧行号可调整顺序；"
            "选中后按 Delete、右键菜单或点「删除所选阶段」删除。",
        )
        ph_hint = QLabel("提示：拖行号排序，Delete / 右键删除（详见悬停提示）")
        ph_hint.setWordWrap(True)
        ph_hint.setStyleSheet("color: #666; font-size: 12px;")
        ph_l.addWidget(self._tbl_phases)
        _ph_del_sc = QShortcut(QKeySequence(Qt.Key.Key_Delete), self._tbl_phases)
        _ph_del_sc.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        _ph_del_sc.activated.connect(self._phases_del_row)
        self._tbl_phases.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._tbl_phases.customContextMenuRequested.connect(self._phases_context_menu)
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
        self._scenarios_reload_deferred: bool = False
        self._flush_error: str | None = None
        self._model.data_changed.connect(self._on_project_data_changed)
        self.reload_from_model()

    def select_scenario_by_id(self, scenario_id: str) -> None:
        sid = (scenario_id or "").strip()
        if not sid:
            return
        for i, e in enumerate(self._scenarios_data):
            if str(e.get("id", "")).strip() == sid:
                self._sc_list.setCurrentRow(i)
                return
        QMessageBox.information(self, "Scenarios", f"未找到 scenario：{sid}")

    def _on_project_data_changed(self, data_type: str, _item_id: str) -> None:
        if data_type != "scenarios":
            return
        if self._loading_ui:
            return
        if not self.isVisible():
            self._scenarios_reload_deferred = True
            return
        self._scenarios_reload_deferred = False
        self._reload_scenarios_keep_selection()

    def _reload_scenarios_keep_selection(self) -> None:
        cur_sid = ""
        row = self._sc_list.currentRow()
        if 0 <= row < len(self._scenarios_data):
            cur_sid = str(self._scenarios_data[row].get("id", "")).strip()
        self.reload_from_model()
        if cur_sid:
            self.select_scenario_by_id(cur_sid)

    def showEvent(self, event) -> None:  # type: ignore[override]
        super().showEvent(event)
        if self._scenarios_reload_deferred and not self._loading_ui:
            self._scenarios_reload_deferred = False
            self._reload_scenarios_keep_selection()

    def _on_linked_graph_double_clicked(self, item: QListWidgetItem) -> None:
        gid = (item.data(Qt.ItemDataRole.UserRole) or item.text() or "").strip()
        if not gid:
            return
        w = self.window()
        fn = getattr(w, "navigate_to_dialogue_graph", None)
        if callable(fn):
            fn(gid)
        else:
            QMessageBox.information(
                self,
                "图对话",
                "请从主编辑器打开「数据编辑 → 叙事编排 → 图对话」。",
            )

    def _refresh_linked_graphs_list(self, d: dict) -> None:
        self._lw_linked_graphs.clear()
        raw = d.get("dialogueGraphIds")
        if not isinstance(raw, list):
            return
        for x in raw:
            gid = str(x).strip()
            if not gid:
                continue
            it = QListWidgetItem(gid)
            it.setData(Qt.ItemDataRole.UserRole, gid)
            self._lw_linked_graphs.addItem(it)

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

    def _phase_rows_visual_order(self) -> list[int]:
        """按左侧行号的**视觉顺序**返回逻辑行索引。拖动 vertical header 只改 visual↔logical
        映射，不改 cellWidget(logical) 的取值——序列化必须按视觉序遍历，否则「拖行号排序」
        纯属视觉、永不写入数据（审查 P1-35）。"""
        vh = self._tbl_phases.verticalHeader()
        return [vh.logicalIndex(v) for v in range(self._tbl_phases.rowCount())]

    def _phase_names_from_phases_table(self) -> list[str]:
        ordered: list[str] = []
        seen: set[str] = set()
        for r in self._phase_rows_visual_order():
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
                if isinstance(w, ScenarioRequiresExprEdit):
                    for cw in (w, *w.findChildren(QWidget)):
                        cw.removeEventFilter(self)
                        cw.installEventFilter(self)

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
            self._f_manual_line.blockSignals(True)
            self._f_manual_line.setChecked(d.get("manualLineLifecycle") is True)
            self._f_manual_line.blockSignals(False)
            self._f_desc.setText(str(d.get("description", "")))
            self._f_requires_edit.set_requires_value(d.get("requires"))

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
            self._refresh_linked_graphs_list(d)
        finally:
            self._loading_ui = False

    def _clear_detail_fields(self) -> None:
        self._f_id_sel.blockSignals(True)
        self._f_id_sel.set_items([])
        self._f_id_sel.blockSignals(False)
        self._f_manual_line.blockSignals(True)
        self._f_manual_line.setChecked(False)
        self._f_manual_line.blockSignals(False)
        self._f_desc.clear()
        self._f_requires_edit.set_requires_value(None)
        self._f_expose_after.clear()
        self._f_expose_after.addItem("（不配置）", "")
        self._tbl_exposes.setRowCount(0)
        self._lw_linked_graphs.clear()
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
                raw_req: object | None = None
                if isinstance(ph_val, dict):
                    if isinstance(ph_val.get("status"), str):
                        st = ph_val["status"]
                    if "requires" in ph_val:
                        raw_req = ph_val.get("requires")
                r = self._tbl_phases.rowCount()
                self._tbl_phases.insertRow(r)
                ne = QLineEdit(str(ph_name))
                ne.textChanged.connect(self._on_phases_or_exposes_structure_changed)
                self._tbl_phases.setCellWidget(r, 0, ne)
                self._tbl_phases.setCellWidget(r, 1, self._make_status_combo(st))
                dep = ScenarioRequiresExprEdit.for_phase_row(
                    self, self._on_phases_or_exposes_structure_changed, self._tbl_phases,
                )
                dep.set_requires_value(raw_req)
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
        if self._f_manual_line.isChecked():
            d["manualLineLifecycle"] = True
        elif "manualLineLifecycle" in d:
            del d["manualLineLifecycle"]
        desc = self._f_desc.text().strip()
        if desc:
            d["description"] = desc
        elif "description" in d:
            del d["description"]

        try:
            rqx = self._f_requires_edit.get_requires_value()
        except ValueError:
            pass
        else:
            if rqx is not None:
                d["requires"] = rqx
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

        # 旧 phase 表（重建前）：用于沿用本表无列可编辑、但运行时支持的字段（如 outcome），
        # 避免 Apply 整体重建 phases 时把这些字段静默抹掉（CLAUDE.md「重建区」盲区）。
        prev_phases = d.get("phases") if isinstance(d.get("phases"), dict) else {}
        phases: dict[str, dict] = {}
        for r in self._phase_rows_visual_order():  # 视觉序=拖动后的真实顺序（审查 P1-35）
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
            if isinstance(rw, ScenarioRequiresExprEdit):
                try:
                    prq = rw.get_requires_value()
                except ValueError:
                    pass
                else:
                    if prq is not None:
                        entry["requires"] = prq
            elif isinstance(rw, QLineEdit) and rw.text().strip():
                entry["requires"] = [
                    x.strip() for x in rw.text().split(",") if x.strip()
                ]
            # 同名 phase 的非托管字段（status/requires 之外，如 outcome）原样保留；
            # 改名的 phase 视为新阶段不继承。无此类字段时输出与改前完全一致。
            prev_entry = prev_phases.get(name)
            if isinstance(prev_entry, dict):
                for k, v in prev_entry.items():
                    if k not in ("status", "requires"):
                        entry[k] = v
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
        sc = self._scenarios_data[row] if row < len(self._scenarios_data) else {}
        sid = sc.get("id", "") if isinstance(sc, dict) else ""
        if not confirm.confirm_delete(self, f"剧情场景「{sid}」及其全部阶段/产出/暴露标志"):
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
        dep = ScenarioRequiresExprEdit.for_phase_row(
            self, self._on_phases_or_exposes_structure_changed, self._tbl_phases,
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

    def _phases_context_menu(self, pos) -> None:
        menu = QMenu(self._tbl_phases)
        menu.addAction("添加阶段", self._phases_add_row)
        has_sel = bool(self._tbl_phases.selectedIndexes()) or self._tbl_phases.currentRow() >= 0
        act_del = menu.addAction("删除所选阶段", self._phases_del_row)
        act_del.setEnabled(has_sel)
        menu.exec(self._tbl_phases.viewport().mapToGlobal(pos))

    def _exposes_context_menu(self, pos) -> None:
        menu = QMenu(self._tbl_exposes)
        menu.addAction("添加行", self._exposes_add_row)
        has_sel = bool(self._tbl_exposes.selectedIndexes()) or self._tbl_exposes.currentRow() >= 0
        act_del = menu.addAction("删除所选行", self._exposes_del_row)
        act_del.setEnabled(has_sel)
        menu.exec(self._tbl_exposes.viewport().mapToGlobal(pos))

    def _requires_ui_parse_errors(self) -> str | None:
        try:
            self._f_requires_edit.get_requires_value()
        except ValueError as e:
            return f"scenario 进线 requires：{e}"
        for r in range(self._tbl_phases.rowCount()):
            rw = self._tbl_phases.cellWidget(r, 2)
            if isinstance(rw, ScenarioRequiresExprEdit):
                try:
                    rw.get_requires_value()
                except ValueError as e:
                    return f"phases 第 {r + 1} 行 requires：{e}"
        return None

    def _validate(self) -> str | None:
        self._sync_current_row_from_ui()
        ui_err = self._requires_ui_parse_errors()
        if ui_err:
            return ui_err
        return validate_scenarios_list(
            self._scenarios_data,
            flag_registry=getattr(self._model, "flag_registry", None) or {},
            model=self._model,
        )

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

    def _is_dirty(self) -> bool:
        """编辑缓冲与模型里的 scenarios 是否有未应用差异（语义比较，键序/格式无关）。

        与表单类编辑器一致：Save All / 关闭路径据此判断是否需要提交，避免「未点 Apply
        即关闭」静默丢失，也避免未改动时每次保存都重写 scenarios.json。
        """
        candidate = json.dumps(
            self._build_catalog_dict().get("scenarios") or [],
            ensure_ascii=False, sort_keys=True,
        )
        saved_raw = getattr(self._model, "scenarios_catalog", None) or {}
        saved_list = saved_raw.get("scenarios") if isinstance(saved_raw, dict) else []
        saved = json.dumps(
            saved_list if isinstance(saved_list, list) else [],
            ensure_ascii=False, sort_keys=True,
        )
        return candidate != saved

    def pop_flush_error(self) -> str | None:
        """供 Save All 失败时取出可读错误详情（与框架 _flush_editors_to_model 约定一致）。"""
        e = self._flush_error
        self._flush_error = None
        return e

    def flush_to_model(self, for_save_all: bool = False) -> bool:
        """Save All 钩子：仅在有未应用编辑时校验并提交，校验失败返回 False（不抛、不写）。"""
        if not self._is_dirty():
            return True
        err = self._validate()
        if err:
            self._flush_error = f"scenarios.json：{err}"
            return False
        self._model.scenarios_catalog = self._build_catalog_dict()
        self._model.mark_dirty("scenarios")
        return True

    def confirm_close(self, parent=None) -> bool:
        """关闭/切换工程前：有未应用编辑则提示保存，避免静默丢弃（对齐 Quest 等编辑器）。"""
        if not self._is_dirty():
            return True
        r = QMessageBox.question(
            self, "未应用的修改",
            "Scenarios 有未 Apply 的修改。保存到工程模型？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            if not self.flush_to_model():
                QMessageBox.warning(
                    self, "scenarios.json",
                    self.pop_flush_error() or "校验未通过，无法保存。",
                )
                return False
        return True


class DocumentRevealsEditor(QWidget):
    """结构化编辑 public/assets/data/document_reveals.json（与运行时 DocumentRevealDef 一致）。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._loading_ui = False
        self._reveals: list[dict] = []
        # 从磁盘载入时这批条目的 id 快照：用于区分"已有数据"与"新建草稿"，
        # 保存全工程时只跳过新建且未填图的草稿，已有数据一律保留（防数据丢失）。
        self._loaded_ids: set[str] = set()

        root = QVBoxLayout(self)
        tip = QLabel("document_reveals.json：id / quest / revealedFlag 等均从工程清单选择。")
        tip.setWordWrap(True)
        tip.setToolTip(
            "「文档揭示」= 一条「模糊图→清晰图」的揭示包，带触发条件、会记进存档。\n"
            "做法两步：① 在这里登记一条（模糊图/清晰图/揭示条件/位置/时长）；"
            "② 在「图对话 runActions / 过场」里加 revealDocument，documentId 选这条 id。\n"
            "玩家侧：满足 revealCondition 时自动播叠化、放揭示音效、并把「已揭示」写进存档（重进保持清晰、不重播）。\n"
            "适合：告示揭真相、信件显字、线索清晰化。改完 Apply→Ctrl+S。",
        )
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
        b_add.setToolTip("新建一条揭示；填好模糊图/清晰图/揭示条件后才会被保存（只占位、不填图的草稿保存时自动忽略）")
        b_add.clicked.connect(self._dr_add)
        b_del = QPushButton("删除")
        b_del.setToolTip("删除当前选中的揭示条目")
        b_del.clicked.connect(self._dr_del)
        lr.addWidget(b_add)
        lr.addWidget(b_del)
        ll.addLayout(lr)

        right_scroll = QScrollArea()
        right_scroll.setWidgetResizable(True)
        rh = QWidget()
        rfl = QVBoxLayout(rh)

        form = compact_form(QFormLayout())
        self._dr_id_row = QWidget(rh)
        _drl = QHBoxLayout(self._dr_id_row)
        _drl.setContentsMargins(0, 0, 0, 0)
        self._dr_id_sel = IdRefSelector(
            self._dr_id_row, allow_empty=True, editable=False, click_opens_popup=True)
        self._dr_id_sel.setToolTip(
            "这条揭示的标识。剧情里靠它触发——在动作 revealDocument 的 documentId 下拉里选这个 id。\n"
            "下拉可对齐「档案文档」的 id（让一条档案与这条揭示同名联动）；没有就点右边「生成唯一 id」。",
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
            external_copy_hint="模糊图：可 Browse，外部图复制到 resources/runtime/images/illustrations/",
        )
        self._dr_blur.setMinimumWidth(240)
        self._dr_blur.setToolTip(
            "揭示前显示的「看不清」图（初始态）。点 Browse 选图，填完整路径。\n"
            "这里直接填图片路径，不走「叠图 ID」短名字。",
        )
        self._dr_blur.changed.connect(self._dr_on_edit)
        self._dr_blur_paint = QPushButton("涂抹生成…")
        self._dr_blur_paint.setToolTip(
            "对 clearImagePath 手绘水墨乱涂遮糊，烘焙同尺寸 PNG 写回模糊图（运行时不变）",
        )
        self._dr_blur_paint.clicked.connect(self._dr_on_paint_blur)
        _dr_blur_row = QWidget(rh)
        _dbl = QHBoxLayout(_dr_blur_row)
        _dbl.setContentsMargins(0, 0, 0, 0)
        _dbl.addWidget(self._dr_blur, stretch=1)
        _dbl.addWidget(self._dr_blur_paint)
        form.addRow("blurredImagePath", _dr_blur_row)

        self._dr_clear = CutsceneImagePathRow(
            self._model, "", self, external_copy_subdir="illustrations",
            external_copy_hint="清晰图：同上",
        )
        self._dr_clear.setMinimumWidth(240)
        self._dr_clear.setToolTip(
            "揭示后显示的「看清」图（目标态）。叠化结束后保留这张。\n"
            "同样填完整路径；建议与模糊图同尺寸同构图，叠化才自然。",
        )
        self._dr_clear.changed.connect(self._dr_on_edit)
        form.addRow("clearImagePath", self._dr_clear)

        rfl.addLayout(form)

        cond_g = QGroupBox("revealCondition")
        cond_g.setToolTip(
            "揭示条件：玩家触发 revealDocument 时，只有这个条件成立才会真正揭示（叠化成清晰）。\n"
            "条件不成立则什么都不发生——所以「先看不清、推进到某步才看清」就靠它控制。",
        )
        cg = QVBoxLayout(cond_g)
        self._dr_cond_kind = QComboBox()
        self._dr_cond_kind.addItem("Scenario 阶段", 0)
        self._dr_cond_kind.addItem("Flag条件", 1)
        self._dr_cond_kind.addItem("任务状态", 2)
        self._dr_cond_kind.addItem("JSON（高级 ConditionExpr）", 3)
        self._dr_cond_kind.addItem("表达式树（all/any/not…）", 4)
        self._dr_cond_kind.setToolTip(
            "选用哪种条件：\n"
            "· Scenario 阶段——某剧情线推进到某 phase（最常用，如「真相揭示」到 done）\n"
            "· Flag 条件——某个 flag 达到某值\n"
            "· 任务状态——某任务到 Active/Completed\n"
            "· JSON / 表达式树——需要 且/或/非 组合时的高级写法",
        )
        self._dr_cond_kind.currentIndexChanged.connect(self._dr_cond_kind_changed)
        cg.addWidget(self._dr_cond_kind)

        self._dr_cond_stack = QStackedWidget()
        w0 = QWidget()
        w0l = compact_form(QFormLayout(w0))
        self._dr_sc_scen = QComboBox()
        self._dr_sc_scen.setEditable(False)
        self._dr_sc_scen.setToolTip("哪条剧情线（scenario）——选定后下面 phase 会自动列出它的阶段")
        self._dr_sc_scen.currentIndexChanged.connect(self._dr_scenario_changed)
        self._dr_sc_phase = QComboBox()
        self._dr_sc_phase.setEditable(False)
        self._dr_sc_phase.setToolTip("该剧情线的哪个阶段（phase）")
        self._dr_sc_st = QComboBox()
        for s in SCENARIO_PHASE_STATUSES:
            self._dr_sc_st.addItem(s, s)
        self._dr_sc_st.setToolTip("该阶段要达到的状态，一般用 done（已完成）才触发揭示")
        self._dr_sc_out = QLineEdit()
        self._dr_sc_out.setPlaceholderText("可选 outcome（字符串/数字，与运行时一致）")
        self._dr_sc_out.setToolTip("可选：要求该阶段是某个具体结局值时才揭示；不需要就留空")
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
        self._dr_fl_key.setToolTip("看哪个 flag（从登记表里选，别手打）")
        self._dr_fl_key.valueChanged.connect(self._dr_flag_key_changed)
        self._dr_fl_op = QComboBox()
        self._dr_fl_op.addItems(["==", "!=", ">", "<", ">=", "<="])
        self._dr_fl_op.setMaximumWidth(64)
        self._dr_fl_op.setToolTip("比较方式：等于 == 最常用")
        self._dr_fl_op.currentTextChanged.connect(self._dr_on_edit)
        self._dr_fl_val = FlagValueEdit(self, self._model.flag_registry)
        self._dr_fl_val.setToolTip("要求 flag 等于的值（如 true）")
        self._dr_fl_val.valueChanged.connect(self._dr_on_edit)
        w1l.addWidget(self._dr_fl_key, stretch=1)
        w1l.addWidget(self._dr_fl_op)
        w1l.addWidget(self._dr_fl_val)

        w2 = QWidget()
        w2l = compact_form(QFormLayout(w2))
        self._dr_q_id = IdRefSelector(w2, allow_empty=True, editable=False, click_opens_popup=True)
        self._dr_q_id.setToolTip("看哪个任务（从 quests.json 任务列表里选）")
        self._dr_q_id.value_changed.connect(self._dr_on_edit)
        self._dr_q_st = QComboBox()
        for qs in QUEST_STATUSES:
            self._dr_q_st.addItem(qs, qs)
        self._dr_q_st.setToolTip("要求该任务到达的状态：Completed=已完成、Active=进行中")
        self._dr_q_st.currentIndexChanged.connect(self._dr_on_edit)
        w2l.addRow("quest", self._dr_q_id)
        w2l.addRow("questStatus", self._dr_q_st)

        w3 = QWidget()
        w3l = QVBoxLayout(w3)
        self._dr_cond_json = QPlainTextEdit()
        self._dr_cond_json.setPlaceholderText('例如 {"all":[...]} 或任意 ConditionExpr JSON')
        self._dr_cond_json.setMinimumHeight(120)
        self._dr_cond_json.setMaximumHeight(320)
        self._dr_cond_json.textChanged.connect(self._dr_on_edit)
        w3l.addWidget(self._dr_cond_json)
        # JSON 高级模式即时反馈：解析失败时高亮，避免"看似改了实则吞掉旧值"的静默。
        self._dr_cond_json_status = QLabel("")
        self._dr_cond_json_status.setStyleSheet("color:#c44;")
        self._dr_cond_json_status.setWordWrap(True)
        w3l.addWidget(self._dr_cond_json_status)

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

        anim_g = QGroupBox("过渡时序（animation）")
        anim_g.setToolTip("控制「模糊→清晰」叠化的快慢与起播延迟（毫秒）。")
        anim = compact_form(QFormLayout(anim_g))
        self._dr_dur = QSpinBox()
        self._dr_dur.setRange(0, 600_000)
        self._dr_dur.setSingleStep(100)
        self._dr_dur.setValue(2000)
        self._dr_dur.setToolTip("叠化时长（毫秒）：从模糊渐变到清晰用多久。2000=2 秒")
        self._dr_delay = QSpinBox()
        self._dr_delay.setRange(0, 600_000)
        self._dr_delay.setSingleStep(100)
        self._dr_delay.setToolTip("起播延迟（毫秒）：触发后先等多久再开始叠化。0=立即")
        for sp in (self._dr_dur, self._dr_delay):
            sp.setMaximumWidth(90)
            sp.valueChanged.connect(self._dr_on_edit)
        anim.addRow("animation.durationMs", self._dr_dur)
        anim.addRow("animation.delayMs", self._dr_delay)
        rfl.addWidget(anim_g)

        opt_g = QGroupBox("位置与可选字段（清晰图叠放位置 / 可选 flag）")
        opt_g.setToolTip("控制图叠在屏幕上的位置与大小（都按屏幕百分比）；revealedFlag 可选。可对着下方「揭示过渡预览」调。")
        opt = compact_form(QFormLayout(opt_g))
        self._dr_rflag = FlagKeyPickField(self._model, None, "", rh)
        self._dr_rflag.setToolTip(
            "可选：揭示完成后自动写 true 的 flag。\n"
            "想让别处剧情/条件知道「这条已经揭示过了」就填一个；不需要就留空。",
        )
        self._dr_rflag.valueChanged.connect(self._dr_on_edit)
        self._dr_x = QSpinBox()
        self._dr_x.setRange(0, 100)
        self._dr_x.setValue(50)
        self._dr_x.setToolTip("图在屏幕上的水平位置：图中心横向放在屏宽的百分之几。50=正中。可看下方预览对位")
        self._dr_y = QSpinBox()
        self._dr_y.setRange(0, 100)
        self._dr_y.setValue(50)
        self._dr_y.setToolTip("图在屏幕上的垂直位置：图中心纵向放在屏高的百分之几。50=正中")
        self._dr_w = QSpinBox()
        self._dr_w.setRange(1, 100)
        self._dr_w.setValue(40)
        self._dr_w.setToolTip("图的显示大小：占屏幕宽度的百分之几（高度按图自身比例自动算）。40=占四成屏宽")
        for sp in (self._dr_x, self._dr_y, self._dr_w):
            sp.setMaximumWidth(90)
            sp.valueChanged.connect(self._dr_on_edit)
        opt.addRow("revealedFlag", self._dr_rflag)
        opt.addRow("xPercent", self._dr_x)
        opt.addRow("yPercent", self._dr_y)
        opt.addRow("widthPercent", self._dr_w)
        rfl.addWidget(opt_g)

        # overlayId 是 blend 叠图层的「实例句柄」（与 blendOverlayImage 的 id 同义，供后续
        # 寻址/隐藏该层），不是 overlay_images.json 的图引用；运行时缺省为 docReveal_<id>。
        # 绝大多数情况无需填，放进默认折叠的高级区，并用自由文本（这是给图层命名，非引用他者）。
        adv_g = CollapsibleSection("高级：overlay 图层句柄（一般留空）", start_open=False)
        adv_body = QWidget()
        adv = compact_form(QFormLayout(adv_body))
        self._dr_oid = QLineEdit()
        self._dr_oid.setPlaceholderText("留空＝docReveal_<id>")
        self._dr_oid.setToolTip(
            "一般不用填、留空即可（系统自动取 docReveal_<本条 id>）。\n"
            "它只是这层叠图的内部「把手」名（和 blendOverlayImage 的 id 同义，给程序事后寻址/关闭用）；\n"
            "不是图片——别在这填图，图填上面的模糊图/清晰图。",
        )
        self._dr_oid.textChanged.connect(self._dr_on_edit)
        adv.addRow("overlayId（图层句柄）", self._dr_oid)
        adv_g.add_body(adv_body)
        rfl.addWidget(adv_g)

        prev_g = CollapsibleSection(
            "揭示过渡预览（Qt 近似，语义同 blendOverlayImage：模糊图 from → 清晰图 to）",
            start_open=False,
        )
        self._dr_blend_preview = BlendOverlayPreviewWidget(
            self._model, self._dr_blend_preview_params, rh,
        )
        prev_g.add_body(self._dr_blend_preview)
        rfl.addWidget(prev_g)
        self._dr_blur.changed.connect(self._dr_blend_preview.schedule_refresh)
        self._dr_clear.changed.connect(self._dr_blend_preview.schedule_refresh)
        self._dr_dur.valueChanged.connect(self._dr_blend_preview.schedule_refresh)
        self._dr_delay.valueChanged.connect(self._dr_blend_preview.schedule_refresh)
        self._dr_x.valueChanged.connect(self._dr_blend_preview.schedule_refresh)
        self._dr_y.valueChanged.connect(self._dr_blend_preview.schedule_refresh)
        self._dr_w.valueChanged.connect(self._dr_blend_preview.schedule_refresh)

        exp = CollapsibleSection("专家：本条原始 JSON（只读对照）", start_open=False)
        self._dr_json_preview = QPlainTextEdit()
        self._dr_json_preview.setReadOnly(True)
        self._dr_json_preview.setMaximumHeight(120)
        exp.add_body(self._dr_json_preview)
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

    def _dr_on_paint_blur(self) -> None:
        """对 clearImagePath 手绘水墨乱涂遮糊，烘焙模糊图写回 blurredImagePath（运行时不变）。"""
        from ..shared.image_path_picker import disk_path_for_runtime_url
        from ..shared.document_scribble_painter import DocumentScribblePainterDialog

        clear_url = self._dr_clear.path().strip()
        if not clear_url:
            QMessageBox.information(
                self, "涂抹生成模糊图", "请先设置 clearImagePath（涂抹基于清晰图）。",
            )
            return
        clear_disk = disk_path_for_runtime_url(self._model, clear_url)
        if clear_disk is None:
            QMessageBox.warning(self, "涂抹生成模糊图", "clearImagePath 无法解析到磁盘文件。")
            return
        doc_id = self._dr_id_sel.current_id().strip() or "doc"
        try:
            dlg = DocumentScribblePainterDialog(
                self._model, clear_disk, doc_id=doc_id,
                existing_blur_url=self._dr_blur.path().strip() or None, parent=self,
            )
        except ValueError as e:
            QMessageBox.warning(self, "涂抹生成模糊图", str(e))
            return
        if dlg.exec() == QDialog.DialogCode.Accepted and dlg.result_url():
            self._dr_blur.set_path(dlg.result_url())
            self._dr_on_edit()

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
        self._loaded_ids = {
            str(e.get("id", "")).strip()
            for e in self._reveals
            if str(e.get("id", "")).strip()
        }
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
        self._dr_cond_json_status.setText("")
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
            self._dr_oid.setText(str(d.get("overlayId", "")))
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
                if iqs < 0:
                    iqs = self._dr_q_st.findData("Completed")
                self._dr_q_st.setCurrentIndex(iqs if iqs >= 0 else 0)
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
            qid = self._dr_q_id.current_id().strip()
            qs = self._dr_q_st.currentData()
            if not isinstance(qs, str):
                qs = self._dr_q_st.currentText()
            d["revealCondition"] = {"quest": qid, "questStatus": qs}
        elif kind == 3:
            raw = self._dr_cond_json.toPlainText().strip()
            if not raw:
                d["revealCondition"] = {}
                self._dr_cond_json_status.setText("")
            else:
                try:
                    d["revealCondition"] = json.loads(raw)
                    self._dr_cond_json_status.setText("")
                except json.JSONDecodeError as e:
                    # 解析失败时保留旧值（不丢数据），但明确提示，避免静默吞改。
                    self._dr_cond_json_status.setText(f"JSON 解析失败：{e}")
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

    def _dr_is_empty_draft(self, e: dict) -> bool:
        """新建且从未填图的占位草稿：保存全工程时跳过（不写盘、不阻断其它编辑器的保存），
        且不算数据丢失（未填图本就无法运行）。已从磁盘载入的条目（id 在 _loaded_ids）
        或任一图非空的条目永不视为草稿，确保已有数据严格保留、字节往返不变。"""
        rid = str(e.get("id", "")).strip()
        if rid in self._loaded_ids:
            return False
        if str(e.get("blurredImagePath", "")).strip() or str(e.get("clearImagePath", "")).strip():
            return False
        return rid == "" or rid.startswith("新揭示_")

    def _dr_current_json_error(self) -> str | None:
        """当前选中行处于 JSON 高级模式、文本非空但无法解析时返回错误说明，否则 None。
        用于在 Apply / 保存前拦截「看似改了实则被静默吞掉」的旧值。"""
        if self._dr_cond_kind.currentData() != 3:
            return None
        raw = self._dr_cond_json.toPlainText().strip()
        if not raw:
            return None
        try:
            json.loads(raw)
        except json.JSONDecodeError as e:
            return f"revealCondition JSON 无法解析：{e}"
        return None

    def _dr_validate_condition_leaf(self, rid: str, rc: dict) -> str | None:
        """scenario / flag / quest 单叶子条件的关键字段非空校验；all/any/not 复合式跳过。"""
        if any(k in rc for k in ("all", "any", "not")):
            return None
        if "scenario" in rc:
            sid = str(rc.get("scenario", "")).strip()
            if not sid:
                return f"{rid!r}：scenario 阶段条件未选场景"
            ph = str(rc.get("phase", "")).strip()
            if ph:
                valid_ph = set(self._model.phases_for_scenario(sid))
                if valid_ph and ph not in valid_ph:
                    return f"{rid!r}：phase {ph!r} 不在 scenario {sid!r} 的清单中"
        elif "flag" in rc:
            if not str(rc.get("flag", "")).strip():
                return f"{rid!r}：flag 条件未填 flag 键"
        elif "quest" in rc:
            if not str(rc.get("quest", "")).strip():
                return f"{rid!r}：任务状态条件未选任务"
        return None

    def _dr_validate(self, entries: list[dict] | None = None) -> str | None:
        items = self._reveals if entries is None else entries
        seen: set[str] = set()
        for i, e in enumerate(items):
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
            leaf_err = self._dr_validate_condition_leaf(rid, rc)
            if leaf_err:
                return leaf_err
        return None

    def _apply(self) -> None:
        self._dr_sync_row_from_ui()
        je = self._dr_current_json_error()
        if je:
            QMessageBox.warning(self, "document_reveals.json", je)
            return
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
        row = self._dr_list.currentRow()
        # 正在 JSON 高级模式编辑当前行、文本不可解析时中止整次保存，避免静默写旧值；
        # 但若当前行只是未填图的草稿（下面会被跳过），则不拦，免得锁死别处的保存。
        if 0 <= row < len(self._reveals) and not self._dr_is_empty_draft(self._reveals[row]):
            je = self._dr_current_json_error()
            if je:
                raise ValueError(f"document_reveals.json：{je}")
        # 跳过"新建未填图草稿"：不阻断保存、不写半成品；已有数据一律保留并严格校验。
        kept = [e for e in self._reveals if not self._dr_is_empty_draft(e)]
        err = self._dr_validate(kept)
        if err:
            raise ValueError(f"document_reveals.json：{err}")
        payload = json.loads(json.dumps(kept, ensure_ascii=False))
        # 仅在内容确有变化时标脏：避免每次 Save All 都重写未改动的 document_reveals.json。
        if payload != (self._model.document_reveals or []):
            self._model.document_reveals = payload
            self._model.mark_dirty("document_reveals")
