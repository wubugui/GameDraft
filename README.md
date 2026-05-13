# gamedraft

2D 叙事向 Web 游戏客户端（Vite + TypeScript + Pixi.js）。

## 快速开始

新机器只需要先安装 Git，然后拉取仓库：

```powershell
git clone <repo-url>
cd GameDraft
.\bootstrap.cmd
```

`bootstrap.cmd` 是可重复执行的引导脚本，只负责准备环境：

```text
1. Initialize game
2. Initialize editor
3. Clean local environment
0. Exit
```

如果没有 `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`，引导脚本会提示输入并保存到当前 Windows 用户环境变量。Secret 输入不会回显。

项目禁止依赖全局 Python。所有 Python 工具都使用仓库内的：

```text
.\.tools\Python311\python.exe
```

## 资源结构

项目代码走 GitHub；大文件资源走 OSS。DVC 负责记录资源版本、校验 hash 和本地 checkout，实际 OSS 上传/下载由 `scripts/sync-dvc-cache.py` 使用阿里云官方 `oss2` SDK 完成。

DVC 托管三类资源：

```text
public/resources/runtime.dvc        # 游戏运行时媒体资源
resources/editor_projects.dvc       # 编辑器工程/中间工程资源
resources/vendor_archives.dvc       # 第三方依赖离线包
```

对应目录：

```text
public/resources/runtime/
resources/editor_projects/
resources/vendor_archives/
```

`.ts` 目录是 TagSpaces/临时缩略图数据，不进入版本控制。

## 日常开发

拉取 GitHub 代码和游戏运行资源：

```powershell
.\pull-all.cmd
```

按需拉取编辑器工程资源：

```powershell
.\pull-all.cmd -Editor
```

查看状态：

```powershell
git status
.\.tools\Python311\python.exe -m dvc status
```

提交：

```powershell
.\commit-all.cmd "提交说明"
```

推送 Git + OSS 资源：

```powershell
.\push-all.cmd
```

## 运行与构建

启动游戏开发服务器：

```powershell
.\start-game.cmd
```

启动主编辑器：

```powershell
.\start-main-editor.cmd
```

构建游戏：

```powershell
.\.tools\node-portable\node-v22.14.0-win-x64\npm.cmd run build
```

## 文档

| 文档 | 说明 |
|------|------|
| [Cutscene / Action / Timeline 迭代计划](docs/plan-cutscene-action-timeline.md) | Action、Timeline 路线与验收清单 |
| [数据与工具说明](docs/data-and-tools-manual.md) | 资源与工具链说明 |
| [渲染相关](docs/rendering-architecture.md) | 渲染架构笔记 |

## 创作声明

本项目涉及的地方民俗、志怪传闻与禁忌仪式，均为创作需要进行的架空编撰，并非对现实仪式、真实人物或具体事件的复刻与指涉。

民俗习惯是人类祖先在乱世、贫困、疾病、死亡与未知面前形成的生活经验、心理秩序和民间智慧。本项目希望以尊重的态度呈现这些经验，而不是猎奇、戏弄或宣扬迷信。

项目不会刻意复刻真实祭文、咒语或现实亡者信息；涉及禁忌与仪式的设计会尽量保持边界感与敬畏感。
