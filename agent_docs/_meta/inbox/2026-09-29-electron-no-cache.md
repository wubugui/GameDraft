---
target: desktop-window-no-cache
date: 2026-09-29
---

现象: 机制卡仍指向已移除的 Tauri/WebView2 发行壳，当前发行窗是 Electron。
证据: `src-electron/main.cjs` 的禁缓存开关及自定义协议 `Cache-Control: no-store`。
建议: 更新权威源、标题和验证项；Qt 开发预览部分沿用原约束。
