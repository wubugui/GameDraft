"""预览：图像 QImageReader、视频 QVideoWidget+QMediaPlayer、文本 QFile、音频 QMediaPlayer。图像解码在子线程。"""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import (
    QFile,
    QIODevice,
    QThread,
    QObject,
    QSize,
    QUrl,
    Qt,
    Slot,
    Signal,
)
from PySide6.QtGui import QImage, QImageReader, QPixmap
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtMultimediaWidgets import QVideoWidget
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QScrollArea,
    QStackedWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

_MAX = QSize(1600, 1200)
_MAX_TEXT = 500_000
_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tga"}
_VIDEO_EXT = {".mp4", ".webm", ".mov", ".avi", ".mkv"}
_AUDIO_EXT = {".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac"}
_TEXT_EXT = {
    ".json", ".txt", ".md", ".xml", ".csv", ".ink", ".html", ".htm", ".css",
    ".ts", ".tsx", ".js", ".mjs", ".yml", ".yaml",
}
PREVIEW_PREFERRED = _IMAGE_EXT | _VIDEO_EXT | _TEXT_EXT | _AUDIO_EXT


def _load_image(path: str) -> QImage | None:
    r = QImageReader(path)
    r.setAutoTransform(True)
    sz = r.size()
    if sz.isValid():
        r.setScaledSize(sz.boundedTo(_MAX))
    else:
        r.setScaledSize(_MAX)
    out = r.read()
    if out.isNull():
        return None
    return out


def _read_text_file(path: str) -> str:
    f = QFile(path)
    if not f.open(QIODevice.OpenModeFlag.ReadOnly):
        return f"无法打开: {path}"
    data = f.read(_MAX_TEXT * 2)
    f.close()
    if not data:
        return ""
    raw = bytes(data)
    for enc in ("utf-8", "utf-8-sig", "gbk", "cp936", "latin-1"):
        try:
            t = raw.decode(enc, errors="strict")
            if len(t) > 400_000:
                t = t[:400_000] + "\n[…已截断]"
            return t
        except UnicodeDecodeError:
            continue
    t = raw.decode("utf-8", errors="replace")
    if len(t) > 400_000:
        t = t[:400_000] + "\n[…已截断]"
    return t


def _fallback_text(p: Path) -> str:
    try:
        n = p.stat().st_size
    except OSError as e:
        return f"无法统计: {e}"
    return f"(无内置预览) {p.name}\n大小 {n} 字节\n\n{p.as_posix()}"


class PreviewWorker(QObject):
    result = Signal(int, str, object)
    work = Signal(int, str)

    def __init__(self) -> None:
        super().__init__()
        self.work.connect(self._run, Qt.ConnectionType.QueuedConnection)

    @Slot(int, str)
    def _run(self, seq: int, path: str) -> None:  # noqa: N802
        p = Path(path)
        ext = p.suffix.lower()
        if not p.is_file():
            self.result.emit(
                seq, path, ("text", f"非文件或不存在:\n{path}")
            )
            return
        if ext in _IMAGE_EXT:
            im = _load_image(str(p))
            if im is not None and not im.isNull():
                self.result.emit(seq, path, ("image", im))
                return
        if ext in _TEXT_EXT:
            self.result.emit(
                seq, path, ("text", _read_text_file(str(p)))
            )
            return
        if ext in _AUDIO_EXT:
            self.result.emit(seq, path, ("audio", str(p)))
            return
        self.result.emit(
            seq, path, ("text", _fallback_text(p))
        )


class PreviewPanel(QWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._seq = 0
        self._thread = QThread()
        self._worker = PreviewWorker()
        self._worker.moveToThread(self._thread)
        self._worker.result.connect(
            self._on_result, Qt.ConnectionType.QueuedConnection
        )
        self._thread.start()

        self._status = QLabel("")
        self._status.setWordWrap(True)
        self._img = QLabel()
        self._img.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._img.setMinimumSize(200, 160)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setWidget(self._img)
        self._text = QTextEdit()
        self._text.setReadOnly(True)
        self._stack = QStackedWidget()
        self._stack.addWidget(scroll)
        self._stack.addWidget(self._text)
        self._stack.addWidget(self._empty_audio_page())
        self._video = QVideoWidget()
        self._video.setMinimumSize(200, 160)
        self._vplayer: QMediaPlayer | None = None
        self._stack.addWidget(self._video)
        v = QVBoxLayout(self)
        v.addWidget(self._status, 0)
        v.addWidget(self._stack, 1)
        v.setStretch(1, 1)
        self._player: QMediaPlayer | None = None
        self._audio_out: QAudioOutput | None = None

    def shutdown(self) -> None:
        """窗口关闭时显式停止后台预览线程，避免 Qt 退出时报线程仍在运行。"""
        self._seq += 1
        self._stop_video()
        if self._player:
            self._player.stop()
            self._player = None
        if self._thread.isRunning():
            self._thread.quit()
            self._thread.wait(2000)

    def closeEvent(self, event) -> None:  # noqa: N802, ANN001
        self.shutdown()
        super().closeEvent(event)

    def _empty_audio_page(self) -> QWidget:
        w = QWidget()
        h = QHBoxLayout(w)
        self._btn_play = QPushButton("播放 / 停止")
        self._btn_play.clicked.connect(self._toggle_audio)
        self._lbl_audio = QLabel("音频")
        h.addWidget(self._btn_play)
        h.addWidget(self._lbl_audio, 1)
        return w

    def _stop_video(self) -> None:
        if self._vplayer is not None:
            self._vplayer.stop()
            self._vplayer = None
        if self._video is not None:
            self._video.setVisible(False)

    def _on_result(self, seq: int, path: str, payload: object) -> None:
        if seq != self._seq:
            return
        if not isinstance(payload, tuple) or len(payload) < 2:
            return
        kind, data = payload[0], payload[1]
        self._status.setText(path)
        if self._player and kind != "audio":
            self._player.stop()
        if kind in ("image",) and isinstance(data, QImage):
            self._stop_video()
            self._img.setPixmap(QPixmap.fromImage(data))
            self._stack.setCurrentIndex(0)
        elif kind == "text":
            self._stop_video()
            self._text.setPlainText(str(data))
            self._stack.setCurrentIndex(1)
        elif kind == "audio" and isinstance(data, str):
            self._stop_video()
            self._lbl_audio.setText(Path(data).name)
            self._player = QMediaPlayer()
            self._audio_out = QAudioOutput()
            self._player.setAudioOutput(self._audio_out)
            self._player.setSource(QUrl.fromLocalFile(data))
            self._stack.setCurrentIndex(2)
        else:
            self._stop_video()
            self._text.setPlainText(str(data))
            self._stack.setCurrentIndex(1)

    def _show_video_path(self, file_path: str, status_path: str) -> None:
        self._status.setText(status_path)
        self._stop_video()
        self._vplayer = QMediaPlayer()
        self._vplayer.setVideoOutput(self._video)
        self._vplayer.setSource(QUrl.fromLocalFile(file_path))
        m = getattr(self._vplayer, "setMuted", None)
        if callable(m):
            m(True)
        self._video.setVisible(True)
        self._stack.setCurrentIndex(3)
        self._vplayer.play()

    def _toggle_audio(self) -> None:
        if not self._player:
            return
        if self._player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
            self._player.stop()
        else:
            self._player.play()

    def set_selection(
        self,
        paths: list[str],
        *,
        primary_preview_path: str | None,
    ) -> None:
        self._seq += 1
        my = self._seq
        n = len(paths)
        self._stop_video()
        if self._player:
            self._player.stop()
        if n == 0:
            self._status.setText("无选择。")
            self._stack.setCurrentIndex(1)
            self._text.setPlainText("")
            return
        if n == 1:
            self._status.setText("1 项")
        else:
            self._status.setText(
                f"已选 {n} 项。预览为下列第一个可解析文件。"
            )
        if not primary_preview_path:
            self._text.setPlainText("当前选中项中无单文件以预览。")
            self._stack.setCurrentIndex(1)
            return
        if self._player:
            self._player.stop()
        ext = Path(primary_preview_path).suffix.lower()
        if ext in _VIDEO_EXT:
            self._show_video_path(primary_preview_path, primary_preview_path)
            return
        self._worker.work.emit(my, primary_preview_path)
