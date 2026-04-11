"""Cutscene command-list editor (no timeline)."""
from __future__ import annotations

import json
from copy import deepcopy
from typing import TYPE_CHECKING

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QComboBox, QTextEdit, QPushButton, QLabel,
    QScrollArea, QCheckBox, QDoubleSpinBox, QFrame, QMessageBox,
    QDialog,
)
from PySide6.QtCore import Qt, Signal

from ..project_model import ProjectModel
from ..shared.flag_key_field import FlagKeyPickField
from ..shared.flag_value_edit import FlagValueEdit
from ..shared.id_ref_selector import IdRefSelector
from ..shared.image_path_picker import CutsceneImagePathRow
from ..shared.action_editor import ActionRow, ACTION_TYPES, FilterableTypeCombo
from .scene_editor import TargetSpawnPickerDialog

if TYPE_CHECKING:
    pass

COMMAND_TYPES = [
    "fade_black", "fade_in", "flash_white", "wait_time", "wait_click",
    "set_flag", "show_title", "show_dialogue", "play_bgm", "stop_bgm",
    "play_sfx", "camera_move", "camera_zoom", "switch_scene", "change_scene",
    "show_character",
    "show_img", "hide_img", "show_movie_bar", "hide_movie_bar",
    "show_subtitle", "execute_action",
    "entity_move", "entity_anim", "entity_face", "entity_spawn",
    "entity_remove", "entity_emote", "entity_visible",
]

STANDARD_CMD_TYPES = frozenset(COMMAND_TYPES)

_CMD_PARAMS: dict[str, list[tuple[str, str]]] = {
    "fade_black": [("duration", "float")],
    "fade_in": [("duration", "float")],
    "flash_white": [("duration", "float")],
    "wait_time": [("duration", "float")],
    "wait_click": [],
    "set_flag": [("key", "str"), ("value", "flag_val")],
    "show_title": [("text", "text"), ("duration", "float")],
    "show_dialogue": [("speaker", "str"), ("text", "text")],
    "play_bgm": [("id", "str"), ("fadeMs", "float")],
    "stop_bgm": [("fadeMs", "float")],
    "play_sfx": [("id", "str")],
    "camera_move": [("x", "float"), ("y", "float"), ("duration", "float")],
    "camera_zoom": [("scale", "float"), ("duration", "float")],
    "switch_scene": [("sceneId", "str"), ("spawnPoint", "str")],
    "change_scene": [("sceneId", "str"), ("spawnPoint", "str")],
    "show_character": [("visible", "bool")],
    "show_img": [("id", "str"), ("image", "str")],
    "hide_img": [("id", "str")],
    "show_movie_bar": [("heightPercent", "float")],
    "hide_movie_bar": [],
    "show_subtitle": [("text", "text")],
    "entity_move": [("target", "str"), ("x", "float"), ("y", "float"), ("speed", "float")],
    "entity_anim": [("target", "str"), ("animation", "str")],
    "entity_face": [("target", "str"), ("direction", "str"), ("faceTarget", "str")],
    "entity_spawn": [("id", "str"), ("name", "str"), ("x", "float"), ("y", "float")],
    "entity_remove": [("id", "str")],
    "entity_emote": [("target", "str"), ("emote", "str"), ("duration", "float")],
    "entity_visible": [("target", "str"), ("visible", "bool")],
    "execute_action": [],
}

_ENTITY_TARGET_FIELDS = {
    ("entity_move", "target"),
    ("entity_anim", "target"),
    ("entity_face", "target"),
    ("entity_emote", "target"),
    ("entity_visible", "target"),
}

_EMOTE_PRESETS = ["!", "?", "...", "!!!", "~"]

_MS_DURATION_KEYS = frozenset({
    "duration", "fadeMs",
})


def _reserved_keys_for_type(ct: str) -> frozenset[str]:
    keys: set[str] = {"type", "parallel"}
    for pname, _ in _CMD_PARAMS.get(ct, ()):
        keys.add(pname)
    if ct == "execute_action":
        keys.add("actionType")
        keys.add("params")
    if ct == "change_scene":
        keys.update({"cameraX", "cameraY", "useCamera"})
    if ct == "show_subtitle":
        keys.add("position")
        keys.add("duration")
    return frozenset(keys)


def _row_label(param_name: str, ptype: str, ct: str) -> str:
    if ptype == "float" and param_name in _MS_DURATION_KEYS:
        return f"{param_name} (ms)"
    if ct == "entity_emote" and param_name == "duration":
        return "duration (ms)"
    return param_name


class CommandWidget(QFrame):
    """Single command block with reorder toolbar."""

    def __init__(
        self,
        cmd: dict,
        model: ProjectModel | None = None,
        cutscene_editor: QWidget | None = None,
        parent: QWidget | None = None,
    ):
        super().__init__(parent)
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self._widgets: dict[str, QWidget] = {}
        self._model = model
        self._editor = cutscene_editor
        self._action_row: ActionRow | None = None
        self._unknown_json: QTextEdit | None = None
        self._unknown_warn: QLabel | None = None
        self._preserved_extra: dict = {}
        self._subtitle_pos_mode: QComboBox | None = None
        self._subtitle_pos_spin: QDoubleSpinBox | None = None
        self._change_use_cam: QCheckBox | None = None
        self._change_cam_x: QDoubleSpinBox | None = None
        self._change_cam_y: QDoubleSpinBox | None = None

        ut = str(cmd.get("type", "wait_click"))
        self._initial_type = ut
        self._preserved_extra = {
            k: deepcopy(v)
            for k, v in cmd.items()
            if k not in _reserved_keys_for_type(ut)
        }

        lay = QVBoxLayout(self)
        lay.setContentsMargins(4, 4, 4, 4)

        tool = QHBoxLayout()
        self._btn_up = QPushButton("\u2191")
        self._btn_up.setFixedWidth(28)
        self._btn_up.setToolTip("上移")
        self._btn_down = QPushButton("\u2193")
        self._btn_down.setFixedWidth(28)
        self._btn_down.setToolTip("下移")
        self._btn_copy = QPushButton("Copy")
        self._btn_copy.setToolTip("复制此条")
        self._btn_del = QPushButton("Del")
        self._btn_del.setToolTip("删除此条")
        tool.addWidget(self._btn_up)
        tool.addWidget(self._btn_down)
        tool.addWidget(self._btn_copy)
        tool.addWidget(self._btn_del)
        tool.addStretch(1)
        lay.addLayout(tool)

        if cutscene_editor is not None:
            self._btn_up.clicked.connect(lambda: cutscene_editor._move_command(self, -1))
            self._btn_down.clicked.connect(lambda: cutscene_editor._move_command(self, 1))
            self._btn_copy.clicked.connect(lambda: cutscene_editor._duplicate_command(self))
            self._btn_del.clicked.connect(lambda: cutscene_editor._remove_command(self))

        top = QHBoxLayout()
        self._type_combo = FilterableTypeCombo(
            [(t, t) for t in COMMAND_TYPES],
            orphan_label=lambda v: f"[unknown] {v}",
        )
        self._type_combo.set_committed_type(ut)
        self._type_combo.typeCommitted.connect(self._on_type_combo_changed)
        self._parallel = QCheckBox("parallel")
        self._parallel.setChecked(bool(cmd.get("parallel", False)))
        self._parallel.toggled.connect(self._emit_editor_dirty)
        top.addWidget(self._type_combo, stretch=1)
        top.addWidget(self._parallel)
        lay.addLayout(top)

        self._params_layout = QFormLayout()
        lay.addLayout(self._params_layout)

        self._cmd_data = deepcopy(cmd)
        self._rebuild_params()
        self._wire_type_combo_once()

    def _emit_editor_dirty(self, *args) -> None:
        if self._editor is not None and hasattr(self._editor, "mark_pending_changes"):
            self._editor.mark_pending_changes()

    def _wire_type_combo_once(self) -> None:
        self._type_combo.typeCommitted.connect(lambda *_: self._emit_editor_dirty())

    def _current_type_str(self) -> str:
        return self._type_combo.committed_type()

    def _is_unknown_type(self) -> bool:
        return self._current_type_str() not in STANDARD_CMD_TYPES

    def _on_type_combo_changed(self) -> None:
        ct_new = self._current_type_str()
        if ct_new in STANDARD_CMD_TYPES:
            self._preserved_extra.clear()
            self._cmd_data = {"type": ct_new}
        else:
            self._cmd_data["type"] = ct_new
        self._rebuild_params()

    def refresh_animation_picker_items(self) -> None:
        if self._current_type_str() != "entity_anim":
            return
        w = self._widgets.get("animation")
        if not isinstance(w, IdRefSelector) or not self._model:
            return
        cur = w.current_id()
        anims = self._model.all_anim_files()
        w.set_items([(a, a) for a in anims])
        if cur in anims:
            w.set_current(cur)
        else:
            w.set_current("")

    def _connect_cutscene_spawn(self) -> None:
        sc_w = self._widgets.get("sceneId")
        sp_w = self._widgets.get("spawnPoint")
        if not isinstance(sc_w, IdRefSelector) or not isinstance(sp_w, IdRefSelector):
            return

        def refresh(_: str = "") -> None:
            sid = sc_w.current_id()
            keys = (
                self._model.spawn_point_keys_for_scene(sid)
                if self._model
                else [""]
            )
            items: list[tuple[str, str]] = [(k, k if k else "(default)") for k in keys]
            cur = sp_w.current_id()
            sp_w.set_items(items)
            if cur in keys:
                sp_w.set_current(cur)
            elif keys:
                sp_w.set_current(keys[0])

        sc_w.value_changed.connect(refresh)
        sc_w.value_changed.connect(self._emit_editor_dirty)
        refresh()

    def _rebuild_params(self) -> None:
        while self._params_layout.rowCount() > 0:
            self._params_layout.removeRow(0)
        self._widgets.clear()
        self._action_row = None
        self._unknown_json = None
        self._unknown_warn = None
        self._subtitle_pos_mode = None
        self._subtitle_pos_spin = None
        self._change_use_cam = None
        self._change_cam_x = None
        self._change_cam_y = None

        ct = self._current_type_str()
        if self._is_unknown_type():
            self._unknown_warn = QLabel(
                "未知指令类型：请编辑 JSON 或改为标准类型。parallel 仍以勾选框为准。"
            )
            self._unknown_warn.setStyleSheet("color: #c44;")
            self._params_layout.addRow(self._unknown_warn)
            _uj = {k: v for k, v in self._cmd_data.items() if k != "parallel"}
            self._unknown_json = QTextEdit(json.dumps(_uj, ensure_ascii=False, indent=2))
            self._unknown_json.setMinimumHeight(120)
            self._unknown_json.textChanged.connect(self._emit_editor_dirty)
            self._params_layout.addRow("command JSON", self._unknown_json)
            return

        schema = _CMD_PARAMS.get(ct, [])
        for pname, ptype in schema:
            val = self._cmd_data.get(pname, "")
            if ct == "entity_anim" and pname == "animation" and val == "":
                val = self._cmd_data.get("anim", "")
            label = _row_label(pname, ptype, ct)
            if ptype == "float":
                w = QDoubleSpinBox()
                w.setRange(-99999, 99999)
                w.setDecimals(2)
                w.setValue(float(val) if val != "" else 0)
                w.valueChanged.connect(self._emit_editor_dirty)
            elif ptype == "bool":
                w = QCheckBox()
                w.setChecked(bool(val))
                w.toggled.connect(self._emit_editor_dirty)
            elif ptype == "text":
                w = QTextEdit(str(val))
                w.setMaximumHeight(50)
                w.textChanged.connect(self._emit_editor_dirty)
            elif ptype == "flag_val":
                w = FlagValueEdit(self, self._model.flag_registry if self._model else {})
                if ct != "set_flag":
                    w.set_value(val if val != "" else True)
                w.valueChanged.connect(self._emit_editor_dirty)
            elif ct == "set_flag" and pname == "key":
                w = FlagKeyPickField(self._model, None, str(val) if val else "", self)
                w.setMinimumWidth(200)
                w.valueChanged.connect(self._emit_editor_dirty)
            elif ct == "play_bgm" and pname == "id":
                w = IdRefSelector(self, allow_empty=True)
                w.setMinimumWidth(200)
                if self._model:
                    w.set_items([(a, a) for a in self._model.all_audio_ids("bgm")])
                w.set_current(str(val) if val is not None else "")
                w.value_changed.connect(self._emit_editor_dirty)
            elif ct == "play_sfx" and pname == "id":
                w = IdRefSelector(self, allow_empty=True)
                w.setMinimumWidth(200)
                if self._model:
                    w.set_items([(a, a) for a in self._model.all_audio_ids("sfx")])
                w.set_current(str(val) if val is not None else "")
                w.value_changed.connect(self._emit_editor_dirty)
            elif ct in ("switch_scene", "change_scene") and pname == "sceneId":
                w = IdRefSelector(self, allow_empty=True)
                w.setMinimumWidth(200)
                if self._model:
                    w.set_items([(s, s) for s in self._model.all_scene_ids()])
                w.set_current(str(val) if val is not None else "")
                w.value_changed.connect(self._emit_editor_dirty)
            elif ct in ("switch_scene", "change_scene") and pname == "spawnPoint":
                w = IdRefSelector(self, allow_empty=True)
                w.setMinimumWidth(200)
                sid = str(self._cmd_data.get("sceneId", "") or "")
                keys = (
                    self._model.spawn_point_keys_for_scene(sid)
                    if self._model and sid
                    else [""]
                )
                w.set_items([(k, k if k else "(default)") for k in keys])
                w.set_current(str(val) if val is not None else "")
                w.value_changed.connect(self._emit_editor_dirty)
            elif ct == "entity_face" and pname == "faceTarget":
                w = IdRefSelector(self, allow_empty=True)
                w.setMinimumWidth(200)
                if self._model:
                    items: list[tuple[str, str]] = [("player", "player")]
                    items += self._model.all_npc_ids_global()
                    w.set_items(items)
                w.set_current(str(val) if val is not None else "")
                w.value_changed.connect(self._emit_editor_dirty)
            elif (ct, pname) in _ENTITY_TARGET_FIELDS:
                w = IdRefSelector(self, allow_empty=False)
                w.setMinimumWidth(200)
                if self._model:
                    items = [("player", "player")]
                    items += self._model.all_npc_ids_global()
                    w.set_items(items)
                w.set_current(str(val) if val else "player")
                w.value_changed.connect(self._emit_editor_dirty)
            elif ct == "show_dialogue" and pname == "speaker":
                w = QComboBox()
                w.setEditable(True)
                w.setMinimumWidth(200)
                if self._model:
                    for name in self._model.all_npc_names():
                        w.addItem(name)
                w.setCurrentText(str(val) if val else "")
                w.currentTextChanged.connect(self._emit_editor_dirty)
            elif ct == "show_img" and pname == "image":
                w = CutsceneImagePathRow(self._model, str(val) if val is not None else "", self)
                w.setMinimumWidth(360)
                w._edit.textChanged.connect(self._emit_editor_dirty)
            elif ct == "entity_anim" and pname == "animation":
                w = IdRefSelector(self, allow_empty=True)
                w.setMinimumWidth(200)
                if self._model:
                    w.set_items([(a, a) for a in self._model.all_anim_files()])
                w.set_current(str(val) if val is not None else "")
                w.value_changed.connect(self._emit_editor_dirty)
            elif ct == "entity_emote" and pname == "emote":
                w = QComboBox()
                w.setEditable(True)
                w.setMinimumWidth(150)
                for e in _EMOTE_PRESETS:
                    w.addItem(e)
                w.setCurrentText(str(val) if val else "")
                w.currentTextChanged.connect(self._emit_editor_dirty)
            elif ct == "entity_face" and pname == "direction":
                w = QComboBox()
                w.addItem("(none)", "")
                for d in ("left", "right", "up", "down"):
                    w.addItem(d, d)
                v = str(val) if val else ""
                for i in range(w.count()):
                    if w.itemData(i) == v:
                        w.setCurrentIndex(i)
                        break
                w.currentIndexChanged.connect(self._emit_editor_dirty)
            else:
                w = QLineEdit(str(val))
                w.textChanged.connect(self._emit_editor_dirty)
            self._widgets[pname] = w
            self._params_layout.addRow(label, w)

        if ct == "show_subtitle":
            pos = self._cmd_data.get("position", "bottom")
            mode = QComboBox()
            mode.addItem("top", "top")
            mode.addItem("center", "center")
            mode.addItem("bottom", "bottom")
            mode.addItem("numeric (0-1)", "numeric")
            if isinstance(pos, (int, float)):
                mode.setCurrentIndex(3)
            else:
                ps = str(pos) if pos else "bottom"
                for i in range(mode.count()):
                    if mode.itemData(i) == ps:
                        mode.setCurrentIndex(i)
                        break
            spin = QDoubleSpinBox()
            spin.setRange(0, 1)
            spin.setDecimals(3)
            if isinstance(pos, (int, float)):
                spin.setValue(float(pos))
            else:
                spin.setValue(0.15)
            spin.setEnabled(mode.currentData() == "numeric")
            mode.currentIndexChanged.connect(
                lambda: spin.setEnabled(mode.currentData() == "numeric"),
            )
            mode.currentIndexChanged.connect(self._emit_editor_dirty)
            spin.valueChanged.connect(self._emit_editor_dirty)
            self._params_layout.addRow("position", mode)
            self._params_layout.addRow("position value (0-1)", spin)
            self._subtitle_pos_mode = mode
            self._subtitle_pos_spin = spin

        if ct == "change_scene":
            has_cam = "cameraX" in self._cmd_data and "cameraY" in self._cmd_data
            ucc = QCheckBox("指定相机 cameraX / cameraY（世界坐标）")
            ucc.setChecked(has_cam)
            cx = QDoubleSpinBox()
            cy = QDoubleSpinBox()
            for box in (cx, cy):
                box.setRange(-999999, 999999)
                box.setDecimals(1)
            cx.setValue(float(self._cmd_data.get("cameraX", 0)))
            cy.setValue(float(self._cmd_data.get("cameraY", 0)))
            cx.setEnabled(has_cam)
            cy.setEnabled(has_cam)
            ucc.toggled.connect(cx.setEnabled)
            ucc.toggled.connect(cy.setEnabled)
            ucc.toggled.connect(self._emit_editor_dirty)
            cx.valueChanged.connect(self._emit_editor_dirty)
            cy.valueChanged.connect(self._emit_editor_dirty)
            self._params_layout.addRow(ucc)
            self._params_layout.addRow("cameraX", cx)
            self._params_layout.addRow("cameraY", cy)
            self._change_use_cam = ucc
            self._change_cam_x = cx
            self._change_cam_y = cy

        if ct == "execute_action":
            ad = {
                "type": str(self._cmd_data.get("actionType", "setFlag")),
                "params": dict(self._cmd_data.get("params") or {}),
            }
            self._action_row = ActionRow(
                ad, model=self._model, scene_id=None, show_delete_button=False, parent=self,
            )
            self._action_row.changed.connect(self._emit_editor_dirty)
            self._params_layout.addRow(self._action_row)

        if ct in ("switch_scene", "change_scene"):
            self._connect_cutscene_spawn()

        if ct == "set_flag":
            kw = self._widgets.get("key")
            vw = self._widgets.get("value")
            if isinstance(kw, FlagKeyPickField) and isinstance(vw, FlagValueEdit):
                reg = self._model.flag_registry if self._model else {}
                vw.set_registry(reg)

                def on_key() -> None:
                    vw.set_flag_key(kw.key())

                kw.valueChanged.connect(on_key)
                on_key()
                val = self._cmd_data.get("value", "")
                vw.set_value(val if val != "" else True)

    def to_dict(self) -> dict:
        if self._is_unknown_type() and self._unknown_json is not None:
            try:
                raw = json.loads(self._unknown_json.toPlainText())
            except json.JSONDecodeError:
                raw = dict(self._cmd_data)
            if not isinstance(raw, dict):
                raw = {"type": "wait_click"}
            d = dict(raw)
            d["type"] = str(d.get("type", "wait_click"))
            if self._parallel.isChecked():
                d["parallel"] = True
            else:
                d.pop("parallel", None)
            return d

        ct = self._current_type_str()
        d: dict = {"type": ct}
        if self._parallel.isChecked():
            d["parallel"] = True
        schema = _CMD_PARAMS.get(ct, [])
        for pname, ptype in schema:
            w = self._widgets.get(pname)
            if w is None:
                continue
            if ptype == "float":
                d[pname] = w.value()
            elif ptype == "bool":
                d[pname] = w.isChecked()
            elif ptype == "text":
                d[pname] = w.toPlainText()
            elif ptype == "flag_val" and isinstance(w, FlagValueEdit):
                v = w.get_value()
                d[pname] = v if isinstance(v, (bool, str)) else float(v)
            elif ct == "set_flag" and pname == "key" and isinstance(w, FlagKeyPickField):
                d[pname] = w.key()
            elif isinstance(w, CutsceneImagePathRow):
                d[pname] = w.path()
            elif isinstance(w, IdRefSelector):
                d[pname] = w.current_id()
            elif isinstance(w, QComboBox) and ct == "entity_face" and pname == "direction":
                dd = w.currentData()
                if dd:
                    d[pname] = str(dd)
            elif isinstance(w, QComboBox):
                d[pname] = w.currentText()

        if ct == "entity_face":
            if not str(d.get("faceTarget", "")).strip():
                d.pop("faceTarget", None)
            if not d.get("direction"):
                d.pop("direction", None)

        if ct == "show_subtitle" and self._subtitle_pos_mode is not None:
            mode = self._subtitle_pos_mode.currentData()
            if mode == "numeric" and self._subtitle_pos_spin is not None:
                d["position"] = self._subtitle_pos_spin.value()
            else:
                d["position"] = str(mode) if mode else "bottom"

        if ct == "change_scene":
            if self._change_use_cam is not None and self._change_use_cam.isChecked():
                if self._change_cam_x is not None:
                    d["cameraX"] = self._change_cam_x.value()
                if self._change_cam_y is not None:
                    d["cameraY"] = self._change_cam_y.value()
            else:
                d.pop("cameraX", None)
                d.pop("cameraY", None)

        if ct == "execute_action" and self._action_row is not None:
            ad = self._action_row.to_dict()
            d["actionType"] = ad["type"]
            d["params"] = ad["params"]

        if ct == "entity_anim":
            d.pop("anim", None)

        merged = {**self._preserved_extra, **d}
        return merged


def _validate_cutscene_commands(cmds: list[dict]) -> list[str]:
    errs: list[str] = []
    for i, c in enumerate(cmds):
        t = c.get("type", "")
        if t == "execute_action":
            at = c.get("actionType", "")
            if at not in ACTION_TYPES:
                errs.append(f"#{i + 1} execute_action: 未知 actionType {at!r}")
            if not isinstance(c.get("params"), dict):
                errs.append(f"#{i + 1} execute_action: params 必须是对象")
        if t == "show_img" and not str(c.get("image", "")).strip():
            errs.append(f"#{i + 1} show_img: image 为空")
        if t == "set_flag" and not str(c.get("key", "")).strip():
            errs.append(f"#{i + 1} set_flag: key 为空")
    return errs


class CutsceneEditor(QWidget):
    play_requested = Signal(str)

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx: int = -1
        self._pending_changes = False
        self._loading_ui = False

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

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
        self._spawn_display.setPlaceholderText("点击右侧按钮在场景预览中选择…")
        spawn_lay.addWidget(self._spawn_display, 1)
        self._spawn_pick_btn = QPushButton("选择出生点…")
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

        rl.addWidget(QLabel("<b>Commands</b>"))

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        self._cmds_container = QWidget()
        self._cmds_layout = QVBoxLayout(self._cmds_container)
        self._cmds_layout.setSpacing(4)
        scroll.setWidget(self._cmds_container)
        rl.addWidget(scroll, stretch=1)

        cmd_btns = QHBoxLayout()
        add_cmd = QPushButton("+ Command")
        add_cmd.clicked.connect(self._add_cmd)
        cmd_btns.addWidget(add_cmd)
        rl.addLayout(cmd_btns)
        apply_btn = QPushButton("Apply")
        apply_btn.clicked.connect(self._apply)
        rl.addWidget(apply_btn)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([220, 700])
        root.addWidget(splitter)
        self._cmd_widgets: list[CommandWidget] = []
        self._refresh()
        self._model.data_changed.connect(self._on_model_data_changed)

        self._c_id.textChanged.connect(self.mark_pending_changes)
        self._target_scene.value_changed.connect(self.mark_pending_changes)
        self._spawn_pick_btn.clicked.connect(self.mark_pending_changes)
        self._pos_chk.toggled.connect(self.mark_pending_changes)
        self._target_x.valueChanged.connect(self.mark_pending_changes)
        self._target_y.valueChanged.connect(self.mark_pending_changes)
        self._restore_chk.toggled.connect(self.mark_pending_changes)

    def _on_model_data_changed(self, data_type: str, _item_id: str) -> None:
        if data_type != "animation":
            return
        for cw in self._cmd_widgets:
            cw.refresh_animation_picker_items()

    def mark_pending_changes(self, *args) -> None:
        if self._loading_ui:
            return
        self._pending_changes = True

    def has_pending_changes(self) -> bool:
        return self._pending_changes

    def confirm_apply_or_discard(self, parent: QWidget) -> str:
        """Return 'proceed', 'cancel'. Applies or discards pending cutscene edits."""
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

    def _move_command(self, cw: CommandWidget, delta: int) -> None:
        try:
            i = self._cmd_widgets.index(cw)
        except ValueError:
            return
        j = i + delta
        if j < 0 or j >= len(self._cmd_widgets):
            return
        self._cmd_widgets[i], self._cmd_widgets[j] = self._cmd_widgets[j], self._cmd_widgets[i]
        self._relayout_commands()
        self.mark_pending_changes()

    def _duplicate_command(self, cw: CommandWidget) -> None:
        try:
            i = self._cmd_widgets.index(cw)
        except ValueError:
            return
        data = deepcopy(cw.to_dict())
        new_w = CommandWidget(data, self._model, self)
        self._cmd_widgets.insert(i + 1, new_w)
        self._relayout_commands()
        self.mark_pending_changes()

    def _remove_command(self, cw: CommandWidget) -> None:
        try:
            i = self._cmd_widgets.index(cw)
        except ValueError:
            return
        self._cmd_widgets.pop(i)
        cw.deleteLater()
        self._relayout_commands()
        self.mark_pending_changes()

    def _relayout_commands(self) -> None:
        for w in self._cmd_widgets:
            self._cmds_layout.removeWidget(w)
        for w in self._cmd_widgets:
            self._cmds_layout.addWidget(w)

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
            self._spawn_display.setText("默认（spawnPoint）")
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
        if (
            old >= 0
            and row >= 0
            and old != row
            and self._pending_changes
        ):
            r = QMessageBox.question(
                self,
                "Cutscene",
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
            self._rebuild_commands(cs.get("commands", []))
            self._pending_changes = False
        finally:
            self._loading_ui = False

    def _rebuild_commands(self, commands: list[dict]) -> None:
        for w in self._cmd_widgets:
            self._cmds_layout.removeWidget(w)
            w.deleteLater()
        self._cmd_widgets.clear()
        for cmd in commands:
            cw = CommandWidget(cmd, self._model, self)
            self._cmd_widgets.append(cw)
            self._cmds_layout.addWidget(cw)

    def _add_cmd(self) -> None:
        cw = CommandWidget({"type": "wait_click"}, self._model, self)
        self._cmd_widgets.append(cw)
        self._cmds_layout.addWidget(cw)
        self.mark_pending_changes()

    def _apply(self) -> bool:
        if self._current_idx < 0:
            return False
        cmds = [cw.to_dict() for cw in self._cmd_widgets]
        errs = _validate_cutscene_commands(cmds)
        if errs:
            QMessageBox.warning(
                self,
                "Cutscene",
                "校验未通过：\n" + "\n".join(errs),
            )
            return False
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

        cs["commands"] = cmds
        self._model.mark_dirty("cutscene")
        self._pending_changes = False
        self._refresh()
        if 0 <= self._current_idx < self._list.count():
            self._list.setCurrentRow(self._current_idx)
        return True

    def _add(self) -> None:
        self._model.cutscenes.append({
            "id": f"cutscene_{len(self._model.cutscenes)}",
            "commands": [],
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
