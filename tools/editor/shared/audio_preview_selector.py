"""音频 id 选择控件：一个显示当前值的按钮 + 就地试听键，点开是可搜可听的弹窗。

**为什么不是下拉**：sfx 有一百多条，下拉既搜不了也听不了，还得先提交才知道选错。
按 [dropdown-vs-popup-selector] 决策（只有很短的枚举才配用下拉），音频这种
大候选集 + 需要感官确认的资产选择一律走弹窗，见 :mod:`audio_picker_dialog`。

数据安全契约（沿用 IdRefSelector，勿退化）：
- 当前值不在候选清单时**保值展示**为 ``id  [未登记]``，绝不静默替换或清空；
- 程序性 ``set_current`` / ``set_items`` 不发 ``value_changed``（避免载入即脏）；
- 弹窗取消 = 不改值；只有用户确实选中了别的 id 或按「清空」才发信号。
"""
from __future__ import annotations

from collections.abc import Callable

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QSizePolicy,
    QStyle,
    QWidget,
)

from ..project_model import ProjectModel
from . import audio_library as lib
from .audio_picker_dialog import AudioPickerDialog
from .qt_icon_buttons import outline_row_tool_button

try:
    from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
except Exception:  # pragma: no cover - 取决于本机 QtMultimedia 是否安装完整
    QAudioOutput = None  # type: ignore[misc,assignment]
    QMediaPlayer = None  # type: ignore[misc,assignment]

from PySide6.QtCore import QUrl  # noqa: E402  （放在可选导入之后，保持上面 try 的可读性）

#: 旧调用点/测试沿用的解析入口，实现已收进 audio_library（保持单一真相源）。
audio_config_src_for_id = lib.audio_config_src_for_id
audio_config_file_for_id = lib.audio_config_file_for_id

_PLACEHOLDER = "（未选择）"


class AudioPreviewControls(QWidget):
    """一对 ▶/■：试听 ``current_id_fn()`` 当前返回的那个 id。"""

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

        # 用 QToolButton + 系统媒体图标：QPushButton 在 modern 主题下带大内边距，
        # 30px 宽的按钮会把 ▶/■ 挤没（实测两颗按钮渲染成空条），而 ■ 这个字形
        # 在部分字体里还会退化成一根竖线。
        self._play = outline_row_tool_button(
            self, "试听当前选择的音频",
            std=QStyle.StandardPixmap.SP_MediaPlay, fallback_text="▶",
        )
        self._stop = outline_row_tool_button(
            self, "停止试听",
            std=QStyle.StandardPixmap.SP_MediaStop, fallback_text="停",
        )
        lay.addWidget(self._play)
        lay.addWidget(self._stop)

        # 试听失败必须说话（审查 P2）：id 无法解析成文件 / 播放器报错都提示在按钮旁。
        self._hint = QLabel("", self)
        self._hint.setStyleSheet("color:#e8590c;")
        self._hint.setVisible(False)
        lay.addWidget(self._hint)
        # errorOccurred 每个失败源只弹一次窗，避免同一坏文件反复打断。
        self._error_notified_keys: set[str] = set()
        self._active_source_key: str = ""

        if QMediaPlayer is None or QAudioOutput is None:
            self._play.setEnabled(False)
            self._stop.setEnabled(False)
            self._play.setToolTip("需要 PySide6.QtMultimedia 才能试听")
            self._stop.setToolTip("需要 PySide6.QtMultimedia 才能试听")
        else:
            # 播放器**按需**创建：这对按钮在 System SFX 页有 40 份、在动作参数表里
            # 更多，构造时就各起一个 ffmpeg 后端的 QMediaPlayer 纯属白烧资源。
            self._play.clicked.connect(self.preview_current)
            self._stop.clicked.connect(self.stop)

    def _ensure_player(self) -> QMediaPlayer | None:
        if self._player is not None:
            return self._player
        if QMediaPlayer is None or QAudioOutput is None:
            return None
        self._audio_out = QAudioOutput(self)
        self._player = QMediaPlayer(self)
        self._player.setAudioOutput(self._audio_out)
        self._player.errorOccurred.connect(self._on_player_error)
        return self._player

    def _set_hint(self, text: str) -> None:
        self._hint.setText(text)
        self._hint.setToolTip(text)
        self._hint.setVisible(bool(text))

    def preview_current(self) -> None:
        self._set_hint("")
        audio_id = (self._current_id_fn() or "").strip()
        path = lib.audio_config_file_for_id(self._model, self._channel, audio_id)
        if path is None:
            # id 未选 / src 缺失 / 文件被移走全落到这里——旧实现裸 return 全静默。
            self._set_hint("该 id 无有效音频文件")
            return
        player = self._ensure_player()
        if player is None:
            return
        self._active_source_key = str(path)
        player.stop()
        player.setSource(QUrl.fromLocalFile(str(path)))
        player.play()

    def _on_player_error(self, error: object = None, error_string: str = "") -> None:
        """播放失败（格式不支持 / 解码器缺失 / 文件损坏…）：
        按钮旁常驻提示 + 每个失败文件只弹一次警告框。"""
        if QMediaPlayer is not None and error == getattr(
            getattr(QMediaPlayer, "Error", None), "NoError", None,
        ):
            return
        self._set_hint("试听失败：文件无法播放")
        key = self._active_source_key or "<unknown>"
        if key in self._error_notified_keys:
            return
        self._error_notified_keys.add(key)
        msg = (error_string or "").strip() or "无法播放该音频文件"
        QMessageBox.warning(self, "音频试听", f"无法播放：\n{key}\n\n{msg}")

    def stop(self) -> None:
        if self._player is not None:
            self._player.stop()


class AudioIdPreviewSelector(QWidget):
    """当前值按钮（点开＝可搜可听的弹窗）+ 就地 ▶/■。

    ``editable`` 保留旧语义「允许写入目录里还没有的 id」——现在由弹窗里的
    「手输 id…」承载，而不是把一百多条塞进可编辑下拉。
    """

    value_changed = Signal(str)

    def __init__(
        self,
        model: ProjectModel,
        channel: str,
        parent: QWidget | None = None,
        *,
        allow_empty: bool = True,
        click_opens_popup: bool = False,  # noqa: ARG002 - 兼容旧签名；本控件恒为弹窗
        editable: bool = False,
    ):
        super().__init__(parent)
        self._model = model
        self._channel = channel
        self._allow_empty = bool(allow_empty)
        self._editable = bool(editable)
        self._items: list[tuple[str, str]] = []
        self._value = ""

        self._button = QPushButton(_PLACEHOLDER, self)
        self._button.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self._button.setStyleSheet("text-align:left; padding-left:6px;")
        self._button.setToolTip("点击打开音频选择窗（可搜索、可试听）")
        self._button.clicked.connect(self.open_picker)

        self._preview = AudioPreviewControls(model, channel, self.current_id, self)

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        lay.addWidget(self._button, stretch=1)
        lay.addWidget(self._preview)

    # ------------------------------------------------------------ 候选/取值
    def set_items(self, items: list[tuple[str, str]] | list[str]) -> None:
        pairs: list[tuple[str, str]] = []
        seen: set[str] = set()
        for it in items:
            if isinstance(it, tuple):
                rid = str(it[0]).strip()
                name = str(it[1]) if len(it) > 1 else rid
            else:
                rid = str(it).strip()
                name = rid
            if not rid or rid in seen:
                continue
            seen.add(rid)
            pairs.append((rid, name))
        self._items = pairs
        self._sync_button()

    def item_ids(self) -> list[str]:
        """当前候选 id 列表（跨面板刷新与测试用；顺序即传入顺序）。"""
        return [rid for rid, _name in self._items]

    def set_current(self, item_id: str) -> None:
        """程序性设值：不发 ``value_changed``，未知 id 原样保值。"""
        self._value = "" if item_id is None else str(item_id).strip()
        self._sync_button()

    def current_id(self) -> str:
        return self._value

    # --------------------------------------------------------------- 弹窗
    def open_picker(self) -> None:
        dialog = AudioPickerDialog(
            self._model,
            self._channel,
            list(self._items),
            current=self._value,
            allow_empty=self._allow_empty,
            parent=self,
            allow_manual_id=self._editable,
        )
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        selected = dialog.selected_value()
        if selected == self._value:
            return
        self._value = selected
        self._sync_button()
        self.value_changed.emit(selected)

    # --------------------------------------------------------------- 展示
    def _sync_button(self) -> None:
        if not self._value:
            self._button.setText(_PLACEHOLDER)
            self._button.setToolTip("点击打开音频选择窗（可搜索、可试听）")
            return
        entry = lib.channel_dict(self._model, self._channel).get(self._value)
        if entry is None:
            self._button.setText(f"{self._value}  [未登记]")
            self._button.setToolTip(
                f"{self._value} 不在 audio_config.{self._channel} 里——原值已保留，"
                "但运行时不会有声音。去「音频」页登记，或改选一条已登记的。",
            )
            return
        src = lib.entry_src(entry)
        if lib.src_to_local_file(self._model, src) is None:
            self._button.setText(f"{self._value}  [文件缺失]")
            self._button.setToolTip(f"src={src or '(空)'} 找不到对应文件")
            return
        self._button.setText(self._value)
        self._button.setToolTip(src)

    # ---------------------------------------------------------- 兼容旧 API
    def setMinimumWidth(self, minw: int) -> None:  # noqa: N802 - Qt API compatibility
        super().setMinimumWidth(minw)
        # 按钮让出 ▶/■ 占的宽度，避免整行被顶爆（小屏护栏）
        self._button.setMinimumWidth(max(60, minw - 70))

    def stop_preview(self) -> None:
        self._preview.stop()
