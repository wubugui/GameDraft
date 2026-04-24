from PySide6.QtWidgets import QWidget, QVBoxLayout, QFormLayout, QLineEdit, QComboBox, QGroupBox
from PySide6.QtCore import Signal
from tools.editor.project_model import ProjectModel
from tools.editor.shared.rich_text_field import RichTextLineEdit, RichTextTextEdit

from ..model.node_types import NodeData


class RulePanel(QWidget):
    data_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._nd: NodeData | None = None
        self._pm = ProjectModel()
        layout = QVBoxLayout(self)
        form = QFormLayout()

        self.id_edit = QLineEdit()
        self.id_edit.setReadOnly(True)
        self.name_edit = RichTextLineEdit(self._pm)
        self.incomplete_name_edit = RichTextLineEdit(self._pm)
        self.incomplete_name_edit.setPlaceholderText("规矩未集齐时的显示名称")
        self.cat_combo = QComboBox()
        self.cat_combo.addItems(["ward", "taboo", "jargon", "streetwise"])

        self._layer_text: dict[str, RichTextTextEdit] = {}
        self._layer_hint: dict[str, RichTextLineEdit] = {}
        self._layer_ver: dict[str, QComboBox] = {}

        form.addRow("ID:", self.id_edit)
        form.addRow("Name:", self.name_edit)
        form.addRow("Incomplete Name:", self.incomplete_name_edit)
        form.addRow("Category:", self.cat_combo)
        for lk, title in (("xiang", "象"), ("li", "理"), ("shu", "术")):
            gb = QGroupBox(f"层：{title}")
            gl = QFormLayout(gb)
            te = RichTextTextEdit(self._pm)
            te.setMaximumHeight(80)
            hi = RichTextLineEdit(self._pm)
            hi.setPlaceholderText("lockedHint（可选）")
            ver = QComboBox()
            ver.addItems(["unverified", "effective", "questionable"])
            gl.addRow("text", te)
            gl.addRow("lockedHint", hi)
            gl.addRow("verified", ver)
            form.addRow(gb)
            self._layer_text[lk] = te
            self._layer_hint[lk] = hi
            self._layer_ver[lk] = ver
        layout.addLayout(form)
        layout.addStretch()

        for w in (self.name_edit, self.incomplete_name_edit):
            w.textChanged.connect(self._mark_dirty)
        self.cat_combo.currentTextChanged.connect(self._mark_dirty)
        for lk in ("xiang", "li", "shu"):
            self._layer_text[lk].textChanged.connect(self._mark_dirty)
            self._layer_hint[lk].textChanged.connect(self._mark_dirty)
            self._layer_ver[lk].currentTextChanged.connect(self._mark_dirty)

    def set_editor_model(self, pm: ProjectModel | None) -> None:
        if pm is None:
            return
        self._pm = pm
        self.name_edit.set_model(pm)
        self.incomplete_name_edit.set_model(pm)
        for lk in ("xiang", "li", "shu"):
            self._layer_text[lk].set_model(pm)
            self._layer_hint[lk].set_model(pm)

    def load_node(self, nd: NodeData):
        self._nd = nd
        d = nd.data
        self.id_edit.setText(d.get("id", ""))
        self.name_edit.setText(d.get("name", ""))
        self.incomplete_name_edit.setText(d.get("incompleteName", ""))
        self.cat_combo.setCurrentText(d.get("category", "ward"))
        rule_fallback_ver = str(d.get("verified", "unverified") or "unverified")
        layers = d.get("layers")
        if not isinstance(layers, dict) or not layers:
            legacy = str(d.get("description", "") or "")
            layers = {"xiang": {"text": legacy}} if legacy else {"xiang": {"text": ""}}
        for lk in ("xiang", "li", "shu"):
            lob = layers.get(lk)
            ver_w = self._layer_ver[lk]
            if isinstance(lob, dict):
                self._layer_text[lk].setPlainText(str(lob.get("text", "")))
                self._layer_hint[lk].setText(str(lob.get("lockedHint", "")))
                lv = str(lob.get("verified", rule_fallback_ver) or rule_fallback_ver)
                vi = ver_w.findText(lv)
                ver_w.setCurrentIndex(vi if vi >= 0 else 0)
            else:
                self._layer_text[lk].setPlainText("")
                self._layer_hint[lk].setText("")
                ver_w.setCurrentIndex(0)

    def _mark_dirty(self):
        if not self._nd:
            return
        d = self._nd.data
        d["name"] = self.name_edit.text()
        inc_name = self.incomplete_name_edit.text()
        if inc_name:
            d["incompleteName"] = inc_name
        elif "incompleteName" in d:
            del d["incompleteName"]
        d["category"] = self.cat_combo.currentText()
        new_layers: dict = {}
        for lk in ("xiang", "li", "shu"):
            t = self._layer_text[lk].toPlainText().strip()
            h = self._layer_hint[lk].text().strip()
            v = self._layer_ver[lk].currentText()
            if not t and not h:
                continue
            entry: dict = {}
            if t:
                entry["text"] = self._layer_text[lk].toPlainText()
            if h:
                entry["lockedHint"] = self._layer_hint[lk].text()
            if v:
                entry["verified"] = v
            new_layers[lk] = entry
        if not new_layers:
            new_layers = {"xiang": {"text": "", "verified": "unverified"}}
        d["layers"] = new_layers
        for k in ("description", "source", "sourceType", "fragmentCount", "verified"):
            d.pop(k, None)
        self._nd.dirty = True
        self.data_changed.emit(self._nd.id)
