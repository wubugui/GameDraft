"""实例变换（缩放 / 旋转）与整组位移。

两者都遵守同一条：**手势期间不写数据**，release 时一条命令落地。
于是"拖到一半按 Esc 退不回原处、坐标被截断成一位小数"没有发生的余地。

整组位移还有一条老画布的血债要继承：**位移的对象是模型层名册，不是画布上看得见
的那些**。被位面/时段/过场过滤藏起来的成员**同样要动**，否则留下"半份移动"的
坏数据，而画布照新位置画、肉眼看不出来。
"""
from __future__ import annotations

import math

from PySide6.QtCore import QPointF, Qt

from .changes import EntityProperty, EntityRef
from .commands import _MISSING, build_change_fields_command
from .tools import AbstractTool

__all__ = ["TransformTool", "GroupMoveTool", "group_member_refs", "translate_group"]

#: 缩放的合法区间。与老画布一致，防止缩成 0 或天文数字。
SCALE_MIN = 0.05
SCALE_MAX = 20.0


class TransformTool(AbstractTool):
    """选中单个实体后拖动手柄做等比缩放 / 旋转。

    手柄的**屏幕半径恒定**（由 renderer 换算），所以缩小视图后仍然抓得住 ——
    老画布的手柄环半径是世界单位，与顶点手柄同一个毛病。
    """

    tool_id = "transform"
    display_name = "缩放旋转"
    status_hint = "拖动圆手柄旋转、方手柄等比缩放；Esc 取消"

    #: 手柄环到锚点的屏幕像素距离
    RING_PX = 70.0

    def __init__(self, document, renderer, view=None, parent=None) -> None:
        super().__init__(document, renderer, parent)
        self._view = view
        self._ref: EntityRef | None = None
        self._mode = ""          # "scale" | "rotate"
        self._start_scale = 1.0
        self._start_rot = 0.0
        self._press_angle = 0.0
        self._press_dist = 1.0
        self._preview = (1.0, 0.0)

    @property
    def preview(self) -> tuple[float, float]:
        """(scale, rotation) 的手势中预览值。数据里**没有**这个值。"""
        return self._preview

    def _anchor(self, ref: EntityRef) -> QPointF | None:
        ent = self._doc.entity(ref)
        if not isinstance(ent, dict) or "x" not in ent:
            return None
        return QPointF(float(ent["x"]), float(ent["y"]))

    def _ring_world(self) -> float:
        return self._renderer.px_to_world(self.RING_PX)

    def handle_positions(self, ref: EntityRef) -> dict[str, QPointF]:
        """两个手柄的世界坐标。视图照它画，工具照它判命中 —— **同一个函数**，
        免得"看着在这、点着在那"。"""
        anchor = self._anchor(ref)
        if anchor is None:
            return {}
        ent = self._doc.entity(ref) or {}
        rot = math.radians(float(ent.get("rotation", 0) or 0))
        r = self._ring_world()
        return {
            "rotate": QPointF(anchor.x() + r * math.cos(rot),
                              anchor.y() + r * math.sin(rot)),
            "scale": QPointF(anchor.x() - r * math.sin(rot),
                             anchor.y() + r * math.cos(rot)),
        }

    def mouse_pressed(self, scene_pos, button, modifiers) -> bool:
        if button != Qt.MouseButton.LeftButton or len(self._doc.selection) != 1:
            return False
        ref = self._doc.selection[0]
        anchor = self._anchor(ref)
        if anchor is None:
            return False
        grab = self._renderer.px_to_world(14.0)
        for mode, pos in self.handle_positions(ref).items():
            if (pos - scene_pos).manhattanLength() <= grab * 2:
                ent = self._doc.entity(ref) or {}
                self._ref = ref
                self._mode = mode
                self._start_scale = float(ent.get("scale", 1.0) or 1.0)
                self._start_rot = float(ent.get("rotation", 0.0) or 0.0)
                d = scene_pos - anchor
                self._press_angle = math.degrees(math.atan2(d.y(), d.x()))
                self._press_dist = max(1e-6, math.hypot(d.x(), d.y()))
                self._preview = (self._start_scale, self._start_rot)
                return True
        return False

    def mouse_moved(self, scene_pos, buttons, modifiers) -> bool:
        if self._ref is None or not (buttons & Qt.MouseButton.LeftButton):
            return False
        anchor = self._anchor(self._ref)
        if anchor is None:
            return False
        d = scene_pos - anchor
        if self._mode == "rotate":
            ang = math.degrees(math.atan2(d.y(), d.x()))
            rot = (self._start_rot + (ang - self._press_angle)) % 360.0
            if modifiers & Qt.KeyboardModifier.ShiftModifier:
                rot = round(rot / 15.0) * 15.0      # Shift 吸附 15°
            self._preview = (self._start_scale, rot)
        else:
            dist = max(1e-6, math.hypot(d.x(), d.y()))
            s = self._start_scale * (dist / self._press_dist)
            self._preview = (min(SCALE_MAX, max(SCALE_MIN, s)), self._start_rot)
        return True

    def mouse_released(self, scene_pos, button, modifiers) -> bool:
        if self._ref is None:
            return False
        ref = self._ref
        scale, rot = self._preview
        self._reset()
        # **缺省值写成"删键"**：本仓约定缺省不落键，写 `scale: 1` / `rotation: 0`
        # 会污染 JSON，黄金往返立刻红。
        vals = {
            "scale": _MISSING if abs(scale - 1.0) < 1e-9 else round(scale, 4),
            "rotation": (_MISSING if abs(rot % 360.0) < 1e-9
                         else round(rot % 360.0, 3)),
        }
        self._doc.push(build_change_fields_command(
            self._doc, [ref], [vals], EntityProperty.TRANSFORM, "缩放/旋转"))
        return True

    def cancel_gesture(self) -> bool:
        if self._ref is None:
            return False
        self._reset()
        return True

    def _reset(self) -> None:
        self._ref = None
        self._mode = ""
        self._preview = (1.0, 0.0)


# ---------------------------------------------------------------------------
# 整组位移
# ---------------------------------------------------------------------------

def group_member_refs(document, gid: str) -> list[EntityRef]:
    """某分组的**全部**成员 —— 从模型层名册取，不是从画布上看得见的图元取。

    这是老画布的血债：被位面/时段/过场藏起来的成员**同样是成员**，
    漏掉它们就是"半份移动"的坏数据，而画布照新位置画、肉眼看不出来。
    """
    sc = document.scene() or {}
    out: list[EntityRef] = []
    for kind, key in (("hotspot", "hotspots"), ("npc", "npcs"), ("zone", "zones")):
        for ent in sc.get(key) or []:
            if isinstance(ent, dict) and str(ent.get("group", "")) == str(gid):
                out.append(EntityRef(kind, str(ent.get("id", ""))))
    return out


def translate_group(document, gid: str, dx: float, dy: float,
                    *, mergeable: bool = False, label: str = "整组位移") -> bool:
    """把 (dx, dy) 烘进该组每个成员自己的坐标。**一条命令**。

    逐类规则（与运行时 moveGroupBy 的作者态对应物一致）：
    - 有 x/y 的实体：平移 x/y；NPC 连巡逻路点一起；
    - Zone：平移 polygon 全部顶点；
    - **碰撞面不动** —— 加载期迁移保证它一定是局部坐标，挂在锚点上自动跟随；
      再平移一次就是"碰撞面漂两倍"。
    """
    refs = group_member_refs(document, gid)
    if not refs or (dx == 0 and dy == 0):
        return False
    values: list[dict] = []
    kept: list[EntityRef] = []
    for ref in refs:
        ent = document.entity(ref)
        if not isinstance(ent, dict):
            continue
        vals: dict = {}
        if "x" in ent and "y" in ent:
            vals["x"] = _shift(ent["x"], dx)
            vals["y"] = _shift(ent["y"], dy)
        poly = ent.get("polygon")
        if isinstance(poly, list) and len(poly) >= 3:
            vals["polygon"] = [{"x": _shift(p.get("x", 0), dx),
                                "y": _shift(p.get("y", 0), dy)}
                               for p in poly if isinstance(p, dict)]
        patrol = ent.get("patrol")
        if isinstance(patrol, dict) and isinstance(patrol.get("route"), list):
            new_patrol = dict(patrol)
            new_patrol["route"] = [{"x": _shift(p.get("x", 0), dx),
                                    "y": _shift(p.get("y", 0), dy)}
                                   for p in patrol["route"] if isinstance(p, dict)]
            vals["patrol"] = new_patrol
        if vals:
            kept.append(ref)
            values.append(vals)
    if not kept:
        return False
    return document.push(build_change_fields_command(
        document, kept, values, EntityProperty.POSITION | EntityProperty.GEOMETRY,
        label, mergeable=mergeable))


def _shift(value, delta: float):
    """平移一个坐标，**保留原始数值表示**（int 仍是 int）。

    不保留的话，方向键微移一次就把整份场景的整数坐标漂成小数 ——
    黄金往返会红，而且 diff 里满屏都是 `.0`。
    """
    try:
        v = float(value)
    except (TypeError, ValueError):
        return value
    out = v + float(delta)
    if isinstance(value, int) and float(out).is_integer():
        return int(out)
    return round(out, 1)


class GroupMoveTool(AbstractTool):
    """拖动分组框整体位移。手势期间只记偏移，release 一条命令。"""

    tool_id = "group_move"
    display_name = "整组位移"
    status_hint = "拖动分组框整体位移；方向键微移；Esc 取消"

    def __init__(self, document, renderer, view=None, parent=None) -> None:
        super().__init__(document, renderer, parent)
        self._view = view
        self._gid = ""
        self._origin: QPointF | None = None
        self._offset = (0.0, 0.0)

    @property
    def offset(self) -> tuple[float, float]:
        return self._offset

    def begin(self, gid: str, scene_pos: QPointF) -> bool:
        if not group_member_refs(self._doc, gid):
            return False
        self._gid = str(gid)
        self._origin = QPointF(scene_pos)
        self._offset = (0.0, 0.0)
        return True

    def mouse_moved(self, scene_pos, buttons, modifiers) -> bool:
        if self._origin is None or not (buttons & Qt.MouseButton.LeftButton):
            return False
        self._offset = (scene_pos.x() - self._origin.x(),
                        scene_pos.y() - self._origin.y())
        return True

    def mouse_released(self, scene_pos, button, modifiers) -> bool:
        if self._origin is None:
            return False
        gid = self._gid
        dx, dy = self._offset
        self._reset()
        translate_group(self._doc, gid, round(dx, 1), round(dy, 1))
        return True

    def nudge(self, gid: str, dx: float, dy: float, *, mergeable: bool) -> bool:
        """方向键微移。连续按住由**命令合并**收成一条撤销记录 ——
        老画布为此糊了一个 400ms idle 定时器。"""
        return translate_group(self._doc, gid, dx, dy,
                               mergeable=mergeable, label="整组微移")

    def cancel_gesture(self) -> bool:
        if self._origin is None:
            return False
        self._reset()
        return True

    def _reset(self) -> None:
        self._gid = ""
        self._origin = None
        self._offset = (0.0, 0.0)
