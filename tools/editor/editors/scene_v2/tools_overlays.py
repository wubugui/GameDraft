"""覆盖物的工具：透视深度轴、分组框。

两者的命中都由**工具用显式几何判定**（问 overlay 的 `hit_*`），不靠 Qt 按 z 派发。
所以"组框把实体的点击吞掉""轴线横贯全场挡住一切"这两类问题没有发生的余地。
"""
from __future__ import annotations

import copy

from PySide6.QtCore import QPointF, QRectF, Qt

from .changes import EntityProperty, EntityRef
from .commands import _MISSING, build_change_fields_command
from .tools import _NUDGE_DIR, AbstractTool
from .tools_transform import group_member_refs, translate_group

__all__ = ["PerspectiveAxisTool", "GroupBoxTool", "group_bounds"]


class PerspectiveAxisTool(AbstractTool):
    """拖动 near / far 端点改透视深度轴。

    透视系数进实体的脚底缩放，所以改完必须让内容重排 —— 页面订阅变更事件即可，
    这里不自己去碰 z。
    """

    tool_id = "persp_axis"
    display_name = "透视轴"
    status_hint = "拖动近端 / 远端手柄调整透视深度轴"

    def __init__(self, document, renderer, item=None, parent=None) -> None:
        super().__init__(document, renderer, parent)
        self._item = item
        self._which = ""
        self._start: dict | None = None

    def set_item(self, item) -> None:
        self._item = item

    def _cfg(self) -> dict | None:
        sc = self._doc.scene()
        cfg = sc.get("perspectiveScale") if isinstance(sc, dict) else None
        return cfg if isinstance(cfg, dict) else None

    def mouse_pressed(self, scene_pos, button, modifiers) -> bool:
        if button != Qt.MouseButton.LeftButton or self._item is None:
            return False
        if self._cfg() is None:
            # **没配过透视的场景要能就地起一条轴。** 否则新画布在这个功能上是
            # 只读的一半：只能改已有轴的端点，不能给新场景加近大远小 ——
            # 策划必须切回老画布（或手改 JSON）。
            # 种一条竖直轴：近端在下（scale 1.0）、远端在上（0.6），与老画布
            # `_on_persp_widgets_changed` 自动 seed 的形状一致。
            return self._seed_axis(scene_pos)
        which = self._item.hit_endpoint(scene_pos)
        if which is None:
            return False
        cfg = self._cfg()
        if cfg is None:
            return False
        self._which = which
        self._start = copy.deepcopy(cfg)
        return True

    def _seed_axis(self, scene_pos) -> bool:
        sc = self._doc.scene() or {}
        try:
            h = float(sc.get("worldHeight", 0) or 0)
        except (TypeError, ValueError):
            h = 0.0
        h = h if h > 0 else 600.0
        x = float(scene_pos.x())
        cfg = {"near": {"x": x, "y": h * 0.9, "scale": 1.0},
               "far": {"x": x, "y": h * 0.2, "scale": 0.6}}
        ok = self._doc.push(build_change_fields_command(
            self._doc, [EntityRef("scene", self._doc.scene_id)],
            [{"perspectiveScale": cfg}], EntityProperty.TRANSFORM, "启用透视缩放"))
        if ok:
            self._doc.notify("已在此处种下一条透视深度轴，拖两端调整")
        return ok

    def mouse_moved(self, scene_pos, buttons, modifiers) -> bool:
        if not self._which or not (buttons & Qt.MouseButton.LeftButton):
            return False
        # 预览：只动 overlay，不写数据
        if self._item is not None:
            near = self._item.near
            far = self._item.far
            if self._which == "near":
                near = QPointF(scene_pos)
            else:
                far = QPointF(scene_pos)
            self._item.set_axis(near, far)
        return True

    def mouse_released(self, scene_pos, button, modifiers) -> bool:
        if not self._which or self._start is None:
            return False
        which, start = self._which, self._start
        self._which = ""
        self._start = None
        cfg = copy.deepcopy(start)
        end = cfg.setdefault(which, {})
        end["x"] = round(scene_pos.x(), 1)
        end["y"] = round(scene_pos.y(), 1)
        # 透视配置挂在**场景**上，不是实体上 —— 用 scene ref 走同一套命令机制
        self._doc.push(build_change_fields_command(
            self._doc, [EntityRef("scene", self._doc.scene_id)],
            [{"perspectiveScale": cfg}], EntityProperty.TRANSFORM, "调整透视轴"))
        return True

    def _restore_overlay(self) -> None:
        """把 overlay 拨回**模型现值**。

        取消一次拖动后不拨回的话，画布上显示的深度轴与实际生效的对不上，
        用户会照着这根假轴继续摆实体 —— 数据没坏，但画面在骗人。
        """
        cfg = self._cfg()
        if self._item is None or not isinstance(cfg, dict):
            return
        near, far = cfg.get("near") or {}, cfg.get("far") or {}
        try:
            self._item.set_axis(
                QPointF(float(near.get("x", 0)), float(near.get("y", 0))),
                QPointF(float(far.get("x", 0)), float(far.get("y", 0))))
        except (TypeError, ValueError):
            pass

    def cancel_gesture(self) -> bool:
        if not self._which:
            return False
        self._restore_overlay()
        self._which = ""
        self._start = None
        return True


#: 分组框相对成员最外沿再外扩多少世界单位。
#:
#: 不外扩的话框线正好压在最外侧成员的脚下：看起来"框没把成员框住"（用户以为
#: 选错了组），而且框边的命中带会把那几个成员的点击整个吃掉 —— 想点它们得先
#: 躲开框线。老画布是 Figma frame 式的"框 + 留白 + 名字"。
GROUP_BOX_PAD = 24.0


def group_bounds(document, gid: str) -> QRectF | None:
    """分组包围盒 —— 从**模型层名册**算，与整组位移同源。

    与画布上看得见的图元无关：被过滤藏起来的成员照样算进包围盒，
    否则框会随着切视图忽大忽小，而成员其实一个没少。

    单成员（甚至零尺寸）的组同样要出一个**看得见、点得中**的框：不外扩的话
    单点成员算出来是零尺寸矩形，`paint` 直接早退 —— 那个组在画布上既看不见
    也选不中，整组位移/微移全部够不到，用户会以为分组丢了。
    """
    all_pts: list[tuple[float, float]] = []
    for ref in group_member_refs(document, gid):
        ent = document.entity(ref)
        if not isinstance(ent, dict):
            continue
        if "x" in ent and "y" in ent:
            all_pts.append((float(ent["x"]), float(ent["y"])))
        poly = ent.get("polygon")
        if isinstance(poly, list):
            all_pts += [(float(p.get("x", 0)), float(p.get("y", 0)))
                        for p in poly if isinstance(p, dict)]
    if not all_pts:
        return None
    # **直接对全部点取 min/max**，不要用 QRectF.united 逐个并 ——
    # 点实体的矩形是零尺寸，Qt 把零尺寸矩形当 null，united 会把它整个丢掉，
    # 于是"一组点实体"的包围盒会塌成最后一个成员的位置。
    xs = [p[0] for p in all_pts]
    ys = [p[1] for p in all_pts]
    pad = GROUP_BOX_PAD
    return QRectF(min(xs) - pad, min(ys) - pad,
                  (max(xs) - min(xs)) + pad * 2, (max(ys) - min(ys)) + pad * 2)


class GroupBoxTool(AbstractTool):
    """点选组框、拖框整组位移、拖把手挪锚点。

    两段式：**没选中的组，边线按下只选中不拖**。否则用户想从那儿起手拉橡皮筋
    框选，实际把整组悄悄挪走了（老画布的血债之一）。
    """

    tool_id = "group_box"
    display_name = "分组"
    status_hint = "点组框边线选中；再拖动整组位移；方向键微移"

    def __init__(self, document, renderer, view=None, parent=None) -> None:
        super().__init__(document, renderer, parent)
        self._view = view
        self._boxes: dict[str, object] = {}
        self._selected_gid = ""
        self._drag_gid = ""
        #: 上一次整组微移作用的组（判断能不能并进同一条命令）
        self._nudge_gid = ""
        self._anchor_mode = False
        self._origin: QPointF | None = None
        self._offset = (0.0, 0.0)

    def set_boxes(self, boxes: dict) -> None:
        self._boxes = dict(boxes)

    @property
    def selected_gid(self) -> str:
        return self._selected_gid

    @property
    def offset(self) -> tuple[float, float]:
        return self._offset

    def select_group(self, gid: str) -> None:
        """选中一个分组框。

        **同时把文档选择切到这个组** —— 属性面板据此切到分组页。不切的话组的
        id / label / 整组显影条件 / 成员列表在新画布上一个入口都没有，
        分组只剩"整体拖动"一个能力。
        """
        self._selected_gid = str(gid or "")
        for g, box in self._boxes.items():
            box.set_selected(g == self._selected_gid)
        if self._selected_gid:
            self._doc.set_selection([EntityRef("group", self._selected_gid)])

    def _box_at(self, pos: QPointF):
        for gid, box in self._boxes.items():
            if box.hit_handle(pos) or box.hit_edge(pos):
                return gid, box
        return None, None

    def mouse_pressed(self, scene_pos, button, modifiers) -> bool:
        if button != Qt.MouseButton.LeftButton:
            return False
        gid, box = self._box_at(scene_pos)
        if gid is None:
            # **点空白要熄灯。** 组选中态粘滞的话，用户以为什么都没选，
            # 一按方向键（很多人用方向键的肌肉记忆）就把整组坐标改了并标脏，
            # 而撤销记录写的是"整组微移"，与操作意图对不上。
            if self._selected_gid:
                self.select_group("")
                self._nudge_gid = ""
            return False
        if gid != self._selected_gid:
            # 第一段：只选中，不拖
            self.select_group(gid)
            return True
        self._drag_gid = gid
        self._origin = QPointF(scene_pos)
        self._offset = (0.0, 0.0)
        # **Alt + 拖把手 = 挪把手**（`editor.anchor`），不是挪整组。
        # 派生位置压住成员时这是唯一的救济手段。
        self._anchor_mode = bool(
            modifiers & Qt.KeyboardModifier.AltModifier) and box.hit_handle(scene_pos)
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
        gid = self._drag_gid
        dx, dy = self._offset
        anchor_mode = self._anchor_mode
        self._drag_gid = ""
        self._origin = None
        self._offset = (0.0, 0.0)
        self._anchor_mode = False
        if anchor_mode:
            return self.set_group_anchor(gid, scene_pos)
        translate_group(self._doc, gid, round(dx, 1), round(dy, 1))
        return True

    def set_group_anchor(self, gid: str, pos: QPointF | None) -> bool:
        """把手位置写进 `editor.anchor`；`pos` 为 None = 重置回派生位置。"""
        ref = EntityRef("group", str(gid))
        ent = self._doc.model_entity(ref)
        if not isinstance(ent, dict):
            return False
        editor = dict(ent.get("editor") or {})
        if pos is None:
            editor.pop("anchor", None)
        else:
            editor["anchor"] = {"x": round(float(pos.x()), 1),
                                "y": round(float(pos.y()), 1)}
        value = editor if editor else _MISSING
        return self._doc.push(build_change_fields_command(
            self._doc, [ref], [{"editor": value}],
            EntityProperty.GROUPING,
            "重置分组把手" if pos is None else "挪动分组把手"))

    @property
    def drag_offset(self) -> tuple[float, float]:
        """与 `MoveTool` 同名同义，接进视图那一条统一预览通道。"""
        return self._offset

    @property
    def dragging_refs(self) -> tuple:
        """拖动中的组成员。取**模型层名册** —— 与真正落地的 `translate_group`
        同一份名单，预览才不会与结果不一致（被过滤藏起来的成员也在内）。"""
        if self._origin is None or not self._drag_gid:
            return ()
        return tuple(group_member_refs(self._doc, self._drag_gid))

    def key_pressed(self, key, modifiers) -> bool:
        """选中了组时，方向键微移**整组**；没选组就交回基类按实体选择微移。

        此前 `nudge` 一个调用点都没有 —— 状态栏写着"方向键微移"，按了没反应。
        """
        if self._selected_gid and key in _NUDGE_DIR:
            dx, dy = _NUDGE_DIR[key]
            step = (self.NUDGE_STEP_FAST
                    if modifiers & Qt.KeyboardModifier.ShiftModifier
                    else self.NUDGE_STEP)
            return self.nudge(dx * step, dy * step,
                              mergeable=(self._nudge_gid == self._selected_gid))
        return super().key_pressed(key, modifiers)

    def nudge(self, dx: float, dy: float, *, mergeable: bool) -> bool:
        if not self._selected_gid:
            return False
        self._nudge_gid = self._selected_gid
        return translate_group(self._doc, self._selected_gid, dx, dy,
                               mergeable=mergeable, label="整组微移")

    def cancel_gesture(self) -> bool:
        if self._origin is None:
            return False
        self._drag_gid = ""
        self._origin = None
        self._offset = (0.0, 0.0)
        return True


class LightPlaceTool(AbstractTool):
    """「在画布上定位选中的灯」模式：点一下，把灯落到该处地面。

    灯位是 3D 伪世界坐标（x/y/z），**属性面板里根本没有 x/y 输入框** ——
    `pos` 只能靠"画布点一下取地面深度"得到。所以这条链路断掉的后果不是"少一个
    便利功能"：新加的灯永远停在场景中心的缺省位置，作者没有任何办法把它挪到
    想要的地方。

    落点的计算（取地面深度、按当前高度抬起、没有深度图时给提示）全在面板的
    `place_selected_light_at` 里，本工具只负责把画布点击转过去。
    """

    tool_id = "light_place"
    display_name = "定位灯"
    status_hint = "点击画布把选中的灯落到该处地面"

    def __init__(self, document, renderer, panel=None, parent=None) -> None:
        super().__init__(document, renderer, parent)
        self._panel = panel
        self.active_mode = False

    def set_mode(self, on: bool) -> None:
        self.active_mode = bool(on)

    def mouse_pressed(self, scene_pos, button, modifiers) -> bool:
        if not self.active_mode or button != Qt.MouseButton.LeftButton:
            return False
        place = getattr(self._panel, "place_selected_light_at", None)
        if not callable(place):
            return False
        return bool(place(float(scene_pos.x()), float(scene_pos.y())))

    def mouse_moved(self, scene_pos, buttons, modifiers) -> bool:
        return False

    def mouse_released(self, scene_pos, button, modifiers) -> bool:
        return bool(self.active_mode)
