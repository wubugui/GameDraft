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
from ..shared.action_editor import ActionEditor, FilterableTypeCombo
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
from ..shared.widget_discard import discard_widget
from ..shared.health_forms import HealthConfigForm


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

# 点火（playerActs.ignite，燃烧系统 A3.8）不进上面的整槽写出机制：walkSpeed 没有数值缺省
# （缺省 = 本场景走路速度），写成 0 就改了行为。三项各自「缺省不写键」，见 _read_ignite_ui。
_IGNITE_DEFAULT_ANIMATION = "ignite"
#: 仅作 walkSpeed 控件的初值提示（Player.ts 的 DEFAULT_PLAYER_WALK_SPEED）；不勾「写」就不落盘
_IGNITE_WALK_SPEED_HINT = 100.0
#: _read_ignite_ui 的「整槽不写」哨兵
_OMIT = object()


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

        # 缺省值与游戏的标准视口一致（4:3）。以前这里是 1280×720：没勾时一按勾就把标准换成 16:9，
        # 与 exe 窗口写死 16:9 是同一类漂移（2026-09-06 「打包出来比例不对」）。
        vp_row, self._vp_chk, self._vp_w, self._vp_h = _make_size_row("Viewport")
        self._vp_w.setValue(1024)
        self._vp_h.setValue(768)
        self._vp_chk.setToolTip(
            "逻辑渲染分辨率（标准 1024×768，4:3）：所有游戏元素在这个尺寸内布局与渲染。\n"
            "显示时只做等比缩放（信箱/柱箱），窗口是什么形状都不会拉伸变形。"
        )
        disp_lay.addLayout(vp_row)

        ws_row, self._ws_chk, self._ws_w, self._ws_h = _make_size_row("Window Size")
        self._ws_w.setValue(1024)
        self._ws_h.setValue(768)
        self._ws_chk.setToolTip(
            "宿主窗口的期望尺寸：编辑器 F5 预览窗与打包 exe 的窗口都按它开。\n"
            "不影响逻辑分辨率，也不决定画面比例（画面按 Viewport 比例等比放进窗口）。通常与 Viewport 相同。"
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
        lay.addWidget(self._build_night_window_section())
        self._health_section = CollapsibleSection("三把火与剧情系绳", start_open=False)
        self._health_form = None
        self._health_section.expanded_changed.connect(self._expand_health)
        lay.addWidget(self._health_section)

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
            "黄昏 18:00 / 入夜 20:00。\n\n"
            "「街上有人」勾选＝这一段人在外面做事，是没写时段归属的 NPC（龙套/群演）的缺省。\n"
            "改时段 id 不会连累代码——运行时只认这个勾，不认任何时段名字。",
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

    def _add_phase_row(
        self, pid: str = "", frm: str = "00:00", label: str = "", daylight: bool = False
    ) -> None:
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
        w_daylight = QCheckBox("街上有人")
        w_daylight.setChecked(bool(daylight))
        w_daylight.setToolTip(
            "勾上＝这一段「人在外面做事」。\n"
            "没写时段归属的 NPC（龙套/群演）就只在勾了的段里出现，天一擦黑自动收摊。\n"
            "有作息的具名角色请用 NPC 日程表，两者正交。\n\n"
            "⚠ 一段都不勾＝这条缺省失效，所有龙套全天都在（并在控制台告警）。"
        )
        rl.addWidget(QLabel("id"))
        rl.addWidget(w_id)
        rl.addWidget(QLabel("起于"))
        rl.addWidget(w_from)
        rl.addWidget(QLabel("名"))
        rl.addWidget(w_label)
        rl.addWidget(w_daylight)
        rl.addStretch(1)
        self._dn_phase_lay.addWidget(row)
        self._dn_phase_rows.append(
            {
                "widget": row,
                "id": w_id,
                "from": w_from,
                "label": w_label,
                "daylight": w_daylight,
            }
        )

    def _remove_phase_row(self) -> None:
        if not self._dn_phase_rows:
            return
        row = self._dn_phase_rows.pop()
        discard_widget(row["widget"])

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
                # 缺省 False 不写键（防「打开即注入」，与本页其它可选键同惯例）
                if r["daylight"].isChecked():
                    entry["daylight"] = True
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
                    p.get("daylight") is True,
                )
        else:
            for pid, frm, lab, daylight in ProjectModel.DEFAULT_TIME_PHASES:
                self._add_phase_row(pid, frm, lab, daylight)
        self._dn_phase_host.setEnabled(has_custom)

    def _build_player_acts_section(self) -> CollapsibleSection:
        """蹲/注视/躺/上脚/跳/点火 的全局参数。重块 → 默认折叠。"""
        sec = CollapsibleSection("玩家身体动词（蹲 / 注视 / 躺 / 上脚 / 跳 / 点火）", start_open=False)
        sec.set_header_tool_tip(
            "键位：C 蹲（躺点上按 C 即躺）· X 驻足注视 · F 上脚 · 空格 跳 · "
            "E 点火（手上拿着燃着的点火挂件、走到可燃物跟前）。\n"
            "动画映射在「玩家化身」页；某动词没有映射到片段时自动禁用。\n"
            "整块缺省不写 = 各动词（含点火）全按缺省开启。"
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

        body_lay.addWidget(self._build_ignite_act_box())
        sec.add_body(body)
        return sec

    # ———————————————— 点火（playerActs.ignite） ————————————————

    def _build_ignite_act_box(self) -> QGroupBox:
        box = QGroupBox("点火（地图上点可燃物，按 E）")
        box.setToolTip(
            "玩家手上拿着燃着的点火挂件、走到可燃物跟前按 E：走到站位 → 播点火动画 → "
            "接触帧火头对准着火点、点着。\n"
            "点火接触帧在「动画浏览」页的挂点面板里逐帧勾「本帧点火接触」。"
        )
        form = compact_form(QFormLayout(box))
        # 盘上原样快照（_load_player_acts 填）：「原本有没有这个键」一律按打开时的盘面判
        self._ignite_snap_present = False
        self._ignite_snap: object = None
        self._ignite_anim_seed: tuple[bool, object, str] = (False, None, "")
        self._ignite_ws_seed: tuple[bool, object, float] = (False, None, 0.0)

        self._ignite_enabled = QCheckBox("启用（玩家按 E 点火）")
        self._ignite_enabled.setToolTip(
            "取消勾选 = 只关掉「玩家按 E 点可燃物」；\n"
            "内容里的动作 igniteBurnable 照常能点着东西，不受这里影响。\n"
            "缺省勾上（不写键）。"
        )
        form.addRow(self._ignite_enabled)

        self._ignite_anim = FilterableTypeCombo(
            self._ignite_anim_entries(),
            orphan_label=lambda v: f"{v}（化身 stateMap 里没有这个名字）",
            select_only=False,
        )
        self._ignite_anim.setMaximumWidth(260)
        self._ignite_anim.setToolTip(
            "点火动画的**逻辑状态名**，不是片段名：经「玩家化身」页的 stateMap 映射成片段，\n"
            "映射不出来时运行时退回 idle。\n"
            "选「缺省」= 不写键，运行时按 ignite 解析。候选 = ignite + 化身 stateMap 已有的名字。"
        )
        form.addRow("点火动画（逻辑状态）", self._ignite_anim)

        ws_row = QHBoxLayout()
        self._ignite_ws_chk = QCheckBox("写")
        self._ignite_ws_chk.setToolTip("不勾 = 不写键 = 按本场景的玩家走路速度走到站位")
        ws_row.addWidget(self._ignite_ws_chk)
        self._ignite_ws = QDoubleSpinBox()
        self._ignite_ws.setRange(0.0, 5000.0)
        self._ignite_ws.setDecimals(2)
        self._ignite_ws.setSingleStep(10.0)
        self._ignite_ws.setSuffix(" wu/s")
        self._ignite_ws.setMaximumWidth(130)
        self._ignite_ws.setValue(_IGNITE_WALK_SPEED_HINT)
        self._ignite_ws.setEnabled(False)
        self._ignite_ws.setToolTip("走到点火站位的速度（wu/s）；≤0 运行时也按本场景走路速度")
        self._ignite_ws_chk.toggled.connect(self._ignite_ws.setEnabled)
        ws_row.addWidget(self._ignite_ws)
        ws_row.addStretch(1)
        form.addRow("走到站位速度", ws_row)
        return box

    def _ignite_anim_entries(self) -> list[tuple[str, str]]:
        """候选：缺省（不写键）+ ignite + 化身 stateMap 的键（显示映射到的片段）。"""
        entries: list[tuple[str, str]] = [
            (f"（缺省 = {_IGNITE_DEFAULT_ANIMATION}，不写键）", ""),
            (_IGNITE_DEFAULT_ANIMATION, _IGNITE_DEFAULT_ANIMATION),
        ]
        pa = self._model.game_config.get("playerAvatar")
        sm = pa.get("stateMap") if isinstance(pa, dict) else None
        if isinstance(sm, dict):
            seen = {_IGNITE_DEFAULT_ANIMATION}
            for k, clip in sm.items():
                name = str(k).strip()
                if not name or name in seen:
                    continue
                seen.add(name)
                entries.append((f"{name} → {clip}", name))
        return entries

    def _load_ignite(self, acts_cfg: dict) -> None:
        present = "ignite" in acts_cfg
        raw = acts_cfg.get("ignite")
        self._ignite_snap_present = present
        self._ignite_snap = copy.deepcopy(raw)
        slot = raw if isinstance(raw, dict) else {}

        self._ignite_enabled.setChecked(slot.get("enabled") is not False)

        self._ignite_anim.set_entries(self._ignite_anim_entries())
        if "animation" in slot:
            a_raw = slot.get("animation")
            a_txt = a_raw if isinstance(a_raw, str) else str(a_raw)
            self._ignite_anim.set_committed_type(a_txt)
            self._ignite_anim_seed = (True, copy.deepcopy(a_raw), self._ignite_anim.committed_type())
        else:
            self._ignite_anim.set_committed_type("")
            self._ignite_anim_seed = (False, None, "")

        if "walkSpeed" in slot:
            w_raw = slot.get("walkSpeed")
            num = w_raw if isinstance(w_raw, (int, float)) and not isinstance(w_raw, bool) else 0.0
            self._ignite_ws_chk.setChecked(True)
            self._ignite_ws.setValue(float(num))
            # 种子快照：控件会 clamp/量化，仍等于种子就回写盘上原字面值（int 不漂 float）
            self._ignite_ws_seed = (True, copy.deepcopy(w_raw), float(self._ignite_ws.value()))
        else:
            self._ignite_ws_chk.setChecked(False)
            self._ignite_ws.setValue(_IGNITE_WALK_SPEED_HINT)
            self._ignite_ws_seed = (False, None, 0.0)

    def _read_ignite_ui(self, current: object) -> object:
        """读点火槽。`current` = 模型当前的 ignite 值（未知子键从它透传）；
        「原本有没有键」按打开时的盘面快照判。返回 `_OMIT` = 不写 ignite。"""
        snap_slot = self._ignite_snap if isinstance(self._ignite_snap, dict) else {}
        slot: dict = copy.deepcopy(current) if isinstance(current, dict) else {}

        # enabled：只有盘上原本有这个键、或用户关掉时才写
        if not self._ignite_enabled.isChecked():
            slot["enabled"] = False
        elif "enabled" in snap_slot:
            orig = snap_slot["enabled"]
            slot["enabled"] = copy.deepcopy(orig) if orig is not False else True
        else:
            slot.pop("enabled", None)

        # animation：空 = 不写；等于缺省 ignite 且盘上原本没键 = 不写；没动过 = 原字面值
        a_present, a_raw, a_seed = self._ignite_anim_seed
        cur = self._ignite_anim.committed_type()
        if a_present and cur == a_seed:
            slot["animation"] = copy.deepcopy(a_raw)
        elif not cur.strip() or (cur.strip() == _IGNITE_DEFAULT_ANIMATION and not a_present):
            slot.pop("animation", None)
        else:
            slot["animation"] = cur.strip()

        # walkSpeed：不勾「写」= 不写；控件没动过 = 原字面值；否则整数值写 int
        w_present, w_raw, w_seed = self._ignite_ws_seed
        if not self._ignite_ws_chk.isChecked():
            slot.pop("walkSpeed", None)
        else:
            v = float(self._ignite_ws.value())
            if w_present and v == w_seed:
                slot["walkSpeed"] = copy.deepcopy(w_raw)
            else:
                slot["walkSpeed"] = int(v) if v.is_integer() else v

        if slot:
            return slot
        if not self._ignite_snap_present:
            return _OMIT
        # 盘上原本就有 ignite：非 dict 的原值（如 null）三项全缺省时原样透传；dict 则留空槽
        return slot if isinstance(current, dict) else copy.deepcopy(current)

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
        # 点火槽单独读写：三项缺省且盘上原本没 ignite ⇒ 不写（_default_player_acts 不含它，
        # 故「打开→Apply」不会因点火凭空写出 playerActs）
        ign = self._read_ignite_ui(out.get("ignite"))
        if ign is _OMIT:
            out.pop("ignite", None)
        else:
            out["ignite"] = ign
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
        self._load_ignite(cfg)


    # ── 窥夜法宝（玩法清单 F.5）──────────────────────────────────────
    #
    # 整块不勾 = 不写 nightWindow 键，运行时用内置值。与日夜那一节同一个取舍：
    # 作者没表态就别在 JSON 里留一堆等于缺省的数字，将来改内置值才不会被它们钉死。
    _NW_FIELDS = (
        # (键, 标签, 最小, 最大, 步长, 小数位, 缺省, 提示)
        ("halfAngleDeg", "半角(度)", 1.0, 89.0, 1.0, 1, 34.0,
         "楔形张多宽。越小越像一道缝，越大越像一片扇面。"),
        ("nearWu", "近截距(wu)", 0.0, 2000.0, 5.0, 0, 10.0,
         "顶点附近这一截不显示，免得脚底下糊成一片。"),
        ("farWu", "远截距(wu)", 50.0, 50000.0, 100.0, 0, 5000.0,
         "铺多远。给小了窗只罩住脚下一条带，看着像地上一摊影子而不是一扇窗。"),
        ("heightDownWu", "下沿(wu)", -5000.0, 5000.0, 10.0, 0, 0.0,
         "相对顶点的世界 Y 下界。上沿 <= 下沿 = 不限高。"),
        ("heightUpWu", "上沿(wu)", -5000.0, 5000.0, 10.0, 0, 0.0,
         "相对顶点的世界 Y 上界。与下沿相等 = 不限高。"),
        ("softAngleDeg", "角度软化(度)", 0.0, 45.0, 0.5, 1, 4.0,
         "两侧边界的羽化宽度。0 = 硬边，切口感。"),
        ("softRangeWu", "距离软化(wu)", 0.0, 2000.0, 5.0, 0, 60.0,
         "远近两端的羽化宽度。0 = 硬边。"),
        ("softHeightWu", "高度软化(wu)", 0.0, 2000.0, 5.0, 0, 0.0,
         "上下沿的羽化宽度（只在限高时有意义）。"),
        ("apexLiftWu", "顶点抬高(wu)", 0.0, 2000.0, 5.0, 0, 0.0,
         "楔形顶点从脚点往上抬多少，免得窗像从地缝里长出来。"),
        ("fadeSeconds", "开合渐变(秒)", 0.0, 5.0, 0.05, 2, 0.18,
         "举起 / 收起的淡入淡出时长。0 = 瞬开瞬关。"),
    )
    _NW_RULE_FIELDS = (
        ("drainPerSecond", "阳气/秒", 0.0, 100.0, 0.5, 2, 2.0,
         "被对面的东西看着时每秒扣多少阳气。走与普通鬼物同一条扣血通道（防护、死亡系绳照旧）。\n"
         "0 = 只看不掉血。"),
        ("drainFalloffAtFar", "远端倍率", 0.0, 4.0, 0.05, 2, 0.25,
         "距离衰减：顶点处按满额扣，到远截距降到这个倍率。1 = 远近一个样。"),
        ("rememberSeconds", "记住你(秒)", 0.0, 60.0, 0.5, 2, 1.5,
         "同一只东西连续看够这么多秒 = 它记住你了，发一次派生信号。0 = 不发。"),
    )

    def _build_night_window_section(self) -> CollapsibleSection:
        """窥夜法宝：楔形形状 + 被看见的代价。"""
        sec = CollapsibleSection("窥夜法宝（楔形 / 被看见的代价）", start_open=False)
        sec.set_header_tool_tip(
            "举起法宝，从角色身上朝**鼠标指的方向**张开一片楔形，\n"
            "里头显示的是同一处、对面那一段的真实样子（白天看见夜、夜里看见白天）。\n\n"
            "只在画过夜原画的场景有效——没画过的场景法宝安静地没反应，这是合法状态不是错误。\n"
            "整块不勾＝不写 nightWindow 键，运行时用内置值。",
        )
        body = QWidget()
        body_lay = QVBoxLayout(body)
        body_lay.setContentsMargins(0, 0, 0, 0)

        self._nw_custom = QCheckBox("自定义窥夜参数（不勾＝用运行时内置值）")
        self._nw_custom.setToolTip(
            "勾上后下面的值会写进 game_config.json；不勾＝不写这一块。",
        )
        self._nw_custom.toggled.connect(self._on_nw_custom_toggled)
        body_lay.addWidget(self._nw_custom)

        self._nw_spins: dict[str, QDoubleSpinBox] = {}
        for title, fields in (("楔形", self._NW_FIELDS), ("玩法", self._NW_RULE_FIELDS)):
            box = QGroupBox(title)
            form = compact_form(QFormLayout())
            for key, label, lo, hi, step, dec, default, tip in fields:
                sp = QDoubleSpinBox()
                sp.setRange(lo, hi)
                sp.setSingleStep(step)
                sp.setDecimals(dec)
                sp.setValue(default)
                sp.setMaximumWidth(120)
                sp.setToolTip(tip)
                self._nw_spins[key] = sp
                form.addRow(label, sp)
            box.setLayout(form)
            body_lay.addWidget(box)

        sig_box = QGroupBox("被记住时发的信号")
        sig_form = compact_form(QFormLayout())
        self._nw_signal_prefix = QLineEdit()
        self._nw_signal_prefix.setPlaceholderText("peek_seen")
        self._nw_signal_prefix.setToolTip(
            "实际发出的是「前缀:实体 id」这种派生信号，叙事图监听它。\n"
            "⚠ 这条不写 flag：进度 / 门控 / 做过没有一律走叙事状态机。",
        )
        sig_form.addRow("信号前缀", self._nw_signal_prefix)
        self._nw_damage_source = QLineEdit()
        self._nw_damage_source.setPlaceholderText("peek_window")
        self._nw_damage_source.setToolTip("扣血的来源 id，供护身物匹配与死亡说明用。")
        sig_form.addRow("扣血来源 id", self._nw_damage_source)
        sig_box.setLayout(sig_form)
        body_lay.addWidget(sig_box)

        self._nw_body = body
        sec.add_body(body)
        return sec

    def _on_nw_custom_toggled(self, on: bool) -> None:
        for sp in self._nw_spins.values():
            sp.setEnabled(on)
        self._nw_signal_prefix.setEnabled(on)
        self._nw_damage_source.setEnabled(on)

    def _load_night_window(self) -> None:
        nw = self._model.game_config.get("nightWindow")
        has = isinstance(nw, dict) and bool(nw)
        self._nw_custom.setChecked(has)
        cone = (nw or {}).get("cone") if has else {}
        rules = (nw or {}).get("rules") if has else {}
        for key, _l, _lo, _hi, _st, _d, default, _t in self._NW_FIELDS:
            src = cone if isinstance(cone, dict) else {}
            v = src.get(key)
            self._nw_spins[key].setValue(float(v) if isinstance(v, (int, float)) else default)
        for key, _l, _lo, _hi, _st, _d, default, _t in self._NW_RULE_FIELDS:
            src = rules if isinstance(rules, dict) else {}
            v = src.get(key)
            self._nw_spins[key].setValue(float(v) if isinstance(v, (int, float)) else default)
        r = rules if isinstance(rules, dict) else {}
        self._nw_signal_prefix.setText(str(r.get("rememberSignalPrefix", "") or ""))
        self._nw_damage_source.setText(str(r.get("damageSourceId", "") or ""))
        self._on_nw_custom_toggled(has)

    def _read_night_window_ui(self) -> dict | None:
        """返回要写进 cfg 的那一块；不勾自定义时返回 None（= 删键）。"""
        if not self._nw_custom.isChecked():
            return None
        cone = {}
        for key, _l, _lo, _hi, _st, dec, _def, _t in self._NW_FIELDS:
            cone[key] = round(self._nw_spins[key].value(), dec)
        rules = {}
        for key, _l, _lo, _hi, _st, dec, _def, _t in self._NW_RULE_FIELDS:
            rules[key] = round(self._nw_spins[key].value(), dec)
        pre = self._nw_signal_prefix.text().strip()
        if pre:
            rules["rememberSignalPrefix"] = pre
        src = self._nw_damage_source.text().strip()
        if src:
            rules["damageSourceId"] = src
        return {"cone": cone, "rules": rules}

    def _expand_health(self, expanded: bool) -> None:
        if expanded and self._health_form is None:
            self._health_form = HealthConfigForm(self._model, self._health_data, self)
            self._health_section.add_body(self._health_form)

    def _load_health(self) -> None:
        self._health_data = copy.deepcopy(self._model.game_config.get("health", {}))
        if self._health_form is not None:
            discard_widget(self._health_form)
            self._health_form = None
            self._expand_health(True)

    def commit_pending_on_leave(self) -> bool:
        return self.flush_to_model()

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
        # 点火动画候选取自「玩家化身」页的 stateMap；set_entries 保当前值（悬垂作孤儿项展示）
        self._ignite_anim.set_entries(self._ignite_anim_entries())
        if self._health_form is not None:
            self._health_form.reload_refs_from_model()

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
        self._load_night_window()
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
        self._load_health()

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

        nw = self._read_night_window_ui()
        if nw is not None:
            cfg["nightWindow"] = nw
        elif "nightWindow" in cfg:
            del cfg["nightWindow"]

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
        health = self._health_form.value() if self._health_form is not None else copy.deepcopy(self._health_data)
        if health or "health" in cfg:
            cfg["health"] = health
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
