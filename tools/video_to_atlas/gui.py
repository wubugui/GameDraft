"""视频转 Atlas：PySide6 主界面（源预览使用 Qt Multimedia 普通播放）。"""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image
from PySide6.QtCore import QEvent, QObject, QSize, Qt, QThread, Signal, QTimer, QUrl
from PySide6.QtGui import QIcon, QImage, QPixmap
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtMultimediaWidgets import QVideoWidget
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QProgressDialog,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSpinBox,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from atlas_core import (
    BuildConfig,
    build_atlas_from_rgba_list,
    build_atlas_from_video,
    decode_segment_rgba_frames,
    export_gamedraft_anim,
    first_last_frame_diff_score,
    save_outputs,
    slice_atlas_cells,
)
from loop_range_bar import LoopRangeBar
from loop_autodetect import (
    MSE_WARN_THRESHOLD,
    best_loop_fixed_length,
    best_loop_search_length,
    build_fingerprint_timeline,
)


def _pil_to_qpixmap(im: Image.Image) -> QPixmap:
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    w, h = im.size
    data = im.tobytes("raw", "RGBA")
    qimg = QImage(data, w, h, QImage.Format.Format_RGBA8888)
    return QPixmap.fromImage(qimg.copy())


class _BuildThread(QThread):
    done = Signal(object, object)
    failed = Signal(str)

    def __init__(
        self,
        video_path: str,
        cfg: BuildConfig,
        rgba_preset: Optional[List[np.ndarray]] = None,
        times_preset: Optional[List[float]] = None,
        strip_slice: Optional[Tuple[int, int]] = None,
    ) -> None:
        super().__init__()
        self._video_path = video_path
        self._cfg = cfg
        self._rgba_preset = rgba_preset
        self._times_preset = times_preset
        self._strip_slice = strip_slice

    def run(self) -> None:
        try:
            if self._rgba_preset is not None and self._times_preset is not None:
                atlas, meta = build_atlas_from_rgba_list(
                    self._rgba_preset,
                    self._times_preset,
                    self._cfg,
                    self._video_path,
                    strip_slice=self._strip_slice,
                )
            else:
                atlas, meta = build_atlas_from_video(self._video_path, self._cfg)
            self.done.emit(atlas, meta)
        except Exception as e:
            self.failed.emit(str(e))


class LoopAlignThread(QThread):
    """后台：扫描指纹 + 固定长度或搜索长度，得到最优 (t0,t1,mse)。"""

    finished_ok = Signal(float, float, float)
    failed = Signal(str)
    phase = Signal(str)

    def __init__(
        self,
        path: str,
        step_sec: float,
        chroma_enabled: bool,
        chroma_rgb: tuple[int, int, int],
        chroma_tol: float,
        mode: str,
        L_sec: float = 0.0,
        L_min: float = 0.0,
        L_max: float = 0.0,
        L_step: float = 0.05,
        pose_focus: bool = True,
    ) -> None:
        super().__init__()
        self._path = path
        self._step = step_sec
        self._ce = chroma_enabled
        self._crgb = chroma_rgb
        self._ctol = chroma_tol
        self._pose_focus = pose_focus
        self._mode = mode
        self._L = L_sec
        self._L_min = L_min
        self._L_max = L_max
        self._L_step = L_step

    def run(self) -> None:
        try:
            self.phase.emit("顺序解码并采样指纹…")

            times, fingerprints, duration, fps = build_fingerprint_timeline(
                self._path,
                self._step,
                self._ce,
                self._crgb,
                self._ctol,
                progress=None,
                pose_focus=self._pose_focus,
            )

            if self._mode == "fixed":
                self.phase.emit("按当前长度搜索最优起点…")
                t0, t1, mse = best_loop_fixed_length(
                    times,
                    fingerprints,
                    duration,
                    fps,
                    self._L,
                    progress=None,
                )
            else:
                self.phase.emit("枚举长度并搜索最优区间…")
                t0, t1, mse = best_loop_search_length(
                    times,
                    fingerprints,
                    duration,
                    fps,
                    self._L_min,
                    self._L_max,
                    self._L_step,
                    progress=None,
                )
            self.finished_ok.emit(t0, t1, mse)
        except Exception as e:
            self.failed.emit(str(e))


class MainWindow(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("视频转 Atlas（GameDraft）")
        self.resize(1200, 980)

        self._video_path: Optional[str] = None
        self._duration_sec = 0.0
        self._source_fps = 30.0
        self._last_atlas: Optional[Image.Image] = None
        self._last_meta: Optional[dict] = None
        self._result_cells: List[Image.Image] = []
        self._build_thread: Optional[_BuildThread] = None
        self._pending_out_png: Optional[Path] = None
        self._pending_out_meta: Optional[Path] = None
        self._pending_out_anim: Optional[Path] = None
        self._loop_seek_guard = False
        self._align_thread: Optional[LoopAlignThread] = None
        self._align_progress: Optional[QProgressDialog] = None
        self._onion_t0_bgr: Optional[np.ndarray] = None
        self._onion_head_strip_idx: Optional[int] = None
        self._strip_rgba: List[np.ndarray] = []
        self._strip_times: List[float] = []
        self._active_preview_frames: List[Image.Image] = []
        self._filmstrip_btns: List[QPushButton] = []

        self._player = QMediaPlayer()
        self._audio = QAudioOutput()
        self._player.setAudioOutput(self._audio)
        self._audio.setVolume(0.0)

        self._result_timer = QTimer(self)
        self._result_timer.timeout.connect(self._on_result_preview_tick)
        self._result_idx = 0

        self._loop_poll_timer = QTimer(self)
        self._loop_poll_timer.setInterval(16)
        self._loop_poll_timer.timeout.connect(self._tick_loop_segment)

        self._build_ui()

        self._player.playbackStateChanged.connect(self._on_playback_state_changed)
        self._player.durationChanged.connect(self._on_player_duration_changed)
        self._player.errorOccurred.connect(self._on_player_error)

    def eventFilter(self, obj: QObject, ev: QEvent) -> bool:
        if obj is getattr(self, "_onion_blend_panel", None) and ev.type() == QEvent.Type.Resize:
            QTimer.singleShot(0, self._refresh_onion_blend)
        return super().eventFilter(obj, ev)

    def _build_ui(self) -> None:
        root = QHBoxLayout(self)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        root.addWidget(splitter)

        left_scroll = QScrollArea()
        left_scroll.setWidgetResizable(True)
        left_panel = QWidget()
        left_layout = QVBoxLayout(left_panel)
        left_scroll.setWidget(left_panel)
        splitter.addWidget(left_scroll)

        gb_file = QGroupBox("视频")
        fl_file = QVBoxLayout(gb_file)
        self.btn_open = QPushButton("打开视频…")
        self.btn_open.clicked.connect(self._open_video)
        fl_file.addWidget(self.btn_open)
        self.lbl_video = QLabel("未加载")
        self.lbl_video.setWordWrap(True)
        fl_file.addWidget(self.lbl_video)
        left_layout.addWidget(gb_file)

        gb_range = QGroupBox("循环区间（拖动两端的圆点）")
        v_range = QVBoxLayout(gb_range)
        self.range_bar = LoopRangeBar()
        self.range_bar.rangeChanged.connect(self._on_loop_range_changed)
        v_range.addWidget(self.range_bar)
        self.lbl_range = QLabel("t0: —   t1: —")
        v_range.addWidget(self.lbl_range)

        hl_onion = QHBoxLayout()
        self.cb_onion = QCheckBox("首帧半透明叠层（手动对尾帧）")
        self.cb_onion.setToolTip(
            "抓取当前 t0 为参考帧。Windows 上解码画面会盖住叠在播放器上的控件，"
            "故首帧与尾帧的半透明叠放在下方「混合预览」中显示；拖动 t1 会更新混合图并让播放器跳到 t1。"
        )
        self.cb_onion.toggled.connect(self._on_onion_toggled)
        hl_onion.addWidget(self.cb_onion)
        self.btn_onion_grab = QPushButton("抓取 t0 为叠层")
        self.btn_onion_grab.setToolTip("按当前左柄 t0 时刻解码一帧并锁定为叠层；改 t0 后需重新抓取")
        self.btn_onion_grab.clicked.connect(self._grab_onion_frame)
        self.btn_onion_grab.setEnabled(False)
        hl_onion.addWidget(self.btn_onion_grab)
        self.sp_onion_opacity = QDoubleSpinBox()
        self.sp_onion_opacity.setRange(0.15, 0.85)
        self.sp_onion_opacity.setDecimals(2)
        self.sp_onion_opacity.setSingleStep(0.05)
        self.sp_onion_opacity.setValue(0.45)
        self.sp_onion_opacity.setToolTip("混合图里首帧权重（越大越接近首帧）")
        self.sp_onion_opacity.valueChanged.connect(self._on_onion_opacity_changed)
        hl_onion.addWidget(QLabel("叠层不透明度"))
        hl_onion.addWidget(self.sp_onion_opacity)
        hl_onion.addStretch()
        v_range.addLayout(hl_onion)

        hl_auto = QHBoxLayout()
        self.btn_align_fixed = QPushButton("按当前长度对齐首尾")
        self.btn_align_fixed.setToolTip(
            "保持当前区间长度不变，在时间轴上平移，使首尾在「姿势指纹」上最接近日匹配"
            "（默认按 alpha 包围盒裁角色再比；可关「姿势优先」改整帧）"
        )
        self.btn_align_fixed.setEnabled(False)
        self.btn_align_fixed.clicked.connect(self._start_align_fixed)
        hl_auto.addWidget(self.btn_align_fixed)
        self.cb_align_chroma = QCheckBox("对齐计算使用色键")
        self.cb_align_chroma.setChecked(True)
        self.cb_align_chroma.setToolTip("与下方关键色/容差一致；关闭则用原画比较")
        hl_auto.addWidget(self.cb_align_chroma)
        self.cb_align_pose = QCheckBox("姿势优先")
        self.cb_align_pose.setChecked(True)
        self.cb_align_pose.setToolTip(
            "开启：按非透明区域包围盒裁出角色、归一化后再比 MSE，便于找可循环的帧动画首尾。"
            "关闭：整帧缩小比较（接近早期整图行为）。建议配合色键。"
        )
        hl_auto.addWidget(self.cb_align_pose)
        hl_auto.addStretch()
        v_range.addLayout(hl_auto)

        form_scan = QFormLayout()
        self.sp_scan_step = QDoubleSpinBox()
        self.sp_scan_step.setDecimals(4)
        self.sp_scan_step.setRange(0.0, 2.0)
        self.sp_scan_step.setSpecialValueText("自动")
        self.sp_scan_step.setValue(0.0)
        self.sp_scan_step.setToolTip("指纹采样时间间隔；0 表示按帧率自动（约≤0.05s）")
        form_scan.addRow("采样步长 (s)", self.sp_scan_step)
        v_range.addLayout(form_scan)

        gb_adv = QGroupBox("高级：同时搜索区间长度")
        form_adv = QFormLayout(gb_adv)
        self.sp_L_min = QDoubleSpinBox()
        self.sp_L_min.setDecimals(3)
        self.sp_L_min.setRange(0.02, 600.0)
        self.sp_L_min.setValue(0.2)
        form_adv.addRow("最小时长 (s)", self.sp_L_min)
        self.sp_L_max = QDoubleSpinBox()
        self.sp_L_max.setDecimals(3)
        self.sp_L_max.setRange(0.05, 600.0)
        self.sp_L_max.setValue(5.0)
        form_adv.addRow("最大时长 (s)", self.sp_L_max)
        self.btn_fill_L_from_range = QPushButton("用当前区间填最小时长/最大时长")
        self.btn_fill_L_from_range.setToolTip(
            "按时间轴上 t0、t1 的间隔 L=t1−t0 填入两端；"
            "若只搜这一种长度，两处会相同。会按视频总长做夹紧。"
        )
        self.btn_fill_L_from_range.setEnabled(False)
        self.btn_fill_L_from_range.clicked.connect(self._fill_adv_duration_from_range)
        form_adv.addRow(self.btn_fill_L_from_range)
        self.sp_L_step = QDoubleSpinBox()
        self.sp_L_step.setDecimals(3)
        self.sp_L_step.setRange(0.01, 5.0)
        self.sp_L_step.setValue(0.05)
        form_adv.addRow("长度步进 (s)", self.sp_L_step)
        self.btn_align_search = QPushButton("搜索区间与长度")
        self.btn_align_search.setToolTip(
            "在「最小时长～最大时长」内枚举长度，并对每种长度做平移搜索，取全局姿势指纹 MSE 最小"
        )
        self.btn_align_search.setEnabled(False)
        self.btn_align_search.clicked.connect(self._start_align_search)
        form_adv.addRow(self.btn_align_search)
        v_range.addWidget(gb_adv)

        hl_play = QHBoxLayout()
        self.btn_play = QPushButton("播放")
        self.btn_play.clicked.connect(self._toggle_play)
        hl_play.addWidget(self.btn_play)
        self.cb_loop_segment = QCheckBox("仅循环播放所选区间")
        self.cb_loop_segment.setChecked(True)
        self.cb_loop_segment.setToolTip(
            "关闭后按普通播放器从头播到文件末尾。"
            "开启时用定时器略提前跳回起点，减轻解码器触底的卡顿（仍受素材关键帧与 Qt 后端限制）。"
        )
        self.cb_loop_segment.toggled.connect(self._sync_loop_poll_timer)
        hl_play.addWidget(self.cb_loop_segment)
        self.cb_mute = QCheckBox("静音预览")
        self.cb_mute.setChecked(True)
        self.cb_mute.toggled.connect(self._on_mute_toggled)
        hl_play.addWidget(self.cb_mute)
        hl_play.addStretch()
        v_range.addLayout(hl_play)
        left_layout.addWidget(gb_range)

        gb_export = QGroupBox("导出参数")
        form_e = QFormLayout(gb_export)
        self.sp_fps = QDoubleSpinBox()
        self.sp_fps.setDecimals(2)
        self.sp_fps.setRange(0.5, 120)
        self.sp_fps.setValue(12)
        form_e.addRow("目标 FPS", self.sp_fps)
        self.sp_max_frames = QSpinBox()
        self.sp_max_frames.setRange(0, 9999)
        self.sp_max_frames.setSpecialValueText("不限制")
        self.sp_max_frames.setValue(0)
        form_e.addRow("最大帧数 0=不限", self.sp_max_frames)
        self.sp_cell_w = QSpinBox()
        self.sp_cell_w.setRange(16, 4096)
        self.sp_cell_w.setValue(256)
        self.sp_cell_h = QSpinBox()
        self.sp_cell_h.setRange(16, 4096)
        self.sp_cell_h.setValue(256)
        form_e.addRow("单元格宽", self.sp_cell_w)
        form_e.addRow("单元格高", self.sp_cell_h)
        self.sp_pad = QSpinBox()
        self.sp_pad.setRange(0, 128)
        self.sp_pad.setValue(4)
        form_e.addRow("内边距", self.sp_pad)
        self.sp_cols = QSpinBox()
        self.sp_cols.setRange(0, 99)
        self.sp_cols.setSpecialValueText("自动")
        self.sp_cols.setValue(0)
        self.sp_rows = QSpinBox()
        self.sp_rows.setRange(0, 99)
        self.sp_rows.setSpecialValueText("自动")
        self.sp_rows.setValue(0)
        form_e.addRow("列数 0=自动", self.sp_cols)
        form_e.addRow("行数 0=自动", self.sp_rows)
        left_layout.addWidget(gb_export)

        gb_chroma = QGroupBox("色键（导出用；预览为原始画面）")
        form_c = QFormLayout(gb_chroma)
        self.cb_chroma = QCheckBox("启用色键")
        form_c.addRow(self.cb_chroma)
        self.sp_cr = QSpinBox()
        self.sp_cr.setRange(0, 255)
        self.sp_cg = QSpinBox()
        self.sp_cg.setRange(0, 255)
        self.sp_cb = QSpinBox()
        self.sp_cb.setRange(0, 255)
        self.sp_cr.setValue(0)
        self.sp_cg.setValue(255)
        self.sp_cb.setValue(0)
        hl_rgb = QHBoxLayout()
        hl_rgb.addWidget(QLabel("R"))
        hl_rgb.addWidget(self.sp_cr)
        hl_rgb.addWidget(QLabel("G"))
        hl_rgb.addWidget(self.sp_cg)
        hl_rgb.addWidget(QLabel("B"))
        hl_rgb.addWidget(self.sp_cb)
        form_c.addRow("关键色 RGB", hl_rgb)
        self.sp_chroma_tol = QDoubleSpinBox()
        self.sp_chroma_tol.setRange(1, 255)
        self.sp_chroma_tol.setValue(40)
        form_c.addRow("容差", self.sp_chroma_tol)
        left_layout.addWidget(gb_chroma)

        gb_strip = QGroupBox("区段帧动画（先提取，再选导出首尾）")
        v_strip = QVBoxLayout(gb_strip)
        self.btn_strip_extract = QPushButton("提取帧条（时间轴区间 + 目标 FPS + 最大帧数 + 色键）")
        self.btn_strip_extract.setToolTip(
            "按左侧时间轴 [t0,t1] 与下方「导出参数」中的目标 FPS、最大帧数解码成帧序列；"
            "在缩略图条上辨认姿势后，用序号框选要导出进 Atlas 的首尾帧（含端点）。"
        )
        self.btn_strip_extract.setEnabled(False)
        self.btn_strip_extract.clicked.connect(self._extract_strip)
        v_strip.addWidget(self.btn_strip_extract)
        self.lbl_strip_status = QLabel("尚未提取。请设置区间与 FPS 后点「提取帧条」；生成 Atlas 前必须提取。")
        self.lbl_strip_status.setWordWrap(True)
        v_strip.addWidget(self.lbl_strip_status)
        self._filmstrip_scroll = QScrollArea()
        self._filmstrip_scroll.setMinimumHeight(130)
        self._filmstrip_scroll.setMaximumHeight(200)
        self._filmstrip_scroll.setWidgetResizable(True)
        self._filmstrip_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self._filmstrip_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._filmstrip_inner = QWidget()
        self._filmstrip_layout = QHBoxLayout(self._filmstrip_inner)
        self._filmstrip_layout.setContentsMargins(4, 4, 4, 4)
        self._filmstrip_layout.setSpacing(4)
        self._filmstrip_layout.addStretch()
        self._filmstrip_scroll.setWidget(self._filmstrip_inner)
        v_strip.addWidget(self._filmstrip_scroll)
        hl_sl = QHBoxLayout()
        hl_sl.addWidget(QLabel("导出首帧序号"))
        self.sp_strip_i0 = QSpinBox()
        self.sp_strip_i0.setRange(0, 0)
        self.sp_strip_i0.setEnabled(False)
        self.sp_strip_i0.setToolTip("帧条中从0 开始；与尾帧一起决定打进 Atlas 的连续片段")
        hl_sl.addWidget(self.sp_strip_i0)
        hl_sl.addWidget(QLabel("导出尾帧序号"))
        self.sp_strip_i1 = QSpinBox()
        self.sp_strip_i1.setRange(0, 0)
        self.sp_strip_i1.setEnabled(False)
        hl_sl.addWidget(self.sp_strip_i1)
        hl_sl.addStretch()
        v_strip.addLayout(hl_sl)
        hl_cmp = QHBoxLayout()
        self.cb_strip_onion = QCheckBox("帧条叠层对比（半透明对尾帧）")
        self.cb_strip_onion.setToolTip(
            "勾选后：在帧条上点一格设为叠层「首帧」，用「对比尾帧」调半透明混合（下方预览区）。"
            "与「视频 t0 叠层」二选一。"
        )
        self.cb_strip_onion.toggled.connect(self._on_strip_onion_toggled)
        hl_cmp.addWidget(self.cb_strip_onion)
        hl_cmp.addWidget(QLabel("对比尾帧"))
        self.sp_compare_tail = QSpinBox()
        self.sp_compare_tail.setRange(0, 0)
        self.sp_compare_tail.setEnabled(False)
        self.sp_compare_tail.valueChanged.connect(lambda _v: self._refresh_onion_blend())
        hl_cmp.addWidget(self.sp_compare_tail)
        hl_cmp.addStretch()
        v_strip.addLayout(hl_cmp)
        self.sp_strip_i0.valueChanged.connect(self._on_strip_export_range_changed)
        self.sp_strip_i1.valueChanged.connect(self._on_strip_export_range_changed)
        left_layout.addWidget(gb_strip)

        gb_anim = QGroupBox("GameDraft 动画 JSON")
        form_a = QFormLayout(gb_anim)
        self.cb_save_anim = QCheckBox("同时导出 anim .json")
        self.cb_save_anim.setChecked(True)
        form_a.addRow(self.cb_save_anim)
        self.edit_sprite_path = QLineEdit("/assets/images/characters/out_atlas.png")
        form_a.addRow("spritesheet 路径", self.edit_sprite_path)
        self.edit_state = QLineEdit("clip")
        form_a.addRow("state 名称", self.edit_state)
        self.sp_world_w = QSpinBox()
        self.sp_world_w.setRange(1, 9999)
        self.sp_world_w.setValue(100)
        self.sp_world_h = QSpinBox()
        self.sp_world_h.setRange(1, 9999)
        self.sp_world_h.setValue(160)
        form_a.addRow("worldWidth", self.sp_world_w)
        form_a.addRow("worldHeight", self.sp_world_h)
        self.cb_loop = QCheckBox("loop")
        self.cb_loop.setChecked(True)
        form_a.addRow(self.cb_loop)
        self.cmb_index_base = QComboBox()
        self.cmb_index_base.addItem("帧编号从 0 开始", 0)
        self.cmb_index_base.addItem("帧编号从 1 开始", 1)
        form_a.addRow("帧索引基准", self.cmb_index_base)
        left_layout.addWidget(gb_anim)

        self.btn_generate = QPushButton("生成 Atlas …")
        self.btn_generate.clicked.connect(self._generate)
        left_layout.addWidget(self.btn_generate)
        self.lbl_status = QLabel("")
        self.lbl_status.setWordWrap(True)
        left_layout.addWidget(self.lbl_status)
        left_layout.addStretch()

        right = QWidget()
        rl = QVBoxLayout(right)
        self.video_widget = QVideoWidget()
        self.video_widget.setMinimumSize(400, 280)
        self.video_widget.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.video_widget.setStyleSheet("background:#111;")
        self._player.setVideoOutput(self.video_widget)
        rl.addWidget(self.video_widget, stretch=1)
        self._onion_blend_panel = QWidget()
        ob = QVBoxLayout(self._onion_blend_panel)
        ob.setContentsMargins(0, 6, 0, 0)
        self._lbl_onion_hint = QLabel(
            "混合预览：视频叠层随时间轴 t1更新；帧条叠层请点击某一格设首帧并调「对比尾帧」。"
        )
        self._lbl_onion_hint.setStyleSheet("color:#aaa;font-size:12px;")
        self._lbl_onion_hint.setWordWrap(True)
        ob.addWidget(self._lbl_onion_hint)
        self._onion_blend_label = QLabel()
        self._onion_blend_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._onion_blend_label.setMinimumHeight(200)
        self._onion_blend_label.setStyleSheet("background:#1a1a1a;border:1px solid #333;")
        self._onion_blend_label.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        ob.addWidget(self._onion_blend_label, stretch=1)
        self._onion_blend_panel.setVisible(False)
        self._onion_blend_panel.installEventFilter(self)
        rl.addWidget(self._onion_blend_panel, stretch=0)
        self.lbl_out = QLabel("生成结果预览")
        self.lbl_out.setMinimumSize(400, 200)
        self.lbl_out.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_out.setStyleSheet("background:#222;color:#888;")
        self.lbl_out.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        rl.addWidget(self.lbl_out, stretch=1)
        hl_pv = QHBoxLayout()
        self.btn_preview_out = QPushButton("播放预览")
        self.btn_preview_out.setCheckable(True)
        self.btn_preview_out.setToolTip(
            "优先播放已生成的 Atlas 帧；若无则播放当前「导出首尾序号」范围内的帧条。"
        )
        self.btn_preview_out.toggled.connect(self._toggle_result_preview)
        hl_pv.addWidget(self.btn_preview_out)
        self.cb_preview_loop = QCheckBox("预览循环")
        self.cb_preview_loop.setChecked(True)
        self.cb_preview_loop.setToolTip("关闭则播放到最后一帧后自动停止")
        hl_pv.addWidget(self.cb_preview_loop)
        hl_pv.addWidget(QLabel("查看帧"))
        self.sp_preview_frame = QSpinBox()
        self.sp_preview_frame.setRange(1, 1)
        self.sp_preview_frame.setMinimumWidth(72)
        self.sp_preview_frame.setToolTip("从 1 开始；与导出片段或 Atlas 帧序一致")
        hl_pv.addWidget(self.sp_preview_frame)
        self.btn_preview_goto = QPushButton("显示该帧")
        self.btn_preview_goto.setToolTip("停止播放并定格到上面序号")
        self.btn_preview_goto.clicked.connect(self._preview_goto_frame)
        hl_pv.addWidget(self.btn_preview_goto)
        hl_pv.addStretch()
        rl.addLayout(hl_pv)
        splitter.addWidget(right)
        splitter.setStretchFactor(1, 1)

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
            self._sync_loop_poll_timer(self.cb_loop_segment.isChecked())
        else:
            self.btn_play.setText("播放")
            self._loop_poll_timer.stop()

    def _toggle_play(self) -> None:
        if not self._video_path:
            QMessageBox.information(self, "提示", "请先打开视频")
            return
        if self._player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
            self._player.pause()
            self._loop_poll_timer.stop()
            return
        t0, t1 = self._t0_t1()
        if self.cb_loop_segment.isChecked() and t1 > t0:
            self._player.setPosition(int(t0 * 1000))
        self._player.play()

    def _sync_loop_poll_timer(self, _checked: bool = False) -> None:
        if (
            self.cb_loop_segment.isChecked()
            and self._player.playbackState() == QMediaPlayer.PlaybackState.PlayingState
        ):
            self._loop_poll_timer.start()
        else:
            self._loop_poll_timer.stop()

    def _tick_loop_segment(self) -> None:
        """
        区间循环：用 ~60Hz 轮询 + 略提前跳转，减轻触到 t1 时解码器收尾导致的跳变。
        （Qt Multimedia 本身难以做真正无缝循环，见 QTBUG-34706 等讨论。）
        """
        if self._loop_seek_guard:
            return
        if not self.cb_loop_segment.isChecked():
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
        jump_at = t1_ms - lead_ms
        if jump_at <= t0_ms:
            jump_at = t0_ms + max(1, span_ms // 4)
        if pos >= jump_at:
            self._loop_seek_guard = True
            self._player.setPosition(t0_ms)
            release_ms = min(100, max(20, span_ms // 3))
            QTimer.singleShot(release_ms, self._release_loop_seek_guard)

    def _on_loop_range_changed(self, t0: float, t1: float) -> None:
        del t0
        self._update_range_label()
        if self.cb_onion.isChecked() and self._onion_t0_bgr is not None and self._video_path:
            self._loop_seek_guard = True
            self._player.setPosition(int(max(0.0, t1) * 1000.0))
            self._loop_seek_guard = False
            self._refresh_onion_blend()
        if self._player.playbackState() != QMediaPlayer.PlaybackState.PlayingState:
            return
        pos = self._player.position()
        a, b = self._t0_t1()
        a_ms = int(a * 1000)
        b_ms = int(b * 1000)
        if self.cb_loop_segment.isChecked() and b > a and (pos < a_ms or pos >= b_ms):
            self._loop_seek_guard = True
            self._player.setPosition(a_ms)
            self._loop_seek_guard = False

    def _release_loop_seek_guard(self) -> None:
        self._loop_seek_guard = False

    def _update_range_label(self) -> None:
        t0, t1 = self.range_bar.range_sec()
        self.lbl_range.setText(f"t0: {t0:.3f} s    ·    t1: {t1:.3f} s    ·    总长 {self._duration_sec:.3f} s")

    def _on_onion_opacity_changed(self, _v: float) -> None:
        self._refresh_onion_blend()

    def _set_onion_blend_pixmap(self, rgb: np.ndarray) -> None:
        h, w = rgb.shape[:2]
        qimg = QImage(rgb.data, w, h, w * 3, QImage.Format.Format_RGB888).copy()
        pix = QPixmap.fromImage(qimg)
        lw = max(self._onion_blend_label.width(), 320)
        lh = max(self._onion_blend_label.height(), 160)
        scaled = pix.scaled(
            lw,
            lh,
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        self._onion_blend_label.setPixmap(scaled)

    def _refresh_onion_blend(self) -> None:
        a = float(self.sp_onion_opacity.value())
        a = max(0.0, min(1.0, a))

        if self.cb_strip_onion.isChecked() and self._strip_rgba:
            hi = self._onion_head_strip_idx
            if hi is None:
                return
            hi = max(0, min(hi, len(self._strip_rgba) - 1))
            ti = int(self.sp_compare_tail.value())
            ti = max(0, min(ti, len(self._strip_rgba) - 1))
            head_bgr = cv2.cvtColor(self._strip_rgba[hi], cv2.COLOR_BGRA2BGR)
            tail_bgr = cv2.cvtColor(self._strip_rgba[ti], cv2.COLOR_BGRA2BGR)
            if tail_bgr.shape[:2] != head_bgr.shape[:2]:
                tail_bgr = cv2.resize(
                    tail_bgr,
                    (head_bgr.shape[1], head_bgr.shape[0]),
                    interpolation=cv2.INTER_LINEAR,
                )
            blend = cv2.addWeighted(head_bgr, a, tail_bgr, 1.0 - a, 0.0)
            rgb = np.ascontiguousarray(cv2.cvtColor(blend, cv2.COLOR_BGR2RGB))
            self._set_onion_blend_pixmap(rgb)
            return

        if (
            not self.cb_onion.isChecked()
            or self._onion_t0_bgr is None
            or not self._video_path
        ):
            return
        _, t1 = self._t0_t1()
        cap = cv2.VideoCapture(self._video_path)
        if not cap.isOpened():
            return
        cap.set(cv2.CAP_PROP_POS_MSEC, float(max(0.0, t1) * 1000.0))
        ret, bgr1 = cap.read()
        cap.release()
        if not ret or bgr1 is None:
            return
        t0 = self._onion_t0_bgr
        if bgr1.shape[:2] != t0.shape[:2]:
            bgr1 = cv2.resize(
                bgr1,
                (t0.shape[1], t0.shape[0]),
                interpolation=cv2.INTER_LINEAR,
            )
        blend = cv2.addWeighted(t0, a, bgr1, 1.0 - a, 0.0)
        rgb = np.ascontiguousarray(cv2.cvtColor(blend, cv2.COLOR_BGR2RGB))
        self._set_onion_blend_pixmap(rgb)

    def _grab_onion_frame(self) -> None:
        if not self._video_path:
            QMessageBox.information(self, "提示", "请先打开视频")
            return
        t0, t1 = self._t0_t1()
        cap = cv2.VideoCapture(self._video_path)
        if not cap.isOpened():
            QMessageBox.warning(self, "错误", "无法打开视频")
            return
        cap.set(cv2.CAP_PROP_POS_MSEC, float(max(0.0, t0) * 1000.0))
        ret, bgr = cap.read()
        cap.release()
        if not ret or bgr is None:
            QMessageBox.warning(self, "错误", f"无法在 t0={t0:.3f}s 解码帧")
            self.cb_onion.blockSignals(True)
            self.cb_onion.setChecked(False)
            self.cb_onion.blockSignals(False)
            self._onion_blend_panel.setVisible(False)
            self._onion_t0_bgr = None
            return
        self._onion_t0_bgr = bgr.copy()
        self.cb_strip_onion.blockSignals(True)
        self.cb_strip_onion.setChecked(False)
        self.cb_strip_onion.blockSignals(False)
        self.sp_compare_tail.setEnabled(False)
        self.cb_onion.blockSignals(True)
        self.cb_onion.setChecked(True)
        self.cb_onion.blockSignals(False)
        self._onion_blend_panel.setVisible(True)
        self._loop_seek_guard = True
        self._player.setPosition(int(max(0.0, t1) * 1000.0))
        self._loop_seek_guard = False
        QTimer.singleShot(0, self._refresh_onion_blend)

    def _on_onion_toggled(self, checked: bool) -> None:
        if checked:
            self.cb_strip_onion.blockSignals(True)
            self.cb_strip_onion.setChecked(False)
            self.cb_strip_onion.blockSignals(False)
            self.sp_compare_tail.setEnabled(False)
            if self._filmstrip_btns:
                self._update_filmstrip_head_style()
            if self._onion_t0_bgr is None:
                self._grab_onion_frame()
                if self._onion_t0_bgr is None:
                    self.cb_onion.blockSignals(True)
                    self.cb_onion.setChecked(False)
                    self.cb_onion.blockSignals(False)
            else:
                self._onion_blend_panel.setVisible(True)
                _, t1 = self._t0_t1()
                self._loop_seek_guard = True
                self._player.setPosition(int(max(0.0, t1) * 1000.0))
                self._loop_seek_guard = False
                QTimer.singleShot(0, self._refresh_onion_blend)
        else:
            if not self.cb_strip_onion.isChecked():
                self._onion_blend_panel.setVisible(False)

    def _on_strip_onion_toggled(self, on: bool) -> None:
        if on:
            self.cb_onion.blockSignals(True)
            self.cb_onion.setChecked(False)
            self.cb_onion.blockSignals(False)
            if not self._strip_rgba:
                self.cb_strip_onion.blockSignals(True)
                self.cb_strip_onion.setChecked(False)
                self.cb_strip_onion.blockSignals(False)
                QMessageBox.information(self, "提示", "请先点击「提取帧条」。")
                return
            self.sp_compare_tail.setEnabled(True)
            n = len(self._strip_rgba)
            self.sp_compare_tail.setRange(0, max(0, n - 1))
            if self.sp_compare_tail.value() > n - 1:
                self.sp_compare_tail.setValue(n - 1)
            if self._onion_head_strip_idx is None:
                self._onion_head_strip_idx = 0
            if self._filmstrip_btns:
                self._update_filmstrip_head_style()
            else:
                self._populate_filmstrip()
            self._onion_blend_panel.setVisible(True)
            self._refresh_onion_blend()
        else:
            self.sp_compare_tail.setEnabled(False)
            if self._filmstrip_btns:
                self._update_filmstrip_head_style()
            if not self.cb_onion.isChecked():
                self._onion_blend_panel.setVisible(False)

    def _on_strip_export_range_changed(self, _v: int = 0) -> None:
        del _v
        self._update_preview_frame_spin()
        if self._result_timer.isActive():
            self._active_preview_frames = self._current_preview_frames()
            self._result_idx = min(self._result_idx, max(0, len(self._active_preview_frames) - 1))
        if self.cb_strip_onion.isChecked() and self._strip_rgba:
            self._refresh_onion_blend()

    def _chroma_params_for_align(self) -> tuple[bool, tuple[int, int, int], float]:
        ce = self.cb_align_chroma.isChecked()
        rgb = (int(self.sp_cr.value()), int(self.sp_cg.value()), int(self.sp_cb.value()))
        tol = float(self.sp_chroma_tol.value())
        return ce, rgb, tol

    def _begin_align_busy(self) -> None:
        self.btn_align_fixed.setEnabled(False)
        self.btn_align_search.setEnabled(False)

    def _end_align_busy(self) -> None:
        ok = self._video_path is not None
        self.btn_align_fixed.setEnabled(ok)
        self.btn_align_search.setEnabled(ok)

    def _on_align_phase(self, text: str) -> None:
        if self._align_progress is not None:
            self._align_progress.setLabelText(text)
        QApplication.processEvents()

    def _on_align_ok(self, t0: float, t1: float, mse: float) -> None:
        if self._align_progress is not None:
            self._align_progress.close()
            self._align_progress = None
        # 进度框关闭后再改时间轴与 seek，避免双柄条不重绘、预览仍停在旧时刻
        QTimer.singleShot(
            0,
            lambda t0=t0, t1=t1, mse=mse: self._apply_align_result(t0, t1, mse),
        )

    def _apply_align_result(self, t0: float, t1: float, mse: float) -> None:
        dur = max(self._duration_sec, 0.001)
        self.range_bar.set_duration_sec(dur)
        self.range_bar.set_range_sec(t0, t1, emit=True)
        self.range_bar.repaint()
        self._update_range_label()
        self._seek_preview_to_loop_start()
        msg = f"自动对齐完成：首尾差异 MSE≈{mse:.1f}（越小越接近日匹配；开「姿势优先」时按角色区域裁切后比较）"
        if mse > MSE_WARN_THRESHOLD:
            msg += (
                f"\n仍高于建议阈值 {MSE_WARN_THRESHOLD:.0f}，循环可能仍有跳变；"
                "可尝试缩小采样步长或缩短「高级」里的搜索范围。"
            )
        self.lbl_status.setText(msg)
        self._end_align_busy()

    def _seek_preview_to_loop_start(self) -> None:
        if not self._video_path:
            return
        t0, _t1 = self.range_bar.range_sec()
        ms = int(max(0.0, t0) * 1000.0)
        self._loop_seek_guard = True
        self._player.setPosition(ms)
        self._loop_seek_guard = False

    def _on_align_fail(self, err: str) -> None:
        if self._align_progress is not None:
            self._align_progress.close()
            self._align_progress = None
        QMessageBox.warning(self, "自动对齐失败", err)
        self._end_align_busy()

    def _cleanup_align_thread(self) -> None:
        self._align_thread = None

    def _start_align_fixed(self) -> None:
        if not self._video_path or (self._align_thread and self._align_thread.isRunning()):
            return
        t0, t1 = self.range_bar.range_sec()
        L = t1 - t0
        if L <= 1e-4:
            QMessageBox.warning(self, "提示", "请先拖出有效的区间长度（t1 > t0）。")
            return
        step = float(self.sp_scan_step.value())
        ce, rgb, tol = self._chroma_params_for_align()
        self._begin_align_busy()
        self._align_progress = QProgressDialog(self)
        self._align_progress.setWindowTitle("自动对齐")
        self._align_progress.setLabelText("顺序解码视频中…")
        self._align_progress.setRange(0, 0)
        self._align_progress.setCancelButton(None)
        self._align_progress.setMinimumDuration(0)
        self._align_progress.show()

        th = LoopAlignThread(
            self._video_path,
            step,
            ce,
            rgb,
            tol,
            "fixed",
            L_sec=L,
            pose_focus=self.cb_align_pose.isChecked(),
        )
        self._align_thread = th
        th.phase.connect(self._on_align_phase)
        th.finished_ok.connect(self._on_align_ok)
        th.failed.connect(self._on_align_fail)
        th.finished.connect(self._cleanup_align_thread)
        th.start()

    def _fill_adv_duration_from_range(self) -> None:
        """用时间轴当前 t0、t1 的间隔 L 填入高级搜索的最小/最大时长。"""
        t0, t1 = self.range_bar.range_sec()
        if t1 < t0:
            t0, t1 = t1, t0
        L = t1 - t0
        if L < 1e-6:
            QMessageBox.information(self, "提示", "请先在时间轴上拖出有效区间（t1 > t0）。")
            return
        dur = max(self._duration_sec, 0.1)
        cap_hi = dur - 0.02
        if cap_hi < 0.05:
            QMessageBox.warning(self, "提示", "视频过短，无法设置时长范围。")
            return
        lo = max(0.02, min(L, cap_hi))
        hi = max(0.05, min(L, cap_hi))
        if hi < lo:
            lo, hi = hi, lo
        self.sp_L_min.setValue(lo)
        self.sp_L_max.setValue(hi)

    def _start_align_search(self) -> None:
        if not self._video_path or (self._align_thread and self._align_thread.isRunning()):
            return
        L_min = float(self.sp_L_min.value())
        L_max = float(self.sp_L_max.value())
        L_step = float(self.sp_L_step.value())
        if L_max < L_min + 1e-4:
            QMessageBox.warning(self, "提示", "最大时长必须大于最小时长。")
            return
        dur = max(self._duration_sec, 0.1)
        L_max = min(L_max, dur - 0.02)
        L_min = min(L_min, L_max - 0.02)
        if L_min < 0.02:
            L_min = 0.02
        if L_max <= L_min:
            QMessageBox.warning(self, "提示", "视频过短或时长范围无效。")
            return
        step = float(self.sp_scan_step.value())
        ce, rgb, tol = self._chroma_params_for_align()
        self._begin_align_busy()
        self._align_progress = QProgressDialog(self)
        self._align_progress.setWindowTitle("自动对齐")
        self._align_progress.setLabelText("顺序解码视频中…")
        self._align_progress.setRange(0, 0)
        self._align_progress.setCancelButton(None)
        self._align_progress.setMinimumDuration(0)
        self._align_progress.show()

        th = LoopAlignThread(
            self._video_path,
            step,
            ce,
            rgb,
            tol,
            "search",
            L_sec=0.0,
            L_min=L_min,
            L_max=L_max,
            L_step=L_step,
            pose_focus=self.cb_align_pose.isChecked(),
        )
        self._align_thread = th
        th.phase.connect(self._on_align_phase)
        th.finished_ok.connect(self._on_align_ok)
        th.failed.connect(self._on_align_fail)
        th.finished.connect(self._cleanup_align_thread)
        th.start()

    def closeEvent(self, event) -> None:
        self._result_timer.stop()
        self._loop_poll_timer.stop()
        self._player.stop()
        if self._build_thread and self._build_thread.isRunning():
            self._build_thread.wait(3000)
        if self._align_thread and self._align_thread.isRunning():
            self._align_thread.wait(8000)
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

        self._onion_t0_bgr = None
        self._onion_blend_label.clear()
        self.cb_onion.blockSignals(True)
        self.cb_onion.setChecked(False)
        self.cb_onion.blockSignals(False)
        self._onion_blend_panel.setVisible(False)
        self.cb_strip_onion.blockSignals(True)
        self.cb_strip_onion.setChecked(False)
        self.cb_strip_onion.blockSignals(False)
        self.sp_compare_tail.setEnabled(False)
        self._onion_head_strip_idx = None

        self._strip_rgba = []
        self._strip_times = []
        self._clear_filmstrip()
        self._filmstrip_layout.addStretch()
        self.lbl_strip_status.setText(
            "尚未提取。请设置区间与「导出参数」中的 FPS/最大帧数后点「提取帧条」。"
        )
        self.sp_strip_i0.setRange(0, 0)
        self.sp_strip_i1.setRange(0, 0)
        self.sp_strip_i0.setEnabled(False)
        self.sp_strip_i1.setEnabled(False)

        self.lbl_video.setText(f"{abs_path}\n时长约 {dur:.2f}s · OpenCV 估计 FPS {fps:.2f}")
        self.lbl_status.setText(
            "已加载：用时间轴选区段，再提取帧条并在序号中选导出首尾，最后生成 Atlas。"
        )
        self.btn_align_fixed.setEnabled(True)
        self.btn_align_search.setEnabled(True)
        self.btn_fill_L_from_range.setEnabled(True)
        self.btn_onion_grab.setEnabled(True)
        self.btn_strip_extract.setEnabled(True)

    def _t0_t1(self) -> tuple[float, float]:
        t0, t1 = self.range_bar.range_sec()
        if t1 < t0:
            t0, t1 = t1, t0
        return t0, t1

    def _make_config(self) -> BuildConfig:
        t0, t1 = self._t0_t1()
        return BuildConfig(
            t0_sec=t0,
            t1_sec=t1,
            target_fps=float(self.sp_fps.value()),
            cell_w=int(self.sp_cell_w.value()),
            cell_h=int(self.sp_cell_h.value()),
            cols=int(self.sp_cols.value()),
            rows=int(self.sp_rows.value()),
            padding=int(self.sp_pad.value()),
            chroma_enabled=self.cb_chroma.isChecked(),
            chroma_rgb=(int(self.sp_cr.value()), int(self.sp_cg.value()), int(self.sp_cb.value())),
            chroma_tolerance=float(self.sp_chroma_tol.value()),
            max_frames=int(self.sp_max_frames.value()),
            frame_index_base=int(self.cmb_index_base.currentData()),
        )

    def _clear_filmstrip(self) -> None:
        self._filmstrip_btns = []
        while self._filmstrip_layout.count():
            item = self._filmstrip_layout.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()

    def _thumb_pixmap(self, rgba: np.ndarray, tw: int = 72, th: int = 72) -> QPixmap:
        bgr = cv2.cvtColor(rgba, cv2.COLOR_BGRA2BGR)
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        h, w = rgb.shape[:2]
        rgb = np.ascontiguousarray(rgb)
        qimg = QImage(rgb.data, w, h, w * 3, QImage.Format.Format_RGB888).copy()
        return QPixmap.fromImage(qimg).scaled(
            tw,
            th,
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )

    def _populate_filmstrip(self) -> None:
        self._clear_filmstrip()
        for i, rgba in enumerate(self._strip_rgba):
            pix = self._thumb_pixmap(rgba, 72, 72)
            btn = QPushButton()
            btn.setIcon(QIcon(pix))
            btn.setIconSize(QSize(72, 72))
            btn.setFixedSize(78, 78)
            btn.setToolTip(f"点击设为叠层首帧  #{i}  t={self._strip_times[i]:.3f}s")
            btn.clicked.connect(lambda _c=False, idx=i: self._on_filmstrip_thumb_clicked(idx))
            self._filmstrip_btns.append(btn)
            self._filmstrip_layout.addWidget(btn)
        self._filmstrip_layout.addStretch()
        self._update_filmstrip_head_style()

    def _update_filmstrip_head_style(self) -> None:
        for i, btn in enumerate(self._filmstrip_btns):
            sel = self._onion_head_strip_idx is not None and i == self._onion_head_strip_idx
            border = "3px solid #66aaff" if sel else "1px solid #555"
            btn.setStyleSheet(
                f"QPushButton {{ border:{border}; background:#222; padding:0; }}"
            )

    def _on_filmstrip_thumb_clicked(self, idx: int) -> None:
        self._onion_head_strip_idx = idx
        if not self.cb_strip_onion.isChecked():
            self.cb_strip_onion.setChecked(True)
        else:
            self._update_filmstrip_head_style()
            self._refresh_onion_blend()

    def _extract_strip(self) -> None:
        if not self._video_path:
            QMessageBox.information(self, "提示", "请先打开视频")
            return
        cfg = self._make_config()
        try:
            self._strip_rgba, self._strip_times = decode_segment_rgba_frames(
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
        if not self._strip_rgba:
            QMessageBox.warning(self, "提示", "未解码到任何帧，请检查时间轴区间、目标 FPS 与最大帧数")
            return
        n = len(self._strip_rgba)
        self.cb_strip_onion.blockSignals(True)
        self.cb_strip_onion.setChecked(False)
        self.cb_strip_onion.blockSignals(False)
        self.sp_compare_tail.setEnabled(False)
        self._onion_head_strip_idx = 0
        self._populate_filmstrip()
        self.sp_compare_tail.setRange(0, max(0, n - 1))
        self.sp_compare_tail.setValue(max(0, n - 1))
        self.lbl_strip_status.setText(
            f"已提取 {n} 帧（索引 0～{n - 1}）。点击缩略图可选叠层首帧；"
            "在序号中选导出首尾（含端点），再点「生成 Atlas」。"
        )
        self.sp_strip_i0.setEnabled(True)
        self.sp_strip_i1.setEnabled(True)
        self.sp_strip_i0.setRange(0, n - 1)
        self.sp_strip_i1.setRange(0, n - 1)
        self.sp_strip_i0.setValue(0)
        self.sp_strip_i1.setValue(n - 1)
        self._update_preview_frame_spin()

    def _generate(self) -> None:
        if self._build_thread is not None and self._build_thread.isRunning():
            return
        if not self._video_path:
            QMessageBox.warning(self, "提示", "请先打开视频")
            return
        if not self._strip_rgba:
            QMessageBox.warning(
                self,
                "提示",
                "请先点击「提取帧条」，在缩略图条上确认序列后，用「导出首/尾帧序号」选定要打进 Atlas 的片段，再生成。",
            )
            return
        png_path, _ = QFileDialog.getSaveFileName(
            self,
            "保存 Atlas PNG",
            str(Path(self._video_path).with_suffix(".atlas.png")),
            "PNG (*.png)",
        )
        if not png_path:
            return
        out_png = Path(png_path)
        out_meta = out_png.with_name(out_png.stem + ".meta.json")
        out_anim = out_png.with_name(out_png.stem + ".anim.json")

        cfg = self._make_config()
        i0 = int(self.sp_strip_i0.value())
        i1 = int(self.sp_strip_i1.value())
        if i0 > i1:
            i0, i1 = i1, i0
            self.sp_strip_i0.setValue(i0)
            self.sp_strip_i1.setValue(i1)
        sub_rgba = self._strip_rgba[i0 : i1 + 1]
        sub_times = self._strip_times[i0 : i1 + 1]
        if len(sub_rgba) < 1:
            QMessageBox.warning(self, "错误", "所选首尾序号无效")
            return

        seg = f"[{cfg.t0_sec:.3f}s , {cfg.t1_sec:.3f}s]"
        seam = first_last_frame_diff_score(sub_rgba) if len(sub_rgba) >= 2 else None
        hint = ""
        if seam is not None:
            hint = f"导出片段首尾粗略差异(MSE@64px)约{seam:.1f}，若循环跳变可微调尾帧序号。"

        self._pending_out_png = out_png
        self._pending_out_meta = out_meta
        self._pending_out_anim = out_anim
        self.btn_generate.setEnabled(False)
        self.lbl_status.setText(
            f"正在生成…区段 {seg}，帧条序号 {i0}～{i1} 共 {len(sub_rgba)} 帧。{hint}"
        )

        th = _BuildThread(
            self._video_path,
            cfg,
            rgba_preset=sub_rgba,
            times_preset=sub_times,
            strip_slice=(i0, i1),
        )
        self._build_thread = th

        def on_done(atlas: Image.Image, meta: dict) -> None:
            self._last_atlas = atlas
            self._last_meta = meta
            gdraft = None
            if self.cb_save_anim.isChecked():
                gdraft = export_gamedraft_anim(
                    meta,
                    self.edit_sprite_path.text().strip(),
                    float(self.sp_world_w.value()),
                    float(self.sp_world_h.value()),
                    self.edit_state.text().strip() or "clip",
                    self.cb_loop.isChecked(),
                )
            try:
                save_outputs(
                    atlas,
                    meta,
                    out_png,
                    out_meta,
                    gdraft,
                    out_anim if self.cb_save_anim.isChecked() else None,
                )
            except OSError as e:
                QMessageBox.critical(self, "保存失败", str(e))
                self.btn_generate.setEnabled(True)
                return

            n = int(meta["frameCount"])
            cols = int(meta["cols"])
            rows = int(meta["rows"])
            cw = int(meta["cellWidth"])
            ch = int(meta["cellHeight"])
            self._result_cells = slice_atlas_cells(atlas, cols, rows, cw, ch, n)
            self._update_preview_frame_spin()
            self.lbl_out.setPixmap(
                _pil_to_qpixmap(self._result_cells[0]).scaled(
                    self.lbl_out.size(),
                    Qt.AspectRatioMode.KeepAspectRatio,
                    Qt.TransformationMode.FastTransformation,
                )
            )
            extras = f"已保存：\n{out_png}\n{out_meta}"
            if self.cb_save_anim.isChecked():
                extras += f"\n{out_anim}"
            self.lbl_status.setText(extras + "\n" + hint)
            self.btn_generate.setEnabled(True)

        def on_fail(msg: str) -> None:
            QMessageBox.critical(self, "生成失败", msg)
            self.lbl_status.setText("")
            self.btn_generate.setEnabled(True)

        th.done.connect(on_done)
        th.failed.connect(on_fail)
        th.start()

    def _strip_export_slice(self) -> tuple[int, int]:
        i0 = int(self.sp_strip_i0.value())
        i1 = int(self.sp_strip_i1.value())
        if i0 > i1:
            return i1, i0
        return i0, i1

    def _current_preview_frames(self) -> List[Image.Image]:
        if self._result_cells:
            return self._result_cells
        if not self._strip_rgba:
            return []
        i0, i1 = self._strip_export_slice()
        out: List[Image.Image] = []
        for rgba in self._strip_rgba[i0 : i1 + 1]:
            rgba_u8 = np.ascontiguousarray(rgba)
            rgb = cv2.cvtColor(rgba_u8, cv2.COLOR_BGRA2RGBA)
            out.append(Image.fromarray(rgb))
        return out

    def _update_preview_frame_spin(self) -> None:
        n = len(self._current_preview_frames())
        if n <= 0:
            self.sp_preview_frame.setRange(1, 1)
            self.sp_preview_frame.setValue(1)
            return
        cur = int(self.sp_preview_frame.value())
        self.sp_preview_frame.setRange(1, n)
        self.sp_preview_frame.setValue(min(max(1, cur), n))

    def _show_preview_frame_at(self, idx: int, update_spin: bool = True) -> None:
        frames = self._active_preview_frames if self._active_preview_frames else self._current_preview_frames()
        if not frames:
            return
        idx = max(0, min(idx, len(frames) - 1))
        im = frames[idx]
        self.lbl_out.setPixmap(
            _pil_to_qpixmap(im).scaled(
                self.lbl_out.size(),
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.FastTransformation,
            )
        )
        if update_spin:
            self.sp_preview_frame.blockSignals(True)
            self.sp_preview_frame.setValue(idx + 1)
            self.sp_preview_frame.blockSignals(False)

    def _preview_goto_frame(self) -> None:
        self._result_timer.stop()
        if self.btn_preview_out.isChecked():
            self.btn_preview_out.blockSignals(True)
            self.btn_preview_out.setChecked(False)
            self.btn_preview_out.blockSignals(False)
        frames = self._current_preview_frames()
        if not frames:
            QMessageBox.information(
                self,
                "提示",
                "请先生成 Atlas，或提取帧条并设置导出首尾序号。",
            )
            return
        self._active_preview_frames = frames
        self._update_preview_frame_spin()
        idx = int(self.sp_preview_frame.value()) - 1
        idx = max(0, min(idx, len(frames) - 1))
        self._result_idx = idx
        self._show_preview_frame_at(idx, update_spin=True)

    def _toggle_result_preview(self, on: bool) -> None:
        self._active_preview_frames = self._current_preview_frames()
        if on:
            if not self._active_preview_frames:
                self.btn_preview_out.setChecked(False)
                QMessageBox.information(
                    self,
                    "提示",
                    "请先生成 Atlas，或提取帧条并设置导出首尾序号。",
                )
                return
            fps = float(self.sp_fps.value())
            ms = max(16, int(1000.0 / fps))
            self._result_idx = 0
            self._show_preview_frame_at(0, update_spin=False)
            self.sp_preview_frame.blockSignals(True)
            self.sp_preview_frame.setValue(1)
            self.sp_preview_frame.blockSignals(False)
            self._result_timer.start(ms)
        else:
            self._result_timer.stop()

    def _on_result_preview_tick(self) -> None:
        frames = self._active_preview_frames
        if not frames:
            self._result_timer.stop()
            return
        last = len(frames) - 1
        if self._result_idx >= last:
            if self.cb_preview_loop.isChecked():
                self._result_idx = 0
            else:
                self._result_timer.stop()
                self.btn_preview_out.blockSignals(True)
                self.btn_preview_out.setChecked(False)
                self.btn_preview_out.blockSignals(False)
                self._show_preview_frame_at(last, update_spin=True)
                return
        else:
            self._result_idx += 1
        self._show_preview_frame_at(self._result_idx, update_spin=False)
        self.sp_preview_frame.blockSignals(True)
        self.sp_preview_frame.setValue(self._result_idx + 1)
        self.sp_preview_frame.blockSignals(False)
