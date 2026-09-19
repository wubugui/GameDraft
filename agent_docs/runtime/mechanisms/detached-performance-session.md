---
id: detached-performance-session
title: 脱手演出会话（技能/天气这类跑在玩家背后的演出）
domain: runtime
type: mechanism
summary: runActionsDetached 开的是第二条时间线；任何系统都能强制打断，打断＝跳过演出+补齐结算+按账本归位
status: active
authority:
  - src/systems/performanceSession.ts#PerformanceSessionManager
  - src/core/actionParamManifest.ts#PRESENTATION_ONLY_ACTIONS
  - src/core/Game.ts#buildPerformanceSessions
triggers:
  paths:
    - "src/systems/performanceSession.ts"
    - "src/core/ActionExecutor.ts"
    - "src/core/actionParamManifest.ts"
  topics: [脱手演出, 技能, runActionsDetached, 打断, 归位, 会话]
last_governed: 2026-09-19
---

## 是什么(一句话)

`runActionsDetached` 开出来的**第二条时间线**（技能、天气、远处的事故）：跑在玩家背后、玩家
全程能动；任何系统都能随时强制打断，打断＝**跳过演出 + 补齐结算 + 按账本归位**。

## 权威源(读代码从哪进)

`src/systems/performanceSession.ts`（会话、账本、打断）；分类表在
`src/core/actionParamManifest.ts` 的 `PRESENTATION_ONLY_ACTIONS` / `DETACHED_FORBIDDEN_ACTIONS`；
打断源接线在 `Game.buildPerformanceSessions()`。

## 硬契约(违反即 bug)

- **三层**（制作人 2026-09-19 拍板）：**结算**必须发生、**演出**整段丢掉、**归位**跑满且瞬间。
  "打断"是跳过演出，**不是**取消技能——玩家放了符，鬼必须没。
- **打断＝快进，不是砍断**：剩下的动作照跑，只有 `PRESENTATION_ONLY_ACTIONS` 里的整条跳过。
  `waitMs` 在表里，所以"等待归零"是副产物，别另写一套时长改写。
  ⚠ **缺省是「跑」不是「跳」**：漏登记一条演出动作最坏是它闪在过场上面；反了（把结算当演出跳掉）
  就是玩家放了技能什么都没发生。护栏 `test_no_save_writing_action_is_ever_skipped`。
- **归位靠账本，不靠作者记得写**：演出期间动过的旋钮（天色 / 音频闪避 / 震屏 / 雷光 / 阵风 /
  一次性长音 / 粒子实例）都记在会话名下，会话一结束按**倒序**释放。数据里那几拍收尾是**保险**。
  - 天色比的是**目标值**不是当前值：作者写了「慢慢放晴」时，最后一条动作返回那一刻渐变还在跑，
    拿当前值判断会把 2.6 秒的放晴一巴掌拍成瞬间。
- **打断必须同步**：切场景 / 死亡 / 读档都是同步收尾路径，等一个微任务场景就已经卸了，
  结算会落到新场景头上。所以补跑走 `runActionSync`（`executeAwait` 在第一个 await 之前
  就把 handler 同步调掉了，同步结算当场落地）。
- **`cancelPending()` 之前必须先 `interruptAll()`**：前者只把批停在两条动作之间，剩下的结算与
  归位一条都不跑——世界会停在"天是黑的、背景音是哑的、闷雷还在响"那一帧（2026-09-19 原始故障）。
  `enterDeath` / `distributeSaveData` 两处都已按这个顺序。
- **顶替按 `id` 算**：同名再开播，前一段当场按打断收掉（不叠加）。不写 id 的都叫 `detached`。
- **脱手批里不许有抢控制权 / 换世界的动作**（`DETACHED_FORBIDDEN_ACTIONS`），校验器报 error。

## 打断源（谁能打断）

| 打断 | 不打断 |
|---|---|
| 过场开演（`Cutscene`）、进小游戏（`Minigame`）、切场景（`SceneTransition` + `scene:beforeUnload` 兜底）、死亡、读档、回主菜单、拆除 | **对话、遭遇、面板** —— 雷在背景劈着、NPC 在旁边说话是好演出，只有全屏接管才必须清场 |

状态那一路走 `GameStateController.setStateChangeObserver`（**同步**旁听席，不是事件总线）：
要的是"状态一写完就收摊"，晚一个微任务演出就闪在过场第一拍上面。

## 与「暂停」的关系

打断与暂停是**两件事**，别混：打断是**收摊**（演出没了、结算补齐、归位做满），
暂停是**按住**（演出原地不动，等玩家关面板再接着演）。
面板 / 菜单 / 说明卡一律**暂停**不打断——见 [world-pause-and-game-clock](world-pause-and-game-clock.md)。
脱手演出的等待吃游戏时钟，所以"开背包 → 雷停在半空"是自动成立的，不用会话自己管。

## 已知坑

- **嵌套容器**：打断时只有**顶层**时间线是同步补跑的；容器里剩下的动作靠
  `executeBatchAwait` 里的 `scope.session.hurried` 过滤，要晚一个微任务才收。
  校验器对此报 warning，脱手演出的时间线**尽量摊平写**。
- `strikeThreat` 是"既结算又演出"的那一类：它读 `scope.session.hurried` 走 `silent` 档
  （只收靶子，不放雷柱/不亮/不响/不闪/不震）。同类动作照这个模式办，别塞进跳过表。

## 怎么验证

`src/systems/performanceSession.test.ts`（会话语义）+ `tools/editor/tests/test_run_actions_detached.py`
（两张表的护栏 + 校验器四条规矩）。真机判据：演出跑到一半切状态，`performanceSessions.activeIds()`
当场清空、`sceneLighting.getEnvDim()` 与 `audioManager.getAudioDuck()` 回到进入前、
长音停、而**结算已落地**（背包/实体可见性能查到）。
