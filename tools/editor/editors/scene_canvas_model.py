"""场景画布的图元账本模型 —— 零 Qt，可脱离 QApplication 单测。

## 为什么单独一个模块

画布上一个"实体"从来不是一个图元，而是一束：热点 = 圆点 + 展示图 + 碰撞多边形 +
透视幽灵；NPC = 圆点 + 碰撞 + 幽灵 + 巡逻折线 + **动画精灵**。而"这一束都有谁"
此前被**手写了三遍**（`set_entity_visible` 一份、`remove_hotspot_graphics` 一份、
`remove_npc_graphics` 一份），彼此不同步：

- `set_entity_visible` 的 npc 分支**漏了动画精灵** → 切时段/位面时圆点藏了、人还站着；
- 精灵压根不住 `_entity_items`（它在 `SceneEditor._scene_npc_runtimes[eid].item`），
  任何"遍历 `_entity_items` 贴显隐"的写法都碰不到它。

把这束关系收进 :data:`PART_TABLE` 这一张表，三处手写清单同时消失，
"新增附属图元漏改一处 = 删不干净或藏不住"这类 bug 结构性消失。

## 为什么键是 ``kind:id`` 而不是对象身份

Tiled 用 ``MapObject*`` 指针做键，因为 C++ 侧对象身份稳定。Python 这边场景 JSON
每次 reload 都是新 dict，没有稳定身份可用；而 ``kind:id`` 已经是画布、实体树、
引用系统、撞名闸（``test_scene_entity_id_collision_gate.py``）共同承认的身份，
也与既有 ``_entity_items`` 键同形，迁移期新旧可以并存。

代价是**撞名会互相覆盖** —— 由撞名闸在数据层拦，画布这层不重复防。
"""
from __future__ import annotations

from typing import Iterator

__all__ = [
    "Part",
    "PART_TABLE",
    "PART_KEY_PREFIX",
    "EXTERNAL_PARTS",
    "part_key",
    "iter_part_keys",
    "parts_of",
]

Part = str

#: 每一族实体在画布上拥有的全部图元 part。**唯一真相**——增删附属图元只改这里。
#:
#: 顺序无语义，但保持"主图元在前"便于阅读。
PART_TABLE: dict[str, tuple[Part, ...]] = {
    "hotspot": ("handle", "display", "collision", "ghost"),
    "npc": ("handle", "collision", "ghost", "patrol", "sprite"),
    "zone": ("polygon",),
    "spawn": ("handle",),
    "group": ("box",),
}

#: part → ``_entity_items`` 里的键前缀。``None`` = 该 part **不住** ``_entity_items``，
#: 由外部适配器提供（见 :data:`EXTERNAL_PARTS`）。
PART_KEY_PREFIX: dict[tuple[str, Part], str | None] = {
    ("hotspot", "handle"): "hotspot",
    ("hotspot", "display"): "hotspot_display",
    ("hotspot", "collision"): "hotspot_collision",
    ("hotspot", "ghost"): "hotspot_collision_ghost",
    ("npc", "handle"): "npc",
    ("npc", "collision"): "npc_collision",
    ("npc", "ghost"): "npc_collision_ghost",
    ("npc", "patrol"): None,   # 住 SceneCanvas._patrol_overlays
    ("npc", "sprite"): None,   # 住 SceneEditor._scene_npc_runtimes[eid].item
    ("zone", "polygon"): "zone",
    ("spawn", "handle"): "spawn",
    ("group", "box"): "group",
}

#: 不住 ``_entity_items`` 的 part。它们通过 `SceneCanvas.register_part_adapter`
#: 注册进画布，显隐/回收统一经适配器 —— 这样"账本走一圈"就能覆盖到它们，
#: 而不必把它们搬家（大量既有测试直接摸 ``_patrol_overlays`` / ``_scene_npc_runtimes``）。
EXTERNAL_PARTS: frozenset[tuple[str, Part]] = frozenset(
    key for key, prefix in PART_KEY_PREFIX.items() if prefix is None
)


def parts_of(kind: str) -> tuple[Part, ...]:
    """某族实体的全部 part；未知族返回空元组（调用方按"没有图元"处理）。"""
    return PART_TABLE.get(str(kind).strip().lower(), ())


def part_key(kind: str, entity_id: str, part: Part) -> str | None:
    """``(kind, id, part)`` → ``_entity_items`` 键；外部 part 返回 ``None``。"""
    prefix = PART_KEY_PREFIX.get((str(kind).strip().lower(), part))
    return None if prefix is None else f"{prefix}:{entity_id}"


def iter_part_keys(kind: str, entity_id: str) -> Iterator[tuple[Part, str | None]]:
    """遍历某实体的 ``(part, _entity_items 键或 None)``。

    ``set_entity_visible`` / ``remove_*_graphics`` 都走这里，于是三处手写清单
    合并成一处，永远不会再各自漏项。
    """
    k = str(kind).strip().lower()
    for part in parts_of(k):
        yield part, part_key(k, entity_id, part)
