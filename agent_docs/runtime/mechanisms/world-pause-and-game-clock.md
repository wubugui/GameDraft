---
id: world-pause-and-game-clock
title: 世界暂停与游戏时钟
domain: runtime
type: mechanism
summary: 开面板/菜单=冻结整个游戏；演出时间一律吃 GameClock 而非 setTimeout，暂停期间原地不动
status: active
authority:
  - src/core/Game.ts#isWorldPaused
  - src/systems/gameClock.ts#GameClock
triggers:
  paths:
    - "src/core/Game.ts"
    - "src/systems/gameClock.ts"
  topics: [暂停, 冻结, 游戏时钟, waitMs, UIOverlay, 菜单]
last_governed: 2026-09-19
---

## 是什么(一句话)

玩家一开面板/菜单，**整个游戏停**；"停"的判据只有一处（`Game.isWorldPaused`），
而所有玩家看得见的等待都吃**游戏时钟**（`GameClock`）——时钟只在没暂停时前进。

## 权威源(读代码从哪进)

`Game.isWorldPaused()`（判据）、`Game.tick`（推时钟 + 各闸）、`src/systems/gameClock.ts`（时钟本体）。

## 硬契约(违反即 bug)

- **暂停判据只有一处**。`systemNotePauseDepth > 0`，或状态是
  `SceneTransition / MainMenu / UIOverlay / Dead`。加暂停源改这一个函数，不要再在 tick 里
  另写一份状态清单（2026-09-19 之前就是散着写两份：轨迹那一闸列三个状态、说明卡与死亡另走早返回，
  结果"开面板"只冻住了一半）。
- **演出时间一律走 `GameClock`，禁止 `setTimeout`**：`waitMs`、天色渐变、落雷连劈的间隔、
  雷柱软停。墙钟不认识暂停——玩家翻个背包出来会发现演出已经在背后播完了。
- **`cancelAll()` 立刻兑现在途等待**，不能悬着：悬着的话调用方的 `await` 永远不返回，
  动作批的世代检查压根轮不到、脱手演出会话的循环永远收不了尾。死亡/读档/拆除三处都调它。
- **UI 自己的东西不吃这个闸**：提示条（`notificationUI`）在面板开着时照常弹
  （2026-08-18 制作人拍板）。横幅与引导层反过来——它们是**游戏时钟**上的东西，暂停要停。
- **镜头暂停时喂 `dt = 0`** 而不是跳过 `camera.update`：平滑不动、震屏不推进，
  但 `applyTransform` 照旧（画面该**定住**，不是不画）。

## 暂停时停/不停一览

| 停 | 不停 |
|---|---|
| 血量·威胁·护火 / 交互·zone / 轨迹 / 阵风·草木 / 挂件·燃烧 / 粒子 / **角色动画** / 落雷的灯 / 镜头平滑与震屏 / 任务横幅·引导层 / **演出时钟** | 提示条 toast / Pixi 渲染与事件（面板要能点） / **音频**（音乐与在响的音效继续） |

音频不冻是刻意的：开菜单时音乐掐掉太突兀。要冻要另说，别顺手加。

## 已知坑

- `fixedTickMode`（无头/逐帧）下主循环不调 `tick`，靠 `debugStepTicks` 走 —— 那条路照常推时钟，
  所以 `waitMs` 在无头里是**按步**前进的（这正是确定性想要的）。别为了"跑快点"把时钟改回墙钟。
- 暂停期间 `setTimeout` 仍在走。凡是新写的、玩家看得见的延时，一律接 `GameClock`。

## 怎么验证

`src/systems/gameClock.test.ts` + `src/core/ActionRegistryGameClock.test.ts`。
真机判据：演出跑到一半切进 `UIOverlay`，`gameClock.now` 与 `sceneLighting.getEnvDim()`
在面板开着期间**一个数都不许变**，关掉后从原处接着走。
