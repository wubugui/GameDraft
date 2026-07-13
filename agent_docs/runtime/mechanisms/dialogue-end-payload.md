---
id: dialogue-end-payload
title: dialogue:end 负载语义
domain: runtime
type: mechanism
summary: dialogue:end 带 source/willContinue/nestedInGraph;状态恢复只认最外层、只认恰好一次 willContinue=false 的最终 end
status: active
authority:
  - src/systems/GraphDialogueManager.ts
triggers:
  paths: ["src/systems/GraphDialogueManager.ts", "src/core/GameStateController.ts"]
  topics: [dialogue:end, 对话链, 状态恢复]
last_governed: 2026-07-11
---

## 是什么(一句话)

对话结束事件的负载契约:图对话可以 deferred 链式接续(一张图完了接下一张),消费方必须靠负载分辨"链中间的 end"与"最终 end"。

## 权威源(读代码从哪进)

`GraphDialogueManager.ts`(搜 willContinue):`willContinue = deferredGraphQueue.length > 0`;链条全部接续失败时补发恰好一次 willContinue=false 的最终 end。

## 硬契约(违反即 bug)

- 监听 dialogue:end 做**状态恢复/世界解锁**的,只认最外层(`willContinue=false` 且非 `nestedInGraph`);在链中间恢复状态=对话中途世界失控。
- 最终 end 恰好一次:不悬空也不重复——新增接续路径时必须维持这个不变量。

## 怎么验证

配一条 A 图结尾 startDialogueGraph B 的链,断言 dialogue:end 触发两次但只有末次 willContinue=false;中途让 B 加载失败断言补发。
