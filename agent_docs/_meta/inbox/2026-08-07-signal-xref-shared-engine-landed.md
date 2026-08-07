---
target: emitted-signal-catalog
date: 2026-08-07
session: 信号关系（谁发谁听）
---

现象: 卡里只有"哪些容器算实发"的口径，没有"怎么按信号反查两侧"的入口；新建的共享扫描
`tools/narrative_xref` 已把两侧（含派生信号的上游因果、条件读状态）算成一份可跳转的索引，
编辑器面板 / 调试器窗 / MCP `narrative_signal_info` 三处共用它。
证据: `tools/narrative_xref/README.md`；parity 测试
`tools/narrative_xref/tests/test_narrative_xref.py::test_real_project_matches_catalog_emitted_signal_ids`
与 `tools/editor/tests/test_signal_xref_bridge.py::test_model_source_matches_disk_source_on_the_real_project`。
建议: 卡的「怎么验证」补一条 `python3 -m tools.narrative_xref --problems`（一眼看出两侧对不齐的信号）；
「已知坑」里"广播只被条件叶消费会误报没人听"现在面板会同时列出读状态的地方，可注明。
