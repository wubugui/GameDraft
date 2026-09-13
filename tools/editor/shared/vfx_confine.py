"""粒子区域（场景 ``vfx[].area`` + ``vfx[].confine``）的编辑器侧几何小件。

运行时权威在 ``src/systems/vfx/vfxConfine.ts``；这里只放编辑器画布与校验器要用的那几样
（点在多边形里 / 自相交 / 缺省边带宽），缺省值与 TS 那份由
``tools/editor/tests/test_vfx_confine.py`` 逐字对账。
"""

from __future__ import annotations

from typing import Sequence

#: 边带宽缺省（画面坐标 wu）——与 TS ``CONFINE_FEATHER_DEFAULT`` 同一个数
CONFINE_FEATHER_DEFAULT = 120.0

Point = Sequence[float]


def point_in_polygon(poly: Sequence[Point], x: float, y: float) -> bool:
    """奇偶规则，与运行时 ``pointInPolygon`` 同一条式子（自相交时两边算出同样的"洞"）。"""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = float(poly[i][0]), float(poly[i][1])
        xj, yj = float(poly[j][0]), float(poly[j][1])
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _cross(ax: float, ay: float, bx: float, by: float, cx: float, cy: float) -> float:
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)


def _segments_cross(p1: Point, p2: Point, p3: Point, p4: Point) -> bool:
    """两条线段是否**真相交**（端点相切、共线重叠不算——那种画出来也不会挖洞）。"""
    d1 = _cross(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1])
    d2 = _cross(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1])
    d3 = _cross(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1])
    d4 = _cross(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1])
    return ((d1 > 0 > d2) or (d1 < 0 < d2)) and ((d3 > 0 > d4) or (d3 < 0 < d4))


def is_polygon(v: object) -> bool:
    """≥3 个 ``[x, y]`` 数值点（与运行时 ``toPoly`` 的"凑不出 3 个有限点就不算"同口径）。"""
    if not isinstance(v, list) or len(v) < 3:
        return False
    for p in v:
        if not (isinstance(p, list) and len(p) == 2):
            return False
        for c in p:
            if isinstance(c, bool) or not isinstance(c, (int, float)) or c != c or c in (float("inf"), float("-inf")):
                return False
    return True


def polygons_overlap(a: Sequence[Point], b: Sequence[Point]) -> bool:
    """两块多边形有没有公共部分（顶点落进对方 / 边相交）。发射区域与范围区域不相交 = 纸钱挑不到落点。"""
    if any(point_in_polygon(b, float(p[0]), float(p[1])) for p in a):
        return True
    if any(point_in_polygon(a, float(p[0]), float(p[1])) for p in b):
        return True
    na, nb = len(a), len(b)
    for i in range(na):
        for j in range(nb):
            if _segments_cross(a[i], a[(i + 1) % na], b[j], b[(j + 1) % nb]):
                return True
    return False


def polygon_self_intersects(poly: Sequence[Point]) -> bool:
    """任意两条不相邻的边真相交 ⇒ 自相交。奇偶规则下交叉围出来的那块会变成框外（一个洞）。"""
    n = len(poly)
    if n < 4:
        return False
    for i in range(n):
        a1, a2 = poly[i], poly[(i + 1) % n]
        for j in range(i + 1, n):
            if j == i or (j + 1) % n == i or (i + 1) % n == j:
                continue
            if _segments_cross(a1, a2, poly[j], poly[(j + 1) % n]):
                return True
    return False
