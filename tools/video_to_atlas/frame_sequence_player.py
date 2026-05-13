"""Reusable frame sequence player: drives QTimer, emits QPixmap per tick."""
from __future__ import annotations

from collections import OrderedDict
from typing import TYPE_CHECKING, List, Optional, Tuple

import cv2
import numpy as np
from PySide6.QtCore import QObject, Qt, QElapsedTimer, QTimer, Signal
from PySide6.QtGui import QImage, QPixmap

if TYPE_CHECKING:
    from .workspace_model import SlotRef, Workspace

# 与 Game.tick 一致，避免一帧卡死后 dt 爆炸、一次跳过多格只画最后一帧
_MAX_DT_SEC = 0.1
# 缩放后的 QPixmap 缓存（按帧 id + 显示参数）；循环播放时命中率高
_PIX_CACHE_MAX = 384


def _poll_interval_ms(fps: float) -> int:
    fps = max(1e-6, float(fps))
    ideal = 1000.0 / fps / 3.0
    return max(4, min(16, int(round(ideal))))


def _bgra_to_qpixmap_zero_copy_copy(bgra: np.ndarray) -> QPixmap:
    """
    OpenCV BGRA 与 Qt Format_ARGB32 在小端机器上内存字节序均为 B,G,R,A。
    copy() 脱离 numpy 缓冲区生命周期。
    """
    if bgra.ndim != 3 or bgra.shape[2] != 4:
        raise ValueError("expected HxWx4 BGRA")
    bgra = np.ascontiguousarray(bgra)
    h, w = bgra.shape[:2]
    qimg = QImage(bgra.data, w, h, w * 4, QImage.Format.Format_ARGB32)
    return QPixmap.fromImage(qimg.copy())


def _bgr_to_qpixmap_rgb888(bgr: np.ndarray) -> QPixmap:
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]
    rgb = np.ascontiguousarray(rgb)
    qimg = QImage(rgb.data, w, h, w * 3, QImage.Format.Format_RGB888)
    return QPixmap.fromImage(qimg.copy())


def _composite_checkerboard(bgra: np.ndarray, cell: int = 12) -> np.ndarray:
    h, w = bgra.shape[:2]
    ys = np.arange(h, dtype=np.int32)[:, None] // cell
    xs = np.arange(w, dtype=np.int32)[None, :] // cell
    odd = ((xs + ys) % 2) == 0
    bg = np.empty((h, w, 3), dtype=np.uint8)
    bg[odd] = [210, 210, 210]
    bg[~odd] = [130, 130, 130]
    bg_bgr = cv2.cvtColor(bg, cv2.COLOR_RGB2BGR)
    a = bgra[:, :, 3:4].astype(np.float32) / 255.0
    bgr = bgra[:, :, :3].astype(np.float32)
    out = bgr * a + bg_bgr.astype(np.float32) * (1.0 - a)
    return np.clip(out, 0, 255).astype(np.uint8)


class FrameSequencePlayer(QObject):
    """Plays a list of SlotRef through a Workspace, emitting pixmaps."""

    frame_changed = Signal(QPixmap, int)  # pixmap, current_index

    def __init__(self, parent: Optional[QObject] = None) -> None:
        super().__init__(parent)
        self._workspace: Optional[Workspace] = None
        self._slots: List[SlotRef] = []
        self._fps: float = 12.0
        self._loop: bool = True
        self._index: int = 0
        self._playing: bool = False
        self._max_display_w: int = 400
        self._max_display_h: int = 400
        self._checkerboard: bool = True
        self._accum: float = 0.0
        self._elapsed = QElapsedTimer()
        self._emit_fast: bool = False
        self._pix_cache: OrderedDict[Tuple, QPixmap] = OrderedDict()

        self._timer = QTimer(self)
        self._timer.setTimerType(Qt.TimerType.CoarseTimer)
        self._timer.timeout.connect(self._tick)

    def _invalidate_pix_cache(self) -> None:
        self._pix_cache.clear()

    def set_source(self, workspace: Workspace, slots: List[SlotRef],
                   fps: float = 12.0, loop: bool = True) -> None:
        self.stop()
        self._invalidate_pix_cache()
        self._workspace = workspace
        self._slots = list(slots)
        self._fps = max(1e-6, float(fps))
        self._loop = loop
        self._index = 0
        self._accum = 0.0

    def set_display_size(self, w: int, h: int) -> None:
        nw, nh = max(64, w), max(64, h)
        if nw != self._max_display_w or nh != self._max_display_h:
            self._invalidate_pix_cache()
        self._max_display_w = nw
        self._max_display_h = nh

    def set_checkerboard(self, on: bool) -> None:
        if bool(on) != self._checkerboard:
            self._invalidate_pix_cache()
        self._checkerboard = on

    def play(self) -> None:
        if not self._slots or self._workspace is None:
            return
        self._playing = True
        self._emit_fast = True
        self._accum = 0.0
        self._elapsed.start()
        self._emit_current()
        self._timer.start(_poll_interval_ms(self._fps))

    def apply_fps_loop(self, fps: float, loop: bool) -> None:
        self._fps = max(1e-6, float(fps))
        self._loop = loop
        if self._playing and self._slots and self._workspace is not None:
            self._timer.setInterval(_poll_interval_ms(self._fps))

    def stop(self) -> None:
        self._playing = False
        self._emit_fast = False
        self._timer.stop()
        self._accum = 0.0

    def is_playing(self) -> bool:
        return self._playing

    def show_frame(self, index: int) -> None:
        if not self._slots or self._workspace is None:
            return
        index = max(0, min(index, len(self._slots) - 1))
        self._index = index
        self._emit_current()

    def _cache_get(self, key: Tuple) -> Optional[QPixmap]:
        pix = self._pix_cache.get(key)
        if pix is None:
            return None
        self._pix_cache.move_to_end(key)
        return pix

    def _cache_put(self, key: Tuple, pix: QPixmap) -> None:
        if key in self._pix_cache:
            del self._pix_cache[key]
        self._pix_cache[key] = pix
        while len(self._pix_cache) > _PIX_CACHE_MAX:
            self._pix_cache.popitem(last=False)

    def _tick(self) -> None:
        if not self._slots or self._workspace is None:
            self.stop()
            return
        if not self._playing:
            return
        dt = self._elapsed.restart() / 1000.0
        if dt < 0:
            dt = 0.0
        dt = min(dt, _MAX_DT_SEC)
        self._accum += dt
        step = 1.0 / self._fps
        progressed = False
        while self._accum >= step and self._playing:
            self._accum -= step
            self._advance()
            progressed = True
        if progressed:
            self._emit_current()

    def _advance(self) -> None:
        start = self._index
        n = len(self._slots)
        for _ in range(n):
            self._index += 1
            if self._index >= n:
                if self._loop:
                    self._index = 0
                else:
                    self._index = n - 1
                    self.stop()
                    return
            slot = self._slots[self._index]
            if slot.frame_id in self._workspace._frame_store:
                return
        self._index = start

    def _emit_current(self) -> None:
        if not self._slots or self._workspace is None:
            return
        slot = self._slots[self._index]
        item = self._workspace._frame_store.get(slot.frame_id)
        if item is None:
            return
        fast = self._emit_fast
        use_checkerboard = self._checkerboard and not fast
        qual_fast = 1 if fast else 0
        cache_mode = "cb" if use_checkerboard else "argb"
        cache_key = (
            slot.frame_id,
            slot.flip_h,
            self._max_display_w,
            self._max_display_h,
            cache_mode,
            qual_fast,
        )
        cached = self._cache_get(cache_key)
        if cached is not None:
            self.frame_changed.emit(cached, self._index)
            return

        from .atlas_core import flip_bgra_horizontal
        bgra = item.rgba
        if bgra.ndim == 2 or (bgra.ndim == 3 and bgra.shape[2] == 1):
            return
        if bgra.shape[2] == 3:
            bgra = cv2.cvtColor(bgra, cv2.COLOR_BGR2BGRA)
        if slot.flip_h:
            bgra = flip_bgra_horizontal(bgra)

        if use_checkerboard:
            bgr = _composite_checkerboard(bgra)
            pix = _bgr_to_qpixmap_rgb888(bgr)
        else:
            pix = _bgra_to_qpixmap_zero_copy_copy(bgra)

        xform = (
            Qt.TransformationMode.FastTransformation
            if fast
            else Qt.TransformationMode.SmoothTransformation
        )
        scaled = pix.scaled(
            self._max_display_w,
            self._max_display_h,
            Qt.AspectRatioMode.KeepAspectRatio,
            xform,
        )
        self._cache_put(cache_key, scaled)
        self.frame_changed.emit(scaled, self._index)
