"""Global game config editor."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QFormLayout, QLineEdit, QPushButton, QLabel,
    QTableWidget, QTableWidgetItem, QHeaderView,
)

from ..project_model import ProjectModel
from ..shared.id_ref_selector import IdRefSelector


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

        self._cutscene_flag = QLineEdit()
        f.addRow("initialCutsceneDoneFlag", self._cutscene_flag)
        lay.addLayout(f)

        lay.addWidget(QLabel("<b>startupFlags</b>"))
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

    def _load(self) -> None:
        cfg = self._model.game_config
        self._initial_scene.set_current(cfg.get("initialScene", ""))
        self._initial_quest.set_current(cfg.get("initialQuest", ""))
        self._fallback_scene.set_current(cfg.get("fallbackScene", ""))
        self._initial_cutscene.set_current(cfg.get("initialCutscene", ""))
        self._cutscene_flag.setText(cfg.get("initialCutsceneDoneFlag", ""))
        sf = cfg.get("startupFlags", {})
        self._flags_table.setRowCount(len(sf))
        for i, (k, v) in enumerate(sf.items()):
            self._flags_table.setItem(i, 0, QTableWidgetItem(k))
            self._flags_table.setItem(i, 1, QTableWidgetItem(str(v)))

    def _add_flag(self) -> None:
        r = self._flags_table.rowCount()
        self._flags_table.insertRow(r)
        self._flags_table.setItem(r, 0, QTableWidgetItem(""))
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
        cf = self._cutscene_flag.text().strip()
        if cf:
            cfg["initialCutsceneDoneFlag"] = cf
        elif "initialCutsceneDoneFlag" in cfg:
            del cfg["initialCutsceneDoneFlag"]
        sf: dict = {}
        for i in range(self._flags_table.rowCount()):
            k_item = self._flags_table.item(i, 0)
            v_item = self._flags_table.item(i, 1)
            if k_item and k_item.text().strip():
                raw = v_item.text().strip() if v_item else "true"
                if raw == "true":
                    sf[k_item.text().strip()] = True
                elif raw == "false":
                    sf[k_item.text().strip()] = False
                else:
                    try:
                        sf[k_item.text().strip()] = int(raw)
                    except ValueError:
                        sf[k_item.text().strip()] = raw
        if sf:
            cfg["startupFlags"] = sf
        elif "startupFlags" in cfg:
            del cfg["startupFlags"]
        self._model.mark_dirty("config")
