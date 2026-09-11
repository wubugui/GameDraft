# -*- coding: utf-8 -*-
"""烘焙编排：一份资产（``source`` + ``authoring`` + ``space``）→ 运行时帧 + 预览曲线。

这是服务端 ``/api/bake`` 与 ``/api/save`` 共用的唯一入口——**保存 = 烘一次再写**，
保证磁盘上 ``source`` 与 ``keyframes`` 永远同一次烘焙的产物（分开写就会出现
"路径是新的、帧是旧的"这种运行时看不出来的坏数据）。

**曲线本身没有锚点**（2026-09-11 制作人重定）：曲线就是画在场景里的一条路径，播放位置在播放时给。

**曲线有自己的原点**（2026-09-11 第二轮）：``authoring.origin``（画面 wu；世界空间另记
``authoring.originWorld``，``origin`` 是它的投影）是**作者摆的参考点**，不是第一帧。帧写成相对原点的偏移，
播放时给的位置对齐的就是这个原点；场景曲线不给位置就放回 ``origin`` 原地播。
烘焙机**只在它缺省时回填**（新曲线 / 老资产 = 曲线起点），之后一律以作者摆的为准——
第一版把它钉死成第一帧，于是"调一下运动起点"会让整条曲线在播放时整体位移（制作人 2026-09-11 打回：
"曲线的起点绑死原点…这是不对的"）。所以第一帧**不再恒为 (0,0)**。

空间：
- ``screen``：:mod:`.bake`（2D）；``contactOffsetY``（``source.bake``，骑在曲线上那个东西的接地偏移）把 sortY 落到接地线；
- ``world``：:mod:`.bake3d`（3D）；``restHeight``（``source.bake``，那个东西静止时支点离地高，圆心锚的铜钱 = 半径）
  是抛体的贴地高度，产物 ``worldKeyframes``（相对 ``originWorld``）+ 按烘焙场景 R 投好的回落 ``keyframes``。

兼容旧资产：``authoring.anchor`` / ``anchorWorld`` / ``anchorHeight`` / ``contactOffsetY`` 仍能读
（第 0 段 ``startFrom:'anchor'`` 时锚点只当"段起点"用），产物里一律不再写它们。**保存即迁移**：
产物 ``source`` 是补齐过的副本——``source.bake.restHeight / contactOffsetY`` 从旧键回填，
第 0 段的 ``startFrom:'anchor'`` 改成 ``'explicit'`` + 明写 ``start``（锚点剥掉之后再烘还是同一条曲线，
不许"第二次保存曲线自己挪走"）。

命名插槽 ``slots``（曲线暴露给场景的位置）原样透传；世界空间给每个插槽补脚下地面的世界坐标 ``world``。
"""
from __future__ import annotations

import copy
import math
from typing import Any

from .assets import relativize_screen_frames, write_world_keyframe
from .bake import bake_samples, bake_trajectory
from .bake3d import bake_world_samples, decimate_world_samples
from .model import as_number, write_keyframe
from .projection import project_world_keyframes

__all__ = ["bake_asset", "bake_params", "binding_of"]

BINDINGS: tuple[str, ...] = ("scene", "free")


def binding_of(doc: dict) -> str:
    """``binding``：``scene``（场景曲线，绑定作者场景）/ ``free``（相对曲线，不绑场景）。
    缺省按老资产推：写了 ``authoring.sceneId`` 的当场景曲线。"""
    b = str(doc.get("binding") or "").strip()
    if b in BINDINGS:
        return b
    au = doc.get("authoring") if isinstance(doc.get("authoring"), dict) else {}
    return "scene" if str(au.get("sceneId") or "").strip() else "free"


def _legacy_anchor(authoring: dict) -> tuple[float, float] | None:
    a = authoring.get("anchor") if isinstance(authoring.get("anchor"), dict) else None
    if not a:
        return None
    return (as_number(a.get("x"), 0.0), as_number(a.get("y"), 0.0))


def bake_params(doc: dict, cos_theta: float = 1.0) -> dict:
    """``source.bake`` 里"骑在曲线上的那个东西"的两个尺寸参数（老资产从 ``authoring`` 回落）。"""
    src = doc.get("source") if isinstance(doc.get("source"), dict) else {}
    bk = src.get("bake") if isinstance(src.get("bake"), dict) else {}
    au = doc.get("authoring") if isinstance(doc.get("authoring"), dict) else {}
    contact = bk.get("contactOffsetY")
    if contact is None:
        contact = au.get("contactOffsetY")
    contact = as_number(contact, 0.0)
    rest = bk.get("restHeight")
    if rest is None:
        rest = au.get("anchorHeight")
    if rest is None:
        rest = contact / max(1e-6, abs(float(cos_theta)))
    return {"contactOffsetY": contact, "restHeight": as_number(rest, 0.0)}


def _fill_bake_params(source: dict, params: dict) -> None:
    """``source.bake`` 里缺的尺寸参数用解析值补上（老资产从 ``authoring`` 迁过来；新资产前端已写）。"""
    bk = source.get("bake")
    if not isinstance(bk, dict):
        bk = source["bake"] = {}
    for k in ("restHeight", "contactOffsetY"):
        if bk.get(k) is None:
            bk[k] = round(float(params[k]), 3)


def _explicit_first_start(source: dict, start, *, world: bool = False) -> None:
    """第 0 段还写着 ``startFrom:'anchor'``（或缺省）且能解出旧锚点时，改成明写起点——锚点剥掉之后这条曲线不动。"""
    segs = source.get("segments")
    if start is None or not isinstance(segs, list) or not segs or not isinstance(segs[0], dict):
        return
    seg = segs[0]
    mode = str(seg.get("startFrom") or "").strip()
    if mode in ("previous", "explicit"):
        return
    seg["startFrom"] = "explicit"
    if world:
        seg["start"] = {"x": round(float(start[0]), 2), "z": round(float(start[1]), 2), "h": round(float(start[2]), 2)}
    else:
        seg["start"] = {"x": round(float(start[0]), 2), "y": round(float(start[1]), 2)}


def _authored_origin(authoring: dict) -> tuple[float, float] | None:
    """作者摆的曲线原点（画面 wu）。没有 / 不是有限数 → None（由调用方回填成曲线起点）。"""
    o = authoring.get("origin")
    if not isinstance(o, dict):
        return None
    x, y = as_number(o.get("x"), float("nan")), as_number(o.get("y"), float("nan"))
    if not (math.isfinite(x) and math.isfinite(y)):
        return None
    return (x, y)


def _authored_origin_world(authoring: dict) -> tuple[float, float, float] | None:
    """作者摆的曲线原点（世界 wu，绝对点）。世界空间的真相是它，``origin`` 只是它的投影。"""
    o = authoring.get("originWorld")
    if not isinstance(o, dict):
        return None
    v = [as_number(o.get(k), float("nan")) for k in ("x", "y", "z")]
    return (v[0], v[1], v[2]) if all(math.isfinite(c) for c in v) else None


def _clean_slots(doc: dict) -> list[dict]:
    raw = doc.get("slots")
    out: list[dict] = []
    if not isinstance(raw, list):
        return out
    seen: set[str] = set()
    for s in raw:
        if not isinstance(s, dict):
            continue
        sid = str(s.get("id") or "").strip()
        if not sid or sid in seen:
            continue
        seen.add(sid)
        row: dict = {"id": sid, "x": round(as_number(s.get("x"), 0.0), 2), "y": round(as_number(s.get("y"), 0.0), 2)}
        label = str(s.get("label") or "").strip()
        if label:
            row["label"] = label
        out.append(row)
    return out


def bake_asset(doc: dict, geom) -> dict:
    """返回 ``{keyframes, worldKeyframes?, authoring, source, slots, binding, warnings, segments, totalMs, preview}``。

    ``preview``：给前端画曲线的**绝对**密采样（画面空间 ``screen`` 恒有；世界空间另给 ``world``）。
    ``authoring`` 是补齐了 ``origin`` / ``originWorld`` 的副本（服务端回填，前端原样存），老锚点键已剥掉。
    ``source`` 是迁移过的深拷贝（见模块说明）；输入文档不动。
    ``keyframes`` 为空表示没烘出东西（段为空 / 场景没深度）——调用方保留原帧，不许清盘。
    """
    space = str(doc.get("space") or "screen")
    authoring = dict(doc.get("authoring") or {})
    legacy_anchor = _legacy_anchor(authoring)
    legacy_world = authoring.get("anchorWorld") if isinstance(authoring.get("anchorWorld"), dict) else None
    for k in ("anchor", "anchorWorld", "anchorHeight", "contactOffsetY"):
        authoring.pop(k, None)
    binding = binding_of(doc)
    warnings: list[str] = []
    slots = _clean_slots(doc)
    source = copy.deepcopy(doc.get("source")) if isinstance(doc.get("source"), dict) else {}
    out: dict = {"keyframes": [], "authoring": authoring, "source": source, "warnings": warnings, "slots": slots,
                 "binding": binding, "segments": [], "totalMs": 0.0, "preview": {"screen": [], "world": []}}
    if binding == "scene" and not str(authoring.get("sceneId") or "").strip():
        warnings.append("场景曲线必须绑定作者场景（authoring.sceneId 为空）")

    cos_t = max(1e-6, abs(float(getattr(geom, "cos_theta", 1.0) or 1.0)))
    params = bake_params(doc, cos_t)
    _fill_bake_params(source, params)
    if space != "world":
        contact = params["contactOffsetY"]
        if legacy_anchor is not None:
            legacy_anchor = (round(legacy_anchor[0], 2), round(legacy_anchor[1], 2))
        _explicit_first_start(source, legacy_anchor)
        dense = bake_samples(doc, anchor=legacy_anchor, contact_offset_y=contact)
        warnings.extend(dense.warnings)
        out["segments"] = dense.segments
        out["totalMs"] = dense.total_ms
        out["preview"]["screen"] = [
            [s["atMs"], s["x"], s["y"], s["sortY"], s["rotation"], s["scaleX"], s["scaleY"], s["alpha"], 1 if s.get("hard") else 0]
            for s in dense.samples
        ]
        frames_abs = bake_trajectory(doc, anchor=legacy_anchor, contact_offset_y=contact)
        if frames_abs:
            # 原点 = 作者摆的那个点；没摆过（新曲线 / 老资产）才回填成曲线起点。
            # 用**落盘后**的 2 位小数值参与相对化，保证"存一次 == 存两次"逐字节。
            origin = _authored_origin(authoring) or (
                as_number(frames_abs[0].get("x"), 0.0), as_number(frames_abs[0].get("y"), 0.0))
            origin = (round(origin[0], 2), round(origin[1], 2))
            authoring["origin"] = {"x": origin[0], "y": origin[1]}
            out["keyframes"] = relativize_screen_frames(frames_abs, origin)
            out["keyframes"][0]["atMs"] = 0
        elif _authored_origin(authoring) is None and legacy_anchor is not None:
            authoring["origin"] = {"x": round(legacy_anchor[0], 2), "y": round(legacy_anchor[1], 2)}
        authoring.pop("originWorld", None)
        return out

    if not getattr(geom, "has_depth", False):
        warnings.append("场景没有 depthConfig / 深度图：世界空间无法还原")
        return out
    rest_h = params["restHeight"]
    anchor_world: tuple[float, float, float] | None = None
    if legacy_world and all(isinstance(legacy_world.get(k), (int, float)) for k in ("x", "y", "z")):
        anchor_world = (float(legacy_world["x"]), float(legacy_world["y"]), float(legacy_world["z"]))
    elif legacy_anchor is not None:
        gx, gy, gz = geom.scene_to_world_ground(legacy_anchor[0], legacy_anchor[1] + params["contactOffsetY"])
        anchor_world = (gx, gy + rest_h, gz)
    if anchor_world is not None:
        # 明写的起点按 2 位小数落盘；烘焙也用落盘后的那个值，保证"保存一次 = 保存两次"（逐字节）
        ax, ay, az = anchor_world
        rx, rz, rh = round(ax, 2), round(az, 2), round(max(0.0, ay - geom.ground_height(ax, az)), 2)
        _explicit_first_start(source, (rx, rz, rh), world=True)
        anchor_world = (rx, geom.ground_height(rx, rz) + rh, rz)

    dense = bake_world_samples(doc, geom, anchor_world=anchor_world, rest_h=rest_h)
    warnings.extend(dense.warnings)
    out["segments"] = dense.segments
    out["totalMs"] = dense.total_ms
    # 插槽脚下的地面世界点（插槽是"站位"，画面 y 是脚点）
    bounds = getattr(geom, "ground_bounds", None)
    for s in slots:
        try:
            wx, wy, wz = geom.scene_to_world_ground(s["x"], s["y"])
        except Exception:  # noqa: BLE001 — 假几何（测试）
            continue
        s["world"] = {"x": round(wx, 2), "y": round(wy, 2), "z": round(wz, 2)}
        if callable(bounds):
            try:
                bx0, bx1, bz0, bz1 = bounds()
                if not (bx0 <= wx <= bx1 and bz0 <= wz <= bz1):
                    warnings.append(f"插槽 {s.get('label') or s['id']} 脚下的地面点落在行走面之外")
            except Exception:  # noqa: BLE001
                pass
    if not dense.samples:
        return out
    rows = geom.rows
    prev_screen: list[list[float]] = []
    prev_world: list[list[float]] = []
    for s in dense.samples:
        sx, sy = geom.world_to_scene(s["x"], s["y"], s["z"])
        fx, fy = geom.world_to_scene(s["x"], s["y"] - s["h"], s["z"])
        prev_screen.append([s["atMs"], sx, sy, fy, s["rotation"], s["scaleX"], s["scaleY"], s["alpha"], 1 if s.get("hard") else 0])
        prev_world.append([s["atMs"], s["x"], s["y"], s["z"], s["h"]])
    out["preview"] = {"screen": prev_screen, "world": prev_world}

    first = dense.samples[0]
    # 原点 = 作者摆的那个点（世界绝对坐标）；没摆过才回填成曲线起点。落盘取 3 位并用落盘值参与相对化。
    origin_world = _authored_origin_world(authoring) or (float(first["x"]), float(first["y"]), float(first["z"]))
    origin_world = (round(origin_world[0], 3), round(origin_world[1], 3), round(origin_world[2], 3))
    authoring["originWorld"] = {"x": origin_world[0], "y": origin_world[1], "z": origin_world[2]}
    ox, oy = geom.world_to_scene(*origin_world)
    authoring["origin"] = {"x": round(ox, 2), "y": round(oy, 2)}
    # 曲线起点脚下的地面落在行走面高度场之外：高度场只做边缘钳位，离地高会算错——必须出声
    start_world = (float(first["x"]), float(first["y"]), float(first["z"]))
    if callable(bounds):
        try:
            bx0, bx1, bz0, bz1 = bounds()
            if not (bx0 <= start_world[0] <= bx1 and bz0 <= start_world[2] <= bz1):
                warnings.append(f"曲线起点 ({start_world[0]:.0f}, {start_world[2]:.0f}) 落在行走面范围之外 [{bx0:.0f}..{bx1:.0f}]×[{bz0:.0f}..{bz1:.0f}]：把起点放回画面里的地面上")
            if not (bx0 <= origin_world[0] <= bx1 and bz0 <= origin_world[2] <= bz1):
                warnings.append(f"曲线原点 ({origin_world[0]:.0f}, {origin_world[2]:.0f}) 落在行走面范围之外：播放位置对齐的就是它，放回画面里")
        except Exception:  # noqa: BLE001 — 假几何（测试）没有边界就跳过
            pass

    kept = decimate_world_samples(dense.samples, dense.tolerance)
    world_frames: list[dict] = []
    for sm in kept:
        fr = write_world_keyframe(sm, origin_world)
        if world_frames and fr == world_frames[-1]:
            continue
        world_frames.append(fr)
    world_frames[0]["atMs"] = 0
    if len(world_frames) > 1:
        world_frames[-1]["atMs"] = int(round(dense.total_ms))
    # 回落 2D 帧：从**落盘形**世界帧投影（与运行时投的是同一份数，只多一次取整）
    fallback = [write_keyframe(k) for k in project_world_keyframes(world_frames, rows)]
    for a, b in zip(fallback, world_frames):
        a["atMs"] = b["atMs"]
    out["worldKeyframes"] = world_frames
    out["keyframes"] = fallback
    return out
