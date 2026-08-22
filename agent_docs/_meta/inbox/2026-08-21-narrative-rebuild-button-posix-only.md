---
target: narrative-state-editor
date: 2026-08-21
session: 「重建并刷新」在 Windows 上永远起不来（用户报"自动 rebuild 总是不行"）
---

# 叙事状态机的「重建并刷新」是 macOS 专供，Windows 上 100% FailedToStart

- **现象**：主编辑器叙事状态机页的「重建并刷新」在 Windows 上必弹「无法启动重建命令」，
  而同一条 `npm run build:narrative-editor` 在命令行一次过。
- **根因**：`_rebuild_shell_invocation()` 只写了 POSIX 版——`$SHELL -lc 'cd <root> && npm run …'`，
  且回落 `/bin/zsh`。Windows 原生启动的进程 `SHELL` 为空（实测 `SHELL=[]`、`/bin/zsh` 不存在），
  于是 QProcess 的 program 指向一个不存在的路径 ⇒ 必然 `FailedToStart`。
- **讽刺点**：仓库里早有 Windows 正解——`tools/dev/paths.py` 的 `npm_command()`（返回 `npm.cmd` 全路径）
  与 `env_with_node_path()`（认得自带的 `.tools/node` 便携版），`main_window` 也早有 `_npm_run_command`
  的 `cmd /d /c` 分支；**只有这个按钮自己手搓了第三份**。

## 2026-08-21 已修

三份实现收成单一出口 `tools/editor/shared/npm_process.py`（`npm_run_command` / `node_process_environment`），
`main_window` 与叙事状态机都从这进；`_rebuild_shell_invocation(windows=None)` 把平台做成可注入参数，
两条分支在任一平台都能被测到。护栏：`test_narrative_state_editor.py::TestWebRebuildInvocation`
（含「常量与 package.json 对齐」）、`test_main_window_process.py::test_main_window_still_reaches_the_shared_npm_entrypoint`。

留给知识库的两句话：
1. **PyQt 工具里凡起 npm/node 子进程，一律走 `tools/editor/shared/npm_process`**——别再手搓 program/args。
2. **测平台分支别 patch `os.name`**：`pathlib.Path` 按它做平台分派，在 Windows 上一 patch 成 posix，
   `Path(...).resolve()` 当场炸。把平台做成函数参数注入。
