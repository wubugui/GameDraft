---
id: windows-dev-environment
title: Windows 上的开发入口与从零重建环境
domain: meta
type: recipe
summary: Windows 上 dev.sh/bootstrap.sh 起不来,任务一律走 venv python -m tools.dev;重建环境的运行时全在 DVC 的 vendor_archives 里(py3.11 必须、pip 要 PYTHONUTF8=1、node 解到 .tools/node)
status: active
authority:
  - dev.sh
  - tools/dev/paths.py#windows_venv_python
  - tools/dev/paths.py#_windows_node_candidate_dirs
  - resources/vendor_archives.dvc
  - tools/editor/requirements.txt
  - config/python-deps-constraints.txt
triggers:
  paths: ["dev.sh", "bootstrap.sh", "tools/dev/**", "scripts/*-all.sh"]
  topics: [Windows, venv, 开发入口, 环境重建, 新机, vendor_archives, node, pip]
  tasks: [新机搭环境, 重建 venv, Windows 上跑 dev 任务, 拉取推送提交]
last_governed: 2026-09-23
---

**实测环境与日期**:2026-08-20 在本机(Windows 11)按下面步骤从零重建并验证;2026-09-21 补 stdin 用法;
2026-09-23 复核 `paths.py` 现状(node 已有仓库自带便携版兜底)。

## 日常入口

`dev.sh` / `bootstrap.sh` 只找 POSIX 布局的 `venv/bin/python`,在 Windows 上报 "Project venv missing" 直接退出,
连带 `scripts/pull-all.sh` / `push-all.sh` / `commit-all.sh` 全部起不来。Python 侧任务运行器本身认 Windows,
绕开壳即可:

```sh
.tools/venv/Scripts/python.exe -m tools.dev <task>   # pull --editor / push / commit -m ... / editor / game start / validate-data
sh scripts/py.sh <脚本或 -m 模块>                     # 普通脚本
sh scripts/py.sh - <<'PY'                            # 一次性小程序从 stdin 读,不必先落文件
...
PY
```

带反斜杠转义的行别走 bash heredoc(双反斜杠会被吞成一个),用编辑工具写文件。

## 从零重建(运行时全在 DVC 目标 `resources/vendor_archives` 里,仓内已无任何引用,容易漏)

1. **venv 必须是 Python 3.11**:编辑器依赖的图编辑库要 stdlib `distutils`,3.12+ 已移除(requirements 头注写着)。
   把 `python311-dvc-win-x64.zip` 解到 `.tools/`,`.tools/Python311/python.exe -m venv .tools/venv`。
2. 依赖按约束集装,走代理与离线 wheelhouse(`python-wheelhouse-py311.zip` 解到 `.tools/wheelhouse_py311`):
   先 `-c config/python-deps-constraints.txt dvc dvc-oss`,再 `-r tools/editor/requirements.txt`,再 `-r tools/voice_workbench/requirements.txt`。
3. **每次 `pip install -r` 都要 `PYTHONUTF8=1`**:requirements 里有中文注释,旧 pip 按 GBK 解码直接 `UnicodeDecodeError`(升级 pip 也能治)。
4. Node:`node-portable-win-x64.zip` 解到 `.tools/node`,然后 `npm ci`。任务运行器会先认 PATH 上的 node、落空再找
   `.tools/node/<带版本号的目录>`,所以不必为它改用户 PATH、也不必重启整条进程链。
5. OSS 凭据在 `.tools/oss.env`(gitignore)。

## 已知坑

- **裸 `python` 在本机是 Python 2.7**、`python3` 是应用商店占位程序:带非 ASCII 的程序会报
  `SyntaxError: Non-ASCII character ... no encoding declared`,或出现 Py2 才有的属性错误——读起来像脚本写错了。
  一律 `sh scripts/py.sh`;解释器选择的契约见 [project-interpreter-entrypoint](../mechanisms/project-interpreter-entrypoint.md)。
- 大文件拉取 / 推送的坑见 [dvc-oss-restore](dvc-oss-restore.md)。

## 验证

`sh scripts/py.sh -c "import sys; print(sys.version)"` 打出 3.11 且路径落在 `.tools/venv`;
`.tools/venv/Scripts/python.exe -m tools.dev --help` 能列出任务。
