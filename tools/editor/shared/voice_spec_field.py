"""台词配音控件：`voice` + `autoAdvance` 两个键的唯一录入面。

**为什么是共享控件**：配音这一个能力铺在五处台词面上（过场字幕 / 过场对话框 /
playScriptedDialogue 逐行 / 图对话每一拍 / 头顶气泡 action）。五处各摆一套控件必然漂——
漂的表现不是难看，是"这一处能配 hold、那一处配不出来"，策划得记住哪处能干什么。
故控件只此一份，五处调用点只决定「摆在哪、要不要推进那一栏」。

写盘契约（往返保真，勿退化）：
- 磁盘上原本是字符串（`"voice": "voice_004a"`）且没动音量/留声 → 仍写字符串；
- 数值（音量、毫秒）未被改动时**原样回写原始表示**（int 不变 float、0.8 不变 0.8000000001），
  与 `numeric_roundtrip.preserve_numeric_repr` 同一条理由；
- 未选配音 + 点击推进 = 两个键都不写（最小形态打开→保存不得凭空多键）。
"""
from __future__ import annotations

from typing import Any

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QWidget,
)

from .form_layout import compact_form

#: autoAdvance 三态在 UI 里的取值（写盘值另算：点击=不写键）
ADVANCE_CLICK = "__click__"
ADVANCE_VOICE = "__voice__"
ADVANCE_TIMER = "__timer__"

_ADVANCE_ROWS: tuple[tuple[str, str], ...] = (
    ("点击推进（默认）", ADVANCE_CLICK),
    ("跟随配音结束", ADVANCE_VOICE),
    ("固定时长后…", ADVANCE_TIMER),
)

_ADVANCE_TIP = (
    "这一拍怎么结束：\n"
    "· 点击推进（默认）——等玩家点；\n"
    "· 跟随配音结束——本拍配音自然播完就走；本拍**没配**配音时，接管前面某拍勾了"
    "「播完不停」留下的那条，跟它一起结束（一条长配音配几句短台词就靠这条）；\n"
    "· 固定时长——到点自动走。\n"
    "两种自动模式下玩家点击仍可提前推进；配音缺失/加载失败一律退化为等点击，不会闪切。"
)

_HOLD_TIP = (
    "勾选后本拍结束**不停**这条配音，留给后面的台词：\n"
    "后面哪一拍选了「跟随配音结束」，就由那一拍接管、跟它一起结束；没人接管就自然播完。\n"
    "不勾（默认）= 配音跟本拍一起结束。"
)


def parse_voice_raw(raw: Any) -> tuple[str, bool, bool, float, bool]:
    """拆 `voice` 原值 → (id, 原本是对象, 原本写过 volume, volume, hold)。"""
    if isinstance(raw, str):
        return raw.strip(), False, False, 1.0, False
    if isinstance(raw, dict):
        sid = raw.get("id")
        if not isinstance(sid, str):
            sid = raw.get("sfxId")
        vid = sid.strip() if isinstance(sid, str) else ""
        had_volume = "volume" in raw
        try:
            vol = float(raw.get("volume", 1.0))
        except (TypeError, ValueError):
            vol = 1.0
        if vol != vol:  # NaN
            vol = 1.0
        return vid, True, had_volume, max(0.0, min(1.0, vol)), raw.get("hold") is True
    return "", False, False, 1.0, False


def parse_advance_raw(raw: Any) -> tuple[str, float]:
    """拆 `autoAdvance` 原值 → (模式, 毫秒)。非法值按「点击推进」（与运行时同口径）。"""
    if raw == "voice":
        return ADVANCE_VOICE, 3000.0
    if isinstance(raw, (int, float)) and not isinstance(raw, bool) and raw > 0:
        return ADVANCE_TIMER, float(raw)
    return ADVANCE_CLICK, 3000.0


class VoiceSpecField(QWidget):
    """配音 + 推进方式；`voice_value()` / `advance_value()` 取写盘值（None = 不写这个键）。"""

    changed = Signal()

    def __init__(
        self,
        parent: QWidget | None = None,
        *,
        model: Any = None,
        voice_raw: Any = None,
        advance_raw: Any = None,
        show_advance: bool = True,
        compact: bool = False,
    ):
        super().__init__(parent)
        self._model = model
        self._voice_raw_original = voice_raw
        self._advance_raw_original = advance_raw
        self._show_advance = bool(show_advance)

        vid, was_object, had_volume, volume, hold = parse_voice_raw(voice_raw)
        self._was_object = was_object
        self._had_volume = had_volume
        self._orig_volume = volume
        mode, ms = parse_advance_raw(advance_raw)

        form = compact_form(QFormLayout(self))
        form.setContentsMargins(0, 0, 0, 0)

        self._id_widget = self._build_id_widget(vid)
        if compact:
            # 窄面板（图对话检查器 280px 预算 / 台词行列表）：控件必须封顶、标签必须短，
            # 否则展开这一块就把面板顶出横向滚动条、行尾按钮点不到（见图对话编辑器卡 §15）。
            self._id_widget.setMaximumWidth(190)
        form.addRow("配音" if compact else "配音 sfx", self._id_widget)

        self._volume = QDoubleSpinBox(self)
        self._volume.setRange(0.0, 1.0)
        self._volume.setDecimals(3)
        self._volume.setSingleStep(0.05)
        self._volume.setValue(volume)
        self._volume.setToolTip(
            "仅本条配音的相对音量；1.0 = 不额外衰减。\n"
            "▶ 试听按它放（与运行时同口径）。",
        )
        self._volume.valueChanged.connect(self.changed)
        # 音量改了就同步给选择器，让试听跟着变——不同步的话作者在盲调
        self._volume.valueChanged.connect(self._push_preview_volume)
        self._push_preview_volume()

        self._hold = QCheckBox("播完不停，留给后面的台词", self)
        self._hold.setChecked(hold)
        self._hold.setToolTip(_HOLD_TIP)
        self._hold.toggled.connect(self.changed)

        if compact:
            self._volume.setMaximumWidth(84)
            self._hold.setText("播完不停")
            form.addRow("音量", self._volume)
            form.addRow("", self._hold)
        else:
            form.addRow("音量", self._volume)
            form.addRow("", self._hold)

        self._advance: QComboBox | None = None
        self._advance_ms: QDoubleSpinBox | None = None
        if self._show_advance:
            self._advance = QComboBox(self)
            for label, key in _ADVANCE_ROWS:
                self._advance.addItem(label, key)
            idx = self._advance.findData(mode)
            self._advance.setCurrentIndex(max(0, idx))
            self._advance.setToolTip(_ADVANCE_TIP)
            if compact:
                # QComboBox 的 minimumSizeHint 只吃 setMaximumWidth（见图对话编辑器卡「已知坑」）
                self._advance.setMaximumWidth(150)

            self._advance_ms = QDoubleSpinBox(self)
            self._advance_ms.setRange(100.0, 600000.0)
            self._advance_ms.setDecimals(0)
            self._advance_ms.setSingleStep(250.0)
            self._advance_ms.setValue(max(100.0, ms))
            self._advance_ms.setMaximumWidth(96)
            self._advance_ms.setToolTip("固定时长模式的展示毫秒数，到点自动推进。")
            self._advance_ms.setEnabled(mode == ADVANCE_TIMER)
            self._advance_ms.valueChanged.connect(self.changed)
            self._advance.currentIndexChanged.connect(self._on_advance_mode_changed)

            if compact:
                # 窄面板一行塞不下「下拉 + ms + 数值框」（实测把整块顶到 306px）：拆两行
                form.addRow("推进", self._advance)
                form.addRow("时长 ms", self._advance_ms)
            else:
                row = QWidget(self)
                lay = QHBoxLayout(row)
                lay.setContentsMargins(0, 0, 0, 0)
                lay.addWidget(self._advance, 1)
                lay.addWidget(QLabel("ms", row))
                lay.addWidget(self._advance_ms)
                form.addRow("推进方式", row)

    # ------------------------------------------------------------------ 构造
    def _build_id_widget(self, vid: str) -> QWidget:
        """有工程就用可搜可听的弹窗选择器；没工程（独立开图编辑器等）退回保值的裸输入。"""
        if self._model is not None:
            try:
                from . import audio_library as lib
                from .audio_preview_selector import AudioIdPreviewSelector
                from .action_editor import _id_ref_rows_with_orphan

                # 配音一律取 audio_config.voice 区——与 sfx 彻底脱钩，不做任何回落。
                # 这里写 "sfx" 的后果是：游戏能放、编辑器却说 id 无效（踩过）。
                sel = AudioIdPreviewSelector(
                    self._model, lib.VOICE_CHANNEL, self, allow_empty=True, editable=False,
                )
                pairs = [(a, a) for a in self._model.all_audio_ids(lib.VOICE_CHANNEL)]
                sel.set_items(_id_ref_rows_with_orphan(pairs, vid))
                sel.set_current(vid)
                sel.value_changed.connect(self.changed)
                sel.setToolTip("audio_config.voice 里的一条配音；可搜索、可试听。留空 = 本拍没有配音。")
                return sel
            except Exception:  # pragma: no cover - 选择器不可用时不能让整个表单起不来
                pass
        edit = QLineEdit(vid, self)
        edit.setPlaceholderText("audio_config.voice 的 id（留空 = 无配音）")
        edit.textChanged.connect(self.changed)
        return edit

    def _on_advance_mode_changed(self, _i: int) -> None:
        if self._advance_ms is not None:
            self._advance_ms.setEnabled(self.advance_mode() == ADVANCE_TIMER)
        self.changed.emit()

    # ------------------------------------------------------------------ 取值
    def _push_preview_volume(self, _v: float = 0.0) -> None:
        """把本条配音的音量同步给 id 选择器，使 ▶ 试听与运行时一致。

        判据与 :meth:`voice_value` 写不写 ``volume`` 键同一条：没配过且仍是 1.0 时传 None
        （= 沿用素材级音量）。一律传 1.0 会把素材级那条 volume 顶掉，试听就比游戏里响。
        """
        w = self._id_widget
        setter = getattr(w, "set_volume", None)
        if not callable(setter):
            return
        v = float(self._volume.value())
        configured = self._had_volume or abs(v - 1.0) > 1e-9
        setter(v if configured else None)

    def current_id(self) -> str:
        w = self._id_widget
        if isinstance(w, QLineEdit):
            return w.text().strip()
        getter = getattr(w, "current_id", None)
        return str(getter()).strip() if callable(getter) else ""

    def advance_mode(self) -> str:
        if self._advance is None:
            return ADVANCE_CLICK
        data = self._advance.currentData()
        return str(data) if data is not None else ADVANCE_CLICK

    def voice_value(self) -> Any:
        """写盘用的 `voice` 值；None = 不写这个键。"""
        vid = self.current_id()
        if not vid:
            return None
        volume = max(0.0, min(1.0, float(self._volume.value())))
        hold = self._hold.isChecked()
        volume_touched = abs(volume - self._orig_volume) > 1e-9
        want_volume = self._had_volume or abs(volume - 1.0) > 1e-9
        # 原样字符串：磁盘上就是字符串、没写过音量、也没勾留声——不因打开一次就升级成对象
        if not want_volume and not hold and not self._was_object:
            return vid
        out: dict[str, Any] = {"id": vid}
        if want_volume:
            out["volume"] = self._original_volume_repr() if not volume_touched else volume
        if hold:
            out["hold"] = True
        return out

    def advance_value(self) -> Any:
        """写盘用的 `autoAdvance` 值；None = 不写这个键（点击推进即缺省语义）。"""
        mode = self.advance_mode()
        if mode == ADVANCE_VOICE:
            return "voice"
        if mode != ADVANCE_TIMER or self._advance_ms is None:
            return None
        ms = float(self._advance_ms.value())
        orig = self._advance_raw_original
        if (
            isinstance(orig, (int, float))
            and not isinstance(orig, bool)
            and abs(float(orig) - ms) < 1e-9
        ):
            return orig  # 未改动：原样回写（int 不升 float）
        return ms

    def _original_volume_repr(self) -> Any:
        raw = self._voice_raw_original
        if isinstance(raw, dict) and "volume" in raw:
            v = raw.get("volume")
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return v
        return max(0.0, min(1.0, float(self._volume.value())))

    def apply_to(self, out: dict, *, voice_key: str = "voice", advance_key: str = "autoAdvance") -> None:
        """把两个键写进 out（值为 None 的键不写）——各调用点共用，免得写漏一个键。"""
        v = self.voice_value()
        if v is not None:
            out[voice_key] = v
        a = self.advance_value()
        if a is not None:
            out[advance_key] = a

    def has_content(self) -> bool:
        """是否配了东西（决定折叠区要不要默认展开）。"""
        return bool(self.current_id()) or self.advance_mode() != ADVANCE_CLICK
