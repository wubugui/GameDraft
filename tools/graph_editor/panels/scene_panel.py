from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QFormLayout,
    QLineEdit,
    QSpinBox,
    QComboBox,
    QRadioButton,
    QButtonGroup,
    QHBoxLayout,
    QLabel,
)
from PySide6.QtCore import Signal

from tools.editor.project_model import ProjectModel
from tools.editor.shared.action_editor import ActionEditor, FilterableTypeCombo
from tools.editor.shared.rich_text_field import RichTextLineEdit, RichTextTextEdit

from ..model.node_types import NodeData
from .condition_editor import ConditionEditor


class ScenePanel(QWidget):
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
        self.w_spin = QSpinBox()
        self.w_spin.setRange(100, 10000)
        self.h_spin = QSpinBox()
        self.h_spin.setRange(100, 10000)

        form.addRow("ID:", self.id_edit)
        form.addRow("Name:", self.name_edit)
        form.addRow("Width:", self.w_spin)
        form.addRow("Height:", self.h_spin)
        layout.addLayout(form)
        layout.addStretch()

        self.name_edit.textChanged.connect(self._mark_dirty)
        self.w_spin.valueChanged.connect(self._mark_dirty)
        self.h_spin.valueChanged.connect(self._mark_dirty)

    def set_editor_model(self, pm: ProjectModel | None) -> None:
        if pm is None:
            return
        self._pm = pm
        self.name_edit.set_model(pm)

    def load_node(self, nd: NodeData):
        self._nd = nd
        d = nd.data
        self.id_edit.setText(d.get("id", ""))
        self.name_edit.setText(d.get("name", ""))
        self.w_spin.setValue(d.get("width", 800))
        self.h_spin.setValue(d.get("height", 600))

    def _mark_dirty(self):
        if not self._nd:
            return
        d = self._nd.data
        d["name"] = self.name_edit.text()
        d["width"] = self.w_spin.value()
        d["height"] = self.h_spin.value()
        self._nd.dirty = True
        self.data_changed.emit(self._nd.id)


class HotspotPanel(QWidget):
    data_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._nd: NodeData | None = None
        self._project_path = ""
        self._pm = ProjectModel()
        self._loading = False

        layout = QVBoxLayout(self)
        form = QFormLayout()

        self.id_edit = QLineEdit()
        self.id_edit.setReadOnly(True)
        self.type_combo = QComboBox()
        self.type_combo.addItems(["inspect", "pickup", "transition", "encounter", "npc"])
        self.label_edit = RichTextLineEdit(self._pm)
        self.x_spin = QSpinBox()
        self.x_spin.setRange(0, 10000)
        self.y_spin = QSpinBox()
        self.y_spin.setRange(0, 10000)
        self.w_spin = QSpinBox()
        self.w_spin.setRange(1, 1000)
        self.h_spin = QSpinBox()
        self.h_spin.setRange(1, 1000)
        self.range_spin = QSpinBox()
        self.range_spin.setRange(1, 500)

        form.addRow("ID:", self.id_edit)
        form.addRow("Type:", self.type_combo)
        form.addRow("Label:", self.label_edit)
        form.addRow("X:", self.x_spin)
        form.addRow("Y:", self.y_spin)
        form.addRow("Width:", self.w_spin)
        form.addRow("Height:", self.h_spin)
        form.addRow("Range:", self.range_spin)
        layout.addLayout(form)

        self._inspect_wrap = QWidget()
        iw = QVBoxLayout(self._inspect_wrap)
        iw.setContentsMargins(0, 4, 0, 0)
        iw.addWidget(QLabel("<b>inspect data</b>（纯 text与 graphId 互斥）"))
        mode_row = QHBoxLayout()
        self._insp_mode_grp = QButtonGroup(self)
        self._mode_text = QRadioButton("纯文本")
        self._mode_graph = QRadioButton("图对话 graphId")
        self._mode_text.setChecked(True)
        self._insp_mode_grp.addButton(self._mode_text)
        self._insp_mode_grp.addButton(self._mode_graph)
        mode_row.addWidget(self._mode_text)
        mode_row.addWidget(self._mode_graph)
        mode_row.addStretch()
        iw.addLayout(mode_row)
        self._inspect_text = RichTextTextEdit(self._pm)
        self._inspect_text.setPlaceholderText("inspect 纯文本模式…")
        self._inspect_text.setMaximumHeight(120)
        iw.addWidget(self._inspect_text)
        gf = QFormLayout()
        self._graph_combo = FilterableTypeCombo([], self)
        self._graph_combo.setMinimumWidth(140)
        gf.addRow("graphId", self._graph_combo)
        self._entry = QLineEdit()
        self._entry.setPlaceholderText("可选 entry 节点 id")
        gf.addRow("entry", self._entry)
        gw = QWidget()
        gw.setLayout(gf)
        self._graph_outer = gw
        iw.addWidget(gw)
        self._inspect_actions = ActionEditor("inspect actions（可选）")
        iw.addWidget(self._inspect_actions)
        layout.addWidget(self._inspect_wrap)

        self.cond_editor = ConditionEditor("Conditions（热区显示/交互条件）")
        layout.addWidget(self.cond_editor)
        layout.addStretch()

        self.type_combo.currentTextChanged.connect(self._on_hs_type_changed)
        for w in (self.label_edit,):
            w.textChanged.connect(self._mark_dirty)
        for w in (self.x_spin, self.y_spin, self.w_spin, self.h_spin, self.range_spin):
            w.valueChanged.connect(self._mark_dirty)
        self.cond_editor.changed.connect(self._mark_dirty)
        self._insp_mode_grp.buttonClicked.connect(self._on_inspect_mode)
        self._inspect_text.textChanged.connect(self._mark_dirty)
        self._graph_combo.typeCommitted.connect(lambda _t: self._mark_dirty())
        self._entry.textChanged.connect(self._mark_dirty)
        self._inspect_actions.changed.connect(self._mark_dirty)

    def set_project_path(self, project_path: str) -> None:
        self._project_path = (project_path or "").strip()

    def set_editor_model(self, pm: ProjectModel | None) -> None:
        if pm is None:
            return
        self._pm = pm
        self.label_edit.set_model(pm)
        self._inspect_text.set_model(pm)
        self.cond_editor.set_flag_pattern_context(pm, None)
        self._inspect_actions.set_project_context(pm, None)
        self._refresh_graph_ids()
        if self._nd is not None:
            self.load_node(self._nd)

    def _refresh_graph_ids(self) -> None:
        if self._pm:
            gids = self._pm.all_dialogue_graph_ids()
            self._graph_combo.set_entries([(g, g) for g in gids])
        else:
            self._graph_combo.set_entries([])

    def _sync_inspect_mode_ui(self) -> None:
        graph_on = self._mode_graph.isChecked()
        self._inspect_text.setEnabled(not graph_on)
        self._graph_outer.setVisible(graph_on)

    def _on_inspect_mode(self, _btn=None) -> None:
        self._sync_inspect_mode_ui()
        self._mark_dirty()

    def _on_hs_type_changed(self, _t: str) -> None:
        vis = self.type_combo.currentText() == "inspect"
        self._inspect_wrap.setVisible(vis)
        self._mark_dirty()

    def load_node(self, nd: NodeData):
        self._nd = nd
        d = nd.data
        self._loading = True
        try:
            self.id_edit.setText(d.get("id", ""))
            self.type_combo.setCurrentText(d.get("type", "inspect"))
            self.label_edit.setText(d.get("label", ""))
            self.x_spin.setValue(int(d.get("x", 0)))
            self.y_spin.setValue(int(d.get("y", 0)))
            self.w_spin.setValue(int(d.get("width", 40)))
            self.h_spin.setValue(int(d.get("height", 40)))
            ir = d.get("interactionRange", 80)
            self.range_spin.setValue(int(ir) if ir is not None else 80)
            self.cond_editor.set_data(d.get("conditions") or [])

            self._refresh_graph_ids()
            ht = d.get("type", "inspect")
            self._inspect_wrap.setVisible(ht == "inspect")
            data = d.get("data") if isinstance(d.get("data"), dict) else {}
            gid = str(data.get("graphId") or "").strip()
            self._mode_text.blockSignals(True)
            self._mode_graph.blockSignals(True)
            if gid:
                self._mode_graph.setChecked(True)
                self._graph_combo.set_committed_type(gid)
                self._entry.setText(str(data.get("entry") or ""))
                self._inspect_text.clear()
            else:
                self._mode_text.setChecked(True)
                self._inspect_text.setPlainText(str(data.get("text") or ""))
                gids = self._pm.all_dialogue_graph_ids() if self._pm else []
                self._graph_combo.set_committed_type(gids[0] if gids else "")
                self._entry.clear()
            self._mode_text.blockSignals(False)
            self._mode_graph.blockSignals(False)
            self._sync_inspect_mode_ui()
            self._inspect_actions.set_data(data.get("actions") or [])
        finally:
            self._loading = False

    def _mark_dirty(self):
        if not self._nd or self._loading:
            return
        d = self._nd.data
        d["type"] = self.type_combo.currentText()
        d["label"] = self.label_edit.text()
        d["x"] = self.x_spin.value()
        d["y"] = self.y_spin.value()
        d["width"] = self.w_spin.value()
        d["height"] = self.h_spin.value()
        d["interactionRange"] = self.range_spin.value()
        conds = self.cond_editor.to_list()
        if conds:
            d["conditions"] = conds
        elif "conditions" in d:
            del d["conditions"]

        if d.get("type") == "inspect":
            prev = d.get("data") if isinstance(d.get("data"), dict) else {}
            base: dict = dict(prev)
            for k in ("text", "graphId", "entry", "actions"):
                base.pop(k, None)
            if self._mode_graph.isChecked():
                gid = self._graph_combo.committed_type().strip()
                if gid:
                    base["graphId"] = gid
                ent = self._entry.text().strip()
                if ent:
                    base["entry"] = ent
            else:
                base["text"] = self._inspect_text.toPlainText()
            acts = self._inspect_actions.to_list()
            if acts:
                base["actions"] = acts
            d["data"] = base

        self._nd.dirty = True
        self.data_changed.emit(self._nd.id)


class NpcPanel(QWidget):
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
        self.x_spin = QSpinBox()
        self.x_spin.setRange(0, 10000)
        self.y_spin = QSpinBox()
        self.y_spin.setRange(0, 10000)
        self.dlg_graph_edit = QLineEdit()
        self.dlg_entry_edit = QLineEdit()
        self.range_spin = QSpinBox()
        self.range_spin.setRange(1, 500)

        form.addRow("ID:", self.id_edit)
        form.addRow("Name:", self.name_edit)
        form.addRow("X:", self.x_spin)
        form.addRow("Y:", self.y_spin)
        form.addRow("dialogueGraphId:", self.dlg_graph_edit)
        form.addRow("dialogueGraphEntry:", self.dlg_entry_edit)
        form.addRow("Range:", self.range_spin)
        layout.addLayout(form)
        layout.addStretch()

        self.name_edit.textChanged.connect(self._mark_dirty)
        self.x_spin.valueChanged.connect(self._mark_dirty)
        self.y_spin.valueChanged.connect(self._mark_dirty)
        self.dlg_graph_edit.textChanged.connect(self._mark_dirty)
        self.dlg_entry_edit.textChanged.connect(self._mark_dirty)
        self.range_spin.valueChanged.connect(self._mark_dirty)

    def set_editor_model(self, pm: ProjectModel | None) -> None:
        if pm is None:
            return
        self._pm = pm
        self.name_edit.set_model(pm)

    def load_node(self, nd: NodeData):
        self._nd = nd
        d = nd.data
        self.id_edit.setText(d.get("id", ""))
        self.name_edit.setText(d.get("name", ""))
        self.x_spin.setValue(d.get("x", 0))
        self.y_spin.setValue(d.get("y", 0))
        self.dlg_graph_edit.setText(str(d.get("dialogueGraphId", "") or ""))
        self.dlg_entry_edit.setText(str(d.get("dialogueGraphEntry", "") or ""))
        self.range_spin.setValue(d.get("interactionRange", 80))

    def _mark_dirty(self):
        if not self._nd:
            return
        d = self._nd.data
        d["name"] = self.name_edit.text()
        d["x"] = self.x_spin.value()
        d["y"] = self.y_spin.value()
        dg = self.dlg_graph_edit.text().strip()
        if dg:
            d["dialogueGraphId"] = dg
        elif "dialogueGraphId" in d:
            del d["dialogueGraphId"]
        de = self.dlg_entry_edit.text().strip()
        if de:
            d["dialogueGraphEntry"] = de
        elif "dialogueGraphEntry" in d:
            del d["dialogueGraphEntry"]
        for k in ("dialogueFile", "dialogueKnot"):
            if k in d:
                del d[k]
        d["interactionRange"] = self.range_spin.value()
        self._nd.dirty = True
        self.data_changed.emit(self._nd.id)
