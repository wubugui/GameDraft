---
target: narrative-debugger-bridge
date: 2026-09-17
session: 叙事编排全貌面板
---

现象: `tools/narrative_debugger/tests` 有 4 条在 HEAD 422b066 干净检出上就红（`test_mainline_beats_are_ordered_from_initial` / `test_composition_exposes_subgraphs_not_just_mainline` / `test_every_row_carries_its_graph_name` / `test_search_matches_graph_name_and_keeps_the_group`）——断言写死了 09-08 重构前的数据形状（主线拍名「背崖墓尸完成」、xungou_demo_main 挂 >20 张子图、拍子行数 >100），现在编排只剩 7 个 elements。
证据: validator 子代理在临时 worktree（HEAD 422b066）用同一 venv 复现同样 4 条、同样断言值；两个测试文件最后一次改动 2026-08-18。
建议: 把这几条改成按真实数据现算（或用合成 fixture），别把主线拍名与子图数量写死。
