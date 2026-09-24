---
id: canvas-stage
title: 画布(场景之外那张屏幕空间的面)
domain: runtime
type: mechanism
summary: 叠图/文档揭示/实体/特效四类 item 共用一张有序表与一个 order 顺序空间;kind 前缀就是"句柄永不互访"那条解耦的落地形式;画布实体与特效一律不吃场景光照,特效自带第二套 VfxSystem 并逐实例一个宿主
status: active
authority:
  - src/rendering/CanvasStage.ts
  - src/rendering/Renderer.ts#canvasStage
  - src/systems/canvas/CanvasStageSystem.ts
  - src/systems/canvas/CanvasVfxHost.ts
  - src/rendering/CutsceneRenderer.ts#attachToCanvas
  - src/rendering/vfx/VfxRenderer.ts#hostFor
triggers:
  paths:
    - "src/rendering/CanvasStage.ts"
    - "src/systems/canvas/**"
    - "src/rendering/Renderer.ts"
  topics: [画布, canvas, 绘制顺序, order, 屏幕空间, 叠图, 文档揭示, 画布实体, 画布特效, showCanvasEntity, setCanvasOrder, playCanvasVfx]
  tasks: [往画布上放东西, 调绘制顺序, 让实体画到文档揭示前面, 改画布层, 加画布 item 类型]
verified_by:
  - src/rendering/CanvasStage.test.ts
  - src/rendering/worldFadeLayering.test.ts
  - src/systems/DocumentRevealManager.test.ts
last_governed: 2026-09-21
---

## 是什么(一句话)

场景**之外**的一张屏幕空间的面:底下一张图,前面按作者给的 `order` 画别的东西。
叠图、文档揭示、实体、特效四类 item **共用同一个顺序空间**,谁前谁后随时可改
(制作人 2026-09-21 立项定名"画布")。

## 为什么必须是一张表(不是"再加一个容器")

在它之前,屏幕空间的东西散在 `CutsceneRenderer` 的几张私有表里,各自 `addChild` 到
`cutsceneOverlay`,**顺序由 addChild 先后决定**;而实体与粒子的唯一宿主是
`worldContainer.entityLayer`。两者是**兄弟容器**——"实体/特效能不能画到文档揭示前面"
在架构上**无解**:那一层填什么 `zIndex` 都没用,因为比的根本不是同一个父节点下的次序。

## 舞台分层(改这一段要想清楚遮挡关系)

```
worldContainer      场景(背景/阴影/实体),吃相机与世界滤镜
worldFadeLayer      世界渐黑(fadeWorldToBlack)——只黑掉世界
canvasStage.layer   画布:四类 item 按 order 排        ← 不吃相机、不吃世界滤镜
cutsceneOverlay     字幕 / 电影黑边 / 对白框 / 小游戏
uiLayer             全屏渐黑 / 对话压暗 / GUI
```

- **🔴 世界渐黑必须在画布之下**。画布落地那一版(2026-09-21)把它留在了 `cutsceneOverlay`
  (画布之上),梦段 D「先渐黑 2 秒 → 再出盖脸纸」的那张图就被黑场**整张吞掉**——
  不报错,玩家只看到一片黑。迁移前渐黑与叠图同在 `cutsceneOverlay`,谁在上面取决于
  **谁先加进去**;而现有内容里唯一两者重叠的用法要的正是"图画在黑场上"。
  所以渐黑只黑世界,画布上的东西照样画在黑场之上。**代价**:画布上已经在的东西不会跟着
  世界一起变黑——要它消失就显式收掉(现有内容没有依赖"跟着黑"的写法,已逐处核过)。
  由 `worldFadeLayering.test.ts` 钉住。
- 世界渐黑进不了过场白名单,所以它与过场的字幕 / 对白框不会同时出现;对话的压暗
  (`dimBackground`)在 UI 层,前后都盖在画布之上,与这次分层无关。
- 电影黑边仍在 `cutsceneOverlay`,故画布上的东西**永远压不到黑边之上**。

## 硬契约(违反即 bug)

- **kind 前缀是命名空间,不许合并**。`hideOverlayImage` 必须收不到文档揭示
  (2026-09-12 制作人定调解耦,见 [overlay-image-handle-semantics](overlay-image-handle-semantics.md)
  与 [document-reveal-three-states](document-reveal-three-states.md))。在画布里这条靠
  `kind:name` 的键落地:`image:告示` 与 `document:告示` 天生是两个键,**不再需要两张 Map**。
- **`order` 缺省 0,同 order 保持登记先后**。这是"叠图/文档揭示从 `cutsceneOverlay` 迁到画布后
  画面不变"的前提(迁移前顺序就是 addChild 先后)。改排序实现时先想这条。
- **画布只管"在不在、排第几",不管销毁**。`detach` / `clear` 只摘父子关系与登记,**不 destroy**:
  各类 item 的释放纪律各有其主(叠图的 `disposeGpu`、实体的挂件与 lit mesh、粒子的网格池),
  收归画布就是第二份真相。
- **🔴 画布特效的容器绝不能 `destroy({ children: true })`**。那容器里装的是 `VfxRenderer` 的
  批网格,**网格的所有者是渲染器**(它要自己 `removeFromParent` + `destroy` + 手收 geometry)。
  容器代它销一遍,下一帧 `destroyView` 读到的 `mesh.geometry` 已是 null 当场抛 ——
  **而那一抛在渲染路径上,按 [pixi-v8-traps](pixi-v8-traps.md) 第一条就是整局死透**
  (ticker 再不排帧)。正确顺序:先 `removeChildren()` 把网格摘出来,再拆容器,
  网格由渲染器在下一拍 `render` 里自己收。2026-09-21 真机踩到过。
- **画布上的实体与特效不吃场景那条光照链**(制作人 2026-09-21:"画布和场景着色没啥关系,
  是一套完全自己的东西")。实体只调 `loadFromDef`、不接 lit shader 工厂;特效那套
  `canLight: false` / `getToneEnv: null` / `getDepth: null`,恒走无光路。
- **画布实体的整体缩放写在外包容器上,不许动 `SpriteEntity` 自己的缩放**——那一层是
  朝向符号 × 透视 × 轨迹叠加合成出来的,插一脚进去镜像与轨迹会同时错(画面还对,只有采样错)。
- **画布实体的动画吃暂停闸**:暂停一览表里"角色动画"是停的那一列
  (见 [world-pause-and-game-clock](world-pause-and-game-clock.md)),但**不分探索/演出态**
  ——画布本就是演出面,对话与过场里照样要动。

## 生命周期：画布**不跟着场景走**

换场景(`scene:beforeUnload`)**不清画布** —— 四类 item 一视同仁，都留着。
这是刻意的：画布是场景**之外**的面，而且"叠图留着、实体没了"那种不一致比两者都留更难查。

真正清画布的只有三条路：

- **读档**：`deserialize` 整批收掉（表演态不入档，旧时间线不写新状态）；
- **过场结束 / 中断**：`CutsceneManager.cleanup` → `CutsceneRenderer.cleanup` 收叠图与文档揭示；
- **作者显式收**：`hideOverlayImage` / `hideDocument` / `hideCanvasEntity` / `stopCanvasVfx` / `clearCanvas`。

所以把东西放上画布的编排**自己负责收**，别指望换场景替你收。

## 特效为什么是"第二套"

场景那套 `VfxSystem`/`VfxRenderer` 是跟着场景走的。画布另起一份实例,把三件事拧到画布口径:

| | 场景那套 | 画布这套 |
|---|---|---|
| 空间 | 照明载荷建的真 3D 场 | 平面近似,`depthScale=1`、不吃透视 |
| 宿主 | 唯一 `entityLayer`,按脚底 y 分桶 | **逐实例一个 canvas item**(`hostFor`),`sortByScene:false` |
| 着色 | probe / 场景灯 / 深度遮挡 | 一律无光路 |

- `VfxRenderer` 的宿主与排序因此**参数化**了:`hostFor` 不给 ⇒ 回落 `entityLayer`,
  `sortByScene` 不给 ⇒ 按场景脚底 y 分桶。**场景那条路的行为逐位不变**,改它时守住这条。
- 画布那套用**私有 EventBus**:接主总线的话换场景会把画布上的特效一起散掉,而画布是
  场景之外的面。空间的初始化靠往私有总线发一次 `scene:ready`
  (`VfxSystem` 的空间在那一拍建,且 `getSceneData()` 返回 null 时**整个 rebuild 直接 return**)。

## 已知坑

- **`order` 必须能填负数**。负 order 正是"排到底图后面";编辑器的可选数值控件缺省下限是 0,
  不单独登记量程就是"负顺序配不出来,而且不报错"(`_CANVAS_NUMBER_FIELDS`)。
- **可选数值参数不能用普通 float 控件**:`xPercent: 0` 是合法取值(靠左边),
  用普通控件"没填"与"填 0"分不开,等于把靠边那一档配没了。一律走 `optional_number`(带"不写"档)。
- 画布 item 按屏幕百分比定位,**窗口尺寸一变必须重摆**——重摆回调登记在画布表里,
  由 `Renderer.notifyAfterResize` 在通知订阅者**之前**统一跑(订阅方会读位置)。

## 怎么验证

真跑:`revealDocument` 出一张整屏原画 → `showCanvasEntity` 给 order 100(该出现在原画前)、
另给一个 order −50(该被原画压住看不见)→ `playCanvasVfx` 给 order 500;
再 `setCanvasOrder` 把两个实体的 order 对调,画面必须立刻互换。
⚠ **别拿原画里画上去的东西当特效的证据**(神龛那张原画自带一缕烟,照着它做 A/B 会得出错误结论);
把特效摆到画面空处再判,或直接读 `canvasStage.list()` 与实例的 `liveCount`。
Browser pane 隐藏时 rAF 停,粒子要靠 `debugStepTicks` 手动推。
