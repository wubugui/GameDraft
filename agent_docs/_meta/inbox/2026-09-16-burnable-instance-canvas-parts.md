---
target: scene-canvas-item-parts-and-z
date: 2026-09-16
session: 可燃物模板化 · 宿主编辑面
---

现象: 卡里写「NPC = 圆点 + 碰撞 + 幽灵 + 巡逻折线 + 动画精灵」、热点 burn part 是「燃烧布置库着火点」；可燃物模板化之后 NPC 也有 burn part，开了 burnable 的热点展示图 / NPC 精灵改画模板图（按模板真实尺寸，BurnFrame 摆法），「NPC 精灵 = 动画包 / displayImage 合成」也不再完整。
证据: tools/editor/editors/scene_canvas_model.py PART_TABLE；scene_editor.py hotspot_burn_template_view / _try_add_scene_npc_burn_sprite / set_entity_burn_markers；shared/burn_geometry.py；tools/editor/editors/tests/test_scene_editor_burn_overlay.py
建议: 已知坑里补一条「开了 burnable 的实体：图与尺寸取模板，着火点标记挂 runtime.on_drawn 跟精灵走」。
