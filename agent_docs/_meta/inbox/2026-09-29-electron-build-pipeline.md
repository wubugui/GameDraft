---
target: build-pipeline
date: 2026-09-29
---

现象: 机制卡仍把 Tauri/Rust 描述为正式发行壳，实际 `release.mjs` 已改用 Electron 装配 Windows x64 绿色包。
证据: `scripts/release.mjs`、`scripts/electron_release.mjs`、`src-electron/main.cjs`；旧 `src-tauri/` 与 `scripts/tauri_test.mjs` 已移除。
建议: 更新卡片、INDEX 与路径触发器的正式构建入口，同时保留历史排障记录的时间标识。
