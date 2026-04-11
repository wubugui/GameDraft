"""Flag Registry editor: manage static flags and view/edit patterns."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QSplitter, QListWidget,
    QLineEdit, QPushButton, QLabel,
    QScrollArea, QMessageBox, QInputDialog, QComboBox,
    QAbstractItemView, QFrame,
)
from PySide6.QtCore import Qt, Signal

from ..project_model import ProjectModel
from ..flag_registry import normalize_registry_value_type

ID_SOURCES = [
    "hotspot_any_scene", "hotspot_in_scene",
    "rule", "fragment", "quest", "item",
    "encounter", "cutscene",
    "archive_character", "archive_lore", "archive_document", "archive_book",
    "archive_book_entry",
]


class FlagRegistryEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = self._build_static_panel()
        right = self._build_patterns_panel()

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([500, 500])
        root.addWidget(splitter)

        self._refresh_static()
        self._refresh_patterns()

    def refresh_views(self) -> None:
        """Reload lists from model (e.g. after external edits)."""
        self._refresh_static()
        self._refresh_patterns()

    # ---- static flags panel -----------------------------------------------

    def _build_static_panel(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(4, 4, 4, 4)
        lay.addWidget(QLabel("<b>Static Flags</b>"))

        search_row = QHBoxLayout()
        self._search = QLineEdit()
        self._search.setPlaceholderText("Search...")
        self._search.textChanged.connect(self._filter_static)
        search_row.addWidget(self._search)
        lay.addLayout(search_row)

        self._static_list = QListWidget()
        self._static_list.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self._static_list.setSortingEnabled(True)
        lay.addWidget(self._static_list, stretch=1)

        btn_row = QHBoxLayout()
        add_btn = QPushButton("+ Add Flag")
        add_btn.clicked.connect(self._add_static)
        rename_btn = QPushButton("Rename")
        rename_btn.clicked.connect(self._rename_static)
        del_btn = QPushButton("Delete")
        del_btn.clicked.connect(self._delete_static)
        btn_row.addWidget(add_btn)
        btn_row.addWidget(rename_btn)
        btn_row.addWidget(del_btn)
        lay.addLayout(btn_row)

        type_row = QHBoxLayout()
        type_row.addWidget(QLabel("选中项值类型:"))
        self._static_type_combo = QComboBox()
        self._static_type_combo.addItems(["bool", "float", "string"])
        self._static_type_combo.currentTextChanged.connect(self._on_static_type_edited)
        type_row.addWidget(self._static_type_combo, stretch=1)
        lay.addLayout(type_row)

        self._static_list.itemSelectionChanged.connect(self._sync_static_type_ui)

        count_row = QHBoxLayout()
        self._static_count = QLabel("0 flags")
        count_row.addWidget(self._static_count)
        count_row.addStretch()
        lay.addLayout(count_row)

        return w

    def _find_static_entry(self, key: str) -> dict | None:
        for e in self._model.flag_registry.get("static") or []:
            if isinstance(e, dict) and e.get("key") == key:
                return e
        return None

    def _refresh_static(self) -> None:
        self._static_list.clear()
        statics = self._model.flag_registry.get("static") or []
        keys: list[str] = []
        for e in statics:
            if isinstance(e, dict) and e.get("key"):
                keys.append(str(e["key"]))
            elif isinstance(e, str) and e:
                keys.append(e)
        for key in sorted(keys):
            self._static_list.addItem(key)
        self._static_count.setText(f"{len(keys)} flags")
        self._filter_static(self._search.text())
        self._sync_static_type_ui()

    def _sync_static_type_ui(self) -> None:
        sel = self._static_list.selectedItems()
        if len(sel) != 1:
            self._static_type_combo.setEnabled(False)
            return
        it = sel[0]
        if it.isHidden():
            self._static_type_combo.setEnabled(False)
            return
        self._static_type_combo.setEnabled(True)
        key = it.text()
        ent = self._find_static_entry(key)
        vt = normalize_registry_value_type((ent or {}).get("valueType"))
        self._static_type_combo.blockSignals(True)
        if vt == "float":
            self._static_type_combo.setCurrentText("float")
        elif vt == "string":
            self._static_type_combo.setCurrentText("string")
        else:
            self._static_type_combo.setCurrentText("bool")
        self._static_type_combo.blockSignals(False)

    def _on_static_type_edited(self, text: str) -> None:
        sel = self._static_list.selectedItems()
        if len(sel) != 1 or not text:
            return
        key = sel[0].text()
        ent = self._find_static_entry(key)
        if not ent:
            return
        if text == "float":
            ent["valueType"] = "float"
        elif text == "string":
            ent["valueType"] = "string"
        else:
            ent["valueType"] = "bool"
        self._model.mark_dirty("flag_registry")

    def _filter_static(self, text: str) -> None:
        text = text.strip().lower()
        for i in range(self._static_list.count()):
            item = self._static_list.item(i)
            if item:
                item.setHidden(bool(text) and text not in item.text().lower())
        self._sync_static_type_ui()

    def _add_static(self) -> None:
        key, ok = QInputDialog.getText(self, "Add Flag", "Flag key:")
        if not ok or not key.strip():
            return
        key = key.strip()
        statics: list = self._model.flag_registry.setdefault("static", [])
        existing = {str(e["key"]) for e in statics if isinstance(e, dict) and e.get("key")}
        if key in existing:
            QMessageBox.information(self, "Add Flag", f"'{key}' already exists.")
            return
        statics.append({"key": key, "valueType": "bool"})
        statics.sort(key=lambda e: str(e.get("key", "")) if isinstance(e, dict) else str(e))
        self._model.mark_dirty("flag_registry")
        self._refresh_static()

    def _rename_static(self) -> None:
        items = self._static_list.selectedItems()
        if len(items) != 1:
            QMessageBox.information(self, "Rename", "Select exactly one flag to rename.")
            return
        old_key = items[0].text()
        new_key, ok = QInputDialog.getText(self, "Rename Flag", "New key:", text=old_key)
        if not ok or not new_key.strip() or new_key.strip() == old_key:
            return
        new_key = new_key.strip()
        statics: list = self._model.flag_registry.setdefault("static", [])
        keys_now = {str(e["key"]) for e in statics if isinstance(e, dict) and e.get("key")}
        if new_key in keys_now:
            QMessageBox.information(self, "Rename", f"'{new_key}' already exists.")
            return
        ent = self._find_static_entry(old_key)
        if not ent:
            return
        ent["key"] = new_key
        statics.sort(key=lambda e: str(e.get("key", "")) if isinstance(e, dict) else str(e))
        self._model.mark_dirty("flag_registry")
        self._refresh_static()

    def _delete_static(self) -> None:
        items = self._static_list.selectedItems()
        if not items:
            return
        keys = [it.text() for it in items]
        r = QMessageBox.question(
            self, "Delete Flags",
            f"Delete {len(keys)} flag(s)?\n" + "\n".join(keys[:10]),
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if r != QMessageBox.StandardButton.Yes:
            return
        statics: list = self._model.flag_registry.setdefault("static", [])
        key_set = set(keys)
        self._model.flag_registry["static"] = [
            e for e in statics
            if not (
                isinstance(e, dict) and e.get("key") in key_set
                or isinstance(e, str) and e in key_set
            )
        ]
        self._model.mark_dirty("flag_registry")
        self._refresh_static()

    # ---- patterns panel ---------------------------------------------------

    def _build_patterns_panel(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(4, 4, 4, 4)
        lay.addWidget(QLabel("<b>Patterns (template + idSource)</b>"))

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        self._patterns_container = QWidget()
        self._patterns_layout = QVBoxLayout(self._patterns_container)
        self._patterns_layout.setSpacing(6)
        scroll.setWidget(self._patterns_container)
        lay.addWidget(scroll, stretch=1)

        btn_row = QHBoxLayout()
        add_pat = QPushButton("+ Add Pattern")
        add_pat.clicked.connect(self._add_pattern)
        btn_row.addWidget(add_pat)
        btn_row.addStretch()
        self._pat_count = QLabel("0 patterns")
        btn_row.addWidget(self._pat_count)
        lay.addLayout(btn_row)

        return w

    def _refresh_patterns(self) -> None:
        while self._patterns_layout.count():
            child = self._patterns_layout.takeAt(0)
            if child.widget():
                child.widget().deleteLater()
        patterns = self._model.flag_registry.get("patterns") or []
        for i, p in enumerate(patterns):
            row = _PatternRow(i, p)
            row.changed.connect(lambda: self._on_pattern_changed())
            row.removed.connect(self._on_pattern_removed)
            self._patterns_layout.addWidget(row)
        self._patterns_layout.addStretch()
        self._pat_count.setText(f"{len(patterns)} patterns")

    def _add_pattern(self) -> None:
        patterns: list[dict] = self._model.flag_registry.setdefault("patterns", [])
        patterns.append({
            "id": "new_pattern", "prefix": "new_", "idSource": "item", "valueType": "bool",
        })
        self._model.mark_dirty("flag_registry")
        self._refresh_patterns()

    def _on_pattern_changed(self) -> None:
        new_list = []
        for i in range(self._patterns_layout.count()):
            child = self._patterns_layout.itemAt(i)
            w = child.widget() if child else None
            if isinstance(w, _PatternRow):
                new_list.append(w.to_dict())
        self._model.flag_registry["patterns"] = new_list
        self._model.mark_dirty("flag_registry")

    def _on_pattern_removed(self, row: _PatternRow) -> None:
        idx = row.index
        patterns: list[dict] = self._model.flag_registry.get("patterns") or []
        if 0 <= idx < len(patterns):
            patterns.pop(idx)
        self._model.mark_dirty("flag_registry")
        self._refresh_patterns()


class _PatternRow(QFrame):
    changed = Signal()
    removed = Signal(object)

    def __init__(self, index: int, data: dict, parent: QWidget | None = None):
        super().__init__(parent)
        self.index = index
        self.setFrameShape(QFrame.Shape.StyledPanel)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(4, 2, 4, 2)

        self._id = QLineEdit(data.get("id", ""))
        self._id.setPlaceholderText("id")
        self._id.setMaximumWidth(140)
        self._id.textChanged.connect(self.changed)

        self._prefix = QLineEdit(data.get("prefix", ""))
        self._prefix.setPlaceholderText("prefix")
        self._prefix.setMaximumWidth(160)
        self._prefix.textChanged.connect(self.changed)

        self._suffix = QLineEdit(data.get("suffix", ""))
        self._suffix.setPlaceholderText("suffix (optional)")
        self._suffix.setMaximumWidth(160)
        self._suffix.textChanged.connect(self.changed)

        self._src = QComboBox()
        self._src.setEditable(True)
        self._src.addItems(ID_SOURCES)
        self._src.setCurrentText(data.get("idSource", ""))
        self._src.setMaximumWidth(180)
        self._src.currentTextChanged.connect(self.changed)

        self._vtype = QComboBox()
        self._vtype.addItems(["bool", "float", "string"])
        raw_vt = data.get("valueType", "bool")
        if raw_vt == "int":
            raw_vt = "float"
        elif raw_vt == "str":
            raw_vt = "string"
        if raw_vt not in ("bool", "float", "string"):
            raw_vt = "bool"
        self._vtype.setCurrentText(raw_vt)
        self._vtype.setMinimumWidth(72)
        self._vtype.setMaximumWidth(96)
        self._vtype.currentTextChanged.connect(self.changed)

        del_btn = QPushButton("-")
        del_btn.setFixedWidth(28)
        del_btn.clicked.connect(lambda: self.removed.emit(self))

        lay.addWidget(QLabel("id:"))
        lay.addWidget(self._id)
        lay.addWidget(QLabel("prefix:"))
        lay.addWidget(self._prefix)
        lay.addWidget(QLabel("suffix:"))
        lay.addWidget(self._suffix)
        lay.addWidget(QLabel("idSource:"))
        lay.addWidget(self._src)
        lay.addWidget(QLabel("类型:"))
        lay.addWidget(self._vtype)
        lay.addWidget(del_btn)

    def to_dict(self) -> dict:
        d: dict = {
            "id": self._id.text().strip(),
            "prefix": self._prefix.text().strip(),
            "valueType": self._vtype.currentText(),
        }
        suf = self._suffix.text().strip()
        if suf:
            d["suffix"] = suf
        src = self._src.currentText().strip()
        if src:
            d["idSource"] = src
        return d
