# -*- coding: utf-8 -*-
"""光柱（体积光，``VfxEffectDef.beams``）的形状与引用判据——Python 镜像。

权威在运行时 ``src/systems/vfx/vfxBeam.ts`` 的 ``beamDefErrors`` / ``emitterBeamRefErrors`` / ``effectBeamErrors``；
这里**逐条同序、同一句话**（``tools/vfx_workbench/tests/test_beam.py`` 用 node 真跑那边的函数逐文档比对错误列表）。
枚举 / 缺省 / 上下限不在这里抄：读同一份 ``src/data/vfxBeamContract.json``。

消费方：粒子工作台保存闸门（``assets.normalize_effect``）、构建期校验器（``validator._validate_vfx_effects``）。
本模块不改文档、不写文件。
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Callable

CONTRACT = json.loads((Path(__file__).resolve().parents[3] / "src/data/vfxBeamContract.json").read_text(encoding="utf-8"))
LIMITS = CONTRACT["limits"]
MIN_SIDES, MAX_SIDES = CONTRACT["polygonSides"]
MAX_CURVE_KEYS = CONTRACT["maxCurveKeys"]
MIN_LENGTH = 1

#: 光柱键序（与 types.ts 的 VfxBeamDef 逐字同序）
BEAM_ORDER = ("id", "mode", "shape3d", "shape2d", "color", "colorEnd", "intensity", "alongCurve", "edgeSoftness",
              "thickness", "contactSoftWu", "blend", "noise", "cookie", "pulse", "fadeIn", "fadeOut", "sort")
SHAPE3D_ORDER = ("from", "to", "section", "spreadDeg", "rollDeg")
SHAPE2D_ORDER = ("from", "to", "width", "occludeByDepth")
NOISE_ORDER = ("strength", "scaleWu", "velocity")
COOKIE_ORDER = ("image", "strength", "scale", "offset", "rotationDeg")
PULSE_ORDER = ("kind", "hz", "amount")


def _is_obj(v: Any) -> bool:
    return isinstance(v, dict)


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _in_range(v: Any, r: list) -> bool:
    return _is_num(v) and r[0] <= v <= r[1]


def _is_vec(v: Any, n: int) -> bool:
    return isinstance(v, list) and len(v) == n and all(_is_num(x) for x in v)


def _is_int(v: Any) -> bool:
    return _is_num(v) and float(v).is_integer()


def _in(v: Any, options: list) -> bool:
    return isinstance(v, str) and v in options


def _color_errors(v: Any, key: str, out: list[str]) -> None:
    if not _is_vec(v, 3) or not all(0 <= c <= 1 for c in v):
        out.append(f"{key} 必须为三个 0..1 的数")


def beam_def_errors(d: Any) -> list[str]:
    """一根光柱的形状问题（空 = 合法）。与 ``vfxBeam.ts beamDefErrors`` 逐条同序同句。"""
    out: list[str] = []
    if not _is_obj(d):
        return ["光柱必须为对象"]
    if not isinstance(d.get("id"), str) or not d.get("id"):
        out.append("光柱 id 必须为非空字符串")
    if not _in(d.get("mode"), CONTRACT["modes"]):
        out.append("mode 必须为 3d / 2d")
    if d.get("mode") == "3d":
        _shape3d_errors(d.get("shape3d"), out)
    if d.get("mode") == "2d":
        _shape2d_errors(d.get("shape2d"), out)
    _color_errors(d.get("color"), "color", out)
    if "colorEnd" in d:
        _color_errors(d["colorEnd"], "colorEnd", out)
    lim = LIMITS["intensity"]
    if not _in_range(d.get("intensity"), lim):
        out.append(f"intensity 必须在 {lim[0]}..{lim[1]}")
    if "alongCurve" in d:
        c = d["alongCurve"]
        av = LIMITS["alongValue"]
        ok = isinstance(c, list) and 0 < len(c) <= MAX_CURVE_KEYS
        if ok:
            for i, k in enumerate(c):
                if not (_is_vec(k, 2) and 0 <= k[0] <= 1 and _in_range(k[1], av) and (i == 0 or k[0] >= c[i - 1][0])):
                    ok = False
                    break
        if not ok:
            out.append(f"alongCurve 必须为 1..{MAX_CURVE_KEYS} 个 [t(0..1 递增), 倍率({av[0]}..{av[1]})]")
    for k in ("edgeSoftness", "thickness", "contactSoftWu"):
        if k in d and not _in_range(d[k], LIMITS[k]):
            out.append(f"{k} 必须在 {LIMITS[k][0]}..{LIMITS[k][1]}")
    if "blend" in d and not _in(d["blend"], CONTRACT["blends"]):
        out.append("blend 必须为 add / screen / normal")
    if "sort" in d and not _in(d["sort"], CONTRACT["sorts"]):
        out.append("sort 必须为 depth / background / foreground")
    fs = LIMITS["fadeSeconds"]
    for k in ("fadeIn", "fadeOut"):
        if k in d and not _in_range(d[k], fs):
            out.append(f"{k} 必须在 {fs[0]}..{fs[1]} 秒")
    if "noise" in d:
        n = d["noise"]
        if not _is_obj(n):
            out.append("noise 必须为对象")
        else:
            if not _in_range(n.get("strength"), LIMITS["noiseStrength"]):
                out.append("noise.strength 必须在 0..1")
            if not _is_num(n.get("scaleWu")) or n["scaleWu"] <= 0:
                out.append("noise.scaleWu 必须为正数")
            if "velocity" in n and not _is_vec(n["velocity"], 3):
                out.append("noise.velocity 必须为三个数")
    if "cookie" in d:
        c = d["cookie"]
        if not _is_obj(c):
            out.append("cookie 必须为对象")
        else:
            if not isinstance(c.get("image"), str) or not c.get("image"):
                out.append("cookie.image 必须为图片路径")
            if "strength" in c and not _in_range(c["strength"], LIMITS["cookieStrength"]):
                out.append("cookie.strength 必须在 0..1")
            if "scale" in c and not (_is_vec(c["scale"], 2) and all(s > 0 for s in c["scale"])):
                out.append("cookie.scale 必须为两个正数")
            if "offset" in c and not _is_vec(c["offset"], 2):
                out.append("cookie.offset 必须为两个数")
            if "rotationDeg" in c and not _is_num(c["rotationDeg"]):
                out.append("cookie.rotationDeg 必须为数")
    if "pulse" in d:
        p = d["pulse"]
        if not _is_obj(p):
            out.append("pulse 必须为对象")
        else:
            if not _in(p.get("kind"), CONTRACT["pulseKinds"]):
                out.append("pulse.kind 必须为 flicker / breathe")
            hz = LIMITS["pulseHz"]
            if not _in_range(p.get("hz"), hz):
                out.append(f"pulse.hz 必须在 {hz[0]}..{hz[1]}")
            if not _in_range(p.get("amount"), LIMITS["pulseAmount"]):
                out.append("pulse.amount 必须在 0..1")
    return out


def _shape3d_errors(s: Any, out: list[str]) -> None:
    if not _is_obj(s):
        out.append("3D 光柱缺少 shape3d")
        return
    if not _is_vec(s.get("to"), 3):
        out.append("shape3d.to 必须为三个数")
    if "from" in s and not _is_vec(s["from"], 3):
        out.append("shape3d.from 必须为三个数")
    if _is_vec(s.get("to"), 3) and ("from" not in s or _is_vec(s["from"], 3)):
        f = s.get("from") or [0, 0, 0]
        t = s["to"]
        if math.hypot(t[0] - f[0], t[1] - f[1], t[2] - f[2]) < MIN_LENGTH:
            out.append("shape3d 起点与终点重合")
    sec = s.get("section")
    if not _is_obj(sec) or not _in(sec.get("kind"), CONTRACT["sectionKinds"]):
        out.append("shape3d.section.kind 必须为 rect / polygon")
    elif sec["kind"] == "rect":
        if not _is_num(sec.get("width")) or sec["width"] <= 0 or not _is_num(sec.get("height")) or sec["height"] <= 0:
            out.append("矩形截面的 width / height 必须为正数")
    elif (not _is_int(sec.get("sides")) or sec["sides"] < MIN_SIDES or sec["sides"] > MAX_SIDES
          or not _is_num(sec.get("radius")) or sec["radius"] <= 0):
        out.append(f"正多边形截面的 sides 必须为 {MIN_SIDES}..{MAX_SIDES} 的整数、radius 必须为正数")
    sp = LIMITS["spreadDeg"]
    if "spreadDeg" in s and not (_is_vec(s["spreadDeg"], 2) and all(_in_range(a, sp) for a in s["spreadDeg"])):
        out.append(f"shape3d.spreadDeg 必须为两个 {sp[0]}..{sp[1]} 的角度")
    if "rollDeg" in s and not _is_num(s["rollDeg"]):
        out.append("shape3d.rollDeg 必须为数")


def _shape2d_errors(s: Any, out: list[str]) -> None:
    if not _is_obj(s):
        out.append("2D 光柱缺少 shape2d")
        return
    if not _is_vec(s.get("to"), 2):
        out.append("shape2d.to 必须为两个数")
    if "from" in s and not _is_vec(s["from"], 2):
        out.append("shape2d.from 必须为两个数")
    if _is_vec(s.get("to"), 2) and ("from" not in s or _is_vec(s["from"], 2)):
        f = s.get("from") or [0, 0]
        t = s["to"]
        if math.hypot(t[0] - f[0], t[1] - f[1]) < MIN_LENGTH:
            out.append("shape2d 起点与终点重合")
    w = s.get("width")
    if not (_is_vec(w, 2) and all(x >= 0 for x in w) and max(w[0], w[1]) > 0):
        out.append("shape2d.width 必须为两个非负数且不全为 0")
    if "occludeByDepth" in s and not isinstance(s["occludeByDepth"], bool):
        out.append("shape2d.occludeByDepth 必须为布尔")


def emitter_beam_ref_errors(em: Any, beam_ids: set[str], solver: str) -> list[str]:
    """发射器对光柱的引用问题。与 ``vfxBeam.ts emitterBeamRefErrors`` 逐条同序同句。"""
    out: list[str] = []
    if not _is_obj(em):
        return out
    spawn = em.get("spawn")
    shape = spawn.get("shape") if _is_obj(spawn) else None
    if _is_obj(shape) and shape.get("kind") == "beam":
        ref = shape.get("beam")
        if not isinstance(ref, str) or not ref:
            out.append("出生形状「光柱体积」没有指定光柱")
        elif ref not in beam_ids:
            out.append(f"出生形状引用的光柱「{ref}」不存在")
        if solver != "particle":
            out.append("「光柱体积」出生形状只对普通粒子求解器生效")
        if "along" in shape:
            a = shape["along"]
            if not (_is_vec(a, 2) and a[0] >= 0 and a[1] <= 1 and a[0] <= a[1]):
                out.append("spawn.shape.along 必须为 0..1 的递增区间")
    ap = em.get("appearance")
    if _is_obj(ap) and "beamLit" in ap:
        lit = ap["beamLit"]
        if not _is_obj(lit):
            out.append("appearance.beamLit 必须为对象")
        else:
            ref = lit.get("beam")
            if not isinstance(ref, str) or not ref:
                out.append("「被光柱照亮」没有指定光柱")
            elif ref not in beam_ids:
                out.append(f"「被光柱照亮」引用的光柱「{ref}」不存在")
            g = LIMITS["beamLitGain"]
            if "gain" in lit and not _in_range(lit["gain"], g):
                out.append(f"appearance.beamLit.gain 必须在 {g[0]}..{g[1]}")
    return out


def effect_beam_errors(effect: Any, solver_of: Callable[[dict], str]) -> list[str]:
    """整份效果里与光柱有关的全部问题。与 ``vfxBeam.ts effectBeamErrors`` 逐条同序同句。"""
    out: list[str] = []
    if not _is_obj(effect):
        return out
    ids: set[str] = set()
    if "beams" in effect:
        beams = effect["beams"]
        if not isinstance(beams, list):
            out.append("beams 必须为数组")
        else:
            for i, b in enumerate(beams):
                has_id = _is_obj(b) and isinstance(b.get("id"), str) and bool(b.get("id"))
                bid = b["id"] if has_id else f"#{i}"
                for e in beam_def_errors(b):
                    out.append(f"光柱「{bid}」: {e}")
                if has_id:
                    if b["id"] in ids:
                        out.append(f"光柱 id「{b['id']}」重复")
                    ids.add(b["id"])
    ems = effect.get("emitters")
    if isinstance(ems, list):
        for i, em in enumerate(ems):
            if not _is_obj(em):
                continue
            eid = em["id"] if isinstance(em.get("id"), str) and em.get("id") else f"#{i}"
            for e in emitter_beam_ref_errors(em, ids, solver_of(em)):
                out.append(f"发射器「{eid}」: {e}")
    return out


# ---------------------------------------------------------------------------
# 只读显示（主编辑器场景画布）：光柱的截面顶点与画面轮廓。与 vfxBeam.ts resolveBeam3dFrame / resolveBeam2dFrame
# 的 corners 逐点同式（parity 测试用 node 真跑那边比对）。
# ---------------------------------------------------------------------------

def _norm3(v: list[float]) -> float:
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    if n > 0:
        v[0] /= n; v[1] /= n; v[2] /= n
    return n


def beam3d_corners(shape: dict, anchor: tuple[float, float, float] | list[float]) -> list[tuple[float, float, float]] | None:
    """3D 光柱两圈截面顶点（源一圈 + 终点一圈，各 sides 个），M-world wu。退化返回 None。"""
    f = shape.get("from") or [0, 0, 0]
    t = shape["to"]
    origin = [anchor[0] + f[0], anchor[1] + f[1], anchor[2] + f[2]]
    axis = [t[0] - f[0], t[1] - f[1], t[2] - f[2]]
    length = _norm3(axis)
    if not length >= MIN_LENGTH:
        return None
    right = [axis[2], 0.0, -axis[0]]
    if _norm3(right) < 1e-6:
        right = [1.0, 0.0, 0.0]
    up = [axis[1] * right[2] - axis[2] * right[1], axis[2] * right[0] - axis[0] * right[2], axis[0] * right[1] - axis[1] * right[0]]
    _norm3(up)
    roll = math.radians(float(shape.get("rollDeg") or 0))
    if roll != 0:
        c, s = math.cos(roll), math.sin(roll)
        r0, u0 = right, up
        right = [r0[i] * c + u0[i] * s for i in range(3)]
        up = [-r0[i] * s + u0[i] * c for i in range(3)]
    spread = shape.get("spreadDeg") or [0, 0]
    sec = shape["section"]
    polygon = sec.get("kind") == "polygon"
    sides = int(sec["sides"]) if polygon else 4
    half_w0 = 0.0 if polygon else sec["width"] / 2
    half_h0 = 0.0 if polygon else sec["height"] / 2
    tan_w = math.tan(math.radians(spread[0]) / 2)
    tan_h = 0.0 if polygon else math.tan(math.radians(spread[1]) / 2)
    radius0 = sec["radius"] if polygon else 0.0
    out: list[tuple[float, float, float]] = []
    for ring in (0, 1):
        tt = 0.0 if ring == 0 else length
        cx, cy, cz = origin[0] + axis[0] * tt, origin[1] + axis[1] * tt, origin[2] + axis[2] * tt
        for k in range(sides):
            if not polygon:
                hw, hh = half_w0 + tt * tan_w, half_h0 + tt * tan_h
                lx = hw if k in (0, 3) else -hw
                ly = hh if k < 2 else -hh
            else:
                r = radius0 + tt * tan_w
                th = math.pi / 2 + 2 * math.pi * k / sides + math.pi / sides
                lx, ly = r * math.cos(th), r * math.sin(th)
            out.append((cx + right[0] * lx + up[0] * ly, cy + right[1] * lx + up[1] * ly, cz + right[2] * lx + up[2] * ly))
    return out


def beam2d_corners(shape: dict, anchor_scene: tuple[float, float] | list[float]) -> list[tuple[float, float]] | None:
    """2D 光带四角（起点左右、终点右左），画面 wu。退化返回 None。"""
    f = shape.get("from") or [0, 0]
    t = shape["to"]
    ox, oy = anchor_scene[0] + f[0], anchor_scene[1] + f[1]
    ex, ey = anchor_scene[0] + t[0], anchor_scene[1] + t[1]
    length = math.hypot(ex - ox, ey - oy)
    if not length >= MIN_LENGTH:
        return None
    dx, dy = (ex - ox) / length, (ey - oy) / length
    nx, ny = -dy, dx
    w0, w1 = shape["width"][0] / 2, shape["width"][1] / 2
    return [(ox + nx * w0, oy + ny * w0), (ox - nx * w0, oy - ny * w0), (ex - nx * w1, ey - ny * w1), (ex + nx * w1, ey + ny * w1)]


def convex_hull(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """画面凸包（Andrew 单调链，逆时针）。"""
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


class PlanarBeamSpace:
    """没有深度载荷时与运行时平面近似（``createPlanarVfxSpace``，k = √2）同式的换算。"""

    kind = "planar"

    def __init__(self, depth_scale: float = math.sqrt(2)) -> None:
        self.k = depth_scale

    def anchor_world(self, a: dict) -> tuple[float, float, float]:
        return float(a["x"]), float(a.get("h") or 0), -float(a["y"]) * self.k

    def ground_y(self, x: float, z: float) -> float:  # noqa: ARG002
        return 0.0

    def world_to_scene(self, w) -> tuple[float, float]:
        return float(w[0]), -float(w[2]) / self.k - float(w[1])


class GeometryBeamSpace:
    """场景有深度时：包一层轨迹工作台的 ``SceneGeometry``（行走面 / 深度壳 / 世界 ↔ 画面，与运行时同一套几何）。

    锚点解算与运行时 ``FieldSpace.anchorToWorld`` 同式：``ground`` = 行走面点 + 世界 Y 抬 h；
    ``shell`` = 该画面点视线上的壳点（工作分辨率双线性深度）沿壳法线抬 h。
    """

    kind = "field"

    def __init__(self, geometry: Any) -> None:
        self.g = geometry

    def anchor_world(self, a: dict) -> tuple[float, float, float]:
        g = self.g
        h = float(a.get("h") or 0)
        gw = g.scene_to_world_ground(float(a["x"]), float(a["y"]))
        if a.get("surface") == "shell" and g.geo is not None:
            qx, qy, _qz = g.world_to_q(*gw)
            px, py = g.q_to_work_px(qx, qy)
            depth = g.geo["depth"]
            hh, ww = depth.shape
            cpx, cpy = min(max(px, 0.0), ww - 1), min(max(py, 0.0), hh - 1)
            d = g._bilinear(depth, cpx, cpy)  # noqa: SLF001 — 同一份几何里的采样，不另写
            p = g.q_to_world(*g.work_px_to_q(cpx, cpy, d))
            n = g.geo["normal"][int(round(cpy)), int(round(cpx))]
            return p[0] + float(n[0]) * h, p[1] + float(n[1]) * h, p[2] + float(n[2]) * h
        return gw[0], gw[1] + h, gw[2]

    def ground_y(self, x: float, z: float) -> float:
        return float(self.g.ground_height(x, z))

    def world_to_scene(self, w) -> tuple[float, float]:
        return self.g.world_to_scene(float(w[0]), float(w[1]), float(w[2]))


def beam_overlay_rows(placement_rows: list[dict], effects: dict, space: Any) -> list[dict]:
    """布置（这一份）× 效果里的光柱 → 画布显示数据 ``{id, beam, mode, outline:[[x,y]…], start:[x,y], end:[x,y]}``。

    ``space`` 要有 ``anchor_world(anchor)`` / ``ground_y(x, z)`` / ``world_to_scene(w)``（场景有深度时由编辑器按
    轨迹工作台那份 ``SceneGeometry`` 包一层；没有就 :class:`PlanarBeamSpace`）。形状过不了闸门的光柱不画
    （运行时整个实例都建不起来，画出来反而像是能用）。
    """
    out: list[dict] = []
    for row in placement_rows:
        eff = effects.get(str(row.get("effect") or "")) if isinstance(effects, dict) else None
        beams = eff.get("beams") if isinstance(eff, dict) else None
        anchor = row.get("anchor")
        if not isinstance(beams, list) or not beams or not isinstance(anchor, dict):
            continue
        try:
            aw = space.anchor_world(anchor)
        except Exception:  # noqa: BLE001 — 单条锚点坏了不拖垮整块显示
            continue
        a_scene = space.world_to_scene(aw)
        for b in beams:
            if beam_def_errors(b):
                continue
            if b["mode"] == "3d":
                corners = beam3d_corners(b["shape3d"], aw)
                if not corners:
                    continue
                hull = convex_hull([space.world_to_scene(c) for c in corners])
                f = b["shape3d"].get("from") or [0, 0, 0]
                t = b["shape3d"]["to"]
                start = space.world_to_scene((aw[0] + f[0], aw[1] + f[1], aw[2] + f[2]))
                end = space.world_to_scene((aw[0] + t[0], aw[1] + t[1], aw[2] + t[2]))
            else:
                corners2 = beam2d_corners(b["shape2d"], a_scene)
                if not corners2:
                    continue
                hull = corners2
                f = b["shape2d"].get("from") or [0, 0]
                t = b["shape2d"]["to"]
                start = (a_scene[0] + f[0], a_scene[1] + f[1])
                end = (a_scene[0] + t[0], a_scene[1] + t[1])
            out.append({"id": str(row.get("id") or ""), "beam": b["id"], "mode": b["mode"],
                        "outline": [[float(p[0]), float(p[1])] for p in hull],
                        "start": [float(start[0]), float(start[1])], "end": [float(end[0]), float(end[1])]})
    return out


def beam_texture_refs(effect: Any) -> list[str]:
    """效果里光柱引用的贴图（图案遮罩）路径——给校验器查文件在不在。"""
    out: list[str] = []
    if not _is_obj(effect) or not isinstance(effect.get("beams"), list):
        return out
    for b in effect["beams"]:
        c = b.get("cookie") if _is_obj(b) else None
        if _is_obj(c) and isinstance(c.get("image"), str) and c["image"]:
            out.append(c["image"])
    return out
