---
target: missing
date: 2026-08-07
session: 场景分组画布代理框 + 整组位移
---

现象: hotspot 的世界坐标 `collisionPolygon` 在场景加载时被 `_migrate_scene_hotspot_collision_to_local` 迁成局部坐标，**NPC 的同名字段没有任何迁移路径**——凡是「按锚点平移实体」的批量操作，只处理 hotspot 就会漏掉 NPC 的世界坐标碰撞面。
证据: `tools/editor/editors/scene_editor.py:237` 只遍历 `sc["hotspots"]`；`src/data/types.ts:985` NpcDef 同样有 `collisionPolygon` + `collisionPolygonLocal`（缺省即世界坐标）。本次整组位移初版就漏了 NPC 这一支，测试 `test_scene_group_canvas_move.py::test_drag_box_moves_every_member_including_hidden_one_command` 才逼出来。
建议: 库里缺一张「实体几何的两套坐标系（局部 vs 旧世界坐标）与谁做过迁移」的机制卡；任何新的批量平移/变换都要按该卡逐类判 `collisionPolygonLocal`，不能只照 hotspot 抄。
