import subprocess
import sys
from pathlib import Path

from PySide6.QtWidgets import (
    QMainWindow, QSplitter, QStatusBar, QMessageBox, QPushButton, QDialog,
    QVBoxLayout, QTextEdit,
)
from PySide6.QtCore import Qt, QTimer

from .model.graph_model import GameGraph
from .model.node_types import NodeType
from .parsers.project_parser import parse_project
from .canvas.graph_scene import GraphScene
from .canvas.graph_view import GraphView
from .sidebar import Sidebar
from .toolbar import Toolbar
from .panels.property_stack import PropertyStack
from .serializer import save_all
from .layout_store import GraphLayoutStore


class MainWindow(QMainWindow):
    def __init__(self, project_path: str):
        super().__init__()
        self._project_path = project_path
        self._graph: GameGraph | None = None
        self._current_view = "Full Graph"
        self._layout_store = GraphLayoutStore(
            Path(project_path).resolve() / "editor_data" / "graph_layout.json"
        )
        self._layout_save_timer = QTimer(self)
        self._layout_save_timer.setSingleShot(True)
        self._layout_save_timer.timeout.connect(self._flush_layout_store)

        self.setWindowTitle(f"Graph Editor - {project_path}")
        self.resize(1600, 900)

        self._toolbar = Toolbar()
        self.addToolBar(self._toolbar)

        self._scene = GraphScene()
        self._view = GraphView(self._scene)
        self._sidebar = Sidebar()
        self._property_panel = PropertyStack()

        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(self._sidebar)
        splitter.addWidget(self._view)
        splitter.addWidget(self._property_panel)
        splitter.setSizes([220, 1000, 340])
        self.setCentralWidget(splitter)

        self._status = QStatusBar()
        self.setStatusBar(self._status)

        self._diag_btn = QPushButton("Diagnostics...")
        self._diag_btn.setMaximumWidth(120)
        self._diag_btn.clicked.connect(self._show_diagnostics)
        self._status.addPermanentWidget(self._diag_btn)

        self._toolbar.view_changed.connect(self._on_view_changed)
        self._toolbar.refresh_requested.connect(self._refresh)
        self._toolbar.layout_requested.connect(self._relayout)
        self._toolbar.filter_changed.connect(self._on_filter_changed)
        self._toolbar.full_component_changed.connect(
            self._scene.set_highlight_full_component
        )
        self._toolbar.isolate_highlight_changed.connect(
            self._scene.set_isolate_highlight
        )
        self._toolbar.save_requested.connect(self._on_save)
        self._sidebar.node_activated.connect(self._on_sidebar_activate)
        self._scene.node_selected.connect(self._on_node_selected)
        self._scene.node_deselected.connect(self._on_node_deselected)
        self._scene.node_moved.connect(self._on_node_moved_schedule_save)
        self._view.node_clicked.connect(self._on_node_selected)

        self._build_menus()

        self._refresh()

    def _build_menus(self) -> None:
        mb = self.menuBar()
        tools_menu = mb.addMenu("Tools")
        act = tools_menu.addAction("Open GameDraft Editor")
        act.triggered.connect(self._open_main_editor)

    def _open_main_editor(self) -> None:
        root = str(Path(self._project_path).resolve())
        try:
            subprocess.Popen(
                [sys.executable, "-m", "tools.editor", root],
                cwd=root,
            )
        except OSError as e:
            QMessageBox.critical(self, "GameDraft Editor", str(e))

    def _refresh(self):
        self._graph = parse_project(self._project_path)
        if self._graph:
            valid = {nd.id for nd in self._graph.all_nodes()}
            self._layout_store.prune_unknown(valid)
            self._layout_store.flush()
        self._property_panel.set_graph(self._graph)
        self._sidebar.populate(self._graph)
        self._rebuild_view()
        self._property_panel.clear_selection()
        self._update_status()

    def _rebuild_view(self, force_layout: bool = False):
        if not self._graph:
            return

        view_name = self._current_view
        saved = None if force_layout else self._layout_store.get_positions()

        if view_name == "Full Graph":
            self._scene.populate(
                self._graph,
                layout="spring",
                saved_positions=saved,
                force_layout=force_layout,
            )
        elif view_name == "Quests":
            sub = self._graph.subgraph_with_neighbors(
                {NodeType.QUEST, NodeType.QUEST_GROUP}
            )
            self._scene.populate(
                sub,
                layout="hierarchical",
                saved_positions=saved,
                force_layout=force_layout,
            )
        elif view_name == "Encounters":
            sub = self._graph.subgraph_with_neighbors({NodeType.ENCOUNTER})
            self._scene.populate(
                sub,
                layout="spring",
                saved_positions=saved,
                force_layout=force_layout,
            )
        elif view_name == "Dialogue":
            sub = self._graph.subgraph_with_neighbors({NodeType.DIALOGUE_GRAPH})
            self._scene.populate(
                sub,
                layout="spring",
                saved_positions=saved,
                force_layout=force_layout,
            )

        self._scene.set_highlight_full_component(
            self._toolbar.is_full_component_highlight()
        )
        self._scene.set_isolate_highlight(self._toolbar.is_isolate_highlight())
        self._scene.set_type_filter(self._toolbar.get_hidden_types())

        if force_layout:
            self._layout_save_timer.stop()
            self._layout_store.replace_all(self._scene.dump_positions())

        self._view.fit_all()

    def _relayout(self):
        self._rebuild_view(force_layout=True)

    def _on_node_moved_schedule_save(self, node_id: str, x: float, y: float):
        self._layout_store.update_position(node_id, x, y)
        self._layout_save_timer.start(450)

    def _flush_layout_store(self):
        self._layout_store.flush()

    def _on_view_changed(self, view_name: str):
        self._current_view = view_name
        self._rebuild_view()

    def _on_filter_changed(self, hidden_types: set):
        self._scene.set_type_filter(hidden_types)

    def _on_sidebar_activate(self, node_id: str):
        item = self._scene.get_node_item(node_id)
        if item:
            self._view.centerOn(item)
            self._scene.highlight_node(node_id)

    def _on_node_selected(self, node_id: str):
        if not self._graph:
            return
        nd = self._graph.get_node(node_id)
        if not nd:
            return
        self._property_panel.show_node(nd)

    def _on_node_deselected(self):
        self._property_panel.clear_selection()

    def _on_save(self):
        if not self._graph:
            return
        try:
            save_all(self._graph, self._project_path)
            self._status.showMessage("All changes saved successfully.", 3000)
        except Exception as e:
            QMessageBox.critical(self, "Save Error", str(e))

    def _update_status(self):
        if not self._graph:
            return
        self._diag_cache = self._graph.diagnostics()
        wo = len(self._diag_cache["write_only_flags"])
        ro = len(self._diag_cache["read_only_flags"])
        orphan = len(self._diag_cache["orphaned_nodes"])
        total = len(self._graph.all_nodes())
        edges = len(self._graph.all_edges())
        self._status.showMessage(
            f"Nodes: {total}  |  Edges: {edges}  |  "
            f"Write-only flags: {wo}  |  Read-only flags: {ro}  |  "
            f"Orphaned: {orphan}"
        )

    def _show_diagnostics(self):
        if not self._graph:
            return
        diag = getattr(self, "_diag_cache", None)
        if diag is None:
            diag = self._graph.diagnostics()

        lines = []
        lines.append("=== Write-Only Flags (written but never read) ===")
        for fid in diag["write_only_flags"]:
            writers = self._graph.flag_writers(fid)
            src = ", ".join(writers) if writers else "?"
            lines.append(f"  {fid}  <-  written by: {src}")

        lines.append("")
        lines.append("=== Read-Only Flags (read but never written) ===")
        for fid in diag["read_only_flags"]:
            readers = self._graph.flag_readers(fid)
            dst = ", ".join(readers) if readers else "?"
            lines.append(f"  {fid}  ->  read by: {dst}")

        lines.append("")
        lines.append("=== Orphaned Nodes (no connections) ===")
        for nid in diag["orphaned_nodes"]:
            nd = self._graph.get_node(nid)
            label = nd.label if nd else nid
            nt = nd.node_type.name if nd else "?"
            lines.append(f"  [{nt}] {nid}  ({label})")

        dlg = QDialog(self)
        dlg.setWindowTitle("Diagnostics Report")
        dlg.resize(700, 500)
        lay = QVBoxLayout(dlg)
        text = QTextEdit()
        text.setReadOnly(True)
        text.setPlainText("\n".join(lines))
        text.setStyleSheet("font-family: Consolas, monospace; font-size: 12px;")
        lay.addWidget(text)
        dlg.exec()
