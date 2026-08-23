"""结构性命令：增 / 删 / 复制。

与 `commands.ChangeEntityFieldsCommand`（改字段）分开，因为它们动的是**名册**
而不是字段值，撤销时要把实体连同它在数组里的**原位置**一起放回去 ——
放到末尾会让 JSON 数组序变化，而数组序正是运行时平局排序的依据。
"""
from __future__ import annotations

import copy
from typing import Sequence

from .changes import EntitiesAdded, EntityRef
from .commands import SceneCommand

__all__ = ["AddEntitiesCommand", "RemoveEntitiesCommand", "LIST_KEY"]

#: 实体族 → 场景 JSON 里的列表键
LIST_KEY = {"hotspot": "hotspots", "npc": "npcs", "zone": "zones"}


class _StructureCommand(SceneCommand):
    """增删的公共部分：按 (ref, index, payload) 三元组操作名册。"""

    def __init__(self, document, entries: Sequence[tuple[EntityRef, int, dict]],
                 label: str) -> None:
        super().__init__(document, label)
        self._entries = [(r, i, copy.deepcopy(p)) for r, i, p in entries]

    @property
    def is_noop(self) -> bool:
        return not self._entries

    def _properties(self):  # 结构变化不走 property 位掩码
        from .changes import EntityProperty
        return EntityProperty.ALL

    def _list_for(self, ref: EntityRef) -> list | None:
        sc = self._doc.scene()
        key = LIST_KEY.get(ref.kind)
        if not isinstance(sc, dict) or key is None:
            return None
        lst = sc.setdefault(key, [])
        return lst if isinstance(lst, list) else None

    def _insert_all(self) -> None:
        # 按下标升序插入，保证多个实体一起恢复时各回各位
        for ref, index, payload in sorted(self._entries, key=lambda e: e[1]):
            lst = self._list_for(ref)
            if lst is None:
                continue
            at = index if 0 <= index <= len(lst) else len(lst)
            lst.insert(at, copy.deepcopy(payload))
        self._doc.mark_dirty()
        self._doc.emit_changed(EntitiesAdded(tuple(e[0] for e in self._entries)))

    def _remove_all(self) -> None:
        refs = tuple(e[0] for e in self._entries)
        # **先广播"即将删除"**：订阅者此刻还能按 ref 读到完整数据
        self._doc.about_to_remove(refs)
        for ref, _index, _payload in self._entries:
            lst = self._list_for(ref)
            if lst is None:
                continue
            for i, ent in enumerate(lst):
                if isinstance(ent, dict) and str(ent.get("id", "")) == ref.id:
                    lst.pop(i)
                    break
        self._doc.mark_dirty()
        self._doc.removed(refs)

    # 结构命令自己发事件，不走基类的 _apply
    def _write(self, values):  # pragma: no cover - 未使用
        return ()


class AddEntitiesCommand(_StructureCommand):
    """新增实体。撤销 = 删除它们。"""

    def redo(self) -> None:
        self._insert_all()

    def undo(self) -> None:
        self._remove_all()


class RemoveEntitiesCommand(_StructureCommand):
    """删除实体。撤销 = 连同**原数组位置**一起放回去。

    放回末尾会改变 JSON 数组序，而数组序是运行时平局排序的依据 ——
    撤销一次就让前后关系悄悄变了，属于"撤销没撤干净"的隐蔽形态。
    """

    def redo(self) -> None:
        self._remove_all()

    def undo(self) -> None:
        self._insert_all()


def snapshot_entries(document, refs: Sequence[EntityRef]):
    """把 refs 打包成 (ref, 原下标, 数据副本)，供删除命令记住怎么放回去。"""
    out: list[tuple[EntityRef, int, dict]] = []
    sc = document.scene()
    if not isinstance(sc, dict):
        return out
    for ref in refs:
        key = LIST_KEY.get(ref.kind)
        if key is None:
            continue
        for i, ent in enumerate(sc.get(key) or []):
            if isinstance(ent, dict) and str(ent.get("id", "")) == ref.id:
                out.append((ref, i, copy.deepcopy(ent)))
                break
    return out
