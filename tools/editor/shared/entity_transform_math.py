"""实体实例 transform（scale/rotation/anchor，quad 级真变换）的编辑器侧数学镜像。

与运行时 ``src/utils/entityTransform.ts`` 同口径（绕**锚点**，先缩放后旋转，
rotation 单位为度）。画布预览 / 碰撞多边形往返必须经此模块换算，保证
「编辑器所见 = 运行时所得」（防预览撒谎）。

锚点（``NpcDef.anchor``）缺省 ``{x:0.5, y:1}`` = 底中 = 脚底，即锚点可配之前
写死的那个值 —— 所以本模块所有名字带 ``around_foot`` 的函数照旧成立：它们要的
"脚点"现在叫**接地点**（:func:`anchor_contact_offset` 派生），缺省锚点时接地点
恒等于锚点，全部既有调用一位不变。
"""
from __future__ import annotations

import math

#: 缺省锚点：图元横向中点 / 底边（脚底）。与 TS ``DEFAULT_ENTITY_ANCHOR_X/Y`` 一字不差。
DEFAULT_ENTITY_ANCHOR_X = 0.5
DEFAULT_ENTITY_ANCHOR_Y = 1.0


def _anchor_component(raw: object, fallback: float) -> float:
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return fallback
    v = float(raw)
    if not math.isfinite(v):
        return fallback
    return min(1.0, max(0.0, v))


def entity_anchor_of(d: dict | None) -> tuple[float, float]:
    """镜像 TS ``entityAnchorOf``：``(x, y)`` 落在精灵包围盒的哪一点。

    非数值 / 非有限 / 缺失的分量各自回落缺省（只写一半是合法的），其余夹到 [0,1]。
    与其它 ``entity_*_of`` 同口径地拦 ``bool``（``True`` 是 int 子类，不拦会被当成 1）。
    """
    a = (d or {}).get("anchor")
    if not isinstance(a, dict):
        return (DEFAULT_ENTITY_ANCHOR_X, DEFAULT_ENTITY_ANCHOR_Y)
    return (
        _anchor_component(a.get("x"), DEFAULT_ENTITY_ANCHOR_X),
        _anchor_component(a.get("y"), DEFAULT_ENTITY_ANCHOR_Y),
    )


def is_default_entity_anchor(ax: float, ay: float) -> bool:
    """是不是缺省锚点（底中）。为真时全部锚点派生量恒 0，走与改造前逐位相同的分支。"""
    return ax == DEFAULT_ENTITY_ANCHOR_X and ay == DEFAULT_ENTITY_ANCHOR_Y


def anchor_contact_offset(
    ax: float, ay: float, eff_w: float, eff_h: float,
) -> tuple[float, float]:
    """镜像 TS ``anchorContactOffset``：锚点 → **接地点**的局部偏移（未旋转、未镜像）。

    接地点 = 精灵包围盒的底边中点，也就是锚点可配之前 ``(x, y)`` 的那个含义。
    ``eff_w/eff_h`` 传**有效尺寸**（已含实例 scale 与透视系数），本函数只做归一化
    换算、不再乘任何东西（避免双重缩放）。缺省锚点时恒 ``(0.0, 0.0)``。
    """
    return (
        (DEFAULT_ENTITY_ANCHOR_X - ax) * eff_w,
        (DEFAULT_ENTITY_ANCHOR_Y - ay) * eff_h,
    )


def rotate_local_vec(lx: float, ly: float, rot_deg: float) -> tuple[float, float]:
    """镜像 TS ``rotateLocalVector``：只旋转、不缩放。

    与 :func:`transform_local_vec` 的分工：那个先乘 scale（用于尚未乘过 scale 的
    authored 量），本函数用于已经由**有效尺寸**派生出来的量（再乘一次就是双重缩放）。
    """
    if rot_deg == 0:
        return lx, ly
    rad = math.radians(rot_deg)
    c = math.cos(rad)
    n = math.sin(rad)
    return lx * c - ly * n, lx * n + ly * c


def entity_contact_offset(
    d: dict | None, eff_w: float, eff_h: float, mirror_x: float = 1.0,
) -> tuple[float, float]:
    """实体接地点相对锚点的**世界**偏移（已含实例旋转与左右镜像）。

    镜像 ``Npc._contactOffset``。``eff_w/eff_h`` 是有效尺寸（含实例 scale 与透视系数），
    所以这里只补旋转与镜像符号 —— 再乘一次 scale 就是双重缩放。
    缺省锚点时恒 ``(0.0, 0.0)``，于是排序锚 / 阴影脚点 / 透视采样点全部逐位不变。
    """
    ax, ay = entity_anchor_of(d)
    if is_default_entity_anchor(ax, ay):
        return (0.0, 0.0)
    ox, oy = anchor_contact_offset(ax, ay, eff_w, eff_h)
    return rotate_local_vec(ox * (-1.0 if mirror_x < 0 else 1.0), oy,
                            entity_rotation_deg_of(d))


def entity_contact_point(
    d: dict | None, base_w: float, base_h: float, factor: float = 1.0,
    mirror_x: float = 1.0, x: float | None = None, y: float | None = None,
) -> tuple[float, float]:
    """实体**接地点**的世界坐标（阴影落点 / 排序锚 / 透视采样点的依据）。

    ``base_w/base_h`` 传**未乘实例 scale 与透视系数**的世界尺寸（动画包 / displayImage
    里的原值），``factor`` 是透视系数 —— 两者在这里一次乘齐，避免调用方各乘各的。
    ``x/y`` 缺省取 ``d['x']/d['y']``（拖动预览可传 staging 坐标）。

    缺省锚点时恒返回 ``(x, y)``。
    """
    px = float((d or {}).get("x", 0) or 0) if x is None else float(x)
    py = float((d or {}).get("y", 0) or 0) if y is None else float(y)
    s = entity_scale_of(d) * (factor if (factor and factor > 0) else 1.0)
    ox, oy = entity_contact_offset(d, base_w * s, base_h * s, mirror_x)
    return (px + ox, py + oy)


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


def quad_top_local_y_around_foot(eff_w: float, eff_h: float, rotation_rad: float) -> float:
    """底中锚 quad 变换后顶部相对锚点的局部 y（负值）。镜像 TS quadTopLocalYAroundFoot。

    w/h 传**有效尺寸**（已含实例 scale），本函数只做旋转。
    """
    if rotation_rad == 0:
        return -eff_h
    c = math.cos(rotation_rad)
    n = math.sin(rotation_rad)
    hw = eff_w / 2.0
    return min(
        lx * n + ly * c
        for lx, ly in ((-hw, 0.0), (hw, 0.0), (hw, -eff_h), (-hw, -eff_h))
    )


def content_top_local_y_around_foot(
    eff_content_w: float,
    eff_content_h: float,
    eff_bottom_gap: float,
    rotation_rad: float,
) -> float:
    """**内容框**变换后顶部相对锚点的局部 y（负值）。镜像 TS contentTopLocalYAroundFoot。

    内容框不是贴着脚点的整块 quad——它底边离脚点 ``eff_bottom_gap``、上下都内缩，
    旋转后顶点集与 quad 不同，不能套 quad 那套算。无旋转时 = -(gap + h)。
    """
    top_y = -(eff_bottom_gap + eff_content_h)
    if rotation_rad == 0:
        return top_y
    bottom_y = -eff_bottom_gap
    c = math.cos(rotation_rad)
    n = math.sin(rotation_rad)
    hw = eff_content_w / 2.0
    return min(
        lx * n + ly * c
        for lx, ly in ((-hw, bottom_y), (hw, bottom_y), (hw, top_y), (-hw, top_y))
    )


def quad_ground_y_around_foot(
    anchor_y: float, eff_w: float, eff_h: float, rotation_rad: float,
) -> float:
    """底中锚 quad 变换后的**接地线** y（世界坐标）。镜像 TS quadGroundYAroundFoot。

    即旋转后 AABB 的底边（最大世界 y）。无旋转时恒等于 ``anchor_y`` —— 运行时正是靠
    这一条在 ``rad == 0`` 时删掉 ``entitySortFootY``、回落容器锚点 y。
    w/h 传**有效尺寸**（已含实例 scale 与透视系数），本函数只做旋转扩展，避免双重缩放。
    """
    if rotation_rad == 0:
        return anchor_y
    c = math.cos(rotation_rad)
    n = math.sin(rotation_rad)
    hw = eff_w / 2.0
    return anchor_y + max(
        lx * n + ly * c
        for lx, ly in ((-hw, 0.0), (hw, 0.0), (hw, -eff_h), (-hw, -eff_h))
    )


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
    """**接地点** (foot_x, foot_y) 处的透视缩放系数 f；未配置/退化/非有限时恒 1。
    与 TS perspectiveScaleAt 同口径：接地点在 near→far 轴上归一化投影 [0,1] 后分段线性插值。

    ⚠ "接地点"不等于实体位置：锚点可配之后两者差一段 :func:`entity_contact_offset`
    （缺省锚点时为 0）。近大远小的依据是"脚踩在哪"，调用方应传
    :func:`entity_contact_point` 的结果，不是 ``ent['x'], ent['y']``。"""
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
    """实体在画布上的透视系数：参与判定 × f(接地点)。foot_x/foot_y 缺省取实体 x/y
    （巡逻预览可传瞬时坐标；锚点非底中的实体应传 :func:`entity_contact_point`）。"""
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
