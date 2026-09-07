"""动画包面板：states（帧序/帧率/循环/增删）与世界尺寸可编辑并格式保真写回 anim.json；图集字段只读，重打图集用 video_to_atlas。"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path, PurePosixPath

from PySide6.QtCore import QProcess
from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QSpinBox, QDoubleSpinBox, QPushButton, QLabel, QComboBox,
    QTableWidget, QTableWidgetItem, QHeaderView, QScrollArea,
    QAbstractItemView,
    QCheckBox,
    QSizePolicy,
    QMessageBox,
)


def _make_list_search_box(list_widget: QListWidget) -> QLineEdit:
    """动画包列表上方的纯视图搜索框：按文本逐项 setHidden，不增删/不重排数据。"""
    box = QLineEdit()
    box.setPlaceholderText("搜索…")
    box.setClearButtonEnabled(True)
    box.setToolTip("按包 ID 过滤下方动画包列表（仅隐藏不匹配项）。")

    def _filter(text: str) -> None:
        q = text.strip().lower()
        for i in range(list_widget.count()):
            it = list_widget.item(i)
            if it is None:
                continue
            it.setHidden(bool(q) and q not in it.text().lower())

    box.textChanged.connect(_filter)
    return box
from PySide6.QtGui import QColor, QImage, QPainter, QPen, QPixmap
from PySide6.QtCore import Qt, QRect, QElapsedTimer, QTimer

from ..shared.collapsible_section import CollapsibleSection
from ..shared.socket_panel import SocketPanel

# 与游戏 tick、FrameSequencePlayer 一致：累加 dt，每 1/frameRate 秒换帧；限制 dt 避免卡死后一次跳多格
_PREVIEW_MAX_DT_SEC = 0.1


def _preview_poll_interval_ms(fps: float) -> int:
    fps = max(1e-6, float(fps))
    ideal = 1000.0 / fps / 3.0
    return max(4, min(16, int(round(ideal))))

from ..project_model import ProjectModel
from ..shared.anim_atlas_preview import (
    HEAD_GAP as BUBBLE_HEAD_GAP,
    anim_manifest_url_for_bundle,
)
from ..shared.bubble_anchor_field import BubbleAnchorActor, BubbleAnchorPickField
from ..shared.form_layout import compact_form


class _WalkCalibStrip(QWidget):
    """步速匹配调校走廊：精灵按「移动速度」左右往返，帧率按 clamp(速度/refSpeed, 0.5~2)
    缩放——与运行时 SpriteEntity.applyLocomotionSpeed 同口径。地面刻度与精灵共用同一套
    world→px 映射，脚底相对刻度的滑动肉眼可判（向前飘=动画偏慢，原地小碎步=动画偏快）。
    refSpeed ≤0 = 不匹配恒原速。步进由外部计时器驱动（tick），可见性由调用方把关。
    """

    _TICK_WORLD = 50.0     # 地面刻度间隔（世界单位）
    _SPRITE_DISP_H = 110   # 精灵显示高度（px）；world→px 比例由此与 worldHeight 推出
    _MARGIN_PX = 12

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setFixedHeight(150)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self._frames: list[int] = []
        self._rate = 8.0
        self._ref: float | None = None
        self._speed = 60.0
        self._world_w = 100.0
        self._world_h = 150.0
        self._crop_fn = None
        self._cache: dict[int, QPixmap] = {}
        self._pos_w = 0.0
        self._dir = 1
        self._seq = 0
        self._accum = 0.0

    def set_clip(self, frames, rate, world_w, world_h, crop_fn) -> None:
        """换片段：帧序/帧率/世界尺寸/裁帧函数；重置游标与位置，清帧缓存。"""
        self._frames = [int(x) for x in frames] if frames else []
        self._rate = max(1e-6, float(rate))
        self._world_w = max(1.0, float(world_w))
        self._world_h = max(1.0, float(world_h))
        self._crop_fn = crop_fn
        self._cache.clear()
        self._pos_w = 0.0
        self._dir = 1
        self._seq = 0
        self._accum = 0.0
        self.update()

    def set_speed(self, v: float) -> None:
        self._speed = max(0.0, float(v))
        self.update()

    def set_ref_speed(self, v: float | None) -> None:
        self._ref = float(v) if v and v > 0 else None
        self.update()

    def multiplier(self) -> tuple[float, bool]:
        """(播放倍率, 是否被夹取)；夹取区间同运行时 LOCOMOTION_RATE_MIN/MAX=0.5~2。"""
        if not self._ref or self._speed <= 0:
            return 1.0, False
        raw = self._speed / self._ref
        m = min(2.0, max(0.5, raw))
        return m, abs(m - raw) > 1e-9

    def _ppw(self) -> float:
        return self._SPRITE_DISP_H / self._world_h

    def tick(self, dt: float) -> None:
        if self._crop_fn is None or not self._frames or self._speed <= 0:
            return
        mult, _ = self.multiplier()
        if len(self._frames) > 1:
            self._accum += dt
            step = 1.0 / (self._rate * mult)
            while self._accum >= step:
                self._accum -= step
                self._seq = (self._seq + 1) % len(self._frames)
        ppw = self._ppw()
        span_w = max(1.0, (self.width() - 2 * self._MARGIN_PX) / ppw - self._world_w)
        self._pos_w += self._dir * self._speed * dt
        if self._pos_w >= span_w:
            self._pos_w = span_w
            self._dir = -1
        elif self._pos_w <= 0.0:
            self._pos_w = 0.0
            self._dir = 1
        self.update()

    def _pix(self, idx: int) -> QPixmap | None:
        pm = self._cache.get(idx)
        if pm is None and self._crop_fn is not None:
            got = self._crop_fn(idx)
            if got is not None and not got.isNull():
                pm = got
                self._cache[idx] = pm
        return pm

    def paintEvent(self, _ev) -> None:  # noqa: N802 — Qt 命名
        p = QPainter(self)
        try:
            p.fillRect(self.rect(), QColor("#1a1a1a"))
            ground_y = self.height() - 22
            ppw = self._ppw()
            p.setPen(QPen(QColor("#555")))
            p.drawLine(0, ground_y, self.width(), ground_y)
            tick_px = max(8.0, self._TICK_WORLD * ppw)
            x = float(self._MARGIN_PX)
            while x < self.width():
                p.drawLine(int(x), ground_y, int(x), ground_y + 6)
                x += tick_px
            if not self._frames or self._crop_fn is None:
                p.setPen(QColor("#777"))
                p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "（选中一行移动状态后在此来回走）")
                return
            pm = self._pix(self._frames[self._seq % len(self._frames)])
            if pm is None:
                return
            disp_w = max(1, int(round(self._world_w * ppw)))
            disp_h = max(1, int(round(self._world_h * ppw)))
            scaled = pm.scaled(
                disp_w, disp_h,
                Qt.AspectRatioMode.IgnoreAspectRatio,
                Qt.TransformationMode.FastTransformation,
            )
            foot_x = self._MARGIN_PX + self._pos_w * ppw + disp_w / 2.0
            top = ground_y - disp_h
            if self._dir < 0:
                p.save()
                p.translate(foot_x, 0)
                p.scale(-1.0, 1.0)
                p.drawPixmap(int(-disp_w / 2.0), int(top), scaled)
                p.restore()
            else:
                p.drawPixmap(int(foot_x - disp_w / 2.0), int(top), scaled)
        finally:
            p.end()

_ATLAS_VIEW_MAX_W = 580
_ATLAS_VIEW_MAX_H = 300
_ATLAS_VIEW_MIN_W = 240
_ATLAS_VIEW_RESERVE_RIGHT_COL = 280
_FRAME_PREV_MAX_W = 220
_FRAME_PREV_MAX_H = 200
_FRAME_PREV_PLACEHOLDER_W = 160
_FRAME_PREV_PLACEHOLDER_H = 120


def _effective_cell_stride(
    cols: int,
    rows: int,
    pm: QPixmap | None,
    cell_w_override: int,
    cell_h_override: int,
) -> tuple[int, int]:
    c = max(1, cols)
    r = max(1, rows)
    if pm is None or pm.isNull():
        return max(1, cell_w_override or 32), max(1, cell_h_override or 32)
    pw, ph = pm.width(), pm.height()
    sw = cell_w_override if cell_w_override > 0 else max(1, pw // c)
    sh = cell_h_override if cell_h_override > 0 else max(1, ph // r)
    return sw, sh


def _spritesheet_disk(project_path: Path, anim_manifest_url: str, spritesheet: str) -> Path | None:
    pub = project_path / "public"
    sh = str(spritesheet or "").strip()
    if not sh:
        return None
    if sh.startswith("/assets/"):
        return pub / sh.lstrip("/")
    base = PurePosixPath(anim_manifest_url.strip().lstrip("/")).parent
    part = sh[2:] if sh.startswith("./") else sh
    return pub / (base / PurePosixPath(part))


class AnimEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_key: str | None = None
        # 编辑态：_loading 期间忽略控件变更信号；_dirty 表示有未保存改动；
        # _original_anim 为当前包载入时的完整 anim.json 深拷贝（保存时在其上施加差异，
        # 从而原样保留 spritesheet/cols/rows/单格像素/atlasFrames 及任何未知键如 notes）。
        self._loading: bool = False
        self._dirty: bool = False
        self._original_anim: dict | None = None
        # 世界尺寸往返保真（preserve_numeric_repr 惯例）：QSpinBox 会把磁盘上的
        # 84.266667 截成 84，保存时若控件仍等于载入种子（未编辑），按原字面值写回。
        self._world_orig: dict[str, int | float] = {}
        self._world_seed: dict[str, int] = {}

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        hint = QLabel("动画包：图集由 video_to_atlas 导出")
        hint.setToolTip(
            "动画包目录：public/resources/runtime/animation/<id>/\n"
            "（anim.json + 图集；图集由 video_to_atlas 导出）\n"
            "本面板可直接改 states（帧序/帧率/循环/增删）与世界尺寸并写回 anim.json，\n"
            "无需重新打图集；图集相关字段（spritesheet/cols/rows/单格像素/atlasFrames）只读。"
        )
        hint.setStyleSheet("color: #888;")
        ll.addWidget(hint)
        row_tools = QHBoxLayout()
        btn_vta = QPushButton("视频工具…")
        btn_vta.setToolTip(
            "启动 tools/video_to_atlas，独立窗口；若存在 resources/editor_projects/editor_data/animation/project.json 将自动打开该工作区。"
        )
        btn_vta.clicked.connect(self._open_video_atlas_detached)
        row_tools.addWidget(btn_vta)
        btn_reload = QPushButton("重载动画")
        btn_reload.setToolTip(
            "重新扫描 public/resources/runtime/animation/*/anim.json 并更新内存；在视频工具导出后点此同步主编辑器。"
        )
        btn_reload.clicked.connect(self._reload_all_animations_from_disk)
        row_tools.addWidget(btn_reload)
        row_tools.addStretch()
        ll.addLayout(row_tools)
        self._list = QListWidget()
        self._search_box = _make_list_search_box(self._list)
        ll.addWidget(self._search_box)
        self._list.currentTextChanged.connect(self._on_list_selection_changed)
        ll.addWidget(self._list)
        self._empty_hint = QLabel("暂无动画包：用「视频工具…」导出，再点「重载动画」")
        self._empty_hint.setStyleSheet("color: #888;")
        self._empty_hint.setWordWrap(True)
        ll.addWidget(self._empty_hint)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        detail = QWidget()
        self._anim_detail_panel = detail
        dl = QVBoxLayout(detail)
        self._lbl_disk = QLabel("")
        self._lbl_disk.setWordWrap(True)
        self._lbl_disk.setStyleSheet("color: #6af;")
        dl.addWidget(self._lbl_disk)
        f = compact_form(QFormLayout())
        self._a_stem = QLineEdit()
        self._a_stem.setReadOnly(True)
        f.addRow("包 ID（目录名）", self._a_stem)

        self._a_sheet = QLineEdit()
        self._a_sheet.setReadOnly(True)
        f.addRow("spritesheet（manifest 内）", self._a_sheet)

        self._a_cols = QSpinBox()
        self._a_cols.setRange(1, 99)
        self._a_cols.setReadOnly(True)
        self._a_cols.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
        f.addRow("cols", self._a_cols)
        self._a_rows = QSpinBox()
        self._a_rows.setRange(1, 99)
        self._a_rows.setReadOnly(True)
        self._a_rows.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
        f.addRow("rows", self._a_rows)
        self._a_cell_w = QSpinBox()
        self._a_cell_w.setRange(0, 4096)
        self._a_cell_w.setReadOnly(True)
        self._a_cell_w.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
        f.addRow("cellWidth px（0=自动）", self._a_cell_w)
        self._a_cell_h = QSpinBox()
        self._a_cell_h.setRange(0, 4096)
        self._a_cell_h.setReadOnly(True)
        self._a_cell_h.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
        f.addRow("cellHeight px（0=自动）", self._a_cell_h)
        self._a_world_mode = QComboBox()
        self._a_world_mode.addItem("按宽度（只写 worldWidth）", 0)
        self._a_world_mode.addItem("按高度（只写 worldHeight）", 1)
        self._a_world_mode.addItem("同时写宽高（高级）", 2)
        self._a_world_mode.setToolTip(
            "运行时按单格像素长宽比由其一推出另一维；两者都写则直接采用（高级）。\n"
            "只改世界尺寸不影响图集，保存即写回 anim.json。"
        )
        self._a_world_mode.currentIndexChanged.connect(self._on_world_mode_changed)
        self._a_world_mode.setSizePolicy(
            QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        self._a_world_mode.setMaximumWidth(220)
        f.addRow("世界尺寸", self._a_world_mode)
        self._a_ww = QSpinBox()
        self._a_ww.setRange(1, 9999)
        self._a_ww.valueChanged.connect(self._on_field_edited)
        f.addRow("worldWidth", self._a_ww)
        self._a_wh = QSpinBox()
        self._a_wh.setRange(1, 9999)
        self._a_wh.valueChanged.connect(self._on_field_edited)
        f.addRow("worldHeight", self._a_wh)
        # 法线烘焙（per-animation；写入 anim.json 的 normalBake，供 bake-normals 读取）
        self._a_bake_enable = QCheckBox("烘焙法线（关闭=运行时用平面法线）")
        self._a_bake_enable.setToolTip(
            "是否为本动画烘焙鼓包法线图（<图集>.normal.png）。关闭并重烘会删掉法线图，"
            "运行时该角色回退到垂直平面法线（不参与逐像素明暗）。"
        )
        self._a_bake_enable.stateChanged.connect(self._on_field_edited)
        f.addRow("法线烘焙", self._a_bake_enable)
        self._a_bake_downscale = QSpinBox()
        self._a_bake_downscale.setRange(1, 32)
        self._a_bake_downscale.setValue(4)
        self._a_bake_downscale.setMaximumWidth(90)
        self._a_bake_downscale.setToolTip(
            "法线图边长 = 源图的 1/N。越大越省体积但越糊、太小(如 16)会导致动画帧间闪烁；"
            "4 是实测不闪的推荐值，更省可试 8。1=源分辨率。"
        )
        self._a_bake_downscale.valueChanged.connect(self._on_field_edited)
        f.addRow("法线分辨率 1/N", self._a_bake_downscale)
        dl.addLayout(f)

        # 保存/放弃改动（仅写 anim.json 的 states 与世界尺寸；图集不动）
        socket_sec = CollapsibleSection("挂点 / 落脚帧（逐帧标注 · 写 sockets.json）", start_open=False)
        socket_sec.set_header_tool_tip(
            "给这个动画包逐帧标两样东西：\n"
            "· 挂点（右手/头顶/腰…）——运行时可以往上挂任意东西；\n"
            "· 落脚帧——脚触地的那几格，运行时走到这一格就播一声脚步"
            "（声音本身在「脚步集」页配，这里只管哪一帧响）。\n"
            "数据写同目录的 sockets.json sidecar，**不进 anim.json**——重导出图集不会带走它，\n"
            "但槽位会漂移：指纹对不上时游戏整份忽略并在此提示重标。")
        self._socket_panel = SocketPanel(self._model)
        self._socket_panel.dirtyChanged.connect(self._on_socket_dirty)
        socket_sec.add_body(self._socket_panel)
        dl.addWidget(socket_sec)

        save_row = QHBoxLayout()
        self._btn_save = QPushButton("保存改动到 anim.json")
        self._btn_save.setToolTip(
            "把 states（帧序/帧率/循环/增删）与世界尺寸写回 "
            "public/resources/runtime/animation/<id>/anim.json；不改图集 PNG。"
        )
        self._btn_save.clicked.connect(self._do_save)
        save_row.addWidget(self._btn_save)
        self._btn_discard = QPushButton("放弃改动")
        self._btn_discard.setToolTip("丢弃未保存的改动，从磁盘当前 anim.json 重新载入。")
        self._btn_discard.clicked.connect(self._do_discard)
        save_row.addWidget(self._btn_discard)
        self._btn_rebake_normal = QPushButton("重烘本动画法线")
        self._btn_rebake_normal.setToolTip(
            "按当前「法线烘焙」配置重烘本动画的 <图集>.normal.png（先自动存盘 anim.json）。"
            "关闭烘焙则删除法线图。"
        )
        self._btn_rebake_normal.clicked.connect(self._do_rebake_normal)
        save_row.addWidget(self._btn_rebake_normal)
        self._lbl_dirty = QLabel("")
        self._lbl_dirty.setStyleSheet("color: #e0a030;")
        save_row.addWidget(self._lbl_dirty, 1)
        dl.addLayout(save_row)

        states_hdr = QLabel("<b>States（可编辑）</b>")
        states_hdr.setToolTip(
            "name=状态名（运行时引用，需唯一非空）；frames=图集线性槽位逗号列表（0 基，<cols×rows）；\n"
            "frameRate=每秒帧数（≥1）；loop=是否循环；refSpeed=步速匹配基准（世界单位/秒）——\n"
            "该循环在此移动速度下不滑步，配置后移动时按 实际速度/refSpeed 自动缩放播放倍率（夹取 0.5~2），\n"
            "留空=不参与匹配（恒 1 倍速，现状行为）。仅移动类状态（walk/run 等）需要填。\n"
            "改这些只写 anim.json，不重打图集。"
        )
        dl.addWidget(states_hdr)
        self._state_table = QTableWidget(0, 5)
        self._state_table.setHorizontalHeaderLabels(
            ["name", "frames", "frameRate", "loop", "refSpeed"])
        self._state_table.horizontalHeader().setSectionResizeMode(
            QHeaderView.ResizeMode.Stretch)
        self._state_table.verticalHeader().setDefaultSectionSize(32)
        self._state_table.setEditTriggers(
            QAbstractItemView.EditTrigger.DoubleClicked
            | QAbstractItemView.EditTrigger.SelectedClicked
            | QAbstractItemView.EditTrigger.EditKeyPressed)
        self._state_table.setSelectionBehavior(
            QAbstractItemView.SelectionBehavior.SelectRows)
        dl.addWidget(self._state_table)

        self._state_table.itemSelectionChanged.connect(self._on_state_selection_changed)
        self._state_table.itemChanged.connect(self._on_state_item_changed)

        st_tools = QHBoxLayout()
        btn_add_state = QPushButton("添加状态")
        btn_add_state.clicked.connect(self._add_state)
        st_tools.addWidget(btn_add_state)
        btn_del_state = QPushButton("删除所选状态")
        btn_del_state.clicked.connect(self._remove_selected_state)
        st_tools.addWidget(btn_del_state)
        btn_up_state = QPushButton("上移")
        btn_up_state.clicked.connect(lambda: self._move_selected_state(-1))
        st_tools.addWidget(btn_up_state)
        btn_dn_state = QPushButton("下移")
        btn_dn_state.clicked.connect(lambda: self._move_selected_state(1))
        st_tools.addWidget(btn_dn_state)
        st_tools.addStretch()
        dl.addLayout(st_tools)

        dl.addWidget(
            QLabel("<b>状态动画预览</b>（选中表格行即播该 state）")
        )
        pv_bar = QHBoxLayout()
        self._chk_preview_play = QCheckBox("播放")
        self._chk_preview_play.setChecked(True)
        self._chk_preview_play.toggled.connect(self._restart_preview_animation)
        pv_bar.addWidget(self._chk_preview_play)
        self._lbl_preview_info = QLabel("")
        self._lbl_preview_info.setStyleSheet("color: #aaa;")
        self._lbl_preview_info.setWordWrap(True)
        pv_bar.addWidget(self._lbl_preview_info, 1)
        dl.addLayout(pv_bar)

        calib_box = CollapsibleSection("步速匹配调校（来回走）", start_open=False)
        calib_box.set_header_tool_tip(
            "选中一行移动状态（walk/run…），精灵按「移动速度」在走廊里往返，帧率按\n"
            "clamp(速度÷refSpeed, 0.5~2) 实时缩放——与游戏运行时同口径。\n"
            "refSpeed 在此调节即写入表格该行（保存路径同表格编辑）。")
        calib_inner = QWidget()
        calib_l = QVBoxLayout(calib_inner)
        calib_bar = QHBoxLayout()
        calib_bar.addWidget(QLabel("移动速度"))
        self._calib_speed = QDoubleSpinBox()
        self._calib_speed.setRange(1.0, 500.0)
        self._calib_speed.setDecimals(0)
        self._calib_speed.setSingleStep(5.0)
        self._calib_speed.setValue(60.0)
        self._calib_speed.setMaximumWidth(80)
        self._calib_speed.setToolTip(
            "模拟的实际移动速度（世界单位/秒）。参考：NPC 巡逻默认 60、玩家走 100、跑 180。")
        self._calib_speed.valueChanged.connect(self._on_calib_speed_changed)
        calib_bar.addWidget(self._calib_speed)
        calib_bar.addWidget(QLabel("refSpeed"))
        self._calib_ref = QDoubleSpinBox()
        self._calib_ref.setRange(0.0, 500.0)
        self._calib_ref.setDecimals(1)
        self._calib_ref.setSingleStep(5.0)
        self._calib_ref.setSpecialValueText("（不匹配）")
        self._calib_ref.setMaximumWidth(96)
        self._calib_ref.setToolTip(
            "与表格选中行的 refSpeed 列双向同步：在此调节即改表格、走同一保存路径。\n"
            "0=留空不参与匹配。起点建议=上面的实际移速，再按滑步方向微调。")
        self._calib_ref.valueChanged.connect(self._on_calib_ref_changed)
        calib_bar.addWidget(self._calib_ref)
        self._lbl_calib_mult = QLabel("")
        self._lbl_calib_mult.setStyleSheet("color: #aaa;")
        calib_bar.addWidget(self._lbl_calib_mult, 1)
        calib_l.addLayout(calib_bar)
        self._calib_strip = _WalkCalibStrip()
        calib_l.addWidget(self._calib_strip)
        calib_hint = QLabel(
            "盯脚底与地面刻度的相对滑动：向前飘（溜冰）= 调小 refSpeed；原地小碎步 = 调大。")
        calib_hint.setStyleSheet("color: #888;")
        calib_hint.setWordWrap(True)
        calib_l.addWidget(calib_hint)
        calib_box.add_body(calib_inner)
        dl.addWidget(calib_box)
        self._calib_box = calib_box
        self._calib_timer = QTimer(self)
        self._calib_timer.setTimerType(Qt.TimerType.CoarseTimer)
        self._calib_timer.setInterval(16)
        self._calib_timer.timeout.connect(self._tick_calib)
        self._calib_elapsed = QElapsedTimer()
        self._calib_ref_syncing = False

        atlas_frame_row = QHBoxLayout()
        atlas_col = QVBoxLayout()
        atlas_col.addWidget(QLabel("<b>雪碧图 Atlas（完整原图）</b>"))
        self._lbl_atlas_meta = QLabel("")
        self._lbl_atlas_meta.setStyleSheet("color: #888;")
        self._lbl_atlas_meta.setWordWrap(True)
        atlas_col.addWidget(self._lbl_atlas_meta)
        self._atlas_full = QLabel()
        self._atlas_full.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._atlas_full.setSizePolicy(
            QSizePolicy.Policy.Maximum,
            QSizePolicy.Policy.Fixed,
        )
        self._atlas_full.setFixedSize(_ATLAS_VIEW_MIN_W, 120)
        self._atlas_full.setStyleSheet("background: #1a1a1a;")
        atlas_col.addWidget(self._atlas_full, 1)
        # 法线图预览：紧挨图集，直观看烘焙产物 <图集>.normal.png
        normal_col = QVBoxLayout()
        normal_col.addWidget(QLabel("<b>法线图 Normal（烘焙产物）</b>"))
        self._lbl_normal_meta = QLabel("")
        self._lbl_normal_meta.setStyleSheet("color: #888;")
        self._lbl_normal_meta.setWordWrap(True)
        normal_col.addWidget(self._lbl_normal_meta)
        self._normal_full = QLabel()
        self._normal_full.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._normal_full.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        self._normal_full.setFixedSize(_ATLAS_VIEW_MIN_W, 120)
        self._normal_full.setStyleSheet("background: #1a1a1a;")
        normal_col.addWidget(self._normal_full, 1)
        frame_col = QVBoxLayout()
        frame_col.addWidget(QLabel("<b>当前帧</b>"))
        self._preview = QLabel()
        self._preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._preview.setSizePolicy(
            QSizePolicy.Policy.Fixed,
            QSizePolicy.Policy.Fixed,
        )
        self._preview.setFixedSize(_FRAME_PREV_PLACEHOLDER_W, _FRAME_PREV_PLACEHOLDER_H)
        self._preview.setStyleSheet("background: #2a2a2a;")
        frame_col.addWidget(self._preview)
        frame_col.addStretch(1)
        atlas_frame_row.addLayout(atlas_col, 1)
        atlas_frame_row.addLayout(normal_col, 1)
        atlas_frame_row.addLayout(frame_col, 0)
        dl.addLayout(atlas_frame_row)

        # —— 本状态授权头顶锚（可选）：写 states[<所选状态>].bubbleAnchor。
        # 缺省不写键 = 运行时按每帧可见内容自动求；只有"内容顶≠头顶"的状态
        #（举枪、扛尸、打伞——自动锚会挂到道具尖上）才需要在这里钉死。
        self._bubble_field = BubbleAnchorPickField(
            self, self._model, None, self._bubble_actor_for_selected_state,
        )
        self._bubble_field.changed.connect(self._on_bubble_anchor_changed)
        self._bubble_sec = CollapsibleSection(
            "说话气泡头顶锚（所选状态，可选）", start_open=False, parent=self,
        )
        self._bubble_sec.set_header_tool_tip(
            "角色说话时头顶那个「…」气泡贴在哪。\n"
            "默认不写 = 运行时按每帧可见内容自动贴（蹲/躺/跑都自己跟）。\n"
            "只有内容顶 ≠ 头顶的状态才需要钉死：举枪、扛尸、打伞——自动锚会挂到道具尖上。\n"
            "写盘为 states[<状态>].bubbleAnchor（格高归一化比例，0=脚点、1=格子顶边）。",
        )
        self._bubble_sec.add_body(self._bubble_field)
        dl.addWidget(self._bubble_sec)

        self._preview_timer = QTimer(self)
        self._preview_timer.setTimerType(Qt.TimerType.CoarseTimer)
        self._preview_timer.timeout.connect(self._advance_preview_frame)
        self._preview_elapsed = QElapsedTimer()
        self._preview_accum: float = 0.0
        self._sheet_pixmap: QPixmap | None = None
        self._sheet_cache_key: str = ""
        self._preview_seq_i: int = 0
        self._preview_frames: list[int] = []

        prev_btn = QPushButton("刷新当前包图集预览")
        prev_btn.setToolTip(
            "仅从磁盘重载当前包目录下的图集 PNG；若 anim.json 有变请先点「从磁盘重载全部动画」。"
        )
        prev_btn.clicked.connect(self._refresh_preview)
        dl.addWidget(prev_btn)
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([260, 760])
        root.addWidget(splitter)
        self._anim_list_reload_deferred: bool = False
        self._model.data_changed.connect(self._on_model_data_changed)
        self._refresh()

    def _on_model_data_changed(self, data_type: str, _item_id: str) -> None:
        if data_type != "animation":
            return
        self._anim_list_reload_deferred = True
        if self.isVisible():
            self._flush_anim_list_from_model()

    def _flush_anim_list_from_model(self) -> None:
        if not self._anim_list_reload_deferred:
            return
        self._anim_list_reload_deferred = False
        keep = self._current_key
        self._list.blockSignals(True)
        self._list.clear()
        for k in sorted(self._model.animations.keys()):
            self._list.addItem(k)
        self._list.blockSignals(False)
        self._sync_list_chrome()
        if keep and keep in self._model.animations:
            self._select_stem(keep)
            # 有未保存改动时不要用盘面数据覆盖正在编辑的详情（保护编辑中内容不丢失）；
            # 本面板自身保存后会先清 dirty 再广播，故那条路径仍会刷新为已保存内容。
            if not self._dirty:
                self._on_select(keep)
        elif self._list.count() > 0:
            self._select_stem(self._list.item(0).text())
            self._on_select(self._list.item(0).text())
        else:
            self._clear_detail()

    def reload_refs_from_model(self) -> None:
        """切页激活钩子：先把磁盘上新出现的动画包补进内存，再刷列表。

        产线（`static_bundle_batch publish` / video_to_atlas 导出）刚发布的包，编辑器不重启
        也要能在这里看见（2026-08-06 批量上线静态占位包时发现这条断着）。走的是**只加不改**
        的 discover，不是清空重读——否则本面板里没保存的 anim.json 编辑会被冲掉。
        """
        if self._model.discover_new_animation_bundles():
            self._anim_list_reload_deferred = True
        self._flush_anim_list_from_model()

    def showEvent(self, event) -> None:  # type: ignore[override]
        super().showEvent(event)
        self.reload_refs_from_model()
        # 面板重新可见：恢复预览播放（离开时被 hideEvent 停掉，避免后台空转，P3）。
        self._restart_preview_animation()
        self._calib_elapsed.start()
        self._calib_timer.start()

    def hideEvent(self, event) -> None:  # type: ignore[override]
        # 面板不可见时停预览定时器：4~16ms tick 在后台空转纯耗 CPU（P3）。
        self._stop_preview_timer()
        self._calib_timer.stop()
        super().hideEvent(event)

    def has_unsaved_changes(self) -> bool:
        """供主窗 Save All 成功提示追加动画包未保存提醒（anim 直写 anim.json，不进
        ProjectModel dirty 桶；Save All 经 flush_to_model 钩子收集本面板）。"""
        return bool(self._dirty and self._current_key)

    def _open_video_atlas_detached(self) -> None:
        if self._model.project_path is None:
            QMessageBox.warning(self, "提示", "请先通过「打开工程」加载游戏项目目录。")
            return
        root = self._model.project_path.resolve()
        vta_dir = (root / "tools" / "video_to_atlas").resolve()
        main_py = vta_dir / "main.py"
        if not main_py.is_file():
            QMessageBox.warning(
                self, "未找到工具",
                f"未找到视频动画工具入口：\n{main_py}",
            )
            return
        argv = [str(main_py)]
        from ..shared.project_paths import DIR_KIND_EDITOR_ANIMATION_PROJECT
        ws = self._model.paths.default_dir(DIR_KIND_EDITOR_ANIMATION_PROJECT).resolve()
        if ws.is_dir() and (ws / "project.json").is_file():
            argv.append(str(ws))
        ok = QProcess.startDetached(
            sys.executable,
            argv,
            str(vta_dir),
        )
        if not ok:
            QMessageBox.warning(
                self, "启动失败",
                "无法以独立进程启动视频动画工具（请检查 Python 与路径）。",
            )

    def _reload_all_animations_from_disk(self) -> None:
        if self._model.project_path is None:
            QMessageBox.warning(self, "提示", "请先打开工程。")
            return
        if self._dirty and not self._confirm_discard_dirty(
            "重载会用磁盘上的 anim.json 覆盖当前面板。"
        ):
            return
        self._clear_dirty()
        self._model.reload_animations_from_disk()

    def _manifest_url(self, bundle_id: str) -> str:
        return f"/resources/runtime/animation/{bundle_id}/anim.json"

    def _atlas_target_view_width(self) -> int:
        dw = self._anim_detail_panel.width()
        if dw > _ATLAS_VIEW_RESERVE_RIGHT_COL + _ATLAS_VIEW_MIN_W:
            return max(
                _ATLAS_VIEW_MIN_W,
                min(_ATLAS_VIEW_MAX_W, dw - _ATLAS_VIEW_RESERVE_RIGHT_COL),
            )
        return _ATLAS_VIEW_MAX_W

    def _set_atlas_full_placeholder(self, message: str) -> None:
        self._atlas_full.clear()
        self._atlas_full.setText(message)
        self._atlas_full.setFixedSize(_ATLAS_VIEW_MIN_W, 120)

    def _set_frame_preview_placeholder(self, message: str) -> None:
        self._preview.clear()
        self._preview.setText(message)
        self._preview.setFixedSize(_FRAME_PREV_PLACEHOLDER_W, _FRAME_PREV_PLACEHOLDER_H)

    def _refresh(self) -> None:
        sel = self._list.currentItem()
        keep = sel.text() if sel else self._current_key
        self._list.blockSignals(True)
        self._list.clear()
        for k in sorted(self._model.animations.keys()):
            self._list.addItem(k)
        self._list.blockSignals(False)
        self._sync_list_chrome()
        if keep and keep in self._model.animations:
            self._select_stem(keep)
            self._on_select(keep)

    def _sync_list_chrome(self) -> None:
        """刷新列表后同步空态提示与当前搜索过滤（纯视图，不改数据）。"""
        self._empty_hint.setVisible(self._list.count() == 0)
        # 重新套用搜索框过滤，使 setHidden 与新内容一致
        self._search_box.textChanged.emit(self._search_box.text())

    def _select_stem(self, stem: str) -> None:
        """仅程序化定位列表项，全程屏蔽信号；详情加载由调用方显式 _on_select 完成。"""
        self._list.blockSignals(True)
        try:
            for i in range(self._list.count()):
                it = self._list.item(i)
                if it and it.text() == stem:
                    self._list.setCurrentRow(i)
                    return
        finally:
            self._list.blockSignals(False)

    def _clear_detail(self) -> None:
        self._stop_preview_timer()
        self._loading = True
        self._sheet_pixmap = None
        self._sheet_cache_key = ""
        self._preview_frames = []
        self._preview_seq_i = 0
        self._lbl_preview_info.setText("")
        self._current_key = None
        self._original_anim = None
        self._world_orig = {}
        self._world_seed = {}
        self._lbl_disk.clear()
        self._a_stem.clear()
        self._a_sheet.clear()
        self._a_cols.setValue(1)
        self._a_rows.setValue(1)
        self._a_cell_w.setValue(0)
        self._a_cell_h.setValue(0)
        self._a_world_mode.setCurrentIndex(0)
        self._a_ww.setValue(100)
        self._a_wh.setValue(160)
        self._a_bake_enable.setChecked(True)
        self._a_bake_downscale.setValue(4)
        self._orig_had_bake = False
        self._clear_state_rows()
        self._set_atlas_full_placeholder("")
        self._lbl_atlas_meta.setText("")
        self._set_frame_preview_placeholder("(未选择动画)")
        self._calib_strip.set_clip([], 8.0, 100.0, 150.0, None)
        self._loading = False
        self._clear_dirty()

    def _clear_state_rows(self) -> None:
        while self._state_table.rowCount() > 0:
            self._state_table.removeRow(0)

    def _on_select(self, key: str) -> None:
        if not key or key not in self._model.animations:
            self._clear_detail()
            return
        self._loading = True
        try:
            self._current_key = key
            a = self._model.animations[key]
            # 整包深拷贝作为保存基底：原样保留 spritesheet/cols/rows/单格像素/atlasFrames
            # 及任何未知键（如 player_taoist_anim_v1 的 notes），保存时只在其上施加 states/世界尺寸差异。
            self._original_anim = copy.deepcopy(a) if isinstance(a, dict) else {}
            man = self._manifest_url(key)
            if self._model.project_path:
                rel = Path("public") / PurePosixPath(man.strip().lstrip("/"))
                self._lbl_disk.setText(str(self._model.project_path / rel))
            else:
                self._lbl_disk.setText(man)
            self._a_stem.setText(key)
            self._a_sheet.setText(str(a.get("spritesheet", "")))
            self._a_cols.setValue(int(a.get("cols", 1)))
            self._a_rows.setValue(int(a.get("rows", 1)))
            cw0 = int(a.get("cellWidth", 0) or 0)
            ch0 = int(a.get("cellHeight", 0) or 0)
            self._a_cell_w.setValue(cw0 if cw0 > 0 else 0)
            self._a_cell_h.setValue(ch0 if ch0 > 0 else 0)
            self._capture_world_snapshot(a)
            self._sync_socket_panel(key, a)
            ww = self._world_seed.get("worldWidth", 0)
            wh = self._world_seed.get("worldHeight", 0)
            if ww > 0 and wh > 0:
                self._a_world_mode.setCurrentIndex(2)
            elif wh > 0:
                self._a_world_mode.setCurrentIndex(1)
            else:
                self._a_world_mode.setCurrentIndex(0)
            self._a_ww.setValue(ww if ww > 0 else 100)
            self._a_wh.setValue(wh if wh > 0 else 160)
            self._apply_world_mode_enabled()
            # 法线烘焙配置（normalBake；未配=默认启用 1/4）
            nb = a.get("normalBake")
            self._orig_had_bake = isinstance(nb, dict)
            nb = nb if isinstance(nb, dict) else {}
            self._a_bake_enable.setChecked(nb.get("enabled") is not False)
            _ds = nb.get("downscale")
            self._a_bake_downscale.setValue(
                int(_ds) if isinstance(_ds, (int, float)) and not isinstance(_ds, bool) and 1 <= _ds <= 32 else 4)

            self._clear_state_rows()
            states = a.get("states", {})
            if not isinstance(states, dict):
                states = {}
            for sname, sdef in states.items():
                if not isinstance(sdef, dict):
                    sdef = {}
                r = self._state_table.rowCount()
                self._state_table.insertRow(r)
                self._set_state_row(
                    r,
                    str(sname),
                    self._frames_to_cell_text(sdef.get("frames", [0])),
                    int(sdef.get("frameRate", 8)),
                    bool(sdef.get("loop", True)),
                    self._ref_speed_to_cell_text(sdef.get("referenceSpeed")),
                )
            if self._state_table.rowCount() > 0:
                self._state_table.selectRow(0)
        finally:
            self._loading = False
        self._clear_dirty()
        self._refresh_preview()

    @staticmethod
    def _ref_speed_to_cell_text(v: object) -> str:
        """referenceSpeed → 单元格文本：非正数/非数值/缺失显示为空（不参与匹配）。
        保留原字面表示（int 不带小数点），供未编辑时按原值写回。"""
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return ""
        if v <= 0:
            return ""
        return str(v)

    def _set_state_row(
        self, r: int, name: str, frames_text: str, rate: int, loop: bool,
        ref_speed_text: str = "",
    ) -> None:
        """填一行 state：name/frames/frameRate/refSpeed 为可编辑文本，loop 为复选框（无文本）。"""
        name_it = QTableWidgetItem(name)
        name_it.setData(Qt.ItemDataRole.UserRole, name)  # 旧名快照，重名/空名时回退
        self._state_table.setItem(r, 0, name_it)
        self._state_table.setItem(r, 1, QTableWidgetItem(frames_text))
        self._state_table.setItem(r, 2, QTableWidgetItem(str(max(1, int(rate)))))
        loop_it = QTableWidgetItem("")
        loop_it.setFlags(
            (loop_it.flags() | Qt.ItemFlag.ItemIsUserCheckable)
            & ~Qt.ItemFlag.ItemIsEditable
        )
        loop_it.setCheckState(
            Qt.CheckState.Checked if loop else Qt.CheckState.Unchecked)
        self._state_table.setItem(r, 3, loop_it)
        self._state_table.setItem(r, 4, QTableWidgetItem(ref_speed_text))

    # ---- 编辑 / 脏标记 / 保存 ------------------------------------------------

    def _on_list_selection_changed(self, key: str) -> None:
        """用户点选其它动画包：若当前有未保存改动，先询问保存/放弃/取消，再加载新包。"""
        if key == self._current_key:
            return
        if self._dirty and self._current_key:
            box = QMessageBox(self)
            box.setWindowTitle("未保存的改动")
            box.setText(f"动画包「{self._current_key}」有未保存改动，如何处理？")
            b_save = box.addButton("保存", QMessageBox.ButtonRole.AcceptRole)
            box.addButton("放弃", QMessageBox.ButtonRole.DestructiveRole)
            b_cancel = box.addButton("取消", QMessageBox.ButtonRole.RejectRole)
            box.exec()
            clicked = box.clickedButton()
            if clicked is b_cancel:
                self._select_stem(self._current_key)  # 还原选择，不切换
                return
            if clicked is b_save:
                if not self._do_save():  # 校验未过则留在原包
                    self._select_stem(self._current_key)
                    return
            else:  # 放弃
                self._clear_dirty()
        self._on_select(key)

    def _confirm_discard_dirty(self, reason: str) -> bool:
        ret = QMessageBox.question(
            self, "未保存的改动",
            f"动画包「{self._current_key}」有未保存改动。{reason}\n确定放弃这些改动？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        return ret == QMessageBox.StandardButton.Yes

    def confirm_close(self, parent=None) -> bool:
        """主窗口关闭/换工程门控：anim 编辑不进 ProjectModel dirty（直写 anim.json），
        必须自带此钩子，否则未保存的帧序/世界尺寸改动会被无提示丢弃（审查 P1-6）。
        挂点面板同样直写 sidecar，其脏态经 _on_socket_dirty 并进 self._dirty，走同一条门。"""
        panel = getattr(self, "_socket_panel", None)
        if panel is not None and panel.is_dirty():
            self._dirty = True
        if not self._dirty or not self._current_key:
            return True
        box = QMessageBox(self)
        box.setWindowTitle("未保存的动画改动")
        box.setText(f"动画包「{self._current_key}」有未保存改动，如何处理？")
        save_btn = box.addButton("保存", QMessageBox.ButtonRole.AcceptRole)
        box.addButton("放弃", QMessageBox.ButtonRole.DestructiveRole)
        cancel_btn = box.addButton("取消", QMessageBox.ButtonRole.RejectRole)
        box.exec()
        clicked = box.clickedButton()
        if clicked is cancel_btn:
            return False
        if clicked is save_btn:
            if not self._do_save():
                return False  # 保存失败（校验不过等）：留在编辑器里改
        return True

    def _mark_dirty(self) -> None:
        if self._loading:
            return
        self._dirty = True
        self._update_dirty_ui()

    def _on_socket_dirty(self, dirty: bool) -> None:
        """挂点面板的脏态并进本编辑器：保存/放弃/关闭门控走同一条路。"""
        if self._loading:
            return
        if dirty:
            self._dirty = True
        self._update_dirty_ui()

    def _sync_socket_panel(self, key: str, anim: dict) -> None:
        """切包时把挂点面板指到新包（图集像素由本编辑器已加载的 sheet pixmap 提供）。"""
        panel = getattr(self, "_socket_panel", None)
        if panel is None:
            return
        panel.set_bundle(key, anim, self._sheet_pixmap)

    def _clear_dirty(self) -> None:
        self._dirty = False
        self._update_dirty_ui()

    def _update_dirty_ui(self) -> None:
        has_pkg = bool(self._current_key)
        self._btn_save.setEnabled(self._dirty and has_pkg)
        self._btn_discard.setEnabled(self._dirty and has_pkg)
        self._lbl_dirty.setText("● 未保存" if self._dirty else "")

    def _on_field_edited(self, *_args) -> None:
        self._mark_dirty()

    def _apply_world_mode_enabled(self) -> None:
        mode = int(self._a_world_mode.currentData())
        self._a_ww.setEnabled(mode in (0, 2))
        self._a_wh.setEnabled(mode in (1, 2))

    def _on_world_mode_changed(self, *_args) -> None:
        self._apply_world_mode_enabled()
        self._mark_dirty()

    def _on_state_item_changed(self, item: QTableWidgetItem) -> None:
        if self._loading or item is None:
            return
        col = item.column()
        if col == 0:
            new_name = item.text().strip()
            old_name = item.data(Qt.ItemDataRole.UserRole)
            dup = any(
                r != item.row()
                and self._state_table.item(r, 0) is not None
                and self._state_table.item(r, 0).text().strip() == new_name
                for r in range(self._state_table.rowCount())
            )
            if not new_name or dup:
                self._loading = True
                try:
                    item.setText(str(old_name) if old_name is not None else "")
                finally:
                    self._loading = False
                QMessageBox.warning(
                    self, "状态名无效",
                    "状态名不能为空，且不能与其它状态重名。",
                )
                return
            item.setData(Qt.ItemDataRole.UserRole, new_name)
        self._mark_dirty()
        if col in (1, 2, 3) and item.row() == self._state_table.currentRow():
            self._restart_preview_animation()
        elif col == 4 and item.row() == self._state_table.currentRow():
            # refSpeed 列改动 → 只同步调校 spinbox/走带倍率，不重置走位
            self._sync_calib_ref_from_row()
            self._update_calib_mult_label()

    def _add_state(self) -> None:
        existing = {
            (self._state_table.item(r, 0).text().strip()
             if self._state_table.item(r, 0) else "")
            for r in range(self._state_table.rowCount())
        }
        name = "new_state"
        i = 1
        while name in existing:
            i += 1
            name = f"new_state_{i}"
        self._loading = True
        try:
            r = self._state_table.rowCount()
            self._state_table.insertRow(r)
            self._set_state_row(r, name, "0", 8, True, "")
        finally:
            self._loading = False
        self._state_table.selectRow(r)
        self._mark_dirty()

    def _remove_selected_state(self) -> None:
        row = self._state_table.currentRow()
        if row < 0:
            return
        name_it = self._state_table.item(row, 0)
        nm = name_it.text() if name_it else f"#{row}"
        if QMessageBox.question(
            self, "删除状态", f"删除状态「{nm}」？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        ) != QMessageBox.StandardButton.Yes:
            return
        self._state_table.removeRow(row)
        self._mark_dirty()
        self._restart_preview_animation()

    def _move_selected_state(self, delta: int) -> None:
        row = self._state_table.currentRow()
        if row < 0:
            return
        j = row + delta
        if j < 0 or j >= self._state_table.rowCount():
            return
        a = self._read_state_row(row)
        b = self._read_state_row(j)
        self._loading = True
        try:
            self._set_state_row(row, *b)
            self._set_state_row(j, *a)
        finally:
            self._loading = False
        self._state_table.selectRow(j)
        self._mark_dirty()

    def _read_state_row(self, r: int) -> tuple[str, str, int, bool, str]:
        name_it = self._state_table.item(r, 0)
        frames_it = self._state_table.item(r, 1)
        rate_it = self._state_table.item(r, 2)
        loop_it = self._state_table.item(r, 3)
        ref_it = self._state_table.item(r, 4)
        name = name_it.text() if name_it else ""
        frames_text = frames_it.text() if frames_it else "0"
        try:
            rate = int(round(float((rate_it.text() if rate_it else "8") or "8")))
        except ValueError:
            rate = 8
        loop = bool(loop_it and loop_it.checkState() == Qt.CheckState.Checked)
        ref_text = ref_it.text().strip() if ref_it else ""
        return name, frames_text, max(1, rate), loop, ref_text

    def _parse_frames_strict(self, text: str) -> list[int] | None:
        t = (text or "").strip()
        if not t:
            return None
        if t.startswith("["):
            try:
                raw = json.loads(t)
            except (json.JSONDecodeError, ValueError):
                return None
            if not isinstance(raw, list):
                return None
            try:
                return [int(x) for x in raw]
            except (ValueError, TypeError):
                return None
        parts = [p.strip() for p in t.split(",") if p.strip()]
        if not parts:
            return None
        out: list[int] = []
        for p in parts:
            try:
                out.append(int(p))
            except ValueError:
                return None
        return out

    def _collect_states_from_table(self) -> tuple[dict | None, str | None]:
        cols = max(1, int(self._a_cols.value()))
        rows = max(1, int(self._a_rows.value()))
        slots = cols * rows
        orig_states = (self._original_anim or {}).get("states", {})
        if not isinstance(orig_states, dict):
            orig_states = {}
        n = self._state_table.rowCount()
        if n == 0:
            return None, "至少需要保留一个状态。"
        out: dict = {}
        for r in range(n):
            name_it = self._state_table.item(r, 0)
            name = name_it.text().strip() if name_it else ""
            if not name:
                return None, f"第 {r + 1} 行的状态名为空。"
            if name in out:
                return None, f"状态名重复：{name!r}。"
            frames_it = self._state_table.item(r, 1)
            frames = self._parse_frames_strict(
                frames_it.text() if frames_it else "")
            if not frames:
                return None, f"状态 {name!r} 的帧列表无效（用逗号分隔的非负整数）。"
            bad = [fi for fi in frames if fi < 0 or fi >= slots]
            if bad:
                return None, (
                    f"状态 {name!r} 的帧索引 {bad} 超出图集槽位 0..{slots - 1}"
                    f"（cols×rows={slots}）。")
            rate_it = self._state_table.item(r, 2)
            try:
                rate = int(round(float(
                    (rate_it.text().strip() if rate_it else "8") or "8")))
            except ValueError:
                return None, f"状态 {name!r} 的帧率必须是数字。"
            if rate < 1:
                return None, f"状态 {name!r} 的帧率须 ≥ 1。"
            loop_it = self._state_table.item(r, 3)
            loop = bool(loop_it and loop_it.checkState() == Qt.CheckState.Checked)
            ref_it = self._state_table.item(r, 4)
            ref_text = ref_it.text().strip() if ref_it else ""
            old_name = name_it.data(Qt.ItemDataRole.UserRole) if name_it else None
            src = None
            if isinstance(old_name, str):
                src = orig_states.get(old_name)
            if src is None:
                src = orig_states.get(name)
            sdef: dict = {"frames": frames, "frameRate": rate, "loop": loop}
            if isinstance(src, dict):
                for k, v in src.items():
                    # referenceSpeed 由 refSpeed 列显式管理（空=删除），不走未知键透传
                    if k not in ("frames", "frameRate", "loop", "referenceSpeed"):
                        sdef[k] = v
            # 授权头顶锚：气泡锚控件改过才动，没动过沿用上面透传来的磁盘原值
            bub_edit = name_it.data(Qt.ItemDataRole.UserRole + 1) if name_it else None
            if bub_edit == "clear":
                sdef.pop("bubbleAnchor", None)
            elif isinstance(bub_edit, (int, float)) and not isinstance(bub_edit, bool):
                sdef["bubbleAnchor"] = round(float(bub_edit), 4)
            if ref_text:
                try:
                    ref_val = float(ref_text)
                except ValueError:
                    return None, f"状态 {name!r} 的 refSpeed 必须是数字（或留空=不参与匹配）。"
                if not (ref_val > 0):
                    return None, f"状态 {name!r} 的 refSpeed 须 > 0（或留空=不参与匹配）。"
                orig_ref = src.get("referenceSpeed") if isinstance(src, dict) else None
                if (
                    not isinstance(orig_ref, bool)
                    and isinstance(orig_ref, (int, float))
                    and float(orig_ref) == ref_val
                ):
                    # 未编辑（数值等于原字面值）→ 按原对象写回，保留 int/float 表示
                    sdef["referenceSpeed"] = orig_ref
                else:
                    sdef["referenceSpeed"] = int(ref_val) if ref_val.is_integer() else ref_val
            out[name] = sdef
        return out, None

    def _capture_world_snapshot(self, a: dict) -> None:
        """记录世界尺寸的原始字面值与 QSpinBox 载入种子（int 截断，与 setValue 一致），
        供保存时"未编辑按原字面值写回"（preserve_numeric_repr 惯例）判定。"""
        self._world_orig = {}
        self._world_seed = {}
        for key in ("worldWidth", "worldHeight"):
            v = a.get(key)
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                continue
            iv = int(v)
            if iv <= 0:
                continue
            self._world_orig[key] = v
            self._world_seed[key] = iv

    def _world_value_for_save(self, key: str, ctrl_val: int) -> int | float:
        """控件仍等于载入种子 → 未编辑，写回原字面值（保留 84.266667 / 160.0 等
        管线产出的小数表示）；被改过才用控件的整数值。"""
        orig_v = self._world_orig.get(key)
        if orig_v is not None and self._world_seed.get(key) == ctrl_val:
            return orig_v
        return ctrl_val

    def _bake_field_for_save(self) -> dict | None:
        """法线烘焙字段的写盘值：None=不写（保持文件无此键，最小 diff）。

        往返保真：原文件已有 normalBake → 始终写回（保留其存在与位置）；原文件没有且
        当前是默认（启用+1/4）→ 不写（无编辑不无中生有加键）。
        """
        enabled = self._a_bake_enable.isChecked()
        ds = int(self._a_bake_downscale.value())
        is_default = enabled and ds == 4
        if getattr(self, "_orig_had_bake", False) or not is_default:
            return {"enabled": enabled, "downscale": ds}
        return None

    def _build_saved_anim_dict(self) -> tuple[dict | None, str | None]:
        new_states, err = self._collect_states_from_table()
        if err:
            return None, err
        mode = int(self._a_world_mode.currentData())
        want_ww = mode in (0, 2)
        want_wh = mode in (1, 2)
        ww = int(self._a_ww.value())
        wh = int(self._a_wh.value())
        if want_ww and ww <= 0:
            return None, "worldWidth 须为正整数。"
        if want_wh and wh <= 0:
            return None, "worldHeight 须为正整数。"
        ww_out = self._world_value_for_save("worldWidth", ww)
        wh_out = self._world_value_for_save("worldHeight", wh)
        # 键序保真：原有键（含 states/worldWidth/worldHeight）一律回原位置，
        # 只有原文件没有的世界尺寸键才新插在 states 之后。
        bake_out = self._bake_field_for_save()   # dict 或 None（None=不写该键）
        orig = self._original_anim if isinstance(self._original_anim, dict) else {}
        out: dict = {}
        for k, v in orig.items():
            if k == "states":
                out["states"] = new_states
            elif k == "worldWidth":
                if want_ww:
                    out["worldWidth"] = ww_out
            elif k == "worldHeight":
                if want_wh:
                    out["worldHeight"] = wh_out
            elif k == "normalBake":
                if bake_out is not None:
                    out["normalBake"] = bake_out   # 原位保真；None=从文件删除该键
            else:
                out[k] = v
        if "states" not in out:
            out = {"states": new_states, **out}
        if bake_out is not None and "normalBake" not in out:
            out["normalBake"] = bake_out           # 原文件无此键、现需写入 → 追加末尾
        missing_ww = want_ww and "worldWidth" not in out
        missing_wh = want_wh and "worldHeight" not in out
        if missing_ww or missing_wh:
            rebuilt: dict = {}
            for k, v in out.items():
                rebuilt[k] = v
                if k == "states":
                    if missing_ww:
                        rebuilt["worldWidth"] = ww_out
                    if missing_wh:
                        rebuilt["worldHeight"] = wh_out
            out = rebuilt
        return out, None

    def _save_current_bundle(self) -> str | None:
        """把当前包的表格状态写盘（save_animation_bundle 直写 anim.json）。
        成功返回 None，失败返回错误文案——不弹窗，供保存按钮与 Save All flush 两个入口复用。"""
        if not self._current_key:
            return "未选中动画包"
        new_dict, err = self._build_saved_anim_dict()
        if err or new_dict is None:
            return err or "未知错误"
        try:
            self._model.save_animation_bundle(self._current_key, new_dict)
        except Exception as e:  # noqa: BLE001 — 反馈给用户即可
            return str(e)
        self._original_anim = copy.deepcopy(
            self._model.animations.get(self._current_key, new_dict))
        # 保存后以盘面新值为基线重建种子，防止"改回种子值"误还原成保存前的旧字面值
        panel = getattr(self, "_socket_panel", None)
        # 只在挂点真被改过时才写：无条件写会把 sanitize 刷新的新指纹盖上去，
        # 等于「改个 worldWidth 顺手把一份已失效的挂点认证为有效」（审查 #4）。
        if panel is not None and panel.is_dirty():
            sock_err = panel.save()
            if sock_err:
                return f"挂点保存失败：{sock_err}"
        self._capture_world_snapshot(self._original_anim)
        self._clear_dirty()
        self._refresh_preview()
        return None

    def _do_save(self) -> bool:
        if not self._current_key:
            return False
        err = self._save_current_bundle()
        if err:
            QMessageBox.warning(self, "无法保存", err)
            return False
        return True

    def _do_rebake_normal(self) -> None:
        """按当前配置重烘本动画法线：先存盘（持久化 normalBake），再调 bake-normals 单烘。"""
        if not self._current_key:
            return
        err = self._save_current_bundle()   # 存盘后 anim.json 的 normalBake = 当前控件值
        if err:
            QMessageBox.warning(self, "无法保存", err)
            return
        if not self._model.project_path:
            QMessageBox.warning(self, "无法重烘", "工程未加载。")
            return
        anim_dir = (Path(self._model.project_path)
                    / "public/resources/runtime/animation" / self._current_key)
        try:
            from tools.animation_pipeline.bake_normal_atlas import bake_one
            msg = bake_one(anim_dir, force=True, cli_downscale=None)
        except Exception as e:  # noqa: BLE001 — 反馈给用户即可
            QMessageBox.warning(self, "重烘失败", str(e))
            return
        self._refresh_preview()
        QMessageBox.information(self, "重烘法线", msg)

    def flush_to_model(self, for_save_all: bool = False) -> bool:
        """Save All 钩子（主窗鸭子协议）：把当前包未保存的表格编辑落盘。

        动画包不走 model 脏桶——save_animation_bundle 直写 anim.json 并同步内存，
        缺此钩子时 Save All 会静默跳过本面板：改了帧率/refSpeed 等只标脏、盘面零 diff，
        除非用户记得点面板自己的「保存」按钮。无脏或未选包时空转成功。
        ``for_save_all`` 仅为统一调用签名，逻辑不区分。
        """
        if not self._dirty or not self._current_key:
            return True
        err = self._save_current_bundle()
        if err:
            self._flush_error = err
            return False
        return True

    def pop_flush_error(self) -> str | None:
        """Save All 失败详情（主窗在 flush 返回 False 后取用，一次性）。"""
        err = getattr(self, "_flush_error", None)
        self._flush_error = None
        return err

    def _do_discard(self) -> None:
        if not self._dirty or not self._current_key:
            return
        if not self._confirm_discard_dirty("将从磁盘重新载入该包。"):
            return
        panel = getattr(self, "_socket_panel", None)
        if panel is not None:
            panel.discard()
        self._clear_dirty()
        self._on_select(self._current_key)

    def _frames_to_cell_text(self, frames: object) -> str:
        if isinstance(frames, list):
            return ",".join(str(int(x)) for x in frames)
        return "0"

    def _parse_frames_from_cell(
        self, item: QTableWidgetItem | None, *, quiet: bool = True
    ) -> list[int]:
        if item is None:
            return [0]
        text = item.text().strip()
        if not text:
            return [0]
        if text.startswith("["):
            try:
                raw = json.loads(text)
                if isinstance(raw, list):
                    if not raw:
                        return [0]
                    return [int(x) for x in raw]
            except (json.JSONDecodeError, ValueError, TypeError):
                pass
        parts = [p.strip() for p in text.split(",") if p.strip()]
        out: list[int] = []
        for p in parts:
            try:
                out.append(int(p))
            except ValueError:
                return [] if quiet else [0]
        return out if out else [0]

    def _refresh_preview(self) -> None:
        self._sheet_pixmap = None
        self._sheet_cache_key = ""
        self._update_normal_full()
        if self._model.project_path is None or not self._current_key:
            self._update_atlas_full_label()
            return
        sheet_path = self._a_sheet.text().strip()
        if not sheet_path:
            self._set_atlas_full_placeholder("(未设置 spritesheet)")
            self._lbl_atlas_meta.setText("")
            self._set_frame_preview_placeholder("(未设置 spritesheet)")
            self._restart_preview_animation()
            return
        man = self._manifest_url(self._current_key)
        full = _spritesheet_disk(self._model.project_path, man, sheet_path)
        if full and full.is_file():
            pm = QPixmap(str(full))
            if not pm.isNull():
                self._sheet_pixmap = pm
                self._sheet_cache_key = sheet_path
                panel = getattr(self, "_socket_panel", None)
                if panel is not None and self._current_key:
                    # 只补图集像素：走 set_bundle 会从磁盘重读，把没保存的标注静默丢掉
                    panel.set_atlas(pm)
                self._update_atlas_full_label()
                self._restart_preview_animation()
                return
        self._set_atlas_full_placeholder(
            f"无法加载: {sheet_path}\n解析路径: {full}")
        self._lbl_atlas_meta.setText("")
        self._set_frame_preview_placeholder(f"无法加载图集")
        self._stop_preview_timer()

    def _normal_disk_path(self) -> Path | None:
        """当前包图集的法线图磁盘路径（<图集>.normal.png），无则 None。"""
        if self._model.project_path is None or not self._current_key:
            return None
        sheet_path = self._a_sheet.text().strip()
        if not sheet_path:
            return None
        man = self._manifest_url(self._current_key)
        full = _spritesheet_disk(self._model.project_path, man, sheet_path)
        if full is None:
            return None
        return full.with_name(full.stem + ".normal.png")

    def _update_normal_full(self) -> None:
        """把 <图集>.normal.png 显示在图集旁边；未烘焙则给提示占位。"""
        np_path = self._normal_disk_path()
        if np_path is None or not np_path.is_file():
            self._normal_full.setPixmap(QPixmap())
            self._normal_full.setFixedSize(_ATLAS_VIEW_MIN_W, 120)
            self._normal_full.setText("未烘焙\n（点「重烘本动画法线」）"
                                      if self._a_bake_enable.isChecked() else "已禁用烘焙")
            self._lbl_normal_meta.setText("")
            return
        # 经 QImage 解码再转 QPixmap，避免重烘后同名文件命中旧解码缓存（与场景缩略图同法）
        pm = QPixmap.fromImage(QImage(str(np_path)))
        if pm.isNull():
            self._normal_full.setPixmap(QPixmap())
            self._normal_full.setText("(法线图无法加载)")
            self._lbl_normal_meta.setText("")
            return
        avail_w = self._atlas_target_view_width()
        scaled = pm.scaled(avail_w, _ATLAS_VIEW_MAX_H,
                           Qt.AspectRatioMode.KeepAspectRatio,
                           Qt.TransformationMode.SmoothTransformation)
        self._normal_full.setPixmap(scaled)
        self._normal_full.setFixedSize(scaled.size())
        self._normal_full.setText("")
        kb = np_path.stat().st_size / 1024
        self._lbl_normal_meta.setText(f"法线图 {pm.width()}×{pm.height()} px  ·  {kb:.0f} KB")

    def _update_atlas_full_label(self) -> None:
        if self._sheet_pixmap is None or self._sheet_pixmap.isNull():
            self._set_atlas_full_placeholder("(无雪碧图)")
            self._lbl_atlas_meta.setText("")
            return
        cols = max(1, self._a_cols.value())
        rows = max(1, self._a_rows.value())
        w = self._sheet_pixmap.width()
        h = self._sheet_pixmap.height()
        avail_w = self._atlas_target_view_width()
        scaled = self._sheet_pixmap.scaled(
            avail_w,
            _ATLAS_VIEW_MAX_H,
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        self._atlas_full.setPixmap(scaled)
        self._atlas_full.setFixedSize(scaled.size())
        self._atlas_full.setText("")
        stride_w, stride_h = _effective_cell_stride(
            cols, rows, self._sheet_pixmap,
            self._a_cell_w.value(), self._a_cell_h.value(),
        )
        af_n = 0
        if self._current_key and self._current_key in self._model.animations:
            af = self._model.animations[self._current_key].get("atlasFrames")
            if isinstance(af, list):
                af_n = len(af)
        af_hint = f"  ·  atlasFrames {af_n} 项" if af_n else ""
        self._lbl_atlas_meta.setText(
            f"原图 {w}×{h} px  ·网格 {cols}×{rows}  ·  单格步进 {stride_w}×{stride_h} px{af_hint}"
        )

    def _stop_preview_timer(self) -> None:
        self._preview_timer.stop()

    def _on_state_selection_changed(self) -> None:
        self._restart_preview_animation()
        self._sync_bubble_field_to_row()

    # ---- 本状态授权头顶锚 ------------------------------------------------

    def _selected_state_name(self) -> str:
        row = self._state_table.currentRow()
        it = self._state_table.item(row, 0) if row >= 0 else None
        return it.text().strip() if it else ""

    def _bubble_actor_for_selected_state(self) -> BubbleAnchorActor:
        """舞台对象来自**编辑器当前载入的包**（不经 ProjectModel），未保存的世界尺寸改动也照出。"""
        a = self._original_anim
        name = self._selected_state_name()
        if not isinstance(a, dict) or not name:
            return BubbleAnchorActor(hint="先在上面的表里选一个状态")
        if not self._current_key:
            return BubbleAnchorActor(hint="当前没有载入动画包")
        data = copy.deepcopy(a)
        # 世界尺寸取表单当前值（可能还没保存），其余取磁盘原样
        ww = float(max(1, self._a_ww.value()))
        wh = float(max(1, self._a_wh.value()))
        data["worldWidth"] = ww
        data["worldHeight"] = wh
        # 本行待写入的授权值先反映进预览数据，切状态回来还能看见
        edit = self._pending_bubble_edit_for_row(self._state_table.currentRow())
        if edit is not None:
            sd = data.setdefault("states", {}).setdefault(name, {})
            if edit == "clear":
                sd.pop("bubbleAnchor", None)
            else:
                sd["bubbleAnchor"] = edit
        return BubbleAnchorActor(
            kind="actor",
            label=f"{self._current_key} / {name}",
            hint="",
            anim_data=data,
            anim_manifest_url=anim_manifest_url_for_bundle(self._current_key),
            world_w=ww,
            world_h=wh,
            states=[name],
            default_state=name,
        )

    def _pending_bubble_edit_for_row(self, row: int) -> float | str | None:
        """本行尚未落盘的授权锚编辑：float=授权值、"clear"=清除授权、None=没动过。

        存在 name 单元格的 UserRole+1 上——跟着行走，改名/重排/删行自动跟随，
        不用另建一份按名字索引的账（那种账在重命名后必对不上）。
        """
        it = self._state_table.item(row, 0) if row >= 0 else None
        return it.data(Qt.ItemDataRole.UserRole + 1) if it else None

    def _sync_bubble_field_to_row(self) -> None:
        if not hasattr(self, "_bubble_field"):
            return
        self._bubble_field.refresh_actor()
        row = self._state_table.currentRow()
        edit = self._pending_bubble_edit_for_row(row)
        name = self._selected_state_name()
        stored = None
        if isinstance(self._original_anim, dict) and name:
            sd = (self._original_anim.get("states") or {}).get(name)
            if isinstance(sd, dict):
                stored = sd.get("bubbleAnchor")
        frac = edit if isinstance(edit, (int, float)) else (None if edit == "clear" else stored)
        wh = float(max(1, self._a_wh.value()))
        self._bubble_field.set_committed_anchor(
            None if frac is None else -float(frac) * wh - BUBBLE_HEAD_GAP,
        )

    def _on_bubble_anchor_changed(self) -> None:
        row = self._state_table.currentRow()
        it = self._state_table.item(row, 0) if row >= 0 else None
        if it is None:
            return
        v = self._bubble_field.value()
        wh = float(max(1, self._a_wh.value()))
        # 控件说的是"气泡底边的绝对世界 y（含 headGap）"，anim.json 存的是格高归一化比例
        frac = None if v is None else max(0.0, (-float(v) - BUBBLE_HEAD_GAP) / wh)
        it.setData(Qt.ItemDataRole.UserRole + 1, "clear" if frac is None else frac)
        self._mark_dirty()

    # ---- 步速匹配调校走廊 ----------------------------------------------------

    def _gather_row_ref_speed(self, row: int) -> float | None:
        if row < 0 or row >= self._state_table.rowCount():
            return None
        it = self._state_table.item(row, 4)
        txt = it.text().strip() if it else ""
        if not txt:
            return None
        try:
            v = float(txt)
        except ValueError:
            return None
        return v if v > 0 else None

    def _reload_calib_from_row(self) -> None:
        row = self._state_table.currentRow()
        data = self._gather_row_preview(row)
        if not data or self._sheet_pixmap is None or self._sheet_pixmap.isNull():
            self._calib_strip.set_clip([], 8.0, 100.0, 150.0, None)
        else:
            _name, frames, rate, _loop = data
            self._calib_strip.set_clip(
                frames, rate,
                float(max(1, self._a_ww.value())),
                float(max(1, self._a_wh.value())),
                self._atlas_crop,
            )
            self._calib_strip.set_speed(float(self._calib_speed.value()))
        self._sync_calib_ref_from_row()
        self._update_calib_mult_label()

    def _sync_calib_ref_from_row(self) -> None:
        """表格 refSpeed 列 → 调校 spinbox/走带（不重置走位；spinbox 侧回写有环路守卫）。"""
        ref = self._gather_row_ref_speed(self._state_table.currentRow())
        self._calib_ref_syncing = True
        try:
            self._calib_ref.setValue(float(ref) if ref else 0.0)
        finally:
            self._calib_ref_syncing = False
        self._calib_strip.set_ref_speed(ref)

    def _on_calib_speed_changed(self, v: float) -> None:
        self._calib_strip.set_speed(float(v))
        self._update_calib_mult_label()

    def _on_calib_ref_changed(self, v: float) -> None:
        if self._calib_ref_syncing:
            return
        row = self._state_table.currentRow()
        if row < 0:
            return
        it = self._state_table.item(row, 4)
        if it is None:
            it = QTableWidgetItem("")
            self._state_table.setItem(row, 4, it)
        vv = float(v)
        # 写表格该行 refSpeed 列 → itemChanged 标脏，保存路径与手改表格完全一致
        it.setText("" if vv <= 0 else f"{vv:g}")
        self._calib_strip.set_ref_speed(vv if vv > 0 else None)
        self._update_calib_mult_label()

    def _update_calib_mult_label(self) -> None:
        mult, clamped = self._calib_strip.multiplier()
        if self._calib_ref.value() <= 0:
            self._lbl_calib_mult.setText("未匹配（恒原速）")
        else:
            self._lbl_calib_mult.setText(
                f"倍率 {mult:.2f}×" + ("（已夹取 0.5~2）" if clamped else ""))

    def _tick_calib(self) -> None:
        if not self._calib_strip.isVisible():
            # 折叠/被遮挡时不推进也不累积 dt（展开瞬间不跳帧）
            self._calib_elapsed.restart()
            return
        dt = self._calib_elapsed.restart() / 1000.0
        if dt < 0:
            dt = 0.0
        dt = min(dt, _PREVIEW_MAX_DT_SEC)
        self._calib_strip.tick(dt)

    def _gather_row_preview(self, row: int) -> tuple[str, list[int], float, bool] | None:
        if row < 0 or row >= self._state_table.rowCount():
            return None
        name_item = self._state_table.item(row, 0)
        frames_item = self._state_table.item(row, 1)
        name = name_item.text().strip() if name_item else ""
        frames = self._parse_frames_from_cell(frames_item, quiet=True)
        if not frames:
            frames = [0]
        rate_item = self._state_table.item(row, 2)
        try:
            raw = (rate_item.text() if rate_item else "").strip()
            rate = float(raw) if raw else 8.0
        except ValueError:
            rate = 8.0
        rate = max(1e-6, float(rate))
        loop_item = self._state_table.item(row, 3)
        loop_b = True
        if loop_item is not None:
            loop_b = loop_item.checkState() == Qt.CheckState.Checked
        return (name or f"row{row}", frames, float(rate), loop_b)

    def _atlas_crop(self, atlas_index: int) -> QPixmap | None:
        if self._sheet_pixmap is None or self._sheet_pixmap.isNull():
            return None
        cols = max(1, self._a_cols.value())
        rows = max(1, self._a_rows.value())
        pw = self._sheet_pixmap.width()
        ph = self._sheet_pixmap.height()
        stride_w, stride_h = _effective_cell_stride(
            cols, rows, self._sheet_pixmap,
            self._a_cell_w.value(), self._a_cell_h.value(),
        )
        sw, sh = stride_w, stride_h
        if self._current_key and self._current_key in self._model.animations:
            af = self._model.animations[self._current_key].get("atlasFrames")
            if isinstance(af, list) and 0 <= atlas_index < len(af):
                b = af[atlas_index]
                if isinstance(b, dict):
                    bw = int(b.get("width", 0) or 0)
                    bh = int(b.get("height", 0) or 0)
                    if bw > 0:
                        sw = bw
                    if bh > 0:
                        sh = bh
        col = atlas_index % cols
        row = atlas_index // cols
        if col >= cols or row >= rows:
            return None
        x = col * stride_w
        y = row * stride_h
        if x + sw > pw or y + sh > ph:
            return None
        rect = QRect(x, y, sw, sh)
        return self._sheet_pixmap.copy(rect)

    def _show_cropped_scaled(
        self, cropped: QPixmap | None, *, fast_scale: bool = False
    ) -> None:
        if cropped is None or cropped.isNull():
            self._set_frame_preview_placeholder("(无法切帧：检查 cols/rows 与帧索引)")
            return
        mode = (
            Qt.TransformationMode.FastTransformation
            if fast_scale
            else Qt.TransformationMode.SmoothTransformation
        )
        scaled = cropped.scaled(
            _FRAME_PREV_MAX_W,
            _FRAME_PREV_MAX_H,
            Qt.AspectRatioMode.KeepAspectRatio,
            mode,
        )
        self._preview.setPixmap(scaled)
        self._preview.setFixedSize(scaled.size())
        self._preview.setText("")

    def _restart_preview_animation(self) -> None:
        # 调校走廊与静态预览同源重载（选行/改帧序帧率/换包/重新可见都会走到这里）
        self._reload_calib_from_row()
        self._stop_preview_timer()
        self._preview_accum = 0.0
        self._preview_frames = []
        self._preview_seq_i = 0
        row = self._state_table.currentRow()
        if row < 0:
            self._lbl_preview_info.setText("")
            if self._sheet_pixmap is not None and not self._sheet_pixmap.isNull():
                self._show_cropped_scaled(self._atlas_crop(0))
                self._lbl_preview_info.setText("（请选中一行 state）")
            elif not self._a_sheet.text().strip():
                self._set_frame_preview_placeholder("(未设置 spritesheet)")
                return
        data = self._gather_row_preview(row)
        if not data:
            return
        name, frames, rate, _loop = data
        self._preview_frames = frames
        self._preview_seq_i = 0
        if not self._sheet_pixmap or self._sheet_pixmap.isNull():
            self._set_frame_preview_placeholder("(无法加载雪碧图)")
            self._lbl_preview_info.setText("")
            return
        first = self._atlas_crop(frames[0])
        self._show_cropped_scaled(first)
        theory_ms = max(1, int(round(1000.0 / float(rate))))
        if not self._chk_preview_play.isChecked() or len(frames) <= 1:
            self._update_preview_info(name, len(frames), 0)
            return
        self._update_preview_info(name, len(frames), theory_ms)
        self._preview_elapsed.start()
        self._preview_timer.start(_preview_poll_interval_ms(float(rate)))

    def _update_preview_info(self, state_name: str, n_frames: int, interval_ms: int) -> None:
        pos = self._preview_seq_i + 1
        base = f"{state_name}  第 {pos}/{max(1, n_frames)} 帧"
        if interval_ms > 0:
            base = f"{base}  ·  {interval_ms}ms/帧"
        # 播放预览里也把落脚帧标出来：作者看着动画走，哪一帧会响脚步一目了然
        frames = self._preview_frames
        panel = getattr(self, "_socket_panel", None)
        if panel is not None and frames and 0 <= self._preview_seq_i < len(frames) \
                and panel.is_contact_slot(int(frames[self._preview_seq_i])):
            base = f"{base}  ·  ▶ 落脚帧（播脚步声）"
        self._lbl_preview_info.setText(base)

    def _advance_preview_frame(self) -> None:
        row = self._state_table.currentRow()
        if row < 0:
            self._stop_preview_timer()
            return
        data = self._gather_row_preview(row)
        if not data:
            self._stop_preview_timer()
            return
        name, frames, rate, loop = data
        self._preview_frames = frames
        if len(frames) <= 1:
            self._stop_preview_timer()
            return
        dt = self._preview_elapsed.restart() / 1000.0
        if dt < 0:
            dt = 0.0
        dt = min(dt, _PREVIEW_MAX_DT_SEC)
        self._preview_accum += dt
        step = 1.0 / float(max(1e-6, rate))
        theory_ms = max(1, int(round(1000.0 / float(rate))))
        changed = False
        while self._preview_accum >= step:
            self._preview_accum -= step
            self._preview_seq_i += 1
            if self._preview_seq_i >= len(frames):
                if loop:
                    self._preview_seq_i = 0
                else:
                    self._preview_seq_i = len(frames) - 1
                    self._stop_preview_timer()
                    crop = self._atlas_crop(frames[self._preview_seq_i])
                    self._show_cropped_scaled(crop, fast_scale=False)
                    self._update_preview_info(name, len(frames), 0)
                    return
            changed = True
        if changed:
            crop = self._atlas_crop(frames[self._preview_seq_i])
            self._show_cropped_scaled(crop, fast_scale=True)
            self._update_preview_info(name, len(frames), theory_ms)
