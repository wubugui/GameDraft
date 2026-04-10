"""视频转 Atlas：全局帧库、多动画序列、native 等大导出、色键预览。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import numpy as np
from PySide6.QtCore import QEvent, QObject, QSize, Qt, QTimer, QUrl
from PySide6.QtGui import QColor, QIcon, QImage, QMouseEvent, QPixmap, QResizeEvent
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtMultimediaWidgets import QVideoWidget
from PySide6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QColorDialog,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSpinBox,
    QSplitter,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from PIL import Image

from atlas_core import (
    BuildConfig,
    bgr_to_rgba_frame,
    bgra_to_bgr_preview,
    decode_segment_rgba_frames,
    export_gamedraft_anim_multi,
    flip_bgra_horizontal,
    meta_atlas_to_bgra_frames,
    save_outputs,
    scale_bgra_uniform,
)
from loop_range_bar import LoopRangeBar
from project_model import (
    AnimationClip,
    FrameItem,
    VideoProject,
    build_merge_atlas_and_states,
    export_single_clip_native,
    make_animation_clip,
    new_id,
)

# 库内蒙版预览最大边长（避免 QLabel 随 pixmap 撑大 + Resize 反复刷新导致无限变大）
_LIB_ONION_BLEND_MAX_W = 480
_LIB_ONION_BLEND_MAX_H = 320
_LIB_ONION_BLEND_MIN_W = 280

# 色键双栏预览：原图小、剔除结果大（便于看边缘）；宽度来自 gb_chroma，高度可参 keyed 标签当前高度
_CHROMA_ORIG_MAX_W = 220
_CHROMA_ORIG_MAX_H = 200
_CHROMA_ORIG_MIN_W = 140
_CHROMA_ORIG_MIN_H = 100
_CHROMA_KEYED_MAX_W = 1200
_CHROMA_KEYED_MAX_H = 900
_CHROMA_KEYED_MIN_W = 280
_CHROMA_KEYED_MIN_H = 220

_CLIP_PREVIEW_MAX_W = 400
_CLIP_PREVIEW_MAX_H = 400
_CLIP_PREVIEW_MIN_W = 200


def _bgr_to_qpixmap(bgr: np.ndarray) -> QPixmap:
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]
    rgb = np.ascontiguousarray(rgb)
    qimg = QImage(rgb.data, w, h, w * 3, QImage.Format.Format_RGB888)
    return QPixmap.fromImage(qimg.copy())


def composite_checkerboard_bgra(bgra: np.ndarray, cell: int = 12) -> np.ndarray:
    """BGRA → 棋盘格底合成 BGR，便于预览透明。"""
    h, w = bgra.shape[:2]
    ys = np.arange(h, dtype=np.int32)[:, None] // cell
    xs = np.arange(w, dtype=np.int32)[None, :] // cell
    odd = ((xs + ys) % 2) == 0
    bg = np.empty((h, w, 3), dtype=np.uint8)
    bg[odd] = np.array([210, 210, 210], dtype=np.uint8)
    bg[~odd] = np.array([130, 130, 130], dtype=np.uint8)
    bg_bgr = cv2.cvtColor(bg, cv2.COLOR_RGB2BGR)
    a = bgra[:, :, 3:4].astype(np.float32) / 255.0
    bgr = bgra[:, :, :3].astype(np.float32)
    out = bgr * a + bg_bgr.astype(np.float32) * (1.0 - a)
    return np.clip(out, 0, 255).astype(np.uint8)


class _LibraryThumbButton(QPushButton):
    """库缩略图：Ctrl+左键选首帧，Alt+左键选尾帧。"""

    def __init__(self, idx: int, main: "MainWindow", parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._idx = idx
        self._main = main

    def mousePressEvent(self, ev: QMouseEvent) -> None:
        if ev.button() == Qt.MouseButton.LeftButton:
            self._main._on_library_thumb_mouse(self._idx, ev.modifiers())
            return
        super().mousePressEvent(ev)


class MainWindow(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("视频转 Atlas（GameDraft · 多序列）")
        self.resize(1400, 1020)

        self._project = VideoProject()
        self._video_path: Optional[str] = None
        self._duration_sec = 0.0
        self._source_fps = 30.0
        self._loop_seek_guard = False
        self._library_thumb_btns: List[QPushButton] = []

        self._clip_preview_idx = 0
        self._active_clip_id: Optional[str] = None

        self._chroma_key_rgb: Tuple[int, int, int] = (255, 255, 255)
        self._chroma_orig_bgr: Optional[np.ndarray] = None
        self._chroma_pick_from_orig = False

        self._player = QMediaPlayer()
        self._audio = QAudioOutput()
        self._player.setAudioOutput(self._audio)
        self._audio.setVolume(0.0)

        self._loop_poll_timer = QTimer(self)
        self._loop_poll_timer.setInterval(16)
        self._loop_poll_timer.timeout.connect(self._tick_playback_range)

        self._chroma_debounce = QTimer(self)
        self._chroma_debounce.setSingleShot(True)
        self._chroma_debounce.setInterval(90)
        self._chroma_debounce.timeout.connect(self._run_chroma_preview)

        self._clip_preview_timer = QTimer(self)
        self._clip_preview_timer.timeout.connect(self._on_clip_preview_tick)

        self._build_ui()

        self._player.playbackStateChanged.connect(self._on_playback_state_changed)
        self._player.durationChanged.connect(self._on_player_duration_changed)
        self._player.errorOccurred.connect(self._on_player_error)
        self._player.positionChanged.connect(self._on_player_position_changed)

    def _build_ui(self) -> None:
        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)
        root.addWidget(splitter)

        left_scroll = QScrollArea()
        left_scroll.setWidgetResizable(True)
        left_scroll.setMinimumWidth(500)
        left_panel = QWidget()
        left_outer = QVBoxLayout(left_panel)
        left_outer.setContentsMargins(0, 0, 0, 0)
        self._left_tabs = QTabWidget()
        left_outer.addWidget(self._left_tabs)
        left_scroll.setWidget(left_panel)
        splitter.addWidget(left_scroll)

        tab_video = QWidget()
        v_video = QVBoxLayout(tab_video)
        self._left_tabs.addTab(tab_video, "视频与抽取")
        tab_chroma = QWidget()
        v_chroma = QVBoxLayout(tab_chroma)
        self._left_tabs.addTab(tab_chroma, "色键与全局库")
        tab_anim = QWidget()
        v_anim = QVBoxLayout(tab_anim)
        self._left_tabs.addTab(tab_anim, "动画与导出")
        tab_atlas = QWidget()
        v_atlas = QVBoxLayout(tab_atlas)
        self._left_tabs.addTab(tab_atlas, "图集还原")

        gb_file = QGroupBox("视频")
        fl = QVBoxLayout(gb_file)
        self.btn_open = QPushButton("打开视频…")
        self.btn_open.clicked.connect(self._open_video)
        fl.addWidget(self.btn_open)
        self.lbl_video = QLabel("未加载")
        self.lbl_video.setWordWrap(True)
        fl.addWidget(self.lbl_video)
        v_video.addWidget(gb_file)

        gb_range = QGroupBox("时间区间（仅播放 t0～t1；拖动圆点立即约束播放位置）")
        v_range = QVBoxLayout(gb_range)
        self.range_bar = LoopRangeBar()
        self.range_bar.rangeChanged.connect(self._on_loop_range_changed)
        v_range.addWidget(self.range_bar)
        self.lbl_range = QLabel("t0: —   t1: —")
        v_range.addWidget(self.lbl_range)

        hl_play = QHBoxLayout()
        self.btn_play = QPushButton("播放")
        self.btn_play.clicked.connect(self._toggle_play)
        hl_play.addWidget(self.btn_play)
        self.cb_loop_segment = QCheckBox("到 t1 后循环回 t0")
        self.cb_loop_segment.setChecked(True)
        self.cb_loop_segment.setToolTip(
            "播放始终只在上方所选区间内。勾选：将近 t1 时跳回 t0 循环；"
            "不勾选：将近 t1 时暂停在区间末尾。"
        )
        self.cb_loop_segment.toggled.connect(self._on_loop_mode_toggled)
        hl_play.addWidget(self.cb_loop_segment)
        self.cb_mute = QCheckBox("静音预览")
        self.cb_mute.setChecked(True)
        self.cb_mute.toggled.connect(self._on_mute_toggled)
        hl_play.addWidget(self.cb_mute)
        hl_play.addStretch()
        v_range.addLayout(hl_play)
        v_video.addWidget(gb_range)

        gb_ext = QGroupBox("抽取到全局库")
        form_e = QFormLayout(gb_ext)
        self.sp_fps = QDoubleSpinBox()
        self.sp_fps.setDecimals(2)
        self.sp_fps.setRange(0.5, 120)
        self.sp_fps.setValue(12)
        self.sp_fps.setToolTip("写入导出 anim.json 的 frameRate；抽帧张数由「抽取帧数」决定，不再用 FPS 算张数。")
        form_e.addRow("导出动画 frameRate", self.sp_fps)
        self.sp_max_frames = QSpinBox()
        self.sp_max_frames.setRange(1, 9999)
        self.sp_max_frames.setValue(12)
        self.sp_max_frames.setToolTip("在区间 t0～t1 内按帧均匀抽取这么多张（与导出 frameRate 无关）。")
        form_e.addRow("抽取帧数（t0～t1 均匀）", self.sp_max_frames)
        self.btn_append_extract = QPushButton("追加抽取当前区间到全局库")
        self.btn_append_extract.setToolTip("不覆盖已有帧；可反复打开不同视频继续追加。")
        self.btn_append_extract.setEnabled(False)
        self.btn_append_extract.clicked.connect(self._append_extract_to_library)
        form_e.addRow(self.btn_append_extract)
        v_video.addWidget(gb_ext)
        v_video.addStretch(1)

        gb_chroma = QGroupBox("色键（抽取与导出；下方为抠图预览）")
        self._gb_chroma = gb_chroma
        form_c = QFormLayout(gb_chroma)
        self.cb_chroma = QCheckBox("启用色键（抽取/导出时按下方关键色与容差抠图）")
        self.cb_chroma.setToolTip("必须勾选此项，追加抽取才会写入透明背景；仅调容差而不勾选不会抠图。")
        self.cb_chroma.toggled.connect(self._schedule_chroma_preview)
        form_c.addRow(self.cb_chroma)
        hl_key = QHBoxLayout()
        self._lbl_chroma_swatch = QLabel()
        self._lbl_chroma_swatch.setFixedSize(40, 22)
        self._lbl_chroma_swatch.setToolTip("当前关键色（RGB）")
        self._lbl_chroma_rgb_text = QLabel("255, 255, 255")
        self._lbl_chroma_rgb_text.setStyleSheet("color:#ccc;")
        self._lbl_chroma_rgb_text.setMinimumWidth(88)
        btn_chroma_dialog = QPushButton("选择颜色…")
        btn_chroma_dialog.setToolTip("打开系统取色窗口（可用滴管从屏幕任意处取色，含右侧视频画面）")
        btn_chroma_dialog.clicked.connect(self._on_chroma_color_dialog)
        self.btn_chroma_drop = QPushButton("从原图吸色")
        self.btn_chroma_drop.setCheckable(True)
        self.btn_chroma_drop.setToolTip("开启后，在下方「原图」预览上单击即可采样该像素为关键色")
        self.btn_chroma_drop.toggled.connect(self._on_chroma_drop_toggled)
        hl_key.addWidget(self._lbl_chroma_swatch, 0)
        hl_key.addWidget(self._lbl_chroma_rgb_text, 0)
        hl_key.addWidget(btn_chroma_dialog, 0)
        hl_key.addWidget(self.btn_chroma_drop, 0)
        hl_key.addStretch(1)
        form_c.addRow("关键色", hl_key)
        self.sp_chroma_tol = QDoubleSpinBox()
        self.sp_chroma_tol.setRange(1, 255)
        self.sp_chroma_tol.setValue(40)
        form_c.addRow("容差", self.sp_chroma_tol)
        self.cmb_chroma_sample = QComboBox()
        self.cmb_chroma_sample.addItem("播放器当前时刻", "playhead")
        self.cmb_chroma_sample.addItem("区间左端 t0", "t0")
        self.cmb_chroma_sample.addItem("区间中点", "mid")
        self.cmb_chroma_sample.addItem("区间右端 t1", "t1")
        self.cmb_chroma_sample.setToolTip(
            "选「播放器当前时刻」时：暂停或拖进度后才会刷新色键预览；"
            "播放中不刷新，以免 OpenCV 与右侧解码抢资源导致卡顿。"
        )
        form_c.addRow("预览采样时刻", self.cmb_chroma_sample)
        for w in (
            self.sp_chroma_tol,
            self.cmb_chroma_sample,
        ):
            if isinstance(w, QSpinBox):
                w.valueChanged.connect(lambda *_: self._schedule_chroma_preview())
            elif isinstance(w, QDoubleSpinBox):
                w.valueChanged.connect(lambda *_: self._schedule_chroma_preview())
            else:
                w.currentIndexChanged.connect(self._schedule_chroma_preview)

        hl_prev = QHBoxLayout()
        self.lbl_chroma_orig = QLabel("原图")
        self.lbl_chroma_orig.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_chroma_orig.setStyleSheet("background:#1a1a1a;border:1px solid #444;")
        self.lbl_chroma_orig.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        self.lbl_chroma_orig.setFixedSize(_CHROMA_ORIG_MIN_W, _CHROMA_ORIG_MIN_H)
        self.lbl_chroma_keyed = QLabel("色键结果（棋盘底）")
        self.lbl_chroma_keyed.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_chroma_keyed.setStyleSheet("background:#1a1a1a;border:1px solid #444;")
        self.lbl_chroma_keyed.setSizePolicy(
            QSizePolicy.Policy.Expanding, QSizePolicy.Policy.MinimumExpanding
        )
        self.lbl_chroma_keyed.setMinimumSize(_CHROMA_KEYED_MIN_W, _CHROMA_KEYED_MIN_H)
        self.lbl_chroma_orig.setScaledContents(False)
        self.lbl_chroma_keyed.setScaledContents(False)
        self.lbl_chroma_orig.installEventFilter(self)
        hl_prev.addWidget(self.lbl_chroma_orig, 0)
        hl_prev.addWidget(self.lbl_chroma_keyed, 1)
        form_c.addRow(hl_prev)
        self._apply_chroma_key_rgb_ui()
        v_chroma.addWidget(gb_chroma)

        gb_lib = QGroupBox("全局帧库")
        v_lib = QVBoxLayout(gb_lib)
        self.lbl_lib_count = QLabel("共 0 帧")
        v_lib.addWidget(self.lbl_lib_count)
        self.lbl_lib_shortcuts = QLabel(
            "选范围：Ctrl+左键 首帧 · Alt+左键 尾帧（尾须在首之后，否则无效）"
        )
        self.lbl_lib_shortcuts.setWordWrap(True)
        self.lbl_lib_shortcuts.setStyleSheet("color:#888;font-size:12px;")
        v_lib.addWidget(self.lbl_lib_shortcuts)
        self._library_scroll = QScrollArea()
        self._library_scroll.setMinimumHeight(220)
        self._library_scroll.setWidgetResizable(True)
        self._library_inner = QWidget()
        self._library_grid = QGridLayout(self._library_inner)
        self._library_grid.setSpacing(6)
        self._library_scroll.setWidget(self._library_inner)
        v_lib.addWidget(self._library_scroll)
        hl_sel = QHBoxLayout()
        hl_sel.addWidget(QLabel("范围首索引"))
        self.sp_lib_i0 = QSpinBox()
        self.sp_lib_i0.setRange(0, 0)
        hl_sel.addWidget(self.sp_lib_i0)
        hl_sel.addWidget(QLabel("尾索引"))
        self.sp_lib_i1 = QSpinBox()
        self.sp_lib_i1.setRange(0, 0)
        hl_sel.addWidget(self.sp_lib_i1)
        self.sp_lib_i0.valueChanged.connect(self._on_lib_range_spin_changed)
        self.sp_lib_i1.valueChanged.connect(self._on_lib_range_spin_changed)
        hl_sel.addStretch()
        v_lib.addLayout(hl_sel)
        self.btn_lib_remove = QPushButton("删除库中索引范围（含端点）")
        self.btn_lib_remove.clicked.connect(self._remove_library_range)
        v_lib.addWidget(self.btn_lib_remove)
        v_chroma.addWidget(gb_lib)

        gb_lo = QGroupBox("库内首尾蒙版对比（选尾帧）")
        v_lo = QVBoxLayout(gb_lo)
        hl_oi = QHBoxLayout()
        hl_oi.addWidget(QLabel("首帧库索引"))
        self.sp_lo_head = QSpinBox()
        self.sp_lo_head.setRange(0, 0)
        self.sp_lo_head.valueChanged.connect(self._refresh_lib_onion_blend)
        hl_oi.addWidget(self.sp_lo_head)
        hl_oi.addWidget(QLabel("尾帧库索引"))
        self.sp_lo_tail = QSpinBox()
        self.sp_lo_tail.setRange(0, 0)
        self.sp_lo_tail.valueChanged.connect(self._refresh_lib_onion_blend)
        hl_oi.addWidget(self.sp_lo_tail)
        self.sp_lo_opacity = QDoubleSpinBox()
        self.sp_lo_opacity.setRange(0.1, 0.95)
        self.sp_lo_opacity.setDecimals(2)
        self.sp_lo_opacity.setValue(0.45)
        self.sp_lo_opacity.valueChanged.connect(self._refresh_lib_onion_blend)
        hl_oi.addWidget(QLabel("首帧权重"))
        hl_oi.addWidget(self.sp_lo_opacity)
        hl_oi.addStretch()
        v_lo.addLayout(hl_oi)
        self._lib_onion_panel = QWidget()
        lob = QVBoxLayout(self._lib_onion_panel)
        self._lbl_lib_onion_hint = QLabel(
            "混合预览：与上方「首/尾帧库索引」一致；在全局库用 Ctrl/Alt+左键 选帧后会刷新。"
        )
        self._lbl_lib_onion_hint.setWordWrap(True)
        self._lbl_lib_onion_hint.setStyleSheet("color:#888;font-size:12px;")
        lob.addWidget(self._lbl_lib_onion_hint)
        self._lbl_lib_onion = QLabel()
        self._lbl_lib_onion.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._lbl_lib_onion.setStyleSheet("background:#111;border:1px solid #333;")
        self._lbl_lib_onion.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        lob.addWidget(self._lbl_lib_onion, 0)
        v_lo.addWidget(self._lib_onion_panel)
        v_chroma.addWidget(gb_lo)
        v_chroma.addStretch(1)

        gb_anim = QGroupBox("动画序列")
        v_an = QVBoxLayout(gb_anim)
        hl_ac = QHBoxLayout()
        self.btn_clip_new = QPushButton("新建动画…")
        self.btn_clip_new.clicked.connect(self._clip_new)
        hl_ac.addWidget(self.btn_clip_new)
        self.btn_clip_del = QPushButton("删除当前动画")
        self.btn_clip_del.clicked.connect(self._clip_delete)
        hl_ac.addWidget(self.btn_clip_del)
        hl_ac.addStretch()
        v_an.addLayout(hl_ac)
        self.list_clips = QListWidget()
        self.list_clips.setMinimumHeight(88)
        self.list_clips.setMaximumHeight(200)
        self.list_clips.currentItemChanged.connect(self._on_clip_selection_changed)
        v_an.addWidget(self.list_clips)
        form_clip = QFormLayout()
        self.sp_clip_fps = QDoubleSpinBox()
        self.sp_clip_fps.setRange(0.5, 120)
        self.sp_clip_fps.setDecimals(2)
        self.sp_clip_fps.setValue(12)
        self.sp_clip_fps.valueChanged.connect(self._on_clip_props_changed)
        form_clip.addRow("帧率", self.sp_clip_fps)
        self.cb_clip_loop = QCheckBox("循环")
        self.cb_clip_loop.setChecked(True)
        self.cb_clip_loop.toggled.connect(self._on_clip_props_changed)
        form_clip.addRow(self.cb_clip_loop)
        v_an.addLayout(form_clip)
        hl_add = QHBoxLayout()
        self.btn_clip_add_range = QPushButton("将库范围加入当前动画")
        self.btn_clip_add_range.clicked.connect(self._clip_add_library_range)
        hl_add.addWidget(self.btn_clip_add_range)
        self.btn_clip_create_from_range = QPushButton("用库范围新建动画")
        self.btn_clip_create_from_range.clicked.connect(self._clip_create_from_library_range)
        hl_add.addWidget(self.btn_clip_create_from_range)
        hl_add.addStretch()
        v_an.addLayout(hl_add)
        self.list_clip_frames = QListWidget()
        self.list_clip_frames.setMinimumHeight(112)
        self.list_clip_frames.setMaximumHeight(260)
        self.list_clip_frames.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        v_an.addWidget(QLabel("当前动画帧列表（有序）"))
        v_an.addWidget(self.list_clip_frames)
        hl_cf = QHBoxLayout()
        self.btn_clip_rm_frames = QPushButton("删除所选帧项")
        self.btn_clip_rm_frames.clicked.connect(self._clip_remove_selected_frames)
        hl_cf.addWidget(self.btn_clip_rm_frames)
        self.btn_clip_up = QPushButton("上移")
        self.btn_clip_up.clicked.connect(lambda: self._clip_move_selected(-1))
        hl_cf.addWidget(self.btn_clip_up)
        self.btn_clip_dn = QPushButton("下移")
        self.btn_clip_dn.clicked.connect(lambda: self._clip_move_selected(1))
        hl_cf.addWidget(self.btn_clip_dn)
        hl_cf.addStretch()
        v_an.addLayout(hl_cf)
        self.lbl_clip_preview = QLabel("动画预览")
        self.lbl_clip_preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_clip_preview.setStyleSheet("background:#222;border:1px solid #444;color:#888;")
        self.lbl_clip_preview.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        self.lbl_clip_preview.setFixedSize(_CLIP_PREVIEW_MIN_W, _CLIP_PREVIEW_MIN_W)
        v_an.addWidget(self.lbl_clip_preview)
        hl_pv = QHBoxLayout()
        self.btn_clip_preview_play = QPushButton("播放预览")
        self.btn_clip_preview_play.setCheckable(True)
        self.btn_clip_preview_play.toggled.connect(self._toggle_clip_preview)
        hl_pv.addWidget(self.btn_clip_preview_play)
        hl_pv.addStretch()
        v_an.addLayout(hl_pv)
        v_anim.addWidget(gb_anim)

        gb_out = QGroupBox("导出（native 等大单元格图集）")
        form_o = QFormLayout(gb_out)
        self.sp_pad = QSpinBox()
        self.sp_pad.setRange(0, 128)
        self.sp_pad.setValue(4)
        form_o.addRow("单元格内边距", self.sp_pad)
        self.edit_sprite_path = QLineEdit("/assets/images/characters/out_atlas.png")
        form_o.addRow("spritesheet 路径", self.edit_sprite_path)
        self.cmb_world_size_mode = QComboBox()
        self.cmb_world_size_mode.addItem("按宽度（只写 worldWidth）", 0)
        self.cmb_world_size_mode.addItem("按高度（只写 worldHeight）", 1)
        self.cmb_world_size_mode.addItem("同时写宽高（高级）", 2)
        self.cmb_world_size_mode.setCurrentIndex(0)
        self.cmb_world_size_mode.currentIndexChanged.connect(self._on_world_export_mode_changed)
        form_o.addRow("世界尺寸", self.cmb_world_size_mode)
        self.sp_world_w = QSpinBox()
        self.sp_world_w.setRange(1, 9999)
        self.sp_world_w.setValue(100)
        self.sp_world_h = QSpinBox()
        self.sp_world_h.setRange(1, 9999)
        self.sp_world_h.setValue(160)
        form_o.addRow("worldWidth", self.sp_world_w)
        form_o.addRow("worldHeight", self.sp_world_h)
        self._on_world_export_mode_changed(0)
        self.cmb_index_base = QComboBox()
        self.cmb_index_base.addItem("帧编号从 0 开始", 0)
        self.cmb_index_base.addItem("帧编号从 1 开始", 1)
        self.cmb_index_base.setCurrentIndex(1)
        form_o.addRow("帧索引基准", self.cmb_index_base)
        self.cb_save_meta = QCheckBox("同时写出 .meta.json")
        self.cb_save_meta.setChecked(True)
        form_o.addRow(self.cb_save_meta)
        self.cb_merge_dedup = QCheckBox("合并导出时复用相同帧（按帧 id 去重占格）")
        self.cb_merge_dedup.setChecked(True)
        form_o.addRow(self.cb_merge_dedup)
        self.btn_export_clip = QPushButton("导出当前动画…")
        self.btn_export_clip.clicked.connect(self._export_current_clip)
        form_o.addRow(self.btn_export_clip)
        self.btn_export_merge = QPushButton("合并导出全部动画…")
        self.btn_export_merge.clicked.connect(self._export_merge_all)
        v_anim.addWidget(gb_out)

        self.lbl_status = QLabel("")
        self.lbl_status.setWordWrap(True)
        v_anim.addWidget(self.lbl_status)
        v_anim.addStretch(1)

        gb_imp = QGroupBox("从导出读入（meta.json + 图集 PNG）")
        v_imp = QVBoxLayout(gb_imp)
        hl_m = QHBoxLayout()
        self.edit_import_meta = QLineEdit()
        self.edit_import_meta.setPlaceholderText("*.meta.json")
        self.btn_import_meta = QPushButton("浏览…")
        self.btn_import_meta.clicked.connect(self._browse_import_meta)
        hl_m.addWidget(self.edit_import_meta, 1)
        hl_m.addWidget(self.btn_import_meta, 0)
        v_imp.addLayout(hl_m)
        hl_p = QHBoxLayout()
        self.edit_import_png = QLineEdit()
        self.edit_import_png.setPlaceholderText("与导出同名的图集 PNG")
        self.btn_import_png = QPushButton("浏览…")
        self.btn_import_png.clicked.connect(self._browse_import_png)
        hl_p.addWidget(self.edit_import_png, 1)
        hl_p.addWidget(self.btn_import_png, 0)
        v_imp.addLayout(hl_p)
        self.btn_import_apply = QPushButton("读入到全局帧库（替换当前库与动画列表）")
        self.btn_import_apply.setToolTip(
            "按 meta 的 cols/rows/cell 裁切图集；覆盖内存中的帧库并新建动画「imported」含全部帧。"
        )
        self.btn_import_apply.clicked.connect(self._import_atlas_from_export)
        v_imp.addWidget(self.btn_import_apply)
        self.lbl_import_summary = QLabel("未读入")
        self.lbl_import_summary.setWordWrap(True)
        self.lbl_import_summary.setStyleSheet("color:#888;font-size:12px;")
        v_imp.addWidget(self.lbl_import_summary)
        v_atlas.addWidget(gb_imp)

        gb_batch = QGroupBox("批处理（对当前全局库中的每一帧）")
        f_batch = QFormLayout(gb_batch)
        self.btn_batch_flip_h = QPushButton("全部水平翻转")
        self.btn_batch_flip_h.setToolTip("左右镜像，含 alpha。")
        self.btn_batch_flip_h.clicked.connect(self._batch_flip_all_frames)
        f_batch.addRow(self.btn_batch_flip_h)
        self.sp_batch_scale = QDoubleSpinBox()
        self.sp_batch_scale.setRange(0.05, 4.0)
        self.sp_batch_scale.setDecimals(3)
        self.sp_batch_scale.setValue(0.5)
        self.sp_batch_scale.setToolTip("宽高同乘该系数；小于 1 缩小，大于 1 放大。")
        hl_bs = QHBoxLayout()
        hl_bs.addWidget(self.sp_batch_scale)
        self.btn_batch_scale = QPushButton("对全部帧应用缩放")
        self.btn_batch_scale.clicked.connect(self._batch_scale_all_frames)
        hl_bs.addWidget(self.btn_batch_scale)
        hl_bs.addStretch()
        f_batch.addRow("缩放比例", hl_bs)
        v_atlas.addWidget(gb_batch)

        gb_one = QGroupBox("单帧处理（全局库索引，与帧库网格序号一致）")
        f_one = QFormLayout(gb_one)
        self.sp_atlas_one_idx = QSpinBox()
        self.sp_atlas_one_idx.setRange(0, 0)
        f_one.addRow("库索引", self.sp_atlas_one_idx)
        hl_one = QHBoxLayout()
        self.btn_one_flip = QPushButton("水平翻转该帧")
        self.btn_one_flip.clicked.connect(self._single_atlas_frame_flip)
        self.btn_one_scale = QPushButton("缩放该帧")
        self.btn_one_scale.clicked.connect(self._single_atlas_frame_scale)
        hl_one.addWidget(self.btn_one_flip)
        hl_one.addWidget(self.btn_one_scale)
        hl_one.addStretch()
        f_one.addRow(hl_one)
        v_atlas.addWidget(gb_one)
        v_atlas.addStretch(1)

        right = QWidget()
        rl = QVBoxLayout(right)
        self.video_widget = QVideoWidget()
        self.video_widget.setMinimumSize(240, 160)
        self.video_widget.setMaximumHeight(280)
        self.video_widget.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Maximum)
        self.video_widget.setStyleSheet("background:#111;")
        self._player.setVideoOutput(self.video_widget)
        rl.addWidget(self.video_widget, stretch=0, alignment=Qt.AlignmentFlag.AlignTop)
        rl.addStretch(1)
        self.lbl_main_hint = QLabel("右侧为源视频（较小即可）；左侧色键「结果」预览较大便于看抠像边缘。")
        self.lbl_main_hint.setWordWrap(True)
        self.lbl_main_hint.setAlignment(Qt.AlignmentFlag.AlignTop)
        self.lbl_main_hint.setStyleSheet("color:#888;")
        rl.addWidget(self.lbl_main_hint, stretch=0, alignment=Qt.AlignmentFlag.AlignTop)
        splitter.addWidget(right)
        self.setMinimumSize(1100, 740)
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([820, 580])

    def resizeEvent(self, event: QResizeEvent) -> None:
        super().resizeEvent(event)
        self._schedule_chroma_preview()

    def _on_world_export_mode_changed(self, _idx: int) -> None:
        mode = int(self.cmb_world_size_mode.currentData())
        self.sp_world_w.setEnabled(mode in (0, 2))
        self.sp_world_h.setEnabled(mode in (1, 2))

    def _export_world_wh(self) -> tuple[Optional[float], Optional[float]]:
        mode = int(self.cmb_world_size_mode.currentData())
        ww = float(self.sp_world_w.value())
        wh = float(self.sp_world_h.value())
        if mode == 0:
            return ww, None
        if mode == 1:
            return None, wh
        return ww, wh

    def _chroma_params(self) -> tuple[bool, tuple[int, int, int], float]:
        return (
            self.cb_chroma.isChecked(),
            self._chroma_key_rgb,
            float(self.sp_chroma_tol.value()),
        )

    def _apply_chroma_key_rgb_ui(self) -> None:
        r, g, b = self._chroma_key_rgb
        self._lbl_chroma_swatch.setStyleSheet(
            f"background-color: rgb({r},{g},{b}); border: 1px solid #666;"
        )
        self._lbl_chroma_rgb_text.setText(f"{r}, {g}, {b}")

    def _set_chroma_key_rgb(
        self,
        rgb: Tuple[int, int, int],
        *,
        schedule_preview: bool = True,
    ) -> None:
        r, g, b = rgb
        self._chroma_key_rgb = (
            max(0, min(255, int(r))),
            max(0, min(255, int(g))),
            max(0, min(255, int(b))),
        )
        self._apply_chroma_key_rgb_ui()
        if schedule_preview:
            self._schedule_chroma_preview()

    def _on_chroma_color_dialog(self) -> None:
        if self.btn_chroma_drop.isChecked():
            self.btn_chroma_drop.setChecked(False)
        r, g, b = self._chroma_key_rgb
        c = QColorDialog.getColor(QColor(r, g, b), self, "关键色")
        if c.isValid():
            self._set_chroma_key_rgb((c.red(), c.green(), c.blue()))

    def _on_chroma_drop_toggled(self, on: bool) -> None:
        self._chroma_pick_from_orig = on
        self.lbl_chroma_orig.setCursor(
            Qt.CursorShape.CrossCursor if on else Qt.CursorShape.ArrowCursor
        )

    def _chroma_orig_pixel_from_label_pos(self, pos) -> Optional[Tuple[int, int, int]]:
        if self._chroma_orig_bgr is None:
            return None
        pm = self.lbl_chroma_orig.pixmap()
        if pm is None or pm.isNull():
            return None
        iw = int(self._chroma_orig_bgr.shape[1])
        ih = int(self._chroma_orig_bgr.shape[0])
        pw = int(pm.width())
        ph = int(pm.height())
        lw = int(self.lbl_chroma_orig.width())
        lh = int(self.lbl_chroma_orig.height())
        x0 = (lw - pw) // 2
        y0 = (lh - ph) // 2
        x = int(pos.x()) - x0
        y = int(pos.y()) - y0
        if x < 0 or y < 0 or x >= pw or y >= ph:
            return None
        ix = int(round(x * iw / max(1, pw)))
        iy = int(round(y * ih / max(1, ph)))
        ix = max(0, min(iw - 1, ix))
        iy = max(0, min(ih - 1, iy))
        b0, g0, r0 = self._chroma_orig_bgr[iy, ix]
        return int(r0), int(g0), int(b0)

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:
        if watched is self.lbl_chroma_orig and self._chroma_pick_from_orig:
            if event.type() == QEvent.Type.MouseButtonPress and isinstance(event, QMouseEvent):
                if event.button() == Qt.MouseButton.LeftButton:
                    rgb = self._chroma_orig_pixel_from_label_pos(event.pos())
                    if rgb is not None:
                        self._set_chroma_key_rgb(rgb)
                    self.btn_chroma_drop.setChecked(False)
                    return True
        return super().eventFilter(watched, event)

    def _schedule_chroma_preview(self) -> None:
        self._chroma_debounce.start()

    def _chroma_sample_t_sec(self) -> Optional[float]:
        if not self._video_path:
            return None
        mode = self.cmb_chroma_sample.currentData()
        t0, t1 = self._t0_t1()
        mid = (t0 + t1) * 0.5
        if mode == "playhead":
            return max(0.0, self._player.position() / 1000.0)
        if mode == "t0":
            return t0
        if mode == "t1":
            return t1
        return mid

    def _on_player_position_changed(self, _pos: int) -> None:
        # 播放中勿随 positionChanged 做 OpenCV 解码：会与 QMediaPlayer 抢主线程，导致画面一卡一卡。
        if self.cmb_chroma_sample.currentData() != "playhead":
            return
        if self._player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
            return
        self._schedule_chroma_preview()

    def _chroma_preview_dims(self) -> tuple[tuple[int, int], tuple[int, int]]:
        inner = max(80, self._gb_chroma.width() - 36)
        gap = 10
        avail = max(_CHROMA_ORIG_MIN_W + _CHROMA_KEYED_MIN_W, inner - gap)
        ow = max(_CHROMA_ORIG_MIN_W, min(_CHROMA_ORIG_MAX_W, int(avail * 0.28)))
        kw = avail - ow - gap
        kw = max(_CHROMA_KEYED_MIN_W, min(_CHROMA_KEYED_MAX_W, kw))
        if ow + kw + gap > avail:
            ow = max(_CHROMA_ORIG_MIN_W, min(_CHROMA_ORIG_MAX_W, avail - gap - kw))
        lh = int(self.lbl_chroma_keyed.height())
        kh = _CHROMA_KEYED_MAX_H
        if lh >= _CHROMA_KEYED_MIN_H + 8:
            kh = min(_CHROMA_KEYED_MAX_H, max(_CHROMA_KEYED_MIN_H, lh - 4))
        return (ow, _CHROMA_ORIG_MAX_H), (kw, kh)

    def _run_chroma_preview(self) -> None:
        t = self._chroma_sample_t_sec()
        if t is None or not self._video_path:
            self._chroma_orig_bgr = None
            self.lbl_chroma_orig.clear()
            self.lbl_chroma_keyed.clear()
            self.lbl_chroma_orig.setText("原图")
            self.lbl_chroma_keyed.setText("色键结果")
            self.lbl_chroma_orig.setFixedSize(_CHROMA_ORIG_MIN_W, _CHROMA_ORIG_MIN_H)
            self.lbl_chroma_keyed.setMinimumSize(_CHROMA_KEYED_MIN_W, _CHROMA_KEYED_MIN_H)
            self.lbl_chroma_keyed.setMaximumSize(16777215, 16777215)
            return
        cap = cv2.VideoCapture(self._video_path)
        if not cap.isOpened():
            self._chroma_orig_bgr = None
            return
        cap.set(cv2.CAP_PROP_POS_MSEC, float(t * 1000.0))
        ret, bgr = cap.read()
        cap.release()
        if not ret or bgr is None:
            self._chroma_orig_bgr = None
            return
        self._chroma_orig_bgr = bgr.copy()
        ce, rgb, tol = self._chroma_params()
        po = _bgr_to_qpixmap(bgr)
        (ow, oh), (kw, kh) = self._chroma_preview_dims()
        so = po.scaled(ow, oh, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.FastTransformation)
        self.lbl_chroma_orig.setPixmap(so)
        self.lbl_chroma_orig.setFixedSize(so.size())
        bgra = bgr_to_rgba_frame(bgr, ce, rgb, tol)
        comp = composite_checkerboard_bgra(bgra)
        pk = _bgr_to_qpixmap(comp)
        sk = pk.scaled(kw, kh, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        self.lbl_chroma_keyed.setPixmap(sk)
        self.lbl_chroma_keyed.setMinimumSize(sk.size())
        self.lbl_chroma_keyed.setMaximumSize(16777215, 16777215)

    def _on_mute_toggled(self, on: bool) -> None:
        self._audio.setVolume(0.0 if on else 1.0)

    def _on_player_error(self, error, error_string: str) -> None:
        del error
        QMessageBox.warning(self, "播放器", error_string or "无法播放该媒体")

    def _on_player_duration_changed(self, duration_ms: int) -> None:
        if duration_ms <= 0:
            return
        d = duration_ms / 1000.0
        self._duration_sec = d
        self.range_bar.set_duration_sec(d)
        t0, t1 = self.range_bar.range_sec()
        if t1 > d or t0 > d:
            self.range_bar.set_range_sec(0.0, max(d, 0.02), emit=False)
        self._update_range_label()

    def _on_playback_state_changed(self, state: QMediaPlayer.PlaybackState) -> None:
        if state == QMediaPlayer.PlaybackState.PlayingState:
            self.btn_play.setText("暂停")
            self._sync_range_poll_timer()
        else:
            self.btn_play.setText("播放")
            self._loop_poll_timer.stop()
            if self.cmb_chroma_sample.currentData() == "playhead":
                self._schedule_chroma_preview()

    def _toggle_play(self) -> None:
        if not self._video_path:
            QMessageBox.information(self, "提示", "请先打开视频")
            return
        if self._player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
            self._player.pause()
            self._loop_poll_timer.stop()
            return
        t0, t1 = self._t0_t1()
        if t1 > t0:
            self._loop_seek_guard = True
            self._player.setPosition(int(t0 * 1000))
            self._loop_seek_guard = False
        self._player.play()

    def _sync_range_poll_timer(self) -> None:
        if self._player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
            self._loop_poll_timer.start()
        else:
            self._loop_poll_timer.stop()

    def _on_loop_mode_toggled(self, _checked: bool) -> None:
        self._clamp_playhead_to_range()
        self._sync_range_poll_timer()

    def _clamp_playhead_to_range(self) -> None:
        """区间拖动或循环模式切换时立即把播放头约束在 [t0,t1] 内。"""
        if not self._video_path:
            return
        t0, t1 = self._t0_t1()
        if t1 <= t0:
            return
        t0_ms = int(t0 * 1000)
        t1_ms = int(t1 * 1000)
        pos = self._player.position()
        playing = self._player.playbackState() == QMediaPlayer.PlaybackState.PlayingState
        self._loop_seek_guard = True
        if pos < t0_ms:
            self._player.setPosition(t0_ms)
        elif pos > t1_ms:
            if self.cb_loop_segment.isChecked():
                self._player.setPosition(t0_ms)
            else:
                self._player.setPosition(t1_ms)
                if playing:
                    self._player.pause()
        self._loop_seek_guard = False

    def _tick_playback_range(self) -> None:
        if self._loop_seek_guard:
            return
        if not self._video_path:
            return
        if self._player.playbackState() != QMediaPlayer.PlaybackState.PlayingState:
            return
        t0, t1 = self._t0_t1()
        if t1 <= t0:
            return
        t0_ms = int(t0 * 1000)
        t1_ms = int(t1 * 1000)
        span_ms = max(1, t1_ms - t0_ms)
        pos = self._player.position()
        fp_ms = 1000.0 / max(self._source_fps, 1.0)
        raw_lead = int(min(120.0, max(20.0, fp_ms * 1.75)))
        lead_ms = min(raw_lead, max(15, span_ms - 40))

        if pos < t0_ms:
            self._loop_seek_guard = True
            self._player.setPosition(t0_ms)
            release_ms = min(100, max(20, span_ms // 3))
            QTimer.singleShot(release_ms, self._release_loop_seek_guard)
            return

        boundary_at = t1_ms - lead_ms
        if boundary_at <= t0_ms:
            boundary_at = t0_ms + max(1, span_ms // 4)

        if self.cb_loop_segment.isChecked():
            if pos >= boundary_at:
                self._loop_seek_guard = True
                self._player.setPosition(t0_ms)
                release_ms = min(100, max(20, span_ms // 3))
                QTimer.singleShot(release_ms, self._release_loop_seek_guard)
        else:
            if pos >= boundary_at:
                self._loop_seek_guard = True
                self._player.setPosition(t1_ms)
                self._player.pause()
                release_ms = min(100, max(20, span_ms // 3))
                QTimer.singleShot(release_ms, self._release_loop_seek_guard)

    def _on_loop_range_changed(self, _t0: float, _t1: float) -> None:
        self._update_range_label()
        self._schedule_chroma_preview()
        self._clamp_playhead_to_range()

    def _release_loop_seek_guard(self) -> None:
        self._loop_seek_guard = False

    def _update_range_label(self) -> None:
        t0, t1 = self.range_bar.range_sec()
        self.lbl_range.setText(
            f"t0: {t0:.3f} s    ·    t1: {t1:.3f} s    ·    总长 {self._duration_sec:.3f} s"
        )

    def _t0_t1(self) -> tuple[float, float]:
        t0, t1 = self.range_bar.range_sec()
        if t1 < t0:
            t0, t1 = t1, t0
        return t0, t1

    def _make_decode_config(self) -> BuildConfig:
        t0, t1 = self._t0_t1()
        ce, rgb, tol = self._chroma_params()
        return BuildConfig(
            t0_sec=t0,
            t1_sec=t1,
            target_fps=float(self.sp_fps.value()),
            cell_w=256,
            cell_h=256,
            cols=0,
            rows=0,
            padding=int(self.sp_pad.value()),
            chroma_enabled=ce,
            chroma_rgb=rgb,
            chroma_tolerance=tol,
            max_frames=int(self.sp_max_frames.value()),
            frame_index_base=int(self.cmb_index_base.currentData()),
        )

    def closeEvent(self, event) -> None:
        self._loop_poll_timer.stop()
        self._clip_preview_timer.stop()
        self._player.stop()
        super().closeEvent(event)

    def _open_video(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self,
            "选择视频",
            "",
            "视频 (*.mp4 *.webm *.mov *.avi *.mkv);;所有文件 (*)",
        )
        if not path:
            return
        self._player.stop()
        abs_path = str(Path(path).resolve())
        self._video_path = abs_path
        self._player.setSource(QUrl.fromLocalFile(abs_path))

        dur = 1.0
        fps = 30.0
        cap = cv2.VideoCapture(abs_path)
        if cap.isOpened():
            fps = float(cap.get(cv2.CAP_PROP_FPS) or 30)
            fc = float(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            if fps > 0:
                dur = max(0.1, fc / fps)
            cap.release()

        self._source_fps = max(1.0, fps)
        self._duration_sec = dur
        self.range_bar.set_duration_sec(dur)
        self.range_bar.set_range_sec(0.0, dur, emit=False)
        self._update_range_label()

        self.lbl_video.setText(f"{abs_path}\n时长约 {dur:.2f}s · OpenCV 估计 FPS {fps:.2f}")
        self.lbl_status.setText("已加载：设区间后可追加抽取到全局库。")
        self.btn_append_extract.setEnabled(True)
        QTimer.singleShot(200, self._schedule_chroma_preview)

    def _append_extract_to_library(self) -> None:
        if not self._video_path:
            QMessageBox.information(self, "提示", "请先打开视频")
            return
        cfg = self._make_decode_config()
        try:
            rgba, times = decode_segment_rgba_frames(
                self._video_path,
                cfg.t0_sec,
                cfg.t1_sec,
                cfg.target_fps,
                cfg.max_frames,
                cfg.chroma_enabled,
                cfg.chroma_rgb,
                cfg.chroma_tolerance,
            )
        except Exception as e:
            QMessageBox.critical(self, "提取失败", str(e))
            return
        if not rgba:
            QMessageBox.warning(self, "提示", "未解码到任何帧")
            return
        self._project.append_decoded(rgba, times, self._video_path)
        self._refresh_library_ui()
        self.lbl_status.setText(f"已追加 {len(rgba)} 帧；库中共 {len(self._project.frames)} 帧。")

    @staticmethod
    def _default_png_beside_meta(meta_path: Path) -> Path:
        stem = meta_path.stem
        if stem.endswith(".meta"):
            stem = stem[: -len(".meta")]
        return meta_path.with_name(stem + ".png")

    def _browse_import_meta(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self,
            "选择 meta.json",
            str(Path.cwd()),
            "JSON (*.json);;All (*.*)",
        )
        if path:
            mp = Path(path)
            self.edit_import_meta.setText(str(mp.resolve()))
            guess = self._default_png_beside_meta(mp)
            if guess.is_file():
                self.edit_import_png.setText(str(guess.resolve()))

    def _browse_import_png(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self,
            "选择图集 PNG",
            str(Path.cwd()),
            "PNG (*.png);;All (*.*)",
        )
        if path:
            self.edit_import_png.setText(str(Path(path).resolve()))

    def _import_atlas_from_export(self) -> None:
        mt = self.edit_import_meta.text().strip()
        pt = self.edit_import_png.text().strip()
        if not mt or not pt:
            QMessageBox.warning(self, "读入", "请填写 meta.json 与图集 PNG 路径。")
            return
        mp = Path(mt)
        pp = Path(pt)
        if not mp.is_file():
            QMessageBox.warning(self, "读入", f"找不到 meta：{mp}")
            return
        if not pp.is_file():
            QMessageBox.warning(self, "读入", f"找不到图集：{pp}")
            return
        try:
            meta = json.loads(mp.read_text(encoding="utf-8"))
            im = Image.open(pp).convert("RGBA")
            bgras, times = meta_atlas_to_bgra_frames(meta, im)
        except Exception as e:
            QMessageBox.critical(self, "读入失败", str(e))
            return
        self._project.frames.clear()
        self._project.clips.clear()
        src = str(pp.resolve())
        for bgra, t in zip(bgras, times):
            self._project.frames.append(
                FrameItem(id=new_id(), rgba=bgra, source_path=src, t_sec=float(t))
            )
        clip = make_animation_clip(
            "imported",
            float(meta.get("exportFps", 12.0)),
            True,
        )
        clip.frame_ids = [f.id for f in self._project.frames]
        self._project.clips.append(clip)
        self.sp_clip_fps.setValue(float(meta.get("exportFps", self.sp_clip_fps.value())))
        base = int(meta.get("frameIndexBase", 1))
        self.cmb_index_base.setCurrentIndex(0 if base == 0 else 1)
        summ = (
            f"已解析 {len(bgras)} 帧 · cols={meta['cols']} rows={meta['rows']} · "
            f"cell {meta['cellWidth']}×{meta['cellHeight']} · "
            f"packMode={meta.get('packMode', '—')}"
        )
        self.lbl_import_summary.setText(summ)
        self._refresh_library_ui()
        self._refresh_clips_list()
        for i in range(self.list_clips.count()):
            it = self.list_clips.item(i)
            if it and it.data(Qt.ItemDataRole.UserRole) == clip.id:
                self.list_clips.setCurrentItem(it)
                break
        self.lbl_status.setText("已从导出还原到全局帧库；可批处理后到「动画与导出」再次导出。")

    def _batch_flip_all_frames(self) -> None:
        if not self._project.frames:
            QMessageBox.information(self, "批处理", "全局帧库为空。")
            return
        for f in self._project.frames:
            f.rgba = flip_bgra_horizontal(f.rgba)
        self._refresh_library_ui()
        self.lbl_status.setText("已对全部帧做水平翻转。")

    def _batch_scale_all_frames(self) -> None:
        if not self._project.frames:
            QMessageBox.information(self, "批处理", "全局帧库为空。")
            return
        s = float(self.sp_batch_scale.value())
        try:
            for f in self._project.frames:
                f.rgba = scale_bgra_uniform(f.rgba, s)
        except Exception as e:
            QMessageBox.critical(self, "缩放失败", str(e))
            return
        self._refresh_library_ui()
        self.lbl_status.setText(f"已对全部帧按比例 {s} 缩放。")

    def _single_atlas_frame_flip(self) -> None:
        n = len(self._project.frames)
        if n <= 0:
            return
        i = int(self.sp_atlas_one_idx.value())
        i = max(0, min(n - 1, i))
        self._project.frames[i].rgba = flip_bgra_horizontal(self._project.frames[i].rgba)
        self._refresh_library_ui()
        self.lbl_status.setText(f"已水平翻转库索引 {i}。")

    def _single_atlas_frame_scale(self) -> None:
        n = len(self._project.frames)
        if n <= 0:
            return
        i = int(self.sp_atlas_one_idx.value())
        i = max(0, min(n - 1, i))
        s = float(self.sp_batch_scale.value())
        try:
            self._project.frames[i].rgba = scale_bgra_uniform(self._project.frames[i].rgba, s)
        except Exception as e:
            QMessageBox.critical(self, "缩放失败", str(e))
            return
        self._refresh_library_ui()
        self.lbl_status.setText(f"已按 {s} 缩放库索引 {i}。")

    def _refresh_library_ui(self) -> None:
        n = len(self._project.frames)
        self.lbl_lib_count.setText(f"共 {n} 帧")
        self.sp_lib_i0.setRange(0, max(0, n - 1))
        self.sp_lib_i1.setRange(0, max(0, n - 1))
        if n > 0:
            self.sp_lib_i1.setValue(max(0, n - 1))
        self.sp_lo_head.setRange(0, max(0, n - 1))
        self.sp_lo_tail.setRange(0, max(0, n - 1))
        if n > 0:
            self.sp_lo_tail.setValue(max(0, n - 1))
        self.sp_atlas_one_idx.setRange(0, max(0, n - 1))
        while self._library_grid.count():
            item = self._library_grid.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()
        self._library_thumb_btns = []
        cols = 6
        for i, fr in enumerate(self._project.frames):
            bgr = bgra_to_bgr_preview(fr.rgba)
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            h, w = rgb.shape[:2]
            qimg = QImage(rgb.data, w, h, w * 3, QImage.Format.Format_RGB888).copy()
            pix = QPixmap.fromImage(qimg).scaled(64, 64, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
            btn = _LibraryThumbButton(i, self)
            btn.setIcon(QIcon(pix))
            btn.setIconSize(QSize(64, 64))
            btn.setFixedSize(72, 72)
            btn.setToolTip(
                f"库 #{i}  t={fr.t_sec:.3f}s\nCtrl+左键：首帧 · Alt+左键：尾帧（须≥首帧）"
            )
            r, c = divmod(i, cols)
            self._library_grid.addWidget(btn, r, c)
            self._library_thumb_btns.append(btn)
        self._apply_library_thumb_highlight()
        self._refresh_lib_onion_blend()
        self._refresh_clip_frames_list()

    def _on_library_thumb_mouse(self, idx: int, modifiers: Qt.KeyboardModifier) -> None:
        if modifiers & Qt.KeyboardModifier.ControlModifier:
            self._library_set_head(idx)
        elif modifiers & Qt.KeyboardModifier.AltModifier:
            self._library_set_tail(idx)

    def _library_set_head(self, idx: int) -> None:
        n = len(self._project.frames)
        if n <= 0:
            return
        idx = max(0, min(idx, n - 1))
        i1 = int(self.sp_lib_i1.value())
        new_i1 = max(idx, i1)
        self._set_lib_range_spins_and_onion(idx, new_i1)

    def _library_set_tail(self, idx: int) -> None:
        n = len(self._project.frames)
        if n <= 0:
            return
        idx = max(0, min(idx, n - 1))
        head = int(self.sp_lib_i0.value())
        if idx < head:
            self.lbl_status.setText("尾帧须在首帧之后或与首帧相同（Alt+左键无效）")
            return
        self._set_lib_range_spins_and_onion(head, idx)

    def _set_lib_range_spins_and_onion(self, i0: int, i1: int) -> None:
        if i0 > i1:
            i0, i1 = i1, i0
        self.sp_lib_i0.blockSignals(True)
        self.sp_lib_i1.blockSignals(True)
        self.sp_lo_head.blockSignals(True)
        self.sp_lo_tail.blockSignals(True)
        self.sp_lib_i0.setValue(i0)
        self.sp_lib_i1.setValue(i1)
        self.sp_lo_head.setValue(i0)
        self.sp_lo_tail.setValue(i1)
        self.sp_lib_i0.blockSignals(False)
        self.sp_lib_i1.blockSignals(False)
        self.sp_lo_head.blockSignals(False)
        self.sp_lo_tail.blockSignals(False)
        self._apply_library_thumb_highlight()
        self._refresh_lib_onion_blend()

    def _on_lib_range_spin_changed(self) -> None:
        i0 = int(self.sp_lib_i0.value())
        i1 = int(self.sp_lib_i1.value())
        lo = min(i0, i1)
        hi = max(i0, i1)
        self.sp_lo_head.blockSignals(True)
        self.sp_lo_tail.blockSignals(True)
        self.sp_lo_head.setValue(lo)
        self.sp_lo_tail.setValue(hi)
        self.sp_lo_head.blockSignals(False)
        self.sp_lo_tail.blockSignals(False)
        self._apply_library_thumb_highlight()
        self._refresh_lib_onion_blend()

    def _apply_library_thumb_highlight(self) -> None:
        if not self._library_thumb_btns:
            return
        i0 = int(self.sp_lib_i0.value())
        i1 = int(self.sp_lib_i1.value())
        lo, hi = (i0, i1) if i0 <= i1 else (i1, i0)
        for i, btn in enumerate(self._library_thumb_btns):
            if lo <= i <= hi:
                if i == lo == hi:
                    border = "3px solid #9966cc"
                elif i == lo:
                    border = "3px solid #4488ff"
                elif i == hi:
                    border = "3px solid #cc7722"
                else:
                    border = "3px solid #339933"
            else:
                border = "1px solid #555"
            btn.setStyleSheet(
                f"QPushButton {{ border:{border}; background:#222; padding:0; }}"
            )

    def _remove_library_range(self) -> None:
        n = len(self._project.frames)
        if n <= 0:
            return
        i0 = int(self.sp_lib_i0.value())
        i1 = int(self.sp_lib_i1.value())
        if i0 > i1:
            i0, i1 = i1, i0
        remove_ids = {self._project.frames[i].id for i in range(i0, i1 + 1)}
        self._project.frames = [f for f in self._project.frames if f.id not in remove_ids]
        for clip in self._project.clips:
            clip.frame_ids = [fid for fid in clip.frame_ids if fid not in remove_ids]
        self._refresh_library_ui()
        self._refresh_clips_list()

    def _refresh_lib_onion_blend(self) -> None:
        n = len(self._project.frames)
        if n <= 0:
            self._lbl_lib_onion.clear()
            self._lbl_lib_onion.setFixedSize(_LIB_ONION_BLEND_MIN_W, 180)
            return
        hi = int(self.sp_lo_head.value())
        ti = int(self.sp_lo_tail.value())
        hi = max(0, min(hi, n - 1))
        ti = max(0, min(ti, n - 1))
        a = float(self.sp_lo_opacity.value())
        head_bgr = bgra_to_bgr_preview(self._project.frames[hi].rgba)
        tail_bgr = bgra_to_bgr_preview(self._project.frames[ti].rgba)
        if tail_bgr.shape[:2] != head_bgr.shape[:2]:
            tail_bgr = cv2.resize(tail_bgr, (head_bgr.shape[1], head_bgr.shape[0]), interpolation=cv2.INTER_LINEAR)
        blend = cv2.addWeighted(head_bgr, a, tail_bgr, 1.0 - a, 0.0)
        rgb = np.ascontiguousarray(cv2.cvtColor(blend, cv2.COLOR_BGR2RGB))
        qimg = QImage(rgb.data, rgb.shape[1], rgb.shape[0], rgb.shape[1] * 3, QImage.Format.Format_RGB888)
        pix = QPixmap.fromImage(qimg.copy())
        pw = self._lib_onion_panel.width()
        cap_w = max(
            _LIB_ONION_BLEND_MIN_W,
            min(_LIB_ONION_BLEND_MAX_W, pw - 16 if pw > 40 else _LIB_ONION_BLEND_MIN_W),
        )
        scaled = pix.scaled(
            cap_w,
            _LIB_ONION_BLEND_MAX_H,
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        self._lbl_lib_onion.setPixmap(scaled)
        self._lbl_lib_onion.setFixedSize(scaled.size())

    def _refresh_clips_list(self) -> None:
        self.list_clips.clear()
        for c in self._project.clips:
            it = QListWidgetItem(f"{c.name}  ({len(c.frame_ids)} 帧)")
            it.setData(Qt.ItemDataRole.UserRole, c.id)
            self.list_clips.addItem(it)
        sel = -1
        if self._active_clip_id:
            for i in range(self.list_clips.count()):
                it = self.list_clips.item(i)
                if it and it.data(Qt.ItemDataRole.UserRole) == self._active_clip_id:
                    sel = i
                    break
        if sel >= 0:
            self.list_clips.setCurrentRow(sel)
        elif self._project.clips:
            self.list_clips.setCurrentRow(0)
        else:
            self._active_clip_id = None
            self.list_clip_frames.clear()

    def _current_clip(self) -> Optional[AnimationClip]:
        if self._active_clip_id:
            return self._project.clip_by_id(self._active_clip_id)
        return None

    def _on_clip_selection_changed(self, cur: Optional[QListWidgetItem], _prev: Optional[QListWidgetItem]) -> None:
        if cur is None:
            self._active_clip_id = None
            self._clip_preview_timer.stop()
            self.btn_clip_preview_play.setChecked(False)
            return
        cid = cur.data(Qt.ItemDataRole.UserRole)
        self._active_clip_id = str(cid) if cid else None
        clip = self._current_clip()
        if clip:
            self.sp_clip_fps.blockSignals(True)
            self.cb_clip_loop.blockSignals(True)
            self.sp_clip_fps.setValue(clip.frame_rate)
            self.cb_clip_loop.setChecked(clip.loop)
            self.sp_clip_fps.blockSignals(False)
            self.cb_clip_loop.blockSignals(False)
        self._refresh_clip_frames_list()
        self._clip_preview_idx = 0
        self._show_clip_preview_frame(0)

    def _on_clip_props_changed(self) -> None:
        clip = self._current_clip()
        if not clip:
            return
        clip.frame_rate = float(self.sp_clip_fps.value())
        clip.loop = self.cb_clip_loop.isChecked()

    def _refresh_clip_frames_list(self) -> None:
        self.list_clip_frames.clear()
        clip = self._current_clip()
        if not clip:
            return
        m = self._project.frame_map()
        for i, fid in enumerate(clip.frame_ids):
            fr = m.get(fid)
            label = f"{i}: {fid[:8]}…" if fr is None else f"{i}: #{self._frame_display_index(fid)}  t={fr.t_sec:.2f}s"
            it = QListWidgetItem(label)
            it.setData(Qt.ItemDataRole.UserRole, fid)
            self.list_clip_frames.addItem(it)

    def _frame_display_index(self, fid: str) -> int:
        for i, f in enumerate(self._project.frames):
            if f.id == fid:
                return i
        return -1

    def _clip_new(self) -> None:
        name, ok = QInputDialog.getText(self, "新建动画", "动画名称（state 名）:")
        if not ok or not name.strip():
            return
        clip = make_animation_clip(name.strip(), self.sp_clip_fps.value(), self.cb_clip_loop.isChecked())
        self._project.clips.append(clip)
        self._refresh_clips_list()
        for i in range(self.list_clips.count()):
            it = self.list_clips.item(i)
            if it and it.data(Qt.ItemDataRole.UserRole) == clip.id:
                self.list_clips.setCurrentItem(it)
                break

    def _clip_delete(self) -> None:
        clip = self._current_clip()
        if not clip:
            return
        self._project.clips = [c for c in self._project.clips if c.id != clip.id]
        self._active_clip_id = None
        self._refresh_clips_list()
        self.list_clip_frames.clear()

    def _clip_add_library_range(self) -> None:
        clip = self._current_clip()
        if not clip:
            QMessageBox.information(self, "提示", "请先新建并选中一个动画。")
            return
        n = len(self._project.frames)
        if n <= 0:
            return
        i0 = int(self.sp_lib_i0.value())
        i1 = int(self.sp_lib_i1.value())
        if i0 > i1:
            i0, i1 = i1, i0
        for i in range(i0, i1 + 1):
            clip.frame_ids.append(self._project.frames[i].id)
        self._refresh_clip_frames_list()
        self._refresh_clips_list()

    def _clip_create_from_library_range(self) -> None:
        name, ok = QInputDialog.getText(self, "新建动画", "动画名称:")
        if not ok or not name.strip():
            return
        n = len(self._project.frames)
        if n <= 0:
            return
        i0 = int(self.sp_lib_i0.value())
        i1 = int(self.sp_lib_i1.value())
        if i0 > i1:
            i0, i1 = i1, i0
        clip = make_animation_clip(name.strip(), self.sp_clip_fps.value(), self.cb_clip_loop.isChecked())
        for i in range(i0, i1 + 1):
            clip.frame_ids.append(self._project.frames[i].id)
        self._project.clips.append(clip)
        self._refresh_clips_list()
        for i in range(self.list_clips.count()):
            it = self.list_clips.item(i)
            if it and it.data(Qt.ItemDataRole.UserRole) == clip.id:
                self.list_clips.setCurrentItem(it)
                break

    def _clip_remove_selected_frames(self) -> None:
        clip = self._current_clip()
        if not clip:
            return
        rows = sorted({self.list_clip_frames.row(it) for it in self.list_clip_frames.selectedItems()}, reverse=True)
        for r in rows:
            if 0 <= r < len(clip.frame_ids):
                del clip.frame_ids[r]
        self._refresh_clip_frames_list()
        self._refresh_clips_list()

    def _clip_move_selected(self, delta: int) -> None:
        clip = self._current_clip()
        if not clip:
            return
        row = self.list_clip_frames.currentRow()
        if row < 0:
            return
        j = row + delta
        if j < 0 or j >= len(clip.frame_ids):
            return
        clip.frame_ids[row], clip.frame_ids[j] = clip.frame_ids[j], clip.frame_ids[row]
        self._refresh_clip_frames_list()
        self.list_clip_frames.setCurrentRow(j)

    def _toggle_clip_preview(self, on: bool) -> None:
        clip = self._current_clip()
        if on:
            if not clip or len(clip.frame_ids) < 1:
                self.btn_clip_preview_play.setChecked(False)
                QMessageBox.information(self, "提示", "当前动画没有帧")
                return
            self._clip_preview_idx = 0
            fps = max(0.5, clip.frame_rate)
            self._clip_preview_timer.start(max(16, int(1000.0 / fps)))
        else:
            self._clip_preview_timer.stop()

    def _on_clip_preview_tick(self) -> None:
        clip = self._current_clip()
        if not clip or not clip.frame_ids:
            self._clip_preview_timer.stop()
            return
        self._show_clip_preview_frame(self._clip_preview_idx)
        self._clip_preview_idx += 1
        if self._clip_preview_idx >= len(clip.frame_ids):
            if clip.loop:
                self._clip_preview_idx = 0
            else:
                self._clip_preview_idx = len(clip.frame_ids) - 1
                self._clip_preview_timer.stop()
                self.btn_clip_preview_play.setChecked(False)

    def _show_clip_preview_frame(self, idx: int) -> None:
        clip = self._current_clip()
        if not clip or not clip.frame_ids:
            self.lbl_clip_preview.clear()
            self.lbl_clip_preview.setText("动画预览")
            self.lbl_clip_preview.setFixedSize(_CLIP_PREVIEW_MIN_W, _CLIP_PREVIEW_MIN_W)
            return
        idx = max(0, min(idx, len(clip.frame_ids) - 1))
        fid = clip.frame_ids[idx]
        m = self._project.frame_map()
        fr = m.get(fid)
        if fr is None:
            return
        bgr = bgra_to_bgr_preview(fr.rgba)
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        rgb = np.ascontiguousarray(rgb)
        qimg = QImage(rgb.data, rgb.shape[1], rgb.shape[0], rgb.shape[1] * 3, QImage.Format.Format_RGB888)
        pix = QPixmap.fromImage(qimg.copy())
        scaled = pix.scaled(
            _CLIP_PREVIEW_MAX_W,
            _CLIP_PREVIEW_MAX_H,
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        self.lbl_clip_preview.setPixmap(scaled)
        self.lbl_clip_preview.setFixedSize(scaled.size())

    def _export_current_clip(self) -> None:
        clip = self._current_clip()
        if not clip or not clip.frame_ids:
            QMessageBox.warning(self, "提示", "请选择含帧的动画")
            return
        png_path, _ = QFileDialog.getSaveFileName(
            self,
            "保存图集 PNG",
            str(Path.cwd() / f"{clip.name}_atlas.png"),
            "PNG (*.png)",
        )
        if not png_path:
            return
        out_png = Path(png_path)
        out_meta = out_png.with_name(out_png.stem + ".meta.json")
        out_anim = out_png.with_name(out_png.stem + ".anim.json")
        base = int(self.cmb_index_base.currentData())
        ew, eh = self._export_world_wh()
        try:
            atlas, meta, anim = export_single_clip_native(
                self._project,
                clip,
                padding=int(self.sp_pad.value()),
                feather_ignore_px=0,
                frame_index_base=base,
                spritesheet_rel=self.edit_sprite_path.text().strip(),
                world_w=ew,
                world_h=eh,
            )
        except Exception as e:
            QMessageBox.critical(self, "导出失败", str(e))
            return
        try:
            save_outputs(
                atlas,
                meta,
                out_png,
                out_meta if self.cb_save_meta.isChecked() else None,
                anim,
                out_anim,
            )
        except OSError as e:
            QMessageBox.critical(self, "保存失败", str(e))
            return
        done_msg = f"已导出：\n{out_png}\n{out_anim}"
        if self.cb_save_meta.isChecked():
            done_msg += f"\n{out_meta}"
        self.lbl_status.setText(done_msg)

    def _export_merge_all(self) -> None:
        if not self._project.clips:
            QMessageBox.warning(self, "提示", "没有动画可合并")
            return
        png_path, _ = QFileDialog.getSaveFileName(
            self,
            "保存合并图集 PNG",
            str(Path.cwd() / "merged_atlas.png"),
            "PNG (*.png)",
        )
        if not png_path:
            return
        out_png = Path(png_path)
        out_meta = out_png.with_name(out_png.stem + ".meta.json")
        out_anim = out_png.with_name(out_png.stem + ".anim.json")
        base = int(self.cmb_index_base.currentData())
        try:
            atlas, meta, states_spec = build_merge_atlas_and_states(
                self._project,
                list(self._project.clips),
                padding=int(self.sp_pad.value()),
                feather_ignore_px=0,
                dedup=self.cb_merge_dedup.isChecked(),
                frame_index_base=base,
            )
        except Exception as e:
            QMessageBox.critical(self, "合并失败", str(e))
            return
        ew, eh = self._export_world_wh()
        anim = export_gamedraft_anim_multi(
            meta,
            self.edit_sprite_path.text().strip(),
            ew,
            eh,
            states_spec,
        )
        try:
            save_outputs(
                atlas,
                meta,
                out_png,
                out_meta if self.cb_save_meta.isChecked() else None,
                anim,
                out_anim,
            )
        except OSError as e:
            QMessageBox.critical(self, "保存失败", str(e))
            return
        merge_msg = f"已合并导出：\n{out_png}\n{out_anim}"
        if self.cb_save_meta.isChecked():
            merge_msg += f"\n{out_meta}"
        self.lbl_status.setText(merge_msg)
