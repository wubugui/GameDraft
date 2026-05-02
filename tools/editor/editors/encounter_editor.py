"""Encounter editor with option branches."""
from __future__ import annotations

import copy
from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QComboBox, QPushButton, QCheckBox,
    QScrollArea, QGroupBox, QSpinBox, QMessageBox, QToolButton,
    QMenu, QSizePolicy, QFrame, QStyle, QLabel,
)
from PySide6.QtCore import Qt

from ..project_model import ProjectModel
from ..shared.condition_editor import ConditionEditor
from ..shared.action_editor import ActionEditor
from ..shared.id_ref_selector import IdRefSelector
from ..shared.rich_text_field import RichTextLineEdit, RichTextTextEdit
from ..shared.qt_icon_buttons import outline_row_tool_button, delete_standard_pixmap


def _tool_std_icon_btn(
    parent: QWidget,
    std: QStyle.StandardPixmap,
    tip: str,
    px: int = 26,
    text_fallback: str = "",
) -> QToolButton:
    """工具条式 QToolButton，与主窗口/遭遇/过场行内按钮视觉一致。"""
    return outline_row_tool_button(
        parent,
        tip,
        theme_names=(),
        std=std,
        fallback_text=text_fallback,
        fixed_width=px,
        fixed_height=px,
    )


# ---------------------------------------------------------------------------
# Collapsible section (default collapsed)
# ---------------------------------------------------------------------------


class _CollapsibleSection(QWidget):
    def __init__(self, title: str, inner: QWidget, parent: QWidget | None = None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self._toggle = QToolButton()
        self._toggle.setText(title)
        self._toggle.setCheckable(True)
        self._toggle.setChecked(False)
        self._toggle.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self._toggle.setArrowType(Qt.ArrowType.RightArrow)
        self._toggle.toggled.connect(self._on_toggled)
        lay.addWidget(self._toggle)
        self._inner = inner
        lay.addWidget(self._inner)
        self._inner.setVisible(False)

    def _on_toggled(self, expanded: bool) -> None:
        self._toggle.setArrowType(
            Qt.ArrowType.DownArrow if expanded else Qt.ArrowType.RightArrow)
        self._inner.setVisible(expanded)


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
        self._item_sel.setSizePolicy(
            QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        self._item_sel.setMaximumWidth(320)
        lay.addWidget(self._item_sel, stretch=0)

        self._count = QSpinBox()
        self._count.setRange(1, 9999)
        self._count.setValue(data.get("count", 1))
        self._count.setPrefix("x")
        lay.addWidget(self._count)

        self._del_btn = _tool_std_icon_btn(
            self, delete_standard_pixmap(), "移除此行", px=24, text_fallback="删")
        lay.addWidget(self._del_btn)
        lay.addStretch(1)

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
        btn.setToolTip("添加消耗物品行")
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

_OPTION_TYPES = ("general", "rule", "special")


class OptionWidget(QFrame):
    """单条遭遇选项：整块默认折叠，标题行显示摘要；折叠时仍可使用上移/下移/删除。"""

    def __init__(self, idx: int, data: dict, model: ProjectModel,
                 parent: QWidget | None = None):
        super().__init__(parent)
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self.setFrameShadow(QFrame.Shadow.Plain)
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.customContextMenuRequested.connect(self._ctx_menu)
        self._data = data
        self._idx = idx

        lay = QVBoxLayout(self)
        lay.setContentsMargins(6, 6, 6, 6)

        head = QHBoxLayout()
        self._expand = QToolButton()
        self._expand.setCheckable(True)
        self._expand.setChecked(False)
        self._expand.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self._expand.setArrowType(Qt.ArrowType.RightArrow)
        self._expand.setToolTip("展开或折叠该选项的详细编辑区")
        self._expand.toggled.connect(self._on_expand_toggled)
        self._expand.setSizePolicy(
            QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        head.addWidget(self._expand, stretch=0)

        self._btn_up = _tool_std_icon_btn(
            self, QStyle.StandardPixmap.SP_ArrowUp, "上移", text_fallback="上")
        self._btn_down = _tool_std_icon_btn(
            self, QStyle.StandardPixmap.SP_ArrowDown, "下移", text_fallback="下")
        self._btn_del = _tool_std_icon_btn(
            self, delete_standard_pixmap(), "删除该选项", text_fallback="删")
        head.addWidget(self._btn_up)
        head.addWidget(self._btn_down)
        head.addWidget(self._btn_del)
        head.addStretch(1)
        lay.addLayout(head)

        self._body = QWidget()
        body_lay = QVBoxLayout(self._body)
        body_lay.setContentsMargins(0, 4, 0, 0)

        f = QFormLayout()
        self._text = RichTextLineEdit(model)
        self._text.setText(data.get("text", ""))
        self._text.setPlaceholderText("选项显示文案")
        self._text.textChanged.connect(self._refresh_header_label)
        f.addRow("text", self._text)
        self._type = QComboBox()
        self._type.addItems(list(_OPTION_TYPES))
        self._type.setEditable(False)
        t = data.get("type", "general")
        if t in _OPTION_TYPES:
            self._type.setCurrentText(t)
        f.addRow("type", self._type)
        self._rule = IdRefSelector(allow_empty=True)
        self._rule.set_items(model.all_rule_ids())
        self._rule.set_current(data.get("requiredRuleId", ""))
        self._rule.setSizePolicy(
            QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        self._rule.setMaximumWidth(360)
        f.addRow("requiredRuleId", self._rule)
        f.addRow(
            QLabel(
                "requiredRuleLayers（不勾=须完整掌握；勾选者须对应层已解锁）",
            ),
        )
        rl_row = QHBoxLayout()
        self._rl_xiang = QCheckBox("象")
        self._rl_li = QCheckBox("理")
        self._rl_shu = QCheckBox("术")
        rl_raw = data.get("requiredRuleLayers") or []
        rl_set = set(rl_raw) if isinstance(rl_raw, list) else set()
        self._rl_xiang.setChecked("xiang" in rl_set)
        self._rl_li.setChecked("li" in rl_set)
        self._rl_shu.setChecked("shu" in rl_set)
        rl_row.addWidget(self._rl_xiang)
        rl_row.addWidget(self._rl_li)
        rl_row.addWidget(self._rl_shu)
        rl_row.addStretch(1)
        f.addRow(rl_row)
        self._result_text = RichTextTextEdit(model)
        self._result_text.setPlainText(data.get("resultText", ""))
        self._result_text.setMaximumHeight(80)
        self._result_text.setPlaceholderText("选择该选项后的叙事（可选）")
        f.addRow("resultText", self._result_text)
        body_lay.addLayout(f)

        self._conds = ConditionEditor("Conditions")
        self._conds.set_flag_pattern_context(model, None)
        self._conds.set_data(data.get("conditions", []))
        body_lay.addWidget(_CollapsibleSection("Conditions", self._conds))

        self._consume = ConsumeItemsEditor("Consume Items")
        self._consume.set_model(model)
        self._consume.set_data(data.get("consumeItems", []))
        body_lay.addWidget(_CollapsibleSection("Consume Items", self._consume))

        self._actions = ActionEditor("Result Actions")
        self._actions.set_project_context(model, None)
        self._actions.set_data(data.get("resultActions", []))
        body_lay.addWidget(_CollapsibleSection("Result Actions", self._actions))

        lay.addWidget(self._body)
        self._body.setVisible(False)
        self._refresh_header_label()

    def _snippet(self) -> str:
        t = self._text.text().strip()
        if not t:
            return "\u2014"
        return t if len(t) <= 40 else t[:37] + "..."

    def _refresh_header_label(self) -> None:
        self._expand.setText(f"Option {self._idx + 1}  {self._snippet()}")
        self._expand.setToolTip(
            f"选项 {self._idx + 1}：{self._snippet()}\n点击箭头展开/折叠表单与子区块。",
        )

    def _on_expand_toggled(self, expanded: bool) -> None:
        self._expand.setArrowType(
            Qt.ArrowType.DownArrow if expanded else Qt.ArrowType.RightArrow)
        self._body.setVisible(expanded)

    def _ctx_menu(self, pos) -> None:
        menu = QMenu(self)
        menu.addAction(
            "折叠" if self._expand.isChecked() else "展开",
            lambda: self._expand.setChecked(not self._expand.isChecked()),
        )
        menu.addSeparator()
        menu.addAction("上移", lambda: self._btn_up.click())
        menu.addAction("下移", lambda: self._btn_down.click())
        menu.addSeparator()
        menu.addAction("删除该选项", lambda: self._btn_del.click())
        menu.exec(self.mapToGlobal(pos))

    def set_option_index(self, idx: int) -> None:
        self._idx = idx
        self._refresh_header_label()

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
        rq: list[str] = []
        if self._rl_xiang.isChecked():
            rq.append("xiang")
        if self._rl_li.isChecked():
            rq.append("li")
        if self._rl_shu.isChecked():
            rq.append("shu")
        if rq:
            d["requiredRuleLayers"] = rq
        rt = self._result_text.toPlainText()
        if rt:
            d["resultText"] = rt
        ci = self._consume.to_list()
        if ci:
            d["consumeItems"] = ci
        return d


# ---------------------------------------------------------------------------
# Encounter editor
# ---------------------------------------------------------------------------


def _encounter_normalize(enc: dict) -> dict:
    """Stable dict for dirty compare (options order preserved)."""
    return {
        "id": str(enc.get("id", "")).strip(),
        "narrative": str(enc.get("narrative", "")),
        "options": copy.deepcopy(enc.get("options") or []),
    }


class EncounterEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx: int = -1
        self._loading_ui = False
        self._snapshot: dict | None = None

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Encounter")
        btn_add.setToolTip("新增一条遭遇")
        btn_add.clicked.connect(self._add)
        btn_del = QPushButton("Delete")
        btn_del.setToolTip("删除当前遭遇")
        btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add)
        btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.selectionModel().currentChanged.connect(
            self._on_selection_current_changed)
        ll.addWidget(self._list, stretch=1)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(
            Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        scroll.setVerticalScrollBarPolicy(
            Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self._detail = QWidget()
        self._detail_layout = QVBoxLayout(self._detail)
        self._detail_layout.setAlignment(Qt.AlignmentFlag.AlignTop)
        f = QFormLayout()
        self._e_id_row = QWidget()
        _idl = QHBoxLayout(self._e_id_row)
        _idl.setContentsMargins(0, 0, 0, 0)
        self._e_id_sel = IdRefSelector(
            self._e_id_row, allow_empty=False, editable=False)
        self._e_id_sel.setToolTip(
            "从下拉选择遭遇 id；须与热区 encounterId、全表唯一一致。",
        )
        self._e_id_new = QPushButton("生成唯一 id")
        self._e_id_new.setToolTip("分配当前表中未占用的 id")
        self._e_id_new.clicked.connect(self._on_gen_encounter_id)
        _idl.addWidget(self._e_id_sel, stretch=1)
        _idl.addWidget(self._e_id_new)
        f.addRow("id", self._e_id_row)
        self._e_narr = RichTextTextEdit(self._model)
        self._e_narr.setMaximumHeight(100)
        self._e_narr.setPlaceholderText("遭遇叙事正文")
        f.addRow("narrative", self._e_narr)
        self._detail_layout.addLayout(f)
        self._opts_layout = QVBoxLayout()
        self._opts_layout.setAlignment(Qt.AlignmentFlag.AlignTop)
        self._detail_layout.addLayout(self._opts_layout)
        opt_btns = QHBoxLayout()
        add_opt = QPushButton("+ Option")
        add_opt.setToolTip("在末尾添加选项")
        add_opt.clicked.connect(self._add_option)
        opt_btns.addWidget(add_opt)
        opt_btns.addStretch()
        self._detail_layout.addLayout(opt_btns)
        apply_btn = QPushButton("Apply")
        apply_btn.setToolTip("将右侧内容写回当前遭遇")
        apply_btn.clicked.connect(self._apply)
        self._detail_layout.addWidget(apply_btn)
        scroll_host = QWidget()
        scroll_host_lay = QVBoxLayout(scroll_host)
        scroll_host_lay.setContentsMargins(0, 0, 0, 0)
        scroll_host_lay.setAlignment(Qt.AlignmentFlag.AlignTop)
        scroll_host_lay.addWidget(self._detail)
        scroll_host_lay.addStretch(1)
        scroll.setWidget(scroll_host)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([250, 700])
        root.addWidget(splitter)
        self._opt_widgets: list[OptionWidget] = []
        self._refresh(select_id=None)

    def _all_encounter_ids_used(self) -> set[str]:
        return {
            str(e.get("id", "")).strip()
            for e in self._model.encounters
            if str(e.get("id", "")).strip()
        }

    def _suggest_unique_encounter_id(self) -> str:
        used = self._all_encounter_ids_used()
        n = len(self._model.encounters)
        while True:
            cand = f"encounter_{n}"
            if cand not in used:
                return cand
            n += 1

    def _encounter_id_choice_list(self, row: int) -> list[str]:
        if row < 0 or row >= len(self._model.encounters):
            return []
        used_elsewhere = {
            str(self._model.encounters[i].get("id", "")).strip()
            for i in range(len(self._model.encounters))
            if i != row
        }
        used_elsewhere.discard("")
        cur = str(self._model.encounters[row].get("id", "")).strip()
        candidates: list[str] = []
        if cur:
            candidates.append(cur)
        used_all = self._all_encounter_ids_used()
        n = 0
        extra = 0
        while extra < 48:
            cand = f"encounter_{n}"
            if cand not in used_all:
                candidates.append(cand)
                extra += 1
            n += 1
        seen: set[str] = set()
        out: list[str] = []
        for c in candidates:
            if c in seen:
                continue
            if c != cur and c in used_elsewhere:
                continue
            seen.add(c)
            out.append(c)
        return out

    def _sync_id_selector_for_row(self, row: int) -> None:
        self._e_id_sel.blockSignals(True)
        try:
            self._e_id_sel.set_items(self._encounter_id_choice_list(row))
            if 0 <= row < len(self._model.encounters):
                cur = str(self._model.encounters[row].get("id", "")).strip()
                self._e_id_sel.set_current(cur)
        finally:
            self._e_id_sel.blockSignals(False)

    def _on_gen_encounter_id(self) -> None:
        if self._loading_ui or self._current_idx < 0:
            return
        new_id = self._suggest_unique_encounter_id()
        row = self._current_idx
        self._model.encounters[row]["id"] = new_id
        self._model.mark_dirty("encounter")
        self._sync_id_selector_for_row(row)
        lw = self._list.item(row)
        if lw is not None:
            lw.setText(new_id)
        self._take_snapshot_from_model_row(row)

    def _enc_from_ui(self) -> dict:
        eid = self._e_id_sel.current_id().strip()
        return {
            "id": eid,
            "narrative": self._e_narr.toPlainText(),
            "options": [ow.to_dict() for ow in self._opt_widgets],
        }

    def _is_dirty(self) -> bool:
        if self._current_idx < 0:
            return False
        if self._snapshot is None:
            return False
        cur = _encounter_normalize(self._enc_from_ui())
        return cur != self._snapshot

    def _take_snapshot_from_model_row(self, row: int) -> None:
        if row < 0 or row >= len(self._model.encounters):
            self._snapshot = None
            return
        self._snapshot = _encounter_normalize(self._model.encounters[row])

    def _prompt_save_discard(self) -> str:
        """Returns 'save', 'discard', or 'cancel'."""
        r = QMessageBox.question(
            self,
            "未应用的修改",
            "当前遭遇有未 Apply 的修改，如何处理？\n"
            "是 = 应用并继续\n"
            "否 = 放弃修改并继续\n"
            "取消 = 留在当前条",
            QMessageBox.StandardButton.Yes
            | QMessageBox.StandardButton.No
            | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Yes,
        )
        if r == QMessageBox.StandardButton.Yes:
            return "save"
        if r == QMessageBox.StandardButton.No:
            return "discard"
        return "cancel"

    def _on_selection_current_changed(self, current, previous) -> None:
        if self._loading_ui:
            return
        prev_row = previous.row() if previous.isValid() else -1
        new_row = current.row() if current.isValid() else -1
        if prev_row == new_row:
            return
        if prev_row >= 0 and self._is_dirty():
            choice = self._prompt_save_discard()
            if choice == "cancel":
                self._loading_ui = True
                try:
                    self._list.selectionModel().blockSignals(True)
                    self._list.setCurrentRow(prev_row)
                    self._list.selectionModel().blockSignals(False)
                finally:
                    self._loading_ui = False
                return
            if choice == "save":
                nav_id = None
                if new_row >= 0:
                    nav_id = str(
                        self._model.encounters[new_row].get("id", "")).strip() or None
                if not self._apply_impl(refresh_select_id=nav_id):
                    self._loading_ui = True
                    try:
                        self._list.selectionModel().blockSignals(True)
                        self._list.setCurrentRow(prev_row)
                        self._list.selectionModel().blockSignals(False)
                    finally:
                        self._loading_ui = False
                    return
                return
            # discard: drop UI edits for prev row
        self._load_row(new_row)

    def _load_row(self, row: int) -> None:
        self._loading_ui = True
        try:
            if row < 0 or row >= len(self._model.encounters):
                self._current_idx = -1
                self._snapshot = None
                self._e_id_sel.blockSignals(True)
                self._e_id_sel.clear()
                self._e_id_sel.blockSignals(False)
                self._e_narr.clear()
                self._rebuild_options([])
                return
            self._current_idx = row
            enc = self._model.encounters[row]
            self._sync_id_selector_for_row(row)
            self._e_narr.setPlainText(enc.get("narrative", ""))
            self._rebuild_options(enc.get("options", []))
            self._take_snapshot_from_model_row(row)
        finally:
            self._loading_ui = False

    def _refresh(self, select_id: str | None) -> None:
        self._list.selectionModel().blockSignals(True)
        try:
            self._list.clear()
            for enc in self._model.encounters:
                self._list.addItem(f"{enc.get('id', '?')}")
            row = -1
            if select_id is not None and select_id != "":
                for i, enc in enumerate(self._model.encounters):
                    if enc.get("id") == select_id:
                        row = i
                        break
                if row < 0 and self._model.encounters:
                    row = 0
            elif self._model.encounters:
                row = 0
            if row >= 0:
                self._list.setCurrentRow(row)
            else:
                self._list.setCurrentRow(-1)
        finally:
            self._list.selectionModel().blockSignals(False)
        self._load_row(row)

    def _rebuild_options(self, options: list[dict]) -> None:
        for w in self._opt_widgets:
            self._opts_layout.removeWidget(w)
            w.deleteLater()
        self._opt_widgets.clear()
        for i, opt in enumerate(options):
            ow = OptionWidget(i, opt, self._model)
            ow._btn_up.clicked.connect(self._move_option_up)
            ow._btn_down.clicked.connect(self._move_option_down)
            ow._btn_del.clicked.connect(self._remove_option_sender)
            self._opt_widgets.append(ow)
            self._opts_layout.addWidget(ow)

    def _option_widget_from_sender(self) -> OptionWidget | None:
        w = self.sender()
        while w is not None and not isinstance(w, OptionWidget):
            w = w.parent()
        return w if isinstance(w, OptionWidget) else None

    def _move_option_up(self) -> None:
        ow = self._option_widget_from_sender()
        if ow is None:
            return
        try:
            idx = self._opt_widgets.index(ow)
        except ValueError:
            return
        if idx <= 0:
            return
        self._swap_options(idx, idx - 1)

    def _move_option_down(self) -> None:
        ow = self._option_widget_from_sender()
        if ow is None:
            return
        try:
            idx = self._opt_widgets.index(ow)
        except ValueError:
            return
        if idx >= len(self._opt_widgets) - 1:
            return
        self._swap_options(idx, idx + 1)

    def _swap_options(self, a: int, b: int) -> None:
        self._opt_widgets[a], self._opt_widgets[b] = (
            self._opt_widgets[b], self._opt_widgets[a])
        for w in self._opt_widgets:
            self._opts_layout.removeWidget(w)
        for i, w in enumerate(self._opt_widgets):
            w.set_option_index(i)
            self._opts_layout.addWidget(w)

    def _remove_option_sender(self) -> None:
        ow = self._option_widget_from_sender()
        if ow is None:
            return
        try:
            idx = self._opt_widgets.index(ow)
        except ValueError:
            return
        self._opts_layout.removeWidget(ow)
        self._opt_widgets.pop(idx)
        ow.deleteLater()
        for i, w in enumerate(self._opt_widgets):
            w.set_option_index(i)

    def _add_option(self) -> None:
        ow = OptionWidget(
            len(self._opt_widgets),
            {"text": "", "type": "general", "conditions": [], "resultActions": []},
            self._model,
        )
        ow._btn_up.clicked.connect(self._move_option_up)
        ow._btn_down.clicked.connect(self._move_option_down)
        ow._btn_del.clicked.connect(self._remove_option_sender)
        self._opt_widgets.append(ow)
        self._opts_layout.addWidget(ow)

    def _validate_before_apply(self) -> list[str]:
        errors: list[str] = []
        eid = self._e_id_sel.current_id().strip()
        if not eid:
            errors.append("遭遇 id 不能为空")
        for i, enc in enumerate(self._model.encounters):
            if i != self._current_idx and str(enc.get("id", "")).strip() == eid:
                errors.append(f"遭遇 id 与其它条重复: {eid}")
                break
        rule_ids = {str(r.get("id", "")).strip() for r in self._model.rules_data.get("rules", [])}
        rule_ids.discard("")
        item_ids = {str(it.get("id", "")).strip() for it in self._model.items}
        item_ids.discard("")
        for j, ow in enumerate(self._opt_widgets):
            d = ow.to_dict()
            if not (d.get("text") or "").strip():
                errors.append(f"Option {j + 1} 的 text 不能为空")
            ot = d.get("type", "")
            if ot not in _OPTION_TYPES:
                errors.append(f"Option {j + 1} 的 type 非法: {ot}")
            rid = d.get("requiredRuleId")
            if rid and rid not in rule_ids:
                errors.append(
                    f"Option {j + 1} 的 requiredRuleId 未找到规则: {rid}")
            for ci in d.get("consumeItems") or []:
                cid = str(ci.get("id", "")).strip()
                if cid and cid not in item_ids:
                    errors.append(
                        f"Option {j + 1} 的 consumeItem 未找到物品: {cid}")
        return errors

    def _apply_impl(self, refresh_select_id: str | None = None) -> bool:
        if self._current_idx < 0:
            return False
        errs = self._validate_before_apply()
        if errs:
            QMessageBox.warning(
                self, "无法应用", "\n".join(errs[:12])
                + ("\n..." if len(errs) > 12 else ""))
            return False
        enc = self._model.encounters[self._current_idx]
        row_saved = self._current_idx
        enc["id"] = self._e_id_sel.current_id().strip()
        enc["narrative"] = self._e_narr.toPlainText()
        enc["options"] = [ow.to_dict() for ow in self._opt_widgets]
        self._model.mark_dirty("encounter")
        sel_raw = refresh_select_id if refresh_select_id is not None else enc["id"]
        sel_id = str(sel_raw).strip() if sel_raw else ""
        target_row = -1
        if sel_id:
            for i, e in enumerate(self._model.encounters):
                if str(e.get("id", "")).strip() == sel_id:
                    target_row = i
                    break
            if target_row < 0 and self._model.encounters:
                target_row = 0
        elif self._model.encounters:
            target_row = 0

        lw = self._list.item(row_saved)
        if lw is not None:
            lw.setText(f"{enc.get('id', '?')}")

        self._list.selectionModel().blockSignals(True)
        try:
            if target_row >= 0:
                self._list.setCurrentRow(target_row)
            else:
                self._list.setCurrentRow(-1)
        finally:
            self._list.selectionModel().blockSignals(False)
        self._load_row(target_row)
        return True

    def _apply(self) -> None:
        self._apply_impl(refresh_select_id=None)

    def _add(self) -> None:
        new_id = self._suggest_unique_encounter_id()
        self._model.encounters.append({
            "id": new_id,
            "narrative": "",
            "options": [],
        })
        self._model.mark_dirty("encounter")
        self._refresh(select_id=new_id)

    def _delete(self) -> None:
        if self._current_idx < 0:
            return
        eid = str(self._model.encounters[self._current_idx].get("id", "?"))
        r = QMessageBox.question(
            self,
            "删除遭遇",
            f"确定删除遭遇「{eid}」？此操作不可撤销。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if r != QMessageBox.StandardButton.Yes:
            return
        idx = self._current_idx
        del self._model.encounters[idx]
        self._model.mark_dirty("encounter")
        next_id: str | None = None
        if self._model.encounters:
            nxt = self._model.encounters[min(idx, len(self._model.encounters) - 1)]
            next_id = str(nxt.get("id", "")).strip() or None
        self._refresh(select_id=next_id)

    def select_by_id(self, item_id: str, _scene_id: str = "") -> None:
        for i, enc in enumerate(self._model.encounters):
            if enc.get("id") == item_id:
                self._list.setCurrentRow(i)
                return
