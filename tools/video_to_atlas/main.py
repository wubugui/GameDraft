"""启动 GUI。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# 先于 Qt / OpenCV / 解码库加载：减轻循环 seek 时 H.264/FFmpeg 刷 stderr
if sys.platform == "win32":
    # 优先走系统解码（WMF），通常不再走 libav，可避免反复 setPosition 时的提示
    os.environ.setdefault("QT_MEDIA_BACKEND", "windows")

os.environ.setdefault("OPENCV_LOG_LEVEL", "SILENT")
os.environ.setdefault("AV_LOG_LEVEL", "quiet")


class _StderrFilter:
    """丢弃 libav 在循环定位时常见的「请上传样本」等噪声行。"""

    _SKIP = (
        "videolan.org",
        "ffmpeg-devel",
        "If you want to help, upload a sample",
    )

    def __init__(self, underlying: object) -> None:
        self._u = underlying
        self._buf = ""

    def write(self, s: str) -> int:
        if not s:
            return 0
        self._buf += s
        text = self._buf.replace("\r\n", "\n").replace("\r", "\n")
        if "\n" not in text:
            return len(s)
        lines = text.split("\n")
        self._buf = lines.pop() or ""
        for line in lines:
            if line.strip() and not any(k in line for k in self._SKIP):
                self._u.write(line + "\n")
        return len(s)

    def flush(self) -> None:
        if self._buf.strip():
            line = self._buf
            self._buf = ""
            if not any(k in line for k in self._SKIP):
                self._u.write(line)
        self._u.flush()

    def __getattr__(self, name: str):
        return getattr(self._u, name)


if hasattr(sys, "__stderr__") and sys.__stderr__ is not None:
    sys.stderr = _StderrFilter(sys.__stderr__)

from PySide6.QtWidgets import QApplication

import cv2

try:
    cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_SILENT)
except Exception:
    pass

from main_window import MainWindow


def main() -> None:
    app = QApplication(sys.argv)
    init_ws: Path | None = None
    if len(sys.argv) > 1 and sys.argv[1].strip():
        init_ws = Path(sys.argv[1]).expanduser()
    win = MainWindow(initial_workspace=init_ws)
    win.show()
    raise SystemExit(app.exec())


if __name__ == "__main__":
    main()
