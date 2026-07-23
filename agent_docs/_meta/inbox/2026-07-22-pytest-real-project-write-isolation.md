---
target: editor-change-verification-gate
date: 2026-07-22
session: pytest-real-project-write-isolation
---

现象: 编辑器测试把真实工程当只读 fixture，但 DialogueGraphEditorWidget 打开图时会自动修复并写入 DVC sidecar，导致运行测试即污染真实数据。
证据: tools/dialogue_graph_editor/editor_widget.py:2368-2369 调用 _flush_flow_layout_to_disk；当前 DVC 基线曾含 28 个 __draft_* 键、5 个畸形测试键和 g_test 分组。
建议: 验证门明确要求真实工作树硬只读，可写 sidecar/QSettings 必须重定向系统临时目录，任何真实根写入立即使测试失败。
