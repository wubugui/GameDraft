---
target: runtime-persistence
date: 2026-09-29
---

现象: 机制卡和 INDEX 仍写 Tauri→HTTP→内存，实际后端顺序已是 Electron→HTTP→内存。
证据: `src/core/storage/persistentStore.ts`、`src-electron/storage.cjs`；正式包 `gamedata/` 读写 smoke 已通过。
建议: 更新存储路径与三种运行环境描述，移除旧 Rust 命令和 `src-tauri` 触发器。
