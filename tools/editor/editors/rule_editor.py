"""Rules and fragments editor."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget, QTabWidget,
    QFormLayout, QLineEdit, QComboBox, QPushButton, QSpinBox,
    QScrollArea, QLabel,
)
from PySide6.QtCore import Qt

from ..project_model import ProjectModel
from ..shared.id_ref_selector import IdRefSelector
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
        ll.addWidget(self._rule_list)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        f = QFormLayout(detail)
        self._r_id = QLineEdit(); f.addRow("id", self._r_id)
        self._r_name = RichTextLineEdit(self._model); f.addRow("name", self._r_name)
        self._r_iname = RichTextLineEdit(self._model); f.addRow("incompleteName", self._r_iname)
        self._r_cat = QComboBox()
        self._r_cat.addItems(["ward", "taboo", "jargon", "streetwise"])
        f.addRow("category", self._r_cat)
        self._r_desc = RichTextTextEdit(self._model); self._r_desc.setMaximumHeight(100)
        f.addRow("description", self._r_desc)
        self._r_src = RichTextLineEdit(self._model); f.addRow("source", self._r_src)
        self._r_stype = QComboBox()
        self._r_stype.addItems(["npc", "fragment", "experience"])
        f.addRow("sourceType", self._r_stype)
        self._r_ver = QComboBox()
        self._r_ver.addItems(["unverified", "effective", "questionable"])
        f.addRow("verified", self._r_ver)
        self._r_fcount = QSpinBox(); self._r_fcount.setRange(0, 99)
        f.addRow("fragmentCount", self._r_fcount)
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
            return
        self._rule_idx = row
        r = rules[row]
        self._r_id.setText(r.get("id", ""))
        self._r_name.setText(r.get("name", ""))
        self._r_iname.setText(r.get("incompleteName", ""))
        self._r_cat.setCurrentText(r.get("category", "ward"))
        self._r_desc.setPlainText(r.get("description", ""))
        self._r_src.setText(r.get("source", ""))
        self._r_stype.setCurrentText(r.get("sourceType", "npc"))
        self._r_ver.setCurrentText(r.get("verified", "unverified"))
        self._r_fcount.setValue(r.get("fragmentCount", 0))

    def _apply_rule(self) -> None:
        rules = self._model.rules_data.get("rules", [])
        if self._rule_idx < 0 or self._rule_idx >= len(rules):
            return
        r = rules[self._rule_idx]
        r["id"] = self._r_id.text().strip()
        r["name"] = self._r_name.text()
        iname = self._r_iname.text()
        if iname:
            r["incompleteName"] = iname
        elif "incompleteName" in r:
            del r["incompleteName"]
        r["category"] = self._r_cat.currentText()
        r["description"] = self._r_desc.toPlainText()
        r["source"] = self._r_src.text()
        r["sourceType"] = self._r_stype.currentText()
        r["verified"] = self._r_ver.currentText()
        fc = self._r_fcount.value()
        if fc > 0:
            r["fragmentCount"] = fc
        elif "fragmentCount" in r:
            del r["fragmentCount"]
        self._model.mark_dirty("rules")
        self._refresh()

    def _add_rule(self) -> None:
        rules = self._model.rules_data.setdefault("rules", [])
        rules.append({
            "id": f"rule_{len(rules)}", "name": "New Rule", "category": "ward",
            "description": "", "source": "", "sourceType": "npc", "verified": "unverified",
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
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Fragment"); btn_add.clicked.connect(self._add_frag)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._del_frag)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
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
        self._f_rule = IdRefSelector(allow_empty=False)
        f.addRow("ruleId", self._f_rule)
        self._f_idx = QSpinBox(); self._f_idx.setRange(0, 99)
        f.addRow("index", self._f_idx)
        self._f_src = RichTextLineEdit(self._model); f.addRow("source", self._f_src)
        apply_btn = QPushButton("Apply"); f.addRow(apply_btn)
        apply_btn.clicked.connect(self._apply_frag)
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([250, 500])
        lay.addWidget(splitter)
        self._frag_idx = -1
        return w

    def _on_frag_select(self, row: int) -> None:
        frags = self._model.rules_data.get("fragments", [])
        if row < 0 or row >= len(frags):
            return
        self._frag_idx = row
        fr = frags[row]
        self._f_id.setText(fr.get("id", ""))
        self._f_text.setPlainText(fr.get("text", ""))
        self._f_rule.set_items(self._model.all_rule_ids())
        self._f_rule.set_current(fr.get("ruleId", ""))
        self._f_idx.setValue(fr.get("index", 0))
        self._f_src.setText(fr.get("source", ""))

    def _apply_frag(self) -> None:
        frags = self._model.rules_data.get("fragments", [])
        if self._frag_idx < 0 or self._frag_idx >= len(frags):
            return
        fr = frags[self._frag_idx]
        fr["id"] = self._f_id.text().strip()
        fr["text"] = self._f_text.toPlainText()
        fr["ruleId"] = self._f_rule.current_id()
        fr["index"] = self._f_idx.value()
        src = self._f_src.text()
        if src:
            fr["source"] = src
        elif "source" in fr:
            del fr["source"]
        self._model.mark_dirty("rules")
        self._refresh()

    def _add_frag(self) -> None:
        frags = self._model.rules_data.setdefault("fragments", [])
        frags.append({"id": f"frag_{len(frags)}", "text": "", "ruleId": "", "index": 0})
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
        self._rule_list.clear()
        for r in self._model.rules_data.get("rules", []):
            self._rule_list.addItem(f"{r.get('id', '?')}  [{r.get('name', '')}]")
        self._frag_list.clear()
        for fr in self._model.rules_data.get("fragments", []):
            self._frag_list.addItem(f"{fr.get('id', '?')}  -> {fr.get('ruleId', '?')}")
