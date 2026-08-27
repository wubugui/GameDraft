---
id: scene-view-filter-axes
title: 场景编辑器的三条视图轴(过场 / 位面 / 时段)
domain: editor-tools
type: mechanism
summary: 过场轴决定实体存不存在,位面与时段轴决定已加载实体显不显;后两条必须合成一个判定再落显隐,分开各贴各的会互相冲掉
status: active
authority:
  - tools/editor/shared/scene_view_filters.py
  - tools/editor/editors/scene_editor.py
  - src/systems/SceneManager.ts
triggers:
  paths: ["tools/editor/editors/scene_editor.py", "tools/editor/shared/scene_view_filters.py"]
  topics: [场景编辑器, 视图过滤, 位面视图, 时段视图, 过场视图, 画布显隐, 分组框, 分组时段]
  tasks: [加场景编辑器视图, 改画布显隐, 加实体归属轴]
verified_by:
  - tools/editor/tests/test_scene_view_filters_compose.py
  - tools/editor/tests/test_scene_canvas_presence_regressions.py
last_governed: 2026-08-26
---

## 是什么(一句话)

场景画布上"这个实体现在看不看得见"由三条轴共同决定,而它们**不在同一层**——
分不清就会写出"切一个视图把另一个的判定冲掉"的画布,策划照着骗人的画布排位。

## 权威源(读代码从哪进)

**判定只有一处**:`tools/editor/shared/scene_view_filters.py`(零 Qt,新老画布共用),
`scene_editor.py` 的视图过滤区(`_apply_entity_view_filters` 一带)只负责遍历与落图元。
运行时对应判定在 `SceneManager` 的三个派生基底口
(`getNpcBaseVisibleForInteraction` / `getHotspotBaseEnabledForInteraction` /
`shouldRegisterZoneWithZoneSystem`),**编辑器的口径以它为准**。
画布再写一份 = "合成一个判定"变成两份各自维护,那正是本卡要消灭的东西。

## 硬契约(违反即 bug)

- **两层,不是三条并列**:
  - **过场轴**决定实体**存不存在**——仅过场实体不加载,改选择触发场景重载。
  - **位面轴 / 时段轴**决定已加载实体**显不显**,是后置显隐开关。
- **后置显隐轴必须合成一个判定再落显隐**。每条轴各自遍历、各自写显隐 = 后跑的把先跑的
  结论冲掉(切位面会把时段藏起来的实体放出来)。再加第四条轴时同样并进那一个判定,
  不许新开一条并行的 apply。
- **时段轴前面还有一道场景总闸 `dayNight.enabled`**(2026-08-26 补)。场景没显式写
  `dayNight.enabled: true` 时,**整条时段轴不生效**——实体与分组的 `phases` 一律恒显。
  镜像口径见 `shared/scene_view_filters.scene_day_night_enabled`,与运行时
  `SceneManager.entityInPhase` 的首行同一句(只认显式 `true`)。
  - `ViewAxes.day_night_enabled` **缺省必须是 `True`**。缺省若是 `False`,所有没显式传这个
    字段的既有调用方会瞬间失去时段过滤——那是静默行为翻转,不是"更安全的缺省"。
  - 这道闸**只管时段轴**,不许上提到 `passes_view_filters` 最前面去掐位面与过场:
    位面归属和过场绑定跟场景开没开日夜没有半点关系。
  - **总闸跟场景走,不跟轴选择走**:它要在装载场景与场景属性变更时从 `scene.dayNight`
    重新派生,不能由调用方自己捏一个传进来。漏掉这条的形状是:在一个没开日夜的场景里
    给实体或分组配了 `phases`,画布按时段把它们藏起来、运行时恒显——正是本卡要消灭的
    "编辑器骗人"。
- **时段轴是三级就近取用,不是单看实体那一格**(2026-08-26 起分组也参与)。判定与运行时
  `SceneManager.entityInPhase` 同式,镜像在 `shared/scene_view_filters.passes_phase`:

      in_phase(实体.phases, 当前时段, 组.phases ?? 种类缺省)
      and in_phase(组.phases, 当前时段, 无)

  - 实体自己写了 → 实体的 ∩ 组的(组是加在全体成员之上的整体闸);
  - 实体没写、组写了 → **跟组走**(组的时段就是成员的缺省来源);
  - 都没写 → **种类缺省,这是与位面轴唯一的形状差别**:NPC = 「街上有人」那几段,
    热点 / 区域 = 全时段(见
    [day-night-npc-schedule](../../runtime/mechanisms/day-night-npc-schedule.md))。
  - **分组自己的缺省 = 不施加限制**,不套用 NPC 那条「只在白日」:分组是异构容器,
    可能同时装着人和门,借用 NPC 缺省会让一个装着门和路牌的组夜里整组消失。
  - 拿不到分组信息时传 `group=None`,行为必须与"没有分组这回事"完全一致
    (第二个 `in_phase` 恒真、第一个落回种类缺省)——不许退化成"整组隐藏"。

  编辑器把这几支一视同仁地处理 = 画布与运行时不一致,属"编辑器骗人"这一类最难查的 bug。
- **画布上那个「分组框」自己只吃时段轴,不吃位面轴、也不吃过场轴**。
  - 要吃时段:组切到自己时段之外时成员整批隐去,框还留着 = 画布上一个"框在、人没了"的
    空框,用户会以为成员数据丢了。
  - **不许吃位面/过场**:分组 dict 里根本没有 `planes` / `cutsceneIds`,走 `passes_plane`
    就落进「缺省实体」那一支——在 **exclusive(独立世界型)位面**视图下判为**不存在**,
    于是一切到梦境位面**全场分组框集体消失**,而整组位移的唯一入口就是这个框。
    这与 `FILTERED_KINDS` 挡住出生点/光环境曲线是同一个坑(缺省实体在 exclusive 下反着来),
    别顺手把分组框并进 `passes_view_filters`;它有自己的
    `passes_group_box_filters`,那不是重复实现而是**形状确实不同**。
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
分组这一支要覆盖的最小集:成员没写跟组走、成员写了取交集(含交集为空)、
`group=None` 与"没有分组"等价、分组框在 exclusive 位面视图下**不消失**。
