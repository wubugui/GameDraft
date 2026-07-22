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


AXIS_MIN_LEN_SQ = 1e-6


def _persp_point(p: object) -> tuple[float, float, float] | None:
    """深度轴端点 {x,y,scale}：有限坐标 + scale>0 才有效。"""
    if not isinstance(p, dict):
        return None
    x = _persp_num(p.get("x"))
    y = _persp_num(p.get("y"))
    s = _persp_num(p.get("scale"))
    if x is None or y is None or s is None or s <= 0:
        return None
    return (x, y, s)


def perspective_axis_data(cfg: dict | None):
    """预解析深度轴：返回 (nx, ny, ax, ay, len_sq, stops[(pos,scale)...]) 或 None（未配置/退化）。
    与 TS axisData 同口径：near/far 有效且轴非退化；stops 含 0/1 端点 + 合法 midStops，按 pos 升序。"""
    if not isinstance(cfg, dict):
        return None
    near = _persp_point(cfg.get("near"))
    far = _persp_point(cfg.get("far"))
    if near is None or far is None:
        return None
    nx, ny, ns = near
    fx, fy, fs = far
    ax = fx - nx
    ay = fy - ny
    len_sq = ax * ax + ay * ay
    if len_sq <= AXIS_MIN_LEN_SQ:
        return None
    stops: list[tuple[float, float]] = [(0.0, ns)]
    mids = cfg.get("midStops")
    if isinstance(mids, list):
        for m in mids:
            if not isinstance(m, dict):
                continue
            pos = _persp_num(m.get("pos"))
            s = _persp_num(m.get("scale"))
            if pos is None or s is None or not (0.0 < pos < 1.0) or s <= 0:
                continue
            stops.append((pos, s))
    stops.append((1.0, fs))
    stops.sort(key=lambda t: t[0])
    return (nx, ny, ax, ay, len_sq, stops)


def perspective_scale_at(cfg: dict | None, foot_x: float, foot_y: float) -> float:
    """脚底点 (foot_x, foot_y) 处的透视缩放系数 f；未配置/退化/非有限脚底时恒 1。
    与 TS perspectiveScaleAt 同口径：脚底点在 near→far 轴上归一化投影 [0,1] 后分段线性插值。"""
    a = perspective_axis_data(cfg)
    if a is None or not math.isfinite(foot_x) or not math.isfinite(foot_y):
        return 1.0
    nx, ny, ax, ay, len_sq, stops = a
    raw = ((foot_x - nx) * ax + (foot_y - ny) * ay) / len_sq
    t = 0.0 if raw <= 0.0 else (1.0 if raw >= 1.0 else raw)
    if t <= stops[0][0]:
        return max(PERSPECTIVE_SCALE_MIN, stops[0][1])
    if t >= stops[-1][0]:
        return max(PERSPECTIVE_SCALE_MIN, stops[-1][1])
    for i in range(1, len(stops)):
        lo_p, lo_s = stops[i - 1]
        hi_p, hi_s = stops[i]
        if t <= hi_p:
            if hi_p == lo_p:
                return max(PERSPECTIVE_SCALE_MIN, hi_s)
            k = (t - lo_p) / (hi_p - lo_p)
            return max(PERSPECTIVE_SCALE_MIN, lo_s + (hi_s - lo_s) * k)
    return max(PERSPECTIVE_SCALE_MIN, stops[-1][1])


def has_perspective_scale(cfg: dict | None) -> bool:
    return perspective_axis_data(cfg) is not None


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
    cfg: dict | None, ent: dict | None, kind: str,
    foot_x: float | None = None, foot_y: float | None = None,
) -> float:
    """实体在画布上的透视系数：参与判定 × f(脚底点)。foot_x/foot_y 缺省取实体 x/y
    （巡逻预览可传瞬时坐标）。"""
    if not entity_participates_perspective(ent, kind):
        return 1.0
    d = ent or {}
    if foot_x is None:
        foot_x = _persp_num(d.get("x"))
    if foot_y is None:
        foot_y = _persp_num(d.get("y"))
    if foot_x is None or foot_y is None:
        return 1.0
    return perspective_scale_at(cfg, foot_x, foot_y)
