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

from .contact_ao import SPREAD_DEFAULT as _CONTACT_AO_SPREAD_DEFAULT

__all__ = ["LightEnvVisual", "light_env_visual", "contact_preview_axes"]

#: 影长系数的夹取区间（与运行时 resolveLightEnv 一致）
SHADOW_LEN_MIN = 0.3
SHADOW_LEN_MAX = 1.6

#: 接触 AO（胶囊 AO）简单 AO 的晕开范围缺省（遮挡高度占身高的比例）——取 `contact_ao` 的那一份，
#: 那边与运行时 `src/rendering/contactAo.ts` 对账（test_npc_contact_shadow_form）。预览画的是缺省晕开。
CONTACT_NEAR_FIELD = _CONTACT_AO_SPREAD_DEFAULT
#: 仅预览用：站立人物贴地那一截的宽度约占身高的比例（37 套角色图集实测 0.16~0.22）。
#: 运行时不用它——那边直接读剪影脚底那一截；预览画在曲线控制点上，没有具体的人可读。
CONTACT_PREVIEW_FOOT_FRAC = 0.18
#: 仅预览用：本作相机俯角 45°，竖直世界高投屏缩 cos45、地面纵深投屏缩 sin45。
_PREVIEW_COS = _PREVIEW_SIN = math.sqrt(0.5)


#: 无方向部分按方位角切几片求积（与运行时 CONTACT_FRAG 的 OMNI_SLICES 同数）
_OMNI_SLICES = 8


def _omni(x: float, r: float, he: float) -> float:
    """胶囊 AO 无方向部分：竖直胶囊（半径 r、底端球心高 r、顶端球心高 he）对地面点的余弦加权遮蔽，
    与运行时 CONTACT_FRAG 的 `capsuleOmni` 逐行同式（推导见那边注释）。贴地那一点 = 1，往外平滑落下。"""
    top = max(he, r)
    pm = math.asin(r / x) if x > r else math.pi
    dphi = 2 * pm / _OMNI_SLICES
    acc = 0.0
    for i in range(_OMNI_SLICES):
        phi = -pm + (i + 0.5) * dphi
        m = x * math.cos(phi)
        p = x * math.sin(phi)
        w2 = r * r - p * p
        if w2 <= 0:
            continue
        w = math.sqrt(w2)
        lo = max(0.0, math.atan2(r, m) - math.asin(min(1.0, w / math.hypot(m, r))))
        hi = math.pi / 2 if m - w <= 0 else min(math.pi / 2, math.atan2(top, m) + math.asin(min(1.0, w / math.hypot(m, top))))
        if hi > lo:
            acc += 0.5 * (math.sin(hi) ** 2 - math.sin(lo) ** 2)
    return acc * dphi / math.pi


def contact_preview_axes(ref_height: float, contact_size: float) -> tuple[float, float]:
    """接触阴影无方向部分在一个代表角色（屏幕高 ref_height）脚下、浓度落到约 1/10 的那一圈的屏幕半轴 (横, 纵)。

    有方向部分不在这里——画布上每个控制点本来就画着沿光反方向的影迹线。
    """
    h_world = ref_height / _PREVIEW_COS
    r = 0.5 * CONTACT_PREVIEW_FOOT_FRAC * ref_height * max(contact_size, 0.0)
    if r <= 0:
        return 0.0, 0.0
    he = CONTACT_NEAR_FIELD * h_world
    lo, hi = r, r + 10 * h_world                     # _omni 在 x>=r 上单调降
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if _omni(mid, r, he) > 0.1:
            lo = mid
        else:
            hi = mid
    return hi, hi * _PREVIEW_SIN


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
        # 缺省 0.75 = 运行时 lightEnv 基线的 shadow.contact（0.45 是角色 AO 的 ao.contact，别混）
        contact=max(0.0, min(1.0, _num(shadow, "contact", 0.75))),
        intensity=_num(key, "intensity", 1.0),
        key_rgb=_rgb(key.get("color"), (255, 247, 235)),
        ambient_rgb=_rgb(ambient.get("color"), (140, 153, 184)),
    )
