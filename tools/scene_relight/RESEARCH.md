# 单张 2D 手绘游戏背景 Relighting / 时刻·天气迁移 技术调研(2026-08)

> 本工具技术选型的依据。评估基准四项硬需求:手绘风格适应性 / 结构·风格稳定性 /
> 参数可调性 / 可 ship(许可证+批量+算力;本机 GTX 970 4GB)。

## 结论(TL;DR)

- **没有任何 2024–2026 的 AI relighting 模型能单独同时满足「可调 + 稳定 + 可 ship」**:
  扩散类输出本质是重采样、逐像素不可复现;几乎全部照片域训练,手绘图风格漂或崩;
  效果最对口的 IC-Light v2 恰好不开权重且非商用。
- 业界 2D 手绘游戏的 day-night 全部是**确定性资产 + 确定性 shader**:
  Graveyard Keeper(10 张时刻 LUT 插值)、Don't Starve(colour cubes)、
  深度/法线假 3D 光、emissive 层。
- 故本工具走**程序化 depth 感知重打光**(方案 B);扩散只建议将来做离线关键帧
  参考(方案 A,须 ControlNet-depth + 低 denoise + 美术 QC,本机显存不够,需云端)。

## 各路线要点

### 1. 扩散 relighting
| 方法 | 许可证/权重 | 对本需求 |
|---|---|---|
| IC-Light v1 (SD1.5) | Apache-2.0 | 官方承认对风格化图片会照片化;方向仅四档;★★ 只配当离线参考 |
| IC-Light v2 (Flux) | **非商用、无权重** | 保绘画风格最好但不可 ship;★★ 只看 demo 找感觉 |
| SwitchLight (Beeble) | 闭源 SaaS | 人像影视域,场景域外;★☆ |
| LumiNet / ScribbleLight / DiLightNet / UniRelight | 部分开源,UniRelight 非商用 | 参考图/涂鸦控制,室内照片域;★~★★ |

### 2. 内在分解 + 传统重合成
- RGB↔X / IntrinsicEdit:X→RGB 重合成仍是生成式,细节重绘;室内照片域。
- Careaga & Aksoy IID(质量公认最好):**仅学术许可**,商用要谈授权。
- Marigold(Apache-2.0):可商用的 depth/normal/IID 估计。
- **本项目已有逐场景深度(char-lighting lab),这条路最贵的一步已付过钱**;
  且手绘 mask(美术手涂 shading/emissive)比任何 IID 模型都准。组件价值 ★★★★。

### 3. 传统/混合(业界实际做法)——本工具采用
- 3D LUT / color grading:结构 100% 不变、LUT 插值=连续时刻、零许可证;上限是
  不产生新光影结构(窗户不会自己亮)——本工具用参数化调色替代 LUT,再用
  发光 mask + 深度阴影 + 深度雾补上"新光影结构"。★★★★★(基座)
- depth→normal 假 3D 光、depth fog、wetness、emissive 层:全参数连续、
  完全确定、运行时/离线成本≈0。★★★★☆
- Neural Preset(确定性颜色映射):可把美术调好的一张夜景样板提成 preset 批量套。

### 4. 时刻/天气专门模型
- CoMoGAN(Apache-2.0,连续时刻插值)、HiDT(BSD-3):照片域,低分辨率,
  手绘直喂必崩;概念参考 > 工程价值。
- WeatherWeaver / WeatherFLUX / WeatherEdit(2025):控制接口设计好,
  但视频/照片域研究品,无可商用权重。

## 落地方案(已实施 = 方案 B)

- **B(本工具)**:深度感知程序化重打光 + 参数预设,覆盖全部连续区间。
- **A(未来可选)**:对视觉差异最大的档(深夜/暴雨)用 SDXL/Flux img2img
  (denoise 0.3–0.5)+ 双 ControlNet(depth=项目深度图 + lineart/tile)+ 固定 seed
  离线出关键帧候选,美术 QC 后定稿为普通图片资产;与 B 的中间态插值配合。
  需 8–16GB 显存(云端/别的机器)。
- **明确不做**:运行时跑扩散;IC-Light v2 / UniRelight / DA-V2-Large 进生产链
  (许可证);CycleGAN 系直接处理手绘图。

主要来源:IC-Light repo 与 v2 讨论区、Awesome-Relighting、LumiNet/ScribbleLight/
DiLightNet 论文与 repo、RGB↔X、Careaga&Aksoy Intrinsic、Marigold、Graveyard Keeper
图形技术文章(gamedeveloper.com)、GDC "LUTious Color"、Don't Starve colour cubes、
CoMoGAN/HiDT、WeatherWeaver(arXiv 2505.00704)等;链接见会话调研记录。
