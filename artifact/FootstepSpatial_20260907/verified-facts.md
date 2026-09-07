# 脚步声 + 空间化音频 · 一手核实事实

> 本文件只记**我自己读代码逐条核实过**的事实，每条带 file:line。
> 与并行取证报告冲突时，以本文件为准（除非对方也给了 file:line 且更精确）。
> 核实日期 2026-09-07，worktree `footstep-spatial-audio`。

---

## 1. 坐标空间：两个都叫「世界空间」的东西

项目里有**两个**被称作「世界坐标 / wu」的 frame，**共用一把尺，不共用原点与朝向**：

| 名字 | 原点 | 轴向 | 维度 | 住户 |
|---|---|---|---|---|
| **场景坐标** | 画布左上 | x 右、y **下** | 2D | `player.x/y`、NPC、热区、spawn、zone polygon、`Camera.getX/getY` |
| **灯世界 / M-world** | 画面中心 | x 右、Y **上**、Z 纵深 | 3D | 灯 `pos`、`N·L`、`1/r²`、角色着色 |

出处：`src/authoring/lightSpace.ts` 文件头。⚠ 该文件头明说
`agent_docs/runtime/mechanisms/coordinate-spaces.md` 的总表把「灯的作者面」列在
「原点=画布左上」那一行是**错的**（已入 inbox 偏差记录）。**以 lightSpace.ts 为准。**

尺度锚：**角色高 150 wu**，28 场景恒定。

### 两者互转的权威实现（不许自己再写一遍）

`src/authoring/lightSpace.ts` 的 `LightSpace` 类：

| 方法 | 作用 |
|---|---|
| `groundWorldAt(sceneX, sceneY): Vec3` | **场景坐标 2D → 灯世界 3D 地面点**。深度由行走面场补出。这就是「点哪儿摆哪儿」 |
| `raise(ground, heightWu): Vec3` | 沿灯世界 **Y** 抬高 |
| `worldToScene(w): {x,y}` | 灯世界 3D → 场景坐标 2D（**正交投影，丢深度**） |
| `groundBelow(w): Vec3` | 灯正下方的地面点（**带阻尼迭代**，裸迭代在真·水平地面上原地打转，单测锁着） |
| `qToWorld / worldToQ` | q ↔ 灯世界（转朝向 R + 折尺度 `wuPerQUnit`） |

⚠ `LightSpace` 一律走 **work 栅格**（照明载荷 `meta.cal`），**不是** native 栅格
（`depthConfig.M`）。两套栅格的比例**不是恒定的 4**（实测 1.95–4.0，只有 19/28 场景是 4）。
桌面编辑器 `tools/editor/editors/scene_lights.py` 用的是 native + `depthConfig.M`，
**不许把它的 ppu/cx/cy 照抄过来**。

### 运行时怎么拿到 LightSpace

`Game.buildLightSpaceGeometry()` @ `src/core/Game.ts:4101`，返回 `LightSpaceGeometry | null`。

```
const ground = this.characterLighting.groundDepthField;
const rows   = this.characterLighting.shadowBasisRows;   // det=+1 的游戏约定 R
const uni    = this.characterLighting.unifiedGeometry;
if (!ground || !rows || !uni || !this.sceneLighting.active) return null;   // ← 关键
```

### 实体三维世界坐标的现成链路

`Game.ts:2647` `getPlayerLightWorld()`：脚点 → `chestQAt` → M-world → `×wuPerQUnit`。
`CharacterLightingSystem.chestQAt(worldX, worldY, worldH)` @ `src/core/CharacterLightingSystem.ts:360`
返回**胸口**的 q（脚点会被地面高差放大，站台阶上影子方向会跳）。
`heightQ(worldH)` @ :385 是「场景世界 px 高度 → q」。

⚠ 两个 M 不可互换：`depthConfig.M.R`（det=**+1**，游戏约定，`wrQToWorldRow`）
vs `lighting.json` 的 `world.M`（det=**−1**，只服务 probe/体素查表，
`wrQToProbeWorldComponent`）。混用 = Z 轴整体翻号，不报错。
出处 `src/utils/worldReconstruct.ts` 第 3 节注释与 `matrixDet3` 的文档。

---

## 2. 🔴 决定架构的事实：六个背尸场景没有任何三维数据

```
public/resources/runtime/scenes/{跑马梁,崖墓入口,崖墓前段,崖墓前段1,崖墓后段,崖墓正式}/
    → 只有 background.png。无 collision.png、无 raw_depth_rg.png、无 lighting/
public/assets/scenes/{同上}.json
    → 无 depthConfig、无 lighting、zones 数量为 0
```

对照：`雾津街头` / `义庄` / `mountain_pass` 都有 `depthConfig.M.R` + `lighting` + 烘好的载荷。
全仓 37 个 runtime 场景目录中 **28 个有 `lighting/<背景基名>/geometry.json`，9 个没有**，
没有的正好包含全部背尸场景。

**推论（不可绕过）**：
`buildLightSpaceGeometry()` 在这六个场景里**恒返回 null**。任何"假定三维链路可用"的
实现，在**最需要它的那六个场景里是静默失效的**。系统必须两级：

- **Level A（有载荷）**：`LightSpace.groundWorldAt` → 真三维 M-world，距离/声像全三维。
- **Level B（无载荷）**：只有场景坐标 2D + 作者给的高度。**绝不假装有三维**。
- 当前处于哪一级**必须在 debug 状态里可见**，不许静默降级。

---

## 3. 相机（`src/rendering/Camera.ts` 全文核实）

```
S = getProjectionScale() = pixelsPerUnit × zoom × worldScale
```

| API | 行 | 语义 |
|---|---|---|
| `getX() / getY()` | 114-115 | 相机中心，**场景坐标 wu**，已 `clampCenterWorld` 到场景边界 |
| `getZoom()` | 116 | **推拉镜头**的量 |
| `getSceneBaseZoom()` | 80 | 场景配置基线 `scene.camera.zoom`，进场景时记录，**不入存档** |
| `getWorldScale()` / `getPixelsPerUnit()` | 117-118 | 视口/场景适配 |
| `getViewWidth/Height()` | 137/142 | `screenWidth / S`，wu |
| `worldToScreen(wx,wy)` | 159 | 场景坐标 → 屏幕像素 |
| `update(dt)` | 102 | 平滑跟随：`alpha = 1-(1-smoothing)^(dt*60)` |

**关键取舍依据**：窗口 resize 改的是 `screenWidth/Height`（以及可能的 `worldScale`），
推拉镜头改的是 `zoom`。所以表达「听者远近」**必须用 `zoom / sceneBaseZoom`，
不能用 `getViewWidth()`**——否则玩家拉大窗口时所有声音突然变远。

相机是**平滑跟随**（`update` 里插值），所以玩家确实会偏离画面中心；
声像随之轻微移动是**正确行为**，不是抖动 bug。

---

## 4. Howler 2.2.4 的空间能力（`node_modules/howler` 逐行核实）

`package.json` `"main": "dist/howler.js"` = **core + spatial 插件拼接**。
所以 `Howl.pos/stereo/orientation/pannerAttr` 与 `Howler.pos/orientation`（听者）**全部可用**，
**不需要碰任何私有 `_sounds[]._node`**。

### 节点链

```
AudioBufferSourceNode → [_panner] → _node(GainNode) → Howler.masterGain → destination
```
出处：`setupPanner` @ dist/howler.js:3241 `sound._panner.connect(sound._node)`；
play 路径 @ :2144 `sound._node.bufferSource.connect(sound._panner)`。

⇒ **panner 在 gain 之前**，所以 `volume()` 与 `pos()` 相乘、互不打架。

### 🔴 调用时序（弄错就是每一步都咔一下）

`setupPanner` @ :3244-3246 结尾：
```js
if (!sound._paused) { sound._parent.pause(sound._id, true).play(sound._id, true); }
```
**对已在播放的声音第一次调 `pos()` 会 pause+replay。** 短音效上表现为咔哒或重头播。

正确时序（已核实安全）：
1. **`play()` 之前**在 Howl 上设 `pannerAttr({...})` 与 `pos(x,y,z)`（**不带 id** = 组默认）
2. `play()` → 新 `Sound` 在 `init` 里继承 `_pos` 并调 `parent.pos(...,id)`
   （spatial 插件覆写的 `Sound.prototype.init` @ :3142-3161）；
   此时 `_paused === true`（core init @ :2224 设的），**不会走 pause/replay 分支** ✅
3. 之后用 `pos(x,y,z,sid)` 逐声源微调 —— 守卫是 `if (!sound._panner || sound._panner.pan)`，
   已有 spatial panner 时**不会**重跑 setupPanner ✅

池化复用也安全：spatial 覆写的 `Sound.prototype.reset` @ :3170-3191 会
从 parent 重新取 `_pos` 并重设，不会留下上一次的旧位置。

### 🔴 共享 Howl 不能用来做空间化

组级 `_pos` 会被**该 Howl 的所有后续 play 继承**。而 `AssetManager` 按
`path::loop` 缓存**共享** Howl（`src/core/AssetManager.ts:398`），多个调用点共用一个实例。
在共享实例上设组级 `_pos` = 污染所有其它调用点（它们会突然被空间化，且位置是别人的）。

⇒ **空间化播放必须用自己的 Howl，不走 AssetManager 的共享缓存。**

代价可接受，因为：Howler 有**全局解码缓冲缓存** `var cache = {}` @ :2377，
按 src URL 存解码后的 AudioBuffer（:2470 写、:2387 命中复用）。
第二个 `new Howl({src: 同一个})` **不重新下载、不重新解码**。

⚠ 反向影响：`unload()` @ :1785-1796 只在 **没有别的 Howl 引用同一 src** 时才
`delete cache[src]`。所以我们持有的独立 Howl 会**让 AssetManager 的 LRU 淘汰失去意义**
（缓冲还在）。声源集是场景级、数量有界（每场景个位数），可接受，但**必须随场景卸载显式释放**。

---

## 5. 音量口径（`src/systems/AudioManager.ts` 核实）

现行：`howl.volume(clamp01(entry.volume(base) × 全局通道值))`，
四处（`playBgm` / `addAmbient` / `playSfx` / `playTransientEntry`）口径一致。
`clamp01` 把上限钉在 1.0。

⇒ 新增的空间化播放**必须沿用同一口径**，且**距离衰减由 panner 承担、不要再乘进 volume**
（乘两次 = 平方衰减，不报错）。

---

## 6. 动画帧（`src/rendering/SpriteEntity.ts` 核实）

- `frameIndex` 私有 @ :229，`getFrameIndex()` 公开 @ :677
- 推进在 `update(dt)` @ :625：`frameDuration = 1/(fps × playbackSpeed)`，
  `fps` 缺省 8（:632-634）
- 支持 `playbackReverse`、loop 回绕、hold（:602）、起始帧（:608）

⇒ 轮询 `getFrameIndex()` 检测跳变可行，但**必须处理**：反向播放（帧号递减）、
单帧动画（恒不跳变）、以及 loop 回绕（n-1 → 0 是一次合法跳变）。

---

## 7. Zone（`src/data/types.ts` 核实）

- `ZoneDef.polygon: Array<{x, y}>` @ :3073 —— **场景坐标 wu**
  （雾津街头 worldWidth=4000，实测 polygon 点 x=1043.9 y=118.2，量级吻合）
- `ZoneKind = 'standard' | 'depth_floor'` @ :3029 —— 新增一种 kind 有先例
- `ZoneSmellConfig` @ :3036 —— **要照抄的范式**：zone 声明气味 → `SmellSystem` 监听
  `zone:enter/zone:exit` 驱动，zone 层优先级低于 action 层

⇒ 「区域脚步集」照 `ZoneSmellConfig` 写，不另起机制。
⚠ 但六个背尸场景 **zones 为空**，所以还必须有**场景级默认脚步集**，
否则这套在目标关卡里一点用没有。
