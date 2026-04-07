"""Cutscene timeline editor."""
from __future__ import annotations

import json

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget, QListWidgetItem,
    QFormLayout, QLineEdit, QComboBox, QTextEdit, QPushButton, QLabel,
    QScrollArea, QCheckBox, QDoubleSpinBox, QSpinBox, QFrame, QMessageBox,
    QDialog,
)
from PySide6.QtCore import Qt, Signal, QTimer

from ..project_model import ProjectModel
from ..shared.flag_key_field import FlagKeyPickField
from ..shared.flag_value_edit import FlagValueEdit
from ..shared.id_ref_selector import IdRefSelector
from ..shared.image_path_picker import CutsceneImagePathRow
from .scene_editor import TargetSpawnPickerDialog

COMMAND_TYPES = [
    "fade_black", "fade_in", "flash_white", "wait_time", "wait_click",
    "set_flag", "show_title", "show_dialogue", "play_bgm", "stop_bgm",
    "play_sfx", "camera_move", "camera_zoom", "switch_scene", "change_scene",
    "show_img", "hide_img", "show_movie_bar", "hide_movie_bar",
    "show_subtitle", "execute_action",
    "entity_move", "entity_anim", "entity_face", "entity_spawn",
    "entity_remove", "entity_emote", "entity_visible",
]

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
    "show_img": [("id", "str"), ("image", "str")],
    "hide_img": [("id", "str")],
    "show_movie_bar": [("heightPercent", "float")],
    "hide_movie_bar": [],
    "show_subtitle": [("text", "text"), ("duration", "float")],
    "entity_move": [("target", "str"), ("x", "float"), ("y", "float"), ("speed", "float")],
    "entity_anim": [("target", "str"), ("animation", "str")],
    "entity_face": [("target", "str"), ("faceTarget", "str")],
    "entity_spawn": [("id", "str"), ("name", "str"), ("x", "float"), ("y", "float")],
    "entity_remove": [("id", "str")],
    "entity_emote": [("target", "str"), ("emote", "str"), ("duration", "float")],
    "entity_visible": [("target", "str"), ("visible", "bool")],
    "execute_action": [("actionType", "str"), ("params", "text")],
}

_ENTITY_TARGET_FIELDS = {
    ("entity_move", "target"),
    ("entity_anim", "target"),
    ("entity_face", "target"),
    ("entity_face", "faceTarget"),
    ("entity_emote", "target"),
    ("entity_visible", "target"),
}

_ACTION_TYPES = [
    "giveItem", "removeItem", "giveCurrency", "removeCurrency",
    "giveRule", "giveFragment", "updateQuest",
    "startEncounter", "playBgm", "stopBgm", "playSfx",
    "endDay", "addDelayedEvent", "addArchiveEntry",
    "startCutscene", "showEmote", "openShop",
    "switchScene", "changeScene",
]

_EMOTE_PRESETS = ["!", "?", "...", "!!!", "~"]


class CommandWidget(QFrame):
    def __init__(
        self,
        cmd: dict,
        model: ProjectModel | None = None,
        parent: QWidget | None = None,
    ):
        super().__init__(parent)
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self._widgets: dict[str, QWidget] = {}
        self._model = model
        lay = QVBoxLayout(self)
        lay.setContentsMargins(4, 4, 4, 4)

        top = QHBoxLayout()
        self._type_combo = QComboBox()
        self._type_combo.addItems(COMMAND_TYPES)
        self._type_combo.setCurrentText(cmd.get("type", "wait_click"))
        self._parallel = QCheckBox("parallel")
        self._parallel.setChecked(cmd.get("parallel", False))
        top.addWidget(self._type_combo, stretch=1)
        top.addWidget(self._parallel)
        lay.addLayout(top)

        self._params_layout = QFormLayout()
        lay.addLayout(self._params_layout)

        self._cmd_data = cmd
        self._rebuild_params()
        self._type_combo.currentTextChanged.connect(lambda _: self._rebuild_params())

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
        refresh()

    def _rebuild_params(self) -> None:
        while self._params_layout.rowCount() > 0:
            self._params_layout.removeRow(0)
        self._widgets.clear()

        ct = self._type_combo.currentText()
        schema = _CMD_PARAMS.get(ct, [])
        for pname, ptype in schema:
            val = self._cmd_data.get(pname, "")
            if ct == "entity_anim" and pname == "animation" and val == "":
                val = self._cmd_data.get("anim", "")
            if ptype == "float":
                w = QDoubleSpinBox()
                w.setRange(-99999, 99999)
                w.setDecimals(2)
                w.setValue(float(val) if val != "" else 0)
            elif ptype == "bool":
                w = QCheckBox()
                w.setChecked(bool(val))
            elif ptype == "text":
                w = QTextEdit(str(val))
                w.setMaximumHeight(50)
            elif ptype == "flag_val":
                w = FlagValueEdit(self, self._model.flag_registry if self._model else {})
                if ct != "set_flag":
                    w.set_value(val if val != "" else True)
            elif ct == "set_flag" and pname == "key":
                w = FlagKeyPickField(self._model, None, str(val) if val else "", self)
                w.setMinimumWidth(200)
            elif ct == "play_bgm" and pname == "id":
                w = IdRefSelector(self, allow_empty=True)
                w.setMinimumWidth(200)
                if self._model:
                    w.set_items([(a, a) for a in self._model.all_audio_ids("bgm")])
                w.set_current(str(val) if val is not None else "")
            elif ct == "play_sfx" and pname == "id":
                w = IdRefSelector(self, allow_empty=True)
                w.setMinimumWidth(200)
                if self._model:
                    w.set_items([(a, a) for a in self._model.all_audio_ids("sfx")])
                w.set_current(str(val) if val is not None else "")
            elif ct in ("switch_scene", "change_scene") and pname == "sceneId":
                w = IdRefSelector(self, allow_empty=True)
                w.setMinimumWidth(200)
                if self._model:
                    w.set_items([(s, s) for s in self._model.all_scene_ids()])
                w.set_current(str(val) if val is not None else "")
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
            elif (ct, pname) in _ENTITY_TARGET_FIELDS:
                w = IdRefSelector(self, allow_empty=False)
                w.setMinimumWidth(200)
                if self._model:
                    items: list[tuple[str, str]] = [("player", "player")]
                    items += self._model.all_npc_ids_global()
                    w.set_items(items)
                w.set_current(str(val) if val else "player")
            elif ct == "show_dialogue" and pname == "speaker":
                w = QComboBox()
                w.setEditable(True)
                w.setMinimumWidth(200)
                if self._model:
                    for name in self._model.all_npc_names():
                        w.addItem(name)
                w.setCurrentText(str(val) if val else "")
            elif ct == "show_img" and pname == "image":
                w = CutsceneImagePathRow(self._model, str(val) if val is not None else "", self)
                w.setMinimumWidth(360)
            elif ct == "entity_anim" and pname == "animation":
                w = IdRefSelector(self, allow_empty=True)
                w.setMinimumWidth(200)
                if self._model:
                    w.set_items([(a, a) for a in self._model.all_anim_files()])
                w.set_current(str(val) if val is not None else "")
            elif ct == "entity_emote" and pname == "emote":
                w = QComboBox()
                w.setEditable(True)
                w.setMinimumWidth(150)
                for e in _EMOTE_PRESETS:
                    w.addItem(e)
                w.setCurrentText(str(val) if val else "")
            elif ct == "execute_action" and pname == "actionType":
                w = QComboBox()
                w.setMinimumWidth(200)
                for at in _ACTION_TYPES:
                    w.addItem(at)
                w.setCurrentText(str(val) if val else _ACTION_TYPES[0])
            elif ct == "execute_action" and pname == "params":
                w = QTextEdit()
                w.setMaximumHeight(80)
                if isinstance(val, dict):
                    w.setPlainText(json.dumps(val, ensure_ascii=False, indent=2))
                elif val:
                    w.setPlainText(str(val))
            else:
                w = QLineEdit(str(val))
            self._widgets[pname] = w
            self._params_layout.addRow(pname, w)

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
        ct = self._type_combo.currentText()
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
                d[pname] = v if isinstance(v, bool) else float(v)
            elif ct == "set_flag" and pname == "key" and isinstance(w, FlagKeyPickField):
                d[pname] = w.key()
            elif isinstance(w, CutsceneImagePathRow):
                d[pname] = w.path()
            elif isinstance(w, IdRefSelector):
                d[pname] = w.current_id()
            elif isinstance(w, QComboBox):
                d[pname] = w.currentText()
            else:
                d[pname] = w.text()
        if ct == "entity_anim":
            d.pop("anim", None)
        if ct == "execute_action" and "params" in d:
            raw = d["params"]
            if isinstance(raw, str) and raw.strip():
                try:
                    d["params"] = json.loads(raw)
                except json.JSONDecodeError:
                    d["params"] = {}
            elif not isinstance(raw, dict):
                d["params"] = {}
        return d


class CutsceneEditor(QWidget):
    play_requested = Signal(str)

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx: int = -1

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Cutscene"); btn_add.clicked.connect(self._add)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        ll.addWidget(self._list)

        right = QWidget()
        rl = QVBoxLayout(right)

        top_row = QHBoxLayout()
        f = QFormLayout()
        self._c_id = QLineEdit(); f.addRow("id", self._c_id)
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
        self._target_x = QDoubleSpinBox(); self._target_x.setRange(-99999, 99999); self._target_x.setDecimals(1)
        self._target_y = QDoubleSpinBox(); self._target_y.setRange(-99999, 99999); self._target_y.setDecimals(1)
        self._target_x.setEnabled(False); self._target_y.setEnabled(False)
        self._pos_chk.toggled.connect(self._target_x.setEnabled)
        self._pos_chk.toggled.connect(self._target_y.setEnabled)
        pos_row.addWidget(self._pos_chk)
        pos_row.addWidget(QLabel("X:")); pos_row.addWidget(self._target_x)
        pos_row.addWidget(QLabel("Y:")); pos_row.addWidget(self._target_y)
        bind_form.addRow(pos_row)

        self._restore_chk = QCheckBox("restoreState")
        self._restore_chk.setChecked(True)
        self._restore_chk.setToolTip("After cutscene ends, restore previous scene and player position")
        bind_form.addRow(self._restore_chk)

        rl.addLayout(bind_form)

        rl.addWidget(QLabel("<b>Commands</b>"))

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        self._cmds_container = QWidget()
        self._cmds_layout = QVBoxLayout(self._cmds_container)
        self._cmds_layout.setSpacing(4)
        scroll.setWidget(self._cmds_container)
        rl.addWidget(scroll, stretch=1)

        cmd_btns = QHBoxLayout()
        add_cmd = QPushButton("+ Command"); add_cmd.clicked.connect(self._add_cmd)
        cmd_btns.addWidget(add_cmd)
        rl.addLayout(cmd_btns)
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply)
        rl.addWidget(apply_btn)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([220, 700])
        root.addWidget(splitter)
        self._cmd_widgets: list[CommandWidget] = []
        self._refresh()

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
        QTimer.singleShot(0, self._open_spawn_picker)

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

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.cutscenes):
            return
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

    def _rebuild_commands(self, commands: list[dict]) -> None:
        for w in self._cmd_widgets:
            self._cmds_layout.removeWidget(w)
            w.deleteLater()
        self._cmd_widgets.clear()
        for cmd in commands:
            cw = CommandWidget(cmd, self._model)
            self._cmd_widgets.append(cw)
            self._cmds_layout.addWidget(cw)

    def _add_cmd(self) -> None:
        cw = CommandWidget({"type": "wait_click"}, self._model)
        self._cmd_widgets.append(cw)
        self._cmds_layout.addWidget(cw)

    def _apply(self) -> None:
        if self._current_idx < 0:
            return
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

        cs["commands"] = [cw.to_dict() for cw in self._cmd_widgets]
        self._model.mark_dirty("cutscene")
        self._refresh()

    def _add(self) -> None:
        self._model.cutscenes.append({
            "id": f"cutscene_{len(self._model.cutscenes)}", "commands": [],
        })
        self._model.mark_dirty("cutscene")
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
            self._refresh()
