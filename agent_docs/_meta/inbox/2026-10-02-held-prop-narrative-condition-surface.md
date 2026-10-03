现象：docs/editor-authoring-surface.md 条件树一节仍称叙事图不收 heldProp 叶子，与现役机制不符。
证据：跑马梁现有迎风/护火迁移及本次低火兜底均使用 heldProp reactive 条件；真实游戏触发、TS 编排测试与编辑器往返均通过。
建议：同步该段到当前 narrativeGraphValidation 与条件求值器口径，保留派生事实只读及状态机推进约束。
