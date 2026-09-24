---
id: dialogue-end-payload
title: dialogue:end 负载语义
domain: runtime
type: mechanism
summary: dialogue:end 带 source/willContinue/nestedInGraph;状态恢复只认最外层、只认恰好一次 willContinue=false 的最终 end,且只在状态仍是 Dialogue 时恢复
status: active
authority:
  - src/systems/GraphDialogueManager.ts
  - src/core/EventBridge.ts
triggers:
  paths: ["src/systems/GraphDialogueManager.ts", "src/core/GameStateController.ts", "src/core/EventBridge.ts"]
  topics: [dialogue:end, 对话链, 状态恢复]
last_governed: 2026-09-23
---

## 是什么(一句话)

对话结束事件的负载契约:图对话可 deferred 链式接续(一张图完了接下一张),消费方必须靠负载
分辨"链中间的 end"与"最终 end"。

## 权威源(读代码从哪进)

`GraphDialogueManager.ts`,搜 `willContinue`。

## 硬契约(违反即 bug)

- 监听 dialogue:end 做**状态恢复 / 世界解锁**的,只认最外层(`willContinue=false` 且非
  `nestedInGraph`);在链中间恢复状态 = 对话中途世界失控。
- **且只在状态仍是 Dialogue 时恢复**:对话末尾的动作可能已把状态切走(`openShop` → UIOverlay 等),
  那时回探索态归那一边自己收尾(关铺子自己回 Exploring)。`dialogue:end` 监听与 `startDialogueGraph`
  动作收尾两处都守这条;无条件写回 = 铺子开着玩家在后面走(2026-09-23)。
  这是"收尾硬写回探索态"那一族的一例,整族见 [game-state-handoff](game-state-handoff.md)。
- **最终 end 恰好一次**:不悬空也不重复(接续全部失败时补发)——新增接续路径必须维持这个不变量。

## 怎么验证

配一条 A 图结尾接 B 的链,断言 dialogue:end 触发两次但只有末次 `willContinue=false`;
中途让 B 加载失败,断言仍补发最终 end。
