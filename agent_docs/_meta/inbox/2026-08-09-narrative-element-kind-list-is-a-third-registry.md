---
target: narrative-state-editor
date: 2026-08-09
session: 叙事状态机探索（产物已 revert，本发现独立成立）
---

现象: 卡里只说「校验三方，Python 兜底是 TS 权威的子集」，但**新增 composition element kind** 时真正要动的登记面有三处，且彼此不对账：`src/core/narrativeGraphValidation.ts` 的 `isElementKind` 白名单 + 两处 `el.kind === 'wrapperGraph' || 'scenarioSubgraph'` 硬判、web 侧的同名清单、`tools/editor/editors/narrative_state_editor.py` 里同形状的硬判。漏掉其中任一处**都不报错**，只是那类元素的内嵌图静默不过 `validateGraph`（状态/转移/条件零校验），并可能被误报 `blackbox.ref.empty`——跑测试看不出来。
证据: `narrativeGraphValidation.ts` 里 kind 硬判 vs `buildGraphIndex` 是 kind 无关的，两者口径天然不一致；`narrative_state_editor.py` 有同形状的两种 kind 硬判。运行时 `compileNarrativeGraphs` 的编译分支是第四处同形状清单。
建议: 卡里「硬契约 1」补一句：**新增 element kind 要同时过全部登记面（运行时编译分支 + TS 权威白名单与两处硬判 + web 清单 + Python 兜底）**，并把它列为镜像 parity 门的固定检查项（同硬契约 6 的 wrapper owner 双注册表）。
