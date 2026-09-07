"""脚步集 + 空间化音频编辑器（`public/assets/data/footstep_sets.json`）。

与运行时约定见 `src/data/types.ts` 的 `FootstepConfig`（以及 `FootstepSetDef` /
`SpatialAudioConfig` / `AudioListenerConfig`）与 `src/systems/FootstepSystem.ts`。

脚步声的三份数据各住各处，本页只管其中一份：

- **哪一帧落脚** —— 动画包 `sockets.json` 的 `contactSlots`，在「动画浏览」页看着图逐帧标
  （与挂点同一个面板）。**本页不配触地帧。**
- **哪块地用哪套声** —— 场景 / zone 的 `footstepSet` 选一个集 id（场景编辑器）。
- **一套声是什么** —— 本页：`sets` 里每个集按**动画片段名**（`SpriteEntity.getCurrentState()`
  返回的 walk / run / carry_walk / …）给**一条**音效 key，key 与其它音效一样在 Audio 页
  （`audio_config.json` sfx 区）登记，这里只引用。**没有随机轮换、没有抖动**：
  地面换了声音就换，靠 zone 切集。
- `clipFallback`：某集没给这个片段的音效时改用哪个片段的（可链式；链尽即不发声，
  绝无隐式回落到 walk）。
- `defaults.gainDb` / 每集 `gainDb`：增益。每个数值都带一个「写这个键」的勾选框——
  取消勾选是**删键**，不是写 0。
- `spatial` / `listener`：空间化参数与听者。全部单位 wu（**角色高 150 wu** 是尺度锚）。

数据体系（与 smell_profile / pressure_hold 两页同构）：
- 单一真相源 = `ProjectModel.footstep_sets`（load_project 载入的活引用）；本页零文件 IO，
  Apply 只写模型并 `mark_dirty("footstep_sets")`，由主编辑器「全部保存」原子落盘。
- **往返契约**：打开-不改-保存字节不变。数值未改动按原始 int/float 表示回写
  （`_keep_num`）；本页不管的键（含每集、`spatial`、`listener` 内部的未知键）原样透传；
  空值删键而不是写空串。
"""
from __future__ import annotations

import copy
from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSplitter,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel
from ..shared import confirm
from ..shared.audio_library import AudioMetaCache, audio_config_file_for_id, format_duration
from ..shared.audio_preview_selector import AudioIdPreviewSelector
from ..shared.form_layout import compact_form
from ..shared.id_ref_selector import IdRefSelector
from ..shared.list_affordances import wire_list_affordances

#: save_all 的脏桶键（ProjectModel.KNOWN_DIRTY_BUCKETS 已登记）。
DIRTY_BUCKET = "footstep_sets"

_MISSING = object()

#: 每集可覆盖的数值：键 → (显示名, 下限, 上限, 小数位, 步长, 缺省值, 说明)
_SET_NUM_FIELDS: tuple[tuple[str, str, float, float, int, float, float, str], ...] = (
    ("gainDb", "gainDb", -120.0, 60.0, 3, 0.5, 0.0,
     "整集增益（dB）。把某块地整体压低 / 抬高，0 = 不变；与全局 defaults.gainDb 相加。"),
)

#: 全局 defaults：键 → 同上
_DEFAULT_FIELDS: tuple[tuple[str, str, float, float, int, float, float, str], ...] = (
    ("gainDb", "gainDb", -120.0, 60.0, 3, 0.5, -6.0,
     "脚步相对 sfx 通道的整体增益（dB）。脚步是全程最高频的声音，缺省压低。"),
)

#: spatial：键 → 同上。单位一律 wu；角色高 150 wu 是尺度锚。
_SPATIAL_FIELDS: tuple[tuple[str, str, float, float, int, float, float, str], ...] = (
    ("refDistanceWu", "refDistanceWu", 0.0, 1_000_000.0, 4, 10.0, 150.0,
     "参考距离（wu）：近于此不再变响。150 wu ≈ 一个角色的身高。"),
    ("rolloff", "rolloff", 0.0, 100.0, 4, 0.1, 1.0,
     "衰减系数（WebAudio inverse 模型的 rolloffFactor）；越大越快听不见。"),
    ("maxDistanceWu", "maxDistanceWu", 0.0, 10_000_000.0, 4, 100.0, 3000.0,
     "超过此距离（wu）一律不播。⚠ 必须显著大于 listenerBackAtBaseZoomWu，"
     "否则连脚下的声音都会被判成听不见。"),
    ("panWidth", "panWidth", 0.0, 1.0, 4, 0.05, 0.7,
     "声像宽度上限 0..1；1 = 允许全左 / 全右。"),
    ("listenerBackAtBaseZoomWu", "listenerBackAtBaseZoomWu", 0.0, 10_000_000.0, 4, 50.0, 600.0,
     "相机听者在**场景基准 zoom** 下站在画面后方多远（wu）。"
     "实际视距 = 本值 ×(基准 zoom / 当前 zoom)：推拉镜头改变听感，改窗口大小不会。"),
    ("planarDepthScale", "planarDepthScale", 0.0, 100.0, 6, 0.05, 1.4142135623730951,
     "无 depthConfig 场景的纵深近似系数；缺省 √2≈1.414214（假定 45° 俯角）。"),
)

#: listener.mode 下拉：值 → 显示文案
_LISTENER_MODES: tuple[tuple[str, str], ...] = (
    ("camera", "camera —— 站在画面后方沿视线看进画面（唯一能表达推拉镜头的）"),
    ("player", "player —— 玩家的耳朵"),
    ("npc", "npc —— 场景里某个 NPC 的耳朵"),
    ("fixed", "fixed —— 钉在场景里某个点"),
)

#: listener 里随 mode 显隐的可选数值：键 → (显示名, 下限, 上限, 小数位, 步长, 缺省, 说明)
_LISTENER_NUM_FIELDS: tuple[tuple[str, str, float, float, int, float, float, str], ...] = (
    ("x", "x", -10_000_000.0, 10_000_000.0, 4, 10.0, 0.0, "场景坐标 x（wu）。"),
    ("y", "y", -10_000_000.0, 10_000_000.0, 4, 10.0, 0.0, "场景坐标 y（wu）。"),
    ("heightWu", "heightWu", -10_000_000.0, 10_000_000.0, 4, 10.0, 135.0,
     "耳朵离地高度（wu）；player / npc 省略时取该实体身高的 0.9。"),
)


def _keep_num(new_val: float, old_val: object, decimals: int) -> object:
    """未改动的数值按**原始 int/float 表示**回写（150 不漂成 150.0）。

    比较用控件的可显示精度：`planarDepthScale = 1.4142135623730951` 在 6 位小数的
    spinbox 里显示 1.414214，纯浏览一趟不能把它改写成 1.414214（往返契约）。
    """
    if isinstance(old_val, (int, float)) and not isinstance(old_val, bool):
        if round(float(old_val), decimals) == round(float(new_val), decimals):
            return old_val
    return float(new_val)


def _put_map(target: dict, key: str, value: dict) -> None:
    """写一张子表：空表时——原本就是空对象则保留空对象（不改字节），否则删键。"""
    orig = target.get(key)
    if value:
        target[key] = value
    elif isinstance(orig, dict) and not orig:
        target[key] = orig
    else:
        target.pop(key, None)


class _OptionalNumRow(QWidget):
    """`[勾选] [数值框]  说明`：**不勾选＝不写这个键**（运行时取缺省），不是写 0。"""

    def __init__(
        self,
        *,
        minimum: float,
        maximum: float,
        decimals: int,
        step: float,
        fallback: float,
        hint: str = "",
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._decimals = int(decimals)
        self._fallback = float(fallback)
        self._orig: object = _MISSING

        self.check = QCheckBox(self)
        self.check.setToolTip("不勾选＝数据里不写这个键（运行时用缺省值），而不是写 0")
        self.spin = QDoubleSpinBox(self)
        self.spin.setRange(minimum, maximum)
        self.spin.setDecimals(int(decimals))
        self.spin.setSingleStep(step)
        self.spin.setValue(float(fallback))
        self.spin.setEnabled(False)
        self.check.toggled.connect(self.spin.setEnabled)

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(6)
        lay.addWidget(self.check)
        lay.addWidget(self.spin)
        if hint:
            lbl = QLabel(hint, self)
            lbl.setWordWrap(True)
            lbl.setStyleSheet("color: #888;")
            lbl.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
            lay.addWidget(lbl, stretch=1)
            self.setToolTip(hint)
        else:
            lay.addStretch(1)

    def load(self, value: object) -> None:
        """按原值载入；`None` / 非数值 = 该键不存在（不勾选）。"""
        self._orig = value if isinstance(value, (int, float)) and not isinstance(value, bool) \
            else _MISSING
        if self._orig is _MISSING:
            self.check.setChecked(False)
            self.spin.setValue(self._fallback)
        else:
            self.check.setChecked(True)
            self.spin.setValue(float(self._orig))  # type: ignore[arg-type]

    def value_or_none(self) -> object | None:
        """勾选 → 数值（未改动按原表示）；未勾选 → None（调用方删键）。"""
        if not self.check.isChecked():
            return None
        return _keep_num(self.spin.value(), self._orig, self._decimals)


class FootstepSetsEditor(QWidget):
    """footstep_sets.json 编辑器（数据类型 'footstep_sets'）。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._current_set = ""
        #: 当前集的音效工作副本：片段名 → 音效 key（Apply 时整体写回）。
        #: 值正常是 str；数据异形时按身份原样留着（本页只透传，见 _current_value）
        self._sfx: dict[str, Any] = {}
        self._current_clip = ""
        self._listener_mode_missing = False
        self._audio_meta = AudioMetaCache(self)
        self._audio_meta.updated.connect(self._refresh_clip_list)

        root = QVBoxLayout(self)
        self._tabs = QTabWidget(self)
        self._tabs.addTab(self._build_sets_tab(), "脚步集")
        self._tabs.addTab(self._build_global_tab(), "全局配置")
        root.addWidget(self._tabs, stretch=1)

        bottom = QHBoxLayout()
        self._apply_btn = QPushButton("Apply")
        self._apply_btn.setToolTip("把本页（当前脚步集 + 全局配置）的修改提交到模型；"
                                  "落盘仍走主编辑器的「全部保存」")
        self._apply_btn.clicked.connect(self._apply)
        bottom.addWidget(self._apply_btn)
        bottom.addStretch(1)
        root.addLayout(bottom)

        self._reload_from_model()

    # ------------------------------------------------------------------ 构建
    def _build_sets_tab(self) -> QWidget:
        host = QWidget()
        lay = QHBoxLayout(host)
        lay.setContentsMargins(0, 0, 0, 0)
        splitter = QSplitter(Qt.Orientation.Horizontal, host)

        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        b_add = QPushButton("+ 脚步集")
        b_add.setToolTip("新增一套脚步声（一块「地」一套）")
        b_add.clicked.connect(self._add_set)
        b_ren = QPushButton("改名")
        b_ren.setToolTip(
            "重命名脚步集 id。\n"
            "注意：引用它的 scene.footstepSet / zone.footstepSet 不会自动改，"
            "改完请跑数据校验确认无悬垂引用。",
        )
        b_ren.clicked.connect(self._rename_set)
        b_del = QPushButton("删除")
        b_del.setToolTip("删除选中的脚步集（Delete 键 / 右键菜单亦可）")
        b_del.clicked.connect(self._delete_set)
        btn_row.addWidget(b_add)
        btn_row.addWidget(b_ren)
        btn_row.addWidget(b_del)
        ll.addLayout(btn_row)
        self._set_list = QListWidget()
        self._set_list.setToolTip("footstep_sets.json 的 sets 词条；id 即 scene/zone 里引用的名字")
        self._set_list.currentRowChanged.connect(self._on_select_set)
        wire_list_affordances(self._set_list, self._delete_set, delete_label="删除脚步集")
        ll.addWidget(self._set_list)

        right_host = QWidget()
        rl = QVBoxLayout(right_host)

        basic = QGroupBox("基本")
        bf = compact_form(QFormLayout())
        basic.setLayout(bf)
        self._f_label = QLineEdit()
        self._f_label.setMinimumWidth(220)
        self._f_label.setToolTip("策划备注，运行时不读；留空即不写这个键")
        bf.addRow("label", self._f_label)
        self._set_num_rows: dict[str, _OptionalNumRow] = {}
        for key, label, lo, hi, dec, step, fb, hint in _SET_NUM_FIELDS:
            row = _OptionalNumRow(minimum=lo, maximum=hi, decimals=dec, step=step,
                                  fallback=fb, hint=hint)
            self._set_num_rows[key] = row
            bf.addRow(label, row)
        rl.addWidget(basic)

        sfx_box = QGroupBox("音效 sfx（按动画片段名，一个片段一条 key）")
        sfx_box.setToolTip(
            "键就是动画片段名（SpriteEntity.getCurrentState() 返回的那个）：\n"
            "walk / run / carry_walk / carry_heavy_walk / crouchWalk …可自由新增。\n"
            "值是 audio_config.json sfx 区的全局 key——脚步与其它音效一样在 Audio 页登记，"
            "这里只引用。\n"
            "确定性播放：没有随机轮换、没有抖动。地面换了声音就换，靠场景 / zone 选不同的集。",
        )
        vl = QVBoxLayout(sfx_box)
        var_split = QSplitter(Qt.Orientation.Horizontal)

        clip_side = QWidget()
        cl = QVBoxLayout(clip_side)
        cl.setContentsMargins(0, 0, 0, 0)
        cbtns = QHBoxLayout()
        c_add = QPushButton("+ 片段")
        c_add.setToolTip("新增一个动画片段条目（片段名可自由填，如 walk / run / carry_walk）")
        c_add.clicked.connect(self._add_clip)
        c_ren = QPushButton("改名")
        c_ren.setToolTip("改动画片段名")
        c_ren.clicked.connect(self._rename_clip)
        c_del = QPushButton("删除")
        c_del.setToolTip("删除该片段条目（这一集走这个片段时按 clipFallback 回落，回落不到就不响）")
        c_del.clicked.connect(self._delete_clip)
        cbtns.addWidget(c_add)
        cbtns.addWidget(c_ren)
        cbtns.addWidget(c_del)
        cl.addLayout(cbtns)
        self._clip_list = QListWidget()
        self._clip_list.setToolTip("片段名 → 音效 key；没选 key 的条目带 ⚠（走这个片段时不响）")
        self._clip_list.currentRowChanged.connect(self._on_select_clip)
        wire_list_affordances(self._clip_list, self._delete_clip, delete_label="删除片段条目")
        cl.addWidget(self._clip_list)

        sfx_side = QWidget()
        sl = QVBoxLayout(sfx_side)
        sl.setContentsMargins(0, 0, 0, 0)
        sf = compact_form(QFormLayout())
        self._clip_name_label = QLabel("")
        self._clip_name_label.setStyleSheet("font-weight: bold;")
        sf.addRow("片段", self._clip_name_label)
        self._sfx_selector = AudioIdPreviewSelector(self._model, "sfx", allow_empty=True, editable=True)
        self._sfx_selector.setToolTip("这一片段落脚时播的音效 key（可搜索 / 试听；可手填还没登记的 key）")
        self._sfx_selector.value_changed.connect(self._on_sfx_changed)
        sf.addRow("音效 key", self._sfx_selector)
        sl.addLayout(sf)
        self._sfx_hint = QLabel("")
        self._sfx_hint.setWordWrap(True)
        self._sfx_hint.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        sl.addWidget(self._sfx_hint)
        sl.addStretch(1)

        var_split.addWidget(clip_side)
        var_split.addWidget(sfx_side)
        var_split.setSizes([220, 420])
        vl.addWidget(var_split)
        rl.addWidget(sfx_box, stretch=1)
        self._set_form_host = right_host

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(right_host)
        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([200, 620])
        lay.addWidget(splitter)
        return host

    def _build_global_tab(self) -> QWidget:
        host = QWidget()
        outer = QVBoxLayout(host)

        # ---- 触地帧在哪配（本页不配，但作者一定会来这里找）
        cf_note = QLabel(
            "触地帧（哪一帧落脚 → 响）**不在本页**：在「动画浏览」页选中动画包，"
            "展开「挂点 / 落脚帧」区，看着帧图逐帧勾「本帧落脚」，写进动画包的 sockets.json。"
            "本页只配声音本身。",
        )
        cf_note.setWordWrap(True)
        cf_note.setStyleSheet("color: #b58900; padding: 4px;")
        outer.addWidget(cf_note)

        # ---- clipFallback
        fb_box = QGroupBox("片段回落 clipFallback")
        fbl = QVBoxLayout(fb_box)
        fb_hint = QLabel(
            "某集没给「片段」的音效时，改用「回落到的片段」的那条。可链式；"
            "链走到头还查不到就不发声（绝无隐式回落到 walk——否则站着不动也会响）。",
        )
        fb_hint.setWordWrap(True)
        fb_hint.setStyleSheet("color: #888;")
        fbl.addWidget(fb_hint)
        self._fb_table = self._make_table("片段", "回落到的片段")
        fbl.addWidget(self._fb_table)
        fbl.addLayout(self._table_buttons(self._fb_table, "回落"))
        outer.addWidget(fb_box)

        # ---- defaults
        d_box = QGroupBox("全局缺省 defaults")
        df = compact_form(QFormLayout())
        d_box.setLayout(df)
        self._default_rows: dict[str, _OptionalNumRow] = {}
        for key, label, lo, hi, dec, step, fb, hint in _DEFAULT_FIELDS:
            row = _OptionalNumRow(minimum=lo, maximum=hi, decimals=dec, step=step,
                                  fallback=fb, hint=hint)
            self._default_rows[key] = row
            df.addRow(label, row)
        outer.addWidget(d_box)

        # ---- spatial
        s_box = QGroupBox("空间化 spatial（单位一律 wu；角色高 150 wu 是尺度锚）")
        sf = compact_form(QFormLayout())
        s_box.setLayout(sf)
        self._spatial_rows: dict[str, _OptionalNumRow] = {}
        for key, label, lo, hi, dec, step, fb, hint in _SPATIAL_FIELDS:
            row = _OptionalNumRow(minimum=lo, maximum=hi, decimals=dec, step=step,
                                  fallback=fb, hint=hint)
            self._spatial_rows[key] = row
            sf.addRow(label, row)
        self._spatial_warn = QLabel("")
        self._spatial_warn.setWordWrap(True)
        self._spatial_warn.setStyleSheet("color: #e8590c;")
        self._spatial_warn.setVisible(False)
        sf.addRow("", self._spatial_warn)
        for key in ("maxDistanceWu", "listenerBackAtBaseZoomWu"):
            r = self._spatial_rows[key]
            r.spin.valueChanged.connect(lambda _v: self._sync_spatial_warning())
            r.check.toggled.connect(lambda _on: self._sync_spatial_warning())
        outer.addWidget(s_box)

        # ---- listener
        l_box = QGroupBox("听者 listener")
        lf = compact_form(QFormLayout())
        l_box.setLayout(lf)
        self._listener_enabled = QCheckBox("配置听者（不勾选＝不写 listener 键，运行时按 camera）")
        self._listener_enabled.toggled.connect(self._sync_listener_enabled)
        lf.addRow("", self._listener_enabled)
        self._listener_mode = QComboBox()
        for value, text in _LISTENER_MODES:
            self._listener_mode.addItem(text, value)
        self._listener_mode.setToolTip("目标找不到时运行时回落 camera 并在调试状态里报出来，不静默")
        self._listener_mode.currentIndexChanged.connect(lambda _i: self._sync_listener_mode())
        lf.addRow("mode", self._listener_mode)
        self._listener_target = IdRefSelector(allow_empty=True, editable=True)
        self._listener_target.setToolTip("mode=npc 时的 NPC id（可手填还没建的 id）")
        self._listener_target_label = QLabel("targetId")
        lf.addRow(self._listener_target_label, self._listener_target)
        self._listener_rows: dict[str, _OptionalNumRow] = {}
        self._listener_labels: dict[str, QLabel] = {}
        for key, label, lo, hi, dec, step, fb, hint in _LISTENER_NUM_FIELDS:
            row = _OptionalNumRow(minimum=lo, maximum=hi, decimals=dec, step=step,
                                  fallback=fb, hint=hint)
            lbl = QLabel(label)
            self._listener_rows[key] = row
            self._listener_labels[key] = lbl
            lf.addRow(lbl, row)
        outer.addWidget(l_box)
        outer.addStretch(1)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(host)
        return scroll

    def _make_table(self, head_a: str, head_b: str) -> QTableWidget:
        t = QTableWidget(0, 2)
        t.setHorizontalHeaderLabels([head_a, head_b])
        t.verticalHeader().setVisible(False)
        t.setMaximumHeight(180)
        t.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Maximum)
        hh = t.horizontalHeader()
        hh.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        hh.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        return t

    def _table_buttons(self, table: QTableWidget, what: str) -> QHBoxLayout:
        row = QHBoxLayout()
        b_add = QPushButton("+ 行")
        b_add.setToolTip(f"新增一条{what}")
        b_add.clicked.connect(lambda: self._add_table_row(table))
        b_del = QPushButton("删除行")
        b_del.setToolTip(f"删除选中的{what}")
        b_del.clicked.connect(lambda: self._delete_table_row(table, what))
        row.addWidget(b_add)
        row.addWidget(b_del)
        row.addStretch(1)
        return row

    # -------------------------------------------------------------- 模型读入
    @property
    def _data(self) -> dict:
        d = getattr(self._model, "footstep_sets", None)
        if not isinstance(d, dict):
            d = {}
            try:
                self._model.footstep_sets = d
            except Exception:
                pass
        return d

    def _sets(self) -> dict:
        s = self._data.get("sets")
        return s if isinstance(s, dict) else {}

    def _reload_from_model(self) -> None:
        self._refresh_set_list()
        self._load_globals()
        if self._set_list.count() > 0:
            self._set_list.setCurrentRow(0)
        else:
            self._clear_set_form()

    def _refresh_set_list(self) -> None:
        self._set_list.blockSignals(True)
        self._set_list.clear()
        for sid, s in self._sets().items():
            self._set_list.addItem(self._set_row_text(str(sid), s))
        self._set_list.blockSignals(False)

    @staticmethod
    def _set_row_text(sid: str, s: object) -> str:
        label = ""
        n_clips = 0
        unset = 0
        if isinstance(s, dict):
            label = str(s.get("label") or "")
            sfx = s.get("sfx")
            if isinstance(sfx, dict):
                n_clips = len(sfx)
                unset = sum(1 for v in sfx.values() if not (isinstance(v, str) and v.strip()))
        head = f"{sid}  [{label[:18]}]" if label else sid
        tail = f"  {n_clips} 片段"
        if unset:
            tail += f"  ⚠{unset} 条没选音效"
        return head + tail

    def _load_globals(self) -> None:
        data = self._data
        self._load_table(self._fb_table, data.get("clipFallback"))
        defaults = data.get("defaults") if isinstance(data.get("defaults"), dict) else {}
        for key, row in self._default_rows.items():
            row.load(defaults.get(key))
        spatial = data.get("spatial") if isinstance(data.get("spatial"), dict) else {}
        for key, row in self._spatial_rows.items():
            row.load(spatial.get(key))
        self._sync_spatial_warning()
        self._load_listener(data.get("listener"))

    def _load_table(self, table: QTableWidget, src: object) -> None:
        table.blockSignals(True)
        table.setRowCount(0)
        if isinstance(src, dict):
            for k, v in src.items():
                r = table.rowCount()
                table.insertRow(r)
                table.setItem(r, 0, QTableWidgetItem(str(k)))
                table.setItem(r, 1, QTableWidgetItem("" if v is None else str(v)))
        table.blockSignals(False)

    def _load_listener(self, src: object) -> None:
        listener = src if isinstance(src, dict) else {}
        self._listener_enabled.setChecked(isinstance(src, dict))
        self._listener_mode_missing = "mode" not in listener
        mode = str(listener.get("mode") or "camera")
        idx = self._listener_mode.findData(mode)
        if idx < 0:  # 未知 mode 保值展示，不静默顶替成 camera
            self._listener_mode.addItem(f"{mode}  [未知模式]", mode)
            idx = self._listener_mode.count() - 1
        self._listener_mode.setCurrentIndex(idx)
        self._reload_npc_items()
        self._listener_target.set_current(str(listener.get("targetId") or ""))
        for key, row in self._listener_rows.items():
            row.load(listener.get(key))
        self._sync_listener_enabled()

    def _reload_npc_items(self) -> None:
        cur = self._listener_target.current_id()
        self._listener_target.set_items(list(self._model.all_npc_ids_global()))
        self._listener_target.set_current(cur)

    def _reload_sfx_items(self) -> None:
        cur = self._sfx_selector.current_id()
        self._sfx_selector.set_items([(a, a) for a in self._model.all_audio_ids("sfx")])
        self._sfx_selector.set_current(cur)

    # -------------------------------------------------------------- 集的选择
    def _on_select_set(self, row: int) -> None:
        sids = list(self._sets().keys())
        if row < 0 or row >= len(sids):
            self._current_set = ""
            return
        # commit-on-leave：切到别的集之前提交上一集未应用的编辑，避免静默丢弃。
        if self._current_set and str(sids[row]) != self._current_set and self._is_dirty():
            if not self._apply():
                # 提交被非法输入挡住：选中回退到原来那一项，不让高亮与表单错位。
                back = sids.index(self._current_set) if self._current_set in sids else -1
                self._set_list.blockSignals(True)
                self._set_list.setCurrentRow(back)
                self._set_list.blockSignals(False)
                return
        self._current_set = str(sids[row])
        self._load_set_form(self._sets().get(self._current_set))

    def _load_set_form(self, s: object) -> None:
        data = s if isinstance(s, dict) else {}
        self._set_form_host.setEnabled(True)
        self._f_label.setText(str(data.get("label") or ""))
        for key, row in self._set_num_rows.items():
            row.load(data.get(key))
        sfx = data.get("sfx")
        self._sfx = {}
        if isinstance(sfx, dict):
            for k, v in sfx.items():
                # 值按身份保留：本页不认识的形状（数组 / 数字）**原样透传**，
                # 绝不静默重写成 "" 或把数字 5 改写成 "5"（那会在 Save All 里无声毁数据）。
                self._sfx[str(k)] = v
        # 换集时片段选中从头来：否则上一集也叫 walk 时 _refresh_clip_list 会原位保住同名行、
        # currentRowChanged 不触发，右侧选择器就还挂着上一集的 key（截图里抓到过）。
        self._current_clip = ""
        self._refresh_clip_list()
        if self._clip_list.count() > 0:
            self._clip_list.setCurrentRow(0)
        self._on_select_clip(self._clip_list.currentRow())

    def _clear_set_form(self) -> None:
        """无选中集时清空右侧表单并禁用（消除「删完还留着幽灵表单」）。"""
        self._current_set = ""
        self._current_clip = ""
        self._sfx = {}
        self._f_label.clear()
        for row in self._set_num_rows.values():
            row.load(None)
        self._refresh_clip_list()
        self._sync_sfx_side()
        self._set_form_host.setEnabled(False)

    # ------------------------------------------------------------ 片段 → 音效
    def _refresh_clip_list(self) -> None:
        keep = self._current_clip
        self._clip_list.blockSignals(True)
        self._clip_list.clear()
        for clip, aid in self._sfx.items():
            it = QListWidgetItem(self._clip_row_text(clip, aid))
            it.setData(Qt.ItemDataRole.UserRole, clip)
            it.setToolTip(self._clip_tooltip(aid))
            self._clip_list.addItem(it)
        self._clip_list.blockSignals(False)
        if keep:
            for i in range(self._clip_list.count()):
                if str(self._clip_list.item(i).data(Qt.ItemDataRole.UserRole)) == keep:
                    self._clip_list.blockSignals(True)
                    self._clip_list.setCurrentRow(i)
                    self._clip_list.blockSignals(False)
                    break

    @staticmethod
    def _clip_row_text(clip: str, aid: object) -> str:
        if not isinstance(aid, str):
            return f"⚠ {clip}   数据不是字符串（本页只透传、不改它）"
        if not aid.strip():
            return f"⚠ {clip}   没选音效（走这个片段时不响）"
        return f"{clip}   →  {aid.strip()}"

    def _clip_tooltip(self, aid: object) -> str:
        if not isinstance(aid, str) or not aid.strip():
            return ""
        path = audio_config_file_for_id(self._model, "sfx", aid.strip())
        if path is None:
            return f"{aid}\n⚠ 没登记在 audio_config.json 的 sfx 区或找不到文件——运行时这一条是静音的"
        return f"{aid}\n{path.name}\n时长 {format_duration(self._audio_meta.duration(path))}"

    def _current_value(self) -> object:
        """当前片段条目的值：正常是 str；非 str = 本页不动的异形数据。"""
        if not self._current_clip:
            return None
        return self._sfx.get(self._current_clip)

    def _on_select_clip(self, row: int) -> None:
        it = self._clip_list.item(row) if row >= 0 else None
        self._current_clip = str(it.data(Qt.ItemDataRole.UserRole)) if it is not None else ""
        self._sync_sfx_side()

    def _sync_sfx_side(self) -> None:
        """右侧：把当前片段的 key 灌进选择器（程序性设值，不触发 value_changed）。"""
        self._reload_sfx_items()
        value = self._current_value()
        editable = isinstance(value, str)
        self._clip_name_label.setText(self._current_clip or "（左边选一个片段）")
        self._sfx_selector.setEnabled(bool(self._current_clip) and editable)
        self._sfx_selector.set_current(value.strip() if isinstance(value, str) else "")
        self._sync_sfx_hint()

    def _sync_sfx_hint(self) -> None:
        if not self._current_clip:
            self._sfx_hint.setText("左边选一个片段，再给它挑一条音效 key。"
                                   "key 在「Audio」页登记（audio_config.json sfx 区）。")
            self._sfx_hint.setStyleSheet("color: #888;")
            return
        value = self._current_value()
        if not isinstance(value, str):
            self._sfx_hint.setText(
                f"⚠「{self._current_clip}」在数据里不是字符串（{type(value).__name__}）。"
                "本页只把它原样透传，不在这里改——请直接改 JSON 或删掉这一条重建。",
            )
            self._sfx_hint.setStyleSheet("color: #e8590c;")
            return
        aid = value.strip()
        if not aid:
            self._sfx_hint.setText(
                f"⚠「{self._current_clip}」还没选音效——走这个片段时**不响**"
                "（除非 clipFallback 把它回落到别的片段）。",
            )
            self._sfx_hint.setStyleSheet("color: #e8590c;")
            return
        path = audio_config_file_for_id(self._model, "sfx", aid)
        if path is None:
            self._sfx_hint.setText(
                f"⚠「{aid}」没登记在 audio_config.json 的 sfx 区（或找不到文件）——"
                "运行时 playSfx 对未知 key 直接 return，完全静默。先去 Audio 页登记。",
            )
            self._sfx_hint.setStyleSheet("color: #e8590c;")
            return
        self._sfx_hint.setText(
            f"「{self._current_clip}」→ {aid}（{path.name}，"
            f"{format_duration(self._audio_meta.duration(path))}）。每一步都是这一条，确定性播放。",
        )
        self._sfx_hint.setStyleSheet("color: #888;")

    def _on_sfx_changed(self, aid: str) -> None:
        if not self._current_clip or not isinstance(self._current_value(), str):
            return
        self._sfx[self._current_clip] = (aid or "").strip()
        self._refresh_clip_row(self._current_clip)
        self._sync_sfx_hint()

    def _refresh_clip_row(self, clip: str) -> None:
        for i in range(self._clip_list.count()):
            it = self._clip_list.item(i)
            if it is not None and str(it.data(Qt.ItemDataRole.UserRole)) == clip:
                aid = self._sfx.get(clip)
                it.setText(self._clip_row_text(clip, aid))
                it.setToolTip(self._clip_tooltip(aid))
                return

    def _add_clip(self) -> None:
        if not self._current_set:
            QMessageBox.information(self, "片段条目", "先选（或新建）一个脚步集。")
            return
        name, ok = QInputDialog.getText(
            self, "新增片段条目",
            "动画片段名（SpriteEntity.getCurrentState() 返回的那个，如 walk / run / carry_walk）：",
        )
        name = (name or "").strip()
        if not ok or not name:
            return
        if name in self._sfx:
            QMessageBox.information(self, "片段条目", f"「{name}」已经有了。")
            return
        self._sfx[name] = ""
        self._current_clip = name
        self._refresh_clip_list()
        self._sync_sfx_side()

    def _rename_clip(self) -> None:
        if not self._current_clip:
            return
        old = self._current_clip
        name, ok = QInputDialog.getText(self, "改片段名", "新的动画片段名：", text=old)
        name = (name or "").strip()
        if not ok or not name or name == old:
            return
        if name in self._sfx:
            QMessageBox.information(self, "片段条目", f"「{name}」已经有了。")
            return
        # 保原键序改名（不把这一条挪到最后）
        self._sfx = {(name if k == old else k): v for k, v in self._sfx.items()}
        self._current_clip = name
        self._refresh_clip_list()
        self._sync_sfx_side()

    def _delete_clip(self) -> None:
        if not self._current_clip:
            return
        clip = self._current_clip
        if not confirm.confirm_delete(self, f"片段条目「{clip}」",
                                      "这一集走这个片段时按 clipFallback 回落，回落不到就不响"):
            return
        self._sfx.pop(clip, None)
        self._current_clip = ""
        self._refresh_clip_list()
        if self._clip_list.count() > 0:
            self._clip_list.setCurrentRow(0)
        else:
            self._sync_sfx_side()

    # ------------------------------------------------------------ 表格增删
    def _add_table_row(self, table: QTableWidget) -> None:
        table.blockSignals(True)
        r = table.rowCount()
        table.insertRow(r)
        table.setItem(r, 0, QTableWidgetItem(""))
        table.setItem(r, 1, QTableWidgetItem(""))
        table.blockSignals(False)
        table.setCurrentCell(r, 0)

    def _delete_table_row(self, table: QTableWidget, what: str) -> None:
        r = table.currentRow()
        if r < 0:
            return
        key = self._cell_text(table, r, 0)
        if not confirm.confirm_delete(self, f"{what}「{key or '(空行)'}」"):
            return
        table.blockSignals(True)
        table.removeRow(r)
        table.blockSignals(False)

    @staticmethod
    def _cell_text(table: QTableWidget, row: int, col: int) -> str:
        it = table.item(row, col)
        return (it.text() or "").strip() if it is not None else ""

    def _collect_clip_fallback(self) -> tuple[dict[str, str], list[str]]:
        table = self._fb_table
        out: dict[str, str] = {}
        errs: list[str] = []
        for r in range(table.rowCount()):
            src = self._cell_text(table, r, 0)
            dst = self._cell_text(table, r, 1)
            if not src and not dst:
                continue
            if not src or not dst:
                errs.append(f"第 {r + 1} 行：片段名与回落目标必须都填")
                continue
            if src in out:
                errs.append(f"第 {r + 1} 行「{src}」：片段名重复")
                continue
            out[src] = dst
        return out, errs

    # ------------------------------------------------------------ 显隐联动
    def _sync_spatial_warning(self) -> None:
        far = self._spatial_rows["maxDistanceWu"]
        back = self._spatial_rows["listenerBackAtBaseZoomWu"]
        if far.check.isChecked() and back.check.isChecked() \
                and far.spin.value() <= back.spin.value() * 1.5:
            self._spatial_warn.setText(
                "⚠ maxDistanceWu 必须**显著大于** listenerBackAtBaseZoomWu"
                f"（现在 {far.spin.value():g} vs {back.spin.value():g}）——"
                "否则相机听者离画面本来就有这么远，连脚下的声音都会被判成听不见。",
            )
            self._spatial_warn.setVisible(True)
        else:
            self._spatial_warn.setVisible(False)

    def _sync_listener_enabled(self) -> None:
        on = self._listener_enabled.isChecked()
        self._listener_mode.setEnabled(on)
        self._sync_listener_mode()

    def _sync_listener_mode(self) -> None:
        on = self._listener_enabled.isChecked()
        mode = str(self._listener_mode.currentData() or "camera")
        want_target = on and mode == "npc"
        self._listener_target.setVisible(want_target)
        self._listener_target_label.setVisible(want_target)
        for key in ("x", "y"):
            vis = on and mode == "fixed"
            self._listener_rows[key].setVisible(vis)
            self._listener_labels[key].setVisible(vis)
        vis_h = on and mode in ("player", "npc", "fixed")
        self._listener_rows["heightWu"].setVisible(vis_h)
        self._listener_labels["heightWu"].setVisible(vis_h)

    # ------------------------------------------------------------ 写回模型
    def _write_all_into(self, data: dict) -> None:
        """把当前 UI 写进 data（就地；不 mark_dirty）。_apply 与脏判断共用同一条路径。"""
        if self._current_set:
            sets = data.get("sets")
            if not isinstance(sets, dict):
                sets = {}
                data["sets"] = sets
            s = sets.get(self._current_set)
            if not isinstance(s, dict):
                s = {}
                sets[self._current_set] = s
            self._write_set_into(s)
        self._write_globals_into(data)

    def _write_set_into(self, s: dict) -> None:
        label = self._f_label.text().strip()
        if label:
            s["label"] = label
        else:
            s.pop("label", None)
        for key, row in self._set_num_rows.items():
            v = row.value_or_none()
            if v is None:
                s.pop(key, None)
            else:
                s[key] = v
        sfx = {k: v for k, v in self._sfx.items() if k}
        _put_map(s, "sfx", sfx)

    def _write_globals_into(self, data: dict) -> None:
        fallback, _fb_errs = self._collect_clip_fallback()
        _put_map(data, "clipFallback", fallback)

        orig_defaults = data.get("defaults")
        defaults = dict(orig_defaults) if isinstance(orig_defaults, dict) else {}
        for key, row in self._default_rows.items():
            v = row.value_or_none()
            if v is None:
                defaults.pop(key, None)
            else:
                defaults[key] = v
        _put_map(data, "defaults", defaults)

        orig_spatial = data.get("spatial")
        spatial = dict(orig_spatial) if isinstance(orig_spatial, dict) else {}
        for key, row in self._spatial_rows.items():
            v = row.value_or_none()
            if v is None:
                spatial.pop(key, None)
            else:
                spatial[key] = v
        _put_map(data, "spatial", spatial)

        self._write_listener_into(data)

    def _write_listener_into(self, data: dict) -> None:
        if not self._listener_enabled.isChecked():
            data.pop("listener", None)
            return
        orig = data.get("listener")
        listener = dict(orig) if isinstance(orig, dict) else {}
        mode = str(self._listener_mode.currentData() or "camera")
        if self._listener_mode_missing and mode == "camera":
            # 原本就没有 mode 键、显示的只是缺省值 —— 不无中生有（往返契约）。
            listener.pop("mode", None)
        else:
            listener["mode"] = mode
        # 与当前 mode 无关的键**不删**：作者切来切去时不静默丢数据，运行时本来就不读。
        if mode == "npc":
            tid = self._listener_target.current_id().strip()
            if tid:
                listener["targetId"] = tid
            else:
                listener.pop("targetId", None)
        managed = {"fixed": ("x", "y", "heightWu"), "player": ("heightWu",),
                   "npc": ("heightWu",)}.get(mode, ())
        for key in managed:
            v = self._listener_rows[key].value_or_none()
            if v is None:
                listener.pop(key, None)
            else:
                listener[key] = v
        data["listener"] = listener

    # ------------------------------------------------------------ 脏 / 提交
    def _is_dirty(self) -> bool:
        test = copy.deepcopy(self._data)
        self._write_all_into(test)
        if test != self._data:
            return True
        # 表里躺着改坏了的行也算「有未提交的编辑」——否则关页时它会无声消失。
        _c, fb_errs = self._collect_clip_fallback()
        return bool(fb_errs)

    def _apply(self) -> bool:
        errs = self._collect_clip_fallback()[1]
        if errs:
            QMessageBox.warning(
                self, "脚步集未保存",
                "下面这些行是非法的，本页拒绝把它们写进数据（改对或删掉那几行再 Apply）：\n\n· "
                + "\n· ".join(errs),
            )
            return False
        self._write_all_into(self._data)
        self._model.mark_dirty(DIRTY_BUCKET)
        if self._current_set:
            row = self._set_list.currentRow()
            item = self._set_list.item(row) if row >= 0 else None
            if item is not None:
                item.setText(self._set_row_text(
                    self._current_set, self._sets().get(self._current_set),
                ))
        return True

    def flush_to_model(self) -> bool:
        """Save All 钩子：未应用编辑在保存前提交。非法输入时返回 False（主窗如实报跳过）。"""
        if not self._is_dirty():
            return True
        return self._apply()

    def confirm_close(self, parent: QWidget | None = None) -> bool:
        if not self._is_dirty():
            return True
        r = QMessageBox.question(
            self, "未应用的修改", "脚步集页有未应用的修改。保存到模型？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            return self._apply()
        # Discard：把表单回滚到模型当前值，否则关闭路径随后的统一 flush 会按
        # UI≠模型判脏，把刚被放弃的编辑重新提交。
        self._reload_from_model()
        return True

    # ------------------------------------------------------------ 列表增删
    def _commit_pending(self) -> bool:
        """动列表结构之前先把未应用的编辑落模型（非法输入时返回 False，调用方中止）。"""
        if not self._is_dirty():
            return True
        return self._apply()

    def _add_set(self) -> None:
        if not self._commit_pending():
            return
        taken = set(self._sets().keys())
        n = 0
        while f"footstep_{n}" in taken:
            n += 1
        sid, ok = QInputDialog.getText(self, "新增脚步集", "脚步集 id：", text=f"footstep_{n}")
        sid = (sid or "").strip()
        if not ok or not sid:
            return
        if sid in taken:
            QMessageBox.information(self, "脚步集", f"「{sid}」已经有了。")
            return
        data = self._data
        sets = data.get("sets")
        if not isinstance(sets, dict):
            sets = {}
            data["sets"] = sets
        sets[sid] = {"sfx": {}}
        self._model.mark_dirty(DIRTY_BUCKET)
        self._refresh_set_list()
        self._set_list.setCurrentRow(self._set_list.count() - 1)

    def _rename_set(self) -> None:
        if not self._current_set:
            return
        old = self._current_set
        sid, ok = QInputDialog.getText(self, "重命名脚步集", "新的脚步集 id：", text=old)
        sid = (sid or "").strip()
        if not ok or not sid or sid == old:
            return
        sets = self._sets()
        if sid in sets:
            QMessageBox.information(self, "脚步集", f"「{sid}」已经有了。")
            return
        if not self._commit_pending():  # 先把当前编辑落到旧 id 上，再整体改名
            return
        sets = self._sets()
        self._data["sets"] = {(sid if k == old else k): v for k, v in sets.items()}
        self._model.mark_dirty(DIRTY_BUCKET)
        QMessageBox.information(
            self, "脚步集已改名",
            f"「{old}」→「{sid}」。\n"
            "引用它的 scene.footstepSet / zone.footstepSet **不会**自动改，"
            "请跑一次数据校验确认没有悬垂引用。",
        )
        self._current_set = ""
        self._refresh_set_list()
        for i, k in enumerate(self._sets().keys()):
            if k == sid:
                self._set_list.setCurrentRow(i)
                break

    def _delete_set(self) -> None:
        if not self._current_set:
            return
        sid = self._current_set
        if not confirm.confirm_delete(
            self, f"脚步集「{sid}」",
            "引用它的 scene.footstepSet / zone.footstepSet 会变成悬垂引用",
        ):
            return
        idx = self._set_list.currentRow()
        self._sets().pop(sid, None)
        self._current_set = ""
        self._model.mark_dirty(DIRTY_BUCKET)
        self._refresh_set_list()
        if self._set_list.count() > 0:
            self._set_list.setCurrentRow(min(idx, self._set_list.count() - 1))
        else:
            self._clear_set_form()

    # ------------------------------------------------------------ 主窗钩子
    def reload_refs_from_model(self) -> None:
        """切页激活时重拉候选（NPC 在别处新增 / 音频目录变了），**不动已编辑的值**。"""
        self._reload_npc_items()
        self._reload_sfx_items()
        self._refresh_clip_list()
        self._sync_sfx_hint()

    def select_by_id(self, item_id: str, _scene_id: str = "") -> bool:
        """全局搜索/跳转落点：按脚步集 id 选中。"""
        for i, sid in enumerate(self._sets().keys()):
            if str(sid) == item_id:
                self._tabs.setCurrentIndex(0)
                self._set_list.setCurrentRow(i)
                return True
        return False
