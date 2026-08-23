"""`SceneDocument` —— 唯一的数据、唯一的撤销栈、唯一的选择态。

镜像 Tiled 的 `Document` / `MapDocument`。文档层的铁律只有一条：

> **任何修改本文档的操作都必须做成命令 push 进它的撤销栈。**

其余全部性质都是这条的推论：撤销不会撤一半（因为每次修改恰好一条命令）、
视图不会与数据不一致（因为每条命令自己发变更事件）、点一下不会变脏
（因为零变更的命令根本不构造）。

## 关于 `write_target`：本重建的**单点成败**

老画布的根因是"数据的真相在哪，由每一处鼠标手势自己判断"——模型 dict 与属性面板
的 staging 深拷贝是两层真相，谁是真的取决于"当前有没有实体被面板打开"。这个判断
散在几十处写入路径里，判错即静默坏数据（整组拖动少一个成员跟上、拖完属性面板
数字弹回旧值）。

这里把它收成**一个函数**。方案书 §3.4"死法二"说得很直白：如果只是把 staging
原样搬过来而没有这个唯一裁决函数，新架构会在第一个"整组平移写错副本"上原样
复现老 bug，然后所有人得出"换架构没用"的结论 —— 而实际上失败的是没做这一步。

staging 本身是**过渡期**产物（二期随面板改造删除），但在它还在的时候，
必须是 Document 的**显式第二层**，不是散落的约定。
"""
from __future__ import annotations

from typing import Iterable, Protocol, runtime_checkable

from PySide6.QtCore import QObject, Signal
from PySide6.QtGui import QUndoCommand, QUndoStack

from ...shared.scene_migrations import migrate_scene_collision_to_local
from .changes import (
    ChangeEvent,
    EntitiesAboutToBeRemoved,
    EntitiesRemoved,
    EntityRef,
    SceneReloaded,
    SelectionChanged,
)

__all__ = ["StagingProvider", "SceneDocument"]

#: 场景里各实体族对应的 JSON 列表键。新增实体族只改这里。
_LIST_KEY = {
    "hotspot": "hotspots",
    "npc": "npcs",
    "zone": "zones",
}


@runtime_checkable
class StagingProvider(Protocol):
    """属性面板对 Document 暴露的**唯一**接口。

    刻意只有一个方法：Document 不需要知道面板长什么样，只需要问一句
    "这个实体现在是不是正被你编辑着"。这样面板可以照旧是那 6657 行不动的老代码，
    而 Document 不必因此了解它的内部结构。
    """

    def staging_dict_for(self, kind: str, entity_id: str) -> dict | None:
        """该实体正被面板编辑时返回它的 staging dict，否则 ``None``。"""


class SceneDocument(QObject):
    """一个场景的文档：数据引用 + 撤销栈 + 选择态 + 变更广播。"""

    #: 唯一的变更出口。参数是 :class:`ChangeEvent` 子类实例。
    changed = Signal(object)

    UNDO_LIMIT = 100

    def __init__(self, model, scene_id: str, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._scene_id = str(scene_id)
        self._staging: StagingProvider | None = None
        self._selection: tuple[EntityRef, ...] = ()
        self.undo_stack = QUndoStack(self)
        self.undo_stack.setUndoLimit(self.UNDO_LIMIT)
        #: 命令回放期间为 True：此时一切"用户操作"入口都应短路，杜绝 undo 中途 push
        self.restoring = False
        sc = self.scene()
        if isinstance(sc, dict) and migrate_scene_collision_to_local(sc):
            self._model.mark_dirty("scene", self._scene_id)

    # ---- 数据（只读视角）---------------------------------------------------

    @property
    def model(self):
        return self._model

    @property
    def scene_id(self) -> str:
        return self._scene_id

    def scene(self) -> dict | None:
        """当前场景的模型 dict。**这是唯一权威**，新老画布共享同一份。"""
        return self._model.scenes.get(self._scene_id)

    def entity(self, ref: EntityRef) -> dict | None:
        """按 ref 取实体的**当前真相**（staging 优先、模型兜底）。

        读也要走裁决：读模型而写 staging 正是老画布"定时器读模型、编辑写 staging"
        每 8ms 打一次架的根因。
        """
        staged = self._staging_for(ref)
        return staged if staged is not None else self.model_entity(ref)

    def model_entity(self, ref: EntityRef) -> dict | None:
        """按 ref 取**模型层**实体，绕过 staging。只有命令做快照时才该用。"""
        sc = self.scene()
        if not isinstance(sc, dict):
            return None
        if ref.kind == "scene":
            # 场景级字段（perspectiveScale / lighting / backgrounds …）也走命令，
            # 于是"改透视轴"与"拖实体"共用同一套撤销语义 —— 老画布这里是裸写模型，
            # 所以摆灯、拖轴这类操作点错了没法 Ctrl+Z。
            return sc
        if ref.kind == "spawn":
            return self._spawn_dict(sc, ref.id)
        key = _LIST_KEY.get(ref.kind)
        if key is None:
            return None
        for ent in sc.get(key) or []:
            if isinstance(ent, dict) and str(ent.get("id", "")) == ref.id:
                return ent
        return None

    @staticmethod
    def _spawn_dict(sc: dict, name: str) -> dict | None:
        if name == "default":
            sp = sc.get("spawnPoint")
            return sp if isinstance(sp, dict) else None
        sps = sc.get("spawnPoints")
        if isinstance(sps, dict):
            sp = sps.get(name)
            return sp if isinstance(sp, dict) else None
        return None

    def entity_refs(self, kind: str) -> tuple[EntityRef, ...]:
        """某族实体的全部 ref，按 JSON 数组序（与运行时装配次序同源）。"""
        sc = self.scene()
        if not isinstance(sc, dict):
            return ()
        if kind == "spawn":
            names = ["default"] if isinstance(sc.get("spawnPoint"), dict) else []
            names += sorted((sc.get("spawnPoints") or {}).keys())
            return tuple(EntityRef("spawn", n) for n in names)
        key = _LIST_KEY.get(kind)
        if key is None:
            return ()
        return tuple(
            EntityRef(kind, str(e.get("id", "")))
            for e in sc.get(key) or []
            if isinstance(e, dict) and str(e.get("id", ""))
        )

    # ---- 写入裁决（本层的核心）--------------------------------------------

    def set_staging_provider(self, provider: StagingProvider | None) -> None:
        self._staging = provider

    def _staging_for(self, ref: EntityRef) -> dict | None:
        if self._staging is None:
            return None
        return self._staging.staging_dict_for(ref.kind, ref.id)

    def write_target(self, ref: EntityRef) -> dict | None:
        """**这次写入该落到哪一份 dict** —— 全画布唯一的裁决点。

        规则只有一条：**该实体正被属性面板编辑 → 写 staging；否则 → 写模型。**

        为什么不能"总是写模型"：面板持的是深拷贝，用户点 Apply 时会用那份深拷贝
        整份覆盖模型 —— 期间任何直写模型的改动都会被**静默盖掉**（P1-01 / P1-25
        那族"新增的实体又被抹掉"）。
        为什么不能"总是写 staging"：面板只为**当前选中**的那一个实体开 staging，
        整组位移要动的成员多数没有 staging，写进去等于写了个不存在的地方。

        调用方**不许自己判断**，一律问这里。
        """
        staged = self._staging_for(ref)
        return staged if staged is not None else self.model_entity(ref)

    def is_staged(self, ref: EntityRef) -> bool:
        """该实体此刻是否正被面板编辑（写入会落到 staging）。"""
        return self._staging_for(ref) is not None

    # ---- 命令入口（唯一能写的路）------------------------------------------

    def push(self, command: QUndoCommand | None) -> bool:
        """把命令推进撤销栈；``None`` 或零变更的命令**不入栈**，返回 False。

        "零变更不入栈"不是优化，是语义：撤销游标不动 → 文档不脏 → **点一下看属性
        不会把场景标记成已修改**。老画布为此在三处手写零位移闸（press 快照比对、
        `_xy_unchanged`、`_keep_num`），这里由构造期比对一次性解决。
        """
        if command is None or self.restoring:
            return False
        if getattr(command, "is_noop", False):
            return False
        self.undo_stack.push(command)
        return True

    def mark_dirty(self) -> None:
        """标记本场景为未保存。命令改完数据后调，**调用方不必再手写第二级脏标记**。"""
        self._model.mark_dirty("scene", self._scene_id)

    def emit_changed(self, event: ChangeEvent) -> None:
        """广播变更。命令的 ``redo()`` 与 ``undo()`` 都必须调，且发**同类型**事件 ——
        这就是"正着改能刷新、撤回来不刷新"写不出来的原因。"""
        self.changed.emit(event)

    def notify_reloaded(self) -> None:
        """整份场景被换掉（切场景 / 撤销回灌 / 外部重载）后调。"""
        sc = self.scene()
        if isinstance(sc, dict) and migrate_scene_collision_to_local(sc):
            self._model.mark_dirty("scene", self._scene_id)
        self._prune_selection()
        self.emit_changed(SceneReloaded(self._scene_id))

    # ---- 选择态（归文档，不是视图的私有状态）------------------------------

    @property
    def selection(self) -> tuple[EntityRef, ...]:
        return self._selection

    def set_selection(self, refs: Iterable[EntityRef]) -> None:
        new = tuple(dict.fromkeys(refs))  # 去重且保序
        if new == self._selection:
            return
        self._selection = new
        self.emit_changed(SelectionChanged(new))

    def clear_selection(self) -> None:
        self.set_selection(())

    def _prune_selection(self) -> None:
        """场景换了之后，选择集里已经不存在的实体必须掉出去。"""
        alive = tuple(r for r in self._selection if self.model_entity(r) is not None)
        if alive != self._selection:
            self._selection = alive
            self.emit_changed(SelectionChanged(alive))

    # ---- 删除的成对事件（防"视图持已析构对象"）-----------------------------

    def about_to_remove(self, refs: Iterable[EntityRef]) -> None:
        """在**真正删除之前**广播，让订阅者清引用。数据此刻仍可读。"""
        rs = tuple(refs)
        if not rs:
            return
        snaps = tuple(dict(self.model_entity(r) or {}) for r in rs)
        self.emit_changed(EntitiesAboutToBeRemoved(rs, snaps))
        # 选择集是最常见的悬挂引用来源，文档自己先清掉
        remaining = tuple(r for r in self._selection if r not in set(rs))
        if remaining != self._selection:
            self._selection = remaining
            self.emit_changed(SelectionChanged(remaining))

    def removed(self, refs: Iterable[EntityRef]) -> None:
        """删除完成后广播。此刻**不许**再按 ref 去查数据。"""
        rs = tuple(refs)
        if rs:
            self.emit_changed(EntitiesRemoved(rs))
