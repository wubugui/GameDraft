---
target: runtime-command-channel
date: 2026-10-02
---

现象: 配方仍以当前工具集中不存在的 preview_* 起游戏；tools.dev game start 固定 strictPort 5173 且无端口选项，已有开发服时无法按该入口另起隔离验收实例。
证据: 本次使用现有 Vite CLI 指定 --port 5174，并设置 GAMEDRAFT_SWEEP_ISOLATED=1 后完成 GTX 970 真 WebGPU 验收；记录 artifact/ao-settings-20261002/runtime-verification.json。
建议: 补充工具不可用与 5173 已被占用时的独立端口/隔离队列入口，强调只回收本次启动的服务及浏览器。
