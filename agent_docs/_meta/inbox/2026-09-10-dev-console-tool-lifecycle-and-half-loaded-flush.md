---
target: narrative-state-editor
date: 2026-09-10
session: 叙事状态机被抹空事故取证与修复（控制台孤儿进程 + 半加载 flush）
---

现象: 2026-09-09 01:20 `narrative_graphs.json` 被主编辑器 Save All 抹成只剩 signals（8 个编排 + migrations 全没）。两个根因叠加：①开发控制台重开时不回收它拉起的工具子进程，9 月 8 日 22:32 起的主编辑器成了孤儿、拿旧代码活到 9 月 10 日；②叙事页半加载（React 挂好 API、桥没通、getData 没回）时 `flush_to_model` 把网页的空白初始文档当合法草稿收下。当晚多次「叙事状态机不响应，保存失败」是 `state is None` 那条护栏在拦，最后一次半加载没拦住。
证据: 用 HEAD 当宿主、按 `flush_to_model` 路径重放空白文档，得到的对象与磁盘那份完全相等；`Get-CimInstance Win32_Process` 显示 `-m tools.editor` 进程 CreationDate 早于相关代码 mtime；主树与 4 个 worktree 的会话记录在 01:20 前后零写入。修复已落地：`narrative-state-editor.md` 硬契约 12（两侧各守一道门）、`tools/dev_console` 工具进程生命周期（登记 / 孤儿检测 / WM_CLOSE 礼貌关闭 / 退出回收，`tools/dev_console/tests/test_tool_lifecycle.py`）。
建议: ①给 `tools/dev_console` 立一张机制卡（工具进程生命周期 + 页面 `tools` 状态 + `stop_tool` 走 EnumWindows+WM_CLOSE 而非 `taskkill /T`——实测后者一见子进程就拒绝、连 WM_CLOSE 都不发）；②在 `live-editor-forensics` 的"判读"一节加一条：数据文件"整块字段消失、别的字段完好、键序变成 EMPTY 常量"= 陈旧/半加载进程全量写回，先看编辑器进程启动时间 vs 代码 mtime，再翻会话记录。
