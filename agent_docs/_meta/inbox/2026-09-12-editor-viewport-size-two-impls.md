---
target: editor-tools-norms
date: 2026-09-12
session: 文档揭示编辑器三处修复
---

现象: 规范第 8 条说「宁可消灭镜像」,但「游戏逻辑视口尺寸」现在有两份实现且**回落次序相反**——新加的 `ProjectModel.game_viewport_size()` 是 viewport 优先(抄 `Game.start` 只在配了 `viewport` 时 `setViewportSize`),`sugar_wheel_editor.py:518` 的 `viewport_size()` 是 windowSize 优先;当前数据两者都是 1024×768,漂了也看不出来。
证据: `tools/editor/project_model.py` 的 `game_viewport_size`、`tools/editor/editors/sugar_wheel_editor.py:518`、`src/core/Game.ts:1802`。
建议: 让糖画盘那份改调 `game_viewport_size()`(本次没动它,怕顺手改掉另一个编辑器的既有取值语义);或确认糖画盘的百分比布局确实相对窗口而非视口,把这条差异写进卡里。
