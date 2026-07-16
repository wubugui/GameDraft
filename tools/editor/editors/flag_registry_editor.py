"""Flag Registry editor: manage static flags and view/edit patterns."""
from __future__ import annotations

import json

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QSplitter, QListWidget,
    QLineEdit, QPushButton, QLabel,
    QScrollArea, QMessageBox, QInputDialog, QComboBox,
    QAbstractItemView, QFrame, QMenu,
)
from PySide6.QtGui import QKeyEvent
from PySide6.QtCore import Qt, Signal, QTimer

from ..project_model import ProjectModel
from ..flag_registry import normalize_registry_value_type

ID_SOURCES = [
    "hotspot_any_scene", "hotspot_in_scene",
    "rule", "fragment", "quest", "item",
    "encounter", "cutscene",
    "archive_character", "archive_lore", "archive_document", "archive_book",
    "archive_book_entry",
]

# ---- flag key 全工程引用扫描（P1-13：Rename/Delete 引用防护） -----------------
# 使用点形状（与 validator 的 _walk_conditions/_walk_action_defs 口径一致）：
# 1. 条件叶 {"flag": key, ...}（含 all/any/not 嵌套内的叶子——generic 递归覆盖）；
# 2. setFlag/appendFlag/addFlagValue 的 params.key；
# 3. flag 映射表：game_config.startupFlags / scenario.exposes 的键；
# 4. 字符串字段：game_config.initialCutsceneDoneFlag / document_reveals[].revealedFlag。

_FLAG_KEY_ACTION_TYPES = frozenset({"setFlag", "appendFlag", "addFlagValue"})
_FLAG_MAP_KEYS = frozenset({"startupFlags", "exposes"})
_FLAG_STR_FIELD_KEYS = frozenset({"initialCutsceneDoneFlag", "revealedFlag"})


def _walk_flag_refs(node, key: str, path: str, hits: list[str],
                    new_key: str | None = None) -> None:
    """在任意 JSON 树里收集 flag key 的使用点；new_key 非 None 时就地机械替换。"""
    if isinstance(node, dict):
        if node.get("flag") == key:
            hits.append(f"{path} 条件叶.flag")
            if new_key is not None:
                node["flag"] = new_key
        t = node.get("type")
        if t in _FLAG_KEY_ACTION_TYPES:
            p = node.get("params")
            if isinstance(p, dict) and p.get("key") == key:
                hits.append(f"{path} {t}.key")
                if new_key is not None:
                    p["key"] = new_key
        for k in list(node.keys()):
            v = node[k]
            if k in _FLAG_MAP_KEYS and isinstance(v, dict) and key in v:
                hits.append(f"{path}.{k}[{key}]")
                if new_key is not None:
                    node[k] = {
                        (new_key if kk == key else kk): vv for kk, vv in v.items()
                    }
                    v = node[k]
            if k in _FLAG_STR_FIELD_KEYS and v == key:
                hits.append(f"{path}.{k}")
                if new_key is not None:
                    node[k] = new_key
                    continue
            _walk_flag_refs(v, key, f"{path}.{k}", hits, new_key)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _walk_flag_refs(v, key, f"{path}[{i}]", hits, new_key)


def _flag_ref_domains(model) -> list[tuple[str, object, str]]:
    """(路径前缀, 对象, 脏桶) —— 内存模型里可能引用 flag key 的内容域。
    scenes（按场景标脏）与对话图（磁盘 + pending 暂存面）单独处理。"""
    return [
        ("game_config", getattr(model, "game_config", None), "config"),
        ("quests", getattr(model, "quests", None), "quest"),
        ("encounters", getattr(model, "encounters", None), "encounter"),
        ("items", getattr(model, "items", None), "item"),
        ("cutscenes", getattr(model, "cutscenes", None), "cutscene"),
        ("map", getattr(model, "map_nodes", None), "map"),
        ("shops", getattr(model, "shops", None), "shop"),
        ("rules", getattr(model, "rules_data", None), "rules"),
        ("archive.characters", getattr(model, "archive_characters", None), "archive"),
        ("archive.lore", getattr(model, "archive_lore", None), "archive"),
        ("archive.books", getattr(model, "archive_books", None), "archive"),
        ("archive.documents", getattr(model, "archive_documents", None), "archive"),
        ("scenarios", getattr(model, "scenarios_catalog", None), "scenarios"),
        ("narrative", getattr(model, "narrative_graphs", None), "narrative_graphs"),
        ("pressure_holds", getattr(model, "pressure_holds", None), "pressure_holds"),
        ("signal_cues", getattr(model, "signal_cues", None), "signal_cues"),
        ("document_reveals", getattr(model, "document_reveals", None), "document_reveals"),
        ("water_minigames", getattr(model, "water_minigames_instances", None), "water_minigames"),
        ("sugar_wheel", getattr(model, "sugar_wheel_instances", None), "sugar_wheel"),
        ("paper_craft", getattr(model, "paper_craft_instances", None), "paper_craft"),
    ]


def iter_dialogue_graph_docs(model):
    """(graph_id, 图 dict, 是否来自 pending 暂存面) —— pending 优先、其余读盘。
    与 validator._validate_dialogue_graphs 同数据源；读盘失败静默跳过（只影响扫描完整性）。"""
    pend = getattr(model, "pending_dialogue_graph_edits", None) or {}
    seen: set[str] = set()
    for gid, g in pend.items():
        if isinstance(g, dict):
            seen.add(str(gid))
            yield str(gid), g, True
    try:
        graphs_dir = model.dialogues_path / "graphs"
    except (AttributeError, TypeError):
        return
    if not graphs_dir.is_dir():
        return
    for p in sorted(graphs_dir.glob("*.json")):
        if p.stem in seen:
            continue
        try:
            g = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(g, dict):
            yield p.stem, g, False


def find_flag_key_references(model, key: str) -> list[str]:
    """全工程扫描 flag key 的使用点，返回可读路径列表（只查不改）。"""
    hits: list[str] = []
    if not key:
        return hits
    for prefix, obj, _bucket in _flag_ref_domains(model):
        _walk_flag_refs(obj, key, prefix, hits)
    scenes = getattr(model, "scenes", None)
    if isinstance(scenes, dict):
        for scene_id, sc in scenes.items():
            _walk_flag_refs(sc, key, f"scene:{scene_id}", hits)
    for gid, g, _pending in iter_dialogue_graph_docs(model):
        _walk_flag_refs(g, key, f"dialogueGraph:{gid}", hits)
    return hits


def rename_flag_key_references(model, old_key: str, new_key: str) -> int:
    """把全工程对 old_key 的使用点机械替换为 new_key 并标脏对应桶，返回替换处数。
    对话图改动进 pending_dialogue_graph_edits 暂存面（Save All 时随 dirty 桶落盘）。"""
    total = 0
    if not old_key or not new_key or old_key == new_key:
        return 0
    for prefix, obj, bucket in _flag_ref_domains(model):
        hits: list[str] = []
        _walk_flag_refs(obj, old_key, prefix, hits, new_key)
        if hits:
            model.mark_dirty(bucket)
            total += len(hits)
    scenes = getattr(model, "scenes", None)
    if isinstance(scenes, dict):
        for scene_id, sc in scenes.items():
            hits = []
            _walk_flag_refs(sc, old_key, f"scene:{scene_id}", hits, new_key)
            if hits:
                model.mark_dirty("scene", str(scene_id))
                total += len(hits)
    for gid, g, _pending in iter_dialogue_graph_docs(model):
        hits = []
        _walk_flag_refs(g, old_key, f"dialogueGraph:{gid}", hits, new_key)
        if hits:
            model.pending_dialogue_graph_edits[gid] = g
            model.mark_dirty("dialogue_graph_edits")
            total += len(hits)
    return total


def _format_ref_preview(refs: list[str], limit: int = 8) -> str:
    lines = refs[:limit]
    more = f"\n…等共 {len(refs)} 处" if len(refs) > limit else ""
    return "\n".join(lines) + more


class FlagRegistryEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._suppress_data_changed = False
        self._patterns_flush_timer = QTimer(self)
        self._patterns_flush_timer.setSingleShot(True)
        self._patterns_flush_timer.setInterval(220)
        self._patterns_flush_timer.timeout.connect(self._flush_patterns_to_model)

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = self._build_static_panel()
        right = self._build_patterns_panel()

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([620, 380])
        root.addWidget(splitter)

        self._refresh_static()
        self._refresh_patterns()
        # 跨实例同步（P2）：别的面板 / FlagPickerDialog 内嵌实例改了登记表时自动刷新；
        # 自己发起的改动经 _mark_registry_dirty 抑制（否则 pattern 行编辑中被重建丢焦点）。
        data_changed = getattr(model, "data_changed", None)
        if data_changed is not None:
            data_changed.connect(self._on_model_data_changed)

    def refresh_views(self) -> None:
        """Reload lists from model (e.g. after external edits)."""
        # 防抖尾窗内的 pattern 编辑先落模型再重建行，否则重建即丢（P3）。
        self.flush_to_model()
        self._refresh_static()
        self._refresh_patterns()

    def _mark_registry_dirty(self) -> None:
        """本编辑器自己的登记表改动：标脏但抑制自家 data_changed 刷新（防重建丢焦点/选中）。"""
        self._suppress_data_changed = True
        try:
            self._model.mark_dirty("flag_registry")
        finally:
            self._suppress_data_changed = False

    def _on_model_data_changed(self, data_type: str, _item_id: str = "") -> None:
        if data_type != "flag_registry" or self._suppress_data_changed:
            return
        # 外部改动（别的面板 / 选择器内嵌实例）：刷新 static 列表并保选中；
        # patterns 仅在本实例无未提交防抖编辑时重建（保未提交编辑，P2-④）。
        selected = {it.text() for it in self._static_list.selectedItems()}
        cur_item = self._static_list.currentItem()
        cur_text = cur_item.text() if cur_item is not None else ""
        self._refresh_static()
        if selected:
            for i in range(self._static_list.count()):
                it = self._static_list.item(i)
                if it is None:
                    continue
                if it.text() in selected:
                    it.setSelected(True)
                if cur_text and it.text() == cur_text:
                    self._static_list.setCurrentItem(it)
        if not self._patterns_flush_timer.isActive():
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
        self._static_list.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._static_list.customContextMenuRequested.connect(self._show_static_menu)
        self._static_list.installEventFilter(self)
        lay.addWidget(self._static_list, stretch=1)

        btn_row = QHBoxLayout()
        add_btn = QPushButton("+ Add Flag")
        add_btn.setToolTip("新增一个静态 flag（默认 bool 类型）")
        add_btn.clicked.connect(self._add_static)
        rename_btn = QPushButton("Rename")
        rename_btn.setToolTip("重命名选中的单个 flag key")
        rename_btn.clicked.connect(self._rename_static)
        del_btn = QPushButton("Delete")
        del_btn.setToolTip("删除选中的 flag（支持多选；Delete 键 / 右键菜单亦可）")
        del_btn.clicked.connect(self._delete_static)
        btn_row.addWidget(add_btn)
        btn_row.addWidget(rename_btn)
        btn_row.addWidget(del_btn)
        lay.addLayout(btn_row)

        type_row = QHBoxLayout()
        type_row.addWidget(QLabel("选中项值类型:"))
        self._static_type_combo = QComboBox()
        self._static_type_combo.addItems(["bool", "float", "string"])
        self._static_type_combo.setToolTip("该 flag 在运行时的存储类型；仅选中单个 flag 时可改")
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

    def select_by_id(self, flag_key: str, _scene_id: str = "") -> bool:
        """全局搜索/跳转落点：在 static 注册表列表里选中指定 flag 键。
        返回 True=真选中，False=没找到（主窗按此提示"未定位"）。"""
        if self._search.text():
            self._search.clear()  # 目标行可能被过滤隐藏
        for i in range(self._static_list.count()):
            it = self._static_list.item(i)
            if it is not None and it.text() == flag_key:
                self._static_list.setCurrentRow(i)
                self._static_list.scrollToItem(it)
                return True
        return False

    def current_static_key(self) -> str:
        """当前选中的 static flag key（无则空）；供 FlagPickerDialog 停在登记页点 Ok 时取值。"""
        it = self._static_list.currentItem()
        if it is not None and not it.isHidden():
            return it.text()
        return ""

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
        self._mark_registry_dirty()

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
        self._mark_registry_dirty()
        self._refresh_static()
        # 新条目自动选中并把焦点交给 valueType（P3：加完通常紧接着改类型）。
        self.select_by_id(key)
        self._static_type_combo.setFocus()

    def _confirm_rename_with_refs(self, old_key: str, new_key: str,
                                  refs: list[str]) -> str:
        """改名引用防护决策弹窗（P1-13）。返回 "all"（连引用一起改）/
        "registry"（仅改登记，引用悬垂）/ "cancel"。独立成方法便于测试替换。"""
        box = QMessageBox(self)
        box.setWindowTitle("Rename Flag")
        box.setIcon(QMessageBox.Icon.Warning)
        box.setText(
            f"flag「{old_key}」仍被全工程 {len(refs)} 处引用：\n"
            + _format_ref_preview(refs)
        )
        box.setInformativeText(
            "「连引用一起改」把上述使用点的 key 机械替换为新名并标脏对应数据；\n"
            "「仅改登记」会让这些引用变成未登记 flag（运行时布尔化静默变义），"
            "选它请随后全局搜索旧键逐处确认。"
        )
        b_all = box.addButton("连引用一起改", QMessageBox.ButtonRole.AcceptRole)
        b_reg = box.addButton("仅改登记", QMessageBox.ButtonRole.DestructiveRole)
        box.addButton("取消", QMessageBox.ButtonRole.RejectRole)
        box.exec()
        clicked = box.clickedButton()
        if clicked is b_all:
            return "all"
        if clicked is b_reg:
            return "registry"
        return "cancel"

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
        # 引用防护（P1-13）：改键名前全工程扫引用，给「连改/仅改登记/取消」三选。
        refs = find_flag_key_references(self._model, old_key)
        rename_refs = False
        if refs:
            decision = self._confirm_rename_with_refs(old_key, new_key, refs)
            if decision == "cancel":
                return
            rename_refs = decision == "all"
        ent["key"] = new_key
        statics.sort(key=lambda e: str(e.get("key", "")) if isinstance(e, dict) else str(e))
        self._mark_registry_dirty()
        if rename_refs:
            rename_flag_key_references(self._model, old_key, new_key)
        self._refresh_static()
        self.select_by_id(new_key)

    def _delete_static(self) -> None:
        items = self._static_list.selectedItems()
        if not items:
            return
        keys = [it.text() for it in items]
        # 引用防护（P1-13）：删除（含多选批删）前逐 key 扫引用，命中则如实拦一道。
        ref_lines: list[str] = []
        total_refs = 0
        for k in keys:
            refs = find_flag_key_references(self._model, k)
            if refs:
                total_refs += len(refs)
                ref_lines.append(f"{k} ← {len(refs)} 处（如 {refs[0]}）")
        if total_refs:
            text = (
                f"选中的 flag 仍被全工程共 {total_refs} 处引用：\n"
                + _format_ref_preview(ref_lines)
                + "\n\n删除后这些引用会变成未登记 flag（运行时布尔化静默变义，校验仅 warning）。"
                  "仍要删除？"
            )
        else:
            text = f"Delete {len(keys)} flag(s)?\n" + "\n".join(keys[:10])
        r = QMessageBox.question(
            self, "Delete Flags", text,
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
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
        self._mark_registry_dirty()
        self._refresh_static()

    def _show_static_menu(self, pos) -> None:
        if not self._static_list.selectedItems():
            return
        menu = QMenu(self._static_list)
        menu.addAction("Rename", self._rename_static)
        menu.addAction("Delete", self._delete_static)
        menu.exec(self._static_list.viewport().mapToGlobal(pos))

    def eventFilter(self, obj, event):  # type: ignore[override]
        if (
            obj is self._static_list
            and isinstance(event, QKeyEvent)
            and event.type() == QKeyEvent.Type.KeyPress
            and event.key() == Qt.Key.Key_Delete
        ):
            self._delete_static()
            return True
        return super().eventFilter(obj, event)

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
        # 防抖尾窗编辑先落模型（P3）：否则随后的重建行会把 220ms 内的输入拍回旧值。
        self.flush_to_model()
        patterns: list[dict] = self._model.flag_registry.setdefault("patterns", [])
        patterns.append({
            "id": "new_pattern", "prefix": "new_", "idSource": "item", "valueType": "bool",
        })
        self._mark_registry_dirty()
        self._refresh_patterns()

    def _on_pattern_changed(self) -> None:
        self._patterns_flush_timer.start()

    def flush_to_model(self) -> bool:
        """Save All/关窗钩子：把 220ms 防抖窗口内的 pattern 编辑立即落进模型。
        没有这个钩子时，"敲完字 220ms 内 Ctrl+S/关窗"会落盘旧值甚至彻底丢编辑（审查 P1-9）。"""
        if self._patterns_flush_timer.isActive():
            self._patterns_flush_timer.stop()
            self._flush_patterns_to_model()
        return True

    def _flush_patterns_to_model(self) -> None:
        new_list = []
        for i in range(self._patterns_layout.count()):
            child = self._patterns_layout.itemAt(i)
            w = child.widget() if child else None
            if isinstance(w, _PatternRow):
                new_list.append(w.to_dict())
        self._model.flag_registry["patterns"] = new_list
        self._mark_registry_dirty()

    def _on_pattern_removed(self, row: _PatternRow) -> None:
        # 防抖尾窗编辑先落模型（P3）：删除行会重建全部行，不 flush 则其它行的
        # 220ms 内输入被拍回旧值。flush 时被删行仍在，随后按行号 pop 不受影响。
        self.flush_to_model()
        idx = row.index
        patterns: list[dict] = self._model.flag_registry.get("patterns") or []
        if 0 <= idx < len(patterns):
            patterns.pop(idx)
        self._mark_registry_dirty()
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
        del_btn.setToolTip("删除此 pattern")
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
