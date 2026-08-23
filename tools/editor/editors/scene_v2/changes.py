"""变更事件 —— Document 通知 View 的**唯一**语言。零 Qt，可脱离 QApplication 单测。

镜像 Tiled 的 `changeevents.h`。两条设计决定值得单独说明，因为它们各自堵掉一类
老画布的顽疾：

## 一、成对的 `*AboutToBeRemoved` / `*Removed`

老画布满仓的 ``QTimer.singleShot(0, self, ...)`` 与"删 overlay 前先
``setSelected(False)``"，根子都是**没有删除前置事件**：视图只能靠人肉记住
"在对象还活着的时候把引用清掉"，忘一处就是段错误。

有了 `EntitiesAboutToBeRemoved`，订阅者拿到的是**指针还活着**的最后一次合法访问
机会（事件里还附带被删实体的完整快照，供需要读它的订阅者用）；`EntitiesRemoved`
只用来更新计数，此时不许再碰实体数据。

## 二、property 位掩码

变更粒度是 push 模式的固有难题：太粗（"场景变了"）→ 每次全量重建视图，性能塌方
且选择态丢失；太细 → 回到"漏发一条就不同步"。

折中照抄 Tiled：事件带 :class:`EntityProperty` 位掩码，订阅者能判断
"只是位置变了" → 只 ``setPos()``，不重建几何。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntFlag

__all__ = [
    "EntityRef",
    "EntityProperty",
    "ChangeEvent",
    "EntitiesAdded",
    "EntitiesChanged",
    "EntitiesAboutToBeRemoved",
    "EntitiesRemoved",
    "SelectionChanged",
    "SceneReloaded",
    "ViewFiltersChanged",
]


@dataclass(frozen=True, slots=True)
class EntityRef:
    """实体身份：``(kind, id)``。

    **为什么不用对象身份**（Tiled 用的是 ``MapObject*`` 指针）：场景 JSON 每次
    reload 都是新 dict，Python 侧没有稳定的对象身份可用；而 ``kind:id`` 已经是
    画布、实体树、引用系统、撞名闸共同承认的身份，也与老画布的 ``_entity_items``
    键同形，迁移期新旧可以并存。

    代价是**撞名会互相覆盖** —— 那由数据层的撞名闸拦，这一层不重复防。
    """

    kind: str
    id: str

    @property
    def key(self) -> str:
        """``"hotspot:door_01"``，与老画布图元表的键同形。"""
        return f"{self.kind}:{self.id}"

    @classmethod
    def parse(cls, key: str) -> "EntityRef":
        kind, _, eid = str(key).partition(":")
        return cls(kind, eid)

    def __str__(self) -> str:  # 便于日志与断言信息
        return self.key


class EntityProperty(IntFlag):
    """变更了实体的哪些方面。订阅者据此决定"重摆"还是"重建"。

    分档依据是**视图侧的代价**，不是数据侧的字段名：位置只要 ``setPos``，
    而换贴图必须重新读盘 —— 两者放同一档就会让拖动每帧重载磁盘（老画布踩过，
    见 `_disp_sig` 签名缓存那段血泪）。
    """

    NONE = 0
    #: x / y —— 只需重摆，最廉价
    POSITION = 1 << 0
    #: scale / rotation —— 需重算 quad，但不重读资源
    TRANSFORM = 1 << 1
    #: 多边形 / 巡逻路点 / 曲线点列 —— 需重建几何
    GEOMETRY = 1 << 2
    #: 展示图 / 动画包 —— **需要读盘**，最贵
    APPEARANCE = 1 << 3
    #: id / 名称 / 标签
    IDENTITY = 1 << 4
    #: 分组归属
    GROUPING = 1 << 5
    #: planes / phases / cutsceneIds —— 影响视图过滤
    PRESENCE = 1 << 6
    #: 交互半径、条件等不影响画面几何的字段
    BEHAVIOUR = 1 << 7
    #: spriteSort —— 影响前后次序
    SORT = 1 << 8

    #: 未知/整体变更：订阅者应当全量重建这些实体
    ALL = (POSITION | TRANSFORM | GEOMETRY | APPEARANCE
           | IDENTITY | GROUPING | PRESENCE | BEHAVIOUR | SORT)


@dataclass(frozen=True, slots=True)
class ChangeEvent:
    """所有变更事件的基类。空基类，仅用于类型标注与 ``isinstance`` 分派。"""


@dataclass(frozen=True, slots=True)
class EntitiesAdded(ChangeEvent):
    """实体已加入场景。视图应当为它们建图元。"""

    refs: tuple[EntityRef, ...]


@dataclass(frozen=True, slots=True)
class EntitiesChanged(ChangeEvent):
    """实体的某些方面变了。``properties`` 决定订阅者要做多少活。

    **批量优先**：一次手势动 N 个实体发**一条**事件，而不是 N 条。这既是性能
    （视图只重排一次 z、只刷一次 viewport），也是语义 —— 多选拖动本来就是一件事。
    """

    refs: tuple[EntityRef, ...]
    properties: EntityProperty = EntityProperty.ALL


@dataclass(frozen=True, slots=True)
class EntitiesAboutToBeRemoved(ChangeEvent):
    """实体**即将**被删除 —— 此刻数据还在，是最后一次合法访问机会。

    订阅者应当在这里清掉自己对这些实体的引用（选择集、悬停态、图元表）。
    ``snapshots`` 附带被删实体的数据副本，供需要读它的订阅者用（例如状态栏
    要报"删掉了哪个热点"）。
    """

    refs: tuple[EntityRef, ...]
    snapshots: tuple[dict, ...] = field(default=())


@dataclass(frozen=True, slots=True)
class EntitiesRemoved(ChangeEvent):
    """实体已被删除。**此刻不许再按 ref 去查数据** —— 它已经不在场景里了。"""

    refs: tuple[EntityRef, ...]


@dataclass(frozen=True, slots=True)
class SelectionChanged(ChangeEvent):
    """画布选择集变了。选择态归 Document 管，不是视图的私有状态 ——
    这样属性面板、实体树、覆盖物三方看到的永远是同一份。"""

    refs: tuple[EntityRef, ...]


@dataclass(frozen=True, slots=True)
class SceneReloaded(ChangeEvent):
    """整个场景被换掉了（切场景、撤销回放、外部重载）。视图应当全量重建。

    这是唯一"粗粒度"的事件，刻意保留：撤销回放是整份快照回灌，逐字段发事件
    既算不出来也没意义。
    """

    scene_id: str


@dataclass(frozen=True, slots=True)
class ViewFiltersChanged(ChangeEvent):
    """位面 / 时段 / 过场视图轴变了 —— 纯视图，不改数据。

    单独一类而不是塞进 `EntitiesChanged`，因为它**不是实体变了**：
    同一份数据，只是看的角度换了。混进去会让"数据脏了吗"的判断失真。
    """
