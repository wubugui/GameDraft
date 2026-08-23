""""这一帧的光长什么样" —— 光环境关键帧 → 画布可视化参数，零 Qt。

光曲线在画布上的存在意义就是**一眼看出这一段的光从哪来、影子多长多黑**。
两个画布都要画它，各解各的 `env` 必然漂移，而漂移的表现是"两个画布画出两种光"——
偏偏这东西没有对错反馈，谁也不会发现。所以解析收在这一处。

## 与运行时对齐的两条

- `azimuthDeg` 在**世界 y 向下**的帧里度量：影迹 = 光来向的反向，
  即 `EntityShadow` 的 `offX/offY = cos/sin(az + 180)`。所以这里的 `sin` **不取负** ——
  取负会与运行时上下镜像（看着像差 90°）。
- 影长系数 `cot(elevation)` 夹在 `[0.3, 1.6]`，与 `resolveLightEnv` 同口径。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

__all__ = ["LightEnvVisual", "light_env_visual"]

#: 影长系数的夹取区间（与运行时 resolveLightEnv 一致）
SHADOW_LEN_MIN = 0.3
SHADOW_LEN_MAX = 1.6


@dataclass(frozen=True, slots=True)
class LightEnvVisual:
    """一帧 env 解出来的画布可视化参数。"""

    #: 光**来向**的单位向量（世界坐标；影迹沿它的反方向）
    dir_x: float
    dir_y: float
    #: 影长系数（`cot(elevation)` 夹取后）
    shadow_len: float
    #: 阴影暗度 0..1
    darkness: float
    #: 接触阴影：范围倍率与浓度 0..1
    contact_size: float
    contact: float
    #: 主光强度
    intensity: float
    #: 主光色 / 环境光色（0-255 三元组）
    key_rgb: tuple[int, int, int]
    ambient_rgb: tuple[int, int, int]


def _num(d: dict, key: str, default: float) -> float:
    try:
        v = float(d.get(key, default) if d.get(key) is not None else default)
    except (TypeError, ValueError):
        return float(default)
    return v if math.isfinite(v) else float(default)


def _rgb(value, default: tuple[int, int, int]) -> tuple[int, int, int]:
    """认 `[r,g,b]` / `{"r":..}` / `"#rrggbb"` 三种写法；解不出来用缺省。"""
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        try:
            return tuple(max(0, min(255, int(v))) for v in value[:3])
        except (TypeError, ValueError):
            return default
    if isinstance(value, dict):
        try:
            return (max(0, min(255, int(value.get("r", default[0])))),
                    max(0, min(255, int(value.get("g", default[1])))),
                    max(0, min(255, int(value.get("b", default[2])))))
        except (TypeError, ValueError):
            return default
    if isinstance(value, str):
        text = value.strip().lstrip("#")
        if len(text) == 6:
            try:
                return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))
            except ValueError:
                return default
    return default


def light_env_visual(env: object) -> LightEnvVisual:
    """把一帧 `env` 解成画布可视化参数。缺项一律用与运行时相同的缺省。"""
    e = env if isinstance(env, dict) else {}
    key = e.get("key") if isinstance(e.get("key"), dict) else {}
    shadow = e.get("shadow") if isinstance(e.get("shadow"), dict) else {}
    ambient = e.get("ambient") if isinstance(e.get("ambient"), dict) else {}

    az = _num(key, "azimuthDeg", 125.0)
    el = max(8.0, min(85.0, _num(key, "elevationDeg", 55.0)))
    rad = math.radians(az)
    cot = math.cos(math.radians(el)) / max(math.sin(math.radians(el)), 1e-3)
    return LightEnvVisual(
        dir_x=math.cos(rad),
        # 见模块 docstring：**不取负**
        dir_y=math.sin(rad),
        shadow_len=max(SHADOW_LEN_MIN, min(SHADOW_LEN_MAX, cot)),
        darkness=max(0.0, min(1.0, _num(shadow, "darkness", 0.4))),
        contact_size=max(0.0, _num(shadow, "contactSize", 1.0)),
        contact=max(0.0, min(1.0, _num(shadow, "contact", 0.45))),
        intensity=_num(key, "intensity", 1.0),
        key_rgb=_rgb(key.get("color"), (255, 247, 235)),
        ambient_rgb=_rgb(ambient.get("color"), (140, 153, 184)),
    )
