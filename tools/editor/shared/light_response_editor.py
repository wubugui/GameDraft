"""角色/粒子的场景作者参数表单；只发工作副本变化，保存由宿主统一处理。"""
from __future__ import annotations

import copy
import json
import math
from pathlib import PurePosixPath

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QDoubleSpinBox, QFormLayout, QLabel, QVBoxLayout, QWidget

from .form_layout import compact_form

RESPONSE_FIELDS = (
    ("indirectFactor", "间接光 factor", 64, 0.05),
    ("directFactor", "直接光 factor", 64, 0.05),
    ("totalFactor", "总 factor", 64, 0.05),
    ("eChroma", "光色度 eChroma", 1, 0.02),
)


def _number(value, fallback, maximum):
    return max(0, min(maximum, value)) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else fallback


def scene_response_fallback(model, scene: dict, variant: dict | None = None) -> dict:
    """只读当前背景的旧载荷初值，和 CharacterLightingSystem 的缺项兼容同口径。"""
    result = dict(indirectFactor=1, directFactor=1, totalFactor=1, eChroma=0)
    bgs = (variant or {}).get("backgrounds", scene.get("backgrounds")) or []
    image = str(bgs[0].get("image") or "background.png") if bgs else "background.png"
    sid = scene.get("id")
    if not sid or not model.paths:
        return result
    file = model.paths.scene_runtime_dir(sid) / "lighting" / PurePosixPath(image.replace("\\", "/")).stem / "lighting.json"
    try:
        sh = json.loads(file.read_text(encoding="utf-8")).get("shading")
        if isinstance(sh, dict):
            beta = sh.get("beta", 0)
            if not isinstance(beta, (float, int)) or not math.isfinite(beta):
                beta = 0
            result.update(indirectFactor=_number(sh.get("giStrength"), 1, 64),
                          totalFactor=2 ** max(-64, min(64, beta)) / math.pi,
                          eChroma=_number(sh.get("eChroma"), 0, 1))
    except (OSError, ValueError, TypeError):
        pass
    return result


class LightResponseEditor(QWidget):
    changed = Signal(dict)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._loading = False
        self._data = {}
        self._resolved = {}
        self._fields = {}
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        hint = QLabel("场景作者参数：角色、粒子各自独立。保存后重载生效；F2 可实时调节并同步回来。")
        hint.setWordWrap(True)
        layout.addWidget(hint)
        form = compact_form(QFormLayout())
        for kind, title in (("character", "角色"), ("particles", "粒子")):
            for key, label, maximum, step in RESPONSE_FIELDS:
                spin = QDoubleSpinBox()
                spin.setRange(0, maximum)
                spin.setDecimals(4)
                spin.setSingleStep(step)
                spin.setMaximumWidth(120)
                spin.setKeyboardTracking(False)
                spin.setToolTip("0 = 不接受光色，1 = 完整接受光色。" if key == "eChroma" else "总倍率 ×（间接光 × 间接倍率 + 直接光 × 直接倍率）。")
                spin.valueChanged.connect(lambda value, k=kind, f=key: self._on_value(k, f, value))
                self._fields[(kind, key)] = spin
                form.addRow(f"{title} · {label}", spin)
        layout.addLayout(form)
        self.load(None, dict(indirectFactor=1, directFactor=1, totalFactor=1, eChroma=0))

    def load(self, value, fallback):
        self._loading = True
        try:
            self._data = copy.deepcopy(value) if isinstance(value, dict) else {}
            for kind in ("character", "particles"):
                data = self._data.get(kind) or {}
                self._resolved[kind] = {**fallback, **data}
                for key, _label, maximum, _step in RESPONSE_FIELDS:
                    self._fields[(kind, key)].setValue(_number(data.get(key), fallback[key], maximum))
        finally:
            self._loading = False

    def effective_value(self):
        return copy.deepcopy(self._resolved)

    def _on_value(self, kind, key, value):
        if self._loading:
            return
        # 完成被编辑的这一组；其余组不改。未修改的浮点值按原精度保留。
        data = {**self._resolved[kind], **(self._data.get(kind) or {})}
        old = data.get(key)
        data[key] = old if old == value else value
        self._data[kind] = data
        self._resolved[kind] = dict(data)
        self.changed.emit(copy.deepcopy(self._data))
