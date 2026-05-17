## 快速开始

```powershell
git clone <repo-url>
cd GameDraft
.\bootstrap.cmd
```

项目内 Python 工具都使用仓库内的：

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


## 创作声明

本项目涉及的地方民俗、志怪传闻与禁忌仪式，均为创作需要进行的架空编撰，并非对现实仪式、真实人物或具体事件的复刻与指涉。
项目不会刻意复刻真实祭文、咒语或现实亡者信息；涉及禁忌与仪式的设计会尽量保持边界感与敬畏感。
