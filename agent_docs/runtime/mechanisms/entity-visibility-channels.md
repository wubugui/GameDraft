---
id: entity-visibility-channels
title: 实体显隐四通道合成
domain: runtime
type: mechanism
summary: 四个独立通道(派生基底/条件/会话覆盖/拾取位)在实体内单点合成;任何一方只写自己的通道,禁止直接 setEnabled 冲掉运行态
status: active
authority:
  - src/entities/Hotspot.ts
  - src/systems/InteractionSystem.ts
  - src/systems/SceneManager.ts
triggers:
  paths: ["src/entities/Hotspot.ts", "src/entities/Npc.ts", "src/systems/InteractionSystem.ts", "src/systems/SceneManager.ts", "src/core/Game.ts"]
  topics: [显隐, 实体可见性, enabled, conditionHidesEntity, 运行时字段, 实体字段写回, 分组显隐, 时段归属, phases]
last_governed: 2026-08-26
---

## 是什么(一句话)

场景实体"可见 / 可交互"的唯一合成模型:四个独立通道在实体内单点合成,外部只写自己那条。

## 权威源(读代码从哪进)

`Hotspot.ts`(通道注释 + 「四通道合成的唯一出口」);`InteractionSystem.ts` 每帧只回写
派生基底与条件两条;**派生基底本身怎么算,权威在 `SceneManager`**——
`getHotspotBaseEnabledForInteraction` / `getNpcBaseVisibleForInteraction` /
`shouldRegisterZoneWithZoneSystem` 三个口,位面、时段、分组、NPC 日程、过场绑定、
运行时覆盖都在那里串成一串 and(见 [plane-system](plane-system.md)、
[day-night-npc-schedule](day-night-npc-schedule.md));位面切换 / 时刻推进时同样经
SceneManager 批量重贴派生基底,不是等下一帧慢慢刷。

## 硬契约(违反即 bug)

- **别直接 setEnabled 覆盖运行态**:瞬时运行态位(拾取、会话隐藏)与派生通道共用一个布尔时,
  每帧回写会把运行态冲掉——这就是四通道拆分的存在理由。
- 会话覆盖(对话/演出里改实体 enabled)在会话结束后**不被派生基底打回**,是有意语义。
- 实体 `conditions` 默认**只锁交互不隐藏**;要隐藏必须显式开 `conditionHidesEntity`
  ——内容侧最常踩。
- **派生基底通道现在也吃分组的时段**(2026-08-26):`entityGroups[].phases` 与实体自己的
  `phases` 同构、同在**派生基底**这一条通道里合成(实体的 ∩ 组的;实体没写就跟组走),
  两者都吃场景的 `dayNight.enabled` 总闸。**分组的 `conditions` 不是这条通道**——
  它走条件通道,不吃日夜总闸、刷新时机也不同。所以**分组的时间一律用 `phases` 表达**,
  在 `conditions` 里写 `{timePhase:…}` 会与成员的 NPC daylight 缺省纯 AND 对撞成恒假,
  且校验器全绿(2026-08-26「雾津送葬队伍 13 人永不出现」,根因见
  [day-night-npc-schedule](day-night-npc-schedule.md) 的已知坑)。
  推论:新增任何"整组维度的存在性开关"时,先问它该落派生基底还是条件通道——
  落错通道不会报错,只会在某些时机静默失效。
- 拾取位持久在 sceneMemory;过场上下文**跳过**拾取/enabled 过滤是有意的(临时演员)。
- **运行时改实体字段写回 def 是逐键硬分支,没有通用写入**:NPC 与热点各一套且互不覆盖,
  **新增任何运行时可改字段必须在对应分支里自己写 def**,否则改动重进场景即丢
  (立绘换装、热点 transform 都踩过)。

## 怎么验证

切位面 / 进出对话 / 拾取三种操作交叉后读实体 active 应符合合成式;
命令通道快照的 interactables 反映真实判定。
