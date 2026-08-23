"""内置工具：选择 / 移动 / 创建删除 / 多边形编辑。

全部遵守两条铁律（见 `tools.AbstractTool`）：**工具不写数据**（只构造命令）、
**命中走白名单**（只认 `EntityItem`）。

因此这里没有一处 "先把坐标写进 staging 再说"，也没有一处 `isinstance` 排除覆盖物。
"""
from __future__ import annotations

import copy

from PySide6.QtCore import QPointF, QRectF, Qt

from .changes import EntityProperty, EntityRef
from .commands import build_change_fields_command
from .entity_items import HandleItem
from .tools import AbstractTool

__all__ = ["SelectTool", "MoveTool", "PolygonEditTool", "pick_cycle"]


def pick_cycle(hits: list, current) -> object | None:
    """叠放循环点选：同一落点重复点击时在候选里轮转。

    老画布靠**临时抬高 z** 实现，于是显示属性兼职承载了命中语义 ——
    本轮亲手踩过它的代价（抬得太高把 gizmo 手柄的按下抢走了）。
    这里纯粹是列表轮转，**一个 z 都不动**。
    """
    if not hits:
        return None
    if current is None or current not in hits:
        return hits[0]
    return hits[(hits.index(current) + 1) % len(hits)]


class SelectTool(AbstractTool):
    """点选 / 加选 / 叠放循环 / 橡皮筋框选。"""

    tool_id = "select"
    display_name = "选择"
    status_hint = "点选实体；Shift 加选；同一处重复点击在重叠实体间轮转；拖拽空白处框选"

    def __init__(self, document, renderer, view=None, parent=None) -> None:
        super().__init__(document, renderer, parent)
        self._view = view
        self._band_origin: QPointF | None = None
        self._band_rect: QRectF | None = None
        self._last_pick_pos: tuple[float, float] | None = None

    # ---- 命中 --------------------------------------------------------------

    def _hits(self, pos: QPointF) -> list:
        if self._view is None:
            return []
        candidates = self._view.entity_items()
        under = [it for it in self.entities_at(pos, candidates)
                 if self._renderer.inflate_for_picking(it.pick_rect()).contains(pos)]
        return under

    def _same_spot(self, pos: QPointF) -> bool:
        """同一落点判定用**屏幕像素**容差，不是世界单位 —— 否则缩小视图后
        手抖几个世界单位就被当成"点了别处"，轮转失效。"""
        if self._last_pick_pos is None:
            return False
        tol = self._renderer.px_to_world(3.0)
        return (abs(pos.x() - self._last_pick_pos[0]) <= tol
                and abs(pos.y() - self._last_pick_pos[1]) <= tol)

    # ---- 手势 --------------------------------------------------------------

    def mouse_pressed(self, scene_pos, button, modifiers) -> bool:
        if button != Qt.MouseButton.LeftButton:
            return False
        hits = self._hits(scene_pos)
        if not hits:
            self._band_origin = QPointF(scene_pos)
            self._band_rect = None
            self._last_pick_pos = None
            if not (modifiers & Qt.KeyboardModifier.ShiftModifier):
                self._doc.clear_selection()
            return True

        current = None
        if self._same_spot(scene_pos):
            sel = self._doc.selection
            for it in hits:
                if it.ref in sel:
                    current = it
                    break
        chosen = pick_cycle(hits, current)
        self._last_pick_pos = (scene_pos.x(), scene_pos.y())
        if chosen is None:
            return True
        if modifiers & Qt.KeyboardModifier.ShiftModifier:
            sel = list(self._doc.selection)
            if chosen.ref in sel:
                sel.remove(chosen.ref)
            else:
                sel.append(chosen.ref)
            self._doc.set_selection(sel)
        else:
            self._doc.set_selection([chosen.ref])
        return True

    def mouse_moved(self, scene_pos, buttons, modifiers) -> bool:
        if self._band_origin is None or not (buttons & Qt.MouseButton.LeftButton):
            return False
        self._band_rect = QRectF(self._band_origin, scene_pos).normalized()
        return True

    def mouse_released(self, scene_pos, button, modifiers) -> bool:
        if self._band_origin is None:
            return False
        rect = self._band_rect
        self._band_origin = None
        self._band_rect = None
        if rect is None or self._view is None:
            return True
        picked = [it.ref for it in self._view.entity_items()
                  if it.isVisible() and rect.intersects(it.pick_rect())]
        if modifiers & Qt.KeyboardModifier.ShiftModifier:
            picked = list(self._doc.selection) + [r for r in picked
                                                  if r not in self._doc.selection]
        self._doc.set_selection(picked)
        return True

    def cancel_gesture(self) -> bool:
        if self._band_origin is None:
            return False
        self._band_origin = None
        self._band_rect = None
        return True

    @property
    def band_rect(self) -> QRectF | None:
        """供视图画橡皮筋。工具持有手势状态，视图只负责画。"""
        return self._band_rect


class MoveTool(AbstractTool):
    """拖动选中实体。**手势期间不写数据** —— 只记偏移，release 时一条命令落地。

    于是"拖到一半按 Esc 退不回原处"没有发生的余地（数据压根没被改过），
    也不需要老画布那三道零位移防伪脏闸（零位移时命令根本构造不出来）。
    """

    tool_id = "move"
    display_name = "移动"
    status_hint = "拖动选中的实体；Esc 取消本次拖动"

    def __init__(self, document, renderer, view=None, parent=None) -> None:
        super().__init__(document, renderer, parent)
        self._view = view
        self._origin: QPointF | None = None
        self._refs: tuple[EntityRef, ...] = ()
        self._start: dict[EntityRef, tuple[float, float]] = {}
        self._offset = (0.0, 0.0)

    @property
    def drag_offset(self) -> tuple[float, float]:
        """当前拖动偏移，供视图做预览。数据里**没有**这个偏移。"""
        return self._offset

    @property
    def dragging_refs(self) -> tuple[EntityRef, ...]:
        return self._refs

    def mouse_pressed(self, scene_pos, button, modifiers) -> bool:
        if button != Qt.MouseButton.LeftButton or not self._doc.selection:
            return False
        movable: dict[EntityRef, tuple[float, float]] = {}
        for ref in self._doc.selection:
            ent = self._doc.entity(ref)
            if isinstance(ent, dict) and "x" in ent and "y" in ent:
                movable[ref] = (float(ent["x"]), float(ent["y"]))
        if not movable:
            return False
        self._origin = QPointF(scene_pos)
        self._refs = tuple(movable)
        self._start = movable
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
        dx, dy = self._offset
        refs = self._refs
        self._origin = None
        self._refs = ()
        self._offset = (0.0, 0.0)
        if not refs:
            return True
        values = []
        for ref in refs:
            sx, sy = self._start[ref]
            values.append({"x": round(sx + dx, 1), "y": round(sy + dy, 1)})
        # 零位移时 build_* 返回 None → 不入栈、不标脏。**不需要额外的防伪脏闸。**
        self._doc.push(build_change_fields_command(
            self._doc, refs, values, EntityProperty.POSITION, "移动实体"))
        return True

    def cancel_gesture(self) -> bool:
        if self._origin is None:
            return False
        self._origin = None
        self._refs = ()
        self._offset = (0.0, 0.0)
        return True


class PolygonEditTool(AbstractTool):
    """多边形 / 折线的顶点编辑：拖顶点、**双击边线插点**、右键删顶点。

    双击插点在老画布里是**空头支票** —— 提示写了、代码没接，而画布的双击路径
    完全没有测试，所以长期没人发现。这里它是一等接口，且有交互级用例。
    """

    tool_id = "polygon"
    display_name = "编辑多边形"
    status_hint = "拖动顶点；双击边线插入顶点；右键顶点删除"

    #: 各 part 的点列住在实体的哪个字段里，以及是否闭合
    PART_FIELD = {
        "polygon": ("polygon", True),
        "collision": ("collisionPolygon", True),
        "patrol": (None, False),   # 住 patrol.route，取写另有出口
    }

    def __init__(self, document, renderer, view=None, parent=None) -> None:
        super().__init__(document, renderer, parent)
        self._view = view
        self._ref: EntityRef | None = None
        self._part = ""
        self._vertex: int | None = None
        self._start_pts: list[tuple[float, float]] = []
        self._preview: list[tuple[float, float]] | None = None

    # ---- 点列的取与写（局部/世界的差别只在这一处）--------------------------

    def _points_of(self, ref: EntityRef, part: str) -> list[tuple[float, float]]:
        item = self._view.item_for(ref, part) if self._view else None
        return item.points() if item is not None else []

    def _write_values(self, ref: EntityRef, part: str,
                      world_pts: list[tuple[float, float]]) -> dict:
        """世界点列 → 该 part 在实体上的字段值。

        碰撞面是**局部坐标**（加载期迁移保证），所以写回要减锚点；
        Zone 与巡逻路线是世界坐标，直接写。
        """
        ent = self._doc.entity(ref) or {}
        if part == "collision":
            x0 = float(ent.get("x", 0) or 0)
            y0 = float(ent.get("y", 0) or 0)
            return {"collisionPolygon": [
                {"x": round(x - x0, 1), "y": round(y - y0, 1)} for x, y in world_pts]}
        if part == "polygon":
            return {"polygon": [{"x": round(x, 1), "y": round(y, 1)}
                                for x, y in world_pts]}
        if part == "patrol":
            patrol = copy.deepcopy(ent.get("patrol")) or {}
            patrol["route"] = [{"x": round(x, 1), "y": round(y, 1)}
                               for x, y in world_pts]
            return {"patrol": patrol}
        if part == "lightcurve":
            # **每个控制点都驮着一份完整的 env 关键帧** —— 只写 x/y 会把它整份丢掉，
            # 而画面要下一次打光才看得出来，属于最难查的那种静默数据丢失。
            old = ent.get("lightEnvCurve")
            old = old if isinstance(old, list) else []
            out = []
            for i, (x, y) in enumerate(world_pts):
                src = old[i] if i < len(old) and isinstance(old[i], dict) else {}
                node = copy.deepcopy(src)
                node["x"] = round(x, 1)
                node["y"] = round(y, 1)
                if "env" not in node and old:
                    # 新插入的点：继承前一个点的 env，而不是留空
                    prev = old[min(i, len(old) - 1)]
                    if isinstance(prev, dict) and isinstance(prev.get("env"), dict):
                        node["env"] = copy.deepcopy(prev["env"])
                out.append(node)
            return {"lightEnvCurve": out}
        return {}

    def _target_parts(self):
        """可编辑的点列。**场景级的光曲线永远在列** —— 它不属于任何实体，
        所以不该要求"先选中某个实体"才能编辑。"""
        if self._view is not None:
            scene_ref = EntityRef("scene", self._doc.scene_id)
            if self._view.item_for(scene_ref, "lightcurve") is not None:
                yield scene_ref, "lightcurve"
        for ref in self._doc.selection:
            for part in ("polygon", "collision", "patrol"):
                if self._view and self._view.item_for(ref, part) is not None:
                    yield ref, part

    # ---- 手势 --------------------------------------------------------------

    def mouse_pressed(self, scene_pos, button, modifiers) -> bool:
        if button != Qt.MouseButton.LeftButton:
            return False
        for ref, part in self._target_parts():
            pts = self._points_of(ref, part)
            idx = self._renderer.vertex_hit_index(
                [QPointF(x, y) for x, y in pts], scene_pos)
            if idx is None:
                continue
            self._ref, self._part, self._vertex = ref, part, idx
            self._start_pts = list(pts)
            self._preview = list(pts)
            return True
        return False

    def mouse_moved(self, scene_pos, buttons, modifiers) -> bool:
        if self._vertex is None or not (buttons & Qt.MouseButton.LeftButton):
            return False
        pts = list(self._start_pts)
        pts[self._vertex] = (scene_pos.x(), scene_pos.y())
        self._preview = pts
        if self._view and self._ref is not None:
            item = self._view.item_for(self._ref, self._part)
            if item is not None:
                item.set_points([{"x": x, "y": y} for x, y in pts])
                item.set_active_vertex(self._vertex)
        return True

    def mouse_released(self, scene_pos, button, modifiers) -> bool:
        if self._vertex is None or self._ref is None:
            return False
        ref, part, pts = self._ref, self._part, list(self._preview or [])
        self._reset()
        if not pts:
            return True
        self._doc.push(build_change_fields_command(
            self._doc, [ref], [self._write_values(ref, part, pts)],
            EntityProperty.GEOMETRY, "拖动顶点"))
        return True

    def mouse_double_clicked(self, scene_pos, button, modifiers) -> bool:
        """双击边线插入顶点。**这条在老画布里是死的。**"""
        if button != Qt.MouseButton.LeftButton:
            return False
        for ref, part in self._target_parts():
            pts = self._points_of(ref, part)
            item = self._view.item_for(ref, part) if self._view else None
            closed = bool(getattr(item, "closed", True))
            edge = self._renderer.edge_hit_index(
                [QPointF(x, y) for x, y in pts], scene_pos, closed=closed)
            if edge is None:
                continue
            new_pts = list(pts)
            new_pts.insert(edge + 1, (scene_pos.x(), scene_pos.y()))
            self._doc.push(build_change_fields_command(
                self._doc, [ref], [self._write_values(ref, part, new_pts)],
                EntityProperty.GEOMETRY, "插入顶点"))
            return True
        return False

    def delete_vertex_at(self, scene_pos: QPointF) -> bool:
        """右键删顶点。少于最低点数时拒绝（多边形 3，折线 2）。"""
        for ref, part in self._target_parts():
            pts = self._points_of(ref, part)
            idx = self._renderer.vertex_hit_index(
                [QPointF(x, y) for x, y in pts], scene_pos)
            if idx is None:
                continue
            item = self._view.item_for(ref, part) if self._view else None
            minimum = 3 if bool(getattr(item, "closed", True)) else 2
            if len(pts) <= minimum:
                return False
            new_pts = [p for i, p in enumerate(pts) if i != idx]
            self._doc.push(build_change_fields_command(
                self._doc, [ref], [self._write_values(ref, part, new_pts)],
                EntityProperty.GEOMETRY, "删除顶点"))
            return True
        return False

    def cancel_gesture(self) -> bool:
        if self._vertex is None:
            return False
        ref, part, pts = self._ref, self._part, list(self._start_pts)
        self._reset()
        if self._view and ref is not None:
            item = self._view.item_for(ref, part)
            if item is not None:
                item.set_points([{"x": x, "y": y} for x, y in pts])
        return True

    def _reset(self) -> None:
        if self._view and self._ref is not None:
            item = self._view.item_for(self._ref, self._part)
            if item is not None:
                item.set_active_vertex(None)
        self._ref = None
        self._part = ""
        self._vertex = None
        self._start_pts = []
        self._preview = None
