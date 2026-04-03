---
name: restart-gamedraft
description: Restarts the GameDraft Vite dev server by running GameDraft/stop-game.cmd then GameDraft/start-game.cmd in order. Use when the user asks to 重启游戏, restart the game, reload the dev server, or restart GameDraft local development.
---

# GameDraft 重启游戏（开发服）

## 何时使用

当用户表示要**重启游戏**、**重启开发服**、**重载 GameDraft**、或等价含义（含英文 restart / reload dev server）且指向本仓库的 GameDraft 前端项目时，按下面顺序执行。

## 必须遵循的流程

### 1. 先停止

在仓库根目录下，用 **Windows cmd** 调用停止脚本，并传入 **`nopause`**，避免批处理末尾 `pause` 阻塞自动化：

```cmd
GameDraft\stop-game.cmd nopause
```

（若当前目录不是仓库根，使用脚本绝对路径或先 `cd /d` 到仓库根。）

### 2. 再启动

停止命令成功返回后，再启动：

```cmd
GameDraft\start-game.cmd
```

`start-game` 会长期占用终端（`npm run dev`）。在 Cursor 里由 Agent 执行时，应在**后台**启动该命令，不要与需要立即返回的操作串在同一同步阻塞里。

## 说明

- `stop-game.cmd` 会结束占用 **3000–3003** 端口的监听进程（与多次启动 Vite 时的端口顺延一致）。
- 双击运行 `stop-game.cmd` 时仍可不带参数，末尾会 `pause`；仅自动化/重启流程使用 `nopause`。
- 本流程针对 **GameDraft + Vite 开发服**，不是独立游戏服务端进程。
