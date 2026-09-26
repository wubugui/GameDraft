---
id: vfx-beams
title: 光柱 / 体积光(效果资产里的 beams[] · 美术可控 · 一次求弦 · 不照角色)
domain: runtime
type: mechanism
summary: 粒子效果里与 emitters 并列的 beams[];3D 截面视锥(矩形或正 3–8 边形,不许圆)/ 2D 画面光带两模式;片元一次解析求弦、弦中点采样一次,不步进;亮度乘在显示空间;不照角色、不进光照缓存;整道光柱按落点当一个实体排;没有寿命(只有开关 + 淡入淡出),所以一次性效果带光柱永远不自收;形状判据一份契约 JSON 三方共用;制作人砍掉的一长串 VLB 功能别加回来
status: active
authority:
  - src/systems/vfx/vfxBeam.ts
  - src/data/vfxBeamContract.json
  - src/rendering/vfx/vfxBeamGlsl.ts
  - src/rendering/vfx/VfxBeamView.ts
  - tools/editor/shared/vfx_beam.py
  - src/data/types.ts#VfxBeamDef
triggers:
  paths:
    - "src/systems/vfx/vfxBeam.ts"
    - "src/data/vfxBeamContract.json"
    - "src/rendering/vfx/vfxBeam*"
    - "src/rendering/vfx/VfxBeamView.ts"
    - "tools/editor/shared/vfx_beam.py"
  topics: [光柱, 体积光, 光束, 丁达尔, god rays, 天窗漏光, 光带, beams, beamLit, 闪电]
  tasks: [加光柱, 调体积光, 让尘埃只在光里亮, 用光柱拼闪电]
verified_by:
  - src/systems/vfx/vfxBeam.test.ts
  - src/systems/vfx/VfxSystem.beams.test.ts
  - src/rendering/vfx/vfxBeamGlsl.test.ts
  - tools/vfx_workbench/tests/test_beam.py
  - tools/editor/tests/test_scene_vfx_beam_overlay.py
last_governed: 2026-09-23
---

## 是什么(一句话)

制作人 09-16 定调:**美术可控、随便放、性能好**,不要物理积分(与物理光照混用不冲突);视角 2D、远观,相机不会贴近 / 走进光柱,
所以"近看才需要"的功能全部砍掉——清单在 `docs/玩法功能需求清单.md` A3.6(内外强度、眩光、距离淡出 / LOD、抖动、步进、
体积阴影、光源绑定、触发区、新动作……)。**落地时别把砍掉的加回来。** 布置 / 条件 / `playVfx`·`stopVfx` / 推给游戏全复用
[[vfx-system]];作者面见 [[vfx-workbench]]「光柱」。

## 硬契约(违反即 bug)

- **形状判据只有一份**:范围 / 枚举 / 缺省的唯一真相源是 `vfxBeamContract.json`,运行时构造、工作台保存闸门、构建期校验器共用,
  Python 镜像 `vfx_beam.py` 报错与 TS **逐字同句**(测试真跑 node 对拍)。运行时闸门不过直接抛(整个实例建不起来,不是半个)。
- **两种模式**:`3d` = M-world 里的截面视锥(`from`→`to` 相对锚点世界点;截面矩形或**正 3–8 边形,不许圆**——远看圆柱反而怪;
  张角、绕轴转);`2d` = 画面坐标的梯形光带,可选按锚点脚下直立面参与原画深度遮挡。画面 + q 深度 ↔ 世界只经 `sceneQAffine`
  (从空间的 `toScene`/`toQ` 探出来,field / planar 同一套),没有它 3D 光柱不画。
- **画法**:一道光柱一张网格(视锥角点投影的凸包);片元把画面点换回世界视线,与 N+2 个半空间求**一次弦**(不步进),远端截在
  原画深度 + 容差,在弦**中点采样一次**:边缘遮罩 × 沿长度曲线 × 世界空间噪声 × 图案遮罩 × 起伏 × 淡入淡出。
  **GLSL / WGSL 两份孪生**:游戏画 `vfxBeamWgsl.ts`,工作台原画视图编 `vfxBeamGlsl.ts`;两份一起改,`src/rendering/shaderTwins.test.ts` 逐函数守门。
- 🔴 **亮度乘在显示空间,不乘在线性空间**:宿主先过显示变换再乘份量(与粒子 alpha 同口径);先乘再编码边缘是一刀硬边。
- **不照亮角色、不进光照缓存**(任何灯变化都整张重烘 RGBA16F,光柱每帧在动)。混合 add / screen / normal(预乘)。
- **前后关系**:整道光柱按落点当一个实体排(3D 取终点正下方地面点、2D 取锚点脚点);`sort: background / foreground` 钉到最后 / 最前。
- **生命周期**:光柱**没有寿命**,只有 `active` 开关 + `fadeIn / fadeOut`。`stop()` 按 fadeOut 淡;布置条件翻假 / `stopVfx` 时带光柱的实例
  进 draining、**淡完才收模拟**;淡出中 `playVfx` / 条件翻回 = 原模拟接着淡入,不重建。帧只在锚点挪动时重算。
- **光柱里的尘埃**:发射形状 `{kind:'beam'}` 在光柱体积里均匀出生;外观 `beamLit {beam, gain}`:该点亮度 k = 光柱份量 × gain,
  透明度 × min(1,k)、颜色 × 光柱色 × clamp(k,1,8),k≈0 不画。
- **图案遮罩贴图**按实例装,装不到先不带图案画 + log;存在性走 `asset_reference_audit`。主编辑器只读画起点 / 中轴 / 轮廓。

## 已知坑

- 粒子 / 薄片 / 雷 / 光柱的着色器都有 GLSL 与 WGSL 两份:WGSL 在 `vfxShaders.ts` / `vfxBeamShaders.ts` 并排,雷与光柱的核函数
  另有 `vfxBoltWgsl.ts` / `vfxBeamWgsl.ts`(与 `vfxBoltGlsl.ts` / `vfxBeamGlsl.ts` 对应;GLSL 版粒子工作台也在用,原样保留)。
  算法改动两份一起改,改完跑 `node tools/render_parity/run.mjs --case 粒子`(见 pixi-shader-wgsl-port)。

| 坑 | 症状 / 对策 |
|---|---|
| 带光柱的效果用 `playVfx({oneShot})` | 光柱不 stop 就永远不暗 ⇒ `finished` 永远假,柱子戳到切场景。放完显式**软停**;软停收尸看 `liveCount` 不看光柱,所以 `fadeOut` 要短于最后一颗粒子寿命,否则淡到一半"啪"地没了;硬 `stopVfx` 对临时实例是当场删 |
| 尘埃看不见 | 先看 `beamLit.gain`:强度 0.4 的光柱配 gain 1 中位 k 只有 0.25,义庄 `dust_motes` 用 4 |
| 预热完的光柱已是满亮 | 淡入步长在预热子步里也推 |
| 拿一道光柱调参数做闪电 / 细曲折的光 | `beams` 是数组:细、曲折、分叉的东西用多节短光柱首尾相接拼,芯与晕各一条叠(09-18 雷击被打回过);先看真实参照再定结构 |

代价(09-16,义庄 1280×960):0 道 1.1–1.3 ms、4 道 1.6、8 道 1.8 ms;模拟侧可忽略。

## 怎么验证

`npx vitest run src/systems/vfx/vfxBeam.test.ts src/systems/vfx/VfxSystem.beams.test.ts src/rendering/vfx/vfxBeamGlsl.test.ts`
(半空间与弦长闭式对暴力、采样都在体积里、起伏确定性、淡出后才收、显示空间乘份量);Python 侧 `test_beam.py`(闸门逐字同句)。
真机:F2 粒子段 `stats.beams`。
