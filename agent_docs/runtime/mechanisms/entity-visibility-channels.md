---
id: entity-visibility-channels
title: 实体显隐四通道合成
domain: runtime
type: mechanism
summary: active = 派生基底 ∧ 条件 ∧ 会话覆盖≠false ∧ !pickedUp;四通道独立存储、实体内单点合成,禁止直接 setEnabled 冲掉运行态
status: active
authority:
  - src/entities/Hotspot.ts
  - src/systems/InteractionSystem.ts
triggers:
  paths: ["src/entities/Hotspot.ts", "src/entities/Npc.ts", "src/systems/InteractionSystem.ts"]
  topics: [显隐, 实体可见性, enabled, conditionHidesEntity]
last_governed: 2026-07-11
---

## 是什么(一句话)

场景实体"可见/可交互"的唯一合成模型:四个独立通道(派生基底=sceneMemory/过场绑定、条件、会话覆盖、拾取位)在实体内单点合成,任何一方只写自己的通道。

## 权威源(读代码从哪进)

`src/entities/Hotspot.ts`(通道注释+「四通道合成的唯一出口」);`InteractionSystem.ts` 每帧只回写「派生基底/条件」通道;位面切换经 SceneManager 批量重贴派生基底(见 [plane-system](plane-system.md))。

## 硬契约(违反即 bug)

- **别直接 setEnabled 覆盖运行态**:若把瞬时运行态位(拾取、会话隐藏)与派生通道共用一个布尔,每帧回写会把运行态冲掉——这是四通道拆分的存在理由。
- 会话覆盖(对话/演出里 setSceneEntityField enabled)在会话后不被派生基底打回,是有意语义。
- 实体 `conditions` 默认**只锁交互不隐藏**;要隐藏必须 `conditionHidesEntity:true`——内容侧最常踩。
- 拾取位持久在 sceneMemory 的 pickedUpHotspots;过场上下文跳过 pickedUp/enabled 过滤是有意的(临时演员)。

## 怎么验证

切位面/进出对话/拾取三种操作交叉后读实体 active 应符合合成式;命令通道快照的 interactables 反映真实判定。
