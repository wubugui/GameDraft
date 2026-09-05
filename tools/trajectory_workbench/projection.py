# -*- coding: utf-8 -*-
"""世界空间帧 → 画面空间帧的投影（``src/utils/trajectoryProjection.ts`` 的逐字镜像）。

伪世界相机是正交的、q ↔ M-world 只差一个纯旋转 R（``depthConfig.M.R``，det=+1），
所以一个**相对** 3D 位移 Δw（wu）投到画面平面是::

    Δx =  (Rᵀ·Δw).x
    Δy = −(Rᵀ·Δw).y          （都是 wu；ppu / cx / cy / wuPerQUnit 全部约掉）

深度排序锚 ``sortY`` 取落点 ``(x, y − h, z)`` 再投影。

跨语言金标 ``src/utils/trajectoryProjection.golden.json``：TS 与本模块必须同数——
工作台落盘的回落 ``keyframes`` 与运行时开播时投出来的帧是同一条数学。
表达式顺序 ``r[i]*dx + r[i+3]*dy + r[i+6]*dz`` 与 TS 逐项同序，两侧逐位相同。
"""
from __future__ import annotations

import math
from typing import Any, Sequence

from .model import as_number

__all__ = [
    "basis_rows_from_R",
    "project_world_offset",
    "project_world_keyframes",
    "flip_keyframes",
]


def _det3(m: Sequence[float]) -> float:
    return (
        m[0] * (m[4] * m[8] - m[5] * m[7])
        - m[1] * (m[3] * m[8] - m[5] * m[6])
        + m[2] * (m[3] * m[7] - m[4] * m[6])
    )


def basis_rows_from_R(R: Any) -> list[float] | None:
    """``depthConfig.M.R``（3×3 嵌套数组）→ 行主 9 元；形状不对或 det 不是 +1 返回 None。"""
    if not isinstance(R, (list, tuple)) or len(R) != 3:
        return None
    rows: list[float] = []
    for r in R:
        if not isinstance(r, (list, tuple)) or len(r) != 3:
            return None
        for v in r:
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                return None
            rows.append(float(v))
    if abs(_det3(rows) - 1.0) > 1e-3:
        return None
    return rows


def _q_comp(rows: Sequence[float], i: int, dx: float, dy: float, dz: float) -> float:
    """``(Rᵀ·d)[i]``：R 正交 ⇒ 转置即逆，行主 R 按列取。与 TS ``wrWorldToQComponent`` 同序。"""
    return rows[i] * dx + rows[i + 3] * dy + rows[i + 6] * dz


def project_world_offset(rows: Sequence[float], dx: float, dy: float, dz: float) -> tuple[float, float]:
    """相对 3D 位移（M-world wu）→ 画面平面相对偏移（场景坐标 wu，Y 向下）。"""
    return (_q_comp(rows, 0, dx, dy, dz), -_q_comp(rows, 1, dx, dy, dz))


def project_world_keyframes(frames: Any, rows: Sequence[float]) -> list[dict]:
    """世界空间帧 → 画面空间帧（都相对锚点，**不取整**；落盘取整走 ``model.write_keyframe``）。

    键集与 TS 同：``atMs, x, y`` 恒有；``rotation/scale/scaleX/scaleY/alpha`` 只在源帧
    给了有限数时透传；``sortY`` 只在与 ``y`` 不同时写。
    """
    if not isinstance(frames, (list, tuple)):
        return []
    out: list[dict] = []
    for f in frames:
        if not isinstance(f, dict):
            continue
        wx = as_number(f.get("x"), 0.0)
        wy = as_number(f.get("y"), 0.0)
        wz = as_number(f.get("z"), 0.0)
        h = max(0.0, as_number(f.get("h"), 0.0))
        px, py = project_world_offset(rows, wx, wy, wz)
        _fx, fy = project_world_offset(rows, wx, wy - h, wz)
        k: dict = {"atMs": as_number(f.get("atMs"), 0.0), "x": px, "y": py}
        for ch in ("rotation", "scale", "scaleX", "scaleY", "alpha"):
            v = f.get(ch)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
                k[ch] = v
        if fy != py:
            k["sortY"] = fy
        out.append(k)
    return out


def flip_keyframes(frames: Any) -> list[dict]:
    """左右翻转画面空间帧：``x`` 取反、叠加旋转取反，其余原样（``playTrajectory.flipX``）。"""
    if not isinstance(frames, (list, tuple)):
        return []
    out: list[dict] = []
    for f in frames:
        if not isinstance(f, dict):
            continue
        k = dict(f)
        k["x"] = -as_number(f.get("x"), 0.0)
        rot = f.get("rotation")
        if isinstance(rot, (int, float)) and not isinstance(rot, bool) and math.isfinite(rot):
            k["rotation"] = -rot
        out.append(k)
    return out
