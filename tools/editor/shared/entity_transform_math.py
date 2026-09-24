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


# ---------------------------------------------------------------------------
# 相机跟随透视（需求清单 A3.5，2026-09-20 拍板）
#
# TS 权威源：src/utils/perspectiveScale.ts::createPerspectiveCameraFollowResolver
# parity 锁：tools/editor/tests/test_perspective_scale_parity.py（黄金数值与
# src/utils/perspectiveScale.test.ts 一字不差）
# ---------------------------------------------------------------------------

#: zoom 相对基线的上限倍数缺省值（镜像 TS DEFAULT_PERSPECTIVE_CAMERA_MAX_ZOOM_RATIO）
DEFAULT_PERSPECTIVE_CAMERA_MAX_ZOOM_RATIO = 1.5


def _persp_follow_stops(cfg: dict | None):
    """带跟随开关的停靠点表：(nx, ny, ax, ay, len_sq, [(pos, scale, follow_next), ...]) 或 None。

    与 :func:`perspective_axis_data` 同一套合法性判定与排序（稳定排序 + 同比较键 ⇒ 同顺序），
    只是每个停靠点多带一个"**从这里到下一个停靠点**是否跟随"。开关挂在停靠点上而不是独立的
    段数组，是为了对 midStops 乱序免疫——独立数组在排序后会静默错位。"""
    a = perspective_axis_data(cfg)
    if a is None:
        return None
    nx, ny, ax, ay, len_sq, _ = a
    d = cfg if isinstance(cfg, dict) else {}
    follow_cfg = d.get("cameraFollow")
    first = True
    if isinstance(follow_cfg, dict):
        first = follow_cfg.get("firstSegment") is not False
    near_s = _persp_point(d.get("near"))[2]
    far_s = _persp_point(d.get("far"))[2]
    stops: list[tuple[float, float, bool]] = [(0.0, near_s, first)]
    mids = d.get("midStops")
    if isinstance(mids, list):
        for m in mids:
            if not isinstance(m, dict):
                continue
            pos = _persp_num(m.get("pos"))
            s = _persp_num(m.get("scale"))
            if pos is None or s is None or not (0.0 < pos < 1.0) or s <= 0:
                continue
            stops.append((pos, s, m.get("cameraFollow") is not False))
    stops.append((1.0, far_s, False))
    stops.sort(key=lambda t: t[0])
    return (nx, ny, ax, ay, len_sq, stops)


def _persp_scale_at_t(stops, t: float) -> float:
    """停靠点表上 t 处的系数（:func:`perspective_scale_at` 的 t 空间版，同口径）。"""
    if t <= stops[0][0]:
        return max(PERSPECTIVE_SCALE_MIN, stops[0][1])
    if t >= stops[-1][0]:
        return max(PERSPECTIVE_SCALE_MIN, stops[-1][1])
    for i in range(1, len(stops)):
        lo_p, lo_s = stops[i - 1][0], stops[i - 1][1]
        hi_p, hi_s = stops[i][0], stops[i][1]
        if t <= hi_p:
            if hi_p == lo_p:
                return max(PERSPECTIVE_SCALE_MIN, hi_s)
            k = (t - lo_p) / (hi_p - lo_p)
            return max(PERSPECTIVE_SCALE_MIN, lo_s + (hi_s - lo_s) * k)
    return max(PERSPECTIVE_SCALE_MIN, stops[-1][1])


def _persp_follow_ratio_raw(stops, t: float) -> float:
    """累计倍数 R(t)：t 之前每个**开启**段贡献 f(段起点)/f(段内走到处)，关闭段贡献 1。"""
    r = 1.0
    for i in range(len(stops) - 1):
        lo_p, lo_s, lo_follow = stops[i]
        hi_p, hi_s, _ = stops[i + 1]
        if t <= lo_p:
            break
        if not lo_follow:
            continue
        end_s = max(PERSPECTIVE_SCALE_MIN, hi_s) if t >= hi_p else _persp_scale_at_t(stops, t)
        r *= max(PERSPECTIVE_SCALE_MIN, lo_s) / end_s
    return r


def perspective_camera_follow_info(cfg: dict | None) -> dict | None:
    """相机跟随透视的解析结果；**没写 ``cameraFollow`` 键就返回 None**（= 不跟随）。

    返回 ``{ref_pos, max_zoom_ratio, raw_ratio_at_far, segments}``，其中 ``segments`` 是
    逐段 ``{from_pos, to_pos, from_scale, to_scale, follow, ratio_at_to}``——
    ``ratio_at_to`` 是走完该段的累计 zoom 倍数（已按基准点归一，**未钳上限**），
    编辑器拿它在轴上标"×1.32"、校验器拿它判超限。"""
    if not isinstance(cfg, dict):
        return None
    follow_cfg = cfg.get("cameraFollow")
    if not isinstance(follow_cfg, dict):
        return None
    a = _persp_follow_stops(cfg)
    if a is None:
        return None
    stops = a[5]
    raw_ref = _persp_num(follow_cfg.get("refPos"))
    ref_pos = 0.0 if raw_ref is None else min(1.0, max(0.0, raw_ref))
    raw_max = _persp_num(follow_cfg.get("maxZoomRatio"))
    max_ratio = (raw_max if raw_max is not None and raw_max >= 1.0
                 else DEFAULT_PERSPECTIVE_CAMERA_MAX_ZOOM_RATIO)
    ref_ratio = _persp_follow_ratio_raw(stops, ref_pos)
    norm = ref_ratio if ref_ratio > 0 and math.isfinite(ref_ratio) else 1.0
    segments = []
    for i in range(len(stops) - 1):
        lo_p, lo_s, lo_follow = stops[i]
        hi_p, hi_s, _ = stops[i + 1]
        segments.append({
            "from_pos": lo_p, "to_pos": hi_p,
            "from_scale": lo_s, "to_scale": hi_s,
            "follow": lo_follow,
            "ratio_at_to": _persp_follow_ratio_raw(stops, hi_p) / norm,
        })
    return {
        "ref_pos": ref_pos,
        "max_zoom_ratio": max_ratio,
        "raw_ratio_at_far": _persp_follow_ratio_raw(stops, 1.0) / norm,
        "segments": segments,
    }


def perspective_camera_zoom_ratio_at(cfg: dict | None, foot_x: float, foot_y: float) -> float:
    """镜头锚点处的 zoom 相对基线倍数（已钳上限）；未配置跟随时恒 1.0。

    下限不在这里钳——"视野不超出地图"是相机的事（TS ``Camera.setDrivenZoom``）。"""
    if not isinstance(cfg, dict) or not isinstance(cfg.get("cameraFollow"), dict):
        return 1.0
    a = _persp_follow_stops(cfg)
    if a is None or not math.isfinite(foot_x) or not math.isfinite(foot_y):
        return 1.0
    nx, ny, ax, ay, len_sq, stops = a
    info = perspective_camera_follow_info(cfg)
    if info is None:
        return 1.0
    raw = ((foot_x - nx) * ax + (foot_y - ny) * ay) / len_sq
    t = 0.0 if raw <= 0.0 else (1.0 if raw >= 1.0 else raw)
    ref_ratio = _persp_follow_ratio_raw(stops, info["ref_pos"])
    norm = ref_ratio if ref_ratio > 0 and math.isfinite(ref_ratio) else 1.0
    r = _persp_follow_ratio_raw(stops, t) / norm
    if not math.isfinite(r) or r <= 0:
        return 1.0
    return min(r, info["max_zoom_ratio"])
