"""可燃物实例在编辑器画面上怎么摆（零 Qt 纯函数）：场景画布与挂件试挂预览共用。

跨语言镜像，TS 权威是 ``src/systems/burn/burnGeometry.ts``：

* :func:`entity_placement` ↔ ``burnEntityPlacement``（场景实体 = 热点 / NPC：模板真实尺寸 × 实体 scale × 透视系数、
  绕实体锚点旋转、朝左镜像；接地点按锚点反推）；
* :func:`placement_frame` ↔ ``burnPlacementFrame``（``scene = o + u·du + v·dv``）；
* :func:`uv_to_scene` ↔ ``burnUvToScene``。

镜像必须有语义级 parity（norms 第 8 条）：``tools/editor/editors/tests/test_scene_editor_burn_overlay.py``
按 ``src/systems/burn/burnSim.test.ts`` 同一组用例钉死这几项，画布贴图的 QTransform 与着火点标记都从同一个
:class:`BurnFrame` 派生——图和点不可能各摆各的。

挂件（手上拿的可燃道具）不走场景摆法：挂点对准模板握点 ``grip``（缺省底边中点），贴图等比缩放到模板真实宽
（``widthCm × 0.88`` wu，× 预设 ``scale``）。运行时挂件贴图宽 = ``texW × scale``，所以换算成挂件口径的 scale 是
``widthCm·0.88 / texW × 预设 scale``（:func:`prop_scale_for_template`）。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from .burnables import WU_PER_CM, template_grip, template_world_size
from .entity_transform_math import entity_anchor_of, entity_rotation_deg_of, entity_scale_of


@dataclass(frozen=True)
class BurnFrame:
    """实例图在画面上的摆放（场景 wu）：``scene = o + u·(ux, uy) + v·(vx, vy)``，立面脚点 ``foot``。"""

    ox: float
    oy: float
    ux: float
    uy: float
    vx: float
    vy: float
    foot_x: float
    foot_y: float


@dataclass(frozen=True)
class BurnPlacement:
    x: float
    y: float
    width: float
    height: float
    scale: float
    rotation: float        # 弧度
    flip_x: bool
    anchor_x: float = 0.5
    anchor_y: float = 1.0
    foot_x: float | None = None
    foot_y: float | None = None


def _num(v: object, default: float) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return default
    f = float(v)
    return f if math.isfinite(f) else default


def entity_placement(
    defn: dict, size: tuple[float, float], *, depth_scale: float, flip_x: bool,
) -> BurnPlacement:
    """``burnEntityPlacement`` 的镜像：场景实体定义 + 模板尺寸（wu）→ 实例摆放。

    ``depth_scale`` = 此刻的透视系数（热点只有参与透视才不是 1，由调用方判——同运行时）。
    """
    ax, ay = entity_anchor_of(defn)
    ds = float(depth_scale)
    scale = entity_scale_of(defn) * (ds if ds > 0 and math.isfinite(ds) else 1.0)
    rotation = math.radians(entity_rotation_deg_of(defn))
    flip = -1.0 if flip_x else 1.0
    w, h = float(size[0]), float(size[1])
    lx = (0.5 - ax) * w * scale * flip
    ly = (1.0 - ay) * h * scale
    c, s = math.cos(rotation), math.sin(rotation)
    x = _num(defn.get("x"), 0.0)
    y = _num(defn.get("y"), 0.0)
    return BurnPlacement(
        x=x, y=y, width=w, height=h, scale=scale, rotation=rotation, flip_x=bool(flip_x),
        anchor_x=ax, anchor_y=ay,
        foot_x=x + lx * c - ly * s, foot_y=y + lx * s + ly * c,
    )


def placement_frame(p: BurnPlacement) -> BurnFrame:
    """``burnPlacementFrame`` 的镜像。"""
    flip = -1.0 if p.flip_x else 1.0
    c, s = math.cos(p.rotation), math.sin(p.rotation)
    lux = p.width * flip * p.scale
    lvy = p.height * p.scale
    l0x = -p.anchor_x * lux
    l0y = -p.anchor_y * lvy
    return BurnFrame(
        ox=p.x + l0x * c - l0y * s,
        oy=p.y + l0x * s + l0y * c,
        ux=lux * c,
        uy=lux * s,
        vx=-lvy * s,
        vy=lvy * c,
        foot_x=p.x if p.foot_x is None else p.foot_x,
        foot_y=p.y if p.foot_y is None else p.foot_y,
    )


def entity_frame(defn: dict, size: tuple[float, float], *, depth_scale: float, flip_x: bool) -> BurnFrame:
    return placement_frame(entity_placement(defn, size, depth_scale=depth_scale, flip_x=flip_x))


def uv_to_scene(f: BurnFrame, u: float, v: float) -> tuple[float, float]:
    """``burnUvToScene`` 的镜像。"""
    return f.ox + u * f.ux + v * f.vx, f.oy + u * f.uy + v * f.vy


def frame_pixel_transform(f: BurnFrame, px_w: float, px_h: float) -> tuple[float, float, float, float, float, float]:
    """把一张 ``px_w × px_h`` 像素的图贴到这个摆放上：像素 ``(px, py)`` → ``o + (px/px_w)·du + (py/px_h)·dv``。

    返回 ``QTransform(m11, m12, m21, m22, dx, dy)`` 的六个数（Qt 行向量约定：``x' = m11·x + m21·y + dx``）。
    """
    w = max(1.0, float(px_w))
    h = max(1.0, float(px_h))
    return f.ux / w, f.uy / w, f.vx / h, f.vy / h, f.ox, f.oy


def hotspot_flip_x(hs: dict) -> bool:
    """热点实例朝左（``displayImage.facing == "left"``）——开了可燃时 ``facing`` 照用（数据契约）。"""
    di = hs.get("displayImage") if isinstance(hs.get("displayImage"), dict) else {}
    return str(di.get("facing", "") or "right").strip().lower() == "left"


def template_size_wu(doc: object) -> tuple[float, float] | None:
    """模板真实尺寸（wu，未乘宿主缩放）；没写 / 坏 ⇒ None。"""
    return template_world_size(doc)


def prop_scale_for_template(doc: object, tex_w: float, preset_scale: float) -> float | None:
    """可燃挂件在挂件口径下的 scale：``widthCm·0.88 / texW × 预设 scale``；模板没尺寸 / 贴图宽不知道 ⇒ None。"""
    if not isinstance(doc, dict):
        return None
    wcm = doc.get("widthCm")
    if isinstance(wcm, bool) or not isinstance(wcm, (int, float)) or not math.isfinite(float(wcm)) or wcm <= 0:
        return None
    if not (tex_w and tex_w > 0):
        return None
    ps = _num(preset_scale, 1.0)
    ps = ps if ps > 0 else 1.0
    return float(wcm) * WU_PER_CM / float(tex_w) * ps


def prop_anchor_for_template(doc: object) -> tuple[float, float]:
    """可燃挂件挂点对准的贴图点 = 模板握点（缺省底边中点）。"""
    return template_grip(doc)
