"""可复用的音频走带条：播放/暂停、停止、可拖进度、时间、音量、循环。

音频选择弹窗与音频配置编辑器共用这一条，避免「每处各写一个 ▶ 按钮」——
此前全项目的试听能力就是一个裸 ▶：不能停在中途、不能听后半段、不能调音量、
不能循环比对两条音效，挑 127 条 sfx 全靠反复重听开头。

QtMultimedia 缺席时整条禁用并说明原因（不假装能播）。
"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, QUrl, Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QHBoxLayout,
    QLabel,
    QSlider,
    QStyle,
    QWidget,
)

from .. import theme
from .qt_icon_buttons import outline_row_tool_button

try:
    from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
except Exception:  # pragma: no cover - 取决于本机 QtMultimedia 是否安装完整
    QAudioOutput = None  # type: ignore[misc,assignment]
    QMediaPlayer = None  # type: ignore[misc,assignment]

MULTIMEDIA_AVAILABLE = QMediaPlayer is not None and QAudioOutput is not None

_ICON_PLAY = "▶"
_ICON_PAUSE = "⏸"


def format_ms(ms: int) -> str:
    """毫秒 → ``0:01.2``（音效以十分之一秒为可辨粒度）。"""
    if ms < 0:
        ms = 0
    total = ms / 1000.0
    minutes = int(total // 60)
    rest = total - minutes * 60
    return f"{minutes}:{rest:04.1f}"


class AudioTransportBar(QWidget):
    """一条走带：只认「本地文件路径」，不关心 id/频道（那是调用方的事）。"""

    #: 播放彻底停止（用户按停 / 换源 / 自然播完且不循环）时发出。
    stopped = Signal()

    def __init__(self, parent: QWidget | None = None, *, compact: bool = False) -> None:
        super().__init__(parent)
        self._player: QMediaPlayer | None = None
        self._audio_out: QAudioOutput | None = None
        self._current: Path | None = None
        self._seeking = False
        self._duration_ms = 0

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(6)

        # QToolButton + 系统媒体图标：QPushButton 在 modern 主题下的内边距会把窄按钮里的
        # 字形挤没，且「■」在部分字体里退化成一根竖线。
        self._play_btn = outline_row_tool_button(
            self, "播放 / 暂停（空格）",
            std=QStyle.StandardPixmap.SP_MediaPlay, fallback_text=_ICON_PLAY,
            fixed_width=34, fixed_height=26,
        )
        self._stop_btn = outline_row_tool_button(
            self, "停止并回到开头",
            std=QStyle.StandardPixmap.SP_MediaStop, fallback_text="停",
            fixed_width=32, fixed_height=26,
        )
        self._icon_play = self._play_btn.icon()
        self._icon_pause = self.style().standardIcon(QStyle.StandardPixmap.SP_MediaPause)
        lay.addWidget(self._play_btn)
        lay.addWidget(self._stop_btn)

        self._pos = QSlider(Qt.Orientation.Horizontal, self)
        self._pos.setRange(0, 0)
        self._pos.setToolTip("拖动定位；听后半段不用从头等")
        lay.addWidget(self._pos, stretch=1)

        self._time = QLabel("0:00.0 / 0:00.0", self)
        self._time.setStyleSheet(theme.semantic_text_css("muted"))
        self._time.setMinimumWidth(96)
        lay.addWidget(self._time)

        self._loop = QCheckBox("循环", self)
        self._loop.setToolTip("循环播放；比对两条相似音效时打开")
        lay.addWidget(self._loop)

        if not compact:
            vol_label = QLabel("音量", self)
            vol_label.setStyleSheet(theme.semantic_text_css("muted"))
            lay.addWidget(vol_label)
        self._vol = QSlider(Qt.Orientation.Horizontal, self)
        self._vol.setRange(0, 100)
        self._vol.setValue(85)
        self._vol.setFixedWidth(80)
        self._vol.setToolTip("试听音量（只影响编辑器试听，不写进任何数据）")
        lay.addWidget(self._vol)

        self._hint = QLabel("", self)
        self._hint.setStyleSheet(theme.semantic_text_css("error"))
        self._hint.setVisible(False)
        lay.addWidget(self._hint)

        if not MULTIMEDIA_AVAILABLE:
            for w in (self._play_btn, self._stop_btn, self._pos, self._loop, self._vol):
                w.setEnabled(False)
            self._set_hint("当前环境无 QtMultimedia，无法试听（配置仍可照常编辑）")
            return

        self._audio_out = QAudioOutput(self)
        self._audio_out.setVolume(0.85)
        self._player = QMediaPlayer(self)
        self._player.setAudioOutput(self._audio_out)

        self._play_btn.clicked.connect(self.toggle)
        self._stop_btn.clicked.connect(self.stop)
        self._vol.valueChanged.connect(self._on_volume)
        self._pos.sliderPressed.connect(self._on_seek_begin)
        self._pos.sliderReleased.connect(self._on_seek_end)
        self._player.positionChanged.connect(self._on_position)
        self._player.durationChanged.connect(self._on_duration)
        self._player.playbackStateChanged.connect(self._on_state)
        self._player.mediaStatusChanged.connect(self._on_media_status)
        self._player.errorOccurred.connect(self._on_error)

    # ------------------------------------------------------------ 对外 API
    @property
    def current_path(self) -> Path | None:
        return self._current

    def set_loop(self, on: bool) -> None:
        self._loop.setChecked(bool(on))

    def play_file(self, path: Path | None, *, autoplay: bool = True) -> None:
        """换源并（默认）立刻播。``path=None`` 等同停止 + 提示不可播。"""
        self._set_hint("")
        if self._player is None:
            return
        if path is None:
            self._current = None
            self._player.stop()
            self._player.setSource(QUrl())
            self._pos.setRange(0, 0)
            self._time.setText("0:00.0 / 0:00.0")
            self._set_hint("该条目没有可播放的音频文件")
            return
        self._current = path
        self._player.stop()
        self._player.setSource(QUrl.fromLocalFile(str(path)))
        if autoplay:
            self._player.play()

    def toggle(self) -> None:
        if self._player is None:
            return
        if self._current is None:
            self._set_hint("先选中一条音频")
            return
        state = self._player.playbackState()
        if state == QMediaPlayer.PlaybackState.PlayingState:
            self._player.pause()
        else:
            self._player.play()

    def replay(self) -> None:
        """从头再放一次（列表里连按空格反复听同一条时用）。"""
        if self._player is None or self._current is None:
            return
        self._player.setPosition(0)
        self._player.play()

    def stop(self) -> None:
        if self._player is not None:
            self._player.stop()
        self._pos.setValue(0)
        self.stopped.emit()

    # ------------------------------------------------------------ 内部槽
    def _set_hint(self, text: str) -> None:
        self._hint.setText(text)
        self._hint.setToolTip(text)
        self._hint.setVisible(bool(text))

    def _on_volume(self, value: int) -> None:
        if self._audio_out is not None:
            self._audio_out.setVolume(max(0.0, min(1.0, value / 100.0)))

    def _on_seek_begin(self) -> None:
        self._seeking = True

    def _on_seek_end(self) -> None:
        self._seeking = False
        if self._player is not None:
            self._player.setPosition(self._pos.value())

    def _on_position(self, ms: int) -> None:
        if not self._seeking:
            self._pos.setValue(ms)
        self._time.setText(f"{format_ms(ms)} / {format_ms(self._duration_ms)}")

    def _on_duration(self, ms: int) -> None:
        self._duration_ms = max(0, ms)
        self._pos.setRange(0, self._duration_ms)
        self._time.setText(f"{format_ms(self._pos.value())} / {format_ms(self._duration_ms)}")

    def _on_state(self, state) -> None:  # noqa: ANN001 - Qt 枚举
        if QMediaPlayer is None:
            return
        playing = state == QMediaPlayer.PlaybackState.PlayingState
        if self._icon_play.isNull():
            self._play_btn.setText(_ICON_PAUSE if playing else _ICON_PLAY)
        else:
            self._play_btn.setIcon(self._icon_pause if playing else self._icon_play)

    def _on_media_status(self, status) -> None:  # noqa: ANN001 - Qt 枚举
        if QMediaPlayer is None or self._player is None:
            return
        if status == QMediaPlayer.MediaStatus.EndOfMedia and self._loop.isChecked():
            self._player.setPosition(0)
            self._player.play()

    def _on_error(self, error=None, error_string: str = "") -> None:  # noqa: ANN001
        if QMediaPlayer is not None and error == getattr(
            getattr(QMediaPlayer, "Error", None), "NoError", None,
        ):
            return
        detail = (error_string or "").strip()
        self._set_hint(f"试听失败：{detail}" if detail else "试听失败：文件无法播放")
