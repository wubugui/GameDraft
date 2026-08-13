"""Global game config editor."""
from __future__ import annotations

import copy

from PySide6.QtCore import QTime
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QFormLayout, QPushButton, QLabel, QLineEdit,
    QTableWidget, QHeaderView, QSpinBox, QDoubleSpinBox, QCheckBox, QMessageBox,
    QScrollArea, QGroupBox, QColorDialog, QTableWidgetItem, QTimeEdit,
)

from ..project_model import ProjectModel
from ..shared.action_editor import ActionEditor
from ..shared.id_ref_selector import IdRefSelector
from ..shared.flag_key_field import FlagKeyPickField
from ..shared.flag_value_edit import FlagValueEdit
from ..shared.form_layout import compact_form
from ..shared.collapsible_section import CollapsibleSection
from ..shared.text_palette import (
    DEFAULT_TEXT_PALETTE,
    ID_RE,
    count_palette_id_uses,
    load_text_palette,
)


# 玩家身体动词参数表：(verb, 分组标题, [(键, 标签, 类型, 下限, 上限, tooltip)])
# 与 src/data/types.ts 的 PlayerPostureConfig / PlayerActConfig 对齐。
_PLAYER_ACT_FIELDS: tuple[tuple[str, str, tuple[tuple[str, str, str, float, float, str], ...]], ...] = (
    ("crouch", "蹲（按住 C）", (
        ("allowRun", "蹲着仍可奔跑", "bool", 0, 1, "缺省关：蹲下就不许跑"),
        ("speedScale", "移速系数", "float", 0.0, 4.0, "蹲着移动的速度倍率，乘在场景速度上"),
        ("enterMs", "下蹲耗时(ms)", "int", 0, 5000, "下蹲动画时长，期间站定"),
        ("exitMs", "起身耗时(ms)", "int", 0, 5000, "起身动画时长（下蹲片段倒放）"),
    )),
    ("gaze", "驻足注视（按住 X）", (
        ("speedScale", "移速系数", "float", 0.0, 4.0, "注视时通常为 0＝站定不动"),
        ("holdMsToTrigger", "触发前按住(ms)", "int", 0, 10000,
         "0＝进入注视即触发目标的 gaze 回调；>0＝盯够这么久才触发"),
        ("enterMs", "起手耗时(ms)", "int", 0, 5000, "进入注视的过渡时长"),
        ("exitMs", "收回耗时(ms)", "int", 0, 5000, "松键回站姿的过渡时长"),
    )),
    ("lie", "躺（躺点上按 C）", (
        ("freeAnywhere", "任意地面都能躺", "bool", 0, 1,
         "缺省关：只有 act_spot 躺点能躺（满街乱躺美术上必翻车）"),
        ("enterMs", "躺下耗时(ms)", "int", 0, 8000, "躺下动画时长"),
        ("exitMs", "起身耗时(ms)", "int", 0, 8000, "起身时长，期间不可打断——这是躺的代价"),
    )),
    ("kick", "上脚 / 踢（按 F）", (
        ("callbackFrame", "回调帧", "int", -1, 64,
         "回调落在动画第几帧（表演对齐，不影响成败）；-1＝片段中点"),
    )),
    ("jump", "跳（按空格）", (
        ("durationMs", "抛物线时长(ms)", "int", 50, 5000, "原地跳与跨点跳共用；act_spot 可单独覆盖"),
        ("arcHeight", "抬升高度", "int", 0, 400, "抛物线视觉抬升像素；act_spot 可单独覆盖"),
    )),
)

# 缺省值（与运行时 PlayerActionSystem 的常量一致）；载入时用于填空缺键。
_PLAYER_ACT_DEFAULTS: dict[str, dict[str, float]] = {
    "crouch": {"allowRun": False, "speedScale": 0.45, "enterMs": 250, "exitMs": 300},
    "gaze": {"speedScale": 0.0, "holdMsToTrigger": 0, "enterMs": 200, "exitMs": 200},
    "lie": {"freeAnywhere": False, "enterMs": 700, "exitMs": 900},
    "kick": {"callbackFrame": -1},
    "jump": {"durationMs": 480, "arcHeight": 46},
}


def _parse_hhmm(raw: str) -> tuple[int, int]:
    """`HH:MM` → (时, 分)；非法回落 (0, 0)。与运行时 dayTime.parseClock 同口径。"""
    s = str(raw or "").strip()
    if ":" not in s:
        return (0, 0)
    h, _, m = s.partition(":")
    try:
        hh, mm = int(h), int(m)
    except ValueError:
        return (0, 0)
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        return (0, 0)
    return (hh, mm)


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
        self._initial_quest.set_items(model.quest_status_target_ids())
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

        # 头顶气泡全局缩放：不勾 = 不写键（运行时按 1 走）
        bub_row = QHBoxLayout()
        self._bubble_scale_chk = QCheckBox("头顶气泡缩放")
        self._bubble_scale_chk.setToolTip(
            "说话「…」气泡 / showEmote / showSpeechBubble 的**全局**大小倍率，缺省 1。\n"
            "字号、内边距、圆角、描边一起等比放大（按新字号重排，文字不会糊）。\n"
            "单处要不一样，在那条对话行 / 那个 action 里勾「覆盖」单独给值。",
        )
        bub_row.addWidget(self._bubble_scale_chk)
        self._bubble_scale = QDoubleSpinBox()
        self._bubble_scale.setRange(0.3, 4.0)
        self._bubble_scale.setSingleStep(0.1)
        self._bubble_scale.setDecimals(2)
        self._bubble_scale.setValue(1.0)
        self._bubble_scale.setMaximumWidth(90)
        self._bubble_scale.setEnabled(False)
        self._bubble_scale_chk.toggled.connect(self._bubble_scale.setEnabled)
        bub_row.addWidget(self._bubble_scale)
        bub_row.addStretch(1)
        disp_lay.addLayout(bub_row)

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
        lay.addWidget(self._build_text_palette_section())

        lay.addWidget(self._build_day_night_section())
        lay.addWidget(self._build_player_acts_section())

        apply_btn = QPushButton("Apply")
        apply_btn.setToolTip("把当前配置写入 game_config 并标脏；保存工程后写入磁盘。")
        apply_btn.clicked.connect(self._apply)
        lay.addWidget(apply_btn)
        lay.addStretch()
        self._load()

    # ———————————————— 玩家身体动词（playerActs） ————————————————

    def _build_day_night_section(self) -> CollapsibleSection:
        """时段分段点与开局时刻。整块缺省不写 = 用运行时内置四段。"""
        sec = CollapsibleSection("日夜循环（时段分段 / 开局时刻）", start_open=False)
        sec.set_header_tool_tip(
            "时段由时刻派生：条件叶 {timePhase:…} 与场景外观都按它走。\n"
            "整块留空（不勾「自定义时段」）= 用内置四段：拂晓 05:00 / 白日 07:00 / "
            "黄昏 18:00 / 入夜 20:00。",
        )
        body = QWidget()
        body_lay = QVBoxLayout(body)
        body_lay.setContentsMargins(0, 0, 0, 0)

        top = compact_form(QFormLayout())
        self._dn_start = QTimeEdit()
        self._dn_start.setDisplayFormat("HH:mm")
        self._dn_start.setMaximumWidth(92)
        self._dn_start.setToolTip("开局（和重开一局）时的时刻。缺省 07:00。")
        top.addRow("开局时刻", self._dn_start)
        self._dn_trans_ms = QSpinBox()
        self._dn_trans_ms.setRange(0, 60000)
        self._dn_trans_ms.setSingleStep(100)
        self._dn_trans_ms.setMaximumWidth(120)
        self._dn_trans_ms.setToolTip("过渡表现的缺省时长（毫秒），供渲染侧消费。缺省 1500。")
        top.addRow("过渡时长(ms)", self._dn_trans_ms)
        top_host = QWidget()
        top_host.setLayout(top)
        body_lay.addWidget(top_host)

        self._dn_custom = QCheckBox("自定义时段分段（不勾＝用内置四段）")
        self._dn_custom.setToolTip(
            "勾上后下面的分段表生效并写进 game_config.json；\n"
            "不勾＝不写 phases 键，运行时用内置四段。",
        )
        self._dn_custom.toggled.connect(self._on_dn_custom_toggled)
        body_lay.addWidget(self._dn_custom)

        btns = QHBoxLayout()
        add = QPushButton("+ 时段")
        add.clicked.connect(self._add_phase_row)
        rm = QPushButton("删除时段")
        rm.clicked.connect(self._remove_phase_row)
        btns.addWidget(add)
        btns.addWidget(rm)
        btns.addStretch(1)
        body_lay.addLayout(btns)

        self._dn_phase_host = QWidget()
        self._dn_phase_lay = QVBoxLayout(self._dn_phase_host)
        self._dn_phase_lay.setContentsMargins(0, 0, 0, 0)
        body_lay.addWidget(self._dn_phase_host)
        self._dn_phase_rows: list[dict] = []

        sec.add_body(body)
        return sec

    def _on_dn_custom_toggled(self, on: bool) -> None:
        self._dn_phase_host.setEnabled(on)

    def _add_phase_row(self, pid: str = "", frm: str = "00:00", label: str = "") -> None:
        row = QWidget()
        rl = QHBoxLayout(row)
        rl.setContentsMargins(0, 0, 0, 0)
        w_id = QLineEdit(pid)
        w_id.setMaximumWidth(120)
        w_id.setToolTip("时段 id，条件叶 {timePhase:…} 按它引用（如 night）。")
        w_from = QTimeEdit()
        w_from.setDisplayFormat("HH:mm")
        w_from.setMaximumWidth(92)
        h, m = _parse_hhmm(frm)
        w_from.setTime(QTime(h, m))
        w_label = QLineEdit(label)
        w_label.setMaximumWidth(120)
        w_label.setToolTip("中文名，只给编辑器/调试看，不参与判定。")
        rl.addWidget(QLabel("id"))
        rl.addWidget(w_id)
        rl.addWidget(QLabel("起于"))
        rl.addWidget(w_from)
        rl.addWidget(QLabel("名"))
        rl.addWidget(w_label)
        rl.addStretch(1)
        self._dn_phase_lay.addWidget(row)
        self._dn_phase_rows.append({"widget": row, "id": w_id, "from": w_from, "label": w_label})

    def _remove_phase_row(self) -> None:
        if not self._dn_phase_rows:
            return
        row = self._dn_phase_rows.pop()
        row["widget"].setParent(None)
        row["widget"].deleteLater()

    def _reset_phase_rows(self) -> None:
        while self._dn_phase_rows:
            self._remove_phase_row()

    def _read_day_night_ui(self) -> dict:
        out: dict = {}
        start = self._dn_start.time()
        start_s = f"{start.hour():02d}:{start.minute():02d}"
        if start_s != "07:00":
            out["startAt"] = start_s
        if self._dn_trans_ms.value() != 1500:
            out["defaultTransitionMs"] = self._dn_trans_ms.value()
        if self._dn_custom.isChecked():
            phases = []
            for r in self._dn_phase_rows:
                pid = r["id"].text().strip()
                if not pid:
                    continue
                t = r["from"].time()
                entry = {"id": pid, "from": f"{t.hour():02d}:{t.minute():02d}"}
                lab = r["label"].text().strip()
                if lab:
                    entry["label"] = lab
                phases.append(entry)
            if phases:
                out["phases"] = phases
        return out

    def _load_day_night(self) -> None:
        cfg = self._model.game_config.get("dayNight")
        cfg = cfg if isinstance(cfg, dict) else {}
        h, m = _parse_hhmm(str(cfg.get("startAt") or "07:00"))
        self._dn_start.setTime(QTime(h, m))
        ms = cfg.get("defaultTransitionMs")
        self._dn_trans_ms.setValue(int(ms) if isinstance(ms, (int, float)) else 1500)
        self._reset_phase_rows()
        phases = cfg.get("phases")
        has_custom = isinstance(phases, list) and bool(phases)
        self._dn_custom.blockSignals(True)
        self._dn_custom.setChecked(has_custom)
        self._dn_custom.blockSignals(False)
        if has_custom:
            for p in phases:
                if not isinstance(p, dict):
                    continue
                self._add_phase_row(
                    str(p.get("id") or ""),
                    str(p.get("from") or "00:00"),
                    str(p.get("label") or ""),
                )
        else:
            for pid, frm, lab in ProjectModel.DEFAULT_TIME_PHASES:
                self._add_phase_row(pid, frm, lab)
        self._dn_phase_host.setEnabled(has_custom)

    def _build_player_acts_section(self) -> CollapsibleSection:
        """蹲/注视/躺/上脚/跳 的全局参数。重块 → 默认折叠。"""
        sec = CollapsibleSection("玩家身体动词（蹲 / 注视 / 躺 / 上脚 / 跳）", start_open=False)
        sec.set_header_tool_tip(
            "键位：C 蹲（躺点上按 C 即躺）· X 驻足注视 · F 上脚 · 空格 跳。\n"
            "动画映射在「玩家化身」页；某动词没有映射到片段时自动禁用。\n"
            "整块缺省不写 = 五个动词全按缺省开启。"
        )
        body = QWidget()
        body_lay = QVBoxLayout(body)
        body_lay.setContentsMargins(0, 0, 0, 0)
        self._act_widgets: dict[str, dict[str, QWidget]] = {}

        for verb, title, fields in _PLAYER_ACT_FIELDS:
            box = QGroupBox(title)
            form = compact_form(QFormLayout(box))
            widgets: dict[str, QWidget] = {}
            chk = QCheckBox("启用")
            chk.setToolTip("取消勾选 = 该动词彻底关闭（按键无反应、触屏按钮不出）")
            form.addRow(chk)
            widgets["enabled"] = chk
            for key, label, kind, lo, hi, tip in fields:
                if kind == "bool":
                    bw = QCheckBox()
                    bw.setToolTip(tip)
                    form.addRow(label, bw)
                    widgets[key] = bw
                    continue
                if kind == "int":
                    sp: QWidget = QSpinBox()
                    sp.setRange(int(lo), int(hi))  # type: ignore[attr-defined]
                else:
                    sp = QDoubleSpinBox()
                    sp.setRange(float(lo), float(hi))  # type: ignore[attr-defined]
                    sp.setSingleStep(0.05)  # type: ignore[attr-defined]
                    sp.setDecimals(2)  # type: ignore[attr-defined]
                sp.setMaximumWidth(120)
                sp.setToolTip(tip)
                form.addRow(label, sp)
                widgets[key] = sp
            if verb == "kick":
                miss = ActionEditor("落空时（missActions）")
                miss.setToolTip("没踢到任何东西时执行；可以留空（此时按 F 只播动画）")
                miss.set_project_context(self._model)
                form.addRow(miss)
                widgets["missActions"] = miss
            self._act_widgets[verb] = widgets
            body_lay.addWidget(box)

        sec.add_body(body)
        return sec

    def _default_player_acts(self) -> dict:
        """与运行时缺省完全一致的整块（用于判断「用户什么都没改」）。"""
        out: dict = {}
        for verb, _title, fields in _PLAYER_ACT_FIELDS:
            slot: dict = {"enabled": True}
            for key, _label, kind, _lo, _hi, _tip in fields:
                d = _PLAYER_ACT_DEFAULTS[verb][key]
                if kind == "bool":
                    slot[key] = bool(d)
                    continue
                if key == "callbackFrame" and d < 0:
                    continue  # 哨兵不写键
                slot[key] = int(d) if float(d).is_integer() else d
            if verb == "kick":
                slot["missActions"] = []
            out[verb] = slot
        return out

    def _read_player_acts_ui(self) -> dict:
        """把动词区 UI 读成 dict（保留磁盘上本面板不管的未知子键）。"""
        old = self._model.game_config.get("playerActs")
        out: dict = copy.deepcopy(old) if isinstance(old, dict) else {}
        for verb, _title, fields in _PLAYER_ACT_FIELDS:
            widgets = self._act_widgets[verb]
            slot = out.get(verb)
            slot = dict(slot) if isinstance(slot, dict) else {}
            chk = widgets["enabled"]
            slot["enabled"] = bool(chk.isChecked())  # type: ignore[attr-defined]
            for key, _label, kind, _lo, _hi, _tip in fields:
                w = widgets[key]
                if kind == "bool":
                    slot[key] = bool(w.isChecked())  # type: ignore[attr-defined]
                    continue
                if key == "callbackFrame" and int(w.value()) < 0:  # type: ignore[attr-defined]
                    # -1 是编辑器的「不指定」哨兵：不写键 = 运行时取片段中点
                    slot.pop(key, None)
                    continue
                if kind == "int":
                    slot[key] = int(w.value())  # type: ignore[attr-defined]
                else:
                    v = float(w.value())  # type: ignore[attr-defined]
                    # 数值往返保真：整数值写成 int，别让 0.45→0.45、1→1.0 漂移
                    slot[key] = int(v) if float(v).is_integer() else v
            mw = widgets.get("missActions")
            if isinstance(mw, ActionEditor):
                slot["missActions"] = mw.to_list()
            out[verb] = slot
        return out

    def _load_player_acts(self) -> None:
        cfg = self._model.game_config.get("playerActs")
        cfg = cfg if isinstance(cfg, dict) else {}
        for verb, _title, fields in _PLAYER_ACT_FIELDS:
            slot = cfg.get(verb)
            slot = slot if isinstance(slot, dict) else {}
            widgets = self._act_widgets[verb]
            widgets["enabled"].setChecked(slot.get("enabled") is not False)  # type: ignore[attr-defined]
            for key, _label, kind, _lo, _hi, _tip in fields:
                w = widgets[key]
                raw = slot.get(key, _PLAYER_ACT_DEFAULTS[verb][key])
                if kind == "bool":
                    w.setChecked(bool(raw))  # type: ignore[attr-defined]
                    continue
                num = raw if isinstance(raw, (int, float)) and not isinstance(raw, bool) else 0
                if kind == "int":
                    w.setValue(int(num))  # type: ignore[attr-defined]
                else:
                    w.setValue(float(num))  # type: ignore[attr-defined]
            mw = widgets.get("missActions")
            if isinstance(mw, ActionEditor):
                raw_actions = slot.get("missActions")
                mw.set_data(raw_actions if isinstance(raw_actions, list) else [])

    def reload_refs_from_model(self) -> None:
        """主窗口切页后调用：重拉引用候选（本会话新建的场景/任务/演出 id 才可见），
        保留各选择器当前值（含未 Apply 的编辑；IdRefSelector.set_items 静态快照不自更新，
        故需切页重拉——见 mainwindow-editor-hooks 契约 3）。startupFlags 用 live 的
        FlagKeyPickField，无需在此刷新（复核 P2 ③）。"""
        for sel, items in (
            (self._initial_scene, [(s, s) for s in self._model.all_scene_ids()]),
            (self._initial_quest, self._model.quest_status_target_ids()),
            (self._fallback_scene, [(s, s) for s in self._model.all_scene_ids()]),
            (self._initial_cutscene, self._model.all_cutscene_ids()),
        ):
            cur = sel.current_id()
            sel.set_items(items)
            sel.set_current(cur)

    def _build_text_palette_section(self) -> CollapsibleSection:
        """语义色板：内容里写 `[c:<id>]…[/c]` 给某几个字上色，这里定义有哪些档位。

        刻意只给具名档位、不在正文里填色号——这套木框/纸纹观感下逐处自由取色一定走形，
        且改一次这里全局生效。运行时读的就是这份 `game_config.textPalette`（无第二份色表）。
        """
        sec = CollapsibleSection("文本语义色板（[c:…] 上色档位）", start_open=False)
        inner = QWidget()
        lay = QVBoxLayout(inner)
        lay.setContentsMargins(0, 0, 0, 0)

        hint = QLabel(
            "内容里写 [c:id]要上色的字[/c]；策划不用手打——对白/文本框上的「染色」按钮会插。\n"
            "留空整张表＝不写这个键，运行时回落到内置六档。"
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color:#888;")
        lay.addWidget(hint)

        #: 行号 → 磁盘上的原始条目（保值往返用；UI 新建的行为 None）
        self._palette_originals: dict[int, object] = {}
        #: 哪些行是"无法用表单表达、只读透传"的坏元素（含 JSON null）
        self._palette_raw_rows: set[int] = set()
        self._palette_key_present = False
        self._palette_ids_at_load: list[str] = []
        self._palette_table = QTableWidget(0, 3)
        self._palette_table.setHorizontalHeaderLabels(["id（内容里写的）", "中文名", "颜色"])
        ph = self._palette_table.horizontalHeader()
        ph.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        ph.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        ph.setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        self._palette_table.setMinimumHeight(90)
        self._palette_table.setMaximumHeight(220)
        lay.addWidget(self._palette_table)

        row = QHBoxLayout()
        add = QPushButton("+ 档位")
        add.setMaximumWidth(90)
        add.clicked.connect(lambda: self._add_palette_row("", "", "#ffcc66"))
        row.addWidget(add)
        rm = QPushButton("- 删除选中")
        rm.setMaximumWidth(110)
        rm.clicked.connect(self._remove_palette_row)
        row.addWidget(rm)
        reset = QPushButton("恢复内置六档")
        reset.setMaximumWidth(130)
        reset.clicked.connect(self._reset_palette_rows)
        row.addWidget(reset)
        row.addStretch(1)
        lay.addLayout(row)

        sec.add_body(inner)
        return sec

    def _add_palette_row(self, pid: str, label: str, color: str, original=None, raw: bool = False) -> None:
        t = self._palette_table
        r = t.rowCount()
        t.insertRow(r)
        self._palette_originals[r] = original
        self._palette_raw_rows.add(r) if raw else self._palette_raw_rows.discard(r)
        # id 是「自身新 id」，属选择器铁律的唯一例外，允许自由文本
        ide = QLineEdit(pid)
        ide.setPlaceholderText("emphasis")
        ide.setToolTip("内容里写 [c:<这个 id>]；只允许字母/数字/下划线/连字符")
        t.setCellWidget(r, 0, ide)
        lab = QLineEdit(label)
        lab.setPlaceholderText("强调")
        lab.setToolTip("只给人看（染色菜单里显示这个名字）")
        t.setCellWidget(r, 1, lab)
        btn = QPushButton(color or "#ffcc66")
        btn.setMaximumWidth(96)
        btn.setToolTip("点开取色")
        # 原样回显盘上的色值（大小写不动），只有用户真去取色时才改
        self._paint_palette_button(btn, color or "#ffcc66")
        btn.clicked.connect(lambda _=False, b=btn: self._pick_palette_color(b))
        t.setCellWidget(r, 2, btn)

    @staticmethod
    def _paint_palette_button(btn: QPushButton, color: str) -> None:
        btn.setText(color)
        c = QColor(color)
        fg = "#000" if c.isValid() and c.lightness() > 140 else "#fff"
        btn.setStyleSheet(f"background:{color}; color:{fg};")

    def _pick_palette_color(self, btn: QPushButton) -> None:
        cur = QColor(btn.text())
        c = QColorDialog.getColor(cur if cur.isValid() else QColor("#ffcc66"), self, "选择颜色")
        if c.isValid():
            self._paint_palette_button(btn, c.name())

    def _remove_palette_row(self) -> None:
        r = self._palette_table.currentRow()
        if r < 0:
            return
        self._palette_table.removeRow(r)
        # 行号是 originals 的键，删行后整体前移
        self._palette_originals = {
            (i if i < r else i - 1): v
            for i, v in self._palette_originals.items() if i != r
        }
        self._palette_raw_rows = {(i if i < r else i - 1) for i in self._palette_raw_rows if i != r}

    def _reset_palette_rows(self) -> None:
        self._palette_table.setRowCount(0)
        self._palette_originals.clear()
        self._palette_raw_rows.clear()
        self._palette_key_present = True
        for e in DEFAULT_TEXT_PALETTE:
            self._add_palette_row(e["id"], e["label"], e["color"])

    def _read_palette_ui(self) -> list:
        """读表。**保值优先**：非 dict 的坏元素原样透传；dict 从原件复制后只覆盖三个可编辑键，
        额外键与键序都不动；label 空就不写这个键（不替策划编默认名）。"""
        out: list = []
        t = self._palette_table
        for i in range(t.rowCount()):
            if i in self._palette_raw_rows:
                out.append(self._palette_originals.get(i))   # 坏元素只读透传（含 null）
                continue
            original = self._palette_originals.get(i)
            ide = t.cellWidget(i, 0)
            lab = t.cellWidget(i, 1)
            btn = t.cellWidget(i, 2)
            pid = ide.text().strip() if isinstance(ide, QLineEdit) else ""
            color = btn.text().strip() if isinstance(btn, QPushButton) else ""
            name = lab.text().strip() if isinstance(lab, QLineEdit) else ""
            entry = dict(original) if isinstance(original, dict) else {}
            if pid or "id" in entry:
                entry["id"] = pid
            if name:
                entry["label"] = name
            elif "label" in entry and not str(entry.get("label") or ""):
                pass                          # 盘上本来就是空 label：保持原样
            elif not name:
                entry.pop("label", None)
            if color or "color" in entry:
                entry["color"] = color
            out.append(entry)
        return out

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

        bs = cfg.get("emoteBubbleScale")
        if isinstance(bs, (int, float)) and not isinstance(bs, bool) and bs > 0:
            self._bubble_scale_chk.setChecked(True)
            self._bubble_scale.setValue(float(bs))
        else:
            self._bubble_scale_chk.setChecked(False)
            self._bubble_scale.setValue(1.0)

        self._load_day_night()
        self._load_player_acts()

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

        # 色板：**逐字保值**——不走 load_text_palette（那会过滤非法项并补默认），
        # 否则"打开→不动→保存"会把 #FFCC66 改成小写、给缺 label 的补默认、丢掉额外键、
        # 甚至把空数组换成内置六档（真丢数据）。
        self._palette_table.setRowCount(0)
        self._palette_originals.clear()
        self._palette_raw_rows.clear()
        raw = cfg.get("textPalette")
        self._palette_key_present = isinstance(raw, list)
        if self._palette_key_present:
            for e in raw:
                if isinstance(e, dict):
                    self._add_palette_row(
                        str(e.get("id") or ""), str(e.get("label") or ""), str(e.get("color") or ""),
                        original=e,
                    )
                else:
                    # 坏元素只读透传（norms：空集合与数组坏元素一律不改写）。
                    # 含 JSON `null`——靠 `original is not None` 判会把它当成正常行，
                    # 结果凭空写出一个 {"color": "#ffcc66"} 的坏档位。
                    self._add_palette_row("", "", "", original=e, raw=True)
        self._palette_ids_at_load = [
            str(e.get("id") or "") for e in (raw or []) if isinstance(e, dict)
        ]

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

        if self._bubble_scale_chk.isChecked():
            v = float(self._bubble_scale.value())
            cfg["emoteBubbleScale"] = int(v) if float(v).is_integer() else v
        elif "emoteBubbleScale" in cfg:
            del cfg["emoteBubbleScale"]

        # 日夜块：整块为空且磁盘上本就没这个键时不写（防「打开即注入」）
        dn = self._read_day_night_ui()
        if dn:
            cfg["dayNight"] = dn
        elif "dayNight" in cfg:
            del cfg["dayNight"]

        # 玩家动词块：整块与缺省一致且磁盘上本就没有这个键时不写（防「打开即注入」）
        acts = self._read_player_acts_ui()
        if "playerActs" in cfg or acts != self._default_player_acts():
            cfg["playerActs"] = acts

        pal = self._read_palette_ui()
        if pal or getattr(self, "_palette_key_present", False):
            cfg["textPalette"] = pal      # 盘上本来是 [] 就保持 []，不凭空注入内置六档
        elif "textPalette" in cfg:
            del cfg["textPalette"]

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

    def _confirm_palette_id_drops(self) -> bool:
        """有色板档位被改名/删掉时，先扫全工程引用并让策划确认。返回 False=取消本次 Apply。"""
        now = {
            str(e.get("id") or "")
            for e in self._read_palette_ui() if isinstance(e, dict)
        }
        dropped = [pid for pid in getattr(self, "_palette_ids_at_load", []) if pid and pid not in now]
        if not dropped:
            return True
        lines: list[str] = []
        for pid in dropped:
            uses = count_palette_id_uses(self._model.project_path, pid)
            total = sum(uses.values())
            if total == 0:
                continue
            where = "、".join(list(uses)[:3]) + ("…" if len(uses) > 3 else "")
            lines.append(f"「{pid}」还有 {total} 处引用（{where}）")
        if not lines:
            return True
        r = QMessageBox.warning(
            self, "色板档位还在被引用",
            "以下档位被改名或删除，但内容里还写着它：\n\n"
            + "\n".join(lines)
            + "\n\n继续的话，这些 [c:…] 会变成「未知语义色板」——运行时按无色显示，"
              "但那些数据桶从此存不下去，只能逐条手改。\n\n仍要继续？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel,
        )
        return r == QMessageBox.StandardButton.Yes

    def _apply(self) -> None:
        if not self._confirm_palette_id_drops():
            return
        self._write_config_into(self._model.game_config)
        self._model.mark_dirty("config")
        self._palette_ids_at_load = [
            str(e.get("id") or "")
            for e in (self._model.game_config.get("textPalette") or []) if isinstance(e, dict)
        ]
