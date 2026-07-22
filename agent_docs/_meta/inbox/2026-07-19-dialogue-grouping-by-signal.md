# 偏差记录 2026-07-19：图对话编辑器「叙事归属」分组机制变更

- **卡**：editor-tools/mechanisms/dialogue-graph-editor.md（未提及左栏分组来源）。
- **现实**：左栏「叙事归属」分组已从「对话图 meta.scenarioId（手填，源自已空的 scenarios.json）」改为**按信号自动推导到章节包**：对话图 emit 信号 → 监听它的叙事图（build_narrative_signal_owners）→ 卷到 owner 的章节包（build_graph_package_map），三个纯函数在 graph_analysis.py。粒度=章节级（16 组）。「叙事归属」字段改只读展示、保存不再写 meta.scenarioId。守护测试 test_chapter_grouping.py。
- **建议**：卡里补一句分组来源（信号推导，非 meta.scenarioId）；老 scenario 运行时管道（ScenarioStateManager/scenario·scenarioLine 叶/空 scenarios.json）是独立待清项，另开一轮。
