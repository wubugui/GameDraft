---
id: day-night-npc-schedule
title: 日夜循环与 NPC 日程(时刻不自流逝 · 离场宽限集)
domain: runtime
type: mechanism
summary: 时刻只由动作推进;transition 决定 NPC 换班演不演离场;leaving/arriving 宽限集是"绝不当着玩家的面消失"的唯一实现,判定点只挂 NPC 不进 entityInPlane
status: active
authority:
  - src/systems/DayManager.ts
  - src/systems/NpcScheduleSystem.ts
  - src/utils/dayTime.ts
  - public/assets/data/npc_schedules.json
triggers:
  paths: ["src/systems/DayManager.ts", "src/systems/NpcScheduleSystem.ts", "src/utils/dayTime.ts", "public/assets/data/npc_schedules.json"]
  topics: [日夜, 时段, timePhase, 时刻, NPC日程, 离场, 出口锚点, exitAnchors]
  tasks: [做日夜, 改时段, 配NPC作息, 加日程]
verified_by:
  - src/systems/DayNightSchedule.test.ts
last_governed: 2026-08-12
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
- **场景没写 `dayNight.enabled` = 完全不参与**:旧场景逐帧不变。没 `characterId` 或没配日程表的
  NPC 同样不受管——两道缺省闸门都是"旧数据零影响"的保证,别为图省事去掉。

## 已知坑

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
