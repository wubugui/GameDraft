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

from PySide6.QtCore import QRectF, Qt
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

    def boundingRect(self) -> QRectF:  # pragma: no cover - 抽象
        raise NotImplementedError

    def paint(self, painter, option, widget=None) -> None:  # pragma: no cover - 抽象
        raise NotImplementedError


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


class OverlayItem(CanvasItem):
    """编辑器覆盖物（选中框、手柄、工具预览）。恒在最上，且**永不进命中白名单**。

    Tiled 的 `ObjectSelectionItem` 同位。分成独立基类不是分类癖：
    工具的命中循环只认 `EntityItem`，覆盖物因此**结构上**不可能抢走点击。
    """

    def __init__(self, parent: QGraphicsItem | None = None) -> None:
        super().__init__(parent)
        self.setZValue(Z_OVERLAY)
