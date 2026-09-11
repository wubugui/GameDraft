"""音频 id 选择控件：当前值按钮 + **本处音量** + 就地试听键，点开是可搜可听的弹窗。

**为什么不是下拉**：sfx 有一百多条，下拉既搜不了也听不了，还得先提交才知道选错。
按 [dropdown-vs-popup-selector] 决策（只有很短的枚举才配用下拉），音频这种
大候选集 + 需要感官确认的资产选择一律走弹窗，见 :mod:`audio_picker_dialog`。

## 本处音量（``with_volume=True``）

同一条素材在不同地方要的响度天然不同（近景推门要满，隔壁当氛围只要一半）。
音频目录里那条 ``volume`` 是**素材级**的，表达不了这件事——以前作者只能复制一条同源素材、
改个 id 单独调音量，音频目录因此长出一堆 ``xxx_quiet`` / ``xxx_loud``。

所以选择器自带一格音量，**它就是运行时音量**：

- 写盘走 :mod:`audio_cue`（对象形态 ``{"id": ..., "volume": ...}``，中性值不写键）；
- ▶ 试听**按同一个数放**，还要乘上素材级 volume 与该通道的出厂音量
  （见 :data:`audio_library.CHANNEL_DEFAULT_VOLUME`）——试听不按运行时口径放的话，
  这一格就只是个装饰：作者调到"听着刚好"，进游戏还是不对。

数据安全契约（沿用 IdRefSelector，勿退化）：
- 当前值不在候选清单时**保值展示**为 ``id  [未登记]``，绝不静默替换或清空；
- 程序性 ``set_current`` / ``set_items`` / ``set_volume`` 不发信号（避免载入即脏）；
- 弹窗取消 = 不改值；只有用户确实选中了别的 id 或按「清空」才发信号；
- 音量"用户没动过就按盘上原值原样写回"（含盘上写着的中性 ``1``），见
  :func:`audio_cue.resolve_volume_for_write`。
"""
from __future__ import annotations

from collections.abc import Callable

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QDialog,
    QDoubleSpinBox,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QSizePolicy,
    QStyle,
    QWidget,
)

from ..project_model import ProjectModel
from . import audio_cue as cue
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

#: cue_for_write 的哨兵：区分"没传 original"与"显式传了 None"（后者 = 盘上本来就没这个键）。
_KEEP_LOADED = object()


class AudioPreviewControls(QWidget):
    """一对 ▶/■：**按运行时音量**试听 ``current_id_fn()`` 当前返回的那个 id。

    ``site_volume_fn`` 给出该引用点的本处音量（``None`` = 没配，沿用素材级）。
    不传就只按素材级 + 通道出厂音量放。
    """

    def __init__(
        self,
        model: ProjectModel,
        channel: str,
        current_id_fn: Callable[[], str],
        parent: QWidget | None = None,
        *,
        site_volume_fn: Callable[[], float | None] | None = None,
    ):
        super().__init__(parent)
        self._model = model
        self._channel = channel
        self._current_id_fn = current_id_fn
        self._site_volume_fn = site_volume_fn
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

    def runtime_gain(self, audio_id: str) -> float:
        """这一声在**游戏里**的线性增益：``(本处音量 ?? 素材级音量 ?? 1) × 通道出厂音量``。

        与运行时同口径（本处音量**替换**素材级，不是相乘）——口径见
        ``src/data/audioCue.ts``。已按满幅 clamp：>1 的本处音量只能吃掉
        "当前音量→满幅"那段余量，跟游戏里一样。
        """
        site = self._site_volume_fn() if self._site_volume_fn is not None else None
        if site is None:
            entry = lib.channel_dict(self._model, self._channel).get(audio_id)
            site = lib.entry_volume(entry)
        base = 1.0 if site is None else float(site)
        return max(0.0, min(1.0, base * lib.channel_default_volume(self._channel)))

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
        gain = self.runtime_gain(audio_id)
        if self._audio_out is not None:
            # QAudioOutput 的 volume 与 Howler 一样是**线性**增益，两边同一个数不必换算。
            self._audio_out.setVolume(gain)
        # 全哑时说一声：否则作者点 ▶ 没声音，只会以为是文件坏了或试听坏了。
        self._set_hint("本处音量为 0（游戏里也不会响）" if gain <= 0 else "")
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
        if self._player is None:
            return
        self._player.stop()
        # 清空 source 才真正松开文件句柄：`stop()` 只是停播，QMediaPlayer 仍持有
        # 打开的文件。在 Windows 上那是独占的——编辑器开着时该音频文件删不掉、
        # 移不动、改名失败（`WinError 32 另一个程序正在使用此文件`）。
        self._player.setSource(QUrl())
        self._active_source_key = None


class AudioIdPreviewSelector(QWidget):
    """当前值按钮（点开＝可搜可听的弹窗）+ 可选的**本处音量** + 就地 ▶/■。

    ``editable`` 保留旧语义「允许写入目录里还没有的 id」——现在由弹窗里的
    「手输 id…」承载，而不是把一百多条塞进可编辑下拉。

    ``with_volume=True`` 挂出本处音量那一格（模块头注释讲了为什么每处都要有）。
    调用点拿 :meth:`volume_for_write` 写盘，并把 :attr:`changed` 接到自己的标脏钩子上——
    只接 ``value_changed`` 的话，**改音量不会被认为是改动**，切走就丢。
    """

    #: 只在 id 变化时发（携带新 id）。旧调用点全都接的这个，语义不动。
    value_changed = Signal(str)
    #: id 或音量任一变化都发。带音量的调用点必须接它，否则改音量不标脏。
    changed = Signal()

    def __init__(
        self,
        model: ProjectModel,
        channel: str,
        parent: QWidget | None = None,
        *,
        allow_empty: bool = True,
        click_opens_popup: bool = False,  # noqa: ARG002 - 兼容旧签名；本控件恒为弹窗
        editable: bool = False,
        with_volume: bool = False,
    ):
        super().__init__(parent)
        self._model = model
        self._channel = channel
        self._allow_empty = bool(allow_empty)
        self._editable = bool(editable)
        self._items: list[tuple[str, str]] = []
        self._value = ""
        #: set_cue 载入的那条引用原件；写回时在它上面改，保住未知键。
        self._cue_raw: object = None
        #: 盘上的音量原值（None = 没写这个键）；用户没动过就按它原样回写。
        self._volume_raw: float | int | None = None
        #: 载入时喂进控件的种子值，用来判"用户动没动过"（不能拿"等不等于中性"当判据）。
        self._volume_seed = cue.NEUTRAL_VOLUME

        self._button = QPushButton(_PLACEHOLDER, self)
        self._button.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self._button.setStyleSheet("text-align:left; padding-left:6px;")
        self._button.setToolTip("点击打开音频选择窗（可搜索、可试听）")
        self._button.clicked.connect(self.open_picker)

        self._volume: QDoubleSpinBox | None = None
        if with_volume:
            self._volume = QDoubleSpinBox(self)
            self._volume.setRange(0.0, cue.MAX_SITE_VOLUME)
            self._volume.setDecimals(2)
            self._volume.setSingleStep(0.05)
            self._volume.setValue(cue.NEUTRAL_VOLUME)
            self._volume.setPrefix("× ")
            self._volume.setMaximumWidth(84)
            self._volume.setToolTip(
                "本处音量：这一处就按它播（▶ 试听同样按它放）。\n"
                "1 = 素材原始音量（不写进数据）；0.5 = 减半；0 = 这里就是要哑。\n"
                ">1 表示比原音更响，但只能顶到满幅——素材本身偏轻要去放大文件。\n"
                "⚠ 它覆盖的是「音频」页那条素材级音量，不是相乘。",
            )
            self._volume.valueChanged.connect(self._on_volume_changed)

        self._preview = AudioPreviewControls(
            model, channel, self.current_id, self,
            site_volume_fn=self.current_volume,
        )

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        lay.addWidget(self._button, stretch=1)
        if self._volume is not None:
            lay.addWidget(self._volume)
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

    # ------------------------------------------------------------ 本处音量
    def has_volume(self) -> bool:
        """本控件是否挂了音量格（``with_volume``）。"""
        return self._volume is not None

    def set_volume(self, raw: object) -> None:
        """程序性设音量：**不发信号**（载入即脏是最常见的编辑器数据事故）。

        ``raw`` 直接收盘上的原值（数值 / ``None`` / 甚至脏值），非法一律当没写。
        """
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or raw < 0:
            value: float | int | None = None
        else:
            value = raw
        self._volume_raw = value
        # 控件量程有上限，超程的原值会被 Qt 夹住——种子记**夹后**的值，否则
        # "没动过"永远判成"动过"，写回时把作者原来的 5.0 悄悄改成 4.0。
        seed = cue.NEUTRAL_VOLUME if value is None else float(value)
        seed = max(0.0, min(cue.MAX_SITE_VOLUME, seed))
        self._volume_seed = seed
        if self._volume is None:
            return
        blocked = self._volume.blockSignals(True)
        try:
            self._volume.setValue(seed)
        finally:
            self._volume.blockSignals(blocked)
        self._sync_volume_style()

    def current_volume(self) -> float | None:
        """控件当前音量，``None`` = 没配（沿用素材级）。**试听按它放**。"""
        if self._volume is None:
            return None if self._volume_raw is None else float(self._volume_raw)
        v = float(self._volume.value())
        # 中性值等价于没配：试听要按"素材级音量"放，而不是硬乘 1 把素材级顶掉。
        if abs(v - cue.NEUTRAL_VOLUME) < 1e-9 and self._volume_raw is None:
            return None
        return v

    def volume_for_write(self) -> float | int | None:
        """写盘用的音量值；``None`` = 不写这个键（见 :func:`audio_cue.resolve_volume_for_write`）。"""
        if self._volume is None:
            return self._volume_raw
        return cue.resolve_volume_for_write(
            float(self._volume.value()), self._volume_seed, self._volume_raw,
        )

    def cue_for_write(self, original: object = _KEEP_LOADED) -> str | dict | None:
        """写盘用的整条引用（裸 id 或 ``{id, volume}``）；``None`` = 这个键整个不写。

        不传 ``original`` 就用 :meth:`set_cue` 记下的那份盘上原件——调用点因此不必自己
        再存一份（存两份就会漂，而漂的表现是**作者手写的未来字段被静默删掉**）。
        """
        base = self._cue_raw if original is _KEEP_LOADED else original
        return cue.make_cue(self.current_id(), self.volume_for_write(), base)

    def set_cue(self, raw: object) -> None:
        """从盘上的一条引用（裸 id 或 ``{id, volume}``）载入 id 与音量，并记住原件。"""
        self._cue_raw = raw
        self.set_current(cue.cue_id(raw))
        self.set_volume(cue.cue_volume(raw))

    def _on_volume_changed(self, _v: float) -> None:
        self._sync_volume_style()
        self.changed.emit()

    def _sync_volume_style(self) -> None:
        """非中性音量描一下边：一屏几十个引用点，得能一眼看出哪几处被单独调过。"""
        if self._volume is None:
            return
        off = abs(float(self._volume.value()) - cue.NEUTRAL_VOLUME) > 1e-9
        self._volume.setStyleSheet("font-weight:bold; color:#0b7285;" if off else "")

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
        self.changed.emit()

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
        # 按钮让出 ▶/■（约 70px）与音量格（约 90px）占的宽度，避免整行被顶爆（小屏护栏）
        reserved = 70 + (90 if self._volume is not None else 0)
        self._button.setMinimumWidth(max(60, minw - reserved))

    def stop_preview(self) -> None:
        self._preview.stop()
