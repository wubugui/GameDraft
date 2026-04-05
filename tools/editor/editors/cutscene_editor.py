"""Cutscene timeline editor."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget, QListWidgetItem,
    QFormLayout, QLineEdit, QComboBox, QTextEdit, QPushButton, QLabel,
    QScrollArea, QCheckBox, QDoubleSpinBox, QSpinBox, QFrame,
)
from PySide6.QtCore import Qt

from ..project_model import ProjectModel

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
    "show_title": [("text", "str"), ("duration", "float")],
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
    "show_subtitle": [("text", "str"), ("duration", "float")],
    "entity_move": [("target", "str"), ("x", "float"), ("y", "float"), ("speed", "float")],
    "entity_anim": [("target", "str"), ("anim", "str")],
    "entity_face": [("target", "str"), ("faceTarget", "str")],
    "entity_spawn": [("id", "str"), ("name", "str"), ("x", "float"), ("y", "float")],
    "entity_remove": [("id", "str")],
    "entity_emote": [("target", "str"), ("emote", "str"), ("duration", "float")],
    "entity_visible": [("target", "str"), ("visible", "bool")],
}


class CommandWidget(QFrame):
    def __init__(self, cmd: dict, parent: QWidget | None = None):
        super().__init__(parent)
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self._widgets: dict[str, QWidget] = {}
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

    def _rebuild_params(self) -> None:
        while self._params_layout.rowCount() > 0:
            self._params_layout.removeRow(0)
        self._widgets.clear()

        ct = self._type_combo.currentText()
        schema = _CMD_PARAMS.get(ct, [])
        for pname, ptype in schema:
            val = self._cmd_data.get(pname, "")
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
                w = QLineEdit(str(val) if val != "" else "true")
            else:
                w = QLineEdit(str(val))
            self._widgets[pname] = w
            self._params_layout.addRow(pname, w)

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
            elif ptype == "flag_val":
                raw = w.text().strip()
                if raw == "true":
                    d[pname] = True
                elif raw == "false":
                    d[pname] = False
                else:
                    try:
                        d[pname] = int(raw)
                    except ValueError:
                        d[pname] = raw
            else:
                d[pname] = w.text()
        return d


class CutsceneEditor(QWidget):
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
        f = QFormLayout()
        self._c_id = QLineEdit(); f.addRow("id", self._c_id)
        rl.addLayout(f)
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

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.cutscenes):
            return
        self._current_idx = row
        cs = self._model.cutscenes[row]
        self._c_id.setText(cs.get("id", ""))
        self._rebuild_commands(cs.get("commands", []))

    def _rebuild_commands(self, commands: list[dict]) -> None:
        for w in self._cmd_widgets:
            self._cmds_layout.removeWidget(w)
            w.deleteLater()
        self._cmd_widgets.clear()
        for cmd in commands:
            cw = CommandWidget(cmd)
            self._cmd_widgets.append(cw)
            self._cmds_layout.addWidget(cw)

    def _add_cmd(self) -> None:
        cw = CommandWidget({"type": "wait_click"})
        self._cmd_widgets.append(cw)
        self._cmds_layout.addWidget(cw)

    def _apply(self) -> None:
        if self._current_idx < 0:
            return
        cs = self._model.cutscenes[self._current_idx]
        cs["id"] = self._c_id.text().strip()
        cs["commands"] = [cw.to_dict() for cw in self._cmd_widgets]
        self._model.mark_dirty("cutscene")
        self._refresh()

    def _add(self) -> None:
        self._model.cutscenes.append({
            "id": f"cutscene_{len(self._model.cutscenes)}", "commands": [],
        })
        self._model.mark_dirty("cutscene")
        self._refresh()

    def _delete(self) -> None:
        if self._current_idx >= 0:
            self._model.cutscenes.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("cutscene")
            self._refresh()
