---
target: runtime-norms
date: 2026-08-08
session: 叙事调试器易用性（四入口开关 + 多页签调试对象）
---

现象: 叙事调试器过去只有一条开关路径（地址栏 `?ndbg=1` + 整页重启），而想开调试器的时刻恰恰是刚出问题那一刻——重启一次现场就没了；且 hub 与游戏是 1:1，第二个页签连上会把旧的踢掉。本轮把开关做成可热插拔的四入口、hub 改成可挂多页签，库内暂无对应卡。
证据:
 ① 开关四入口共用 `Game.enableNarrativeDebugBridge` / `disableNarrativeDebugBridge`（F2「叙事调试器」区块、`window.__ndbg.on()/off()/status()`、标题界面 `MenuDevHooks`、URL）；**持久化落工程文件** `resources/editor_projects/editor_data/narrative_debugger_bridge.json`（vite 中间件 `/__gamedraft-api/narrative-debug`），localStorage 只当首帧种子——与 debug-ui-persistence 卡同一条纪律，该卡的 authority 清单可加这一处。
 ② **拆桥必须单一路径**：destroy 与"现场关掉"共用 `teardownNarrativeDebugBridge()`（摘五个事件 + 两个静态 observer + dispose）。两份拆法漂掉就是 HMR 后"点一下上报两条"。
 ③ **异步读回来的偏好不许覆盖人刚扳的开关**：工程文件是 fetch 回来的旧值，中途人点了标题界面那行就会被覆盖回去（`narrativeDebugUserDecided` 闸）。属"旧时间线不写新状态"的一个新面。
 ④ hub 多目标（`GameTarget`）替代了 1:1 踢人：切走的页签必须当场 `setBreakpoints []` + `disarmStep` + `continue` + 关自动记点，否则它可能正停在断点上而「继续」发给了别人——这是原来"踢掉旧页签"要解决的同一个死局，换了解法。inbox 2026-08-06 第 ⑤ 条（调试器与游戏 1:1）**已被本轮取代**，蒸馏时别照原样入卡。
 ⑤ 后台页签只更新自身状态（供下拉显示场景名）、不写时间线；每个页签各存一条时间线，切回去还是离开时那一屏。
建议: 治理时把「叙事调试器开关的四个入口 + 单一拆桥路径」并进 debug-ui-persistence 或另起一张 runtime 机制卡；顺手把 2026-08-06 那条 ⑤ 标为已取代。
