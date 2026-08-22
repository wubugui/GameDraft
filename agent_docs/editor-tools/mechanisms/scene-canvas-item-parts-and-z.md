---
id: scene-canvas-item-parts-and-z
title: 场景画布的图元 part 表与内容层 z
domain: editor-tools
type: mechanism
summary: 一个实体在画布上是一束图元,清单唯一真相是 PART_TABLE;新建/重建的图元默认可见必须重贴 presence;内容层 z 按运行时排序规则的 Python 镜像实时派名次,不是写死层表
status: active
authority:
  - tools/editor/editors/scene_canvas_model.py
  - tools/editor/shared/entity_sort_math.py
  - src/rendering/entitySortRule.ts
triggers:
  paths: ["tools/editor/editors/scene_editor.py", "tools/editor/editors/scene_canvas_model.py", "tools/editor/shared/entity_sort_math.py", "src/rendering/entitySortRule.ts"]
  topics: [画布图元, part, z序, 叠放, 前后关系, spriteSort, 精灵预览, 画布显隐]
  tasks: [加画布图元, 改画布显隐, 改叠放顺序, 加实体附属图元]
verified_by:
  - tools/editor/tests/test_entity_sort_parity.py
  - tools/editor/tests/test_scene_canvas_content_order.py
  - tools/editor/tests/test_scene_canvas_z_layers.py
  - tools/editor/tests/test_scene_canvas_presence_regressions.py
  - src/rendering/entitySortRule.test.ts
last_governed: 2026-08-23
---

## 是什么(一句话)

画布上一个"实体"从来不是一个图元而是**一束**;这束有谁、这束怎么排前后,
各有一处唯一真相 —— 手写第二份就会漂,而且漂了不会报错。

## 硬契约(违反即 bug)

### 1. 图元清单只在 `PART_TABLE`

热点 = 圆点 + 展示图 + 碰撞多边形 + 透视幽灵;NPC = 圆点 + 碰撞 + 幽灵 + 巡逻折线
+ **动画精灵**。增删附属图元只改 `scene_canvas_model.PART_TABLE` 一处,
`set_entity_visible` 与各 `remove_*_graphics` 都遍历它。

**不住 `_entity_items` 的 part 走适配器**(`register_part_adapter`),不搬家:
巡逻折线住 `_patrol_overlays`、NPC 精灵住 `SceneEditor._scene_npc_runtimes`,
大量测试直接摸这两个容器。适配器让"账本走一圈"覆盖到它们而物理存储不动。

### 2. 新建/重建图元后必须重贴 presence

新图元默认可见。任何建了 part 图元的路径,末尾都要
`refresh_entity_presence(kind, id)` —— 否则被位面/时段藏起来的实体,
只要被刷新一次就冒回来**半个**(圆点还藏着、贴图回来了)。

分界是**重建**不是刷新:走 `set_points_from_model` 原地更新的那几支
(碰撞多边形等)可见性天然留着;而展示图缺件占位框那一支没有签名缓存、每次必重建。

### 3. 精灵的显隐闸门在 runtime,不在 item

`_SceneNpcAnimRuntime.draw_at` 每 8ms 被动画定时器调一次。给
`rt.item.setVisible(False)` 是**无效修法**,下一拍就被打回来 —— 必须落
`rt.set_visible()`(改 `rt.visible` 标志位)。改完看着像判定函数写错,极难反查。

**但也不能"被过滤就不建 runtime"**:`_group_geometry` 的包围盒、gizmo 的
size hint 都要读 `rt.world_w/world_h`。

### 4. 内容层 z = 运行时规则的镜像,装饰品层 z = 固定区间

- **内容**(热点展示图、NPC 精灵)经 `SceneEditor._resort_canvas_content_z`,
  用 `shared/entity_sort_math.py`(运行时 `src/rendering/entitySortRule.ts` 的
  Python 镜像)算「三档 × 档内脚底 y」的名次,再派 z 进 `[_Z_CONTENT_LO, _Z_CONTENT_HI]`。
- **装饰品**(把手/碰撞面/辅助线/gizmo/组框/标尺)是固定常量,恒在内容之上;
  **标尺(NPC 比例参考框)例外,恒在内容之下** —— 装饰品整体调整时最容易顺手
  把它一起抬上去,那样它会盖住 NPC。

不要把运行时的 ±1e7 档位偏移直接当 `zValue`:会盖穿全部装饰品。用名次映射。

排序键读**staging 感知**的真相源(`_staging_hotspot_for_canvas_drag` /
`_npc_render_pos_dict`),不是模型 —— 读模型会算出旧坐标的次序,表现为
"拖着拖着前后关系不跟着变,松手才跳一下"。同
[editor-data-sync-paradigm](editor-data-sync-paradigm.md) 硬契约 1。

## 已知坑

- **重排必须带脏检查**:巡逻预览开着时 NPC 的 y 每 8ms 都在变,不比对就每拍全场
  `setZValue`。
- **热点档位额外要求贴图真的加载成功**(运行时 `displaySprite !== null`;编辑器即
  "读出了 pixmap、没画成紫色缺件框"),**NPC 侧不要求**。这个不对称容易被顺手抹平。
- **遮挡多边形只有热点有**。NPC 的 `collisionPolygon` 不参与遮挡带,一视同仁会造出
  运行时根本不存在的层级翻转。
- **编辑器没有玩家**,故遮挡带那一支恒不生效(与运行时 `hasPlayer` 为假同分支),
  这类热点回落静态 `spriteSort`。全库仅 8 个热点受影响。
- 内容图元刻意没有 `entity_kind` 且 `NoButton`,因此不进叠放循环点选、不与
  `_saved_item_z` 互相覆盖。**别"顺手补上 entity_kind 让代码整齐"**。

## 怎么验证

`test_entity_sort_parity.py` ↔ `entitySortRule.test.ts` 钉死同一组黄金用例(改规则
必须改两处);`test_scene_canvas_content_order.py` 锁画布真的用上了它;
`test_scene_canvas_z_layers.py` 锁分层次序;
`test_scene_canvas_presence_regressions.py` 锁"该藏的没藏"整族。
