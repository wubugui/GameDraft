# -*- coding: utf-8 -*-
"""烘焙编排：一份资产（``source`` + ``authoring`` + ``space``）→ 运行时帧 + 预览曲线。

这是服务端 ``/api/bake`` 与 ``/api/save`` 共用的唯一入口——**保存 = 烘一次再写**，
保证磁盘上 ``source`` 与 ``keyframes`` 永远同一次烘焙的产物（分开写就会出现
"路径是新的、帧是旧的"这种运行时看不出来的坏数据）。

空间：
- ``screen``：:mod:`.bake`（2D），锚点 = ``authoring.anchor``，``contactOffsetY`` 把 sortY 落到接地线；
- ``world``：:mod:`.bake3d`（3D），锚点 = 画面锚点脚下的地面点抬 ``anchorHeight``
  （= ``contactOffsetY / cosθ``：画面上的接地偏移是竖直高度的正交投影），
  产物 ``worldKeyframes``（相对 ``anchorWorld``）+ 按烘焙场景 R 投好的回落 ``keyframes``。
"""
from __future__ import annotations

from typing import Any

from .assets import relativize_screen_frames, write_world_keyframe
from .bake import bake_samples, bake_trajectory
from .bake3d import bake_world_samples, decimate_world_samples
from .model import as_number, write_keyframe
from .projection import project_world_keyframes

__all__ = ["bake_asset"]


def _anchor_of(authoring: dict) -> tuple[float, float]:
    a = authoring.get("anchor") if isinstance(authoring.get("anchor"), dict) else {}
    return (as_number(a.get("x"), 0.0), as_number(a.get("y"), 0.0))


def bake_asset(doc: dict, geom) -> dict:
    """返回 ``{keyframes, worldKeyframes?, authoring, warnings, segments, totalMs, preview}``。

    ``preview``：给前端画曲线的**绝对**密采样（画面空间 ``screen`` 恒有；世界空间另给 ``world``）。
    ``authoring`` 是补齐了 ``anchorWorld`` / ``anchorHeight`` 的副本（服务端回填，前端原样存）。
    ``keyframes`` 为空表示没烘出东西（段为空 / 场景没深度）——调用方保留原帧，不许清盘。
    """
    space = str(doc.get("space") or "screen")
    authoring = dict(doc.get("authoring") or {})
    ax, ay = _anchor_of(authoring)
    contact = as_number(authoring.get("contactOffsetY"), 0.0)
    warnings: list[str] = []
    out: dict = {"keyframes": [], "authoring": authoring, "warnings": warnings,
                 "segments": [], "totalMs": 0.0, "preview": {"screen": [], "world": []}}

    if space != "world":
        dense = bake_samples(doc, anchor=(ax, ay), contact_offset_y=contact)
        warnings.extend(dense.warnings)
        out["segments"] = dense.segments
        out["totalMs"] = dense.total_ms
        out["preview"]["screen"] = [
            [s["atMs"], s["x"], s["y"], s["sortY"], s["rotation"], s["scaleX"], s["scaleY"], s["alpha"], 1 if s.get("hard") else 0]
            for s in dense.samples
        ]
        frames_abs = bake_trajectory(doc, anchor=(ax, ay), contact_offset_y=contact)
        out["keyframes"] = relativize_screen_frames(frames_abs, (ax, ay)) if frames_abs else []
        if out["keyframes"]:
            out["keyframes"][0]["atMs"] = 0
        authoring.pop("anchorWorld", None)
        authoring.pop("anchorHeight", None)
        return out

    if not getattr(geom, "has_depth", False):
        warnings.append("场景没有 depthConfig / 深度图：世界空间无法还原")
        return out
    cos_t = max(1e-6, abs(float(getattr(geom, "cos_theta", 1.0))))
    anchor_height = contact / cos_t
    gx, gy, gz = geom.scene_to_world_ground(ax, ay + contact)
    anchor_world = (gx, gy + anchor_height, gz)
    # 锚点落在行走面高度场之外：高度场只做边缘钳位，起点离地高会算错、整条 h 跟着塌——必须出声
    bounds = getattr(geom, "ground_bounds", None)
    if callable(bounds):
        try:
            bx0, bx1, bz0, bz1 = bounds()
            if not (bx0 <= gx <= bx1 and bz0 <= gz <= bz1):
                warnings.append(f"锚点脚下的地面点 ({gx:.0f}, {gz:.0f}) 落在行走面范围之外 [{bx0:.0f}..{bx1:.0f}]×[{bz0:.0f}..{bz1:.0f}]：把锚点放回画面里的地面上")
        except Exception:  # noqa: BLE001 — 假几何（测试）没有边界就跳过
            pass
    authoring["anchorWorld"] = {"x": round(gx, 3), "y": round(gy + anchor_height, 3), "z": round(gz, 3)}
    authoring["anchorHeight"] = round(anchor_height, 3)

    dense = bake_world_samples(doc, geom, anchor_world=anchor_world, rest_h=anchor_height)
    warnings.extend(dense.warnings)
    out["segments"] = dense.segments
    out["totalMs"] = dense.total_ms
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

    kept = decimate_world_samples(dense.samples, dense.tolerance)
    world_frames: list[dict] = []
    for sm in kept:
        fr = write_world_keyframe(sm, anchor_world)
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
