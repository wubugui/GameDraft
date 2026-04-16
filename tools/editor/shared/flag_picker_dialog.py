"""Modal dialog: pick flag from grouped tree or quick-assemble; edit registry in-tab."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QTabWidget, QWidget, QLabel,
    QTreeWidget, QTreeWidgetItem, QLineEdit, QPushButton, QComboBox,
    QGroupBox, QFormLayout, QDialogButtonBox, QSplitter, QHeaderView,
)
from PySide6.QtCore import Qt

from ..project_model import ProjectModel
from ..flag_registry import static_key_set
from ..flag_registry import ids_for_registry_pattern_source
from ..flag_registry import normalize_registry_value_type
from ..flag_registry import registry_value_type_for_key
from ..editors.flag_registry_editor import FlagRegistryEditor


def _flag_value_type_label(vt: str | None) -> str:
    """登记表 valueType → 选择器第二列展示文案。"""
    if vt == "float":
        return "数值"
    if vt == "string":
        return "文本"
    if vt == "bool":
        return "布尔"
    return "—"


class FlagPickerDialog(QDialog):
    def __init__(
        self,
        model: ProjectModel,
        scene_id: str | None,
        initial: str = "",
        parent=None,
    ):
        super().__init__(parent)
        self.setWindowTitle("选择或登记 flag")
        self.resize(1000, 720)
        self.setModal(True)
        self._model = model
        self._scene_id = scene_id
        self._selected_key = (initial or "").strip()

        root = QVBoxLayout(self)
        self._tabs = QTabWidget()
        pick = QWidget()
        pl = QVBoxLayout(pick)
        self._search = QLineEdit()
        self._search.setPlaceholderText(
            "过滤树（分组名、flag 文本、类型：布尔 / 数值 / 文本）…",
        )
        self._search.textChanged.connect(self._filter_tree)
        pl.addWidget(self._search)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        self._tree = QTreeWidget()
        self._tree.setHeaderLabels(["分组 / flag", "类型"])
        hdr = self._tree.header()
        hdr.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        hdr.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        self._tree.setMinimumWidth(420)
        self._tree.itemDoubleClicked.connect(self._on_tree_double_click)
        splitter.addWidget(self._tree)

        right = QWidget()
        rl = QVBoxLayout(right)
        rl.addWidget(QLabel("<b>当前选用</b>"))
        self._display = QLineEdit(self._selected_key)
        self._display.setReadOnly(True)
        rl.addWidget(self._display)
        use_btn = QPushButton("选用树中焦点项")
        use_btn.clicked.connect(self._use_tree_selection)
        rl.addWidget(use_btn)

        quick = QGroupBox("快速拼装（与条件区模板相同）")
        qf = QFormLayout(quick)
        self._pat_combo = QComboBox()
        self._pat_combo.setMinimumWidth(200)
        self._id_combo = QComboBox()
        self._id_combo.setEditable(False)
        self._id_combo.setMinimumWidth(160)
        preview = QLabel("")
        preview.setWordWrap(True)
        self._preview_label = preview
        apply_quick = QPushButton("拼装并选用")
        apply_quick.clicked.connect(self._apply_quick_assemble)
        self._pat_combo.currentIndexChanged.connect(self._on_pat_changed)
        self._id_combo.currentTextChanged.connect(self._update_quick_preview)
        qf.addRow("模板", self._pat_combo)
        qf.addRow("资源 id", self._id_combo)
        qf.addRow("预览", preview)
        qf.addRow("", apply_quick)
        rl.addWidget(quick)
        rl.addStretch()
        self._populate_pattern_combo()

        splitter.addWidget(right)
        splitter.setSizes([480, 480])
        pl.addWidget(splitter)

        self._tabs.addTab(pick, "选择")
        self._reg_editor = FlagRegistryEditor(model)
        self._tabs.addTab(self._reg_editor, "编辑登记表")
        self._tabs.currentChanged.connect(self._on_tab_changed)

        root.addWidget(self._tabs)

        bb = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        bb.accepted.connect(self._accept)
        bb.rejected.connect(self.reject)
        root.addWidget(bb)

        self._rebuild_tree()

    def selected_key(self) -> str:
        return self._selected_key

    def _set_selection(self, key: str) -> None:
        self._selected_key = key.strip()
        self._display.setText(self._selected_key)

    def _accept(self) -> None:
        self._selected_key = self._display.text().strip()
        self.accept()

    def _on_tab_changed(self, idx: int) -> None:
        if idx == 0:
            self._reg_editor.refresh_views()
            self._populate_pattern_combo()
            self._rebuild_tree()

    def _populate_pattern_combo(self) -> None:
        self._pat_combo.blockSignals(True)
        self._pat_combo.clear()
        self._pat_combo.addItem("(选择模板…)", None)
        regs = self._model.flag_registry.get("patterns") or []
        for p in regs:
            if isinstance(p, dict) and p.get("id"):
                label = str(p["id"])
                pre = p.get("prefix", "")
                suf = p.get("suffix") or ""
                tlab = _flag_value_type_label(normalize_registry_value_type(p.get("valueType")))
                if suf:
                    hint = f"{label}  ({pre}…{suf})  · {tlab}"
                else:
                    hint = f"{label}  ({pre}…)  · {tlab}"
                self._pat_combo.addItem(hint, p)
        self._pat_combo.blockSignals(False)
        self._on_pat_changed(0)

    def _on_pat_changed(self, _idx: int) -> None:
        self._id_combo.blockSignals(True)
        self._id_combo.clear()
        data = self._pat_combo.currentData()
        if isinstance(data, dict) and self._model:
            src = data.get("idSource")
            ids = ids_for_registry_pattern_source(
                self._model, scene_id=self._scene_id, id_source=src,
            )
            self._id_combo.addItems(ids)
        self._id_combo.blockSignals(False)
        self._update_quick_preview()

    def _update_quick_preview(self) -> None:
        p = self._pat_combo.currentData()
        if not isinstance(p, dict):
            self._preview_label.setText("")
            return
        rid = self._id_combo.currentText().strip()
        pre = p.get("prefix", "")
        suf = p.get("suffix") or ""
        tlab = _flag_value_type_label(normalize_registry_value_type(p.get("valueType")))
        if rid:
            self._preview_label.setText(f"{pre}{rid}{suf}  · {tlab}")
        else:
            self._preview_label.setText(f"（请选择资源 id） · {tlab}")

    def _apply_quick_assemble(self) -> None:
        p = self._pat_combo.currentData()
        if not isinstance(p, dict):
            return
        rid = self._id_combo.currentText().strip()
        if not rid:
            return
        pre = p.get("prefix", "")
        suf = p.get("suffix") or ""
        self._set_selection(f"{pre}{rid}{suf}")

    def _rebuild_tree(self) -> None:
        self._tree.clear()
        reg = self._model.flag_registry

        static_root = QTreeWidgetItem(self._tree, ["静态 flag", ""])
        static_root.setData(0, Qt.ItemDataRole.UserRole, None)
        for k in sorted(static_key_set(reg)):
            vt = registry_value_type_for_key(k, reg)
            leaf = QTreeWidgetItem(static_root, [k, _flag_value_type_label(vt)])
            leaf.setData(0, Qt.ItemDataRole.UserRole, k)

        for p in reg.get("patterns") or []:
            if not isinstance(p, dict):
                continue
            pid = p.get("id") or "pattern"
            pre = p.get("prefix", "")
            suf = p.get("suffix") or ""
            src = p.get("idSource") or ""
            p_vt = normalize_registry_value_type(p.get("valueType"))
            type_lbl = _flag_value_type_label(p_vt)
            header = f"模板「{pid}」  {pre}…{suf}  [{src}]"
            proot = QTreeWidgetItem(self._tree, [header, type_lbl])
            proot.setData(0, Qt.ItemDataRole.UserRole, None)
            id_list = ids_for_registry_pattern_source(
                self._model, scene_id=self._scene_id, id_source=src,
            )
            for rid in id_list:
                key = f"{pre}{rid}{suf}"
                leaf = QTreeWidgetItem(proot, [key, type_lbl])
                leaf.setData(0, Qt.ItemDataRole.UserRole, key)

        self._tree.expandToDepth(1)
        self._filter_tree(self._search.text())

    def _filter_tree(self, text: str) -> None:
        t = text.strip().lower()
        for i in range(self._tree.topLevelItemCount()):
            top = self._tree.topLevelItem(i)
            if top is None:
                continue
            self._apply_filter_item(top, t)

    def _apply_filter_item(self, item: QTreeWidgetItem, t: str) -> bool:
        """Return True if this item or any descendant stays visible."""
        n = item.childCount()
        any_child = False
        for j in range(n):
            ch = item.child(j)
            if ch and self._apply_filter_item(ch, t):
                any_child = True
        data = item.data(0, Qt.ItemDataRole.UserRole)
        if isinstance(data, str) and data:
            if not t:
                show = True
            else:
                low0 = item.text(0).lower()
                low1 = item.text(1).lower()
                show = t in low0 or t in low1 or t in data.lower()
            item.setHidden(not show)
            return show
        show = True if not t else any_child
        item.setHidden(not show)
        return show

    def _on_tree_double_click(self, item: QTreeWidgetItem, _col: int) -> None:
        data = item.data(0, Qt.ItemDataRole.UserRole)
        if isinstance(data, str) and data:
            self._set_selection(data)

    def _use_tree_selection(self) -> None:
        it = self._tree.currentItem()
        if it is None:
            return
        data = it.data(0, Qt.ItemDataRole.UserRole)
        if isinstance(data, str) and data:
            self._set_selection(data)
