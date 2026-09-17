---
name: kill-gamedraft-residue
description: 杀掉本项目(GameDraft)的游戏运行时与编辑器/工作台残留进程——vite dev server、游戏预览窗、打包版 gamedraft.exe、tools.* 编辑器/工作台/控制台/手册站/烘焙子任务。触发词：杀残留、清进程、关掉游戏和编辑器、kill residue、清理 dev server、端口被占、把游戏运行时和编辑器都关了。
---

# 杀 GameDraft 运行时 / 编辑器 / 工作台残留

用户调起本技能 = 已授权结束下面认得的全部进程，**不再逐个确认**。

## 流程

1. 用户点名要保留某个（如"控制台留着"）时，先只列不杀，拿到它的 PID：

   ```bash
   sh scripts/py.sh scripts/kill_gamedraft_residue.py --dry-run
   ```

2. 执行（列出并杀；保留项每个加一次 `--keep <PID>`，整棵子树都保留）：

   ```bash
   sh scripts/py.sh scripts/kill_gamedraft_residue.py [--keep <PID> ...]
   ```

3. 按脚本输出向用户汇报：杀了几组、每组是什么（类别 / 端口 / 来源 / 启动时间）、有没有仍存活的。
   退出码 1 = 有进程没杀掉，原样报给用户，不要反复重试。

## 脚本认什么(按身份认，不按端口)

| 类别 | 判据 |
|---|---|
| 游戏(打包版) | `gamedraft.exe`，及 `--webview-exe-name=gamedraft.exe` 的 WebView2 |
| 游戏预览窗 | 带 `GameDraft\preview-profile` 的 Chrome/Edge 实例(`tools/dev/game_preview.py`) |
| 游戏 dev server | 仓库内的 `vite/bin/vite.js`、`scripts/dev_agent.cjs`、`scripts/scene_sweep.mjs`、tauri dev |
| 编辑器 / 工作台 / 控制台 / 手册站 / 烘焙 | 仓库内 python 跑的 `tools.*` 模块或 `tools/**.py` 脚本，含 `tools.dev <工具名>` 启动器 |
| 编辑器内嵌网页进程 | 可执行文件在仓库 `.tools` 下的孤儿 `QtWebEngineProcess.exe` |

**不碰**：MCP server(属于正在用的 AI 会话)、pytest / vitest / `tools.editor.validate` / 审计 / 治理 audit 这类
一次性命令、`tools.dev pull/push/commit/bootstrap/init-*`、git、shell、VS Code、Claude/Codex 本体、本脚本自己和它的祖先。

## 注意

- 端口不作判据：dev server 会顺延(5173~5180、扫场 5195+)，工作台端口由系统分配。
- 会一并杀掉**其他会话正在用**的 dev server——这正是本技能的目的；要保留就用 `--keep`。
- 新增了一类长驻进程(新工作台起 node 服务、新的预览方式)而脚本没认出来时，改
  `scripts/kill_gamedraft_residue.py` 的 `classify()`，不要在这里手写 taskkill 清单。
