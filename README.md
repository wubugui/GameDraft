## 快速开始

本分支保留 macOS/Linux 开发入口，所有任务收口到 `./dev.sh` 和
`python -m tools.dev`。

```bash
git clone <repo-url>
cd GameDraft
./bootstrap.sh            # 需要系统已安装 Python 3.11+；可选 game/editor/clean
```

`bootstrap.sh` 会用系统 Python 创建项目内虚拟环境 `.tools/venv`，安装
DVC，并检查 Node 20+。之后用 `./dev.sh <任务>` 运行各工具。

> 首次在干净克隆上务必先跑 bootstrap；其它命令依赖它准备好的运行时。

## 常用命令

```bash
./scripts/pull-all.sh
./scripts/commit-all.sh "提交说明"
./scripts/push-all.sh
./scripts/console.sh
```

也可以直接使用通用入口：

| 用途 | 命令 |
|---|---|
| 初始化 | `./bootstrap.sh` |
| 安装依赖 | `./dev.sh install-deps` |
| 拉取运行资源 | `./dev.sh init-runtime` |
| 拉取编辑器资源 | `./dev.sh init-editor` |
| 配置 OSS remote | `./dev.sh configure-oss --bucket B` |
| 拉取代码+资源 | `./dev.sh pull --editor` |
| 推送代码+资源 | `./dev.sh push` |
| 提交 | `./dev.sh commit -m "说明"` |
| 控制台 | `./dev.sh console` |
| 启动编辑器 | `./dev.sh editor` |
| 启动游戏开发服 | `./dev.sh game start` |
| 停止游戏开发服 | `./dev.sh game stop` |
| 资源浏览器 | `./dev.sh asset-browser` |
| 资源入库 | `./dev.sh asset-ingest` |
| 对话图编辑器 | `./dev.sh dialogue-graph` |
| 制作工作台 | `./dev.sh workbench` |
| 全量数据校验 | `./dev.sh validate-data` |
| 编年史模拟 v2 / v3 | `./dev.sh chronicle-sim-v2` / `./dev.sh chronicle-sim` |
| 周模拟 | `./dev.sh chronicle-week <run_dir> --week 1` |

`./dev.sh --help` 列出全部任务。

## 凭据与代理

- OSS 凭据保存在 `.tools/oss.env`（git 忽略，两行
  `OSS_ACCESS_KEY_ID=` / `OSS_ACCESS_KEY_SECRET=`）。`bootstrap` 会在缺失时
  提示填写。
- 依赖安装和 git 推拉默认使用临时代理 `http://127.0.0.1:7078`。
  依赖安装不走代理时加 `install-deps --no-proxy`。
- OSS 阶段会绕过本地代理；git 推拉默认使用 `http://127.0.0.1:7078`。
  只有临时换代理时才需要传 `--git-proxy <url>` 或设置 `GAMEDRAFT_GIT_PROXY`。
  npm/game 临时换代理用 `install-deps --npm-proxy <url>` 或 `game start --proxy <url>`。

## 资源结构

项目代码走 GitHub；大文件资源走 OSS。DVC 负责记录资源版本、校验 hash 和
本地 checkout，实际 OSS 上传/下载由 `scripts/sync-dvc-cache.py` 使用阿里云
官方 `oss2` SDK 完成。

DVC 托管三类资源：

```text
public/resources/runtime.dvc        # 游戏运行时媒体资源
resources/editor_projects.dvc       # 编辑器工程/中间工程资源
resources/vendor_archives.dvc       # 离线依赖/运行环境归档
```

对应目录：

```text
public/resources/runtime/
resources/editor_projects/
resources/vendor_archives/
```

## 日常开发

```bash
git status
./scripts/pull-all.sh --editor
```

## 创作声明

本项目涉及的地方民俗、志怪传闻与禁忌仪式，均为创作需要进行的架空编撰，
并非对现实仪式、真实人物或具体事件的复刻与指涉。
项目不会刻意复刻真实祭文、咒语或现实亡者信息；涉及禁忌与仪式的设计会
尽量保持边界感与敬畏感。
