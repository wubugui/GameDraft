---
kind: deviation
date: 2026-08-21
target: editor-change-verification-gate
---

- **说的**：编辑器测试门是 `pytest tools/editor/tests`。
- **实际**：测试实际分两处——`tools/editor/tests/`（1549 条）与
  `tools/editor/editors/tests/`（39 条，含 scene_lights 那两组）。钦定命令差一层目录，
  **收集不到后者**：今天新增的 12 条在标准门里等于不存在，跑绿了也说明不了什么。
  跑 `pytest tools/editor`（全树）才是 1586 条。
- **已加防护**（同日）：`tools/editor/tests/test_gate_collects_all_editor_tests.py` ——
  两条断言：①编辑器测试不许出现在登记之外的目录 ②全树收集数必须**严格大于**
  `tools/editor/tests` 单收（相等就说明后者没被收进来）。以后再有人把测试放进
  门收不到的地方，这条会红并直接说门命令该怎么写。**但门命令本身还得改**——
  防护只是让"漏了"变得看得见。
- **建议**：门命令改成 `pytest tools/editor`；或在 `tools/editor/tests/` 下加一条
  收集完整性断言（比较全树 collected 数与门收集数），否则以后往
  `editors/tests/` 加测试的人不会知道自己写的东西没进门。
