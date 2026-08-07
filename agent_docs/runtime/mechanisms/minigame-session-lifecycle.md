---
id: minigame-session-lifecycle
title: 小游戏会话生命周期
domain: runtime
type: mechanism
summary: 小游戏统一走 MinigameSessionManagerBase;start 的异常必须 catch→teardownSession,否则一次抛错 brick 整个子系统
status: active
authority:
  - src/systems/minigameSession.ts#MinigameSessionManagerBase
triggers:
  paths: ["src/systems/minigameSession.ts", "src/systems/*Minigame*"]
  topics: [小游戏, minigame, session]
last_governed: 2026-08-05
---

## 是什么(一句话)

各小游戏共享的会话基类,统一 start/runUntilDone/teardown 生命周期与 GameState 进出。

## 权威源(读代码从哪进)

`src/systems/minigameSession.ts` 的 `MinigameSessionManagerBase`。

## 硬契约(违反即 bug)

- **start 内任何 await 抛错必须 catch → teardownSession**:只有 finally 不够——runUntilDone 会
  永久 pending,残留的 sessionResolve 使后续所有调用直接 resolve(null),整个小游戏子系统静默 brick;
  active 后抛还会卡死 Minigame 态。
- 新小游戏管理器继承基类,不自造 session 簿记。
- 小游戏是"接管态"例外;背尸这类**任务态**玩法不是小游戏,走位面(见 [plane-system](plane-system.md))。

## 怎么验证

给 start 注入抛错,断言 GameState 回落且下一次 start 正常;runUntilDone 不悬挂。
