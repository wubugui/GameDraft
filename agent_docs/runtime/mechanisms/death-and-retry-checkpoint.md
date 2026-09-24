---
id: death-and-retry-checkpoint
title: 死亡与重试检查点
domain: runtime
type: mechanism
summary: 耗尽→冻结世界→说明卡→"从安全点重试 / 回主菜单";检查点是一份完整存档快照,只在安全窗口拍、动作只登记请求不等;enterDeath 的收摊顺序(先打断会话再 cancelPending 再兑现时钟)是硬契约;死亡闸把任何"还回探索态"钉回 Dead
status: active
authority:
  - src/systems/RetrySystem.ts
  - src/core/GameStateController.ts#setDepletionGuard
  - src/core/Game.ts#distributeSaveData
triggers:
  paths:
    - "src/systems/RetrySystem.ts"
  topics: [死亡, 重试, 检查点, setRetryCheckpoint, 安全点, Dead, 死亡说明卡, 三把火熄了]
  tasks: [加重试检查点, 改死亡流程, 排查死后状态残留, 排查重试后丢东西]
verified_by:
  - src/systems/RetrySystem.test.ts
  - src/core/GameStateControllerPanelRequest.test.ts
last_governed: 2026-09-23
---

## 是什么(一句话)

普通死亡(系绳不接管时)→ 冻结世界 → 说明卡 → 选"从上一个安全点重试 / 返回主菜单";
安全点 = 一份完整存档快照,存在 `RetrySystem` 自己的存档桶里。

## 权威源(读代码从哪进)

`RetrySystem`(检查点、死亡演出协程、重试);接线在 `Game` 里 `retrySystem.connect`(`enterDeath` 收摊顺序、
安全窗口判据、说明卡、选择框);死亡闸 `GameStateController.setDepletionGuard`;耗尽来源见
[health-and-threat](health-and-threat.md)。

## 硬契约(违反即 bug)

- **检查点只在安全窗口拍**:探索态 + 有场景 + 可存档(未耗尽、无说明卡、叙事编排空闲)。
  `setRetryCheckpoint` **只登记请求、不等窗口**——动作本身持有探索锁,等窗口会自锁死;
  所以拍到的是请求**之后**第一个安全帧的世界。没有检查点时首个安全帧自动拍一份开局点。
- **快照剔除自身桶**(否则存档体积递归增长);代价是每份普通存档都内嵌一份完整检查点。
- **`enterDeath` 收摊顺序**:打断全部脱手演出 → `cancelPending` → 游戏时钟 `cancelAll`(兑现在途等待)→ 清阵风 →
  过场 / 对话图 / 对话清空 → 关对话框、面板、选择框 → 置 Dead。**先打断再 cancelPending**:反过来批停在两条动作之间,
  结算与归位永不执行,世界停在"天黑、音哑、闷雷还响"那一帧(2026-09-19 原始故障)。读档路径同一顺序。
- **死亡闸**:耗尽期间除 UIOverlay / MainMenu 外的任何目标状态都被改写成 Dead——旧演出 / 批的收尾"还回探索态"
  会被钉回去;只有读档让血量反序列化成非耗尽,探索态才写得进去。
- **死亡只开一次**(演出协程带世代闸);说明卡优先伤害来源指定的那张,否则用配置的首死说明卡;每条时间线只弹一次。
- **重试 = 读检查点载荷,但把"当前检查点"与"已读说明卡"带进新时间线**,其余(背包、钱、血、叙事、站位)完整回退。
- **读档失败时存档管理器回滚;回滚后仍是死亡才重新给入口**,不解锁成零血探索。任何读档都作废在途死亡协程;
  旧档没有本系统的桶时显式清空检查点。
- **跟着时间线走的开关必须进档**:重试是读档,不进档的东西死一次就丢(例:跟脚声开关进档、在途那一步不进)。

## 已知坑

- 死亡路径不清**非会话**批留下的震屏 / 压暗 / 闪白:Dead 时 tick 早退,它们会以当时的样子定格在死亡画面上,
  直到重试读档。会话里的由会话打断归位,不受影响。
- `closeAllPanels()` 不清覆盖层返回栈,而 `enterDeath` 走的正是它。
- 读档后回不回探索态取决于场景重载的收尾(只在非对话 / 过场 / 遭遇 / 小游戏时写 Exploring);死亡闸保证耗尽档读回仍是 Dead。

## 怎么验证

`npx vitest run src/systems/RetrySystem.test.ts src/core/GameStateControllerPanelRequest.test.ts`
(含"死亡后的旧演出收尾不能恢复探索")。真机:放雷符放到一半被打死 → 重试,检查点之后拿到的东西没了、
已读说明卡不再弹、`performanceSessions.activeIds()` 为空、无残留雷光 / 闷音。
状态机本身(唯一写入口、旁听席、条件恢复)见 [game-state-handoff](game-state-handoff.md)。
