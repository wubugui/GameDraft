"""分组的建 / 删 / 指派 —— 全部走命令，可撤销。

## 为什么单独一支

分组不是普通实体：它住在 `entityGroups` 里，而"谁是成员"记在**成员身上**
（`entity.group` 字符串）。所以删一个组要同时改两处：名册行 + 每个成员的 group 键。
两处必须在**同一条命令**里，否则撤销会撤出"组没了但成员还挂着它"这种半份状态。

## 兼容标签组

旧场景只在成员身上写 `group` 字符串、`entityGroups` 里没有对应条目。这类"标签组"
在老画布上照样有框、能选能拖（`project_model.scene_group_ids_for_scene` 把它们
追加进名录）。新画布起初只遍历 `entityGroups`，于是这类场景在画布上**看不到任何
分组**，用户会以为分组数据丢了。`all_group_ids` 因此两边都认。
"""
from __future__ import annotations

from .changes import EntityProperty, EntityRef
from .commands import _MISSING, build_change_fields_command
from .commands_structure import LIST_KEY

__all__ = [
    "all_group_ids",
    "group_inbound_member_count",
    "create_group",
    "delete_group",
    "assign_group",
    "unique_group_id",
]


def all_group_ids(document) -> list[str]:
    """场景里的全部分组 id：`entityGroups` 条目 **+** 只在成员身上出现的标签组。"""
    sc = document.scene() or {}
    out: list[str] = []
    seen: set[str] = set()
    for g in sc.get("entityGroups") or []:
        if isinstance(g, dict):
            gid = str(g.get("id", "") or "").strip()
            if gid and gid not in seen:
                seen.add(gid)
                out.append(gid)
    for key in LIST_KEY.values():
        for ent in sc.get(key) or []:
            if not isinstance(ent, dict):
                continue
            gid = str(ent.get("group", "") or "").strip()
            if gid and gid not in seen:
                seen.add(gid)
                out.append(gid)
    return out


def group_inbound_member_count(document, gid: str) -> int:
    sc = document.scene() or {}
    return sum(
        1 for key in LIST_KEY.values()
        for ent in sc.get(key) or []
        if isinstance(ent, dict) and str(ent.get("group", "") or "") == str(gid))


def unique_group_id(document, stem: str = "组") -> str:
    taken = set(all_group_ids(document))
    if stem not in taken:
        return stem
    n = 2
    while f"{stem}_{n}" in taken:
        n += 1
    return f"{stem}_{n}"


def create_group(document, gid: str = "", label: str = "") -> str:
    """新建一个分组，返回它的 id（失败返回空串）。

    直接改 `entityGroups` 名册 —— 它不是字段级改动，走 `scene` ref 的字段命令
    会把整份名册当一个值写，撤销粒度反而更粗。这里仍然经命令层，保证可撤销。
    """
    sc = document.scene()
    if not isinstance(sc, dict):
        return ""
    new_id = str(gid or "").strip() or unique_group_id(document)
    if new_id in set(all_group_ids(document)):
        return ""
    rows = list(sc.get("entityGroups") or [])
    rows.append({"id": new_id, "label": str(label or "")})
    ok = document.push(build_change_fields_command(
        document, [EntityRef("scene", document.scene_id)],
        [{"entityGroups": rows}], EntityProperty.GROUPING, "新建分组"))
    return new_id if ok else ""


def delete_group(document, gid: str) -> bool:
    """删除分组，并把成员的 `group` 键一并清掉。**一条命令**。

    两处不在同一条命令里的话，撤销会撤出"组没了但成员还挂着它"这种半份状态 ——
    那正是兼容标签组的形态，画布上会凭空冒出一个没人认领的组。
    """
    gid = str(gid or "").strip()
    if not gid:
        return False
    sc = document.scene()
    if not isinstance(sc, dict):
        return False
    refs: list[EntityRef] = [EntityRef("scene", document.scene_id)]
    values: list[dict] = [{
        "entityGroups": [g for g in sc.get("entityGroups") or []
                         if not (isinstance(g, dict)
                                 and str(g.get("id", "")) == gid)]
    }]
    for kind, key in LIST_KEY.items():
        for ent in sc.get(key) or []:
            if isinstance(ent, dict) and str(ent.get("group", "") or "") == gid:
                refs.append(EntityRef(kind, str(ent.get("id", ""))))
                values.append({"group": _MISSING})
    return document.push(build_change_fields_command(
        document, refs, values, EntityProperty.GROUPING, f"删除分组 {gid}"))


def assign_group(document, refs, gid: str | None) -> bool:
    """把这些实体指派进某个分组；`gid` 为空 = 移出分组（删键，不写空串）。

    写空串会让"没分组"变成"属于一个叫空串的组"，画布上会多出一个诡异的框。
    """
    targets = [r for r in refs if r.kind in LIST_KEY]
    if not targets:
        return False
    value = str(gid or "").strip()
    payload = {"group": value} if value else {"group": _MISSING}
    return document.push(build_change_fields_command(
        document, targets, [dict(payload) for _ in targets],
        EntityProperty.GROUPING,
        "指派分组" if value else "移出分组"))
