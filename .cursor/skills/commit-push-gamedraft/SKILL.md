---
name: commit-push-gamedraft
description: >-
  GameDraft 的 git + DVC 提交与推送钦定流程：先核对状态、刷新 DVC 指针再 commit，
  推送必须走 push-all / tools.dev push（oss2 sync-dvc-cache），禁止裸 dvc push/pull。
  Use when the user asks to 提交、推送、commit、push、核对 dvc、push-all、commit-all，
  or when finishing work that may have touched DVC-tracked resources.
---

# GameDraft 提交 / 推送（git + DVC）

## 何时使用

用户要求**提交 / 推送 / 核对 DVC**，或改动可能触及 DVC 跟踪目录（尤其 `resources/editor_projects`、`public/resources/runtime`、`resources/vendor_archives`）时，按本 skill 执行。

仍遵守用户规则：**未明确要求 commit 时不要擅自 commit**；未明确要求 push 时不要擅自 push。

## 铁律（踩过的坑）

1. **禁止裸 `dvc push` / `dvc pull` / `dvc fetch`**  
   原生 `dvc-oss` 异步栈（ossfs/aiooss2）易超时或兼容炸（如 `AsyncPayload`），且不认代理。  
   上传/下载一律走项目封装的 **`sync-dvc-cache.py`（oss2 SDK）**。
2. **禁止用系统 PATH 上的 `dvc.exe`（常见 Python310）当推送入口**  
   官方链路只认 **`.tools/venv`** 里的解释器。
3. **DVC 工作区有变更时，必须先刷新 `.dvc` 指针再进 git commit**  
   只 commit 源码/JSON、漏掉 `*.dvc`，远端会拿到旧指针。
4. **修全局 Python 依赖不是默认方案**  
   缺环境就建/修 `.tools/venv`，不要去拧系统 site-packages。

## 解释器口径

| 角色 | 路径 |
|---|---|
| 基座 | `.tools/Python311/python.exe`（Windows 便携） |
| 项目 venv（钦定） | `.tools/venv/Scripts/python.exe`（Unix: `.tools/venv/bin/python`） |
| 依赖约束 | `config/python-deps-constraints.txt` |
| 离线 wheel | `.tools/wheelhouse_py311` |

Windows 上若缺 venv，最小补齐（对齐 bootstrap 装 DVC 那一段）：

```powershell
.tools\Python311\python.exe -m venv .tools\venv
.tools\venv\Scripts\python.exe -m pip install -U pip
.tools\venv\Scripts\python.exe -m pip install --no-index --find-links=.tools\wheelhouse_py311 -c config\python-deps-constraints.txt dvc dvc-oss pyyaml
```

OSS 凭据：环境变量 `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`，或 `.tools/oss.env`（勿提交）。

## 标准流程

### A. 提交前核对

在仓库根并行查：

```powershell
git status -sb
git diff --stat
git diff --cached --stat
.tools\venv\Scripts\python.exe -m dvc status
.tools\venv\Scripts\python.exe -m dvc status -c
```

判读：

- `dvc status` 显示 `changed outs` → 本地 DVC 目录有未入指针的变更，**先做 B**。
- `dvc status -c` 显示 `new:` / 不同步 → 推送阶段必须走 D；单独 git push **不够**。
- 未跟踪垃圾（如 `logs/*-audit.json`、本地 MCP 残留）**默认不进提交**。

### B. 刷新 DVC 指针（有 outs 变更时）

用项目 venv：

```powershell
.tools\venv\Scripts\python.exe -m dvc commit <path>.dvc -f
```

常见：`resources/editor_projects.dvc`。确认对应 `*.dvc` 进入 git 暂存。

也可用封装（会按固定路径 `dvc add` 再 git commit，范围更宽，消息需用户给定）：

```bash
./scripts/commit-all.sh "message"
# 或
.tools/venv/Scripts/python.exe -m tools.dev commit -m "message"
```

Agent 做**选择性提交**时：手搓 `dvc commit` + `git add` 相关文件即可，不必强行 `commit-all`。

### C. Git commit

遵循仓库既有 commit 规则（只在用户要求时；看 status/diff/log；写清 why；不提交密钥与审计垃圾）。PowerShell 可用 here-string：

```powershell
git commit -m @"
feat(...): 一句话 why

可选第二行补充。
"@
```

`.dvc` 指针变更与业务文件**同一次 commit**，避免指针与内容分家。

### D. 推送（钦定 = push-all）

用户说「提交/推送」且需要上远端时，**只走这条**：

```powershell
.tools\venv\Scripts\python.exe -m tools.dev push
```

等价：

```bash
./scripts/push-all.sh
# → ./dev.sh push → tools.dev sync.push
```

内部顺序（`tools/dev/sync.py`）：

1. `python -m dvc status`（仅查状态）
2. `scripts/sync-dvc-cache.py push` → runtime / editor_projects / vendor（**oss2，不是裸 dvc push**）
3. `git push`

需要临时代理推 git 时用 `--git-proxy`（见 `tools.dev push -h`），**不要**因此改回裸 `dvc push`。

### E. 收尾自检

```powershell
git status -sb
git rev-list --left-right --count origin/master...HEAD
.tools\venv\Scripts\python.exe -m dvc status
.tools\venv\Scripts\python.exe -m dvc status -c
git ls-files --others --exclude-standard
```

期望：

- git：与 `origin` 对齐（或仅剩用户故意未推的）
- DVC：`Data and pipelines are up to date` + `Cache and remote ... are in sync`
- 未跟踪：只剩明确排除的本地垃圾；若有业务文件残留，报告给用户

## 命令对照（防呆）

| 意图 | 用这个 | 不要用这个 |
|---|---|---|
| 推 DVC+git | `python -m tools.dev push` / `scripts/push-all.sh` | `dvc push` |
| 拉 DVC+git | `python -m tools.dev pull` / `scripts/pull-all.sh` | `dvc pull` / `dvc fetch` |
| 刷新指针 | `python -m dvc commit …` 或 `tools.dev commit` | 只改工作区文件却不更新 `*.dvc` |
| 解释器 | `.tools/venv/.../python` | 系统 `Python310` + PATH `dvc` |

## 相关

- 拉取侧配方：`agent_docs/meta/recipes/dvc-oss-restore.md`
- 实现：`tools/dev/sync.py`、`scripts/sync-dvc-cache.py`、`scripts/push-all.sh`、`scripts/commit-all.sh`
- 约束：`config/python-deps-constraints.txt`
