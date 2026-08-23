"""画布图元 —— **被动的**，不吃鼠标。

镜像 Tiled：图元只负责画，输入一律由当前工具（`tools.AbstractTool`）处理。
这一条看着像洁癖，实际堵掉老画布两类顽疾：

## 一、覆盖物抢走点击

老画布里每个图元自己吃鼠标，于是"谁拿到这一下"取决于 Qt 按 z 的命中派发。
后果是叠放循环点选临时抬 z 时，被抬起来的多边形会把本该属于 gizmo 旋转手柄的
按下吃掉（本轮亲手踩过一次）。

图元全部 ``NoButton`` 之后，命中由工具在一处**白名单**里决定：
"只有 `EntityItem` 且 `isEnabled()` 才算"。以后再加任何新覆盖物，
**默认就不污染命中**，不需要记得去改命中代码。

## 二、z 兼职承载命中语义

z 本来只该表示"画在哪一层"。老画布拿它当"这一下该派给谁"，于是两个正交的需求
挤在一个数值上，改一个必然碰坏另一个。图元不吃鼠标之后，z 回归纯显示属性。

## 内容层与装饰层

沿用已经验证过的分层（`scene_editor` 里那套常量与 `entity_sort_math` 规则）：
内容（热点展示图、NPC 精灵）按运行时排序规则派 z，装饰（把手、覆盖物）固定区间。
"""
from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtWidgets import QGraphicsItem, QGraphicsObject

from .changes import EntityRef

__all__ = [
    "Z_CONTENT_LO",
    "Z_CONTENT_HI",
    "Z_DECOR_BASE",
    "Z_OVERLAY",
    "CanvasItem",
    "EntityItem",
    "OverlayItem",
]

#: 内容层区间（按运行时排序规则派名次）。与老画布同口径，便于对照。
Z_CONTENT_LO = -100_000.0
Z_CONTENT_HI = 100_000.0
#: 装饰层起点：把手、辅助线等，恒在内容之上。
Z_DECOR_BASE = 300_000.0
#: 覆盖物（选中框、gizmo、工具预览）：恒在装饰之上。
Z_OVERLAY = 900_000.0


class CanvasItem(QGraphicsObject):
    """本画布所有图元的基类：**不吃鼠标**，接受 hover（供工具做悬停提示）。

    子类只实现 ``boundingRect()`` / ``paint()``。命中判定不在这里 ——
    在工具里，按 :meth:`EntityItem.pick_shape` 之类的显式接口做。
    """

    def __init__(self, parent: QGraphicsItem | None = None) -> None:
        super().__init__(parent)
        # **核心约束**：图元不参与 Qt 的鼠标派发，输入全部归当前工具。
        self.setAcceptedMouseButtons(Qt.MouseButton.NoButton)
        self.setAcceptHoverEvents(False)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, False)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, False)
        self._base_pos = (0.0, 0.0)
        self._preview_offset = (0.0, 0.0)

    # ---- 手势预览位移 ------------------------------------------------------
    #
    # 拖动期间画面要跟着手走，但**数据一个字节都不能改**（这是本架构最硬的一条：
    # 手势不写数据，松手才由命令落地）。于是预览必须走一条与数据同步互不干扰的
    # 通道：位置拆成"数据位"+"预览位移"两半，`_sync_*` 只写前者，手势只写后者，
    # 谁都不会把对方的结果抹掉。
    #
    # 直接 `setPos(数据位 + 位移)` 的话，手势中任何一次同步（别的实体变更、
    # 视图轴刷新）都会把预览冲掉；反过来若同步读回带位移的 pos，预览就会被
    # **当成真实几何**烘进数据 —— 那正是老画布"拖到一半点别处，实体永久跑偏"的成因。

    def set_base_pos(self, x: float, y: float) -> None:
        """设置**数据位**。`_sync_*` 走这里，不直接 `setPos`。"""
        self._base_pos = (float(x), float(y))
        self._apply_pos()

    def set_preview_offset(self, dx: float, dy: float) -> None:
        """设置**手势预览位移**。只影响画面。"""
        off = (float(dx), float(dy))
        if off == self._preview_offset:
            return
        self._preview_offset = off
        self._apply_pos()

    @property
    def preview_offset(self) -> tuple[float, float]:
        return self._preview_offset

    def _apply_pos(self) -> None:
        self.setPos(self._base_pos[0] + self._preview_offset[0],
                    self._base_pos[1] + self._preview_offset[1])

    def boundingRect(self) -> QRectF:  # pragma: no cover - 抽象
        raise NotImplementedError

    def paint(self, painter, option, widget=None) -> None:  # pragma: no cover - 抽象
        raise NotImplementedError

    # ---- 选中/悬停：基类给空实现，让视图可以无差别地刷全部图元 --------------
    #
    # 缺省空实现而不是让调用方 hasattr：内容图元（贴图、精灵）本来就不该显示选中态
    # （选中是编辑器概念，不是画面内容），但视图不该为此记得区分。用 hasattr 兜
    # 是那种"脆弱的隐式契约"——加一种新图元忘了实现就静默不刷。

    def set_selected(self, on: bool) -> None:
        """缺省不表现选中态。装饰类图元覆盖它。"""

    def set_hovered(self, on: bool) -> None:
        """缺省不表现悬停态。"""


class EntityItem(CanvasItem):
    """代表一个场景实体的图元。命中白名单只认它。

    一个实体在画布上可能有**一束**图元（把手 + 展示图 + 碰撞面 + …），
    子图元账本沿用 `scene_canvas_model.PART_TABLE` —— 那张表已经把
    "这一族有哪些图元"收成唯一真相，新画布直接继承，不再另立一份。
    """

    def __init__(self, ref: EntityRef, parent: QGraphicsItem | None = None) -> None:
        super().__init__(parent)
        self._ref = ref
        self.setZValue(Z_DECOR_BASE)

    @property
    def ref(self) -> EntityRef:
        return self._ref

    @property
    def entity_kind(self) -> str:
        return self._ref.kind

    @property
    def entity_id(self) -> str:
        return self._ref.id

    def pick_rect(self) -> QRectF:
        """命中用的包围盒（世界坐标）。缺省即 ``boundingRect()``。

        与 ``boundingRect()`` 分开是为了让"太小点不中"有一个专门的钩子 ——
        工具会用 `SceneRenderer.inflate_for_picking` 把它撑到最小命中尺寸。
        """
        return self.boundingRect()

    def pick_contains(self, pos: QPointF, tol: float = 0.0) -> bool:
        """落点是否命中本图元。缺省按放宽 `tol` 的 `pick_rect()` 判定。

        之所以要这个钩子而不是让工具一律拿包围盒比：**包围盒对斜边/凹形几何的
        误差是压倒性的**。一个直角三角形 Zone 的 AABB 有一半面积在形外，于是
        点空白处也选中它；更糟的是它把叠在同一片区域里的小实体一并压过去
        （装饰层 z 全等，谁先谁后本来就没保证），点谁都选中那个 Zone。
        折线更甚 —— 巡逻路线的 AABB 是整条路线的外框。
        """
        return self.pick_rect().adjusted(-tol, -tol, tol, tol).contains(pos)


class OverlayItem(CanvasItem):
    """编辑器覆盖物（选中框、手柄、工具预览）。恒在最上，且**永不进命中白名单**。

    Tiled 的 `ObjectSelectionItem` 同位。分成独立基类不是分类癖：
    工具的命中循环只认 `EntityItem`，覆盖物因此**结构上**不可能抢走点击。
    """

    def __init__(self, parent: QGraphicsItem | None = None) -> None:
        super().__init__(parent)
        self.setZValue(Z_OVERLAY)
