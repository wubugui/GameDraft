"""Global game config editor."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QFormLayout, QPushButton, QLabel,
    QTableWidget, QHeaderView, QSpinBox, QGroupBox, QCheckBox,
)

from ..project_model import ProjectModel
from ..shared.id_ref_selector import IdRefSelector
from ..shared.flag_key_field import FlagKeyPickField
from ..shared.flag_value_edit import FlagValueEdit


def _make_size_row(label: str) -> tuple[QHBoxLayout, QCheckBox, QSpinBox, QSpinBox]:
    """Create a width x height input row with an enable checkbox."""
    row = QHBoxLayout()
    chk = QCheckBox(label)
    chk.setToolTip(f"Enable custom {label.lower()}")
    row.addWidget(chk)
    w = QSpinBox()
    w.setRange(0, 7680)
    w.setSuffix(" px")
    w.setEnabled(False)
    h = QSpinBox()
    h.setRange(0, 4320)
    h.setSuffix(" px")
    h.setEnabled(False)
    row.addWidget(QLabel("W:"))
    row.addWidget(w)
    row.addWidget(QLabel("H:"))
    row.addWidget(h)
    row.addStretch()
    chk.toggled.connect(w.setEnabled)
    chk.toggled.connect(h.setEnabled)
    return row, chk, w, h


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

        self._cutscene_flag = FlagKeyPickField(model, None, "", self)
        self._cutscene_flag.setMinimumWidth(320)
        f.addRow("initialCutsceneDoneFlag", self._cutscene_flag)
        lay.addLayout(f)

        # -- Display settings ---------------------------------------------------
        disp_box = QGroupBox("Display")
        disp_lay = QVBoxLayout(disp_box)

        vp_row, self._vp_chk, self._vp_w, self._vp_h = _make_size_row("Viewport")
        self._vp_w.setValue(1280)
        self._vp_h.setValue(720)
        self._vp_chk.setToolTip(
            "Logical rendering resolution. Game elements are rendered at this "
            "size and the result is scaled to fill the window via CSS."
        )
        disp_lay.addLayout(vp_row)

        ws_row, self._ws_chk, self._ws_w, self._ws_h = _make_size_row("Window Size")
        self._ws_w.setValue(1280)
        self._ws_h.setValue(720)
        self._ws_chk.setToolTip(
            "CSS size of the game container. Independent of viewport resolution."
        )
        disp_lay.addLayout(ws_row)

        lay.addWidget(disp_box)

        # -- Startup flags ------------------------------------------------------
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
        self._cutscene_flag.set_key(str(cfg.get("initialCutsceneDoneFlag", "") or ""))

        vp = cfg.get("viewport")
        if isinstance(vp, dict) and vp.get("width") and vp.get("height"):
            self._vp_chk.setChecked(True)
            self._vp_w.setValue(int(vp["width"]))
            self._vp_h.setValue(int(vp["height"]))
        else:
            self._vp_chk.setChecked(False)

        ws = cfg.get("windowSize")
        if isinstance(ws, dict) and ws.get("width") and ws.get("height"):
            self._ws_chk.setChecked(True)
            self._ws_w.setValue(int(ws["width"]))
            self._ws_h.setValue(int(ws["height"]))
        else:
            self._ws_chk.setChecked(False)

        sf = cfg.get("startupFlags", {})
        self._flags_table.setRowCount(0)
        for k, v in sf.items():
            r = self._flags_table.rowCount()
            self._flags_table.insertRow(r)
            pf = FlagKeyPickField(self._model, None, str(k), self)
            vf = FlagValueEdit(self, self._model.flag_registry)
            pf.valueChanged.connect(lambda: vf.set_flag_key(pf.key()))
            self._flags_table.setCellWidget(r, 0, pf)
            self._flags_table.setCellWidget(r, 1, vf)
            vf.set_flag_key(pf.key())
            vf.set_value(v)

    def _add_flag(self) -> None:
        r = self._flags_table.rowCount()
        self._flags_table.insertRow(r)
        pf = FlagKeyPickField(self._model, None, "", self)
        vf = FlagValueEdit(self, self._model.flag_registry)
        pf.valueChanged.connect(lambda: vf.set_flag_key(pf.key()))
        self._flags_table.setCellWidget(r, 0, pf)
        self._flags_table.setCellWidget(r, 1, vf)
        vf.set_flag_key(pf.key())
        vf.set_value(True)

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
        cf_s = self._cutscene_flag.key()
        if cf_s:
            cfg["initialCutsceneDoneFlag"] = cf_s
        elif "initialCutsceneDoneFlag" in cfg:
            del cfg["initialCutsceneDoneFlag"]

        if self._vp_chk.isChecked() and self._vp_w.value() > 0 and self._vp_h.value() > 0:
            cfg["viewport"] = {"width": self._vp_w.value(), "height": self._vp_h.value()}
        elif "viewport" in cfg:
            del cfg["viewport"]

        if self._ws_chk.isChecked() and self._ws_w.value() > 0 and self._ws_h.value() > 0:
            cfg["windowSize"] = {"width": self._ws_w.value(), "height": self._ws_h.value()}
        elif "windowSize" in cfg:
            del cfg["windowSize"]

        sf: dict = {}
        for i in range(self._flags_table.rowCount()):
            cw = self._flags_table.cellWidget(i, 0)
            vw = self._flags_table.cellWidget(i, 1)
            k = ""
            if isinstance(cw, FlagKeyPickField):
                k = cw.key()
            if not k:
                continue
            if isinstance(vw, FlagValueEdit):
                v = vw.get_value()
                sf[k] = v if isinstance(v, (bool, str)) else float(v)
            else:
                sf[k] = True
        if sf:
            cfg["startupFlags"] = sf
        elif "startupFlags" in cfg:
            del cfg["startupFlags"]
        self._model.mark_dirty("config")
