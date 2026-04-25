"""后台缩略图：磁盘缓存 + QRunnable；用信号将结果交回主线程。"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

from PySide6.QtCore import QObject, QRunnable, QThreadPool, QSize, Signal, Slot
from PySide6.QtGui import QIcon, QImage, QImageReader, QPixmap

_CACHE_DIR: Path | None = None


def _cache_dir() -> Path:
    global _CACHE_DIR
    if _CACHE_DIR is None:
        root = Path(__file__).resolve().parents[2]
        _CACHE_DIR = root / "editor_data" / "asset_browser_cache"
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return _CACHE_DIR


def _cache_key(path: str, mtime: float | None, size: int) -> str:
    m = mtime if mtime is not None else -1.0
    raw = f"{os.path.normcase(path)}|{m}|{size}".encode("utf-8", errors="replace")
    return hashlib.sha256(raw).hexdigest()


def cache_file_for(path: str, mtime: float | None, size: int) -> Path:
    return _cache_dir() / f"{_cache_key(path, mtime, size)}.png"


def make_thumb_image(file_path: str, max_side: int) -> QImage | None:
    p = Path(file_path)
    if p.is_dir():
        return None
    r = QImageReader(str(p))
    r.setAutoTransform(True)
    r.setDecideFormatFromContent(True)
    sz = r.size()
    if not sz.isValid():
        t = max(32, int(max_side))
        r.setScaledSize(QSize(t, t))
    else:
        w, h = sz.width(), sz.height()
        m = max(w, h, 1)
        scale = min(1.0, float(max_side) / float(m))
        r.setScaledSize(QSize(int(w * scale) or 1, int(h * scale) or 1))
    im = r.read()
    if im.isNull():
        return None
    return im


class ThumbnailService(QObject):
    """请求缩略图，完成后发 thumbReady(row, QIcon, path)。"""

    thumbReady = Signal(int, QIcon, str)
    _workerDone = Signal(int, int, int, QImage, str, float, int)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._pool = QThreadPool(self)
        self._pool.setMaxThreadCount(4)
        self._gen = 0
        self._size = 96
        self._workerDone.connect(self._deliver)

    def set_thumb_size(self, n: int) -> None:
        self._size = max(32, min(256, int(n)))

    @property
    def generation(self) -> int:
        return self._gen

    def bump_generation(self) -> int:
        self._gen += 1
        return self._gen

    def request_for_row(
        self,
        gen: int,
        row: int,
        file_path: str,
        mtime: float | None,
        size: int,
    ) -> None:
        if gen != self._gen:
            return
        p = Path(file_path)
        if p.is_dir():
            return
        cf = cache_file_for(file_path, mtime, size)
        if cf.is_file():
            im = QImage(str(cf))
            if not im.isNull():
                ic = QIcon(QPixmap.fromImage(im))
                if gen == self._gen:
                    self.thumbReady.emit(row, ic, file_path)
                return
        self._pool.start(
            _ThumbTask(
                gen, row, self._gen, str(p), mtime, size, self._size, self
            )
        )

    @Slot(int, int, int, QImage, str, float, int)
    def _deliver(
        self,
        task_gen: int,
        row: int,
        cur_gen: int,
        im: QImage,
        path: str,
        mtime: float,
        size: int,
    ) -> None:
        pstr = path
        if task_gen != self._gen or cur_gen != self._gen:
            return
        if im.isNull():
            return
        pm = QPixmap.fromImage(im)
        ic = QIcon(pm)
        mtime_use: float | None = mtime if mtime >= 0.0 else None
        if mtime_use is not None:
            cf = cache_file_for(pstr, mtime_use, size)
            im.save(str(cf), "PNG")
        self.thumbReady.emit(row, ic, pstr)


class _ThumbTask(QRunnable):
    def __init__(
        self,
        gen: int,
        row: int,
        current_gen: int,
        file_path: str,
        mtime: float | None,
        size: int,
        max_side: int,
        svc: ThumbnailService,
    ) -> None:
        super().__init__()
        self._gen = gen
        self._row = row
        self._g = current_gen
        self._path = file_path
        self._mtime = mtime
        self._size = size
        self._max = max_side
        self._svc = svc

    def run(self) -> None:
        if self._gen != self._g:
            return
        try:
            im = make_thumb_image(self._path, self._max)
        except OSError:
            im = None
        if im is None or im.isNull():
            return
        mt = self._mtime if self._mtime is not None else -1.0
        self._svc._workerDone.emit(  # noqa: SLF001
            self._gen,
            self._row,
            self._g,
            im,
            self._path,
            mt,
            self._size,
        )
