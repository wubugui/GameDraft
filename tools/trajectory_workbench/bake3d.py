# -*- coding: utf-8 -*-
"""世界空间（3D）烘焙机：在场景深度还原出的伪世界里做物理 / 拉线，烘成 ``worldKeyframes``。

与 :mod:`.bake`（画面空间 2D）共用采样器镜像、时间曲线、通道轨、抽稀；不同的只有"位置怎么来"：

- 坐标一律 **M-world wu**（``geometry.SceneGeometry``：+Y 向上、XZ 地面、x 右、z 远离相机）；
- 抛体在 3D 里积分（辛欧拉，定步长 1/120 s，与 2D 同一套不变量：能量不增、触地精确 TOI、
  触地/静止瞬间强制成帧）；地面是场景的行走面高度场，墙是深度壳（可见几何那一层，
  "飞到前景物体背后"也算撞——2.5D 的代价，不精确但一致）；
- 手绘段的控制点是 ``{x, z, h}``（地面坐标 + 离地高度），采样时 ``y = 地面(x,z) + h``，
  于是拖控制点过台阶曲线自动跟地形；
- 每个采样点带 ``h``（离地高度），运行时投影 ``sortY`` 靠它（见 ``utils/trajectoryProjection``）。

尺度提醒：150 wu 高的角色 ≈ 1.7 m，1 m ≈ 88 wu，g ≈ 865 wu/s²（作者面给的 `gravity` 是正的大小）。
旋转通道仍是画面上的叠加度数（顺时针为正）：滚动按路程/半径推，符号取**画面 x 方向**
（往右滚 = 顺时针）——3D 自转投到一张 2D 卡片上，只剩这一个自由度是可信的。
"""
from __future__ import annotations

import bisect
import math
from dataclasses import dataclass, field
from typing import Any, Sequence

from .bake import (
    DEFAULT_SAMPLE_HZ,
    DEFAULT_TOLERANCE,
    PHYSICS_STEP_HZ,
    PHYSICS_STEP_SEC,
    _clean_keys,
    _solve_progress_time,
    _uniform_times,
    decimate_samples,
    eval_timing,
    eval_track,
    resolve_sample_hz,
    resolve_tolerance,
)
from .model import as_number

__all__ = [
    "WORLD_CHANNELS",
    "WORLD_TOLERANCE_KEY",
    "BakeResult3D",
    "resolve_world_start",
    "simulate_physics_3d",
    "manual_samples_3d",
    "bake_world_samples",
]

_EPS = 1e-9

#: 3D 采样的通道（抽稀用），``h`` 走位置档。
WORLD_CHANNELS: tuple[str, ...] = ("x", "y", "z", "h", "rotation", "scaleX", "scaleY", "alpha")
WORLD_TOLERANCE_KEY: dict[str, str] = {
    "x": "pos", "y": "pos", "z": "pos", "h": "pos",
    "rotation": "rot", "scaleX": "scale", "scaleY": "scale", "alpha": "alpha",
}


@dataclass
class BakeResult3D:
    """:func:`bake_world_samples` 的产物（世界坐标绝对值，还没抽稀、还没相对化）。"""

    samples: list[dict] = field(default_factory=list)
    total_ms: float = 0.0
    segments: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    sample_hz: int = DEFAULT_SAMPLE_HZ
    tolerance: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_TOLERANCE))


# ---------------------------------------------------------------------------
# 点 / 路径（3D）
# ---------------------------------------------------------------------------

def _pt_xzh(raw: Any) -> tuple[float, float, float] | None:
    """作者面点 ``{x, z, h}``（世界地面坐标 + 离地高度）。缺 z 的（2D 遗留）不认。

    ``h`` **原样保留**（可以为负）：钳 0 只在整体平移到段起点之后做（:func:`manual_samples_3d`），
    与前端 ``Edit.effPointsWorld`` 同式。读进来就钳会把"存储 h 整体偏负"的形状逐点压平成贴地拖行，
    而画布（先加 delta 再钳）看起来仍是弧线——审查 2026-09-04 抓到过这条静默毁坏。
    """
    if not isinstance(raw, dict):
        return None
    if raw.get("z") is None:
        return None
    return (as_number(raw.get("x"), 0.0), as_number(raw.get("z"), 0.0), as_number(raw.get("h"), 0.0))


def _xzh_to_world(geom, x: float, z: float, h: float) -> tuple[float, float, float]:
    return (x, geom.ground_height(x, z) + h, z)


def _world_to_xzh(geom, x: float, y: float, z: float) -> tuple[float, float, float]:
    return (x, z, max(0.0, y - geom.ground_height(x, z)))


def _catmull_rom3(p0, p1, p2, p3, u: float) -> tuple[float, float, float]:
    u2 = u * u
    u3 = u2 * u
    out = []
    for i in range(3):
        a = p0[i]; b = p1[i]; c = p2[i]; d = p3[i]
        out.append(0.5 * ((2 * b) + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3))
    return (out[0], out[1], out[2])


@dataclass(frozen=True)
class ArcLut3:
    """(x, z, h) 空间的弧长表：``pts`` 密点、``s`` 累计弧长、``vertex_s01`` 控制点归一位置。"""

    pts: tuple[tuple[float, float, float], ...]
    s: tuple[float, ...]
    total: float
    vertex_s01: tuple[float, ...]
    #: 控制点的离地高度：h 不走样条（Catmull-Rom 在"等高→升高"之间会先下沉到地面以下），
    #: 按弧长在控制点之间线性插值。
    vertex_h: tuple[float, ...] = ()


def _arc_lut3(points: Sequence[tuple[float, float, float]], smooth: bool, samples_per_span: int = 16) -> ArcLut3:
    pts = [tuple(map(float, p)) for p in points]
    if not pts:
        pts = [(0.0, 0.0, 0.0)]
    if len(pts) == 1:
        return ArcLut3((pts[0],), (0.0,), 0.0, (0.0,), (pts[0][2],))
    dense: list[tuple[float, float, float]] = []
    vertex_idx: list[int] = []
    if smooth and len(pts) >= 3:
        ext = [pts[0]] + pts + [pts[-1]]
        for i in range(len(pts) - 1):
            vertex_idx.append(len(dense))
            p0, p1, p2, p3 = ext[i], ext[i + 1], ext[i + 2], ext[i + 3]
            for k in range(samples_per_span):
                dense.append(_catmull_rom3(p0, p1, p2, p3, k / samples_per_span))
        vertex_idx.append(len(dense))
        dense.append(pts[-1])
    else:
        for i in range(len(pts) - 1):
            vertex_idx.append(len(dense))
            dense.append(pts[i])
        vertex_idx.append(len(dense))
        dense.append(pts[-1])
    s = [0.0]
    for a, b in zip(dense, dense[1:]):
        s.append(s[-1] + math.dist(a, b))
    total = s[-1]
    vs = tuple((s[i] / total) if total > 0 else 0.0 for i in vertex_idx)
    return ArcLut3(tuple(dense), tuple(s), total, vs, tuple(p[2] for p in pts))


def _height_at(lut: ArcLut3, s01: float) -> float:
    vs, vh = lut.vertex_s01, lut.vertex_h
    if not vh:
        return 0.0
    if len(vh) == 1 or s01 <= vs[0]:
        return vh[0]
    if s01 >= vs[-1]:
        return vh[-1]
    j = bisect.bisect_right(vs, s01) - 1
    j = max(0, min(j, len(vs) - 2))
    span = vs[j + 1] - vs[j]
    f = (s01 - vs[j]) / span if span > 0 else 0.0
    return vh[j] + (vh[j + 1] - vh[j]) * f


def _point_at3(lut: ArcLut3, s01: float) -> tuple[float, float, float]:
    """弧长参数 → ``(x, z, h)``：x/z 走密点表（折线或样条），h 按控制点线性插值。"""
    if lut.total <= 0 or len(lut.pts) == 1:
        return lut.pts[0]
    s01 = min(max(s01, 0.0), 1.0)
    target = s01 * lut.total
    i = bisect.bisect_right(lut.s, target) - 1
    i = max(0, min(i, len(lut.pts) - 2))
    a, b = lut.pts[i], lut.pts[i + 1]
    span = lut.s[i + 1] - lut.s[i]
    f = (target - lut.s[i]) / span if span > 0 else 0.0
    return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, max(0.0, _height_at(lut, s01)))


# ---------------------------------------------------------------------------
# 段起点
# ---------------------------------------------------------------------------

def resolve_world_start(
    seg: Any,
    *,
    index: int,
    prev_end: tuple[float, float, float] | None,
    anchor: tuple[float, float, float] | None,
    geom,
) -> tuple[float, float, float]:
    """段起点（世界坐标）。梯子与 2D 同：``anchor / previous / explicit``，末端退到 ``path[0]``。"""
    s = seg if isinstance(seg, dict) else {}
    mode = str(s.get("startFrom") or "").strip()
    if mode == "entity":
        mode = "anchor"
    if mode not in ("anchor", "previous", "explicit"):
        mode = "anchor" if index == 0 else "previous"
    explicit = None
    raw = _pt_xzh(s.get("start"))
    if raw is not None:
        explicit = _xzh_to_world(geom, *raw)
    head = None
    path = s.get("path")
    if isinstance(path, dict):
        pts = [q for q in (_pt_xzh(p) for p in (path.get("points") or [])) if q is not None]
        if pts:
            head = _xzh_to_world(geom, *pts[0])
    if mode == "anchor":
        order = (anchor, prev_end, explicit, head)
    elif mode == "previous":
        order = (prev_end, anchor, explicit, head)
    else:
        order = (explicit, prev_end, anchor, head)
    for cand in order:
        if cand is not None:
            return (float(cand[0]), float(cand[1]), float(cand[2]))
    return (0.0, 0.0, 0.0)


# ---------------------------------------------------------------------------
# 抛体（3D）
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Node3:
    t: float
    x: float
    y: float
    z: float
    vx: float
    vy: float
    vz: float
    rot: float
    omega: float
    grounded: bool
    hard: bool
    #: 离地高度（贴地恒 = rest_h；腾空 = y − 地面）。重采样按它插值，别再去减地面高度场。
    h: float = 0.0


def _screen_dx_sign(geom, vx: float, vy: float, vz: float) -> float:
    """速度在画面 x 上的符号（往右滚 = 顺时针）。"""
    r = geom.rows
    sx = r[0] * vx + r[3] * vy + r[6] * vz
    return 1.0 if sx >= 0 else -1.0


def simulate_physics_3d(seg: Any, start_pose: Any, geom, *, rest_h: float) -> list[Node3]:
    """定步长（1/120 s）3D 抛体积分到停机。

    - 重力：``vy -= g·dt``（作者面 `gravity` 是正的大小）；
    - 地面：``y_contact = 地面(x,z) + rest_h``（``rest_h`` = 锚点离地高度，圆心锚的铜钱 = 半径）；
      触地用精确 TOI（按当前地面高度当平面解），法向按地面法线反射、切向按 `tangentialDamping` 衰减，
      弹起速度低于阈值即贴地滚动（速度只剩切向，摩擦线性减速，沿地形走）；
    - 墙：深度壳（法线不朝上的像素）。球心到壳的深度差 < `radius` 就算撞：沿法线反射，
      再把球心推到壳前 `radius` 处。贴地滚动时同样查（滚进墙里弹回来）；
    - 自转：``omega = deg(速度/spin.radius) × 画面x方向符号``；腾空保持。
    """
    s = seg if isinstance(seg, dict) else {}
    p = start_pose if isinstance(start_pose, dict) else {}
    v0 = s.get("v0") if isinstance(s.get("v0"), dict) else {}
    stop = s.get("stop") if isinstance(s.get("stop"), dict) else {}
    spin = s.get("spin") if isinstance(s.get("spin"), dict) else None

    g = abs(as_number(s.get("gravity"), 0.0))
    restitution = max(0.0, as_number(s.get("restitution"), 0.0))
    damping = as_number(s.get("tangentialDamping"), 0.0)
    damping = 0.0 if damping < 0 else (1.0 if damping > 1 else damping)
    friction = max(0.0, as_number(s.get("rollingFriction"), 0.0))
    min_speed = max(0.0, as_number(stop.get("minSpeed"), 0.0))
    max_ms = as_number(stop.get("maxMs"), 0.0)
    if not (max_ms > 0):
        max_ms = 5000.0
    max_sec = max_ms / 1000.0
    spin_r = as_number(spin.get("radius"), 0.0) if spin is not None else 0.0
    has_spin = spin is not None and abs(spin_r) > _EPS
    radius = max(0.0, as_number(s.get("radius"), spin_r if has_spin else 0.0))

    x = as_number(p.get("x"), 0.0)
    y = as_number(p.get("y"), 0.0)
    z = as_number(p.get("z"), 0.0)
    vx = as_number(v0.get("x"), 0.0)
    vy = as_number(v0.get("y"), 0.0)
    vz = as_number(v0.get("z"), 0.0)
    rot = as_number(p.get("rotation"), 0.0)
    omega = as_number(spin.get("omega0"), 0.0) if spin is not None else 0.0

    def contact_y(px: float, pz: float) -> float:
        return geom.ground_height(px, pz) + rest_h

    # 起点在地下（作者面手滑）先提到地面
    gy = contact_y(x, z)
    if y < gy:
        y = gy
    grounded = (y - gy) <= 1e-6 and vy <= 0
    if grounded:
        y = gy
        vy = 0.0
        if has_spin:
            omega = math.degrees(math.hypot(vx, vz) / spin_r) * _screen_dx_sign(geom, vx, vy, vz)
    bounce_min = max(min_speed, g * PHYSICS_STEP_SEC * 2.0, 1e-9)

    def _mk(tt, px, py, pz, ux, uy, uz, rr, om, gr, hd) -> Node3:
        hh = rest_h if gr else max(rest_h, py - geom.ground_height(px, pz))
        return Node3(tt, px, py, pz, ux, uy, uz, rr, om, gr, hd, hh)

    nodes: list[Node3] = [_mk(0.0, x, y, z, vx, vy, vz, rot, omega, grounded, True)]
    t = 0.0
    max_nodes = int(max_sec * PHYSICS_STEP_HZ) * 4 + 256

    def wall_hit() -> bool:
        """球心撞壳（非地面像素）：反射 + 推出。返回是否发生。"""
        nonlocal x, y, z, vx, vy, vz
        c = geom.shell_contact(x, y, z)
        if c is None or c["ground_like"]:
            return False
        if c["pen_wu"] <= -radius:
            return False
        nx, ny, nz = c["normal"]
        vn = vx * nx + vy * ny + vz * nz
        if vn < 0:
            k = (1.0 + restitution) * vn
            vx -= k * nx
            vy -= k * ny
            vz -= k * nz
            # 切向衰减
            vn2 = vx * nx + vy * ny + vz * nz
            tx, ty, tz = vx - vn2 * nx, vy - vn2 * ny, vz - vn2 * nz
            vx, vy, vz = vn2 * nx + tx * (1 - damping), vn2 * ny + ty * (1 - damping), vn2 * nz + tz * (1 - damping)
        x, y, z = geom.push_in_front_of_shell(x, y, z, radius + 0.5)
        return True

    while True:
        if t >= max_sec - _EPS:
            break
        if grounded and math.hypot(vx, vz) < min_speed:
            break
        if len(nodes) >= max_nodes:
            break
        remaining = min(PHYSICS_STEP_SEC, max_sec - t)
        guard = 0
        while remaining > 1e-12 and guard < 16:
            guard += 1
            if grounded:
                speed = math.hypot(vx, vz)
                new_speed = max(0.0, speed - friction * remaining)
                if speed > 0:
                    vx *= new_speed / speed
                    vz *= new_speed / speed
                else:
                    vx = vz = 0.0
                vy = 0.0
                x += vx * remaining
                z += vz * remaining
                y = contact_y(x, z)
                if has_spin:
                    omega = math.degrees(new_speed / spin_r) * _screen_dx_sign(geom, vx, 0.0, vz)
                rot += omega * remaining
                t += remaining
                remaining = 0.0
                hit = wall_hit()
                nodes.append(_mk(t, x, y, z, vx, vy, vz, rot, omega, True, hit))
                continue

            vy_end = vy - g * remaining
            y_end = y + vy_end * remaining
            gy_now = contact_y(x + vx * remaining, z + vz * remaining)
            if y_end <= gy_now and vy_end < 0:
                # 精确 TOI：在当前高度的平面上解 y(s) = y + (vy − g s) s = gy
                d = max(0.0, y - gy_now)
                s_hit = _toi(g, vy, d, remaining)
                vy_hit = vy - g * s_hit
                x += vx * s_hit
                z += vz * s_hit
                y = contact_y(x, z)
                t += s_hit
                remaining -= s_hit
                nx, ny, nz = geom.ground_normal(x, z)
                vn = vx * nx + vy_hit * ny + vz * nz          # < 0（撞向地面）
                vn_rebound = -vn * restitution
                if abs(vn) <= bounce_min or abs(vn_rebound) <= bounce_min:
                    # 贴地：去掉法向分量
                    vx -= vn * nx
                    vz -= vn * nz
                    vy = 0.0
                    grounded = True
                    if has_spin:
                        omega = math.degrees(math.hypot(vx, vz) / spin_r) * _screen_dx_sign(geom, vx, 0.0, vz)
                else:
                    k = (1.0 + restitution) * vn
                    vx = vx - k * nx
                    vy = vy_hit - k * ny
                    vz = vz - k * nz
                    vn2 = vx * nx + vy * ny + vz * nz
                    tx, ty, tz = vx - vn2 * nx, vy - vn2 * ny, vz - vn2 * nz
                    vx, vy, vz = vn2 * nx + tx * (1 - damping), vn2 * ny + ty * (1 - damping), vn2 * nz + tz * (1 - damping)
                nodes.append(_mk(t, x, y, z, vx, vy, vz, rot, omega, grounded, True))
            else:
                vy = vy_end
                y = y_end
                x += vx * remaining
                z += vz * remaining
                rot += omega * remaining
                t += remaining
                remaining = 0.0
                hit = wall_hit()
                nodes.append(_mk(t, x, y, z, vx, vy, vz, rot, omega, False, hit))

    last = nodes[-1]
    nodes[-1] = Node3(last.t, last.x, last.y, last.z, last.vx, last.vy, last.vz, last.rot, last.omega, last.grounded, True, last.h)
    return nodes


def _toi(g: float, vy: float, d: float, h: float) -> float:
    """解 ``y − gy = d`` 下落 ``d`` 的时刻：``g·s² − vy·s = d``（vy 向上为正）。取 (0, h] 内最小正根，解不出退 h。"""
    if d <= 0:
        return 0.0
    if g <= _EPS:
        if vy >= 0:
            return h
        return min(h, d / -vy)
    disc = vy * vy + 4.0 * g * d
    if disc < 0:
        return h
    root = math.sqrt(disc)
    best = None
    for c in ((vy + root) / (2.0 * g), (vy - root) / (2.0 * g)):
        if c > 0 and c <= h + _EPS and (best is None or c < best):
            best = c
    return h if best is None else min(best, h)


def _resample_nodes(nodes: Sequence[Node3], hz: int, base: dict, geom, rest_h: float) -> list[dict]:
    """节点串 → 按 hz 重采样的姿态列表（``atMs`` 相对段起点）。硬节点时刻恒保留。"""
    duration = nodes[-1].t
    times: list[float]
    if duration <= 0:
        times = [0.0]
    else:
        step = 1.0 / hz
        times = []
        k = 0
        while True:
            tv = k * step
            if tv >= duration:
                break
            times.append(tv)
            k += 1
        times.append(duration)
    hard_times = {round(n.t, 12) for n in nodes if n.hard}
    times = sorted({round(tv, 12) for tv in times} | hard_times)
    node_ts = [n.t for n in nodes]
    out: list[dict] = []
    for tv in times:
        i = bisect.bisect_right(node_ts, tv) - 1
        i = max(0, min(i, len(nodes) - 2)) if len(nodes) > 1 else 0
        a = nodes[i]
        b = nodes[min(i + 1, len(nodes) - 1)]
        span = b.t - a.t
        f = (tv - a.t) / span if span > 0 else 0.0
        f = 0.0 if f < 0 else (1.0 if f > 1 else f)
        x = a.x + (b.x - a.x) * f
        y = a.y + (b.y - a.y) * f
        z = a.z + (b.z - a.z) * f
        # 离地高度按节点 h 插值（贴地节点恒 rest_h，腾空节点 ≥ rest_h）：
        # 直接减地面高度场会在落地前后因插值毫厘差出现 h < rest_h，sortY 跟着抖。
        h = a.h + (b.h - a.h) * f
        out.append({
            "atMs": tv * 1000.0,
            "x": x, "y": y, "z": z,
            "h": h,
            "rotation": a.rot + (b.rot - a.rot) * f,
            "scaleX": base["scaleX"], "scaleY": base["scaleY"], "alpha": base["alpha"],
            "hard": round(tv, 12) in hard_times,
        })
    return out


# ---------------------------------------------------------------------------
# 手绘（3D）
# ---------------------------------------------------------------------------

def manual_samples_3d(seg: dict, start_xyz: tuple[float, float, float], base: dict, geom, *,
                      hz: int, warnings: list[str]) -> list[dict]:
    """手绘段：``{x,z,h}`` 控制点的路径 + 时间曲线 + 通道轨 → 采样（``atMs`` 相对段起点）。

    路径是形状，整体平移到段起点（与 2D 同：``delta = start − points[0]``，在 (x,z,h) 上平移）。
    ``y = 地面(x,z) + h``：曲线自动跟地形。
    """
    timing = seg.get("timing") if isinstance(seg.get("timing"), dict) else {}
    duration = max(0.0, as_number(timing.get("durationMs"), 0.0))
    keys = timing.get("keys")
    path = seg.get("path") if isinstance(seg.get("path"), dict) else {}
    pts = [q for q in (_pt_xzh(p) for p in (path.get("points") or [])) if q is not None]
    start_xzh = _world_to_xzh(geom, *start_xyz)
    if not pts:
        pts = [start_xzh]
    else:
        dx = start_xzh[0] - pts[0][0]
        dz = start_xzh[1] - pts[0][1]
        dh = start_xzh[2] - pts[0][2]
        shifted = [(p[0] + dx, p[1] + dz, p[2] + dh) for p in pts]
        # 客户端高度场 vs 服务端 anchorWorld 有 <1 wu 的几何残差（见 trajectory-workbench 卡）：低于 0.5 wu 的"钻地"是噪声，不报
        below = sum(1 for p in shifted if p[2] < -0.5)
        if below:
            warnings.append(f"段 {seg.get('id') or '?'}: {below} 个控制点在起点对齐后钻到地面以下（存储 h 偏负），已钳到地面——"
                            "多半是换场景 / 换实体时形状没搬对，检查一下高度")
        pts = [(p[0], p[1], max(0.0, p[2])) for p in shifted]
    smooth = bool(path.get("smooth"))
    lut = _arc_lut3(pts, smooth)
    tracks = seg.get("tracks") if isinstance(seg.get("tracks"), dict) else {}
    roll = seg.get("roll") if isinstance(seg.get("roll"), dict) else None
    roll_radius = as_number(roll.get("radius"), 0.0) if roll else 0.0
    roll_dir = -1.0 if (roll and as_number(roll.get("direction"), 1.0) < 0) else 1.0
    use_roll = roll is not None and abs(roll_radius) > _EPS
    if roll is not None and not use_roll:
        warnings.append(f"段 {seg.get('id') or '?'}: roll.radius 为 0，滚动被忽略")

    hard: set[float] = {0.0, round(duration, 9)}
    for k in keys or []:
        if isinstance(k, dict) and k.get("atMs") is not None:
            hard.add(round(min(max(0.0, as_number(k.get("atMs"), 0.0)), duration), 9))
    for ch in ("rotation", "scale", "scaleX", "scaleY", "alpha"):
        for k in tracks.get(ch) or []:
            if isinstance(k, dict) and k.get("atMs") is not None:
                hard.add(round(min(max(0.0, as_number(k.get("atMs"), 0.0)), duration), 9))
    if not smooth:
        for s01 in lut.vertex_s01[1:-1]:
            tv = _solve_progress_time(keys, duration, s01)
            if tv is not None:
                hard.add(round(min(max(0.0, tv), duration), 9))
    times = sorted({round(v, 9) for v in _uniform_times(duration, hz)} | hard)
    has_scale = tracks.get("scale") is not None
    has_sx = tracks.get("scaleX") is not None
    has_sy = tracks.get("scaleY") is not None

    out: list[dict] = []
    for tv in times:
        prog = eval_timing(keys, tv, duration)
        px, pz, ph = _point_at3(lut, prog)
        wx, wy, wz = _xzh_to_world(geom, px, pz, ph)
        if use_roll:
            rotation = base["rotation"] + roll_dir * math.degrees(prog * lut.total / roll_radius)
        else:
            rotation = eval_track(tracks.get("rotation"), tv, base["rotation"])
        if has_sx:
            sx = eval_track(tracks.get("scaleX"), tv, base["scaleX"])
        elif has_scale:
            sx = eval_track(tracks.get("scale"), tv, base["scaleX"])
        else:
            sx = base["scaleX"]
        if has_sy:
            sy = eval_track(tracks.get("scaleY"), tv, base["scaleY"])
        elif has_scale:
            sy = eval_track(tracks.get("scale"), tv, base["scaleY"])
        else:
            sy = base["scaleY"]
        out.append({
            "atMs": tv, "x": wx, "y": wy, "z": wz, "h": ph,
            "rotation": rotation, "scaleX": sx, "scaleY": sy,
            "alpha": eval_track(tracks.get("alpha"), tv, base["alpha"]),
            "hard": tv in hard,
        })
    return out


# ---------------------------------------------------------------------------
# 编排
# ---------------------------------------------------------------------------

def _pose_equal3(a: dict, b: dict) -> bool:
    return all(abs(as_number(a.get(ch), 0.0) - as_number(b.get(ch), 0.0)) <= 1e-9 for ch in WORLD_CHANNELS)


def bake_world_samples(traj: Any, geom, *, anchor_world: tuple[float, float, float] | None,
                       rest_h: float) -> BakeResult3D:
    """``source.segments`` → 世界坐标密采样（绝对值）。分段链接与 2D 同：第 i 段起于第 i−1 段末姿态。"""
    d = traj if isinstance(traj, dict) else {}
    src = d.get("source") if isinstance(d.get("source"), dict) else {}
    bake_cfg = src.get("bake") if isinstance(src.get("bake"), dict) else {}
    hz = resolve_sample_hz(bake_cfg.get("sampleHz"))
    result = BakeResult3D(sample_hz=hz, tolerance=resolve_tolerance(bake_cfg))
    segments = src.get("segments")
    if not isinstance(segments, list) or not segments:
        result.warnings.append("source.segments 为空：没有可烘的段（调用方应保留原 keyframes，不要清空）")
        return result
    if not getattr(geom, "has_depth", False):
        result.warnings.append("场景没有 depthConfig / 深度图：世界空间无法还原，请换画面空间或先烘该场景深度")
        return result

    base = {"rotation": 0.0, "scaleX": 1.0, "scaleY": 1.0, "alpha": 1.0}
    prev_end: tuple[float, float, float] | None = None
    offset = 0.0
    all_samples: list[dict] = []
    for index, seg in enumerate(segments):
        if not isinstance(seg, dict):
            result.warnings.append(f"第 {index + 1} 段不是对象，已跳过")
            continue
        kind = str(seg.get("kind") or "").strip()
        start = resolve_world_start(seg, index=index, prev_end=prev_end, anchor=anchor_world, geom=geom)
        pose = dict(base)
        pose.update({"x": start[0], "y": start[1], "z": start[2]})
        if kind == "physics":
            nodes = simulate_physics_3d(seg, pose, geom, rest_h=rest_h)
            samples = _resample_nodes(nodes, resolve_sample_hz(seg.get("sampleHz"), hz), pose, geom, rest_h)
        elif kind == "manual":
            samples = manual_samples_3d(seg, start, pose, geom, hz=hz, warnings=result.warnings)
        else:
            result.warnings.append(f"第 {index + 1} 段 kind={kind!r} 未知，已跳过")
            continue
        if not samples:
            continue
        seg_start = offset
        seg_end = offset + as_number(samples[-1].get("atMs"), 0.0)
        for raw in samples:
            sm = dict(raw)
            sm["atMs"] = as_number(sm.get("atMs"), 0.0) + offset
            if all_samples and abs(sm["atMs"] - all_samples[-1]["atMs"]) <= 1e-9 and _pose_equal3(sm, all_samples[-1]):
                if sm.get("hard"):
                    all_samples[-1]["hard"] = True
                continue
            all_samples.append(sm)
        last = all_samples[-1]
        prev_end = (last["x"], last["y"], last["z"])
        base = {ch: last[ch] for ch in ("rotation", "scaleX", "scaleY", "alpha")}
        offset = seg_end
        result.segments.append({
            "id": str(seg.get("id") or ""), "kind": kind,
            "startMs": seg_start, "endMs": seg_end,
            "start": list(start), "end": list(prev_end),
        })
    result.samples = all_samples
    result.total_ms = all_samples[-1]["atMs"] if all_samples else 0.0
    # 行走面高度场之外的采样：那里的地面高度只是边缘钳位，不可信——出声
    bounds_fn = getattr(geom, "ground_bounds", None)
    if callable(bounds_fn) and all_samples:
        try:
            bx0, bx1, bz0, bz1 = bounds_fn()
            outside = sum(1 for s in all_samples if not (bx0 <= s["x"] <= bx1 and bz0 <= s["z"] <= bz1))
            if outside:
                result.warnings.append(f"{outside}/{len(all_samples)} 个采样点落在行走面范围之外（画面外 / 深度没覆盖到），那里的地面高度不可信")
        except Exception:  # noqa: BLE001 — 假几何没有边界就跳过
            pass
    return result


def decimate_world_samples(samples: Sequence[dict], tolerance: dict[str, float] | None) -> list[dict]:
    return decimate_samples(samples, tolerance, channels=WORLD_CHANNELS, tolerance_key=WORLD_TOLERANCE_KEY)


# 暴露给 bake 侧复用的私有名（保持一处实现）
_ = (_clean_keys,)
