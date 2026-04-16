"""Timeline-based Cutscene editor (new steps schema).

Replaces the deprecated cutscene_editor.py. Edits NewCutsceneDef with
ActionStep / PresentStep / ParallelGroup.
"""
from __future__ import annotations

import json
from copy import deepcopy
from typing import TYPE_CHECKING

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QComboBox, QTextEdit, QPushButton, QLabel,
    QScrollArea, QCheckBox, QDoubleSpinBox, QFrame, QMessageBox,
    QDialog, QGroupBox,
)
from PySide6.QtCore import Qt, Signal

from ..project_model import ProjectModel
from ..shared.id_ref_selector import IdRefSelector
from ..shared.image_path_picker import CutsceneImagePathRow
from ..shared.action_editor import ActionRow, FilterableTypeCombo
from .scene_editor import TargetSpawnPickerDialog

if TYPE_CHECKING:
    pass

# ---------------------------------------------------------------
# Cutscene Action whitelist (must stay in sync with types.ts)
# ---------------------------------------------------------------
CUTSCENE_ACTION_WHITELIST = [
    "moveEntityTo", "faceEntity", "cutsceneSpawnActor", "cutsceneRemoveActor",
    "showEmoteAndWait", "playNpcAnimation", "setEntityEnabled",
    "playSfx", "playBgm", "stopBgm",
]

# ---------------------------------------------------------------
# Present step types and their parameter schemas
# ---------------------------------------------------------------
PRESENT_TYPES = [
    "fadeToBlack", "fadeIn", "flashWhite", "waitTime", "waitClick",
    "showTitle", "showDialogue", "showImg", "hideImg",
    "showMovieBar", "hideMovieBar", "showSubtitle",
    "cameraMove", "cameraZoom", "showCharacter",
]

_PRESENT_PARAMS: dict[str, list[tuple[str, str]]] = {
    "fadeToBlack": [("duration", "float")],
    "fadeIn": [("duration", "float")],
    "flashWhite": [("duration", "float")],
    "waitTime": [("duration", "float")],
    "waitClick": [],
    "showTitle": [("text", "text"), ("duration", "float")],
    "showDialogue": [("speaker", "str"), ("text", "text")],
    "showImg": [("id", "str"), ("image", "image")],
    "hideImg": [("id", "str")],
    "showMovieBar": [("heightPercent", "float")],
    "hideMovieBar": [],
    "showSubtitle": [("text", "text"), ("position", "str")],
    "cameraMove": [("x", "float"), ("y", "float"), ("duration", "float")],
    "cameraZoom": [("scale", "float"), ("duration", "float")],
    "showCharacter": [("visible", "bool")],
}

_MS_KEYS = frozenset({"duration"})


# ===============================================================
# StepWidget — a single step (action / present / parallel)
# ===============================================================

class StepWidget(QFrame):
    """Edits one CutsceneStep."""

    def __init__(
        self,
        step: dict,
        model: ProjectModel | None = None,
        editor: "TimelineEditor | None" = None,
        parent: QWidget | None = None,
    ):
        super().__init__(parent)
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self._model = model
        self._editor = editor
        self._widgets: dict[str, QWidget] = {}
        self._action_row: ActionRow | None = None
        self._parallel_steps: list[StepWidget] = []
        self._parallel_layout: QVBoxLayout | None = None

        kind = str(step.get("kind", "present"))
        self._step_data = deepcopy(step)
        self._original_data = deepcopy(step)

        lay = QVBoxLayout(self)
        lay.setContentsMargins(4, 4, 4, 4)

        # toolbar
        tool = QHBoxLayout()
        self._btn_up = QPushButton("\u2191")
        self._btn_up.setFixedWidth(28)
        self._btn_up.setToolTip("上移")
        self._btn_down = QPushButton("\u2193")
        self._btn_down.setFixedWidth(28)
        self._btn_down.setToolTip("下移")
        self._btn_copy = QPushButton("Copy")
        self._btn_copy.setToolTip("复制")
        self._btn_del = QPushButton("Del")
        self._btn_del.setToolTip("删除")
        tool.addWidget(self._btn_up)
        tool.addWidget(self._btn_down)
        tool.addWidget(self._btn_copy)
        tool.addWidget(self._btn_del)
        tool.addStretch(1)
        lay.addLayout(tool)

        self._btn_up.clicked.connect(lambda: self._do_move(-1))
        self._btn_down.clicked.connect(lambda: self._do_move(1))
        self._btn_copy.clicked.connect(self._do_copy)
        self._btn_del.clicked.connect(self._do_delete)

        # kind selector
        top = QHBoxLayout()
        self._kind_combo = QComboBox()
        self._kind_combo.addItem("present", "present")
        self._kind_combo.addItem("action", "action")
        self._kind_combo.addItem("parallel", "parallel")
        for i in range(self._kind_combo.count()):
            if self._kind_combo.itemData(i) == kind:
                self._kind_combo.setCurrentIndex(i)
                break
        self._kind_combo.currentIndexChanged.connect(self._on_kind_changed)
        top.addWidget(QLabel("kind:"))
        top.addWidget(self._kind_combo, stretch=1)
        lay.addLayout(top)

        # body
        self._body = QVBoxLayout()
        lay.addLayout(self._body)

        self._rebuild(kind)

    def _find_owning_list_and_layout(self):
        """Return (list, layout) that owns this StepWidget — top-level or parallel parent."""
        p = self.parentWidget()
        while p is not None:
            if isinstance(p, StepWidget) and self in p._parallel_steps:
                return p._parallel_steps, p._parallel_layout
            p = p.parentWidget()
        if self._editor is not None:
            return self._editor._step_widgets, self._editor._steps_layout
        return None, None

    def _do_move(self, delta: int) -> None:
        lst, layout = self._find_owning_list_and_layout()
        if lst is None or layout is None:
            return
        try:
            i = lst.index(self)
        except ValueError:
            return
        j = i + delta
        if j < 0 or j >= len(lst):
            return
        lst[i], lst[j] = lst[j], lst[i]
        for w in lst:
            layout.removeWidget(w)
        for w in lst:
            layout.addWidget(w)
        self._emit_dirty()

    def _do_copy(self) -> None:
        lst, layout = self._find_owning_list_and_layout()
        if lst is None or layout is None:
            return
        try:
            i = lst.index(self)
        except ValueError:
            return
        data = deepcopy(self.to_dict())
        new_w = StepWidget(data, self._model, self._editor, self.parentWidget())
        lst.insert(i + 1, new_w)
        for w in lst:
            layout.removeWidget(w)
        for w in lst:
            layout.addWidget(w)
        self._emit_dirty()

    def _do_delete(self) -> None:
        lst, layout = self._find_owning_list_and_layout()
        if lst is None:
            return
        try:
            lst.remove(self)
        except ValueError:
            return
        self.deleteLater()
        self._emit_dirty()

    def _emit_dirty(self) -> None:
        if self._editor is not None and hasattr(self._editor, "mark_pending_changes"):
            self._editor.mark_pending_changes()

    def _on_kind_changed(self) -> None:
        new_kind = self._kind_combo.currentData()
        self._step_data = {"kind": new_kind}
        if new_kind == "present":
            self._step_data["type"] = "waitClick"
        elif new_kind == "action":
            self._step_data["type"] = CUTSCENE_ACTION_WHITELIST[0]
            self._step_data["params"] = {}
        elif new_kind == "parallel":
            self._step_data["tracks"] = []
        self._rebuild(new_kind)
        self._emit_dirty()

    def _clear_body(self) -> None:
        self._widgets.clear()
        self._action_row = None
        self._parallel_steps = []
        self._parallel_layout = None
        while self._body.count() > 0:
            item = self._body.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()
            sub = item.layout()
            if sub:
                while sub.count() > 0:
                    si = sub.takeAt(0)
                    sw = si.widget()
                    if sw:
                        sw.deleteLater()

    def _rebuild(self, kind: str) -> None:
        self._clear_body()
        if kind == "present":
            self._build_present()
        elif kind == "action":
            self._build_action()
        elif kind == "parallel":
            self._build_parallel()

    # ---- present ----
    def _build_present(self) -> None:
        form = QFormLayout()
        self._type_combo = FilterableTypeCombo(
            [(t, t) for t in PRESENT_TYPES],
            orphan_label=lambda v: f"[unknown] {v}",
        )
        cur_type = str(self._step_data.get("type", "waitClick"))
        self._type_combo.set_committed_type(cur_type)
        self._type_combo.typeCommitted.connect(self._on_present_type_changed)
        form.addRow("type", self._type_combo)

        self._present_params_layout = QFormLayout()
        form_w = QWidget()
        form_w.setLayout(form)
        self._body.addWidget(form_w)
        params_w = QWidget()
        params_w.setLayout(self._present_params_layout)
        self._body.addWidget(params_w)

        self._rebuild_present_params(cur_type)

    def _on_present_type_changed(self) -> None:
        new_type = self._type_combo.committed_type()
        self._step_data = {"kind": "present", "type": new_type}
        self._rebuild_present_params(new_type)
        self._emit_dirty()

    def _rebuild_present_params(self, ptype: str) -> None:
        while self._present_params_layout.rowCount() > 0:
            self._present_params_layout.removeRow(0)
        self._widgets.clear()

        schema = _PRESENT_PARAMS.get(ptype, [])
        for pname, pt in schema:
            val = self._step_data.get(pname, "")
            label = f"{pname} (ms)" if pt == "float" and pname in _MS_KEYS else pname
            if pt == "float":
                w = QDoubleSpinBox()
                w.setRange(-99999, 99999)
                w.setDecimals(2)
                w.setValue(float(val) if val != "" else 0)
                w.valueChanged.connect(self._emit_dirty)
            elif pt == "bool":
                w = QCheckBox()
                w.setChecked(bool(val) if val != "" else True)
                w.toggled.connect(self._emit_dirty)
            elif pt == "text":
                w = QTextEdit(str(val))
                w.setMaximumHeight(50)
                w.textChanged.connect(self._emit_dirty)
            elif pt == "image":
                w = CutsceneImagePathRow(self._model, str(val) if val else "", self)
                w.setMinimumWidth(360)
                w._edit.textChanged.connect(self._emit_dirty)
            else:
                w = QLineEdit(str(val) if val else "")
                w.textChanged.connect(self._emit_dirty)
            self._widgets[pname] = w
            self._present_params_layout.addRow(label, w)

    # ---- action ----
    def _build_action(self) -> None:
        ad = {
            "type": str(self._step_data.get("type", CUTSCENE_ACTION_WHITELIST[0])),
            "params": dict(self._step_data.get("params") or {}),
        }
        self._action_row = ActionRow(
            ad,
            model=self._model,
            scene_id=None,
            show_delete_button=False,
            show_reorder_buttons=False,
            parent=self,
        )
        wl_set = set(CUTSCENE_ACTION_WHITELIST)
        self._action_row.type_combo.set_items(
            [(t, t) for t in CUTSCENE_ACTION_WHITELIST],
            orphan_label=lambda v: f"[not whitelisted] {v}",
        )
        ct = ad["type"]
        if ct in wl_set:
            self._action_row.type_combo.set_committed_type(ct)
        self._action_row.changed.connect(self._emit_dirty)
        self._body.addWidget(self._action_row)

    # ---- parallel ----
    def _build_parallel(self) -> None:
        group = QGroupBox("Parallel tracks")
        self._parallel_layout = QVBoxLayout(group)
        self._parallel_layout.setSpacing(4)
        tracks = self._step_data.get("tracks", []) or []
        for t in tracks:
            sw = StepWidget(t, self._model, self._editor, self)
            self._parallel_steps.append(sw)
            self._parallel_layout.addWidget(sw)
        add_btn = QPushButton("+ Track")
        add_btn.clicked.connect(self._add_parallel_track)
        self._parallel_layout.addWidget(add_btn)
        self._body.addWidget(group)

    def _add_parallel_track(self) -> None:
        sw = StepWidget({"kind": "present", "type": "waitTime", "duration": 1000},
                        self._model, self._editor, self)
        self._parallel_steps.append(sw)
        if self._parallel_layout:
            self._parallel_layout.insertWidget(
                self._parallel_layout.count() - 1, sw)
        self._emit_dirty()

    # ---- serialization ----
    def to_dict(self) -> dict:
        kind = self._kind_combo.currentData()

        if kind == "action" and self._action_row is not None:
            ad = self._action_row.to_dict()
            return {"kind": "action", "type": ad["type"], "params": ad.get("params", {})}

        if kind == "present":
            ptype = self._type_combo.committed_type()
            schema = _PRESENT_PARAMS.get(ptype, [])
            if not schema and ptype not in PRESENT_TYPES:
                base = deepcopy(self._original_data) if self._original_data.get("kind") == "present" else {}
                base["kind"] = "present"
                base["type"] = ptype
                return base
            d: dict = {"kind": "present", "type": ptype}
            for pname, pt in schema:
                w = self._widgets.get(pname)
                if w is None:
                    continue
                if pt == "float":
                    d[pname] = w.value()
                elif pt == "bool":
                    d[pname] = w.isChecked()
                elif pt == "text":
                    d[pname] = w.toPlainText()
                elif pt == "image" and isinstance(w, CutsceneImagePathRow):
                    d[pname] = w.path()
                else:
                    d[pname] = w.text() if hasattr(w, "text") else str(w)
            return d

        if kind == "parallel":
            return {
                "kind": "parallel",
                "tracks": [sw.to_dict() for sw in self._parallel_steps],
            }

        return {"kind": kind}


# ===============================================================
# TimelineEditor — main tab widget
# ===============================================================

class TimelineEditor(QWidget):
    play_requested = Signal(str)

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx: int = -1
        self._pending_changes = False
        self._loading_ui = False

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        # ---- left: cutscene list ----
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Cutscene")
        btn_add.clicked.connect(self._add)
        btn_del = QPushButton("Delete")
        btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add)
        btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        ll.addWidget(self._list)

        # ---- right: detail editor ----
        right = QWidget()
        rl = QVBoxLayout(right)

        top_row = QHBoxLayout()
        f = QFormLayout()
        self._c_id = QLineEdit()
        f.addRow("id", self._c_id)
        top_row.addLayout(f, stretch=1)
        self._play_btn = QPushButton("Play")
        self._play_btn.setToolTip("Play this cutscene in the game preview")
        self._play_btn.clicked.connect(self._on_play)
        top_row.addWidget(self._play_btn)
        rl.addLayout(top_row)

        # metadata
        bind_form = QFormLayout()
        self._target_scene = IdRefSelector(self, allow_empty=True)
        self._target_scene.setMinimumWidth(200)
        if self._model:
            self._target_scene.set_items(
                [("", "(none)")] + [(s, s) for s in self._model.all_scene_ids()])
        bind_form.addRow("targetScene", self._target_scene)

        self._spawn_key = ""
        self._spawn_loading = False
        spawn_row = QWidget()
        spawn_lay = QHBoxLayout(spawn_row)
        spawn_lay.setContentsMargins(0, 0, 0, 0)
        self._spawn_display = QLineEdit()
        self._spawn_display.setReadOnly(True)
        self._spawn_display.setPlaceholderText("点击右侧按钮在场景预览中选择...")
        spawn_lay.addWidget(self._spawn_display, 1)
        self._spawn_pick_btn = QPushButton("选择出生点...")
        self._spawn_pick_btn.clicked.connect(self._open_spawn_picker)
        spawn_lay.addWidget(self._spawn_pick_btn)
        bind_form.addRow("targetSpawnPoint", spawn_row)
        self._target_scene.value_changed.connect(self._on_target_scene_changed)

        pos_row = QHBoxLayout()
        self._pos_chk = QCheckBox("targetX/Y")
        self._target_x = QDoubleSpinBox()
        self._target_x.setRange(-99999, 99999)
        self._target_x.setDecimals(1)
        self._target_y = QDoubleSpinBox()
        self._target_y.setRange(-99999, 99999)
        self._target_y.setDecimals(1)
        self._target_x.setEnabled(False)
        self._target_y.setEnabled(False)
        self._pos_chk.toggled.connect(self._target_x.setEnabled)
        self._pos_chk.toggled.connect(self._target_y.setEnabled)
        pos_row.addWidget(self._pos_chk)
        pos_row.addWidget(QLabel("X:"))
        pos_row.addWidget(self._target_x)
        pos_row.addWidget(QLabel("Y:"))
        pos_row.addWidget(self._target_y)
        bind_form.addRow(pos_row)

        self._restore_chk = QCheckBox("restoreState")
        self._restore_chk.setChecked(True)
        self._restore_chk.setToolTip("After cutscene ends, restore previous scene and player position")
        bind_form.addRow(self._restore_chk)

        rl.addLayout(bind_form)

        rl.addWidget(QLabel("<b>Steps (Timeline)</b>"))

        # steps scroll area
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        self._steps_container = QWidget()
        self._steps_layout = QVBoxLayout(self._steps_container)
        self._steps_layout.setSpacing(4)
        scroll.setWidget(self._steps_container)
        rl.addWidget(scroll, stretch=1)

        step_btns = QHBoxLayout()
        add_present = QPushButton("+ Present")
        add_present.clicked.connect(lambda: self._add_step("present"))
        add_action = QPushButton("+ Action")
        add_action.clicked.connect(lambda: self._add_step("action"))
        add_parallel = QPushButton("+ Parallel")
        add_parallel.clicked.connect(lambda: self._add_step("parallel"))
        step_btns.addWidget(add_present)
        step_btns.addWidget(add_action)
        step_btns.addWidget(add_parallel)
        rl.addLayout(step_btns)

        apply_btn = QPushButton("Apply")
        apply_btn.clicked.connect(self._apply)
        rl.addWidget(apply_btn)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([220, 700])
        root.addWidget(splitter)
        self._step_widgets: list[StepWidget] = []
        self._refresh()
        self._model.data_changed.connect(self._on_model_data_changed)

        self._c_id.textChanged.connect(self.mark_pending_changes)
        self._target_scene.value_changed.connect(self.mark_pending_changes)
        self._pos_chk.toggled.connect(self.mark_pending_changes)
        self._target_x.valueChanged.connect(self.mark_pending_changes)
        self._target_y.valueChanged.connect(self.mark_pending_changes)
        self._restore_chk.toggled.connect(self.mark_pending_changes)

    def _on_model_data_changed(self, data_type: str, _item_id: str) -> None:
        pass

    def mark_pending_changes(self, *args) -> None:
        if self._loading_ui:
            return
        self._pending_changes = True

    def has_pending_changes(self) -> bool:
        return self._pending_changes

    def confirm_apply_or_discard(self, parent: QWidget) -> str:
        if not self._pending_changes or self._current_idx < 0:
            return "proceed"
        r = QMessageBox.question(
            parent,
            "Cutscene",
            "当前演出有未 Apply 的修改，如何处理？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Save,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return "cancel"
        if r == QMessageBox.StandardButton.Save:
            if not self._apply():
                return "cancel"
        else:
            self._pending_changes = False
        return "proceed"

    # ---- list ----
    def _refresh(self) -> None:
        self._list.clear()
        for c in self._model.cutscenes:
            self._list.addItem(c.get("id", "?"))

    def _on_target_scene_changed(self, sid: str) -> None:
        if self._spawn_loading:
            return
        if not sid:
            self._spawn_key = ""
            self._refresh_spawn_display()
            return
        sc = self._model.scenes.get(sid)
        if sc and self._spawn_key:
            if self._spawn_key not in (sc.get("spawnPoints") or {}):
                self._spawn_key = ""
        self._refresh_spawn_display()
        self.mark_pending_changes()

    def _refresh_spawn_display(self) -> None:
        sid = self._target_scene.current_id()
        if not sid:
            self._spawn_display.setText("")
            self._spawn_pick_btn.setEnabled(False)
            return
        self._spawn_pick_btn.setEnabled(True)
        if not self._spawn_key:
            self._spawn_display.setText("默认 (spawnPoint)")
        else:
            self._spawn_display.setText(self._spawn_key)

    def _open_spawn_picker(self) -> None:
        sid = self._target_scene.current_id()
        if not sid:
            QMessageBox.information(self, "Cutscene", "请先选择目标场景。")
            return
        dlg = TargetSpawnPickerDialog(self._model, sid, self._spawn_key, self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            self._spawn_key = dlg.selected_spawn_key()
            self._refresh_spawn_display()
            self.mark_pending_changes()

    def _on_select(self, row: int) -> None:
        old = self._current_idx
        if old >= 0 and row >= 0 and old != row and self._pending_changes:
            r = QMessageBox.question(
                self, "Cutscene",
                "当前演出有未 Apply 的修改，切换前如何处理？",
                QMessageBox.StandardButton.Save
                | QMessageBox.StandardButton.Discard
                | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Save,
            )
            if r == QMessageBox.StandardButton.Cancel:
                self._list.blockSignals(True)
                self._list.setCurrentRow(old)
                self._list.blockSignals(False)
                return
            if r == QMessageBox.StandardButton.Save:
                if not self._apply():
                    self._list.blockSignals(True)
                    self._list.setCurrentRow(old)
                    self._list.blockSignals(False)
                    return
            else:
                self._pending_changes = False

        if row < 0 or row >= len(self._model.cutscenes):
            return
        self._loading_ui = True
        try:
            self._current_idx = row
            cs = self._model.cutscenes[row]
            self._c_id.setText(cs.get("id", ""))
            self._spawn_loading = True
            try:
                self._spawn_key = (cs.get("targetSpawnPoint") or "").strip()
                self._target_scene.set_current(cs.get("targetScene", "") or "")
            finally:
                self._spawn_loading = False
            self._refresh_spawn_display()
            has_pos = "targetX" in cs and "targetY" in cs
            self._pos_chk.setChecked(has_pos)
            self._target_x.setValue(float(cs.get("targetX", 0)))
            self._target_y.setValue(float(cs.get("targetY", 0)))
            self._restore_chk.setChecked(cs.get("restoreState", True))
            self._rebuild_steps(cs.get("steps", []))
            self._pending_changes = False
        finally:
            self._loading_ui = False

    def _rebuild_steps(self, steps: list[dict]) -> None:
        for w in self._step_widgets:
            self._steps_layout.removeWidget(w)
            w.deleteLater()
        self._step_widgets.clear()
        for step in steps:
            sw = StepWidget(step, self._model, self)
            self._step_widgets.append(sw)
            self._steps_layout.addWidget(sw)

    def _add_step(self, kind: str) -> None:
        if kind == "present":
            data = {"kind": "present", "type": "waitClick"}
        elif kind == "action":
            data = {"kind": "action", "type": CUTSCENE_ACTION_WHITELIST[0], "params": {}}
        elif kind == "parallel":
            data = {"kind": "parallel", "tracks": []}
        else:
            data = {"kind": kind}
        sw = StepWidget(data, self._model, self)
        self._step_widgets.append(sw)
        self._steps_layout.addWidget(sw)
        self.mark_pending_changes()

    def _apply(self) -> bool:
        if self._current_idx < 0:
            return False
        steps = [sw.to_dict() for sw in self._step_widgets]

        cs = self._model.cutscenes[self._current_idx]
        cs["id"] = self._c_id.text().strip()

        scene = self._target_scene.current_id()
        if scene:
            cs["targetScene"] = scene
        else:
            cs.pop("targetScene", None)

        spawn = self._spawn_key.strip()
        if spawn:
            cs["targetSpawnPoint"] = spawn
        else:
            cs.pop("targetSpawnPoint", None)

        if self._pos_chk.isChecked():
            cs["targetX"] = self._target_x.value()
            cs["targetY"] = self._target_y.value()
        else:
            cs.pop("targetX", None)
            cs.pop("targetY", None)

        if not self._restore_chk.isChecked():
            cs["restoreState"] = False
        else:
            cs.pop("restoreState", None)

        cs["steps"] = steps
        cs.pop("commands", None)
        self._model.mark_dirty("cutscene")
        self._pending_changes = False
        self._refresh()
        if 0 <= self._current_idx < self._list.count():
            self._list.setCurrentRow(self._current_idx)
        return True

    def _add(self) -> None:
        self._model.cutscenes.append({
            "id": f"cutscene_{len(self._model.cutscenes)}",
            "steps": [],
        })
        self._model.mark_dirty("cutscene")
        self._pending_changes = False
        self._refresh()

    def _on_play(self) -> None:
        cid = self._c_id.text().strip()
        if cid:
            self.play_requested.emit(cid)

    def _delete(self) -> None:
        if self._current_idx >= 0:
            self._model.cutscenes.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("cutscene")
            self._pending_changes = False
            self._refresh()
