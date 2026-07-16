"""Global game config editor."""
from __future__ import annotations

import copy

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QFormLayout, QPushButton, QLabel,
    QTableWidget, QHeaderView, QSpinBox, QCheckBox, QMessageBox,
    QScrollArea, QGroupBox,
)

from ..project_model import ProjectModel
from ..shared.id_ref_selector import IdRefSelector
from ..shared.flag_key_field import FlagKeyPickField
from ..shared.flag_value_edit import FlagValueEdit
from ..shared.form_layout import compact_form
from ..shared.collapsible_section import CollapsibleSection


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
    w.setToolTip(f"{label} width in pixels")
    h = QSpinBox()
    h.setRange(0, 4320)
    h.setSuffix(" px")
    h.setEnabled(False)
    h.setToolTip(f"{label} height in pixels")
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

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        content = QWidget()
        scroll.setWidget(content)
        outer.addWidget(scroll)
        lay = QVBoxLayout(content)

        start_box = QGroupBox("启动引用（初始场景/任务/演出）")
        f = compact_form(QFormLayout(start_box))

        # 引用他者 id 一律选择器选、禁手打（候选完备；悬垂旧值由 IdRefSelector 保值）。
        self._initial_scene = IdRefSelector(allow_empty=True, click_opens_popup=True)
        self._initial_scene.set_items([(s, s) for s in model.all_scene_ids()])
        self._initial_scene.setToolTip("新存档进入的第一个场景")
        f.addRow("initialScene", self._initial_scene)

        self._initial_quest = IdRefSelector(allow_empty=True, click_opens_popup=True)
        self._initial_quest.set_items(model.all_quest_ids())
        self._initial_quest.setToolTip("新存档自动激活的初始任务")
        f.addRow("initialQuest", self._initial_quest)

        self._fallback_scene = IdRefSelector(allow_empty=True, click_opens_popup=True)
        self._fallback_scene.set_items([(s, s) for s in model.all_scene_ids()])
        self._fallback_scene.setToolTip("目标场景缺失时回退到的场景")
        f.addRow("fallbackScene", self._fallback_scene)

        self._initial_cutscene = IdRefSelector(allow_empty=True, click_opens_popup=True)
        self._initial_cutscene.set_items(model.all_cutscene_ids())
        self._initial_cutscene.setToolTip("新游戏开场播放的 cutscene；留空则不写入")
        f.addRow("initialCutscene", self._initial_cutscene)

        self._cutscene_flag = FlagKeyPickField(model, None, "", self)
        self._cutscene_flag.setMinimumWidth(200)
        self._cutscene_flag.setToolTip("记录开场 cutscene 已播放的 flag，避免重复播放")
        f.addRow("initialCutsceneDoneFlag", self._cutscene_flag)
        lay.addWidget(start_box)

        # -- Display settings ---------------------------------------------------
        disp_section = CollapsibleSection("Display（分辨率/窗口）", start_open=False)
        disp_inner = QWidget()
        disp_lay = QVBoxLayout(disp_inner)
        disp_lay.setContentsMargins(0, 0, 0, 0)

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

        disp_section.add_body(disp_inner)
        lay.addWidget(disp_section)

        # -- Startup flags ------------------------------------------------------
        flags_box = QGroupBox("startupFlags（新存档初始 flag）")
        flags_box.setToolTip("新游戏开始时预置的 flag 键值，作为初始世界状态")
        flags_box_lay = QVBoxLayout(flags_box)
        self._flags_table = QTableWidget(0, 2)
        self._flags_table.setHorizontalHeaderLabels(["key", "value"])
        _flags_header = self._flags_table.horizontalHeader()
        _flags_header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        _flags_header.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        self._flags_table.setMinimumHeight(70)
        self._flags_table.setToolTip("逐行登记新存档初始 flag 的 key/value")
        flags_box_lay.addWidget(self._flags_table)
        self._flags_empty_hint = QLabel("暂无初始 flag，点击「+ Flag」新增一行。")
        self._flags_empty_hint.setStyleSheet("color:#888;")
        self._flags_empty_hint.setWordWrap(True)
        flags_box_lay.addWidget(self._flags_empty_hint)
        flag_btns = QHBoxLayout()
        add_flag = QPushButton("+ Flag"); add_flag.clicked.connect(self._add_flag)
        add_flag.setToolTip("新增一条初始 flag（key/value）")
        del_flag = QPushButton("− Flag"); del_flag.clicked.connect(self._del_flag)
        del_flag.setToolTip("删除当前选中的 flag 行")
        flag_btns.addWidget(add_flag)
        flag_btns.addWidget(del_flag)
        flag_btns.addStretch(1)
        flags_box_lay.addLayout(flag_btns)
        lay.addWidget(flags_box)

        apply_btn = QPushButton("Apply")
        apply_btn.setToolTip("把当前配置写入 game_config 并标脏；保存工程后写入磁盘。")
        apply_btn.clicked.connect(self._apply)
        lay.addWidget(apply_btn)
        lay.addStretch()
        self._load()

    def reload_refs_from_model(self) -> None:
        """主窗口切页后调用：重拉引用候选（本会话新建的场景/任务/演出 id 才可见），
        保留各选择器当前值（含未 Apply 的编辑；IdRefSelector.set_items 静态快照不自更新，
        故需切页重拉——见 mainwindow-editor-hooks 契约 3）。startupFlags 用 live 的
        FlagKeyPickField，无需在此刷新（复核 P2 ③）。"""
        for sel, items in (
            (self._initial_scene, [(s, s) for s in self._model.all_scene_ids()]),
            (self._initial_quest, self._model.all_quest_ids()),
            (self._fallback_scene, [(s, s) for s in self._model.all_scene_ids()]),
            (self._initial_cutscene, self._model.all_cutscene_ids()),
        ):
            cur = sel.current_id()
            sel.set_items(items)
            sel.set_current(cur)

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
        self._update_flags_empty_hint()

    def _update_flags_empty_hint(self) -> None:
        """startupFlags 表为空时显示引导提示，否则隐藏（纯视图）。"""
        self._flags_empty_hint.setVisible(self._flags_table.rowCount() == 0)

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
        self._update_flags_empty_hint()

    def _del_flag(self) -> None:
        r = self._flags_table.currentRow()
        if r >= 0:
            self._flags_table.removeRow(r)
        self._update_flags_empty_hint()

    def _is_dirty(self) -> bool:
        """把 UI 写进模型的临时副本与现状比较，判断是否有未应用改动。

        deepcopy-write-compare 避免逐字段镜像 _apply 的复杂逻辑，且 _write_config_into
        就地改写（保留未受管字段），不会误判/误删。"""
        test = copy.deepcopy(self._model.game_config)
        self._write_config_into(test)
        return test != self._model.game_config

    def flush_to_model(self) -> bool:
        """Save All 钩子：未应用编辑在保存前提交，避免静默丢弃。"""
        if self._is_dirty():
            self._apply()
        return True

    def confirm_close(self, parent: QWidget | None = None) -> bool:
        if not self._is_dirty():
            return True
        r = QMessageBox.question(
            self, "未应用的修改", "游戏配置有未应用的修改。保存到模型？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            self._apply()
        else:
            # Discard：把表单回滚到模型当前值。否则关闭路径随后的统一 flush 会按
            # UI≠模型判脏，把刚被放弃的编辑重新提交（复核 P1-01）。
            self._load()
        return True

    def _write_config_into(self, cfg: dict) -> None:
        """把当前 UI 值就地写入 cfg（不 mark_dirty）。_apply 与脏判断共用。"""
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

    def _apply(self) -> None:
        self._write_config_into(self._model.game_config)
        self._model.mark_dirty("config")
