---
id: scene-view-filter-axes
title: 场景编辑器的三条视图轴(过场 / 位面 / 时段)
domain: editor-tools
type: mechanism
summary: 过场轴决定实体存不存在,位面与时段轴决定已加载实体显不显;后两条必须合成一个判定再落显隐,分开各贴各的会互相冲掉
status: active
authority:
  - tools/editor/editors/scene_editor.py
  - src/systems/SceneManager.ts
triggers:
  paths: ["tools/editor/editors/scene_editor.py"]
  topics: [场景编辑器, 视图过滤, 位面视图, 时段视图, 过场视图, 画布显隐]
  tasks: [加场景编辑器视图, 改画布显隐, 加实体归属轴]
verified_by:
  - tools/editor/tests/test_scene_view_filters_compose.py
  - tools/editor/tests/test_scene_canvas_presence_regressions.py
last_governed: 2026-08-23
---

## 是什么(一句话)

场景画布上"这个实体现在看不看得见"由三条轴共同决定,而它们**不在同一层**——
分不清就会写出"切一个视图把另一个的判定冲掉"的画布,策划照着骗人的画布排位。

## 权威源(读代码从哪进)

`tools/editor/editors/scene_editor.py` 的视图过滤区(画布类内,`_apply_entity_view_filters`
一带);运行时对应判定在 `SceneManager` 的两个派生基底口,编辑器的口径以它为准。

## 硬契约(违反即 bug)

- **两层,不是三条并列**:
  - **过场轴**决定实体**存不存在**——仅过场实体不加载,改选择触发场景重载。
  - **位面轴 / 时段轴**决定已加载实体**显不显**,是后置显隐开关。
- **后置显隐轴必须合成一个判定再落显隐**。每条轴各自遍历、各自写显隐 = 后跑的把先跑的
  结论冲掉(切位面会把时段藏起来的实体放出来)。再加第四条轴时同样并进那一个判定,
  不许新开一条并行的 apply。
- **缺省口径按实体种类分叉,不是统一的"全都在"**:时段轴上 NPC 与 热点/区域缺省不同
  (见 [day-night-npc-schedule](../../runtime/mechanisms/day-night-npc-schedule.md))。
  编辑器把两者一视同仁地处理 = 画布与运行时不一致,属"编辑器骗人"这一类最难查的 bug。
- **判定顺序照抄运行时**:运行时是把各轴串成一串 and,过场绑定判定排在时段/位面**之后**,
  故过场专用实体**同样吃**时段与位面过滤。画布不得为了"方便编辑"擅自放行。
- **纯视图,不改数据**:三条轴都只影响画布显隐/加载,任何一条都不得写回实体字段。
  批量操作(整组位移等)作用于**全部成员**而不只是可见的那些,故必须当面告知
  "其中 N 个在画布上不可见"。
- **"藏一个实体"= 藏它的每一个图元**。判定对了不等于藏对了:一个实体在画布上是
  一束图元,漏掉其中一层就是"圆点没了、人还站着"。清单唯一真相是 `PART_TABLE`,
  且新建/重建的图元默认可见、必须重贴 presence —— 详见
  [scene-canvas-item-parts-and-z](scene-canvas-item-parts-and-z.md)。
  本卡管**判定**,那张卡管**落到哪些图元**,两者缺一不可。

## 已知坑

- 切场景/重载会清空实体登记表,但**视图选择保留**——重建时必须按当前选择重新套用,
  否则重载后过滤静默失效(画布显示的是"全部",策划以为那就是该时段的样子)。
- 缺省清单为空时按"不施加限制"处理,不是"全部隐藏"。这条与运行时的 fail-open 同源:
  宁可画布上多几个,绝不静默清空整场景。
- 候选来自 game_config 的时段表 / 位面登记,**改完那两处要刷新下拉候选**
  (跨面板刷新约定,见 editor-tools norms 过程义务)。选中项被删则回落到"全部"。

## 怎么验证

`tools/editor/tests/test_scene_view_filters_compose.py`:两个方向的互不冲掉、两轴 and、
种类分叉缺省、空清单 fail-open、重载后重贴、过场实体照吃时段过滤。
新增轴时在这里补对应方向的用例——**只测单轴不算测过**,互相冲掉正是本卡存在的理由。
