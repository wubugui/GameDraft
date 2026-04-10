# 视频转 Atlas（GameDraft）

从视频中按时间区间抽帧，维护**全局帧库**；可创建多个**命名动画序列**（每段对应 `AnimationSetDef` 里的一个 `state`），再导出 **native 等大单元格** 图集 PNG（按各帧 alpha 包围盒裁切后的原始像素尺寸取 max 作为格宽、格高，格内底边 + 水平居中）及 `.anim.json` /可选 `.meta.json`。格式与运行时 `AnimationSetDef`（见工程 `src/data/types.ts`）及示例 `public/assets/data/npc_yangren_anim.json` 一致。

## 环境

- Python 3.10+

## 安装

在仓库根目录或本工具目录下执行：

```bat
cd /d f:\GameDraft\tools\video_to_atlas
python -m pip install -r requirements.txt
```

## 启动

```bat
cd /d f:\GameDraft\tools\video_to_atlas
python main.py
```

## 工作流概要

1. **打开视频**，用时间轴设 **t0、t1**；**播放始终只在区间内**（点播放会从 t0 起播）；可选 **到 t1 后循环回 t0**，否则在区间末尾暂停。拖动圆点会立即约束当前播放位置，无需暂停重播。
2. **色键**：在「色键」分组设 RGB、容差；左侧 **原图 | 色键结果（棋盘底）** 会按「预览采样时刻」刷新（播放器当前时刻 / t0 / 中点 / t1），与抽帧使用同一抠图逻辑。
3. **追加抽取**：设 **目标 FPS、最大帧数**，点 **「追加抽取当前区间到全局库」**。可反复换视频或改区间继续追加，**不会清空**已有库帧。
4. **全局帧库**：缩略图网格展示所有帧；**范围首/尾索引** 用于后续操作。可 **删除库中一段索引**（会从所有动画序列里移除对应帧引用）。
5. **库内首尾蒙版**：设首、尾 **库索引** 与权重，下方为混合预览，便于选循环尾帧。
6. **动画序列**：**新建动画**（名称即导出 JSON 中的 `state` 名）；**将库范围加入当前动画** 或 **用库范围新建动画**；在列表中 **删除帧项、上移/下移**；**帧率、是否循环** 按序列单独设置；**播放预览** 小窗轮播当前序列。
7. **导出**：
   - **导出当前动画**：一张 PNG + `.anim.json`（仅含当前 state）；可选 **同时写出 .meta.json**。
   - **合并导出全部动画**：一张 PNG + 一个 `.anim.json`（含多个 state，类似 `npc_yangren_anim.json`）。可选 **合并时复用相同帧**：按帧 id 去重占格，减小图集；关闭则每个引用单独占格。
8. **单元格内边距**：导出区的「单元格内边距」对应打包时格内留白（与旧版 padding 语义一致）。
9. **帧索引基准**：JSON 中 `frames` 可与工程一致选 **0 或 1** 起。

## 导出文件

- `*.png`：图集（RGBA；色键开启时含透明）。
- `*.meta.json`（可选）：列行、cell 尺寸、帧索引等调试信息（`version: 2`，`packMode: native_equal_cells`）。
- `*.anim.json`：`spritesheet`、`cols`、`rows`、`worldWidth`、`worldHeight`、`states`。

## 区间循环仍觉跳变时（资料与建议）

Qt/QMediaPlayer **做不到真正无缝**区间循环（类似 [QTBUG-34706](https://bugreports.qt.io/browse/QTBUG-34706)、[StackOverflow 讨论](https://stackoverflow.com/questions/70007728/qt-multimedia-is-there-a-way-to-implement-gapless-loop-video-playback-in-pyside)）。可尝试 ffmpeg 缩短 GOP、保证首尾画面可接；Windows 上可调整 `main.py` 中 `QT_MEDIA_BACKEND`。

## 依赖

- `opencv-python`、`numpy`、`Pillow`、`PySide6`
