"""创建 / 删除 / 复制工具。

与几何工具分开的理由同 `commands_structure`：它们动的是**名册**。
id 生成必须走"扫描现有 id 找空位"，不能用 `len(列表)` —— 后者在删了中间项之后
必然撞名（老画布那一族事故的固定形状）。
"""
from __future__ import annotations

import copy
import re

from PySide6.QtCore import QPointF, Qt

from ...shared.entity_refactor import (
    build_duplicate_payload,
    id_namespace_kinds,
)
from .changes import EntityRef
from .commands_structure import (
    LIST_KEY,
    AddEntitiesCommand,
    RemoveEntitiesCommand,
    snapshot_entries,
)
from .tools import AbstractTool

__all__ = ["unique_entity_id", "CreateTool", "delete_selected", "duplicate_selected"]

_DEFAULTS = {
    "hotspot": {"type": "inspect", "interactionRange": 50},
    "npc": {"interactionRange": 50},
    "zone": {},
}


def existing_ids(document, kind: str) -> set[str]:
    """该 kind **命名空间内**已被占用的 id。

    npc 与 hotspot 共用一个命名空间（运行时按 id 寻址不分族），所以两张表都要扫。
    只扫自己那张的话，复制/新建能造出「一个热点和一个 NPC 同 id」——
    而属性面板自己的撞名闸恰恰禁止用户手输这种数据。
    """
    sc = document.scene() or {}
    out: set[str] = set()
    for k in id_namespace_kinds(kind):
        key = LIST_KEY.get(k)
        if key is None:
            continue
        out |= {str(e.get("id", "")) for e in sc.get(key) or [] if isinstance(e, dict)}
    return out


def unique_entity_id(document, kind: str, stem: str = "",
                     extra_taken: set[str] | None = None) -> str:
    """生成不撞名的 id。

    **不用 `len(列表)` 编号** —— 删了中间项之后 `len` 会回落到一个已被占用的
    数字，于是"新建的实体覆盖了别人"。这里扫描现有 id 取真正的空位。

    `extra_taken` 是**本批还没入模型**的 id。批量复制时命令直到最后才 push，
    模型里看不到本批已分配的名字；不传它就会出现"返回值等于入参"的情况，
    调用方那个 `while new_id in taken` 于是**零推进量、死循环卡死编辑器**
    （实测：同时选中 `a` 与 `a_2` 复制即触发）。
    """
    base = (stem or f"new_{kind}").strip() or f"new_{kind}"
    taken = existing_ids(document, kind) | set(extra_taken or ())
    if base not in taken:
        return base
    # 已有 `xxx_3` 这类后缀时从它之后接着数，避免每次都从 2 开始试
    m = re.match(r"^(.*?)_(\d+)$", base)
    stem2 = m.group(1) if m else base
    n = int(m.group(2)) + 1 if m else 2
    while f"{stem2}_{n}" in taken:
        n += 1
    return f"{stem2}_{n}"


def _new_entity(document, kind: str, x: float, y: float) -> dict:
    ent = {"id": unique_entity_id(document, kind), "x": round(float(x), 1),
           "y": round(float(y), 1)}
    ent.update(copy.deepcopy(_DEFAULTS.get(kind, {})))
    if kind == "npc":
        ent["name"] = ent["id"]
    if kind == "zone":
        # Zone 没有 x/y，用一个以落点为中心的小方块起步
        ent.pop("x", None)
        ent.pop("y", None)
        ent["polygon"] = [
            {"x": round(x - 40, 1), "y": round(y - 40, 1)},
            {"x": round(x + 40, 1), "y": round(y - 40, 1)},
            {"x": round(x + 40, 1), "y": round(y + 40, 1)},
            {"x": round(x - 40, 1), "y": round(y + 40, 1)},
        ]
    return ent


class CreateTool(AbstractTool):
    """在画布上点一下新建一个实体。族由 `entity_kind` 决定。"""

    tool_id = "create"
    display_name = "新建"

    def __init__(self, document, renderer, kind: str = "hotspot",
                 view=None, parent=None) -> None:
        super().__init__(document, renderer, parent)
        self._view = view
        self.entity_kind = kind

    @property
    def status_hint(self) -> str:
        return f"点击画布新建 {self.entity_kind}"

    def mouse_pressed(self, scene_pos, button, modifiers) -> bool:
        if button != Qt.MouseButton.LeftButton:
            return False
        return create_entity_at(self._doc, self.entity_kind, scene_pos)


def create_entity_at(document, kind: str, scene_pos: QPointF) -> bool:
    """新建一个实体并选中它。返回是否真的建了。"""
    if kind not in LIST_KEY:
        return False
    ent = _new_entity(document, kind, scene_pos.x(), scene_pos.y())
    ref = EntityRef(kind, ent["id"])
    sc = document.scene() or {}
    index = len(sc.get(LIST_KEY[kind]) or [])
    if document.push(AddEntitiesCommand(document, [(ref, index, ent)], f"新建{kind}")):
        document.set_selection([ref])
        return True
    return False


def delete_selected(document) -> bool:
    """删除当前选中的实体（一条命令，可整体撤销）。"""
    refs = [r for r in document.selection if r.kind in LIST_KEY]
    if not refs:
        return False
    entries = snapshot_entries(document, refs)
    if not entries:
        return False
    return document.push(RemoveEntitiesCommand(document, entries, "删除实体"))


def duplicate_selected(document, offset: tuple[float, float] = (24.0, 24.0)) -> bool:
    """复制选中实体：**一条命令**建出全部副本，并把选择切到副本上。

    副本整体偏移一点，免得与原件完全重叠、看着像什么都没发生。
    """
    refs = [r for r in document.selection if r.kind in LIST_KEY]
    if not refs:
        return False
    sc = document.scene() or {}
    entries = []
    new_refs = []
    stripped_cutscenes: list[tuple[str, list[str]]] = []
    taken_per_kind: dict[str, set[str]] = {}
    for ref in refs:
        src = document.model_entity(ref)
        if not isinstance(src, dict):
            continue
        taken = taken_per_kind.setdefault(ref.kind, set())
        # 把"本批已分配但还没入模型"的名字一并交给分配器：命令直到最后才 push，
        # 模型里看不到它们。此前是外面套一个 `while new_id in taken` 重试 ——
        # 而分配器看不到本批名字时会原样返回入参，循环零推进、**死循环卡死编辑器**。
        new_id = unique_entity_id(document, ref.kind, str(src.get("id", "")), taken)
        taken.add(new_id)
        # **复制规则走共享实现**（`shared/entity_refactor.build_duplicate_payload`）：
        # 剥离过场绑定、平移 x/y 与 polygon 与**巡逻路点**、局部碰撞面不重复平移。
        # 自己写一份的代价已经付过了：副本挂着 cutsceneOnly 在游戏里永不显示、
        # 巡逻路线仍钉在原实体那条路上，两条都要进游戏才看得出来。
        clone, stripped = build_duplicate_payload(
            src, new_id, float(offset[0]), float(offset[1]))
        if stripped:
            stripped_cutscenes.append((new_id, stripped))
        new_ref = EntityRef(ref.kind, new_id)
        index = len(sc.get(LIST_KEY[ref.kind]) or []) + len(entries)
        entries.append((new_ref, index, clone))
        new_refs.append(new_ref)
    if not entries:
        return False
    if document.push(AddEntitiesCommand(document, entries, "复制实体")):
        document.set_selection(new_refs)
        if stripped_cutscenes:
            # 剥离是对的（副本挂着绑定无人驱动），但**必须说出来** ——
            # 静默剥离会让作者以为副本与原件完全一致。
            document.notify(
                "副本已剥离过场绑定：" + "；".join(
                    f"{nid} ← {', '.join(cs)}" for nid, cs in stripped_cutscenes))
        return True
    return False
