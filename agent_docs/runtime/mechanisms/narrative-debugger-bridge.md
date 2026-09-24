---
id: narrative-debugger-bridge
title: 叙事调试器桥与断点闸
domain: runtime
type: mechanism
summary: 断点闸把叙事队列停住;停住期间"冻的是什么"和"谁能放行"各有一条会静默死锁的坑
status: active
authority:
  - src/core/NarrativeStateManager.ts#breakpointGate
  - src/core/Game.ts
  - src/dev/narrativeDebugBridge.ts
  - tools/narrative_debugger/breakpoints.py
verified_by:
  - src/core/NarrativeBreakpoint.test.ts
triggers:
  paths: ["src/core/NarrativeStateManager.ts", "src/dev/narrativeDebugBridge.ts", "tools/narrative_debugger/**"]
  topics: [叙事调试器, 断点, breakpoint, 单步, 冻结, 时间线]
  tasks: [改叙事调试器, 加断点, 查"断住就再也动不了", 改冻结/暂停]
last_governed: 2026-09-23
---

## 是什么(一句话)

一条把叙事状态机停在某一拍、交给外部工具检视再放行的闸;开关与持久化那一半的纪律在
[debug-ui-persistence](debug-ui-persistence.md),这里只讲**停住之后**的契约。

## 权威源(读代码从哪进)

放行闸挂在 `src/core/NarrativeStateManager.ts` 的 `breakpointGate` 静态钩子上;
闸的实现(放行集合、冻结、断点徽标)在 `src/dev/narrativeDebugBridge.ts`,`src/core/Game.ts` 负责装/拆与现场开关;
工具侧在 `tools/narrative_debugger/`。

## 硬契约(违反即 bug)

- **放行钩子必须是集合,不能是单槽**。引擎允许嵌套排空,而断住期间**不冻定时器**——
  于是断住的这段时间里第二条链也会撞上断点。单槽会把前一条的放行函数覆盖丢掉:
  那条 promise 永不落定 ⇒ 队列那一格永不落定 ⇒ "空闲"判定永假 ⇒ **存不了档**;
  若那条信号正被某批动作 await,玩家直接卡死。
- **冻结只盖住每帧 tick 是不够的**。至少还有两处独立于 tick:①按键的"刚按下"边沿在跳过 tick
  期间会一直攒着,放行后同一帧全部生效;②UI 的输入事件与 tick 无关,面板照样点得动。
  两处都要单独处理,且**改事件模式前必须记住原值**(缺省不是你以为的那个)。
- **一个 hub 挂多个游戏页签时,切走的那个必须当场卸干净**(清断点、解除单步武装、放行、
  关自动记点)才能切走。否则它可能正停在断点上,而"继续"发给了**别人**——这正是早期
  "第二个页签连上就把旧的踢掉"要解决的同一个死局,只是换了解法。
- **后台页签只更新自己的状态,不写时间线**;每个页签各存一条,切回去还是离开时那一屏。

## 已知坑

- 想开调试器的时刻恰恰是刚出问题那一刻,所以开关必须**可热插拔**——只留"改地址栏再整页重启"
  这一条路,等于每次都把现场弄没。
- **`tools/narrative_debugger/tests` 里有几条断言写死了真实编排数据的形状**(主线拍名、某张主图挂几张子图、
  拍子行数下限),编排一重构就在干净 HEAD 上红(2026-09-17 起 4 条,与调试器代码无关)。改调试器前先在基线上跑一遍
  认清既有红;修这类测试要改成按真实数据现算或用合成 fixture,别再把内容数据写进断言。
- 拆桥的多份实现漂开的症状是"点一下上报两条"(热替换后尤其明显),
  单一拆桥路径见 [teardown-ordering](teardown-ordering.md)。

## 怎么验证

`src/core/NarrativeBreakpoint.test.ts`;人工验"断住期间再来一条链"能否两条都放行,
以及放行后按键不会连发。
