"""实体轨迹动画的**烘焙机**（纯函数、零 Qt、零磁盘、零随机）。

## 这台机器干什么

作者面给的是「手绘路径 + 时间曲线」和「抛体物理参数」；运行时只会播
``TrajectoryKeyframe[]``。本模块就是中间那一步::

    source.segments  --逐段解算--> 密采样 --分通道抽稀--> keyframes（写盘形）

**运行时零物理**：弹跳、滚动、摩擦全在编辑期算完，落盘只剩位置/旋转/缩放/透明/深度锚。

## 五条不许动的语义

1. **采样器逐字镜像 TS**。:func:`sample_keyframes` 是 ``src/utils/keyframeSampler.ts``
   的 Python 投影，跨语言金标在 ``src/utils/keyframeSampler.golden.json``
   （``tools/trajectory_workbench/tests/test_bake.py`` 逐 case 断言，容差 1e-9）。
   缓动是**二次族**，段缓动取**起始帧**的 easing，``span = max(1, Δms)``
   —— 所以 `sampleHz` 别超过 1000，亚毫秒段会被拉成 1ms。
2. **烘焙产物恒不写 `easing`**。密帧 + 段缓动 = 缓动两遍（与 parallax 同一硬契约）。
   落形由 :func:`~tools.trajectory_workbench.model.write_keyframe` 负责。
3. **世界空间、Y 向下**。重力向下为**正**；往上抛 ``v0.y`` 是**负**；地面 `groundY`
   是个**较大**的 y；落地判据是 ``y >= groundY``。角色高 150 wu 是尺度锚。
   旋转正方向 = 屏幕上的**顺时针**（Y 向下时 ``atan2(dy, dx)`` 的正向）。
4. **物理定步长 1/120 s**，与 `sampleHz` **解耦**：先定步长积分出真实轨迹，再按 hz
   重采样。改 `sampleHz` 只改帧的疏密，**不改物理**——不然策划一调采样率弹跳高度就变了。
5. **确定性**：同一输入两次调用逐字节相同。不用 set 迭代序、不用随机、不看时钟。

## 抽稀为什么用"竖直偏差"而不是经典 RDP 的垂距

经典 Ramer–Douglas–Peucker 用点到弦的**垂线距离**，那个量在 (时间, 数值) 这种量纲
不一致的空间里没有意义，而且**不给出数值误差上界**。本模块一律用**同一时刻的数值差**
（``|v_k - lerp(v_a, v_b, t_k)|``），因此"抽稀后在任意原始采样点上的偏差 ≤ 容差"
是**可断言的**（:func:`decimate_samples` 末尾还有一道强制收敛的补点闸门兜底）。

## 触地/静止为什么必须强制成帧

抽稀是按误差挑点的，弹跳的**尖角**恰好是误差最大处——但只有在采样点正好落在尖角上时
才留得住。所以物理段把**触地瞬间**和**静止瞬间**直接标成 `hard`，绕过抽稀。
不这么做，弹跳会被磨成一条圆滑的抛物线，而且没有任何东西会报错。

## 权威契约

``src/data/types.ts`` 的 ``TrajectoryAsset`` / ``TrajectorySource`` /
``ManualSegmentSource`` / ``PhysicsSegmentSource``。字段名逐字对齐。

本模块是**画面空间（2D）**的烘焙机；世界空间（3D）的物理与投影在 :mod:`.bake3d` /
:mod:`.projection`，两者共用这里的采样器镜像、时间曲线、通道轨与抽稀。
坐标：本模块内一律是烘焙场景的**绝对**场景坐标；写成资产时由 :mod:`.assets`
减去锚点变成相对帧。
"""
from __future__ import annotations

import bisect
import math
from dataclasses import dataclass, field
from typing import Any, Sequence

from .model import (
    POSE_CHANNELS,
    as_number,
    normalize_keyframe,
    sampler_channels,
    write_keyframe,
)

__all__ = [
    "KEYFRAME_EASINGS",
    "PHYSICS_STEP_HZ",
    "PHYSICS_STEP_SEC",
    "DEFAULT_SAMPLE_HZ",
    "SAMPLE_HZ_MIN",
    "SAMPLE_HZ_MAX",
    "DEFAULT_TOLERANCE",
    "CHANNEL_TOLERANCE_KEY",
    "ArcLut",
    "PhysicsNode",
    "PhysicsRun",
    "BakeResult",
    "apply_keyframe_easing",
    "sample_keyframes",
    "sample_trajectory_pose",
    "arc_length_lut",
    "point_at_arc",
    "resolve_manual_path",
    "resolve_segment_start",
    "eval_timing",
    "timing_warnings",
    "eval_track",
    "simulate_physics_nodes",
    "simulate_physics",
    "resolve_sample_hz",
    "resolve_tolerance",
    "decimate_samples",
    "bake_samples",
    "bake_trajectory",
]

KEYFRAME_EASINGS: tuple[str, ...] = ("linear", "easeIn", "easeOut", "easeInOut")

#: 物理积分的**固定**步频（Hz）。与 `sampleHz` 解耦：改采样率不改物理。
PHYSICS_STEP_HZ = 120
#: 单步秒数。
PHYSICS_STEP_SEC = 1.0 / PHYSICS_STEP_HZ

DEFAULT_SAMPLE_HZ = 60
SAMPLE_HZ_MIN = 10
#: 上限 240：采样器 ``span = max(1, Δms)`` 会把亚毫秒段拉成 1ms，
#: 采样率一旦逼近 1000Hz，落盘的帧间距就开始被那条下限吃掉。
SAMPLE_HZ_MAX = 240

#: 抽稀缺省容差。位置/深度锚按 wu（角色高 150 wu），角度按度。
DEFAULT_TOLERANCE: dict[str, float] = {"pos": 0.5, "rot": 0.5, "scale": 0.005, "alpha": 0.005}

#: 通道 → 容差档。`sortY` 是个 y，走位置档。
CHANNEL_TOLERANCE_KEY: dict[str, str] = {
    "x": "pos",
    "y": "pos",
    "sortY": "pos",
    "rotation": "rot",
    "scaleX": "scale",
    "scaleY": "scale",
    "alpha": "alpha",
}

_EPS = 1e-9


# ===========================================================================
# 1. 采样器 —— src/utils/keyframeSampler.ts 的逐字镜像
# ===========================================================================

def apply_keyframe_easing(u: float, easing: Any) -> float:
    """把线性进度 `u` 按缓动族重映射。**二次族**，不夹紧、不校验入参。

    逐字对应 TS ``applyKeyframeEasing``：越界的 `u` 按同一多项式外推。
    未知字符串（含 None）一律当 ``linear`` —— 与 TS 的三元链末端一致。
    """
    if easing == "easeIn":
        return u * u
    if easing == "easeOut":
        return 1 - (1 - u) * (1 - u)
    if easing == "easeInOut":
        return 2 * u * u if u < 0.5 else 1 - pow(-2 * u + 2, 2) / 2
    return u


def _get(frame: Any, key: str) -> Any:
    return frame.get(key) if isinstance(frame, dict) else None


def _norm_channels(frame: Any, names: Sequence[str], channels: dict) -> dict:
    """TS 里的 ``norm(k)``：键不是 number 就取 `channels` 的缺省值（缺省照样参与插值）。"""
    src: dict = frame if isinstance(frame, dict) else {}
    out: dict = {}
    for name in names:
        v = src.get(name)
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            out[name] = float(channels[name])
        else:
            out[name] = float(v)
    return out


def sample_keyframes(
    kf: Sequence[Any],
    t_ms: float,
    *,
    loop: bool = False,
    default_easing: Any = "linear",
    channels: dict,
    cursor: dict | None = None,
) -> dict:
    """在关键帧序列内按 `t_ms` 采样各通道值 —— ``sampleKeyframeTrack`` 的 Python 镜像。

    返回 dict 的键集**恒等于** `channels` 的键集。

    边界语义（改一条就是跨语言行为回归，金标 12 个 case 全在盯着）:

    - **单帧直接返回该帧**（不看 loop、不看 t）；
    - ``loop`` 且末帧 ``atMs > 0`` 时先环绕 ``((t % total) + total) % total``；
      末帧 ``atMs == 0`` 时 ``total == 0``，**不环绕**；
    - ``t <= 首帧.atMs`` → 首帧；``t >= 末帧.atMs`` → 末帧；
    - ``span = max(1, b.atMs - a.atMs)`` —— **亚毫秒段被拉到 1ms**；
    - 段缓动 ``a.easing ?? default_easing ?? 'linear'``：**起始帧说了算**，
      末帧的 easing 永不生效；
    - 空数组返回 `channels` 的副本（TS 侧会抛，调用方已全部前置拦掉；这里选更安全的一侧）。

    `cursor`（``{'i': int}``）是可选的顺播游标，给了就原地推进并回写。
    **给不给结果逐位相同**（测试锁死），只是复杂度从 O(n) 降到 O(1)。

    ⚠ 取模用 :func:`math.fmod` 而不是 Python 的 ``%``：JS 的 ``%`` 是**截断**取模
    （``-750 % 1000 === -750``），Python 的是**向下**取模（得 250）。外面那层
    ``+ total) % total`` 会把两者抹平，但镜像代码不该赌这种"恰好一样"。
    """
    names = list(channels.keys())

    def set_cursor(i: int) -> None:
        if cursor is not None:
            cursor["i"] = i

    n = len(kf)
    if n == 0:
        set_cursor(0)
        return {name: float(channels[name]) for name in names}
    if n == 1:
        set_cursor(0)
        return _norm_channels(kf[0], names, channels)

    last = kf[n - 1]
    total = as_number(_get(last, "atMs"), 0.0)
    t = as_number(t_ms, 0.0)
    if loop and total > 0:
        t = math.fmod(math.fmod(t, total) + total, total)
    first_at = as_number(_get(kf[0], "atMs"), 0.0)
    if t <= first_at:
        set_cursor(0)
        return _norm_channels(kf[0], names, channels)
    if t >= total:
        set_cursor(n - 2)
        return _norm_channels(last, names, channels)

    i = 0
    if cursor is not None:
        raw = cursor.get("i", 0)
        i = int(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else 0
        if not i >= 0:
            i = 0
        if i > n - 2:
            i = n - 2
        while i > 0 and as_number(_get(kf[i], "atMs"), 0.0) > t:
            i -= 1
    while i < n - 1 and as_number(_get(kf[i + 1], "atMs"), 0.0) <= t:
        i += 1
    set_cursor(i)

    a, b = kf[i], kf[i + 1]
    a_at = as_number(_get(a, "atMs"), 0.0)
    span = max(1.0, as_number(_get(b, "atMs"), 0.0) - a_at)
    easing = _get(a, "easing")
    if easing is None:
        easing = default_easing
    if easing is None:
        easing = "linear"
    u = apply_keyframe_easing((t - a_at) / span, easing)
    va = _norm_channels(a, names, channels)
    vb = _norm_channels(b, names, channels)
    return {name: va[name] + (vb[name] - va[name]) * u for name in names}


def sample_trajectory_pose(keyframes: Sequence[Any], t_ms: float, *, loop: bool = False) -> dict:
    """磁盘帧串 + 时刻 → **七通道姿态**（编辑器预览用，与运行时同语义）。

    先逐帧过 :func:`~tools.trajectory_workbench.model.normalize_keyframe`
    再喂采样器 —— 因为采样器是**哑**的，`sortY 缺省 = y`、`scaleX/scaleY 缺省 = scale`
    这类关系型缺省只有消费侧能填。
    """
    frames = [normalize_keyframe(f) for f in (keyframes or [])]
    return sample_keyframes(frames, t_ms, loop=loop, channels=sampler_channels())


# ===========================================================================
# 2. 路径：弧长参数化
# ===========================================================================

@dataclass(frozen=True)
class ArcLut:
    """等弧长参数化查找表。

    :param points: 折线顶点（`smooth` 时是 Catmull-Rom 细分后的顶点）。
    :param cumulative: 与 `points` 等长的累计弧长，``cumulative[0] == 0``。
    :param total: 总弧长（= ``cumulative[-1]``）。
    :param vertex_s01: **原始控制点**在 [0,1] 上的归一化弧长位置（细分前那些点）。
        抽稀前要把这些位置对应的时刻强制成关键帧，否则折线的**拐角**会被磨圆。
    """

    points: tuple[tuple[float, float], ...]
    cumulative: tuple[float, ...]
    total: float
    vertex_s01: tuple[float, ...]


def _points_to_xy(points: Any) -> list[tuple[float, float]]:
    """接受 ``[{'x':..,'y':..}]`` 或 ``[(x, y)]``；顺手去掉**连续重复**点。

    连续重复点是拖点操作的手滑产物：它们贡献零长度段（切线无定义），
    还会悄悄改掉 Catmull-Rom 的切矢形状。
    """
    out: list[tuple[float, float]] = []
    for p in points or []:
        if isinstance(p, dict):
            xy = (as_number(p.get("x"), 0.0), as_number(p.get("y"), 0.0))
        elif isinstance(p, (list, tuple)) and len(p) >= 2:
            xy = (as_number(p[0], 0.0), as_number(p[1], 0.0))
        else:
            continue
        if out and out[-1] == xy:
            continue
        out.append(xy)
    return out


def _catmull_rom(p0, p1, p2, p3, u: float) -> tuple[float, float]:
    """均匀 Catmull-Rom（tau = 0.5）在 [p1, p2] 段上取 `u ∈ [0,1]`。"""
    u2 = u * u
    u3 = u2 * u
    x = 0.5 * (
        2 * p1[0]
        + (-p0[0] + p2[0]) * u
        + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * u2
        + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * u3
    )
    y = 0.5 * (
        2 * p1[1]
        + (-p0[1] + p2[1]) * u
        + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2
        + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3
    )
    return (x, y)


def arc_length_lut(points: Any, smooth: bool = False, *, samples_per_span: int = 16) -> ArcLut:
    """控制点 → 等弧长查找表。

    - ``smooth=False``：直接用折线，顶点即控制点；
    - ``smooth=True``：均匀 Catmull-Rom 过点，**端点用重复端点**
      （首尾各复制一份当虚拟邻居），每段等参数细分 `samples_per_span` 份。

    细分份数是**定值**（不按段长自适应），这样同一批控制点永远得到同一张表——
    自适应细分会让"改了个远处的点，整条曲线的采样点全变"，抽稀结果跟着抖。

    仓库里没有现成 spline 工具，这份是自带的；单测在
    ``tools/trajectory_workbench/tests/test_bake.py``。
    """
    ctrl = _points_to_xy(points)
    if not ctrl:
        return ArcLut(points=((0.0, 0.0),), cumulative=(0.0,), total=0.0, vertex_s01=(0.0,))
    if len(ctrl) == 1:
        return ArcLut(points=(ctrl[0],), cumulative=(0.0,), total=0.0, vertex_s01=(0.0,))

    verts: list[tuple[float, float]] = []
    vertex_idx: list[int] = []
    if not smooth:
        verts = list(ctrl)
        vertex_idx = list(range(len(ctrl)))
    else:
        ext = [ctrl[0]] + list(ctrl) + [ctrl[-1]]
        steps = max(1, int(samples_per_span))
        verts.append(ctrl[0])
        vertex_idx.append(0)
        for i in range(len(ctrl) - 1):
            p0, p1, p2, p3 = ext[i], ext[i + 1], ext[i + 2], ext[i + 3]
            for j in range(1, steps + 1):
                verts.append(_catmull_rom(p0, p1, p2, p3, j / steps))
            vertex_idx.append(len(verts) - 1)

    cum: list[float] = [0.0]
    for i in range(1, len(verts)):
        cum.append(cum[-1] + math.hypot(verts[i][0] - verts[i - 1][0], verts[i][1] - verts[i - 1][1]))
    total = cum[-1]
    if total > 0:
        vs = tuple(cum[i] / total for i in vertex_idx)
    else:
        vs = tuple(0.0 for _ in vertex_idx)
    return ArcLut(points=tuple(verts), cumulative=tuple(cum), total=total, vertex_s01=vs)


def point_at_arc(lut: ArcLut, s01: float) -> tuple[float, float, float]:
    """等弧长取点：``s01 ∈ [0,1]`` → ``(x, y, 切线角度)``。

    切线角 = ``degrees(atan2(dy, dx))``，**Y 向下**，所以正角 = 屏幕上顺时针
    （与 `rotation` 通道同一套朝向，可直接喂给朝向/滚动）。
    零长度段（重复点残留）会**向前后找最近的非退化段**取切线；整条路径长度为 0 时角度取 0。

    `s01` 越界一律夹紧（不外推）——路径外面没有定义，外推只会画出鬼影。
    """
    s01 = as_number(s01, 0.0)
    s01 = 0.0 if s01 < 0 else (1.0 if s01 > 1 else s01)
    pts, cum = lut.points, lut.cumulative
    n = len(pts)
    if n == 0:
        return (0.0, 0.0, 0.0)
    if n == 1 or lut.total <= 0:
        return (pts[0][0], pts[0][1], 0.0)

    s = s01 * lut.total
    i = bisect.bisect_right(cum, s) - 1
    if i < 0:
        i = 0
    if i > n - 2:
        i = n - 2
    seg = cum[i + 1] - cum[i]
    f = (s - cum[i]) / seg if seg > 0 else 0.0
    x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f
    y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f

    j = i
    while j < n - 1 and cum[j + 1] - cum[j] <= 0:
        j += 1
    if j > n - 2 or cum[j + 1] - cum[j] <= 0:
        j = min(i, n - 2)
        while j > 0 and cum[j + 1] - cum[j] <= 0:
            j -= 1
    dx = pts[j + 1][0] - pts[j][0]
    dy = pts[j + 1][1] - pts[j][1]
    angle = math.degrees(math.atan2(dy, dx)) if (dx or dy) else 0.0
    return (x, y, angle)


def resolve_manual_path(seg: Any, start_xy: tuple[float, float] | None) -> ArcLut:
    """手绘段的**有效**路径（已按段起点平移）。

    路径是一个**形状**，`startFrom` 决定它锚在哪：平移量
    ``delta = start_xy - points[0]``。策划照着实体当前位置起笔时 ``delta == 0``，
    画布上画的就是烘出来的；段间 `previous` 链接时靠这个 delta 保证位置连续。

    ⚠ 第 8 步画布**必须调本函数**画预览，别自己拿原始 `points` 画——不然
    「画布画的」和「烘出来的」会差一个 delta，而且两边都不报错。
    """
    path = seg.get("path") if isinstance(seg, dict) else None
    path = path if isinstance(path, dict) else {}
    pts = _points_to_xy(path.get("points"))
    smooth = bool(path.get("smooth"))
    if not pts:
        base = start_xy or (0.0, 0.0)
        return arc_length_lut([base], False)
    if start_xy is not None:
        dx = start_xy[0] - pts[0][0]
        dy = start_xy[1] - pts[0][1]
        if dx or dy:
            pts = [(p[0] + dx, p[1] + dy) for p in pts]
    return arc_length_lut(pts, smooth)


def resolve_segment_start(
    seg: Any,
    *,
    index: int,
    prev_end: tuple[float, float] | None,
    anchor: tuple[float, float] | None,
) -> tuple[float, float]:
    """段起点解析（`startFrom` 的**回退梯子**）。

    `startFrom` 缺省：第 0 段 ``'anchor'``，其余 ``'previous'``（types.ts 说"缺省由编辑器定"，
    这就是编辑器定的那一版）。``'entity'`` 是搬成独立资产之前的旧写法，按 ``'anchor'`` 处理。
    各档的候选顺序:

    ==========  =================================================================
    startFrom   依次尝试
    ==========  =================================================================
    anchor      anchor → 上一段末点 → seg.start → path[0] → (0, 0)
    previous    上一段末点 → anchor → seg.start → path[0] → (0, 0)
    explicit    seg.start → 上一段末点 → anchor → path[0] → (0, 0)
    ==========  =================================================================

    梯子末端放 ``path[0]`` 是关键：一条什么锚点都没给的孤立手绘段会**原样烘成画的样子**，
    而不是被拽到世界原点（那才是"编辑器骗人"）。
    """
    s = seg if isinstance(seg, dict) else {}
    mode = str(s.get("startFrom") or "").strip()
    if mode == "entity":
        mode = "anchor"
    if mode not in ("anchor", "previous", "explicit"):
        mode = "anchor" if index == 0 else "previous"
    entity_pos = anchor

    explicit: tuple[float, float] | None = None
    raw = s.get("start")
    if isinstance(raw, dict):
        explicit = (as_number(raw.get("x"), 0.0), as_number(raw.get("y"), 0.0))

    path_head: tuple[float, float] | None = None
    path = s.get("path")
    if isinstance(path, dict):
        pts = _points_to_xy(path.get("points"))
        if pts:
            path_head = pts[0]

    if mode == "anchor":
        order = (entity_pos, prev_end, explicit, path_head)
    elif mode == "previous":
        order = (prev_end, entity_pos, explicit, path_head)
    else:
        order = (explicit, prev_end, entity_pos, path_head)
    for cand in order:
        if cand is not None:
            return (float(cand[0]), float(cand[1]))
    return (0.0, 0.0)


# ===========================================================================
# 3. 时间曲线 / 通道轨
# ===========================================================================

def _clean_keys(keys: Any, value_key: str, default: float, *, clamp01: bool, monotonic: bool) -> list[dict]:
    """把作者面的 key 列表清成**可采样**的形状：atMs 非降、值合法（可选夹紧/单调）。

    非法输入一律**夹紧**而不是抛异常——编辑期的中间态天天非法（正在拖点），
    烘焙不该因此炸掉。要给用户看的抱怨走 :func:`timing_warnings`。
    """
    rows: list[dict] = []
    last_at = 0.0
    last_val = -math.inf
    for k in keys or []:
        if not isinstance(k, dict) or k.get("atMs") is None:
            continue
        at = as_number(k.get("atMs"), 0.0)
        if at < 0:
            at = 0.0
        if at < last_at:
            at = last_at
        last_at = at
        val = as_number(k.get(value_key), default)
        if clamp01:
            val = 0.0 if val < 0 else (1.0 if val > 1 else val)
        if monotonic and val < last_val:
            val = last_val
        last_val = val
        row: dict = {"atMs": at, value_key: val}
        easing = k.get("easing")
        if isinstance(easing, str) and easing in KEYFRAME_EASINGS:
            row["easing"] = easing
        rows.append(row)
    return rows


def eval_timing(keys: Any, t_ms: float, duration_ms: float) -> float:
    """时间 → 路径进度（0..1）。段内用共享缓动，边界用共享采样器语义。

    - `keys` 为空 → 匀速 ``t / duration``（夹在 [0,1]）；
    - `keys` 非空 → 先清洗（atMs 非降、progress 夹进 [0,1] 且**单调不减**），
      再走 :func:`sample_keyframes`。所以 ``t`` 小于首 key 的 atMs 时**吃首 key 的
      progress**（不是 0）——这是采样器的钳位语义，与运行时回放一致，别在这儿"修"。
    - `duration_ms <= 0` → 恒 0（退化成单点）。

    **非法输入一律夹紧，不抛异常**；要展示给用户的问题清单调 :func:`timing_warnings`。
    """
    duration = as_number(duration_ms, 0.0)
    rows = _clean_keys(keys, "progress", 0.0, clamp01=True, monotonic=True)
    if not rows:
        if duration <= 0:
            return 0.0
        p = as_number(t_ms, 0.0) / duration
        return 0.0 if p < 0 else (1.0 if p > 1 else p)
    v = sample_keyframes(rows, as_number(t_ms, 0.0), channels={"progress": 0.0})["progress"]
    return 0.0 if v < 0 else (1.0 if v > 1 else v)


def timing_warnings(keys: Any, duration_ms: float) -> list[str]:
    """把 :func:`eval_timing` **默默夹掉**的那些问题列出来，供面板显示。

    烘焙本身从不因为这些停下（编辑期天天有中间态），但策划有权知道
    "我画的 progress 1.4 被当成 1.0 了"。
    """
    out: list[str] = []
    duration = as_number(duration_ms, 0.0)
    if duration <= 0:
        out.append("durationMs 必须 > 0，否则整段退化成一个点")
    rows = [k for k in (keys or []) if isinstance(k, dict) and k.get("atMs") is not None]
    if not rows:
        return out
    last_at = -math.inf
    last_prog = -math.inf
    for idx, k in enumerate(rows):
        at = as_number(k.get("atMs"), 0.0)
        prog = as_number(k.get("progress"), 0.0)
        if at < 0:
            out.append(f"第 {idx + 1} 个时间点 atMs={at} < 0，已夹到 0")
        if at < last_at:
            out.append(f"第 {idx + 1} 个时间点 atMs={at} 比前一个小，已按非降顺序夹平")
        if duration > 0 and at > duration:
            out.append(f"第 {idx + 1} 个时间点 atMs={at} 超出 durationMs={duration}，永远采不到")
        if prog < 0 or prog > 1:
            out.append(f"第 {idx + 1} 个时间点 progress={prog} 越界，已夹进 [0,1]")
        if prog < last_prog:
            out.append(f"第 {idx + 1} 个时间点 progress={prog} 比前一个小（倒放），已夹成单调不减")
        last_at = max(last_at, at)
        last_prog = max(last_prog, prog)
    first_at = as_number(rows[0].get("atMs"), 0.0)
    if first_at > 0:
        out.append(f"首个时间点在 {first_at}ms，0..{first_at}ms 段保持首点的 progress（采样器钳位语义）")
    return out


def eval_track(keys: Any, t_ms: float, default: float) -> float:
    """独立通道轨（rotation / scale / alpha / sortY …）在某时刻的值。

    与 :func:`eval_timing` 同一套缓动与边界语义，只是不夹 [0,1]、不强制单调。
    `keys` 为空 → 返回 `default`（= 上一段传下来的姿态，保证段间连续）。
    """
    d = as_number(default, 0.0)
    rows = _clean_keys(keys, "value", d, clamp01=False, monotonic=False)
    if not rows:
        return d
    return sample_keyframes(rows, as_number(t_ms, 0.0), channels={"value": d})["value"]


def _solve_progress_time(keys: Any, duration_ms: float, target: float, iters: int = 48) -> float | None:
    """二分求 ``eval_timing(t) == target`` 的时刻（progress 已保证单调不减）。

    找不到（progress 根本没跨过 target，比如中间有跳变）返回 None。
    定迭代次数 = 定结果，不按容差提前退出，免得输入的细微差别改掉迭代轮数。
    """
    duration = as_number(duration_ms, 0.0)
    if duration <= 0:
        return None
    lo, hi = 0.0, duration
    if eval_timing(keys, lo, duration) >= target or eval_timing(keys, hi, duration) < target:
        return None
    for _ in range(iters):
        mid = (lo + hi) * 0.5
        if eval_timing(keys, mid, duration) < target:
            lo = mid
        else:
            hi = mid
    if abs(eval_timing(keys, hi, duration) - target) > 1e-6:
        return None
    return hi


# ===========================================================================
# 4. 物理段
# ===========================================================================

@dataclass(frozen=True)
class PhysicsNode:
    """一个积分节点（定步长 1/120 s，外加精确触地子步）。"""

    t_sec: float
    x: float
    y: float
    vx: float
    vy: float
    rotation: float
    omega: float
    grounded: bool
    #: 触地瞬间 / 静止瞬间 / 起点 —— 抽稀不许动。
    hard: bool


@dataclass(frozen=True)
class PhysicsRun:
    """:func:`simulate_physics_nodes` 的产物：节点串 + 复算不变量要用的常量。"""

    nodes: tuple[PhysicsNode, ...]
    ground_y: float
    gravity: float

    def energy(self, node: PhysicsNode) -> float:
        """平动比能 ``½v² + g·h``（``h = groundY - y``，Y 向下所以 h 是"离地高度"）。

        辛欧拉 + 精确 TOI 保证这个量**单调不增**（自由落体每步掉 ``½g²h²``，
        碰撞掉 ``(1-e²)`` 那份，滚动掉摩擦那份）。自转动能不计——落地时纯滚动约束
        会把 ω 一把拽到 ``vx/r``，那是塑性约束，不在这个守恒账里。
        """
        return 0.5 * (node.vx * node.vx + node.vy * node.vy) + self.gravity * (self.ground_y - node.y)


def _pose_of(start_pose: Any) -> dict:
    p = start_pose if isinstance(start_pose, dict) else {}
    y = as_number(p.get("y"), 0.0)
    return {
        "x": as_number(p.get("x"), 0.0),
        "y": y,
        "rotation": as_number(p.get("rotation"), 0.0),
        "scaleX": as_number(p.get("scaleX"), 1.0),
        "scaleY": as_number(p.get("scaleY"), 1.0),
        "alpha": as_number(p.get("alpha"), 1.0),
        "sortY": as_number(p.get("sortY"), y),
    }


def _time_of_impact(g: float, vy: float, d: float, h: float) -> float:
    """解 ``g·s² + vy·s = d``（辛欧拉子步下 ``y(s) = y + (vy + g·s)·s`` 的精确落地时刻）。

    取落在 ``(0, h]`` 内的最小正根；解不出来（数值边角）就退回 `h`。
    """
    if d <= 0:
        return 0.0
    if abs(g) <= _EPS:
        if vy <= 0:
            return h
        return min(h, d / vy)
    disc = vy * vy + 4.0 * g * d
    if disc < 0:
        return h
    root = math.sqrt(disc)
    best: float | None = None
    for c in ((-vy + root) / (2.0 * g), (-vy - root) / (2.0 * g)):
        if c > 0 and c <= h + _EPS and (best is None or c < best):
            best = c
    return h if best is None else min(best, h)


def simulate_physics_nodes(seg: Any, start_pose: Any) -> PhysicsRun:
    """抛体段的**定步长积分**（1/120 s），到停机为止。不做重采样。

    积分方案（**辛欧拉**：先更新速度再更新位置）::

        腾空:  vy += g·h;  y += vy·h;  x += vx·h;  rot += ω·h
        贴地:  |vx| -= rollingFriction·h（不过零）; ω = deg(vx/r); x += vx·h; rot += ω·h

    这个次序**能量严格不增**（自由落体一步掉 ``½g²h²``），是"总能量单调不增"
    那条不变量的来源。反过来写（先动位置再动速度）就会**注入**能量。

    **触地用精确 TOI**（解 ``g·s² + vy·s - d = 0``）切成子步，落点恰好 ``y == groundY``：
    不这么做就只能"穿一点再拉回来"，那一拉是在给系统白送势能，restitution=1 时球会
    越弹越高——而且没有任何东西会报错。

    碰撞响应::

        |vy_撞| > 阈值 且 |vy_弹| > 阈值 → vy = -vy_撞 · restitution; vx *= (1 - tangentialDamping)
        否则                            → 贴地（y = groundY, vy = 0），转滚动

    阈值 ``max(stop.minSpeed, |g|·2/120, 1e-9)``：低于两个积分步的重力增量时，
    "弹跳"已经是亚步噪声。**同时查弹起速度**是刻意的偏离（types.ts 只说查撞击速度）——
    不查的话 ``restitution=0`` 会得到「vy=0 但仍标记为腾空」，下一步又被重力拉成
    零深度触地，原地死循环。查了才能满足"restitution=0 首次触地即贴地"。

    滚动的自转：``ω = deg(vx / spin.radius)``（纯滚动约束，rad/s → 度/s）。
    ``spin.omega0`` 按 types.ts 就是**度/s**，腾空期间原样保持。没有 `spin` 时 ω 恒 0。

    停机：贴地且 ``hypot(vx, vy) < stop.minSpeed``，或 ``t >= stop.maxMs``
    （`maxMs` 未写/非正时按 5000ms 兜底，免得无限积分）。
    """
    s = seg if isinstance(seg, dict) else {}
    pose = _pose_of(start_pose)
    v0 = s.get("v0") if isinstance(s.get("v0"), dict) else {}
    stop = s.get("stop") if isinstance(s.get("stop"), dict) else {}
    spin = s.get("spin") if isinstance(s.get("spin"), dict) else None

    g = as_number(s.get("gravity"), 0.0)
    ground_y = as_number(s.get("groundY"), pose["y"])
    restitution = max(0.0, as_number(s.get("restitution"), 0.0))
    damping = as_number(s.get("tangentialDamping"), 0.0)
    damping = 0.0 if damping < 0 else (1.0 if damping > 1 else damping)
    friction = max(0.0, as_number(s.get("rollingFriction"), 0.0))
    min_speed = max(0.0, as_number(stop.get("minSpeed"), 0.0))
    max_ms = as_number(stop.get("maxMs"), 0.0)
    if not (max_ms > 0):
        max_ms = 5000.0
    max_sec = max_ms / 1000.0

    radius = as_number(spin.get("radius"), 0.0) if spin is not None else 0.0
    has_spin = spin is not None and abs(radius) > _EPS

    x = pose["x"]
    # 起点若已在地下（作者面手滑），先提到地面，否则"永不穿透"从第 0 帧就破了。
    y = min(pose["y"], ground_y)
    vx = as_number(v0.get("x"), 0.0)
    vy = as_number(v0.get("y"), 0.0)
    rot = pose["rotation"]
    omega = as_number(spin.get("omega0"), 0.0) if spin is not None else 0.0
    grounded = (ground_y - y) <= _EPS and vy >= 0
    if grounded:
        y = ground_y
        vy = 0.0
        if has_spin:
            omega = math.degrees(vx / radius)

    bounce_min = max(min_speed, abs(g) * PHYSICS_STEP_SEC * 2.0, 1e-9)

    nodes: list[PhysicsNode] = [PhysicsNode(0.0, x, y, vx, vy, rot, omega, grounded, True)]
    t = 0.0
    # 每个定步长最多切出几个碰撞子步，所以节点上限要比 步数 宽出一截。
    max_nodes = int(max_sec * PHYSICS_STEP_HZ) * 4 + 256

    while True:
        if t >= max_sec - _EPS:
            break
        if grounded and math.hypot(vx, vy) < min_speed:
            break
        if len(nodes) >= max_nodes:
            break
        remaining = min(PHYSICS_STEP_SEC, max_sec - t)
        guard = 0
        while remaining > 1e-12 and guard < 16:
            guard += 1
            if grounded:
                speed = max(0.0, abs(vx) - friction * remaining)
                vx = math.copysign(speed, vx) if speed > 0 else 0.0
                if has_spin:
                    omega = math.degrees(vx / radius)
                x += vx * remaining
                rot += omega * remaining
                t += remaining
                remaining = 0.0
                nodes.append(PhysicsNode(t, x, y, vx, vy, rot, omega, True, False))
                continue

            vy_end = vy + g * remaining
            y_end = y + vy_end * remaining
            if y_end >= ground_y and vy_end > 0:
                d = max(0.0, ground_y - y)
                s_hit = _time_of_impact(g, vy, d, remaining)
                vy_hit = vy + g * s_hit
                x += vx * s_hit
                rot += omega * s_hit
                y = ground_y  # 精确落点，不留浮点残差
                t += s_hit
                remaining -= s_hit
                vy_rebound = -vy_hit * restitution
                if abs(vy_hit) <= bounce_min or abs(vy_rebound) <= bounce_min:
                    vy = 0.0
                    grounded = True
                    if has_spin:
                        omega = math.degrees(vx / radius)
                else:
                    vy = vy_rebound
                    vx *= 1.0 - damping
                nodes.append(PhysicsNode(t, x, y, vx, vy, rot, omega, grounded, True))
            else:
                vy = vy_end
                y = y_end
                x += vx * remaining
                rot += omega * remaining
                t += remaining
                remaining = 0.0
                nodes.append(PhysicsNode(t, x, y, vx, vy, rot, omega, False, False))

    last = nodes[-1]
    # 静止/超时那一刻必须是关键帧。
    nodes[-1] = PhysicsNode(last.t_sec, last.x, last.y, last.vx, last.vy, last.rotation,
                            last.omega, last.grounded, True)
    return PhysicsRun(nodes=tuple(nodes), ground_y=ground_y, gravity=g)


def simulate_physics(seg: Any, start_pose: Any, *, hz: int = DEFAULT_SAMPLE_HZ,
                     contact_offset_y: float = 0.0) -> list[dict]:
    """抛体段：:func:`simulate_physics_nodes` 积分 + 按 `hz` 重采样成姿态列表。

    :param seg: ``PhysicsSegmentSource``。
    :param start_pose: 七通道起始姿态（位置从这儿取；scale/alpha 全程原样带着走）。
    :param hz: **输出**采样率（段自带 ``sampleHz`` 由调用方解析后传进来）。
    :returns: ``{atMs, x, y, rotation, scaleX, scaleY, alpha, sortY, hard}`` 列表，
        `atMs` 相对**段起点**，升序，首项 0、末项 = 段时长。

    ``sortY`` **全程 = groundY**：腾空时深度按**落点**算。加这个通道就是为了这个——
    抛起来的铜钱不该在最高点被判到画面深处去。

    重采样只在**相邻积分节点之间**线性插值。触地节点本身在时间轴上，任何插值区间
    都不会跨过它 —— 这是"重采样不会把弹跳的角切掉"的依据。
    """
    run = simulate_physics_nodes(seg, start_pose)
    pose = _pose_of(start_pose)
    hz = resolve_sample_hz(hz)
    nodes = run.nodes
    duration = nodes[-1].t_sec

    times: list[float] = []
    if duration <= 0:
        times = [0.0]
    else:
        step = 1.0 / hz
        k = 0
        while True:
            tv = k * step
            if tv >= duration:
                break
            times.append(tv)
            k += 1
        times.append(duration)
    hard_times = {round(n.t_sec, 12) for n in nodes if n.hard}
    times = sorted({round(tv, 12) for tv in times} | hard_times)

    node_ts = [n.t_sec for n in nodes]
    out: list[dict] = []
    for tv in times:
        i = bisect.bisect_right(node_ts, tv) - 1
        if i < 0:
            i = 0
        if i > len(nodes) - 2:
            i = max(0, len(nodes) - 2)
        a = nodes[i]
        b = nodes[min(i + 1, len(nodes) - 1)]
        span = b.t_sec - a.t_sec
        f = (tv - a.t_sec) / span if span > 0 else 0.0
        f = 0.0 if f < 0 else (1.0 if f > 1 else f)
        out.append({
            "atMs": tv * 1000.0,
            "x": a.x + (b.x - a.x) * f,
            "y": a.y + (b.y - a.y) * f,
            "rotation": a.rotation + (b.rotation - a.rotation) * f,
            "scaleX": pose["scaleX"],
            "scaleY": pose["scaleY"],
            "alpha": pose["alpha"],
            "sortY": run.ground_y + contact_offset_y,
            "hard": round(tv, 12) in hard_times,
        })
    return out


# ===========================================================================
# 5. 抽稀
# ===========================================================================

def resolve_sample_hz(value: Any, default: int = DEFAULT_SAMPLE_HZ) -> int:
    """采样率解析：非法取缺省，再夹进 ``[SAMPLE_HZ_MIN, SAMPLE_HZ_MAX]``。"""
    hz = as_number(value, float(default))
    if not math.isfinite(hz) or hz <= 0:
        hz = float(default)
    hz_i = int(round(hz))
    if hz_i < SAMPLE_HZ_MIN:
        return SAMPLE_HZ_MIN
    if hz_i > SAMPLE_HZ_MAX:
        return SAMPLE_HZ_MAX
    return hz_i


def resolve_tolerance(bake_cfg: Any) -> dict[str, float]:
    """抽稀容差解析：``source.bake.tolerance`` 覆盖 :data:`DEFAULT_TOLERANCE`。

    非正数/非数一律回落缺省（容差 0 会让抽稀彻底失效，密帧全量落盘）。
    """
    out = dict(DEFAULT_TOLERANCE)
    cfg = bake_cfg if isinstance(bake_cfg, dict) else {}
    tol = cfg.get("tolerance")
    if isinstance(tol, dict):
        for key in ("pos", "rot", "scale", "alpha"):
            v = as_number(tol.get(key), -1.0)
            if v > 0:
                out[key] = v
    return out


def _rdp_seed(times: Sequence[float], values: Sequence[float], tol: float, keep: list[bool]) -> None:
    """1-D RDP（**竖直偏差**，不是垂距）。命中的分裂点写进 `keep`。

    显式栈，不用递归：14000 个采样点（240Hz × 60s）足以打爆默认递归深度。
    并列最大偏差取**下标最小**那个 → 结果与遍历顺序无关，确定性有保障。
    """
    n = len(times)
    if n < 3:
        return
    stack: list[tuple[int, int]] = [(0, n - 1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0 + 1:
            continue
        t0, v0 = times[i0], values[i0]
        dt = times[i1] - t0
        dv = values[i1] - v0
        best = -1
        best_d = -1.0
        for k in range(i0 + 1, i1):
            interp = v0 + dv * ((times[k] - t0) / dt) if dt > 0 else v0
            d = abs(values[k] - interp)
            if d > best_d:
                best_d = d
                best = k
        if best_d > tol and best > i0:
            keep[best] = True
            stack.append((i0, best))
            stack.append((best, i1))


def decimate_samples(samples: Sequence[dict], tolerance: dict[str, float] | None = None,
                     *, channels: Sequence[str] | None = None,
                     tolerance_key: dict[str, str] | None = None) -> list[dict]:
    """分通道抽稀：**保证**任一原始采样点上各通道的重建偏差 ≤ 该通道容差。

    两段式：

    1. 逐通道跑一遍 RDP 播种（各通道各自的容差档，见 :data:`CHANNEL_TOLERANCE_KEY`）；
    2. **强制收敛闸门**：拿并集后的保留点重新逐区间验一遍，还有超差的就把该区间里
       "超得最狠"的点补进去，直到全部达标。

    第 2 步不是保险起见——各通道并集之后的重建曲线**不等于**任一通道自己 RDP 的结果，
    单靠第 1 步的上界不覆盖并集情形。有了闸门，"抽稀误差 ≤ 容差"才是**构造性**成立的，
    测试断的也是这一条。

    `hard=True` 的采样点（触地、静止、作者打的 key、折线拐角）恒保留。

    ``channels`` / ``tolerance_key`` 缺省 = 七通道姿态（2D）；3D 烘焙传 ``x,y,z,h,...``
    进来复用同一台机器——抽稀是通道无关的数学，不该按空间各写一份。
    """
    n = len(samples)
    if n == 0:
        return []
    chans: tuple[str, ...] = tuple(channels) if channels else POSE_CHANNELS
    tol_key: dict[str, str] = dict(tolerance_key) if tolerance_key else CHANNEL_TOLERANCE_KEY
    tol = dict(DEFAULT_TOLERANCE)
    if isinstance(tolerance, dict):
        for k, v in tolerance.items():
            if k in tol:
                tol[k] = float(v)

    times = [as_number(s.get("atMs"), 0.0) for s in samples]
    values = {ch: [as_number(s.get(ch), 0.0) for s in samples] for ch in chans}
    channel_tol = {ch: max(1e-12, tol[tol_key[ch]]) for ch in chans}

    keep = [False] * n
    keep[0] = True
    keep[n - 1] = True
    for i, s in enumerate(samples):
        if s.get("hard"):
            keep[i] = True
    for ch in chans:
        _rdp_seed(times, values[ch], channel_tol[ch], keep)

    for _ in range(n + 1):
        kept = [i for i, k in enumerate(keep) if k]
        added = False
        for a, b in zip(kept, kept[1:]):
            if b <= a + 1:
                continue
            worst_idx = -1
            worst_ratio = 1.0
            dt = times[b] - times[a]
            for ch in chans:
                vs = values[ch]
                v0 = vs[a]
                dv = vs[b] - v0
                ctol = channel_tol[ch]
                for k in range(a + 1, b):
                    interp = v0 + dv * ((times[k] - times[a]) / dt) if dt > 0 else v0
                    ratio = abs(vs[k] - interp) / ctol
                    if ratio > worst_ratio:
                        worst_ratio = ratio
                        worst_idx = k
            if worst_idx >= 0:
                keep[worst_idx] = True
                added = True
        if not added:
            break

    return [samples[i] for i, k in enumerate(keep) if k]


# ===========================================================================
# 6. 烘焙
# ===========================================================================

@dataclass
class BakeResult:
    """:func:`bake_samples` 的产物（第 8/9 步的画布/时间轴直接吃这个）。"""

    #: 全轨迹密采样，`atMs` 是**全局**毫秒（升序），每项含七通道 + ``hard``。
    samples: list[dict] = field(default_factory=list)
    #: 总时长（毫秒，浮点）。
    total_ms: float = 0.0
    #: 每段的 ``{id, kind, startMs, endMs, start:(x,y), end:(x,y)}``，供画布画段边界。
    segments: list[dict] = field(default_factory=list)
    #: 作者面问题（夹紧过的、采不到的、缺段的），只展示不阻断。
    warnings: list[str] = field(default_factory=list)
    #: 实际生效的采样率与容差（面板显示"这次按什么烘的"）。
    sample_hz: int = DEFAULT_SAMPLE_HZ
    tolerance: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_TOLERANCE))


def _xy(pos: Any) -> tuple[float, float] | None:
    if isinstance(pos, dict):
        return (as_number(pos.get("x"), 0.0), as_number(pos.get("y"), 0.0))
    if isinstance(pos, (list, tuple)) and len(pos) >= 2:
        return (as_number(pos[0], 0.0), as_number(pos[1], 0.0))
    return None


def _uniform_times(duration: float, hz: int) -> list[float]:
    """0 → duration 的均匀毫秒网格，末点恒是 duration。"""
    if duration <= 0:
        return [0.0]
    step = 1000.0 / hz
    out: list[float] = []
    k = 0
    while True:
        tv = k * step
        if tv >= duration:
            break
        out.append(tv)
        k += 1
    out.append(duration)
    return out


def _manual_samples(
    seg: dict,
    start_xy: tuple[float, float],
    base: dict,
    *,
    hz: int,
    warnings: list[str],
    contact_offset_y: float = 0.0,
) -> list[dict]:
    """手绘段 → 采样列表（`atMs` 相对段起点）。

    通道解析次序（**每一条都为了段间连续**）：

    - `rotation`：给了 `roll` 就走纯滚动 ``base + direction · deg(路程/半径)``
      （types.ts 明说"按**路程**/半径"，所以路径折返回来时还是同向转，
      要反向请用 `direction`）；否则走 ``tracks.rotation``，缺省 = 上一段末旋转。
    - `scaleX/scaleY`：逐轴优先 ``tracks.scaleX/scaleY``，其次 ``tracks.scale``
      （驱动两轴），再其次沿用上一段末值。
    - `sortY`：**没有轨时缺省 = 该帧的接地线**（``y + contact_offset_y``，关系型缺省），
      不是沿用上一段的 sortY。缺省锚点的实体偏移恒 0 ⇒ 就是该帧的 y，与锚点可配之前逐位相同;
      锚点挪到圆心的物件(铜钱)偏移 = 半径，于是深度锚落在**真实接地线**而不是圆心高度。
    """
    timing = seg.get("timing") if isinstance(seg.get("timing"), dict) else {}
    duration = max(0.0, as_number(timing.get("durationMs"), 0.0))
    keys = timing.get("keys")
    lut = resolve_manual_path(seg, start_xy)
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
    for ch in ("rotation", "scale", "scaleX", "scaleY", "alpha", "sortY"):
        for k in tracks.get(ch) or []:
            if isinstance(k, dict) and k.get("atMs") is not None:
                hard.add(round(min(max(0.0, as_number(k.get("atMs"), 0.0)), duration), 9))
    path_cfg = seg.get("path") if isinstance(seg.get("path"), dict) else {}
    if not bool(path_cfg.get("smooth")):
        # 折线拐角：采样点没正好落在拐角上时，抽稀也救不回来（信息在采样阶段就丢了），
        # 所以把拐角反解成时刻直接钉成 hard。平滑曲线没有拐角，不做。
        for s01 in lut.vertex_s01[1:-1]:
            tv = _solve_progress_time(keys, duration, s01)
            if tv is not None:
                hard.add(round(min(max(0.0, tv), duration), 9))

    times = sorted({round(v, 9) for v in _uniform_times(duration, hz)} | hard)
    has_scale_track = tracks.get("scale") is not None
    has_sx_track = tracks.get("scaleX") is not None
    has_sy_track = tracks.get("scaleY") is not None
    has_sorty_track = tracks.get("sortY") is not None

    out: list[dict] = []
    for tv in times:
        prog = eval_timing(keys, tv, duration)
        px, py, _tangent = point_at_arc(lut, prog)
        if use_roll:
            rotation = base["rotation"] + roll_dir * math.degrees(prog * lut.total / roll_radius)
        else:
            rotation = eval_track(tracks.get("rotation"), tv, base["rotation"])
        if has_sx_track:
            sx = eval_track(tracks.get("scaleX"), tv, base["scaleX"])
        elif has_scale_track:
            sx = eval_track(tracks.get("scale"), tv, base["scaleX"])
        else:
            sx = base["scaleX"]
        if has_sy_track:
            sy = eval_track(tracks.get("scaleY"), tv, base["scaleY"])
        elif has_scale_track:
            sy = eval_track(tracks.get("scale"), tv, base["scaleY"])
        else:
            sy = base["scaleY"]
        out.append({
            "atMs": tv,
            "x": px,
            "y": py,
            "rotation": rotation,
            "scaleX": sx,
            "scaleY": sy,
            "alpha": eval_track(tracks.get("alpha"), tv, base["alpha"]),
            "sortY": (eval_track(tracks.get("sortY"), tv, py + contact_offset_y)
                      if has_sorty_track else py + contact_offset_y),
            "hard": tv in hard,
        })
    return out


def _pose_equal(a: dict, b: dict) -> bool:
    return all(abs(as_number(a.get(ch), 0.0) - as_number(b.get(ch), 0.0)) <= 1e-9 for ch in POSE_CHANNELS)


def bake_samples(traj: Any, *, anchor: Any = None,
                 contact_offset_y: float = 0.0) -> BakeResult:
    """把 ``TrajectoryDef.source`` 解算成**密采样**（还没抽稀、还没落形）。

    第 8/9 步的画布/时间轴要的是这份连续曲线；:func:`bake_trajectory` 在它之上
    再做抽稀 + 落形。分开两层，画布画的和落盘的**保证同源**。

    分段链接：第 i 段起于第 i-1 段末**姿态**（位置 + 旋转 + 缩放 + alpha 全都接着走），
    第 0 段按 `startFrom`（见 :func:`resolve_segment_start`；`anchor` 档取播放锚点）。段边界那两个同时刻采样点
    完全重合时并成一个；两侧值真的不同（作者在 atMs=0 打了个跳变 key）时**两帧都留**，
    如实反映那个跳变而不是偷偷抹平（采样器 ``span`` 下限 1ms，回放成一次瞬时切换）。
    """
    d = traj if isinstance(traj, dict) else {}
    src = d.get("source") if isinstance(d.get("source"), dict) else {}
    bake_cfg = src.get("bake") if isinstance(src.get("bake"), dict) else {}
    hz = resolve_sample_hz(bake_cfg.get("sampleHz"))
    result = BakeResult(sample_hz=hz, tolerance=resolve_tolerance(bake_cfg))

    segments = src.get("segments")
    if not isinstance(segments, list) or not segments:
        result.warnings.append("source.segments 为空：没有可烘的段（调用方应保留原 keyframes，不要清空）")
        return result

    anchor_xy = _xy(anchor)
    base = {"x": 0.0, "y": 0.0, "rotation": 0.0, "scaleX": 1.0, "scaleY": 1.0, "alpha": 1.0, "sortY": 0.0}
    prev_end: tuple[float, float] | None = None
    offset = 0.0
    all_samples: list[dict] = []

    for index, seg in enumerate(segments):
        if not isinstance(seg, dict):
            result.warnings.append(f"第 {index + 1} 段不是对象，已跳过")
            continue
        kind = str(seg.get("kind") or "").strip()
        start_xy = resolve_segment_start(seg, index=index, prev_end=prev_end, anchor=anchor_xy)
        base = dict(base)
        base["x"], base["y"] = start_xy
        if kind == "physics":
            samples = simulate_physics(
                seg, base, hz=resolve_sample_hz(seg.get("sampleHz"), hz),
                contact_offset_y=contact_offset_y)
        elif kind == "manual":
            samples = _manual_samples(seg, start_xy, base, hz=hz, warnings=result.warnings,
                                      contact_offset_y=contact_offset_y)
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
            if all_samples and abs(sm["atMs"] - all_samples[-1]["atMs"]) <= 1e-9 and _pose_equal(sm, all_samples[-1]):
                if sm.get("hard"):
                    all_samples[-1]["hard"] = True
                continue
            all_samples.append(sm)

        last = all_samples[-1]
        prev_end = (last["x"], last["y"])
        base = {ch: last[ch] for ch in POSE_CHANNELS}
        offset = seg_end
        result.segments.append({
            "id": str(seg.get("id") or ""),
            "kind": kind,
            "startMs": seg_start,
            "endMs": seg_end,
            "start": start_xy,
            "end": prev_end,
        })

    result.samples = all_samples
    result.total_ms = all_samples[-1]["atMs"] if all_samples else 0.0
    return result


def bake_trajectory(traj: Any, *, anchor: Any = None,
                    contact_offset_y: float = 0.0) -> list[dict]:
    """``source`` → **写盘形**的密关键帧列表（烘焙场景的**绝对**坐标；相对化在 :mod:`.assets`）。

    :param traj: 轨迹定义（读 ``source.segments`` 与 ``source.bake``）。
    :param anchor: ``{'x':..,'y':..}`` 或 ``(x, y)`` —— ``startFrom:'anchor'`` 用的
        播放锚点（烘焙时实体位置）。给 None 时那一档按 :func:`resolve_segment_start` 的梯子往下退。
    :returns: ``TrajectoryKeyframe`` 列表（已过
        :func:`~tools.trajectory_workbench.model.write_keyframe`：省缺省键、固定键序、
        **恒无 `easing`**）。首帧 ``atMs == 0``，末帧 ``atMs == 总时长``。
        ``source.segments`` 为空时返回 ``[]`` —— **调用方应当保留原有 keyframes，
        而不是拿这个空表把手打的帧清掉**。

    确定性：同一输入两次调用 ``json.dumps`` 逐字节相同（无 set 迭代序、无随机、无时钟）。
    """
    result = bake_samples(traj, anchor=anchor,
                          contact_offset_y=contact_offset_y)
    if not result.samples:
        return []
    kept = decimate_samples(result.samples, result.tolerance)

    out: list[dict] = []
    for sm in kept:
        frame = write_keyframe(sm)
        if out and frame == out[-1]:
            # 取整撞进同一毫秒且逐键相同 —— 留一个就够。
            # 值不同则两帧都留：那是作者面真实的瞬时跳变，抹掉就是替策划改设计。
            continue
        out.append(frame)
    out[0]["atMs"] = 0
    if len(out) > 1:
        out[-1]["atMs"] = int(round(result.total_ms))
    return out
