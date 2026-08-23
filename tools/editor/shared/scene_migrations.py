"""场景 JSON 的加载期迁移 —— 把"历史遗留形状"在进内存那一刻就抹平。

## 为什么要有这一层

编辑器里最难查的一类 bug 是**同一个字段有两种坐标系**：读的人必须每次都记得判断
"这份是局部还是世界"，判错就是**静默的错位**（画面看着对、命中面偏了）。

碰撞多边形 `collisionPolygon` 就是这个形状：早期数据写的是世界坐标，后来改成
相对锚点的局部坐标 + `collisionPolygonLocal: true` 标记。老画布的做法是**在每个
读点写一个兼容分支**（热点一处、NPC 一处、整组平移一处），于是"两种坐标系"这件事
被永久地摊进了所有消费者。

这里改成**加载期一次性归一**：场景进内存的那一刻，全部转成局部坐标并打标。
之后任何消费者（画布、命令、渲染、写盘）都可以**无条件当局部坐标用**，兼容分支
只剩这一处。这是"消灭分支"而不是"多写一个分支"。

## 与运行时的关系

运行时 `src/utils/hotspotCollision.ts#anchorCollisionPolygonToWorld` 同样两种都认，
且**求值时**才施加实例 transform。本模块的正/反变换与它互逆
（`entity_transform_math.transform_local_vec` / `inverse_transform_world_vec`），
所以迁移是**语义无损**的：迁移前后，运行时算出来的世界多边形逐点相同。

## 现状（2026-08-23 实测）

`public/assets/scenes/*.json` 里带碰撞面的 6 个 NPC、以及全部热点，**已经全是局部
坐标**。本模块因此在当前数据上是空操作 —— 它的价值在于**保证不变量**：
旧分支、旧存档、AI 生成的旧形状数据一旦出现，也会在加载期被抹平，
新画布不必再为此写第二个分支。
"""
from __future__ import annotations

from .entity_transform_math import (
    entity_rotation_deg_of,
    entity_scale_of,
    inverse_transform_world_vec,
    transform_local_vec,
)

__all__ = [
    "COLLISION_OWNER_KEYS",
    "collision_polygon_local_to_world",
    "collision_polygon_world_to_local",
    "legacy_world_authored_to_local",
    "migrate_scene_collision_to_local",
]

#: 场景 JSON 里哪些实体列表带 `collisionPolygon`。
#: 加新的带碰撞面实体族时只改这里 —— 与 `scene_canvas_model.PART_TABLE` 同样是
#: "清单只有一份"的做法，避免"新增一族、忘了迁移"。
COLLISION_OWNER_KEYS = ("hotspots", "npcs")


def collision_polygon_local_to_world(ent: dict, local_poly: list) -> list[dict[str, float]]:
    """authored 局部点 → **画布上的**世界点：正变换后加锚点（与运行时同口径）。

    :func:`collision_polygon_world_to_local` 的严格逆运算。两者必须成对使用：
    画布若只用 `anchor + local` 画（漏掉 transform），而写回走完整反变换，
    那么在 `scale != 1` 的实体上"拖一个顶点、松手、顶点跳到别处"，
    且每拖一次偏得更远。
    """
    x0 = float(ent.get("x", 0) or 0)
    y0 = float(ent.get("y", 0) or 0)
    s = entity_scale_of(ent)
    rot = entity_rotation_deg_of(ent)
    out: list[dict[str, float]] = []
    for p in local_poly:
        if not isinstance(p, dict):
            continue
        wx, wy = transform_local_vec(float(p.get("x", 0)), float(p.get("y", 0)), s, rot)
        out.append({"x": round(wx + x0, 1), "y": round(wy + y0, 1)})
    return out


def collision_polygon_world_to_local(ent: dict, world_poly: list) -> list[dict[str, float]]:
    """**画布上的**世界点 → authored 局部点（拖拽写回专用）。

    ⚠ 与 :func:`legacy_world_authored_to_local` 是**两件不同的事**，别混用：

    - 本函数的输入是**画布上看到的点**，它已经含了实例 transform（画布就是照
      `anchor + T(local)` 画出来的），所以要**反变换**才能还原成干净的 authored 局部值。
    - 旧数据里的 world-authored 点是 transform **之前**的值（运行时在求值时才施加
      transform），所以迁移只能**纯平移**。

    用错的后果是静默的：拿本函数去迁移一个 `scale: 2` 的实体，命中面会**缩小一半**，
    而画面完全看不出来。老实现正是用本函数做迁移的，只因为库里一条 world-authored
    数据都没有才没出事。
    """
    x0 = float(ent.get("x", 0))
    y0 = float(ent.get("y", 0))
    s = entity_scale_of(ent)
    rot = entity_rotation_deg_of(ent)
    out: list[dict[str, float]] = []
    for p in world_poly:
        if not isinstance(p, dict):
            continue
        lx, ly = inverse_transform_world_vec(
            float(p.get("x", 0)) - x0, float(p.get("y", 0)) - y0, s, rot)
        out.append({"x": round(lx, 1), "y": round(ly, 1)})
    return out


def legacy_world_authored_to_local(ent: dict, world_poly: list) -> list[dict[str, float]]:
    """旧 world-authored 点 → 局部点：**纯平移，不反变换**。

    运行时对 world-authored 数据的口径是
    ``world = anchor + T(p - anchor) * f``（``src/utils/hotspotCollision.ts``），
    对 local 数据是 ``world = anchor + T(p_local) * f``。
    两者相等 ⟺ ``p_local = p - anchor`` —— 所以迁移是纯平移，**语义无损**。

    这里**刻意不做**反变换（那是 :func:`collision_polygon_world_to_local` 的活）。
    """
    x0 = float(ent.get("x", 0))
    y0 = float(ent.get("y", 0))
    out: list[dict[str, float]] = []
    for p in world_poly:
        if not isinstance(p, dict):
            continue
        out.append({"x": round(float(p.get("x", 0)) - x0, 1),
                    "y": round(float(p.get("y", 0)) - y0, 1)})
    return out


def migrate_scene_collision_to_local(sc: dict) -> bool:
    """把场景里所有实体的 `collisionPolygon` 归一成局部坐标；有改动返回 True。

    幂等：已经打了 `collisionPolygonLocal: True` 的原样跳过，所以重复调用安全。
    点数 <3 的退化多边形不动（那是"没有碰撞面"，不是"坐标系不对"）。
    """
    changed = False
    for list_key in COLLISION_OWNER_KEYS:
        for ent in sc.get(list_key) or []:
            if not isinstance(ent, dict):
                continue
            poly = ent.get("collisionPolygon")
            if not isinstance(poly, list) or len(poly) < 3:
                continue
            if ent.get("collisionPolygonLocal") is True:
                continue
            local = legacy_world_authored_to_local(ent, poly)
            if len(local) < 3:
                continue
            ent["collisionPolygon"] = local
            ent["collisionPolygonLocal"] = True
            changed = True
    return changed
