# Video-to-Atlas Workspace (GameDraft)

从视频中按时间区间抽帧，管理**多视频子帧库**和**动画序列**，导出 **native 等大单元格**图集 PNG 及 `.anim.json`。工作区数据持久化为 `.vtaw` 目录。

## 环境

- Python 3.10+

## 安装

```bat
cd /d f:\GameDraft\tools\video_to_atlas
python -m pip install -r requirements.txt
```

## 启动

```bat
cd /d f:\GameDraft\tools\video_to_atlas
python main.py
```

## 模块结构

| 文件 | 职责 |
|---|---|
| `main.py` | 入口，启动 `QApplication` + `MainWindow` |
| `main_window.py` | 主窗口：单页纵向工作流 (素材库、首尾帧、动画序列、导出) |
| `workspace_model.py` | 数据模型：`Workspace`, `VideoSource`, `FrameItem`, `SlotRef`, `AnimationClip`, `ExportJob`, `ChromaParams`, `GlobalSettings` + save/load |
| `import_dialog.py` | 导入弹窗：视频加载、时间区间、色键、抽帧 |
| `frame_viewer.py` | 帧大图查看对话框 (`QGraphicsView` + 缩放平移 + 棋盘格) |
| `frame_sequence_player.py` | 共享帧序列播放器组件 (范围预览 + 动画预览复用) |
| `export_panel.py` | 导出工作台：per-job 参数、分别导出、合并导出 |
| `atlas_core.py` | 图像处理核心：抽帧解码、色键、图集打包、导出格式生成 |
| `loop_range_bar.py` | 双关键点循环区间条 UI 组件 |
| `gui.py` | (旧版主窗口，已废弃，保留备查) |
| `project_model.py` | (旧版数据模型，已废弃，保留备查) |

## 工作区持久化格式

```
my_project.vtaw/
  project.json          # manifest: version + VideoSources + clips + export_jobs + settings
  frames/
    {frame_id}.png      # 每帧 RGBA PNG
  thumbnails/
    {frame_id}.png      # 64x64 缩略图缓存 (可重建)
```

## 工作流概要

1. **新建/打开工作区**：菜单 文件 > 新建工作区 / 打开工作区...
2. **导入视频帧**：菜单 导入 > 新建导入... 弹出导入弹窗；或在视频列表右键 > 继续导入... 追加帧到已有视频源
3. **素材库管理**：
   - 视频列表中点击切换**激活子库**
   - 帧格网格查看帧缩略图，Ctrl+左键设首帧，Alt+左键设尾帧
   - 右键菜单：设首帧、设尾帧、删除帧、查看大图
   - 每个视频下的帧仅支持尾部追加 + 中间删除，**禁止重排**
4. **首尾帧工作区**：洋葱皮对照预览 + 范围循环播放预览 (可调速度)
5. **动画序列**：
   - 新建动画、用激活子库首尾范围创建
   - 每帧引用全局 `frame_id` (UUID hex16)，支持单帧/全部水平翻转 (不改原始帧)
   - 缺失帧标红显示，可手动替换修补
   - 序列内 frame_id 不允许重复
6. **导出工作台**：
   - 添加动画到导出列表，每行独立设置缩放/边距/world尺寸
   - 分别导出（每个动画独立 PNG + anim.json）
   - 合并导出（所有动画到一张图集 + 多 state anim.json）
   - 合并导出支持每 clip 不同分辨率缩放
7. **保存**：Ctrl+S 手动保存工作区

## 关键设计决策

- **frame_id** 全局唯一 UUID hex16，删帧前扫描所有动画引用并提示确认
- **SlotRef(frame_id, flip_h)** 替代分离的 frame_ids + flip 列表
- **flip_h** 在预览/导出时对像素做临时翻转副本，不改原始帧数据
- **ExportJob** 参数不写回 AnimationClip，导出时读最新 clip 状态
- **anchor** 固定 bottom-center (与 GameDraft SpriteEntity 一致)
- 删除 clip 时级联删除其 ExportJob

## 导出文件

- `*.png`：图集 (RGBA)
- `*.meta.json` (可选)：单格尺寸、帧索引等调试信息
- `*.anim.json`：`spritesheet`、`cols`、`rows`、`worldWidth`/`worldHeight`、`states`

## 依赖

- `opencv-python`, `numpy`, `Pillow`, `PySide6`
