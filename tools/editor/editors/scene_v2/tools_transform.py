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

__all__ = ["TransformTool", "GroupMoveTool", "group_member_refs",
           "translate_entities", "translate_group"]

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

    #: 参与实例变换的实体族。**出生点不在内** —— 它是只有 x/y 的结构件，
    #: 运行时根本不读 scale/rotation；给它写这两个键只会在 JSON 里长期躺着，
    #: 而老画布打开同一场景时既不显示也不可编辑，只能手改文本删掉。
    TRANSFORMABLE_KINDS = ("hotspot", "npc")

    def _anchor(self, ref: EntityRef) -> QPointF | None:
        if ref.kind not in self.TRANSFORMABLE_KINDS:
            return None
        ent = self._doc.entity(ref)
        if not isinstance(ent, dict) or "x" not in ent:
            return None
        return QPointF(float(ent["x"]), float(ent["y"]))

    def _ring_world(self) -> float:
        return self._renderer.px_to_world(self.RING_PX)

    def handle_positions(self, ref: EntityRef,
                         rotation: float | None = None) -> dict[str, QPointF]:
        """两个手柄的世界坐标。视图照它画，工具照它判命中 —— **同一个函数**，
        免得"看着在这、点着在那"。

        `rotation` 显式给值时用它（手势中用预览角度画，手柄才会跟着手转）。
        """
        anchor = self._anchor(ref)
        if anchor is None:
            return {}
        ent = self._doc.entity(ref) or {}
        rot = math.radians(float(ent.get("rotation", 0) or 0)
                           if rotation is None else float(rotation))
        r = self._ring_world()
        return {
            "rotate": QPointF(anchor.x() + r * math.cos(rot),
                              anchor.y() + r * math.sin(rot)),
            "scale": QPointF(anchor.x() - r * math.sin(rot),
                             anchor.y() + r * math.cos(rot)),
        }

    def gizmo_positions(self) -> dict[str, QPointF]:
        """供视图画 gizmo：锚点 + 两个手柄。**手势中按预览角度算**，
        否则转动时手柄纹丝不动，用户没有任何"转到哪了"的反馈。

        手柄位置与命中判定同源（都走 `handle_positions`）。
        """
        sel = self._doc.selection
        ref = self._ref if self._ref is not None else (sel[0] if len(sel) == 1 else None)
        if ref is None:
            return {}
        anchor = self._anchor(ref)
        if anchor is None:
            return {}
        rot = self._preview[1] if self._ref is not None else None
        out: dict[str, QPointF] = {"anchor": anchor}
        out.update(self.handle_positions(ref, rot))
        return out

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
        mode = self._mode
        scale, rot = self._preview
        start_scale, start_rot = self._start_scale, self._start_rot
        self._reset()
        # **没动过就一个字节都不写。** 手柄上按一下不拖就松手是很常见的误触
        # （尤其在手柄叠着实体时），无条件写会把场景标脏、JSON 数值被静默改写、
        # 撤销栈平白多一格 —— 批量点检一遍场景就能污染一片实体。
        if abs(scale - start_scale) < 1e-9 and abs(rot - start_rot) < 1e-9:
            return True
        # **只写本次手势真正动过的那一维。** 旋转手柄不该顺手重写 scale
        # （整数缩放会漂成小数、精度被 round(…,4) 截断），缩放手柄也不该把
        # 作者填的 `-30` 单方面归一化成 `330`。
        vals: dict = {}
        if mode == "scale" or abs(scale - start_scale) >= 1e-9:
            # **缺省值写成"删键"**：本仓约定缺省不落键，写 `scale: 1` 会污染 JSON。
            vals["scale"] = (_MISSING if abs(scale - 1.0) < 1e-9
                             else round(scale, 4))
        if mode == "rotate" or abs(rot - start_rot) >= 1e-9:
            vals["rotation"] = (_MISSING if abs(rot % 360.0) < 1e-9
                                else round(rot % 360.0, 3))
        if not vals:
            return True
        self._doc.push(build_change_fields_command(
            self._doc, [ref], [vals], EntityProperty.TRANSFORM, "缩放/旋转"))
        return True

    def cancel_gesture(self) -> bool:
        if self._ref is None:
            return False
        self._reset()
        return True

    @property
    def transform_preview(self):
        """手势中的 `(ref, scale, rotation)`；没在手势里返回 ``None``。

        视图照它临时改内容图元的几何 —— **数据一个字节都没动**，
        松手才由命令落地。
        """
        if self._ref is None:
            return None
        return (self._ref, self._preview[0], self._preview[1])

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
    return translate_entities(document, group_member_refs(document, gid), dx, dy,
                              mergeable=mergeable, label=label)


def translate_entities(document, refs, dx: float, dy: float,
                       *, mergeable: bool = False, label: str = "位移") -> bool:
    """把 (dx, dy) 烘进这些实体自己的坐标。**一条命令**。

    整组位移与方向键微移共用它 —— 两处各写一遍的话，"Zone 要平移 polygon"
    "碰撞面不能再平移一次"这些规则就得维护两份，迟早分叉。
    """
    refs = list(refs)
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
    """平移一个坐标，**保留原始数值表示**。

    两条都要守住，缺一条都会污染整份场景：

    1. **零位移即原值返回。** 整组位移对每个成员的 x 与 y **无条件同时**写入，
       纯水平拖动时 dy 恒为 0；若这一支仍走 `round(out, 1)`，那么全组成员的
       y 会被静默截断（218.02 → 218.0）。真实场景里 445 个坐标是 float，
       一次水平拖动就能改脏一大片与本次手势毫无关系的数值。
    2. **int 仍是 int。** 否则方向键微移一次就把整数坐标漂成小数，黄金往返会红。
    """
    try:
        v = float(value)
    except (TypeError, ValueError):
        return value
    d = float(delta)
    if d == 0.0:
        return value          # 见 docstring 第 1 条：这一维没动，就一个字节都别碰
    out = v + d
    if isinstance(value, int) and float(out).is_integer():
        return int(out)
    # **保留原值与位移里更精细的那个小数位**，不要一律截到 1 位。
    # 截断会把 1308.14 静默抹成 1308.1：画面上看不出来，数据却被改了，
    # 而且存盘之后撤销也救不回来。老画布 `_shift_point_dict` 用的就是这个口径。
    return round(out, max(1, _decimals_of(v), _decimals_of(d)))


def _decimals_of(value: float, limit: int = 6) -> int:
    """一个数写成十进制时的小数位数（上限 `limit`，防浮点尾巴炸开）。"""
    text = repr(float(value))
    if "e" in text or "E" in text:
        return limit
    frac = text.split(".", 1)[1] if "." in text else ""
    frac = frac.rstrip("0")
    return min(len(frac), limit)


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

    @property
    def drag_offset(self) -> tuple[float, float]:
        """与 `MoveTool` 同名同义 —— 视图只认这一条预览通道，不为每个工具
        写一个分支（老画布的预览就是每个手势各写一套，于是各有各的漏画）。"""
        return self._offset

    @property
    def dragging_refs(self) -> tuple[EntityRef, ...]:
        """手势中要跟着走的成员。取**模型层名册**，被过滤藏起来的也在内 ——
        与真正落地的 `translate_group` 同一份名单，预览才不会与结果不一致。"""
        if self._origin is None or not self._gid:
            return ()
        return tuple(group_member_refs(self._doc, self._gid))

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
