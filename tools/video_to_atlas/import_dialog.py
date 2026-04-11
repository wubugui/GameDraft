"""Import dialog: video loading, time range selection, chroma key, frame extraction."""
from __future__ import annotations

from pathlib import Path
from typing import Optional, Tuple

import cv2
import numpy as np
from PySide6.QtCore import QTimer, QUrl, Qt, Signal
from PySide6.QtGui import QColor, QImage, QMouseEvent, QPixmap
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtMultimediaWidgets import QVideoWidget
from PySide6.QtWidgets import (
    QCheckBox,
    QColorDialog,
    QComboBox,
    QDialog,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QSizePolicy,
    QSpinBox,
    QVBoxLayout,
)

from atlas_core import bgr_to_rgba_frame, decode_segment_rgba_frames
from loop_range_bar import LoopRangeBar
from workspace_model import (
    ChromaParams,
    FrameItem,
    VideoSource,
    Workspace,
    new_id,
)


def _bgr_to_qpixmap(bgr: np.ndarray) -> QPixmap:
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]
    rgb = np.ascontiguousarray(rgb)
    qimg = QImage(rgb.data, w, h, w * 3, QImage.Format.Format_RGB888)
    return QPixmap.fromImage(qimg.copy())


def _composite_checkerboard_bgra(bgra: np.ndarray, cell: int = 12) -> np.ndarray:
    h, w = bgra.shape[:2]
    ys = np.arange(h, dtype=np.int32)[:, None] // cell
    xs = np.arange(w, dtype=np.int32)[None, :] // cell
    odd = ((xs + ys) % 2) == 0
    bg = np.empty((h, w, 3), dtype=np.uint8)
    bg[odd] = [210, 210, 210]
    bg[~odd] = [130, 130, 130]
    bg_bgr = cv2.cvtColor(bg, cv2.COLOR_RGB2BGR)
    a = bgra[:, :, 3:4].astype(np.float32) / 255.0
    bgr_f = bgra[:, :, :3].astype(np.float32)
    out = bgr_f * a + bg_bgr.astype(np.float32) * (1.0 - a)
    return np.clip(out, 0, 255).astype(np.uint8)


class ImportDialog(QDialog):
    """Modal dialog for importing frames from a video into a VideoSource."""

    frames_imported = Signal(str)  # video_id

    def __init__(self, workspace: Workspace,
                 video_source: Optional[VideoSource] = None,
                 parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("导入工具 — 视频抽帧")
        self.resize(960, 720)

        self._workspace = workspace
        self._video_source = video_source
        self._video_path: Optional[str] = None
        self._duration_sec = 0.0
        self._source_fps = 30.0
        self._chroma_key_rgb: Tuple[int, int, int] = (255, 255, 255)
        self._chroma_orig_bgr: Optional[np.ndarray] = None
        self._chroma_pick_from_orig = False
        self._loop_seek_guard = False

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

        self._build_ui()
        self._connect_signals()

        if video_source is not None:
            self._prefill_from_source(video_source)

    def _build_ui(self) -> None:
        root = QVBoxLayout(self)

        # -- Video file --
        gb_file = QGroupBox("视频文件")
        fl = QVBoxLayout(gb_file)
        hl_f = QHBoxLayout()
        self.btn_open = QPushButton("选择视频...")
        self.btn_open.clicked.connect(self._open_video)
        hl_f.addWidget(self.btn_open)
        self.lbl_video = QLabel("未加载")
        self.lbl_video.setWordWrap(True)
        hl_f.addWidget(self.lbl_video, 1)
        fl.addLayout(hl_f)
        self.video_widget = QVideoWidget()
        self.video_widget.setMinimumSize(320, 200)
        self.video_widget.setMaximumHeight(320)
        self.video_widget.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Maximum)
        self.video_widget.setStyleSheet("background:#111;")
        self._player.setVideoOutput(self.video_widget)
        fl.addWidget(self.video_widget)
        root.addWidget(gb_file)

        # -- Time range --
        gb_range = QGroupBox("时间区间")
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
        self.cb_loop = QCheckBox("到 t1 后循环回 t0")
        self.cb_loop.setChecked(True)
        hl_play.addWidget(self.cb_loop)
        self.cb_mute = QCheckBox("静音")
        self.cb_mute.setChecked(True)
        self.cb_mute.toggled.connect(lambda on: self._audio.setVolume(0.0 if on else 1.0))
        hl_play.addWidget(self.cb_mute)
        hl_play.addStretch()
        v_range.addLayout(hl_play)
        root.addWidget(gb_range)

        # -- Chroma key --
        gb_chroma = QGroupBox("色键")
        form_c = QFormLayout(gb_chroma)
        self.cb_chroma = QCheckBox("启用色键")
        self.cb_chroma.toggled.connect(lambda: self._schedule_chroma())
        form_c.addRow(self.cb_chroma)
        hl_key = QHBoxLayout()
        self._lbl_swatch = QLabel()
        self._lbl_swatch.setFixedSize(40, 22)
        self._lbl_rgb_text = QLabel("255, 255, 255")
        self._lbl_rgb_text.setStyleSheet("color:#ccc;")
        btn_color = QPushButton("选择颜色...")
        btn_color.clicked.connect(self._on_color_dialog)
        self.btn_dropper = QPushButton("从原图吸色")
        self.btn_dropper.setCheckable(True)
        self.btn_dropper.toggled.connect(self._on_dropper_toggled)
        hl_key.addWidget(self._lbl_swatch)
        hl_key.addWidget(self._lbl_rgb_text)
        hl_key.addWidget(btn_color)
        hl_key.addWidget(self.btn_dropper)
        hl_key.addStretch()
        form_c.addRow("关键色", hl_key)
        self.sp_tol = QDoubleSpinBox()
        self.sp_tol.setRange(1, 255)
        self.sp_tol.setValue(40)
        self.sp_tol.valueChanged.connect(lambda: self._schedule_chroma())
        form_c.addRow("容差", self.sp_tol)
        hl_prev = QHBoxLayout()
        self.lbl_orig = QLabel("原图")
        self.lbl_orig.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_orig.setStyleSheet("background:#1a1a1a;border:1px solid #444;")
        self.lbl_orig.setFixedSize(180, 140)
        self.lbl_orig.installEventFilter(self)
        self.lbl_keyed = QLabel("色键结果")
        self.lbl_keyed.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_keyed.setStyleSheet("background:#1a1a1a;border:1px solid #444;")
        self.lbl_keyed.setMinimumSize(280, 200)
        hl_prev.addWidget(self.lbl_orig, 0)
        hl_prev.addWidget(self.lbl_keyed, 1)
        form_c.addRow(hl_prev)
        self._apply_swatch()
        root.addWidget(gb_chroma)

        # -- Extraction --
        gb_ext = QGroupBox("抽取设置")
        form_e = QFormLayout(gb_ext)
        self.sp_fps = QDoubleSpinBox()
        self.sp_fps.setDecimals(2)
        self.sp_fps.setRange(0.5, 120)
        self.sp_fps.setValue(12)
        form_e.addRow("导出动画 frameRate", self.sp_fps)
        self.sp_max = QSpinBox()
        self.sp_max.setRange(1, 9999)
        self.sp_max.setValue(12)
        form_e.addRow("抽取帧数", self.sp_max)
        root.addWidget(gb_ext)

        # -- Buttons --
        hl_btn = QHBoxLayout()
        self.btn_extract = QPushButton("抽取并添加到帧库")
        self.btn_extract.setEnabled(False)
        self.btn_extract.clicked.connect(self._do_extract)
        hl_btn.addWidget(self.btn_extract)
        btn_close = QPushButton("关闭")
        btn_close.clicked.connect(self.close)
        hl_btn.addWidget(btn_close)
        hl_btn.addStretch()
        root.addLayout(hl_btn)

        self.lbl_status = QLabel("")
        self.lbl_status.setWordWrap(True)
        root.addWidget(self.lbl_status)

    def _connect_signals(self) -> None:
        self._player.playbackStateChanged.connect(self._on_playback_state)
        self._player.durationChanged.connect(self._on_duration)
        self._player.errorOccurred.connect(
            lambda _e, s: QMessageBox.warning(self, "播放器", s or "无法播放"))
        self._player.positionChanged.connect(self._on_position)

    def _prefill_from_source(self, vs: VideoSource) -> None:
        path = vs.source_path
        if path and Path(path).is_file():
            self._load_video(path)
        if vs.chroma_params is not None:
            cp = vs.chroma_params
            self.cb_chroma.setChecked(cp.enabled)
            self._chroma_key_rgb = cp.key_rgb
            self.sp_tol.setValue(cp.tolerance)
            self._apply_swatch()

    # -- Video loading -------------------------------------------------------

    def _open_video(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择视频", "",
            "视频 (*.mp4 *.webm *.mov *.avi *.mkv);;所有文件 (*)")
        if path:
            self._load_video(str(Path(path).resolve()))

    def _load_video(self, abs_path: str) -> None:
        self._player.stop()
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
        self.lbl_video.setText(f"{abs_path}\n时长 {dur:.2f}s  FPS {fps:.2f}")
        self.btn_extract.setEnabled(True)
        QTimer.singleShot(200, self._schedule_chroma)

    # -- Playback range ------------------------------------------------------

    def _t0_t1(self) -> Tuple[float, float]:
        t0, t1 = self.range_bar.range_sec()
        return (t0, t1) if t0 <= t1 else (t1, t0)

    def _update_range_label(self) -> None:
        t0, t1 = self.range_bar.range_sec()
        self.lbl_range.setText(f"t0: {t0:.3f}s   t1: {t1:.3f}s   总长 {self._duration_sec:.3f}s")

    def _on_loop_range_changed(self, _t0: float, _t1: float) -> None:
        self._update_range_label()
        self._schedule_chroma()
        self._clamp_playhead()

    def _toggle_play(self) -> None:
        if not self._video_path:
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

    def _on_playback_state(self, state: QMediaPlayer.PlaybackState) -> None:
        if state == QMediaPlayer.PlaybackState.PlayingState:
            self.btn_play.setText("暂停")
            self._loop_poll_timer.start()
        else:
            self.btn_play.setText("播放")
            self._loop_poll_timer.stop()
            self._schedule_chroma()

    def _on_duration(self, ms: int) -> None:
        if ms <= 0:
            return
        d = ms / 1000.0
        self._duration_sec = d
        self.range_bar.set_duration_sec(d)
        self._update_range_label()

    def _on_position(self, _pos: int) -> None:
        if self._player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
            return
        self._schedule_chroma()

    def _clamp_playhead(self) -> None:
        if not self._video_path:
            return
        t0, t1 = self._t0_t1()
        if t1 <= t0:
            return
        pos = self._player.position()
        self._loop_seek_guard = True
        if pos < int(t0 * 1000):
            self._player.setPosition(int(t0 * 1000))
        elif pos > int(t1 * 1000):
            if self.cb_loop.isChecked():
                self._player.setPosition(int(t0 * 1000))
            else:
                self._player.setPosition(int(t1 * 1000))
                self._player.pause()
        self._loop_seek_guard = False

    def _tick_playback_range(self) -> None:
        if self._loop_seek_guard or not self._video_path:
            return
        if self._player.playbackState() != QMediaPlayer.PlaybackState.PlayingState:
            return
        t0, t1 = self._t0_t1()
        if t1 <= t0:
            return
        t1_ms = int(t1 * 1000)
        t0_ms = int(t0 * 1000)
        pos = self._player.position()
        lead_ms = min(120, max(20, int(1000 / max(self._source_fps, 1) * 1.75)))
        boundary = t1_ms - lead_ms
        if boundary <= t0_ms:
            boundary = t0_ms + max(1, (t1_ms - t0_ms) // 4)
        if pos >= boundary:
            self._loop_seek_guard = True
            if self.cb_loop.isChecked():
                self._player.setPosition(t0_ms)
            else:
                self._player.setPosition(t1_ms)
                self._player.pause()
            QTimer.singleShot(80, self._release_guard)

    def _release_guard(self) -> None:
        self._loop_seek_guard = False

    # -- Chroma key ----------------------------------------------------------

    def _chroma_params(self) -> Tuple[bool, Tuple[int, int, int], float]:
        return self.cb_chroma.isChecked(), self._chroma_key_rgb, float(self.sp_tol.value())

    def _apply_swatch(self) -> None:
        r, g, b = self._chroma_key_rgb
        self._lbl_swatch.setStyleSheet(
            f"background-color: rgb({r},{g},{b}); border: 1px solid #666;")
        self._lbl_rgb_text.setText(f"{r}, {g}, {b}")

    def _set_key_rgb(self, rgb: Tuple[int, int, int]) -> None:
        self._chroma_key_rgb = (max(0, min(255, rgb[0])),
                                max(0, min(255, rgb[1])),
                                max(0, min(255, rgb[2])))
        self._apply_swatch()
        self._schedule_chroma()

    def _on_color_dialog(self) -> None:
        if self.btn_dropper.isChecked():
            self.btn_dropper.setChecked(False)
        r, g, b = self._chroma_key_rgb
        c = QColorDialog.getColor(QColor(r, g, b), self, "关键色")
        if c.isValid():
            self._set_key_rgb((c.red(), c.green(), c.blue()))

    def _on_dropper_toggled(self, on: bool) -> None:
        self._chroma_pick_from_orig = on
        self.lbl_orig.setCursor(
            Qt.CursorShape.CrossCursor if on else Qt.CursorShape.ArrowCursor)

    def eventFilter(self, watched, event) -> bool:
        if watched is self.lbl_orig and self._chroma_pick_from_orig:
            from PySide6.QtCore import QEvent
            if event.type() == QEvent.Type.MouseButtonPress:
                if isinstance(event, QMouseEvent) and event.button() == Qt.MouseButton.LeftButton:
                    rgb = self._pick_pixel(event.pos())
                    if rgb is not None:
                        self._set_key_rgb(rgb)
                    self.btn_dropper.setChecked(False)
                    return True
        return super().eventFilter(watched, event)

    def _pick_pixel(self, pos) -> Optional[Tuple[int, int, int]]:
        if self._chroma_orig_bgr is None:
            return None
        pm = self.lbl_orig.pixmap()
        if pm is None or pm.isNull():
            return None
        iw, ih = self._chroma_orig_bgr.shape[1], self._chroma_orig_bgr.shape[0]
        pw, ph = pm.width(), pm.height()
        lw, lh = self.lbl_orig.width(), self.lbl_orig.height()
        x0 = (lw - pw) // 2
        y0 = (lh - ph) // 2
        x = int(pos.x()) - x0
        y = int(pos.y()) - y0
        if x < 0 or y < 0 or x >= pw or y >= ph:
            return None
        ix = max(0, min(iw - 1, int(round(x * iw / max(1, pw)))))
        iy = max(0, min(ih - 1, int(round(y * ih / max(1, ph)))))
        b0, g0, r0 = self._chroma_orig_bgr[iy, ix]
        return int(r0), int(g0), int(b0)

    def _schedule_chroma(self) -> None:
        self._chroma_debounce.start()

    def _run_chroma_preview(self) -> None:
        if not self._video_path:
            self.lbl_orig.setText("原图")
            self.lbl_keyed.setText("色键结果")
            return
        t = max(0.0, self._player.position() / 1000.0)
        cap = cv2.VideoCapture(self._video_path)
        if not cap.isOpened():
            return
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ret, bgr = cap.read()
        cap.release()
        if not ret or bgr is None:
            return
        self._chroma_orig_bgr = bgr.copy()
        po = _bgr_to_qpixmap(bgr)
        so = po.scaled(180, 140, Qt.AspectRatioMode.KeepAspectRatio,
                       Qt.TransformationMode.FastTransformation)
        self.lbl_orig.setPixmap(so)
        ce, rgb, tol = self._chroma_params()
        bgra = bgr_to_rgba_frame(bgr, ce, rgb, tol)
        comp = _composite_checkerboard_bgra(bgra)
        pk = _bgr_to_qpixmap(comp)
        sk = pk.scaled(480, 360, Qt.AspectRatioMode.KeepAspectRatio,
                       Qt.TransformationMode.SmoothTransformation)
        self.lbl_keyed.setPixmap(sk)

    # -- Extraction ----------------------------------------------------------

    def _do_extract(self) -> None:
        if not self._video_path:
            QMessageBox.information(self, "提示", "请先选择视频")
            return
        t0, t1 = self._t0_t1()
        ce, rgb, tol = self._chroma_params()
        try:
            rgba_list, times = decode_segment_rgba_frames(
                self._video_path, t0, t1,
                float(self.sp_fps.value()),
                int(self.sp_max.value()),
                ce, rgb, tol)
        except Exception as e:
            QMessageBox.critical(self, "提取失败", str(e))
            return
        if not rgba_list:
            QMessageBox.warning(self, "提示", "未解码到任何帧")
            return

        if self._video_source is None:
            base = Path(self._video_path).stem
            dn = self._workspace.generate_display_name(base)
            vs = VideoSource(
                video_id=new_id(),
                source_path=self._video_path,
                display_name=dn,
                duration_sec=self._duration_sec,
                fps=self._source_fps,
            )
            self._workspace.add_video_source(vs)
            self._video_source = vs

        cp = ChromaParams(enabled=ce, key_rgb=rgb, tolerance=tol)
        self._video_source.chroma_params = cp

        items = []
        for rgba, t in zip(rgba_list, times):
            items.append(FrameItem(id=new_id(), video_id=self._video_source.video_id,
                                   rgba=rgba, t_sec=float(t)))
        self._workspace.append_frames_to_video(self._video_source.video_id, items)

        self.lbl_status.setText(
            f"已追加 {len(items)} 帧到 {self._video_source.display_name}  "
            f"(库中共 {len(self._video_source.frame_ids)} 帧)")
        self.frames_imported.emit(self._video_source.video_id)

    def closeEvent(self, event) -> None:
        self._loop_poll_timer.stop()
        self._player.stop()
        super().closeEvent(event)
