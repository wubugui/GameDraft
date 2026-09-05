---
id: light-authoring-gizmos
title: 运行时摆灯的可视化手柄(聚光靶点/锥角、面光尺寸/朝向)
domain: runtime
type: mechanism
summary: 判据只有一条——三维朝向/尺寸必须能拖,标量数字框就够;聚光靶点落行走面(正向求交要粗扫+二分),面光正面判据必须用真视线不能写 n.z<0;面板兜底值要与 packLights 逐字对齐
status: active
authority:
  - src/authoring/shapeGizmos.ts
  - src/authoring/lightGizmos.ts#drawShapes
  - src/authoring/lightSpace.ts#groundHitAlong
  - src/authoring/AuthoringMode.ts#moveShapeDrag
  - src/rendering/lighting/lightPacking.ts#packLights
  - src/rendering/lighting/lightingCore.glsl#lcAreaLight
triggers:
  paths: ["src/authoring/*", "src/ui/debugLightingSection.ts", "tools/editor/editors/scene_lights.py"]
  topics: [摆灯, gizmo, 聚光, 面光, 光锥, 锥角, 朝向, orientation, 手柄, 运行时编辑]
last_governed: 2026-09-03
---

# 运行时摆灯的可视化手柄：哪些参数必须能拖，哪些数字框就够

**适用**：改 `src/authoring/**`、`src/ui/debugLightingSection.ts`、
`tools/editor/editors/scene_editor.py` 的灯表单，或给 `LightDef` 加新字段时。

## 一句话判据

**一个参数需不需要画面上的手柄，只看它是不是「三维朝向或三维尺寸」。**

标量（强度、色温、作用半径、软化半径）填数字就行 —— 填 2.5 还是 3.0，画面上立刻
看得出差别，看错了改回来的代价是一次输入。三维朝向不是：`dir: [0.31, -0.87, 0.38]`
这三个数**没有任何人能盲读**，看不出它指哪、更看不出它打在哪。填错的表现是
「灯亮着但地上什么都没有」——与「这盏灯坏了」在画面上完全无法区分。

## 逐参数的结论

### 点光 `point`

| 参数 | 结论 | 为什么 |
|---|---|---|
| `pos` | **拖**（早已有） | 位置就是二维加一个深度，画面上点哪儿摆哪儿 |
| `range` | 圈 + 数字 | 标量；选中时画出作用半径圈就够 |
| `softeningRadius` | 数字 | 标量，且效果是「光斑变平摊」，看数比看圈准 |
| `intensity` / `kelvin` / `color` | 数字 | 标量 |

点光**只有位置需要手柄**。这就是为什么它一直没有形状 gizmo 也能用。

### 聚光 `spot`

| 参数 | 结论 | 为什么 |
|---|---|---|
| `dir` 射出方向 | **必须拖** | 三维单位向量。作者真正想说的是「照哪儿」，不是「三个分量各是多少」 |
| `outerAngleDeg` 外锥角 | **必须拖** | 与 `dir`、与灯高联动：同样 40°，灯挂高一点光斑就大一圈。只看数字推不出光斑多大 |
| `innerAngleDeg` 内锥角 | **必须拖** | 同上；而且它与外角的**相对**关系才是"边缘多硬"，两个数字分开看不出来 |
| `range` | 圈 + 数字 | 标量 |
| `softeningRadius` | 数字 | 标量 |

实现口径（`src/authoring/shapeGizmos.ts`）：

- **靶点落在行走面上**。`dir` 由「灯位 → 靶点」反推，与拖灯本体完全同一套数学
  （`groundWorldAt`）。2.5D 场景里只有行走面这一张几何，靶点没有别的地方可落。
- 正向（画 gizmo）要解射线与行走面的交点：`LightSpace.groundHitAlong`。
  行走面**不是平面**，没有闭式解，只能粗扫找变号区间再二分。粗扫不能省 ——
  屋檐/台阶上「离地高度」并不单调，直接二分会收敛到假根。
- 射不到地面的聚光（平射/朝上）画**悬空靶点**并在 HUD 上说出来，不假装有交点。
  这种灯在画面上看着就像坏了，必须有一行字告诉人「它本来就没朝着地」。
- 锥角手柄从**指针的绝对位置**解，不累加增量：累加会随帧率漂、松手再拖接不上。
- 拖外角时把内角一起顶下去。内角 > 外角会让 `smoothstep(cosOuter, cosInner, ·)`
  两端倒置，光锥当场翻成一个环。

### 面光 `area`

| 参数 | 结论 | 为什么 |
|---|---|---|
| `orientation` 法线 | **必须拖，且是这四种灯里最要命的一个** | 单面面光**背面完全不发光**（`lcAreaLight` 里 `dot(n,-d) <= 0` 直接 return 0）。填反 = 整盏灯全黑，而画面上与「强度填成 0」「enabled 忘了开」一模一样 |
| `rollDeg` 自转 | **必须拖** | `orientation` 只说了「朝哪面」，说不了「哪边是宽」。没有它时 u/v 由 `areaAxes` 从法线用固定配方推出来，**矩形的横竖是算出来的、作者说了不算** —— 斜着的窗、转过角度的灯板根本表达不出来 |
| `size[0]` / `size[1]` | **必须拖** | 面板多大直接决定光斑的软硬与覆盖，数字与画面之间没有可推的关系 |
| `twoSided` | 勾选 + **画出正面** | 勾选本身够用，但必须画出「你现在看到的是发光那面还是黑的那面」，否则改朝向时人不知道自己在往哪转 |
| `range` | 圈 + 数字 | 标量 |
| `softeningRadius` | **不该出现** | 面光根本不吃它 —— `lcAreaLight(…, C.x, twoSided, vis)` 的参数表里没有软化项（只有点/聚光走的 `lcFalloff` 用）。摆着 = 让人调半天没反应 |

实现口径：

- 四角用的正交基**与 shader 的 `areaAxes` 逐字同一条配方**（`axesFromNormal`）。
  差一点就是「拖着框调、画面上亮的却是别处」。
- 「正面朝不朝着我们」用的是**真视线方向**：`qToWorld([0,0,1]) − qToWorld(0)`。
  相机是正交的，`worldToScene` 丢掉的正是伪世界的 qz，所以这条差就是视线。
  ⚠ **不能**偷懒写成 `n[2] < 0` —— 灯世界的基是绕 X 转过 45° 的，视线在灯世界里
  不是 (0,0,1)，那样写会在一半的朝向上判反（`shapeGizmos.test.ts` 锁着这条）。
- **自转不能靠量屏幕夹角**：矩形是投影过的，屏幕上转 10° ≠ 绕法线转 10°（正交投影
  把圆压成椭圆），照着屏幕夹角改会忽快忽慢、越侧对镜头越离谱。正解是利用「投影是
  仿射的」：把指针相对中心的位移解成面板平面里的 (a,b) 坐标（一个 2×2 方程），
  再 atan。起手基必须**冻住**——gizmo 每帧按新 roll 重建，拿当帧的基去解会把已经
  转过的角再算一遍，转起来是加速的。
- 自转占 **`C.y`** 那一格：点/聚光那里装软化半径²，而**面光不吃软化**
  （`lcAreaLight` 的参数表里没有软化项），所以那是一个本来就空着的槽 ——
  不必为自转再开一组 vec4（四组已排满，加一组要动所有 shader 的布局）。
  ⚠ 复用意味着**写串了不报错**，只表现成「调自转没反应」或「点光突然贴脸核爆」，
  `lightPacking.test.ts` 有一组用例专门钉这一格。
- 转朝向走**仰角/方位角**再由 `directionFromAngles` 变回向量：这样拖出来的永远是
  单位向量，也永远落在与太阳/平行光同一族约定里。仰角夹在 ±89°，±90 是万向锁，
  转过去就转不回来。

### 平行光 `directional`

没有位置，不是「摆」出来的东西，`projectLight` 直接返回 null。仰角/方位角两个数字
就是它的全部朝向，且它照的是**整个场景**，没有可指的目标点 —— 数字框够用。

## 缺省值必须与 `packLights` 逐字对齐

面板里的 `?? 兜底` 与 `packLights` 里的 `?? 兜底` **是同一个数**，否则会出现：
一盏没显式填过某字段的灯，面板显示 45、GPU 渲成 40；人一碰那个框就把 45 写进了
数据 —— 看着"没改"，实际改了。已修过两处：

- `outerAngleDeg` 面板兜底 45 → **40**（`packLights` 是 40）
- 聚光 `dir` 面板兜底 `[0,-1,0]` → **`[0,0,-1]`**（`packLights` 是
  `l.dir ?? l.orientation ?? [0,0,-1]`）

`LightDef.orientation` 的注释曾写「缺省时取深度场在 `pos` 处的法线」——
**代码里从来没有这回事**，已改正。

## 已知坑：「灯离地多高」不能用投影采样反推

**把灯投影到画布、在落点采一下地面深度**，是这个读数最自然也最错的算法：
深度图里「深度恒定的一片」在斜视角下**不是**世界里的水平地面。实测把灯抬高，
估出来的地面会**跟着往上爬**，读数只剩一半，且越拖越飘。

正解是解「与灯同 x/z 的那条铅垂线打在行走面上的点」（运行时侧 `lightSpace.groundBelow`，
有单测）。⚠ **迭代必须带阻尼**：在真正水平的地面上，那个不动点迭代的导数恰好是 1，
裸迭代会在两个值之间震荡、偶数次正好跳回出发点，看起来像"收敛失败"其实是永不收敛。

**两侧口径尚未统一**：编辑器侧（`scene_editor._recompute_light_heights`）仍是投影采样那一版。
它只影响 UI 读数与「在画布上定位」的输入、不进数据契约，但**那个读数正是人摆灯时看的数**。
要么把它换成同一条解法，要么直接向运行时要这个读数——别在编辑器里另发明第三种。

## 相关

- `src/authoring/shapeGizmos.ts` —— 形状手柄的几何（含 `shapeGizmos.test.ts` 的往返闭合判据）
- `src/authoring/lightSpace.ts` —— 坐标换算与 `groundHitAlong` / `groundBelow`
- [character-lighting](character-lighting.md) / [entity-lighting](entity-lighting.md)
- [coordinate-spaces](coordinate-spaces.md) —— 灯的作者面（原点=**画面中心**、Y 朝上、单位 wu）
  已在那张总表里单列一行，以它为准
