"""Rules and fragments editor."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget, QListWidgetItem,
    QTabWidget, QFormLayout, QLineEdit, QComboBox, QPushButton,
    QScrollArea, QLabel, QGroupBox, QMessageBox, QMenu,
)
from PySide6.QtCore import Qt, QEvent

from ..project_model import ProjectModel
from ..shared import confirm
from ..shared.form_layout import compact_form
from ..shared.collapsible_section import CollapsibleSection
from ..shared.rich_text_field import RichTextLineEdit, RichTextTextEdit


class RuleEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        # 快照式脏判断（UI 与「载入时的 UI」比较，只认用户改动，绕开旧数据→layers 的
        # 自动迁移误判）+ 防 apply→refresh 重选时重复提交。
        self._rule_snapshot = None
        self._frag_snapshot = None
        self._suppress_commit = False

        root = QVBoxLayout(self)
        self._tabs = QTabWidget()
        root.addWidget(self._tabs)

        self._tabs.addTab(self._build_rules_tab(), "Rules")
        self._tabs.addTab(self._build_fragments_tab(), "Fragments")
        self._refresh()

    # ---- rules tab --------------------------------------------------------

    def _build_rules_tab(self) -> QWidget:
        w = QWidget()
        lay = QHBoxLayout(w)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Rule")
        btn_add.setToolTip("新增一条规矩")
        btn_add.clicked.connect(self._add_rule)
        btn_del = QPushButton("Delete")
        btn_del.setToolTip("删除选中的规矩（Delete 键亦可）")
        btn_del.clicked.connect(self._del_rule)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._rule_search = QLineEdit()
        self._rule_search.setPlaceholderText("搜索…")
        self._rule_search.setToolTip("按 id / 名称过滤下方列表（仅隐藏不匹配项，不改数据）")
        self._rule_search.setClearButtonEnabled(True)
        self._rule_search.textChanged.connect(self._on_rule_search_changed)
        ll.addWidget(self._rule_search)
        self._rule_list = QListWidget()
        self._rule_list.currentRowChanged.connect(self._on_rule_select)
        self._rule_list.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._rule_list.customContextMenuRequested.connect(self._show_rule_list_menu)
        self._rule_list.installEventFilter(self)
        ll.addWidget(self._rule_list, stretch=1)

        link_box = QGroupBox("本规矩的碎片（双击跳转编辑）")
        link_lay = QVBoxLayout(link_box)
        self._rule_frag_list = QListWidget()
        self._rule_frag_list.setMinimumHeight(100)
        self._rule_frag_list.itemDoubleClicked.connect(self._on_rule_frag_sidebar_activated)
        link_lay.addWidget(self._rule_frag_list)
        btn_frag_row = QHBoxLayout()
        self._btn_open_frags = QPushButton("在 Fragments 页打开")
        self._btn_open_frags.setToolTip("跳到 Fragments 页并选中上方列表里选中的碎片")
        self._btn_open_frags.clicked.connect(self._open_selected_sidebar_frag_in_tab)
        self._btn_add_linked_frag = QPushButton("+ 关联碎片")
        self._btn_add_linked_frag.setToolTip("跳到 Fragments 页并新增一条已填好 ruleId 的碎片")
        self._btn_add_linked_frag.clicked.connect(self._add_frag_for_current_rule)
        btn_frag_row.addWidget(self._btn_open_frags)
        btn_frag_row.addWidget(self._btn_add_linked_frag)
        link_lay.addLayout(btn_frag_row)
        ll.addWidget(link_box)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        f = compact_form(QFormLayout(detail))
        self._r_id = QLineEdit(); f.addRow("id", self._r_id)
        self._r_name = RichTextLineEdit(self._model); f.addRow("name", self._r_name)
        self._r_iname = RichTextLineEdit(self._model); f.addRow("incompleteName", self._r_iname)
        self._r_cat = QComboBox()
        self._r_cat.addItems(["ward", "taboo", "jargon", "streetwise"])
        f.addRow("category", self._r_cat)
        self._layer_edits: dict[str, tuple[RichTextTextEdit, RichTextLineEdit, QComboBox]] = {}
        for lk, title in (("xiang", "象"), ("li", "理"), ("shu", "术")):
            body = QWidget()
            gl = compact_form(QFormLayout(body))
            te = RichTextTextEdit(self._model)
            te.setMaximumHeight(100)
            hi = RichTextLineEdit(self._model)
            hi.setPlaceholderText("lockedHint（未解锁时提示，可选）")
            ver = QComboBox()
            ver.addItems(["unverified", "effective", "questionable"])
            gl.addRow("text", te)
            gl.addRow("lockedHint", hi)
            gl.addRow("verified", ver)
            sec = CollapsibleSection(f"层：{title}", start_open=False)
            sec.set_header_tool_tip(f"{title} 层文本 / 未解锁提示 / 验证状态")
            sec.add_body(body)
            f.addRow(sec)
            self._layer_edits[lk] = (te, hi, ver)
        apply_btn = QPushButton("Apply"); f.addRow(apply_btn)
        apply_btn.clicked.connect(self._apply_rule)
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([250, 500])
        lay.addWidget(splitter)
        self._rule_idx = -1
        return w

    def _rule_ui_state(self):
        layers = {}
        for lk in ("xiang", "li", "shu"):
            te, hi, ver = self._layer_edits[lk]
            layers[lk] = (te.toPlainText(), hi.text(), ver.currentText())
        return (self._r_id.text(), self._r_name.text(), self._r_iname.text(),
                self._r_cat.currentText(), layers)

    def _frag_ui_state(self):
        return (self._f_id.text(), self._f_text.toPlainText(),
                self._f_layer.currentText(), self._f_src.text())

    def _is_dirty_rule(self) -> bool:
        rules = self._model.rules_data.get("rules", [])
        return (0 <= self._rule_idx < len(rules)
                and self._rule_snapshot is not None
                and self._rule_ui_state() != self._rule_snapshot)

    def _is_dirty_frag(self) -> bool:
        frags = self._model.rules_data.get("fragments", [])
        return (0 <= self._frag_idx < len(frags)
                and self._frag_snapshot is not None
                and self._frag_ui_state() != self._frag_snapshot)

    def _is_dirty(self) -> bool:
        return self._is_dirty_rule() or self._is_dirty_frag()

    def flush_to_model(self) -> bool:
        """Save All 钩子：先提交碎片（其 apply 会刷新碎片列表），再提交规矩。"""
        if self._is_dirty_frag():
            self._apply_frag()
        if self._is_dirty_rule():
            self._apply_rule()
        return True

    def confirm_close(self, parent=None) -> bool:
        if not self._is_dirty():
            return True
        r = QMessageBox.question(
            self, "未应用的修改", "当前规矩/碎片有未应用的修改。保存到模型？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            if self._is_dirty_frag():
                self._apply_frag()
            if self._is_dirty_rule():
                self._apply_rule()
        else:
            # Discard：把两个表单回滚到模型当前值，否则关闭路径随后的统一 flush 会按
            # UI≠模型判脏，把刚被放弃的编辑重新提交（复核 P1-01）。_suppress_commit
            # 防重填路径自身的 commit-on-leave 把被放弃的编辑先提交掉。
            self._suppress_commit = True
            try:
                if self._is_dirty_frag():
                    self._on_frag_select(self._frag_list.currentRow())
                if self._is_dirty_rule():
                    self._on_rule_select(self._rule_idx)
            finally:
                self._suppress_commit = False
        return True

    def _on_rule_select(self, row: int) -> None:
        rules = self._model.rules_data.get("rules", [])
        if row < 0 or row >= len(rules):
            self._rule_idx = -1
            self._rule_snapshot = None
            self._rule_frag_list.clear()
            return
        # commit-on-leave：切到别的规矩前提交上一条未应用编辑。_apply_rule 不重建规矩
        # 列表（只刷新碎片侧栏），故 row 不会悬挂；_suppress_commit 防刷新触发的重入。
        if (not self._suppress_commit and 0 <= self._rule_idx < len(rules)
                and self._rule_idx != row and self._is_dirty_rule()):
            self._suppress_commit = True
            try:
                self._apply_rule()
            finally:
                self._suppress_commit = False
        self._rule_idx = row
        r = rules[row]
        self._r_id.setText(r.get("id", ""))
        self._r_name.setText(r.get("name", ""))
        self._r_iname.setText(r.get("incompleteName", ""))
        self._r_cat.setCurrentText(r.get("category", "ward"))
        rule_fallback_ver = str(r.get("verified", "unverified") or "unverified")
        layers = r.get("layers")
        if not isinstance(layers, dict) or not layers:
            legacy = str(r.get("description", "") or "")
            layers = {"xiang": {"text": legacy}} if legacy else {"xiang": {"text": ""}}
        for lk in ("xiang", "li", "shu"):
            te, hi, ver = self._layer_edits[lk]
            lob = layers.get(lk)
            if isinstance(lob, dict):
                te.setPlainText(str(lob.get("text", "")))
                hi.setText(str(lob.get("lockedHint", "")))
                # 层级 verified 优先；旧数据无层级 verified 时退回 rule 级
                layer_ver = str(lob.get("verified", rule_fallback_ver) or rule_fallback_ver)
                vi = ver.findText(layer_ver)
                ver.setCurrentIndex(vi if vi >= 0 else 0)
            else:
                te.setPlainText("")
                hi.setText("")
                ver.setCurrentIndex(0)
        self._refresh_rule_fragments_sidebar()
        self._rule_snapshot = self._rule_ui_state()

    def _refresh_rule_fragments_sidebar(self) -> None:
        self._rule_frag_list.clear()
        rules = self._model.rules_data.get("rules", [])
        if self._rule_idx < 0 or self._rule_idx >= len(rules):
            return
        rid = str(rules[self._rule_idx].get("id", "")).strip()
        if not rid:
            return
        for i, fr in enumerate(self._model.rules_data.get("fragments", [])):
            if str(fr.get("ruleId", "")).strip() != rid:
                continue
            raw = (fr.get("text", "") or "").replace("\n", " ").strip()
            snippet = raw[:40] + ("…" if len(raw) > 40 else "")
            lay = str(fr.get("layer", "?"))
            it = QListWidgetItem(f"{fr.get('id', '?')}  [{lay}]  {snippet}")
            it.setData(Qt.ItemDataRole.UserRole, i)
            self._rule_frag_list.addItem(it)

    def _current_sidebar_frag_index(self) -> int | None:
        item = self._rule_frag_list.currentItem()
        if not item:
            return None
        v = item.data(Qt.ItemDataRole.UserRole)
        return int(v) if v is not None else None

    def _on_rule_frag_sidebar_activated(self, item: QListWidgetItem) -> None:
        v = item.data(Qt.ItemDataRole.UserRole)
        if v is None:
            return
        self._jump_to_fragments_tab(frag_index=int(v))

    def _open_selected_sidebar_frag_in_tab(self) -> None:
        idx = self._current_sidebar_frag_index()
        if idx is None:
            return
        self._jump_to_fragments_tab(frag_index=idx)

    def _add_frag_for_current_rule(self) -> None:
        rules = self._model.rules_data.get("rules", [])
        if self._rule_idx < 0 or self._rule_idx >= len(rules):
            return
        rid = str(rules[self._rule_idx].get("id", "")).strip()
        if not rid:
            return
        self._commit_pending_edits()
        frags = self._model.rules_data.setdefault("fragments", [])
        new_id = self._unique_id("frag", (f.get("id", "") for f in frags))
        frags.append({
            "id": new_id,
            "text": "",
            "ruleId": rid,
            "layer": "xiang",
            "source": "",
        })
        self._model.mark_dirty("rules")
        self._refresh()
        self._jump_to_fragments_tab(frag_index=len(frags) - 1, filter_rule_id=rid)

    def _jump_to_fragments_tab(
        self,
        frag_index: int | None = None,
        *,
        filter_rule_id: str | None = None,
    ) -> None:
        self._frag_rule_filter.blockSignals(True)
        try:
            if filter_rule_id:
                fi = self._frag_rule_filter.findData(filter_rule_id)
                if fi >= 0:
                    self._frag_rule_filter.setCurrentIndex(fi)
            elif frag_index is not None:
                frags = self._model.rules_data.get("fragments", [])
                if 0 <= frag_index < len(frags):
                    rid = str(frags[frag_index].get("ruleId", "")).strip()
                    if rid:
                        fi = self._frag_rule_filter.findData(rid)
                        if fi >= 0:
                            self._frag_rule_filter.setCurrentIndex(fi)
        finally:
            self._frag_rule_filter.blockSignals(False)
        self._sync_frag_add_button_enabled()
        self._refresh_frag_list()
        self._tabs.setCurrentIndex(1)
        if frag_index is not None:
            for row in range(self._frag_list.count()):
                it = self._frag_list.item(row)
                if it and it.data(Qt.ItemDataRole.UserRole) == frag_index:
                    self._frag_list.setCurrentRow(row)
                    break

    def _restore_frag_row_by_global_index(self, frag_index: int) -> None:
        if frag_index < 0:
            return
        # 不 blockSignals：必须让 _on_frag_select 正常重载表单/_frag_idx/快照。
        # 旧实现只恢复高亮，_frag_idx 停在 -1、表单空——继续输入再 Apply 全被
        # 静默丢弃（审查 P0-4）。_suppress_commit 防恢复期间重入提交。
        prev_sup = self._suppress_commit
        self._suppress_commit = True
        try:
            for row in range(self._frag_list.count()):
                it = self._frag_list.item(row)
                if it and it.data(Qt.ItemDataRole.UserRole) == frag_index:
                    self._frag_list.setCurrentRow(row)
                    return
        finally:
            self._suppress_commit = prev_sup

    def _commit_pending_edits(self) -> None:
        """新增/删除/刷新前静默提交未应用编辑（commit-on-leave 语义，防 _refresh 丢编辑）。"""
        if self._is_dirty_frag():
            prev = self._suppress_commit
            self._suppress_commit = True
            try:
                self._apply_frag(refresh=False)
            finally:
                self._suppress_commit = prev
        if self._is_dirty_rule():
            prev = self._suppress_commit
            self._suppress_commit = True
            try:
                self._apply_rule()
            finally:
                self._suppress_commit = prev

    def _apply_rule(self) -> None:
        rules = self._model.rules_data.get("rules", [])
        if self._rule_idx < 0 or self._rule_idx >= len(rules):
            return
        r = rules[self._rule_idx]
        prev_id = str(r.get("id", "")).strip()
        new_id = self._r_id.text().strip()
        if not new_id:
            new_id = prev_id  # 空 id 不接受：保留原 id
        elif new_id != prev_id and any(
            str(o.get("id", "")).strip() == new_id
            for j, o in enumerate(rules) if j != self._rule_idx
        ):
            QMessageBox.warning(
                self, "规矩 id",
                f"id「{new_id}」与其它规矩重复，已保留原 id「{prev_id}」。")
            new_id = prev_id
        r["id"] = new_id
        self._r_id.blockSignals(True)
        self._r_id.setText(new_id)
        self._r_id.blockSignals(False)
        r["name"] = self._r_name.text()
        iname = self._r_iname.text()
        if iname:
            r["incompleteName"] = iname
        elif "incompleteName" in r:
            del r["incompleteName"]
        r["category"] = self._r_cat.currentText()
        new_layers: dict = {}
        for lk in ("xiang", "li", "shu"):
            te, hi, ver = self._layer_edits[lk]
            t = te.toPlainText().strip()
            h = hi.text().strip()
            v = ver.currentText()
            if not t and not h:
                continue
            entry: dict = {}
            if t:
                entry["text"] = te.toPlainText()
            if h:
                entry["lockedHint"] = hi.text()
            if v:
                entry["verified"] = v
            new_layers[lk] = entry
        if not new_layers:
            new_layers = {"xiang": {"text": "", "verified": "unverified"}}
        r["layers"] = new_layers
        for k in ("description", "source", "sourceType", "fragmentCount", "verified"):
            r.pop(k, None)
        self._model.mark_dirty("rules")
        rid = str(r.get("id", "")).strip()
        # 改名级联：碎片 ruleId 跟随规矩 id，否则碎片链路悬垂断裂（审查 P1）
        if rid and prev_id and rid != prev_id:
            for fr in self._model.rules_data.get("fragments", []):
                if str(fr.get("ruleId", "")).strip() == prev_id:
                    fr["ruleId"] = rid
        lw = self._rule_list.item(self._rule_idx)
        if lw is not None:
            lw.setText(f"{r.get('id', '?')}  [{r.get('name', '')}]")
        self._refresh_rule_fragments_sidebar()
        if rid != prev_id:
            self._populate_frag_rule_filter()
        saved_frag = self._frag_idx
        self._refresh_frag_list()
        self._restore_frag_row_by_global_index(saved_frag)

    @staticmethod
    def _unique_id(prefix: str, existing_ids) -> str:
        taken = {str(i) for i in existing_ids}
        n = 0
        while f"{prefix}_{n}" in taken:
            n += 1
        return f"{prefix}_{n}"

    def _add_rule(self) -> None:
        self._commit_pending_edits()
        rules = self._model.rules_data.setdefault("rules", [])
        rules.append({
            "id": self._unique_id("rule", (r.get("id", "") for r in rules)),
            "name": "New Rule", "category": "ward",
            "layers": {"xiang": {"text": "", "verified": "unverified"}},
        })
        self._model.mark_dirty("rules")
        self._refresh()

    def _del_rule(self) -> None:
        rules = self._model.rules_data.get("rules", [])
        if 0 <= self._rule_idx < len(rules):
            if not confirm.confirm_delete(self, f"规矩「{rules[self._rule_idx].get('id', '')}」"):
                return
            rules.pop(self._rule_idx)
            self._rule_idx = -1
            self._model.mark_dirty("rules")
            self._refresh()

    # ---- fragments tab ----------------------------------------------------

    def _build_fragments_tab(self) -> QWidget:
        w = QWidget()
        lay = QHBoxLayout(w)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        ll.addWidget(QLabel("筛选 ruleId（与 Rules 页联动）"))
        self._frag_rule_filter = QComboBox()
        self._frag_rule_filter.currentIndexChanged.connect(self._on_frag_filter_changed)
        ll.addWidget(self._frag_rule_filter)
        btn_row = QHBoxLayout()
        self._btn_add_frag = QPushButton("+ Fragment")
        self._btn_add_frag.clicked.connect(self._add_frag)
        btn_del = QPushButton("Delete")
        btn_del.setToolTip("删除选中的碎片（Delete 键亦可）")
        btn_del.clicked.connect(self._del_frag)
        btn_row.addWidget(self._btn_add_frag); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._frag_search = QLineEdit()
        self._frag_search.setPlaceholderText("搜索…")
        self._frag_search.setToolTip("按 id / 文本 / 归属规矩过滤下方列表（仅隐藏不匹配项，不改数据）")
        self._frag_search.setClearButtonEnabled(True)
        self._frag_search.textChanged.connect(self._on_frag_search_changed)
        ll.addWidget(self._frag_search)
        self._frag_list = QListWidget()
        self._frag_list.currentRowChanged.connect(self._on_frag_select)
        self._frag_list.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._frag_list.customContextMenuRequested.connect(self._show_frag_list_menu)
        self._frag_list.installEventFilter(self)
        ll.addWidget(self._frag_list)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        f = compact_form(QFormLayout(detail))
        self._f_id = QLineEdit(); f.addRow("id", self._f_id)
        self._f_text = RichTextTextEdit(self._model)
        self._f_text.setMinimumHeight(72)
        self._f_text.setMaximumHeight(180)
        f.addRow("text", self._f_text)
        self._f_rule_display = QLineEdit()
        self._f_rule_display.setReadOnly(True)
        self._f_rule_display.setPlaceholderText("（由左侧「筛选 ruleId」或 Rules 页关联新增决定，此处不可改）")
        tip = QLabel("ruleId（只读）")
        tip.setToolTip(
            "碎片归属的规矩由左侧下拉筛选或 Rules 页「+ 新增关联碎片」固定；"
            "若需改归属请删除本碎片后在正确规矩下新建。",
        )
        f.addRow(tip, self._f_rule_display)
        self._f_layer = QComboBox()
        self._f_layer.addItems(["xiang", "li", "shu"])
        f.addRow("layer", self._f_layer)
        self._f_src = RichTextLineEdit(self._model); f.addRow("source", self._f_src)
        apply_btn = QPushButton("Apply"); f.addRow(apply_btn)
        apply_btn.clicked.connect(self._apply_frag)
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([250, 500])
        lay.addWidget(splitter)
        self._frag_idx = -1
        self._sync_frag_add_button_enabled()
        return w

    def _sync_frag_add_button_enabled(self) -> None:
        ok = self._filter_rule_id() is not None
        self._btn_add_frag.setEnabled(ok)
        self._btn_add_frag.setToolTip(
            "" if ok else "请先在上方选择具体规矩；「全部规矩」下不可新增碎片。",
        )

    def _on_frag_filter_changed(self, _idx: int) -> None:
        if not self._suppress_commit and self._is_dirty_frag():
            prev_sup = self._suppress_commit
            self._suppress_commit = True
            try:
                self._apply_frag(refresh=False)
            finally:
                self._suppress_commit = prev_sup
        self._frag_idx = -1
        self._sync_frag_add_button_enabled()
        self._refresh_frag_list()

    def _populate_frag_rule_filter(self) -> None:
        prev = self._frag_rule_filter.currentData()
        self._frag_rule_filter.blockSignals(True)
        self._frag_rule_filter.clear()
        self._frag_rule_filter.addItem("（全部规矩）", "")
        for rid, label in self._model.all_rule_ids():
            self._frag_rule_filter.addItem(f"{rid} — {label}", rid)
        self._frag_rule_filter.blockSignals(False)
        if prev:
            fi = self._frag_rule_filter.findData(prev)
            if fi >= 0:
                self._frag_rule_filter.setCurrentIndex(fi)
        self._sync_frag_add_button_enabled()

    def _filter_rule_id(self) -> str | None:
        d = self._frag_rule_filter.currentData()
        if not d:
            return None
        s = str(d).strip()
        return s if s else None

    def _refresh_frag_list(self) -> None:
        self._frag_list.clear()
        frags = self._model.rules_data.get("fragments", [])
        filt = self._filter_rule_id()
        for i, fr in enumerate(frags):
            rid = str(fr.get("ruleId", "")).strip()
            if filt is not None and rid != filt:
                continue
            rname = self._rule_display_name(rid)
            lay = str(fr.get("layer", "?"))
            line = f"{fr.get('id', '?')}  [{lay}]  {rid}"
            if rname and rname != rid:
                line += f" — {rname}"
            it = QListWidgetItem(line)
            it.setData(Qt.ItemDataRole.UserRole, i)
            self._frag_list.addItem(it)
        if getattr(self, "_frag_search", None) is not None:
            self._on_frag_search_changed(self._frag_search.text())

    def _rule_display_name(self, rule_id: str) -> str:
        if not rule_id:
            return ""
        for r in self._model.rules_data.get("rules", []):
            if str(r.get("id", "")).strip() == rule_id:
                return str(r.get("name", rule_id))
        return rule_id

    def _on_frag_select(self, row: int) -> None:
        # commit-on-leave：切走前提交上一条碎片的未应用编辑（对齐规矩侧 _on_rule_select）
        if not self._suppress_commit and self._is_dirty_frag():
            prev_sup = self._suppress_commit
            self._suppress_commit = True
            try:
                self._apply_frag(refresh=False)
            finally:
                self._suppress_commit = prev_sup
        if row < 0:
            self._frag_idx = -1
            self._f_id.clear()
            self._f_text.clear()
            self._f_rule_display.clear()
            self._f_layer.setCurrentIndex(0)
            self._f_src.clear()
            return
        item = self._frag_list.item(row)
        if item is None:
            self._frag_idx = -1
            self._f_rule_display.clear()
            return
        vi = item.data(Qt.ItemDataRole.UserRole)
        if vi is None:
            self._frag_idx = -1
            self._f_rule_display.clear()
            return
        i = int(vi)
        frags = self._model.rules_data.get("fragments", [])
        if i < 0 or i >= len(frags):
            self._frag_idx = -1
            self._f_rule_display.clear()
            return
        self._frag_idx = i
        fr = frags[i]
        self._f_id.setText(fr.get("id", ""))
        self._f_text.setPlainText(fr.get("text", ""))
        rid = str(fr.get("ruleId", "")).strip()
        if rid:
            rname = self._rule_display_name(rid)
            self._f_rule_display.setText(f"{rid}  [{rname}]" if rname != rid else rid)
        else:
            self._f_rule_display.clear()
        lv = str(fr.get("layer", "xiang"))
        layer_i = self._f_layer.findText(lv)
        self._f_layer.setCurrentIndex(layer_i if layer_i >= 0 else 0)
        self._f_src.setText(fr.get("source", ""))
        self._frag_snapshot = self._frag_ui_state()

    def _apply_frag(self, refresh: bool = True) -> None:
        frags = self._model.rules_data.get("fragments", [])
        if self._frag_idx < 0 or self._frag_idx >= len(frags):
            return
        fr = frags[self._frag_idx]
        fr["id"] = self._f_id.text().strip()
        fr["text"] = self._f_text.toPlainText()
        fr["layer"] = self._f_layer.currentText()
        fr.pop("index", None)
        src = self._f_src.text()
        if src:
            fr["source"] = src
        elif "source" in fr:
            del fr["source"]
        self._model.mark_dirty("rules")
        if refresh:
            saved_frag = self._frag_idx
            self._refresh_frag_list()
            self._restore_frag_row_by_global_index(saved_frag)
            self._refresh_rule_fragments_sidebar()
        else:
            # commit-on-leave 路径：就地更新该碎片行标签，不重建列表（防重入丢选中）
            for row in range(self._frag_list.count()):
                it = self._frag_list.item(row)
                if it is not None and it.data(Qt.ItemDataRole.UserRole) == self._frag_idx:
                    raw = (fr.get("text", "") or "").replace("\n", " ").strip()
                    lay0 = str(fr.get("layer", "?"))
                    rid0 = str(fr.get("ruleId", "")).strip()
                    it.setText(f"{fr.get('id', '?')}  [{lay0}]  {rid0}")
                    break
            self._refresh_rule_fragments_sidebar()

    def _add_frag(self) -> None:
        rid0 = self._filter_rule_id()
        if not rid0:
            return
        self._commit_pending_edits()
        frags = self._model.rules_data.setdefault("fragments", [])
        default_rid = rid0
        frags.append({
            "id": self._unique_id("frag", (f.get("id", "") for f in frags)),
            "text": "",
            "ruleId": default_rid,
            "layer": "xiang",
            "source": "",
        })
        self._model.mark_dirty("rules")
        self._refresh()

    def _del_frag(self) -> None:
        frags = self._model.rules_data.get("fragments", [])
        if 0 <= self._frag_idx < len(frags):
            if not confirm.confirm_delete(self, f"规矩碎片「{frags[self._frag_idx].get('id', '')}」"):
                return
            frags.pop(self._frag_idx)
            self._frag_idx = -1
            self._model.mark_dirty("rules")
            self._refresh()

    # ---- list affordances (context menu + Delete key) ---------------------

    def eventFilter(self, obj, event):
        # Delete 键删除选中的规矩 / 碎片，复用既有删除处理（含确认），不另写删除逻辑。
        if event.type() == QEvent.Type.KeyPress and event.key() in (
            Qt.Key.Key_Delete, Qt.Key.Key_Backspace,
        ):
            if obj is self._rule_list and 0 <= self._rule_idx:
                self._del_rule()
                return True
            if obj is self._frag_list and 0 <= self._frag_idx:
                self._del_frag()
                return True
        return super().eventFilter(obj, event)

    def _on_rule_search_changed(self, text: str) -> None:
        # 纯视图过滤：只 setHidden，不改/不重排任何数据。
        q = (text or "").strip().lower()
        for row in range(self._rule_list.count()):
            it = self._rule_list.item(row)
            if it is None:
                continue
            it.setHidden(bool(q) and q not in it.text().lower())

    def _on_frag_search_changed(self, text: str) -> None:
        # 纯视图过滤：只 setHidden，不改/不重排任何数据。
        q = (text or "").strip().lower()
        for row in range(self._frag_list.count()):
            it = self._frag_list.item(row)
            if it is None:
                continue
            it.setHidden(bool(q) and q not in it.text().lower())

    def _show_rule_list_menu(self, pos) -> None:
        item = self._rule_list.itemAt(pos)
        if item is not None:
            self._rule_list.setCurrentItem(item)
        menu = QMenu(self._rule_list)
        act_add = menu.addAction("+ Rule")
        act_del = menu.addAction("删除")
        act_del.setEnabled(0 <= self._rule_idx)
        chosen = menu.exec(self._rule_list.viewport().mapToGlobal(pos))
        if chosen is act_add:
            self._add_rule()
        elif chosen is act_del:
            self._del_rule()

    def _show_frag_list_menu(self, pos) -> None:
        item = self._frag_list.itemAt(pos)
        if item is not None:
            self._frag_list.setCurrentItem(item)
        menu = QMenu(self._frag_list)
        act_add = menu.addAction("+ Fragment")
        act_add.setEnabled(self._btn_add_frag.isEnabled())
        act_del = menu.addAction("删除")
        act_del.setEnabled(0 <= self._frag_idx)
        chosen = menu.exec(self._frag_list.viewport().mapToGlobal(pos))
        if chosen is act_add:
            self._add_frag()
        elif chosen is act_del:
            self._del_frag()

    def _refresh(self) -> None:
        saved_rule = self._rule_idx
        saved_frag = self._frag_idx

        self._rule_list.clear()
        for r in self._model.rules_data.get("rules", []):
            self._rule_list.addItem(f"{r.get('id', '?')}  [{r.get('name', '')}]")
        if 0 <= saved_rule < self._rule_list.count():
            self._rule_list.setCurrentRow(saved_rule)
        elif self._rule_list.count() > 0:
            self._rule_list.setCurrentRow(0)
        else:
            self._rule_idx = -1
            self._rule_frag_list.clear()

        if getattr(self, "_rule_search", None) is not None:
            self._on_rule_search_changed(self._rule_search.text())

        self._populate_frag_rule_filter()
        self._refresh_frag_list()
        if saved_frag >= 0:
            for row in range(self._frag_list.count()):
                it = self._frag_list.item(row)
                if it and it.data(Qt.ItemDataRole.UserRole) == saved_frag:
                    self._frag_list.setCurrentRow(row)
                    break
        else:
            self._frag_list.setCurrentRow(-1)
            self._frag_idx = -1

        self._refresh_rule_fragments_sidebar()
