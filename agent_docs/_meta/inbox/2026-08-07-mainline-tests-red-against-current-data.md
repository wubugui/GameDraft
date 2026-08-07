---
target: missing
date: 2026-08-07
session: 信号关系（谁发谁听）
---

现象: 四条咬真实数据的测试当前是红的，与本次改动无关：`src/core/XungouMainFlowIntegration.test.ts`
与 `NarrativePackageDirectorFlow.test.ts` 都断言主线推进到 `s02_beishi`、实际停在 `s01_tingshu`；
`tools/narrative_debugger/tests/test_narrative_debugger.py` 的 neighborhood/player_action 两条同族。
证据: 拿 HEAD 版 `narrative_graphs.json` 单独建索引复跑，前驱数同样是 0 → 断言与数据早已漂移，
不是工作区未提交内容造成的。
建议: 治理 run 决定是改断言还是补数据（**别默认改数据**：`never-touch-game-data-unasked`）；
在此之前，任何人跑这两套测试看到红色，先按"既有失败"处理，不要当成自己改坏了。
