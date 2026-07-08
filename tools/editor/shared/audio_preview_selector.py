"""Audio id picker with inline preview controls.

复用 :class:`IdRefSelector` 的保值/孤儿行契约，只在旁边补试听能力。
"""
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from PySide6.QtCore import QUrl, Signal
from PySide6.QtWidgets import QHBoxLayout, QPushButton, QWidget

from ..project_model import ProjectModel
from .id_ref_selector import IdRefSelector
from .project_paths import URL_KIND_MEDIA

try:
    from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
except Exception:  # pragma: no cover - 取决于本机 QtMultimedia 是否安装完整
    QAudioOutput = None  # type: ignore[misc,assignment]
    QMediaPlayer = None  # type: ignore[misc,assignment]


def audio_config_src_for_id(model: ProjectModel, channel: str, audio_id: str) -> str:
    """Return audio_config[channel][audio_id].src if present."""
    cfg = model.audio_config.get(channel, {})
    if not isinstance(cfg, dict):
        return ""
    entry = cfg.get(audio_id)
    if isinstance(entry, dict):
        return str(entry.get("src") or "").strip()
    if isinstance(entry, str):
        return entry.strip()
    return ""


def audio_config_file_for_id(model: ProjectModel, channel: str, audio_id: str) -> Path | None:
    """Resolve an audio_config id to an existing local file."""
    src = audio_config_src_for_id(model, channel, audio_id)
    if not src or model.project_path is None:
        return None
    path = model.paths.url_to_disk(src, kind=URL_KIND_MEDIA)
    if path is None:
        return None
    try:
        path = path.resolve()
    except OSError:
        return None
    return path if path.is_file() else None


class AudioPreviewControls(QWidget):
    """Tiny play/stop row for the audio id returned by ``current_id_fn``."""

    def __init__(
        self,
        model: ProjectModel,
        channel: str,
        current_id_fn: Callable[[], str],
        parent: QWidget | None = None,
    ):
        super().__init__(parent)
        self._model = model
        self._channel = channel
        self._current_id_fn = current_id_fn
        self._player: QMediaPlayer | None = None
        self._audio_out: QAudioOutput | None = None

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)

        self._play = QPushButton("▶", self)
        self._play.setFixedWidth(34)
        self._play.setToolTip("试听当前选择的音频")
        self._stop = QPushButton("■", self)
        self._stop.setFixedWidth(34)
        self._stop.setToolTip("停止试听")
        lay.addWidget(self._play)
        lay.addWidget(self._stop)

        if QMediaPlayer is None or QAudioOutput is None:
            self._play.setEnabled(False)
            self._stop.setEnabled(False)
            self._play.setToolTip("需要 PySide6.QtMultimedia 才能试听")
            self._stop.setToolTip("需要 PySide6.QtMultimedia 才能试听")
        else:
            self._audio_out = QAudioOutput(self)
            self._player = QMediaPlayer(self)
            self._player.setAudioOutput(self._audio_out)
            self._play.clicked.connect(self.preview_current)
            self._stop.clicked.connect(self.stop)

    def preview_current(self) -> None:
        if self._player is None:
            return
        audio_id = (self._current_id_fn() or "").strip()
        path = audio_config_file_for_id(self._model, self._channel, audio_id)
        if path is None:
            return
        self._player.stop()
        self._player.setSource(QUrl.fromLocalFile(str(path)))
        self._player.play()

    def stop(self) -> None:
        if self._player is not None:
            self._player.stop()


class AudioIdPreviewSelector(QWidget):
    """IdRefSelector plus audio preview buttons."""

    value_changed = Signal(str)

    def __init__(
        self,
        model: ProjectModel,
        channel: str,
        parent: QWidget | None = None,
        *,
        allow_empty: bool = True,
        click_opens_popup: bool = False,
        editable: bool = False,
    ):
        super().__init__(parent)
        self._selector = IdRefSelector(
            self,
            allow_empty=allow_empty,
            click_opens_popup=click_opens_popup,
            editable=editable,
        )
        self._preview = AudioPreviewControls(
            model,
            channel,
            lambda: self.current_id(),
            self,
        )

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(6)
        lay.addWidget(self._selector, stretch=1)
        lay.addWidget(self._preview)

        self._selector.value_changed.connect(self.value_changed.emit)

    def set_items(self, items: list[tuple[str, str]] | list[str]) -> None:
        self._selector.set_items(items)

    def set_current(self, item_id: str) -> None:
        self._selector.set_current(item_id)

    def current_id(self) -> str:
        return self._selector.current_id()

    def setMinimumWidth(self, minw: int) -> None:  # noqa: N802 - Qt API compatibility
        super().setMinimumWidth(minw)
        self._selector.setMinimumWidth(minw)

    def stop_preview(self) -> None:
        self._preview.stop()
