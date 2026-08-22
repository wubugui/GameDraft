"""角色阴影绑定的编辑控件（玩家 / NPC / 热区共用一个）。

制作人 2026-08-20 定死：角色阴影**必须手动指定光源**，可绑真实灯或虚拟灯，
**禁止自动 resolve**。所以这个控件的全部职责就是让作者把那个选择**看得见、点得到**——
它不替作者推荐、不按距离排序、不在灯丢了的时候悄悄换一盏。

## 为什么只显示第一条

数据面允许一个实体挂多条绑定（多光源多影子）。但实测里绝大多数实体只需要一条，
为三个面板各铺一套增删表不值当。多出来的条目**原样保留并显式告知**
（`extra_note()`），不会被静默吃掉——静默吃掉才是真正不可接受的那种。
"""
from __future__ import annotations

from typing import Callable

from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDoubleSpinBox, QHBoxLayout, QLabel, QVBoxLayout, QWidget,
)

from . import scene_lights

#: 下拉里的三档。值与 `EntityShadowBinding.source` 的三种形态对应。
MODE_NONE = 0
MODE_LIGHT = 1
MODE_VIRTUAL = 2


class ShadowBindingsEditor(QWidget):
    """一条阴影绑定的编辑器。`changed` 由调用方接到自己的脏标记上。

    用法::

        w = ShadowBindingsEditor(on_changed=self._emit_props_changed)
        form.addRow("阴影绑定", w)
        ...
        w.set_lights(scene_lighting_lights)     # 场景灯表变了就重喂
        w.load(npc_def.get("shadowBindings"))
        ...
        bindings = w.dump()                     # None = 不写这个字段
    """

    def __init__(self, on_changed: Callable[[], None] | None = None,
                 parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._on_changed = on_changed
        self._loading = False
        self._extra: list[dict] = []     # 第二条起，原样保留
        self._lights: list[dict] = []

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(3)

        row1 = QHBoxLayout()
        row1.setContentsMargins(0, 0, 0, 0)
        self._mode = QComboBox(self)
        self._mode.addItem("不投影", MODE_NONE)
        self._mode.addItem("绑场景灯", MODE_LIGHT)
        self._mode.addItem("虚拟灯（只管影子，不照亮）", MODE_VIRTUAL)
        self._mode.setToolTip(
            "角色阴影**必须手动指定**，系统不会自己挑灯。\n"
            "· 绑场景灯：影子方向由那盏灯与角色的实际位置算出，走动时正确跟着转\n"
            "· 虚拟灯：影子方向由你直接给（演出用：这一刻影子必须往那边倒）\n"
            "· 不投影：明确没有影子\n"
            "不选任何一项（留「不投影」且没有其他绑定）= 走旧的手调单影。"
        )
        self._mode.currentIndexChanged.connect(self._on_mode_changed)
        row1.addWidget(self._mode, 1)

        self._light = QComboBox(self)
        self._light.setToolTip("场景 lighting.lights 里的灯。灯被删掉后这里会显示⚠。")
        self._light.currentIndexChanged.connect(self._emit)
        row1.addWidget(self._light, 1)
        outer.addLayout(row1)

        # 虚拟灯参数
        self._virt = QWidget(self)
        vl = QHBoxLayout(self._virt)
        vl.setContentsMargins(0, 0, 0, 0)
        vl.setSpacing(4)
        self._azim = self._spin(0.0, 359.9, 1.0, "屏幕方位°")
        self._azim.setToolTip(
            "⚠ 这是**屏幕**方向，不是世界方位角。虚拟灯没有世界位置，\n"
            "绕世界坐标只会让你调的数与看到的效果对不上。"
        )
        self._elev = self._spin(25.0, 80.0, 1.0, "仰角°")
        self._elev.setToolTip("决定影长（1/tan）。低于 25° 影子会拉成薄条读不出来，故钳在 25–80。")
        self._dark = self._spin(0.0, 1.0, 0.05, "浓度")
        self._soft = self._spin(0.0, 2.0, 0.05, "软度")
        for lbl, w in (("屏幕方位", self._azim), ("仰角", self._elev),
                       ("浓度", self._dark), ("软度", self._soft)):
            vl.addWidget(QLabel(lbl, self))
            vl.addWidget(w)
        vl.addStretch(1)
        outer.addWidget(self._virt)

        # 绑真实灯时的可选覆盖
        self._ovr = QWidget(self)
        ol = QHBoxLayout(self._ovr)
        ol.setContentsMargins(0, 0, 0, 0)
        ol.setSpacing(4)
        self._ovr_on = QCheckBox("手改浓度/软度", self)
        self._ovr_on.setToolTip(
            "不勾 = 浓度由「这盏灯相对天光有多强」自动算、软度由光源角尺寸自动算。\n"
            "勾上才写死——写死之后调灯强度影子不会跟着变，请确认这是你要的。"
        )
        self._ovr_on.stateChanged.connect(self._on_mode_changed)
        self._ovr_dark = self._spin(0.0, 1.0, 0.05, "浓度")
        self._ovr_soft = self._spin(0.0, 2.0, 0.05, "软度")
        ol.addWidget(self._ovr_on)
        ol.addWidget(QLabel("浓度", self))
        ol.addWidget(self._ovr_dark)
        ol.addWidget(QLabel("软度", self))
        ol.addWidget(self._ovr_soft)
        ol.addStretch(1)
        outer.addWidget(self._ovr)

        self._note = QLabel("", self)
        self._note.setWordWrap(True)
        outer.addWidget(self._note)

        self._apply_visibility()

    # ------------------------------------------------------------------ 内部
    def _spin(self, lo: float, hi: float, step: float, suffix: str) -> QDoubleSpinBox:
        sb = QDoubleSpinBox(self)
        sb.setRange(lo, hi)
        sb.setSingleStep(step)
        sb.setDecimals(2)
        sb.setMaximumWidth(78)
        sb.valueChanged.connect(self._emit)
        return sb

    def _emit(self, *_a: object) -> None:
        if self._loading:
            return
        self._refresh_note()
        if self._on_changed:
            self._on_changed()

    def _on_mode_changed(self, *_a: object) -> None:
        self._apply_visibility()
        self._emit()

    def _apply_visibility(self) -> None:
        mode = self._mode.currentData()
        self._light.setVisible(mode == MODE_LIGHT)
        self._virt.setVisible(mode == MODE_VIRTUAL)
        self._ovr.setVisible(mode == MODE_LIGHT)
        self._ovr_dark.setEnabled(self._ovr_on.isChecked())
        self._ovr_soft.setEnabled(self._ovr_on.isChecked())

    def _refresh_note(self) -> None:
        b = self.dump()
        issues = scene_lights.validate_shadow_bindings(b, self._lights) if b else []
        parts = list(issues)
        if self._extra:
            parts.append(f"另有 {len(self._extra)} 条绑定未在此显示（写回时原样保留）")
        self._note.setText("　".join(parts))
        # 有真问题才变红：绑丢的灯在运行时表现为"没有影子"，画面上完全看不出是配错了
        self._note.setStyleSheet("color:#c66;" if issues else "color:#888;")

    # ------------------------------------------------------------------ 外部
    def set_lights(self, lights: list[dict] | None) -> None:
        """喂当前场景的灯表。**灯表变了必须重喂**，否则下拉里还是上一个场景的灯。"""
        self._lights = list(lights or [])
        keep = self._light.currentData()
        self._loading = True
        try:
            self._light.clear()
            for l in self._lights:
                lid = str(l.get("id") or "")
                if lid:
                    self._light.addItem(f'{lid}（{l.get("kind", "?")}）', lid)
            if keep is not None:
                i = self._light.findData(keep)
                if i >= 0:
                    self._light.setCurrentIndex(i)
                else:
                    # 绑的灯没了：**留在这儿并标出来**，不悄悄换一盏
                    self._light.addItem(f"⚠ {keep}（场景里已无此灯）", keep)
                    self._light.setCurrentIndex(self._light.count() - 1)
        finally:
            self._loading = False
        self._refresh_note()

    def load(self, bindings: object) -> None:
        """从实体数据载入。非法/缺省一律落到「不投影」，不猜。"""
        self._loading = True
        try:
            lst = [b for b in (bindings or []) if isinstance(b, dict)]
            self._extra = lst[1:]
            first = lst[0] if lst else {}
            src = str(first.get("source") or scene_lights.SHADOW_SOURCE_NONE)
            if src == scene_lights.SHADOW_SOURCE_VIRTUAL:
                self._mode.setCurrentIndex(self._mode.findData(MODE_VIRTUAL))
                v = first.get("virtual") or {}
                self._azim.setValue(float(v.get("azimuthDeg", 135.0)))
                self._elev.setValue(float(v.get("elevationDeg", 50.0)))
                self._dark.setValue(float(v.get("darkness", 0.6)))
                self._soft.setValue(float(v.get("softness", 0.35)))
            elif src.startswith(scene_lights.SHADOW_LIGHT_PREFIX):
                self._mode.setCurrentIndex(self._mode.findData(MODE_LIGHT))
                lid = src[len(scene_lights.SHADOW_LIGHT_PREFIX):]
                i = self._light.findData(lid)
                if i < 0:
                    self._light.addItem(f"⚠ {lid}（场景里已无此灯）", lid)
                    i = self._light.count() - 1
                self._light.setCurrentIndex(i)
                has_ovr = "darkness" in first or "softness" in first
                self._ovr_on.setChecked(has_ovr)
                self._ovr_dark.setValue(float(first.get("darkness", 0.6)))
                self._ovr_soft.setValue(float(first.get("softness", 0.35)))
            else:
                self._mode.setCurrentIndex(self._mode.findData(MODE_NONE))
        finally:
            self._loading = False
        self._apply_visibility()
        self._refresh_note()

    def dump(self) -> list[dict] | None:
        """产出写回值。`None` = 不写 `shadowBindings` 字段（走旧的手调单影）。

        ⚠ 「不投影」与「不写字段」是**两回事**：前者明确没影子，后者回落手调单影。
        所以只有在既选了不投影、又没有额外条目时才返回 None。
        """
        mode = self._mode.currentData()
        first: dict | None = None
        if mode == MODE_VIRTUAL:
            first = {
                "source": scene_lights.SHADOW_SOURCE_VIRTUAL,
                "virtual": {
                    "azimuthDeg": round(self._azim.value(), 2),
                    "elevationDeg": round(self._elev.value(), 2),
                    "darkness": round(self._dark.value(), 3),
                    "softness": round(self._soft.value(), 3),
                    "length": 0.0,
                },
            }
        elif mode == MODE_LIGHT:
            lid = self._light.currentData()
            if lid:
                first = {"source": f"{scene_lights.SHADOW_LIGHT_PREFIX}{lid}"}
                if self._ovr_on.isChecked():
                    first["darkness"] = round(self._ovr_dark.value(), 3)
                    first["softness"] = round(self._ovr_soft.value(), 3)
        elif self._extra:
            # 有额外条目时第一条也得占位，否则写回会把它们前移、语义整体错位
            first = {"source": scene_lights.SHADOW_SOURCE_NONE}

        if first is None:
            return None
        return [first, *self._extra]
