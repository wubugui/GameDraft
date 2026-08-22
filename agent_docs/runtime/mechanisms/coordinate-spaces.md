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
