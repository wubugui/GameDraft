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
triggers:
  paths: ["src/entities/Hotspot.ts", "src/entities/Npc.ts", "src/systems/InteractionSystem.ts", "src/core/Game.ts"]
  topics: [显隐, 实体可见性, enabled, conditionHidesEntity, 运行时字段, 实体字段写回]
last_governed: 2026-08-05
---

## 是什么(一句话)

场景实体"可见 / 可交互"的唯一合成模型:四个独立通道在实体内单点合成,外部只写自己那条。

## 权威源(读代码从哪进)

`Hotspot.ts`(通道注释 + 「四通道合成的唯一出口」);`InteractionSystem.ts` 每帧只回写
派生基底与条件两条;位面切换经 SceneManager 批量重贴派生基底(见 [plane-system](plane-system.md))。

## 硬契约(违反即 bug)

- **别直接 setEnabled 覆盖运行态**:瞬时运行态位(拾取、会话隐藏)与派生通道共用一个布尔时,
  每帧回写会把运行态冲掉——这就是四通道拆分的存在理由。
- 会话覆盖(对话/演出里改实体 enabled)在会话结束后**不被派生基底打回**,是有意语义。
- 实体 `conditions` 默认**只锁交互不隐藏**;要隐藏必须显式开 `conditionHidesEntity`
  ——内容侧最常踩。
- 拾取位持久在 sceneMemory;过场上下文**跳过**拾取/enabled 过滤是有意的(临时演员)。
- **运行时改实体字段写回 def 是逐键硬分支,没有通用写入**:NPC 与热点各一套且互不覆盖,
  **新增任何运行时可改字段必须在对应分支里自己写 def**,否则改动重进场景即丢
  (立绘换装、热点 transform 都踩过)。

## 怎么验证

切位面 / 进出对话 / 拾取三种操作交叉后读实体 active 应符合合成式;
命令通道快照的 interactables 反映真实判定。
