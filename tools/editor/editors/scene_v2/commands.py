"""命令层 —— **唯一能写数据的东西**。

镜像 Tiled 的 `changemapobject.h` / `transformmapobjects.cpp` 与 Qt Undo Framework。
三条性质各自堵掉一类老画布的顽疾：

1. **`redo()` 与 `undo()` 走同一个 `_swap()`**（Tiled 的 `swap()` 模式）。
   两个方向做的是同一件事、发的是同一个事件，所以"正着改能刷新、撤回来不刷新"
   **在物理上写不出来**。老画布的撤销回放要靠 `_apply_scene_snapshot` 里一串
   "按需重载"来补刷新，漏一处就是撤销后画面不动。

2. **零变更不构造命令**（`is_noop`）。于是"只是点一下看属性，坐标就被写了、
   场景被标脏、整数坐标漂成小数"这一族不可能发生 —— 老画布为此手写了三道闸。

3. **`id()` + `mergeWith()` 是基类能力**。一次拖动/一串方向键微移合并成一条撤销
   记录，不需要每个工具自己糊一个 400ms 定时器（老画布 `_finish_nudge_session`
   就是那个定时器）。第一帧 `mergeable=False`、之后 `True`，正是 Tiled 的
   `std::exchange(mMergeUndo, true)`。
"""
from __future__ import annotations

import copy
from typing import Iterable, Sequence

from PySide6.QtGui import QUndoCommand

from .changes import EntitiesChanged, EntityProperty, EntityRef

__all__ = [
    "CMD_ID_TRANSFORM",
    "SceneCommand",
    "ChangeEntityFieldsCommand",
    "build_change_fields_command",
]

#: 合并用的命令 ID。同一 ID 且相邻的两条命令才会被 Qt 交给 `mergeWith`。
#: `-1` 是 Qt 约定的"永不合并"。
CMD_ID_TRANSFORM = 0x5C_E2_01


class SceneCommand(QUndoCommand):
    """本画布全部命令的基类：持文档，并把"两个方向做同一件事"钉在结构上。

    ``redo()`` 与 ``undo()`` 的唯一差别是**喂给 `_write()` 的那张值表**，
    其余（写入、标脏、发事件）逐字一致。于是"正着改能刷新、撤回来不刷新"
    在物理上写不出来 —— 那是老画布最难查的一类。

    **命令自己应用变更**（不搞"首次 redo 跳过"）。老画布那个跳过是因为手势代码
    先就地写了数据、命令只补一张快照；在这套架构里数据只能由命令写，
    所以 Qt 在 ``push()`` 时调的那一次 ``redo()`` 正是变更真正落地的时刻。
    手势期间的实时反馈由**视图**负责预览，不写数据。
    """

    def __init__(self, document, label: str) -> None:
        super().__init__(label)
        self._doc = document

    def _write(self, values: Sequence[dict]) -> tuple[EntityRef, ...]:  # pragma: no cover
        raise NotImplementedError

    def _properties(self) -> EntityProperty:  # pragma: no cover - 抽象
        raise NotImplementedError

    def _values_for_redo(self) -> Sequence[dict]:  # pragma: no cover - 抽象
        raise NotImplementedError

    def _values_for_undo(self) -> Sequence[dict]:  # pragma: no cover - 抽象
        raise NotImplementedError

    @property
    def is_noop(self) -> bool:
        """零变更命令不该入栈。基类默认非空操作，子类按需覆盖。"""
        return False

    def _apply(self, values: Sequence[dict]) -> None:
        refs = self._write(values)
        if not refs:
            return
        self._doc.mark_dirty()
        # **撤销与重做发同一个事件** —— 这一行是"撤销后画面不刷新"写不出来的原因
        self._doc.emit_changed(EntitiesChanged(refs, self._properties()))

    def redo(self) -> None:
        self._apply(self._values_for_redo())

    def undo(self) -> None:
        self._apply(self._values_for_undo())


class ChangeEntityFieldsCommand(SceneCommand):
    """改一批实体的一批字段。**位置、缩放、旋转、多边形全走它** —— 它们的差别
    只在 `properties` 位掩码，不在命令类型。

    为什么是"一条命令装一个列表"而不是 N 条拼宏：多选拖动本来就是**一件事**，
    原子性应当由类型保证，而不是靠调用方记得配对 ``beginMacro``/``endMacro``。
    Tiled 的 `transformmapobjects.cpp` 同样明确不用宏做多对象变换。
    """

    def __init__(
        self,
        document,
        refs: Sequence[EntityRef],
        before: Sequence[dict],
        after: Sequence[dict],
        properties: EntityProperty,
        label: str,
        *,
        mergeable: bool = False,
    ) -> None:
        super().__init__(document, label)
        self._refs = tuple(refs)
        self._before = [dict(b) for b in before]
        self._after = [dict(a) for a in after]
        self._props = properties
        self._mergeable = bool(mergeable)

    @property
    def is_noop(self) -> bool:
        return not self._refs or self._before == self._after

    def _properties(self) -> EntityProperty:
        return self._props

    def _values_for_redo(self) -> Sequence[dict]:
        return self._after

    def _values_for_undo(self) -> Sequence[dict]:
        return self._before

    def _write(self, values: Sequence[dict]) -> tuple[EntityRef, ...]:
        """把这张值表落到数据上。

        写入目标一律问 `Document.write_target`：**命令自己也不判断写哪一份**。
        `_MISSING` 表示"这个键原本不存在" → 删键，而不是写 ``None``
        （写 None 会污染 JSON，黄金往返立刻红）。
        """
        touched: list[EntityRef] = []
        for ref, vals in zip(self._refs, values):
            target = self._doc.write_target(ref)
            if target is None:
                continue
            for key, value in vals.items():
                if value is _MISSING:
                    target.pop(key, None)
                else:
                    target[key] = copy.deepcopy(value)
            touched.append(ref)
        return tuple(touched)

    # ---- 合并（一次手势 = 一条撤销记录）------------------------------------

    def id(self) -> int:
        """**恒定**返回同一个 ID —— 合不合并由 `mergeWith` 里查**来者**的标志位决定。

        这里踩过一次：把第一帧的 ``id()`` 写成 ``-1``（"第一帧不可合并"）看着合理，
        实际是后续帧**没有东西可以并进去**（Qt 的判据是 ``top.id() == new.id()``，
        top 就是第一帧），于是一次拖动仍然留下两条记录。

        Tiled 的做法（`transformmapobjects.cpp`）是 id 恒定、在 `mergeWith` 里查
        ``other->mMergeable``：新手势的第一帧带 False，于是**它不会并进上一次手势**；
        同手势的后续帧带 True，并进本条。
        """
        return CMD_ID_TRANSFORM

    def mergeWith(self, other: QUndoCommand) -> bool:
        """把后续同手势的命令并进本条：**保留最早的 before、采用最新的 after**。

        Qt 的 ``push()`` 会**先**调 ``other.redo()``（变更已落地）**再**尝试合并，
        所以这里只需接管值表、不必重放。

        只合并**同一批实体、同一类属性**的命令 —— 否则"拖完 A 又拖 B"会被并成
        一条，撤销时两个都退回去，那是另一种"撤销撤一半"。
        """
        if not isinstance(other, ChangeEntityFieldsCommand):
            return False
        # **查来者的标志位**：新手势的第一帧带 False，于是不会并进上一次手势
        if not other._mergeable:
            return False
        if other._refs != self._refs or other._props != self._props:
            return False
        # before 保持本条最早那份；after 换成最新的一帧
        merged_after: list[dict] = []
        for i in range(len(self._refs)):
            combined = dict(self._after[i])
            combined.update(other._after[i])
            merged_after.append(combined)
        self._after = merged_after
        # 后续帧可能触及本条没碰过的键：那些键的 before 也要补上，否则撤销漏一半
        for i in range(len(self._refs)):
            for key, old in other._before[i].items():
                self._before[i].setdefault(key, old)
        return True


class _Missing:
    """哨兵：表示"这个键原本不存在"，与"值是 None"区分开。

    不区分的话，撤销会把原本没有的键补成 ``None`` 写进 JSON —— 那是**数据污染**，
    黄金往返会红（未受管字段必须原样透传）。
    """

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - 仅调试可读性
        return "<missing>"


_MISSING = _Missing()


def build_change_fields_command(
    document,
    refs: Sequence[EntityRef],
    new_values: Sequence[dict],
    properties: EntityProperty,
    label: str,
    *,
    mergeable: bool = False,
) -> ChangeEntityFieldsCommand | None:
    """构造命令；**零变更时返回 None**（于是不入栈、不标脏）。

    这是"点一下不许变脏"的落地点：before 从当前真相（staging 优先）现取，
    与 after 逐字段比对，全等即返回 None。
    """
    if len(refs) != len(new_values):
        raise ValueError("refs 与 new_values 长度必须一致")
    before: list[dict] = []
    after: list[dict] = []
    kept: list[EntityRef] = []
    for ref, vals in zip(refs, new_values):
        target = document.write_target(ref)
        if target is None:
            continue
        b: dict = {}
        a: dict = {}
        for key, value in vals.items():
            old = target.get(key, _MISSING)
            if _same(old, value):
                continue
            b[key] = copy.deepcopy(old) if old is not _MISSING else _MISSING
            a[key] = value
        if not a:
            continue
        kept.append(ref)
        before.append(b)
        after.append(a)
    if not kept:
        return None
    return ChangeEntityFieldsCommand(
        document, kept, before, after, properties, label, mergeable=mergeable)


def _same(old: object, new: object) -> bool:
    """字段级"没变"判定。

    对 int/float 刻意**区分表示**（``100`` 与 ``100.0`` 视为不同）：老画布的
    数值往返保真契约要求未改动的数值键按原始表示回写，把两者视为相同会让
    "只是点了一下"把整数坐标漂成小数。
    """
    if old is _MISSING or new is _MISSING:
        return old is new
    if type(old) is not type(new):
        return False
    return old == new


def refs_of(entities: Iterable[tuple[str, str]]) -> tuple[EntityRef, ...]:
    """``[("npc", "n1"), ...]`` → ref 元组。调用点可读性用。"""
    return tuple(EntityRef(k, i) for k, i in entities)
