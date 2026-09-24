---
target: missing
date: 2026-09-21
session: Jev 世界脑（worktree claude/jev-street-brain）
---

现象: 在 `.claude/worktrees/<名>/` 里起的 dev server **看不见任何改动**——`vite.config.ts` 的 `DEV_WATCH_IGNORED` 含 `'**/.claude/**'`，而 worktree 的根本身就在 `.claude/` 下，于是整棵源码树都被忽略：改 .ts 不热更、改 vite 插件不重启，浏览器重载拿到的仍是旧模块，不报错；另外 Browser pane 的 `preview_start {name}` 用的是**主仓根**当 cwd（`dev_agent.cjs` 解析到主仓 node_modules/vite），起出来的是主仓的游戏，不是 worktree 的。
证据: 改 `src/debug/WorldBrainOverlay.ts` 的宽度后重载页面，`style.width` 仍是旧值；`Get-CimInstance Win32_Process` 看 5188 端口进程命令行是 `E:\GameDev\GameDraft\node_modules\vite\bin\vite.js`，新加的 `/__gamedraft-api/jev/*` 路由回的是 index.html。
建议: worktree 里验运行时改动一律 Bash 后台 `node scripts/dev_agent.cjs --port <独立端口> --strictPort`（cwd=worktree），每次改完代码杀掉重起；可考虑把忽略规则改成相对 root 的 `.claude/**` 而不是 `**/.claude/**`。
