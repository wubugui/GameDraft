---
id: day-night-npc-schedule
title: 日夜循环与 NPC 日程(时刻不自流逝 · 离场宽限集)
domain: runtime
type: mechanism
summary: 时刻只由动作推进;phases 三级就近取用(实体→分组→种类缺省)且分组不套 NPC 的白日缺省;transition 决定 NPC 换班演不演离场;leaving/arriving 宽限集是"绝不当着玩家的面消失"的唯一实现,判定点只挂 NPC 不进 entityInPlane
status: active
authority:
  - src/systems/DayManager.ts
  - src/systems/NpcScheduleSystem.ts
  - src/systems/SceneManager.ts
  - src/utils/dayTime.ts
  - public/assets/data/npc_schedules.json
triggers:
  paths: ["src/systems/DayManager.ts", "src/systems/NpcScheduleSystem.ts", "src/systems/SceneManager.ts", "src/utils/dayTime.ts", "public/assets/data/npc_schedules.json"]
  topics: [日夜, 时段, timePhase, daylight, 街上有人, 时刻, NPC日程, 离场, 出口锚点, exitAnchors]
  tasks: [做日夜, 改时段, 配NPC作息, 加日程]
verified_by:
  - src/systems/DayNightSchedule.test.ts
  - tools/editor/tests/test_day_night_parity.py
  - tools/editor/tests/test_day_night_daylight_gate.py
last_governed: 2026-08-26
---

## 是什么(一句话)

同一场景按「时刻」换面貌、NPC 按「日程」来去的基建;而 **NPC 绝不当着玩家的面凭空消失**——
看得见时它走到出口才隐去,看不见时才直接按表摆位。

## 权威源(读代码从哪进)

`DayManager`(时刻真相源,文件头注释即模型)+ `NpcScheduleSystem`(查表 + 离场演出,
文件头注释写了两条路径的分界)+ `utils/dayTime.ts`(跨零点纯函数)。
玩法定义在 `docs/玩法功能需求清单.md` H3/H4。

## 硬契约(违反即 bug)

- **时刻不自流逝**:`update()` 里没有任何累加,推进只经 `advanceTime` / `advanceTimeTo` / `endDay`。
  这是玩法定调(H1/H3),不是实现偷懒——叙事驱动的游戏里时钟自由跑,玩家会在长对话中途莫名天黑。
- **只有 `transition: 'seamless'` 演离场**;`timelapse`/`fade`/`cut` 有画面遮挡,遮挡期间直接重贴。
  这是四档存在的**唯一理由**,别把它当"动画时长"用。
- **`leaving` / `arriving` 宽限集不可绕过**:离场演出期间日程判定已翻转成"不在场",
  不用宽限集兜住,`InteractionSystem` 每帧派生回写会在 NPC 走到一半时把它抹掉。
  改任何一处显隐前,先确认这条还成立。
- **判定点只挂 NPC**:接在 `SceneManager.getNpcBaseVisibleForInteraction`,
  **不能**并进 `entityInPlane`——后者被 hotspot/zone 共用,日程是角色的行踪,热点区域不该跟着 NPC 走。
- **`moveTo` 的 Promise 被打断时也 resolve**(对话开始会 `cancelActiveMove`),
  落定 ≠ 到达。到没到**一律用坐标判定**,没到就在下一个探索态帧重发——
  这同时也是"绝不在对话中途走人"的实现(非 Exploring 不重发,回探索态自动续走)。
- **日程不入存档**:它是 `f(时刻, 条件)` 的派生结果;只有 `setOverride` 写的剧情覆盖入档
  (与位面「零自持久化」同哲学)。
- **场景没写 `dayNight.enabled` = 完全不参与**:旧场景逐帧不变(日程与 `phases` 两条都不生效)。
  没 `characterId` 或没配日程表的 NPC 同样不受日程管——这些缺省闸门是"旧数据零影响"的保证,
  别为图省事去掉。
- **`phases` 是三级就近取用,缺省按实体种类分叉,不是统一的"全时段"**
  (2026-08-12 内容定调;2026-08-26 补入分组这一级)。判定的唯一公式(权威在
  `SceneManager` 的派生基底口,`utils/dayTime.isEntityInPhase` 是纯函数):

      有效在场 = isEntityInPhase(实体.phases, 当前时段, 组.phases ?? 种类缺省)
              && isEntityInPhase(组.phases,   当前时段, 无)

  展开成人话——**就近的那一层说了算,分组是加在全体成员之上的整体限制**:
  - 实体自己写了 `phases` → 与组的取**交集**(交集为空 = 这些成员一天都不出现)。
  - 实体没写、所属组写了 → **跟组走**:组的清单就是成员的缺省来源。
    给整队人配一次"夜里出现"即可,**不必再逐个勾**——漏勾一个就是一份永不出现的死内容。
  - 都没写 → **种类缺省**:**NPC = 只在标了 `daylight` 的那几段出没**,热点与 zone = 全时段都在。
    理由:这个世界的人白天做事、天黑归家,"街上有人"是特例;而门、路牌、可拾取物夜里当然还在。
  - **分组自己的缺省 = 不施加限制**,它**没有** NPC 那条"只在白日"。理由:分组是**异构容器**,
    一个组可能同时装着人和门;借用 NPC 的缺省会让一个装着门和路牌的组夜里整组消失。
    ——所以"组没配时段"与"组配了时段"是两件事,别把前者当成"组=白日"。
  - **分组的时间一律写 `phases`,不许写 `conditions` 里的 `{timePhase:…}`**:
    条件在另一层(`InteractionSystem` 的条件通道),**不吃场景日夜总闸**、刷新时机也不同,
    且与成员的 NPC daylight 缺省是纯 AND —— 这正是下面那条已知坑的根因。
  改这些缺省会静默改变**所有**已开日夜场景的夜间人口,动之前先想清楚。
- **场景级总闸对分组一视同仁**:`scene.dayNight.enabled !== true` 时整套时段判定不生效(恒显),
  组的 `phases` 同样不生效。别在没开日夜的场景里靠组的 `phases` 藏东西——那儿它是死字段。
- **代码里不许出现时段 id 字面量**(2026-08-18 事故后定): 哪几段算"白天有人"由内容侧在
  `game_config.dayNight.phases[].daylight` 上标,运行时只认这个语义角色
  (`dayTime.daylightPhaseIds` → `DayManager.daylightPhases` → `SceneManager` 注入口)。
  时辰是内容侧的设定(本作是 `辰/午/暮/夜`),不是引擎的概念——代码存了 id,内容一换词表就恒假。
  要新增"代码需要理解的时段语义"(如遭遇率、光照),加**新的角色标记**,不要去比 id。
- **一段都没标 `daylight` = fail-open**(全时段都在)+ `DayManager.configure` 告警一次,
  **绝不静默清空**。告警只能放在 configure(每帧每实体调用的判定点上告警会刷屏)。
  构建期那一半由 `validator._validate_day_night` 兜(仅当真有场景开了日夜时才报)。

## 已知坑

- **2026-08-26「雾津送葬队伍 13 人永不出现」**:`雾津街头.json` 的分组「雾津送葬队伍」
  想表达"夜里出殡",但当时**分组身上没有 `phases` 这一格**——策划只能退而求其次,
  在组的 `conditions` 里写 `{timePhase:"夜"}`。而它的 13 个 NPC 成员都没写 `phases`,
  于是各自拿到 NPC 的种类缺省白名单 `[辰,午]`(只白日)。两者是**纯 AND**:
  组要"夜"、成员只"白天",**交集恒空 → 这 13 个人一天 24 小时都不会出现**。
  而且**校验器全绿**:两边单看都是合法配置,没有任何一层看得见"合起来恒假"。
  修法是给分组补 `phases`(2026-08-26 落地),数据侧把那条 `timePhase` 条件迁成
  `"phases": ["夜"]`,成员继续不写、跟组走。
  **教训**:同一个语义(时间)在两条不同的通道上各有一半表达能力时,内容侧一定会
  用错的那条把自己写死;正确的收敛方向是**把缺的那一格补上**,而不是在文档里嘱咐
  "记得两边都要配"——恒假的配置没有任何红字,只是"没人出现",肉眼分不出是不是设计如此。
- **2026-08-18「整条街一个人都没有」**:内容侧 8/7 起就在生态图里用中文时段 id,
  8/13 日夜落地时代码带了英文内置兜底表,8/14 一个叫「打字机文本设置」的提交
  顺手塞进 `NPC_DEFAULT_PHASES = ['day']`——当时 `Game` 的逐键白名单还漏着 `dayNight`,
  配置根本读不进来,所以它**当场是对的、测试全绿**。等到白名单补上、中文表真正生效那一拍,
  `'day'` 变成悬垂引用,全场 NPC 判定恒假,雾津街头 32 个 NPC 全天不可见。
  同一个白名单漏洞还让 40+ 生态图的 `{timePhase:…}` 条件恒假了近两周,一声不吭。
  **教训有两条**:(1) 代码存内容侧的 id 就是定时炸弹,引信是"哪天配置真的接通";
  (2) 语义改动不要搭车塞进无关提交,`git log` 事后根本翻不出来。
- 日程**没覆盖到**的时段等于「不受管」(回落成普通常驻 NPC),不是「不在场」。
  validator 的「日程没覆盖全天」warning 提醒的就是它。
- 时段表天然是环:时刻早于第一段起点时属于**最后一段**(01:40 属于前一晚的 night),
  别"修"成回落第一段。`isWithinRange` 的起止相等语义是**整天**,不是零长度。
- 时刻镜像进 flag 只有 `minutesOfDay`(数值);**时段是字符串,FlagStore 只收 bool/number**,
  故判时段一律走 `{timePhase:…}` 条件叶,别去找 flag。
- 推进时刻的那一拍必须**当拍**建好宽限集(`onTimeChanged` 的 seamless 分支里直接检边沿),
  等下一帧 `update` 会留一个"判定已翻转、宽限集未建立"的窗口,NPC 会闪一下。
- 条件求值别用 `evaluateAllGraphConditions`——它自拼缩水上下文(缺 plane/posture/timePhase),
  必须走 `Game.buildConditionEvalContext()`。

## 怎么验证

`src/systems/DayNightSchedule.test.ts`(24 例:跨零点工具、跨日 endDay 联动、宽限集、打断续走)。
真机走[命令通道](../recipes/runtime-command-channel.md)页内注入日程 + Dev Mode「日夜」分区盯
`leaving`/`arriving`:**正在离场的 NPC 必须同时显示「在场」**,一旦某个 NPC 不在这两行里却已经
不见了,就是穿帮。
