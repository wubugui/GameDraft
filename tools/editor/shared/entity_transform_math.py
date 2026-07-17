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
