"""Rules and fragments editor."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget, QListWidgetItem,
    QTabWidget, QFormLayout, QLineEdit, QComboBox, QPushButton,
    QScrollArea, QLabel, QGroupBox,
)
from PySide6.QtCore import Qt

from ..project_model import ProjectModel
from ..shared.rich_text_field import RichTextLineEdit, RichTextTextEdit


class RuleEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model

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
        btn_add = QPushButton("+ Rule"); btn_add.clicked.connect(self._add_rule)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._del_rule)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._rule_list = QListWidget()
        self._rule_list.currentRowChanged.connect(self._on_rule_select)
        ll.addWidget(self._rule_list, stretch=1)

        link_box = QGroupBox("本规矩的碎片（双击跳转编辑）")
        link_lay = QVBoxLayout(link_box)
        self._rule_frag_list = QListWidget()
        self._rule_frag_list.setMaximumHeight(140)
        self._rule_frag_list.itemDoubleClicked.connect(self._on_rule_frag_sidebar_activated)
        link_lay.addWidget(self._rule_frag_list)
        btn_frag_row = QHBoxLayout()
        self._btn_open_frags = QPushButton("在 Fragments 页打开选中")
        self._btn_open_frags.clicked.connect(self._open_selected_sidebar_frag_in_tab)
        self._btn_add_linked_frag = QPushButton("+ 新增关联碎片")
        self._btn_add_linked_frag.setToolTip("跳到 Fragments 页并新增一条已填好 ruleId 的碎片")
        self._btn_add_linked_frag.clicked.connect(self._add_frag_for_current_rule)
        btn_frag_row.addWidget(self._btn_open_frags)
        btn_frag_row.addWidget(self._btn_add_linked_frag)
        link_lay.addLayout(btn_frag_row)
        ll.addWidget(link_box)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        f = QFormLayout(detail)
        self._r_id = QLineEdit(); f.addRow("id", self._r_id)
        self._r_name = RichTextLineEdit(self._model); f.addRow("name", self._r_name)
        self._r_iname = RichTextLineEdit(self._model); f.addRow("incompleteName", self._r_iname)
        self._r_cat = QComboBox()
        self._r_cat.addItems(["ward", "taboo", "jargon", "streetwise"])
        f.addRow("category", self._r_cat)
        self._layer_edits: dict[str, tuple[RichTextTextEdit, RichTextLineEdit, QComboBox]] = {}
        for lk, title in (("xiang", "象"), ("li", "理"), ("shu", "术")):
            gb = QGroupBox(f"层：{title}")
            gl = QFormLayout(gb)
            te = RichTextTextEdit(self._model)
            te.setMaximumHeight(100)
            hi = RichTextLineEdit(self._model)
            hi.setPlaceholderText("lockedHint（未解锁时提示，可选）")
            ver = QComboBox()
            ver.addItems(["unverified", "effective", "questionable"])
            gl.addRow("text", te)
            gl.addRow("lockedHint", hi)
            gl.addRow("verified", ver)
            f.addRow(gb)
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

    def _on_rule_select(self, row: int) -> None:
        rules = self._model.rules_data.get("rules", [])
        if row < 0 or row >= len(rules):
            self._rule_idx = -1
            self._rule_frag_list.clear()
            return
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
        frags = self._model.rules_data.setdefault("fragments", [])
        new_id = f"frag_{len(frags)}"
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
        self._frag_list.blockSignals(True)
        try:
            for row in range(self._frag_list.count()):
                it = self._frag_list.item(row)
                if it and it.data(Qt.ItemDataRole.UserRole) == frag_index:
                    self._frag_list.setCurrentRow(row)
                    return
        finally:
            self._frag_list.blockSignals(False)

    def _apply_rule(self) -> None:
        rules = self._model.rules_data.get("rules", [])
        if self._rule_idx < 0 or self._rule_idx >= len(rules):
            return
        r = rules[self._rule_idx]
        prev_id = str(r.get("id", "")).strip()
        r["id"] = self._r_id.text().strip()
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
        lw = self._rule_list.item(self._rule_idx)
        if lw is not None:
            lw.setText(f"{r.get('id', '?')}  [{r.get('name', '')}]")
        self._refresh_rule_fragments_sidebar()
        if rid != prev_id:
            self._populate_frag_rule_filter()
        saved_frag = self._frag_idx
        self._refresh_frag_list()
        self._restore_frag_row_by_global_index(saved_frag)

    def _add_rule(self) -> None:
        rules = self._model.rules_data.setdefault("rules", [])
        rules.append({
            "id": f"rule_{len(rules)}", "name": "New Rule", "category": "ward",
            "layers": {"xiang": {"text": "", "verified": "unverified"}},
        })
        self._model.mark_dirty("rules")
        self._refresh()

    def _del_rule(self) -> None:
        rules = self._model.rules_data.get("rules", [])
        if 0 <= self._rule_idx < len(rules):
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
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._del_frag)
        btn_row.addWidget(self._btn_add_frag); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._frag_list = QListWidget()
        self._frag_list.currentRowChanged.connect(self._on_frag_select)
        ll.addWidget(self._frag_list)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        f = QFormLayout(detail)
        self._f_id = QLineEdit(); f.addRow("id", self._f_id)
        self._f_text = RichTextTextEdit(self._model); self._f_text.setMaximumHeight(100)
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

    def _rule_display_name(self, rule_id: str) -> str:
        if not rule_id:
            return ""
        for r in self._model.rules_data.get("rules", []):
            if str(r.get("id", "")).strip() == rule_id:
                return str(r.get("name", rule_id))
        return rule_id

    def _on_frag_select(self, row: int) -> None:
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

    def _apply_frag(self) -> None:
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
        saved_frag = self._frag_idx
        self._refresh_frag_list()
        self._restore_frag_row_by_global_index(saved_frag)
        self._refresh_rule_fragments_sidebar()

    def _add_frag(self) -> None:
        rid0 = self._filter_rule_id()
        if not rid0:
            return
        frags = self._model.rules_data.setdefault("fragments", [])
        default_rid = rid0
        frags.append({
            "id": f"frag_{len(frags)}",
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
            frags.pop(self._frag_idx)
            self._frag_idx = -1
            self._model.mark_dirty("rules")
            self._refresh()

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
