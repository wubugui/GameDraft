"""图对话编辑器主窗口。"""
from __future__ import annotations

import json
import copy
from pathlib import Path

from PySide6.QtWidgets import (
    QMainWindow, QWidget, QSplitter, QListWidget, QListWidgetItem, QVBoxLayout,
    QHBoxLayout, QPushButton, QMessageBox, QFileDialog, QLabel, QLineEdit,
    QPlainTextEdit, QFormLayout, QScrollArea, QSpinBox, QGroupBox, QInputDialog,
)
from PySide6.QtCore import Qt

from .graph_document import (
    graphs_dir,
    list_graph_files,
    load_json,
    save_json,
    validate_graph,
    default_node,
    suggest_next_id,
)
from .node_inspector import NodeInspector


class MainWindow(QMainWindow):
    def __init__(self, project_path: str):
        super().__init__()
        self._project = Path(project_path).resolve()
        self._graphs_dir = graphs_dir(self._project)
        self._current_path: Path | None = None
        self._data: dict = {}
        self._dirty = False
        self._editing_node_id: str | None = None

        self.setWindowTitle("图对话编辑器")
        self.resize(1400, 820)

        root = QWidget()
        self.setCentralWidget(root)
        main_layout = QHBoxLayout(root)

        splitter = QSplitter(Qt.Orientation.Horizontal)

        # --- 文件列表 ---
        file_box = QWidget()
        fv = QVBoxLayout(file_box)
        fv.addWidget(QLabel("graphs/*.json"))
        self._file_list = QListWidget()
        self._file_list.currentItemChanged.connect(self._on_file_item_changed)
        fv.addWidget(self._file_list)
        b_refresh = QPushButton("刷新列表")
        b_refresh.clicked.connect(self._refresh_file_list)
        fv.addWidget(b_refresh)
        b_new_file = QPushButton("新建图…")
        b_new_file.clicked.connect(self._new_file)
        fv.addWidget(b_new_file)
        splitter.addWidget(file_box)

        # --- 节点列表 ---
        node_box = QWidget()
        nv = QVBoxLayout(node_box)
        nv.addWidget(QLabel("节点"))
        self._node_list = QListWidget()
        self._node_list.currentItemChanged.connect(self._on_node_item_changed)
        nv.addWidget(self._node_list)
        hb = QHBoxLayout()
        self._btn_add = QPushButton("添加节点")
        self._btn_del = QPushButton("删除")
        self._btn_dup = QPushButton("复制")
        self._btn_add.clicked.connect(self._add_node)
        self._btn_del.clicked.connect(self._delete_node)
        self._btn_dup.clicked.connect(self._duplicate_node)
        hb.addWidget(self._btn_add)
        hb.addWidget(self._btn_del)
        hb.addWidget(self._btn_dup)
        nv.addLayout(hb)
        splitter.addWidget(node_box)

        # --- 右侧：图属性 + 节点编辑 ---
        right = QWidget()
        rv = QVBoxLayout(right)
        rv.setContentsMargins(0, 0, 0, 0)

        self._graph_group = QGroupBox("图属性")
        gform = QFormLayout()
        self._spin_ver = QSpinBox()
        self._spin_ver.setRange(1, 99)
        self._spin_ver.setValue(1)
        self._edit_graph_id = QLineEdit()
        self._edit_entry = QLineEdit()
        self._btn_pick_entry = QPushButton("选")
        self._btn_pick_entry.clicked.connect(self._on_pick_entry_clicked)
        self._edit_title = QLineEdit()
        self._edit_pre = QPlainTextEdit()
        self._edit_pre.setPlaceholderText('[\n  { "flag": "some_flag", "value": true }\n]')
        self._edit_pre.setMaximumHeight(100)
        erow = QHBoxLayout()
        erow.addWidget(self._edit_entry)
        erow.addWidget(self._btn_pick_entry)
        gw = QWidget()
        gw.setLayout(erow)
        gform.addRow("schemaVersion", self._spin_ver)
        gform.addRow("id（与文件名一致）", self._edit_graph_id)
        gform.addRow("entry", gw)
        gform.addRow("标题 meta.title", self._edit_title)
        gform.addRow("preconditions（JSON）", self._edit_pre)
        self._graph_group.setLayout(gform)
        rv.addWidget(self._graph_group)

        for w in (
            self._spin_ver,
            self._edit_graph_id,
            self._edit_entry,
            self._edit_title,
        ):
            if isinstance(w, QPlainTextEdit):
                w.textChanged.connect(self._on_graph_meta_changed)
            else:
                w.textChanged.connect(self._on_graph_meta_changed)
        self._edit_pre.textChanged.connect(self._on_graph_meta_changed)

        self._inspector = NodeInspector(self._node_ids_sorted)
        self._inspector.set_change_callback(self._on_inspector_changed)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(self._inspector)
        rv.addWidget(QLabel("节点内容"), 0)
        rv.addWidget(scroll, 1)

        splitter.addWidget(right)
        splitter.setSizes([220, 260, 900])

        main_layout.addWidget(splitter)

        self._build_menu()
        self._refresh_file_list()
        self._sync_ui_enabled(False)

    def _build_menu(self):
        m = self.menuBar().addMenu("文件")
        m.addAction("打开…", self._open_file_dialog, "Ctrl+O")
        m.addAction("保存", self._save, "Ctrl+S")
        m.addAction("另存为…", self._save_as)
        m.addSeparator()
        m.addAction("退出", self.close, "Ctrl+Q")

        v = self.menuBar().addMenu("校验")
        v.addAction("检查当前图", self._run_validate)

    def _sync_ui_enabled(self, has_file: bool):
        self._graph_group.setEnabled(has_file)
        self._inspector.setEnabled(has_file)
        self._node_list.setEnabled(has_file)
        for b in (self._btn_add, self._btn_del, self._btn_dup):
            b.setEnabled(has_file)

    def _refresh_file_list(self):
        self._file_list.clear()
        for p in list_graph_files(self._project):
            item = QListWidgetItem(p.name)
            item.setData(Qt.ItemDataRole.UserRole, str(p))
            self._file_list.addItem(item)

    def _node_ids_sorted(self) -> list[str]:
        nodes = self._data.get("nodes") or {}
        return sorted(nodes.keys(), key=lambda x: (x.lower(), x))

    def _mark_dirty(self):
        self._dirty = True
        t = "图对话编辑器"
        if self._current_path:
            t += f" — {self._current_path.name}"
        if self._dirty:
            t += " *"
        self.setWindowTitle(t)

    def _load_path(self, path: Path):
        try:
            self._data = load_json(path)
        except (OSError, json.JSONDecodeError) as e:
            QMessageBox.critical(self, "打开失败", str(e))
            return
        self._current_path = path
        self._dirty = False
        self._editing_node_id = None
        self._apply_data_to_widgets()
        self._sync_ui_enabled(True)
        self._populate_node_list(select_first=True)
        self.setWindowTitle(f"图对话编辑器 — {path.name}")

    def _apply_data_to_widgets(self):
        self._spin_ver.setValue(int(self._data.get("schemaVersion", 1)))
        self._edit_graph_id.setText(str(self._data.get("id", "")))
        self._edit_entry.setText(str(self._data.get("entry", "")))
        meta = self._data.get("meta") or {}
        self._edit_title.setText(str(meta.get("title", "")))
        pre = self._data.get("preconditions")
        if pre is None:
            self._edit_pre.setPlainText("")
        else:
            try:
                self._edit_pre.setPlainText(json.dumps(pre, ensure_ascii=False, indent=2))
            except (TypeError, ValueError):
                self._edit_pre.setPlainText(str(pre))

    def _widgets_to_data_meta(self):
        self._data["schemaVersion"] = self._spin_ver.value()
        self._data["id"] = self._edit_graph_id.text().strip()
        self._data["entry"] = self._edit_entry.text().strip()
        title = self._edit_title.text().strip()
        self._data["meta"] = {"title": title} if title else {}
        raw = self._edit_pre.toPlainText().strip()
        if not raw:
            self._data["preconditions"] = []
        else:
            self._data["preconditions"] = json.loads(raw)

    def _on_graph_meta_changed(self):
        if not self._current_path:
            return
        try:
            self._widgets_to_data_meta()
        except json.JSONDecodeError:
            return
        self._mark_dirty()

    def _populate_node_list(self, select_first: bool = False):
        self._node_list.blockSignals(True)
        self._node_list.clear()
        for nid in self._node_ids_sorted():
            n = (self._data.get("nodes") or {}).get(nid, {})
            t = n.get("type", "?")
            self._node_list.addItem(f"{nid}  ({t})")
        self._node_list.blockSignals(False)
        if self._node_list.count() == 0:
            self._editing_node_id = None
            self._inspector.set_node("", {"type": "end"})
            return
        row = 0 if select_first else max(0, self._node_list.currentRow())
        self._node_list.setCurrentRow(min(row, self._node_list.count() - 1))

    def _current_node_id_from_list(self) -> str | None:
        row = self._node_list.currentRow()
        if row < 0:
            return None
        ids = self._node_ids_sorted()
        if row >= len(ids):
            return None
        return ids[row]

    def _on_file_item_changed(self, cur: QListWidgetItem | None, prev: QListWidgetItem | None):
        if not cur:
            return
        path = Path(cur.data(Qt.ItemDataRole.UserRole))
        if self._current_path and path.resolve() == self._current_path.resolve():
            return
        if self._dirty:
            r = QMessageBox.question(
                self,
                "未保存",
                "当前文件已修改，是否保存？",
                QMessageBox.StandardButton.Save
                | QMessageBox.StandardButton.Discard
                | QMessageBox.StandardButton.Cancel,
            )
            if r == QMessageBox.StandardButton.Save:
                if not self._save():
                    self._revert_file_selection(prev)
                    return
            elif r == QMessageBox.StandardButton.Cancel:
                self._revert_file_selection(prev)
                return

        self._load_path(path)

    def _revert_file_selection(self, prev: QListWidgetItem | None):
        self._file_list.blockSignals(True)
        if prev:
            self._file_list.setCurrentItem(prev)
        elif self._current_path:
            p = str(self._current_path)
            for i in range(self._file_list.count()):
                it = self._file_list.item(i)
                if it and Path(it.data(Qt.ItemDataRole.UserRole)) == self._current_path:
                    self._file_list.setCurrentItem(it)
                    break
        self._file_list.blockSignals(False)

    def _on_node_item_changed(self, _cur=None, _prev=None):
        self._apply_selected_node_to_inspector()

    def _apply_selected_node_to_inspector(self):
        nid = self._current_node_id_from_list()
        if not nid:
            self._editing_node_id = None
            return
        if nid != self._editing_node_id and self._editing_node_id:
            try:
                self._data.setdefault("nodes", {})[self._editing_node_id] = (
                    self._inspector.get_node()
                )
            except ValueError as e:
                QMessageBox.warning(self, "无法切换节点", str(e))
                self._node_list.blockSignals(True)
                ids = self._node_ids_sorted()
                if self._editing_node_id in ids:
                    self._node_list.setCurrentRow(ids.index(self._editing_node_id))
                self._node_list.blockSignals(False)
                return
        self._editing_node_id = nid
        nodes = self._data.get("nodes") or {}
        raw = copy.deepcopy(nodes.get(nid, {"type": "end"}))
        self._inspector.set_node(nid, raw)

    def _on_inspector_changed(self):
        nid = self._editing_node_id or self._current_node_id_from_list()
        if not nid or "nodes" not in self._data:
            return
        try:
            new_node = self._inspector.get_node()
        except ValueError as e:
            self.statusBar().showMessage(str(e), 5000)
            return
        self._data.setdefault("nodes", {})[nid] = new_node
        self._mark_dirty()
        self._refresh_node_list_row(nid)

    def _refresh_node_list_row(self, nid: str):
        row = self._node_list.currentRow()
        ids = self._node_ids_sorted()
        try:
            idx = ids.index(nid)
        except ValueError:
            return
        n = (self._data.get("nodes") or {}).get(nid, {})
        t = n.get("type", "?")
        self._node_list.item(idx).setText(f"{nid}  ({t})")

    def _on_pick_entry_clicked(self):
        ids = self._node_ids_sorted()
        if not ids:
            return
        c, ok = QInputDialog.getItem(self, "入口节点", "entry", ids, 0, False)
        if ok and c:
            self._edit_entry.setText(c)
            self._on_graph_meta_changed()

    def _add_node(self):
        nodes = self._data.setdefault("nodes", {})
        nid, ok = QInputDialog.getText(self, "新节点 id", "字母/数字/下划线", text=suggest_next_id(nodes))
        if not ok or not nid.strip():
            return
        nid = nid.strip()
        if nid in nodes:
            QMessageBox.warning(self, "重复", f"已存在节点 {nid!r}")
            return
        items = ["line", "runActions", "choice", "switch", "end"]
        t, ok = QInputDialog.getItem(self, "节点类型", "type", items, 0, False)
        if not ok:
            return
        nodes[nid] = default_node(t, {k: v for k, v in nodes.items() if k != nid})
        self._mark_dirty()
        self._populate_node_list()
        ids = self._node_ids_sorted()
        if nid in ids:
            self._node_list.setCurrentRow(ids.index(nid))

    def _delete_node(self):
        nid = self._current_node_id_from_list()
        if not nid:
            return
        if QMessageBox.question(self, "删除", f"删除节点 {nid!r}？") != QMessageBox.StandardButton.Yes:
            return
        nodes = self._data.get("nodes") or {}
        if nid in nodes:
            del nodes[nid]
        if self._data.get("entry") == nid:
            self._edit_entry.setText("")
        self._mark_dirty()
        self._populate_node_list(select_first=True)

    def _duplicate_node(self):
        nid = self._current_node_id_from_list()
        if not nid:
            return
        nodes = self._data.setdefault("nodes", {})
        new_id, ok = QInputDialog.getText(
            self, "复制为", "新 id", text=suggest_next_id(nodes)
        )
        if not ok or not new_id.strip():
            return
        new_id = new_id.strip()
        if new_id in nodes:
            QMessageBox.warning(self, "重复", f"已存在 {new_id!r}")
            return
        nodes[new_id] = copy.deepcopy(nodes[nid])
        self._mark_dirty()
        self._populate_node_list()
        ids = self._node_ids_sorted()
        if new_id in ids:
            self._node_list.setCurrentRow(ids.index(new_id))

    def _open_file_dialog(self):
        path, _ = QFileDialog.getOpenFileName(
            self,
            "打开图对话",
            str(self._graphs_dir),
            "JSON (*.json)",
        )
        if path:
            self._load_path(Path(path))

    def _save(self):
        if not self._current_path:
            return self._save_as()
        return self._write_to_path(self._current_path)

    def _save_as(self):
        path, _ = QFileDialog.getSaveFileName(
            self,
            "另存为",
            str(self._graphs_dir),
            "JSON (*.json)",
        )
        if not path:
            return False
        p = Path(path)
        if not p.suffix:
            p = p.with_suffix(".json")
        return self._write_to_path(p)

    def _write_to_path(self, path: Path) -> bool:
        try:
            self._widgets_to_data_meta()
        except json.JSONDecodeError as e:
            QMessageBox.critical(self, "保存失败", f"preconditions 不是合法 JSON：{e}")
            return False
        nid = self._editing_node_id or self._current_node_id_from_list()
        if nid:
            try:
                self._data.setdefault("nodes", {})[nid] = self._inspector.get_node()
            except ValueError as e:
                QMessageBox.critical(self, "保存失败", str(e))
                return False

        issues = validate_graph(self._data)
        if issues:
            txt = "\n".join(issues[:30])
            if len(issues) > 30:
                txt += f"\n… 共 {len(issues)} 条"
            r = QMessageBox.question(
                self,
                "校验有警告",
                txt + "\n\n仍要保存吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if r != QMessageBox.StandardButton.Yes:
                return False

        try:
            save_json(path, self._data)
        except OSError as e:
            QMessageBox.critical(self, "保存失败", str(e))
            return False
        self._current_path = path
        self._dirty = False
        self.setWindowTitle(f"图对话编辑器 — {path.name}")
        self.statusBar().showMessage("已保存", 3000)
        self._refresh_file_list()
        return True

    def _run_validate(self):
        if not self._data.get("nodes"):
            QMessageBox.information(self, "校验", "没有加载图。")
            return
        try:
            self._widgets_to_data_meta()
        except json.JSONDecodeError as e:
            QMessageBox.critical(self, "校验", f"preconditions：{e}")
            return
        issues = validate_graph(self._data)
        if not issues:
            QMessageBox.information(self, "校验", "未发现明显问题。")
        else:
            QMessageBox.warning(self, "校验", "\n".join(issues))

    def _new_file(self):
        if self._dirty:
            r = QMessageBox.question(
                self,
                "未保存",
                "放弃当前修改并新建？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if r != QMessageBox.StandardButton.Yes:
                return
        base = self._graphs_dir / "new_dialogue.json"
        path, _ = QFileDialog.getSaveFileName(
            self,
            "新建图对话",
            str(base),
            "JSON (*.json)",
        )
        if not path:
            return
        p = Path(path)
        if not p.suffix:
            p = p.with_suffix(".json")
        stem = p.stem
        self._data = {
            "schemaVersion": 1,
            "id": stem,
            "entry": "n_start",
            "meta": {"title": stem},
            "preconditions": [],
            "nodes": {
                "n_start": {
                    "type": "line",
                    "speaker": {"kind": "player"},
                    "text": "",
                    "next": "e_end",
                },
                "e_end": {"type": "end"},
            },
        }
        self._current_path = p
        self._dirty = True
        self._apply_data_to_widgets()
        self._sync_ui_enabled(True)
        self._populate_node_list(select_first=True)
        self._mark_dirty()
        self._save()

    def closeEvent(self, event):
        if self._dirty:
            r = QMessageBox.question(
                self,
                "退出",
                "有未保存修改，是否保存？",
                QMessageBox.StandardButton.Save
                | QMessageBox.StandardButton.Discard
                | QMessageBox.StandardButton.Cancel,
            )
            if r == QMessageBox.StandardButton.Save:
                if not self._save():
                    event.ignore()
                    return
            elif r == QMessageBox.StandardButton.Cancel:
                event.ignore()
                return
        event.accept()
