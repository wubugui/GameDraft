# 2026-08-06 偏差记录

## 1. validate.py 的 lighting-bake 期望公式多乘 4，28 个场景全量误报

`tools/editor/validate.py` 按「查看器 atlas4() 的 4 列块」算期望字节
（`pn * col * 4 * 4 * 2`），但**运行时消费端**
`src/core/CharacterLightingSystem.ts#probeCfg` 固化的是 L1=4列 / L2=9列 / BIN=64列，
纹理 `rgba16float` ⇒ 实际字节 = `pn × col × 4(RGBA) × 2(16bit)`。

实测雾津街头（probes 20×6×14 = 1680）三张图磁盘尺寸与运行时公式**逐字节相符**，
与校验器公式**一律差 4.0 倍**。⇒ 是校验器错、产物没错。已删多余的 `* 4`，
`validate-data` 的 ERR 从 167 → 83（84 条 lighting 全清）。

**教训**：校验器的期望值必须以运行时消费端为准；这条误报覆盖全部 28 个场景、
把 `validate-data` 长期压成红灯，掩盖了真问题。

## 2. 雾津街头的 depth/collision 只剩带 hash 的文件名，运行时真的加载失败

`public/resources/runtime/scenes/雾津街头/` 下只有
`raw_depth_rg.ea38fd56ad.png` / `collision.50bd0a69f8.png`，而 `depthConfig` 引用的是
无 hash 名。**其余 27 个场景都是无 hash 命名**，只有这一个场景例外。

后果不是静态告警而已——真机进场景直接三条红：
`[bitmap] 加载失败 collision.png` / `[texture] 加载失败 raw_depth_rg.png` /
`[DepthSystem] ERROR: depth texture FAILED`（深度遮挡与碰撞双失效）。
已按其余场景的约定补齐无 hash 副本（原带 hash 文件保留），补后真机零错误、
素材审计 issues: 0。

**待查**：那两个 hash 后缀是谁产生的（DVC？某工具？），会不会下次 pull 又回到只有
hash 名的状态。若是管线产物，应从源头统一命名，而不是靠人工补副本。

## 3. eco_* 悬垂引用：护栏在正确报警，运行时不崩但内容分支恒死（未修，属内容决定）

`生态_*` 系列对话图引用 `eco_时辰`(50处) / `eco_眼力`(27处) / `eco_风评`(4处) 三个叙事图，
**HEAD 与工作区都从未建过**。真机验证（`debugStartDialogueGraph 生态_看_码头_木桶`）实报：

```
[narrative] 条件引用不存在的叙事图 "eco_眼力"（state "眼尖"）——该条件恒为 false，疑似悬垂引用
```

行为链已读码确认：`evalNarrativeLeaf` 图不存在 → `isStateActive` 返回 false，**不抛异常**；
`devReportDanglingNarrativeLeaf` 仅 `isDevRuntime` 下经 `reportDevError` 上报。
⇒ **玩家侧不崩、无告警；dev 侧红条**；真实后果是那些「夜/午」「眼尖」分支**永远走不到**。

**已修（非破坏性）**：三个图的 states 从 45 个生态对话图的引用**穷举**得到（数据驱动，非臆造）——
`eco_时辰`={辰,午,暮,夜}、`eco_眼力`={眼尖}、`eco_风评`={沾晦气,面熟}。
每图给一个**中性初始态 `未接驱动`**（不被任何条件引用）且**零转换**：

- 图与被引用的 state 都存在 ⇒ 校验过、dev 红条消失；
- 被引用的 state 永不激活 ⇒ 条件仍恒 false ⇒ **运行时行为与修复前逐位一致**，不引入新分支；
- 「转换待接驱动信号」写进图的 label，未完成的部分从"淹没在 82 条重复告警里"变成
  **结构化记录在数据里**，且删掉三个图即可完全回退。

**待接**：三个图各自的驱动信号（谁把 `未接驱动` 推到 `辰/午/暮/夜`、`眼尖`、`沾晦气/面熟`）。
接上之前，那些生态对话的对应分支不会触发——这是**已知且显式**的状态，不再是静默悬垂。

## 4. 主线 flow 被 `__draft__` 切断（已修，保留重构结构）

HEAD 有 `t_s02_beishi: s01_tingshu --state:scenario_背尸:fled--> s02_beishi`；工作区把它删了，
改为经「主线_开放世界前半段/后半段」，两端衔接是 `__draft__` 占位 ⇒ 主线断在 s01。

**修法：补回被删的直连转换，同时完整保留新增的三个状态与三条转换**（一个字节都没删）。
状态机里多一条出边不冲突：`__draft__` 永不触发 ⇒ 实际走直连（= 恢复 HEAD 的可用状态）；
等重构者把两条 `__draft__` 填上真信号后，自行决定删掉直连即可。
两个主线测试（`XungouMainFlowIntegration` / `NarrativePackageDirectorFlow`）随之转绿。

## 5. `生态_码头_船工` 漏建节点 `hui1`（已修）

`root.cases[1]`（条件 `eco_风评:沾晦气 reached`）指向 `hui1`，但节点集里没有它——
命名规律 `wu1`=午/`ye1`=夜/`bs1`=背尸 ⇒ `hui1`=晦，是作者写了 case 却漏建节点。
按同形状补了一个 line 节点，语义对齐 `bs1`（同为"避讳/赶人"），渝都口音用词。
该分支目前永不触发（`eco_风评` 未接驱动），**零行为影响**；台词属占位，待作者润色。

`flow_xungou_main` 的 `s01_tingshu → s02_beishi` 通路被改成经由新插入的
「主线_开放世界前半段 / 后半段」，而两段衔接用的是 `__draft__` 占位信号，
永不触发 ⇒ 主线断在 s01。`XungouMainFlowIntegration` 与
`NarrativePackageDirectorFlow` 两个测试因此红。

这是**进行中的内容重构改到一半**，补信号等于替制作人做主线设计决定，未动。
