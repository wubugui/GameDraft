## 快速开始

跨平台开发：Windows 用 `.cmd`，macOS/Linux 用 `./dev.sh`。两端的实际逻辑都收口到同一个 Python 任务入口 `python -m tools.dev`。

**Windows**

```powershell
git clone <repo-url>
cd GameDraft
.\bootstrap.cmd            # 菜单：1 初始化游戏 / 2 初始化编辑器 / 3 清理
```

`bootstrap.cmd` 会自动下载仓库内置的 Python 运行时（`.tools\Python311\python.exe`）并收集 OSS 凭据，之后所有 `.cmd` 都直接复用它。

**macOS / Linux**

```bash
git clone <repo-url>
cd GameDraft
./bootstrap.sh            # 需要系统已安装 Python 3.11+；可选 game/editor/clean
```

`bootstrap.sh` 会用系统 Python 创建项目内虚拟环境 `.tools/venv`，安装 DVC，并检查 Node 20+。之后用 `./dev.sh <任务>` 运行各工具。

> 首次在干净克隆上务必先跑 bootstrap；其它命令依赖它准备好的运行时。

## 命令对照（旧 `.cmd` → 跨平台）

| 用途 | Windows | macOS / Linux |
|---|---|---|
| 初始化 | `.\bootstrap.cmd` | `./bootstrap.sh` |
| 安装依赖 | `.\install-deps.cmd` | `./dev.sh install-deps` |
| 拉取运行资源 | `.\init-runtime.cmd` | `./dev.sh init-runtime` |
| 拉取编辑器资源 | `.\init-editor.cmd` | `./dev.sh init-editor` |
| 配置 OSS remote | `.\configure-oss.cmd --bucket B` | `./dev.sh configure-oss --bucket B` |
| 拉取代码+资源 | `.\pull-all.cmd [--editor] [--vendor]` | `./dev.sh pull [--editor] [--vendor]` |
| 推送代码+资源 | `.\push-all.cmd` | `./dev.sh push` |
| 提交 | `.\commit-all.cmd "说明"` | `./dev.sh commit -m "说明"` |
| 启动编辑器 | `.\start-main-editor.cmd` | `./dev.sh editor` |
| 启动游戏开发服 | `.\start-game.cmd` | `./dev.sh game start` |
| 停止游戏开发服 | `.\stop-game.cmd` | `./dev.sh game stop` |
| 资源浏览器 | `.\start-asset-browser.cmd` | `./dev.sh asset-browser` |
| 资源入库 | `.\start-asset-ingest.cmd` | `./dev.sh asset-ingest` |
| 对话图编辑器 | `.\edit-dialogue-graph.cmd` | `./dev.sh dialogue-graph` |
| 制作工作台 | `.\start-production-workbench.cmd` | `./dev.sh workbench` |
| 编年史模拟 v2 / v3 | `.\start-chronicle-sim-v2.cmd` / `.\chronicle-sim.cmd` | `./dev.sh chronicle-sim-v2` / `./dev.sh chronicle-sim` |
| 周模拟 | `.\run-chronicle-sim-week.cmd <run_dir> --week 1` | `./dev.sh chronicle-week <run_dir> --week 1` |

通用入口：Windows `.\dev.cmd <任务>`，Unix `./dev.sh <任务>`。`./dev.sh --help` 列出全部任务。

## 凭据与代理

- OSS 凭据保存在 `.tools/oss.env`（git 忽略，两行 `OSS_ACCESS_KEY_ID=` / `OSS_ACCESS_KEY_SECRET=`）。`bootstrap` 会在缺失时提示填写。旧 Windows 用户存在用户环境变量里的凭据会在首次运行时自动迁移到该文件。
- OSS 阶段会绕过本地代理；git 推拉可用 `--git-proxy <url>`（或环境变量 `GAMEDRAFT_GIT_PROXY`，默认 `http://127.0.0.1:7078`）。npm 装包走代理用 `install-deps --npm-proxy` 或 `game start --proxy`。

## 资源结构

项目代码走 GitHub；大文件资源走 OSS。DVC 负责记录资源版本、校验 hash 和本地 checkout，实际 OSS 上传/下载由 `scripts/sync-dvc-cache.py` 使用阿里云官方 `oss2` SDK 完成。

DVC 托管三类资源：

```text
public/resources/runtime.dvc        # 游戏运行时媒体资源
resources/editor_projects.dvc       # 编辑器工程/中间工程资源
resources/vendor_archives.dvc       # 第三方依赖离线包（仅 Windows 内置运行时使用）
```

对应目录：

```text
public/resources/runtime/
resources/editor_projects/
resources/vendor_archives/
```

> macOS/Linux 用系统 Python + venv 在线安装依赖，不使用 `vendor_archives` 里的 Windows 离线包。

## 日常开发

查看状态（Windows 用 `.\dev.cmd`，Unix 用 `./dev.sh`）：

```bash
git status
./dev.sh init-runtime    # 或按需 pull --editor
```

## 创作声明

本项目涉及的地方民俗、志怪传闻与禁忌仪式，均为创作需要进行的架空编撰，并非对现实仪式、真实人物或具体事件的复刻与指涉。
项目不会刻意复刻真实祭文、咒语或现实亡者信息；涉及禁忌与仪式的设计会尽量保持边界感与敬畏感。
