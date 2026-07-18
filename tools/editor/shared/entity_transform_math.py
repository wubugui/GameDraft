"""实体实例 transform（scale/rotation，quad 级真变换）的编辑器侧数学镜像。

与运行时 ``src/utils/entityTransform.ts`` 同口径（绕脚底锚点，先缩放后旋转，
rotation 单位为度）。画布预览 / 碰撞多边形往返必须经此模块换算，保证
「编辑器所见 = 运行时所得」（防预览撒谎）。
"""
from __future__ import annotations

import math


def entity_scale_of(d: dict | None) -> float:
    # 与运行时 entityScaleOf 同口径：只认真数值类型（str 数字运行时会回落 1，
    # 编辑器若宽容接受会造成"预览撒谎"的反向复现，审查 F10）。
    raw = (d or {}).get("scale", 1)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return 1.0
    raw = float(raw)
    if not math.isfinite(raw) or raw <= 0:
        return 1.0
    return raw


def entity_rotation_deg_of(d: dict | None) -> float:
    raw = (d or {}).get("rotation", 0)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return 0.0
    raw = float(raw)
    if not math.isfinite(raw):
        return 0.0
    return raw


def has_instance_transform(d: dict | None) -> bool:
    return entity_scale_of(d) != 1.0 or entity_rotation_deg_of(d) != 0.0


def transform_local_vec(lx: float, ly: float, scale: float, rot_deg: float) -> tuple[float, float]:
    """局部向量（相对锚点）→ 变换后向量：先缩放后旋转。"""
    sx = lx * scale
    sy = ly * scale
    if rot_deg == 0:
        return sx, sy
    rad = math.radians(rot_deg)
    c = math.cos(rad)
    n = math.sin(rad)
    return sx * c - sy * n, sx * n + sy * c


def inverse_transform_world_vec(vx: float, vy: float, scale: float, rot_deg: float) -> tuple[float, float]:
    """变换后向量（相对锚点）→ 原始局部向量：先反旋转后反缩放。"""
    if rot_deg != 0:
        rad = math.radians(-rot_deg)
        c = math.cos(rad)
        n = math.sin(rad)
        vx, vy = vx * c - vy * n, vx * n + vy * c
    if scale not in (0, 1):
        vx /= scale
        vy /= scale
    return vx, vy


# ---------------------------------------------------------------------------
# 场景透视缩放（近大远小）—— 运行时 src/utils/perspectiveScale.ts 的编辑器镜像。
# 画布预览必须经此求系数（防预览撒谎）；语义级 parity 测试锁定两侧口径。
# ---------------------------------------------------------------------------

PERSPECTIVE_SCALE_MIN = 0.01


def _persp_num(v: object) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def perspective_valid_rulers(cfg: dict | None) -> list[tuple[float, float]]:
    """cfg = 场景 perspectiveScale dict；返回有效基准线 [(y, scale)...]（原顺序，未排序）。"""
    raw = (cfg or {}).get("rulers") if isinstance(cfg, dict) else None
    out: list[tuple[float, float]] = []
    if not isinstance(raw, list):
        return out
    for r in raw:
        if not isinstance(r, dict):
            continue
        y = _persp_num(r.get("y"))
        s = _persp_num(r.get("scale"))
        if y is None or s is None or s <= 0:
            continue
        out.append((y, s))
    return out


def perspective_scale_at(cfg: dict | None, foot_y: float) -> float:
    """脚底 y 处的透视缩放系数 f(y)；有效基准线不足 2 条或 y 非法时恒 1。
    与 TS perspectiveScaleAt 同口径：按 y 升序分段线性插值、端点钳制、重复 y 取后者。"""
    rulers = perspective_valid_rulers(cfg)
    if len(rulers) < 2 or not math.isfinite(foot_y):
        return 1.0
    srt = sorted(rulers, key=lambda t: t[0])
    lo_y, lo_s = srt[0]
    if foot_y <= lo_y:
        return max(PERSPECTIVE_SCALE_MIN, lo_s)
    hi_y, hi_s = srt[-1]
    if foot_y >= hi_y:
        return max(PERSPECTIVE_SCALE_MIN, hi_s)
    for i in range(1, len(srt)):
        a_y, a_s = srt[i - 1]
        b_y, b_s = srt[i]
        if foot_y <= b_y:
            if b_y == a_y:
                return max(PERSPECTIVE_SCALE_MIN, b_s)
            t = (foot_y - a_y) / (b_y - a_y)
            return max(PERSPECTIVE_SCALE_MIN, a_s + (b_s - a_s) * t)
    return max(PERSPECTIVE_SCALE_MIN, hi_s)


def entity_participates_perspective(ent: dict | None, kind: str) -> bool:
    """参与判定镜像：npc 缺省参与（renderRaw 抠图贴回原位者除外）；hotspot 缺省不参与。"""
    d = ent or {}
    raw = d.get("perspectiveScaleEnabled")
    if isinstance(raw, bool):
        return raw
    if kind == "npc":
        return d.get("renderRaw") is not True
    return False


def entity_perspective_factor(
    cfg: dict | None, ent: dict | None, kind: str, foot_y: float | None = None,
) -> float:
    """实体在画布上的透视系数：参与判定 × f(脚底 y)。foot_y 缺省取实体 y（巡逻预览可传瞬时 y）。"""
    if not entity_participates_perspective(ent, kind):
        return 1.0
    if foot_y is None:
        y = _persp_num((ent or {}).get("y"))
        if y is None:
            return 1.0
        foot_y = y
    return perspective_scale_at(cfg, foot_y)
