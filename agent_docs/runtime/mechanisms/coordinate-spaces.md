---
id: coordinate-spaces
title: 坐标空间总表(屏幕→场景 wu→像素栅格→伪世界 q→M-world)
domain: runtime
type: mechanism
summary: 全项目六个坐标空间的单位/原点/住户/权威源与逐条可验判据;两个 M(det ±1)、两套像素栅格(比例非恒定 4)、着色在 M-world 而 march 在 q——混用一律不报错只是效果不对
status: active
authority:
  - src/rendering/lighting/worldReconstruct.glsl
  - src/utils/worldReconstruct.ts#WR_CONTRACT
  - src/systems/SceneManager.ts
  - tools/scene_relight/geometry.py
  - tools/editor/editors/scene_lights.py
triggers:
  paths:
    - "src/utils/worldReconstruct.ts"
    - "src/rendering/lighting/**"
    - "src/rendering/Character*"
    - "src/core/SceneDepthSystem.ts"
    - "tools/scene_relight/**"
    - "tools/editor/editors/scene_lights.py"
  topics: [坐标, 坐标系, 空间, 伪世界, wu, 世界单位, ppu, 深度场, M 矩阵, 标定, 像素栅格]
  tasks: [摆灯, 改光照, 改深度, 改碰撞, 改影子, 加空间参数, 反投影]
verified_by:
  - src/utils/worldReconstruct.test.ts
  - src/rendering/lighting/lightPacking.test.ts
  - tools/editor/editors/tests/test_scene_lights.py
last_governed: 2026-08-21
---

## 是什么(一句话)

本项目有**六个**坐标空间。混用**一律不报错**——只是效果不对(光偏、影子错位、
碰撞漂、参数调了不生效),所以每个空间的单位、原点、住户都要认死。

## 全链路

```
屏幕像素
  │  (screen − worldContainer.pos) / projectionScale        ← 相机变换
场景坐标 = 世界空间,单位 wu   ← NPC / 热区 / spawn / 碰撞 / 灯的作者面
  │  × native.w/worldWidth              │  × work.w/worldWidth
native px ─────────────┐                └──> work px
  │  ((px−cx)/ppu, (cy−py)/ppu, d)   ← ⚠ 翻 Y 就在这里(cy−py)
伪世界 q   ← 深度场、march、shader 里的一切几何
  ├─ × R (det=+1, depthConfig.M.R) ──> M-world   ← 着色(N·L / 1/r² / 面光)
  └─ × M (det=−1, lighting.json)  ──> probe 晶格世界  ← **只有** probe/体素查表
```

| 空间 | 单位 | 原点 | 谁住在里面 |
|---|---|---|---|
| 屏幕 | 屏幕像素 | 画布左上 | 只有最终合成 |
| **场景坐标(世界空间)** | **wu** | 画布左上 | NPC/热区/spawn/碰撞/**灯的作者面** |
| native px | 像素 | 图左上 | `background.png` / `raw_depth_rg.png` |
| work px | 像素 | 图左上 | 照明载荷(`lighting2/`、probe) |
| **伪世界 q** | q(无名) | 画面中心、深度 0 | 深度场、march |
| **M-world** | 同 q | 同 q | 着色:法线、N·L、1/r²、天光半球 |

**尺度锚:角色高 150 wu**,28 个场景恒定——这是 wu 一致的判据。
`worldWidth` 逐场景 700–4000 wu;`ppu` 逐场景 220–573(相机标定,不是世界单位在变)。

## 铁律 0 · 光照一律在世界空间、单位 wu(制作人 2026-08-30 定死)

> **所有的光照必须在世界空间计算,单位一律 wu。**
> **任何 q 空间的量都必须先转换到世界空间(朝向过 R、尺度过 `wuPerQUnit`),再参与光照计算。**

这条**高于**下面所有条款,没有例外、没有"反正自洽就行"的豁免。

### 「朝向转了、尺度没转」同样算违反

2026-08-30 制作人当场否掉的一种写法:把灯位只乘 `quPerWu`(折尺度不折朝向)、
再让 shader 算 `P = R·q`,于是两边都成了**「世界朝向 + q 尺度」的混合体**。
它自洽、画面也对(全局等比缩放不改变光照结果),但它:

- 让 `range` / `softeningRadius` / area `size` / 光晕半径在 shader 里**不是 wu**,
  而作者面明明按 wu 填的 —— 读代码的人无法判断某个长度到底是哪把尺;
- 让 `1/r²` 的量纲随场景漂(`wuPerQUnit` 逐场景 154–880),
  任何跨场景的强度直觉都不成立;
- 制造了一个**没有名字的第四空间**,而本卡的全部价值就是"每个空间都有名字"。

**要转就一次转到底:朝向过 R,尺度过 `wuPerQUnit`,落到真正的 wu 世界。**
不允许停在半路。

### 为什么它是可执行的(不是口号)

q ↔ M-world 之间就是一个**纯旋转 R**,这一点全项目逐场景验过:

| 判据 | 实测(28/28) |
|---|---|
| q 三轴两两垂直 | 正交相机 ⇒ 屏幕右/屏幕上/视线本来就互相垂直 |
| q 三轴**等尺度**(z 与 x/y 同一把尺) | `atan(depth_per_sy × ppu_native)` **逐位等于** `R` 的绕 X 俯角(45°/36°/40°/50°),误差 < 0.001° |
| `R` 正交 | `max\|RRᵀ−I\| ≤ 2.2e-16`,三行长度全 1,两两夹角全 90.000000° |
| `R` 是真旋转 | `det(R) = +1.000000000000` |

⚠ **`depth_per_sy × ppu = 1` 不是判据**,那只在 45° 俯角的场景成立(实测 24/28)。
拿它当判据会把 temple/城隍庙夜/梦_农家院/破屋 四个场景误判成"各向异性"——
它们只是俯角不是 45°。真正的不变量是 `atan(depth_per_sy × ppu) == R 的俯角`。

因为 R 正交且等尺度,所以:
- 法线转世界**直接 `R·n` 即可,不需要逆转置**(逆转置只在非正交/非等尺度时才必要);
- q 里的点乘就是欧氏点乘,`1/r²` 与 `range` 在 q 里是真距离;
- **两边都在 q 里算出来的点乘,数值上等于两边都在世界里算**(`(Rn)·(Rl) = n·l`)。
  所以"转到世界空间"对已经自洽的 q/q 组合是**零行为变化**的重构 ——
  没有任何理由不转。转了才能一眼看出有没有混。

### 落地清单(改光照代码时逐条对)

进入任何 `lc*Light` / `dot(N,L)` / `1/r²` 之前必须已在 M-world:

| 量 | 怎么到世界空间 + wu | 权威源 |
|---|---|---|
| 位置 `P` | `wrQToWorld(R, q) * uWuPerQUnit` —— **朝向过 R、尺度过 wuPerQUnit,两样都要** | shader |
| 法线 `N` | **原样用 `n`,不要转**。两张法线图烘出来就在世界空间(见下) | `geometry.py:183-190` / `bake_normal_atlas.py` |
| 灯位 `A.xyz` | **原样就是 wu**。作者面 `pos` 已是世界空间 wu(编辑器 `scene_lights.q_to_world` 折过 R),`packLights` **不做任何缩放** | `lightPacking.ts` |
| 灯方向 `D.xyz` | **原样透传即可**。作者用编辑视图的三维 gizmo 在**世界空间**调(制作人 2026-08-30 确认),本来就是世界向量 | `lightPacking.ts` |
| 长度类(`range` / `softeningRadius` / area `size` / 灯体与光晕半径 / 阴影 bias 与厚度) | **原样是 wu,不缩放** | `lightPacking.ts` |

**允许留在 q 的只有三类**,因为它们不是光照计算:
① 深度场 march(视线恰好是 q 的 z 轴,反投影回像素取深度);
② probe / 体素**查表**(走 `lighting.json world.M`,det=−1,那是第三个空间);
③ 大气光晕的视线积分(`SceneLightingPass` 里 `wrWorldToQ(A.xyz)` 转回 q ——
   它积的是沿视线的路径,不是表面着色)。
这三类要在代码里**写明理由**,否则按违反处理。

### ⚠ 两张法线图**本来就烘在世界空间**(2026-08-30 查实,反直觉,必读)

本会话为此走了一整圈弯路:先给灯循环加了 `nW = R·n`,后来查烘焙源码才发现是**回归**,
已全部回退。钉死在这:

| 法线 | 怎么烘的 | 结论 |
|---|---|---|
| 场景 `lighting2/normal.png` | `tools/scene_relight/geometry.py:183-190`:`pos = q @ R.T` 得**世界位置**,再取梯度叉积 | **已在 M-world** |
| 角色 `atlas.normal.png` | `tools/animation_pipeline/bake_normal_atlas.py`:从剪影 alpha 推高度场,在**图像像素空间**取梯度 `(gx, -gy, -6)` | **已在世界空间** —— 角色是**直立 quad**(沿精灵上移 h,过 R 之后在世界里就是正上方 h,零前后偏移),其局部轴恰好是世界 X / Y / −Z |

⇒ **灯循环直接用 `n`。再乘一次 R = 把法线整体仰起一个俯角**(雾津街头 45°),
表现是头顶的灯过亮、水平方向来的灯偏暗。

⇒ **反方向才需要转**:角色 GI 的球谐图集是按 **q 空间法线**烘的,查表前必须
`nQ = Rᵀ·n`(R 正交 ⇒ 转置即逆)。这一条长期缺失,2026-08-30 补上。

**机械闸**:`src/rendering/lighting/worldSpaceShading.test.ts` 两头都锁 ——
`lc*Light` 的法线实参必须是 `n`(出现 `nW` 就红)、`probeE`/`gatherRT` 必须收 `nQ`。

### 当前欠账(2026-08-30 收口后)

| 位置 | 状态 |
|---|---|
| 场景灯循环 / sDay 太阳项 | ✅ 用法线图直出的 `n`(它已是世界) |
| 角色灯循环 | ✅ 同上 |
| 角色 GI(`probeE` / `gatherRT`) | ✅ 用 `nQ = Rᵀ·n`,与 q 空间烘的球谐对齐 |
| 角色太阳项 | ✅ 用 `nQ` 配 `uSunDirQ` —— 它与 probe 同源,同在 q |
| 长度单位 | ✅ 灯位 / range / 软化 / 面光尺寸 / 灯体与光晕半径全是 **wu**;`P = R·q × wuPerQUnit` |
| `packShadowBias` | ⚪ **刻意留在 q**:深度域的量,与 march 的 q 深度直接比较,不是光照量 |
| `UnifiedCharacterShader` | ✅ 一并归位(该路径 `UNIFIED_CHAR_PATH_ENABLED = false` 停用中) |

## 硬契约(违反即 bug)

1. **两个 M 永远不许混**(铁律 3)。`depthConfig.M.R` det **+1**(游戏约定,q→M-world),
   `lighting.json world.M` det **−1**(实验室 GL 右手,只给 probe 查表)。
   实测 28/28 个场景严格成立。喂错 = Z 轴整体翻号,影子前后颠倒。
2. **两套像素栅格永远不许混**(铁律 4)。native 配 `depthConfig.M`,work 配 `meta.cal`。
   ⚠ **比例不是恒定的 4**:实测 1.95–4.0,只有 19/28 个场景是 4。
   但两套各自自洽(尺寸比与 ppu 比逐场景逐位相等)。
3. **着色在 M-world,march 在 q**。两者只差正交的 R(实测 `|RᵀR−I| ≤ 1.11e-16`),
   所以距离与夹角**逐位相同**——但 N 与 L 必须在**同一个**里。
   法线是在 `pos = q @ R.T` 里烘的(`geometry.py`),所以它是 M-world 的。
4. **着色不能用裸 q**。天光半球按"朝上"加权、灯的仰角相对世界上定义,
   而裸 q 的 Y 是**屏幕上**不是世界上。
5. **禁止任何纯屏幕空间光照**(制作人红线)。march 每步都把 q 反投影回像素取
   该处真实表面深度,深度分离逐步做——与"屏幕空间模糊/衰减"不是一回事。
6. **改 GLSL 必须同步改 CPU 镜像并 bump `WR_CONTRACT`**;
   `worldReconstruct.test.ts` 直接从 GLSL 文本解析该常量比对,改一边就红。

## 怎么验(每条都有现成判据)

| 要验什么 | 判据 | 实测 |
|---|---|---|
| wu 是否一致 | 角色身高 `char_wu × scene_per_wu` 跨场景恒定 | **150**(28/28) |
| q 是否各向同性 | 地面法线在 M-world 里应 ≈ (0,1,0) | 雾津街头 **6.4°** |
| **q 三轴是否等尺度**(铁律 0 的地基) | `atan(depth_per_sy × ppu_native)` == `R` 的绕 X 俯角 | **28/28**,误差 < 0.001° |
| **光照有没有混空间** | 每个 `lc*Light(` 的法线实参必须是 `nW` 一类的世界量,不是裸 `n` | 见铁律 0 的欠账表 |
| R 是否正交 | `max\|RᵀR−I\|` | **1.11e-16** |
| 两个 M 没搞反 | `det(R)=+1`、`det(M)=−1` | 28/28 |
| 两套栅格自洽 | 尺寸比 == ppu 比 | 逐场景相等 |
| `backgroundWu` 对不对 | 应**恰好等于** `worldWidth` | 雾津街头 4000 |

## 已知坑(都是真踩过的,都不报错)

| 坑 | 症状 |
|---|---|
| 造了「米」这个单位(`1.7 / char_wu`) | 游戏里没有米;作者被逼拿虚构量填参数 |
| 把**伪世界 q 单位**叫成 wu | 以为"同一个 wu 在不同场景差 5.7 倍",实则是相机 ppu 在变 |
| `meta.cal` 配 `native.w` | `meta.cal` 是 **work** 的标定,差 4 倍(读数报 16000 而非 4000) |
| 「native/work 反正是 4 倍」 | 只有 19/28 个场景成立 |
| `intensity` 换空间没换量纲 | 照度 = I/r²,r 换单位则照度差 `k²`(雾津街头 774400 倍),影子浓度整片归零 |
| 法线在 q 里烘、着色在 M-world | N·L 整体偏一个 R,光的方向不对 |
| 字节域 vs 归一化 texel | CPU 拿 0..255 直接喂 GLSL 口径的解码 = 整体 ×255 |

## 相关

- 光照参数的作者面与折算:[[lighting-scale-reference]]
- 角色逐像素照明:[[character-lighting]]
- 场景光环境 / 实体阴影:[[entity-lighting]]
