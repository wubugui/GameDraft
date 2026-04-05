"""Global game config editor."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QFormLayout, QLineEdit, QPushButton, QLabel,
    QTableWidget, QTableWidgetItem, QHeaderView, QComboBox,
)

from ..project_model import ProjectModel
from ..shared.id_ref_selector import IdRefSelector
from ..shared.flag_key_selector import populate_flag_key_combo


class GameConfigEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model

        lay = QVBoxLayout(self)
        f = QFormLayout()

        self._initial_scene = IdRefSelector(allow_empty=True)
        self._initial_scene.set_items([(s, s) for s in model.all_scene_ids()])
        f.addRow("initialScene", self._initial_scene)

        self._initial_quest = IdRefSelector(allow_empty=True)
        self._initial_quest.set_items(model.all_quest_ids())
        f.addRow("initialQuest", self._initial_quest)

        self._fallback_scene = IdRefSelector(allow_empty=True)
        self._fallback_scene.set_items([(s, s) for s in model.all_scene_ids()])
        f.addRow("fallbackScene", self._fallback_scene)

        self._initial_cutscene = IdRefSelector(allow_empty=True)
        self._initial_cutscene.set_items(model.all_cutscene_ids())
        f.addRow("initialCutscene", self._initial_cutscene)

        self._cutscene_flag = QComboBox()
        self._cutscene_flag.setEditable(False)
        self._cutscene_flag.setMinimumWidth(220)
        f.addRow("initialCutsceneDoneFlag", self._cutscene_flag)
        lay.addLayout(f)

        lay.addWidget(QLabel("<b>startupFlags</b>（key 仅能从 Flags 登记中选择）"))
        self._flags_table = QTableWidget(0, 2)
        self._flags_table.setHorizontalHeaderLabels(["key", "value"])
        self._flags_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        lay.addWidget(self._flags_table)
        flag_btns = QFormLayout()
        add_flag = QPushButton("+ Flag"); add_flag.clicked.connect(self._add_flag)
        flag_btns.addWidget(add_flag)
        lay.addLayout(flag_btns)

        apply_btn = QPushButton("Apply")
        apply_btn.clicked.connect(self._apply)
        lay.addWidget(apply_btn)
        lay.addStretch()
        self._load()

    def _flag_choices(self) -> list[str]:
        return self._model.registry_flag_choices(None)

    def _load(self) -> None:
        cfg = self._model.game_config
        allowed = self._flag_choices()
        self._initial_scene.set_current(cfg.get("initialScene", ""))
        self._initial_quest.set_current(cfg.get("initialQuest", ""))
        self._fallback_scene.set_current(cfg.get("fallbackScene", ""))
        self._initial_cutscene.set_current(cfg.get("initialCutscene", ""))
        populate_flag_key_combo(
            self._cutscene_flag, allowed, str(cfg.get("initialCutsceneDoneFlag", "") or "")
        )
        sf = cfg.get("startupFlags", {})
        self._flags_table.setRowCount(0)
        for k, v in sf.items():
            r = self._flags_table.rowCount()
            self._flags_table.insertRow(r)
            cb = QComboBox()
            cb.setEditable(False)
            populate_flag_key_combo(cb, allowed, str(k))
            self._flags_table.setCellWidget(r, 0, cb)
            self._flags_table.setItem(r, 1, QTableWidgetItem(str(v)))

    def _add_flag(self) -> None:
        r = self._flags_table.rowCount()
        self._flags_table.insertRow(r)
        cb = QComboBox()
        cb.setEditable(False)
        populate_flag_key_combo(cb, self._flag_choices(), "")
        self._flags_table.setCellWidget(r, 0, cb)
        self._flags_table.setItem(r, 1, QTableWidgetItem("true"))

    def _apply(self) -> None:
        cfg = self._model.game_config
        cfg["initialScene"] = self._initial_scene.current_id()
        cfg["initialQuest"] = self._initial_quest.current_id()
        cfg["fallbackScene"] = self._fallback_scene.current_id()
        cs = self._initial_cutscene.current_id()
        if cs:
            cfg["initialCutscene"] = cs
        elif "initialCutscene" in cfg:
            del cfg["initialCutscene"]
        cf = self._cutscene_flag.currentData()
        cf_s = str(cf).strip() if cf else ""
        if cf_s:
            cfg["initialCutsceneDoneFlag"] = cf_s
        elif "initialCutsceneDoneFlag" in cfg:
            del cfg["initialCutsceneDoneFlag"]
        sf: dict = {}
        for i in range(self._flags_table.rowCount()):
            cw = self._flags_table.cellWidget(i, 0)
            v_item = self._flags_table.item(i, 1)
            k = ""
            if isinstance(cw, QComboBox):
                raw = cw.currentData()
                k = str(raw).strip() if raw else ""
            if not k:
                continue
            raw = v_item.text().strip() if v_item else "true"
            if raw == "true":
                sf[k] = True
            elif raw == "false":
                sf[k] = False
            else:
                try:
                    sf[k] = int(raw)
                except ValueError:
                    sf[k] = raw
        if sf:
            cfg["startupFlags"] = sf
        elif "startupFlags" in cfg:
            del cfg["startupFlags"]
        self._model.mark_dirty("config")
