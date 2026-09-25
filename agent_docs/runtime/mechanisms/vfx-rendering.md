---
id: vfx-rendering
title: 粒子渲染(lit / tone / unlit 三条着色路 · 按水平纵深分桶 · 首帧不卡的三件事)
domain: runtime
type: mechanism
summary: 粒子一批一张网格、按"水平视线纵深"在实体之间分桶;着色逐视图三选一(有载荷 lit / 要受光没载荷 tone / lit:false),lit 原样拼接角色那段实体灯循环、吃场景同一次 packLights,受光倍率来自场景 lightFactors.particles(天气压暗 envDim 自动跟);只有漫反射,水/尘靠 emissive 或 lit:false;所有粒子 GL 程序开局后台编、揭幕前闸里等编完并跑完预热——任何一帧可见画面不许同步编 shader / 补跑预热
status: active
authority:
  - src/rendering/vfx/VfxRenderer.ts
  - src/rendering/vfx/vfxShaders.ts
  - src/rendering/vfx/VfxBatchMesh.ts
  - src/rendering/vfx/VfxPlateBatchMesh.ts
  - src/rendering/glProgramWarmup.ts
  - src/rendering/CharacterLitSprite.ts
  - src/core/CharacterLightingSystem.ts#getLightFactors
  - src/systems/SceneManager.ts#setRevealGate
triggers:
  paths:
    - "src/rendering/vfx/**"
    - "src/rendering/glProgramWarmup.ts"
  topics: [粒子受光, 粒子着色, lit, tone, unlit, lightGain, emissive, 粒子发黑, 粒子排序, 分桶, 粒子在人前后, 粒子卡顿, shader 编译, 揭幕前闸, 预编译]
  tasks: [改粒子渲染, 加粒子 shader, 查粒子卡顿, 查粒子发黑, 查粒子前后关系]
verified_by:
  - src/rendering/vfx/VfxRenderer.test.ts
  - src/rendering/vfx/vfxGlPrograms.test.ts
  - src/rendering/glProgramWarmup.test.ts
  - src/rendering/lighting/worldSpaceShading.test.ts
  - src/systems/SceneManagerRevealGate.test.ts
  - src/systems/vfx/VfxSystem.prewarm.test.ts
last_governed: 2026-09-23
---

## 是什么(一句话)

[[vfx-system]] 的画法那一半:一批粒子一张网格,插在实体层里按纵深分桶;着色与 NPC 同源;
首次出现不许卡帧。坐标与光照一律 M-world(铁律 0,见 [[coordinate-spaces]])。

## 硬契约(违反即 bug)

- **一批粒子 = 一张网格,不是 N 个 Sprite**(实体层排序 / 裁剪逐子节点遍历,逐 Sprite 遮挡还要逐个 RT)。
- **前后关系按水平纵深分桶**:实体是立在脚点上的直立 quad ⇒ "粒子在它前面" ⟺ 粒子沿**水平视线轴**比它的脚点近,
  与离地多高无关。桶阈值 = 场上实体按脚点 y 排好、各带脚点水平纵深;桶上限合并时保留宿主。
  ⚠ 别退回"比正下方地面点的画面 y"(悬在低地面上方的蝙蝠 / 檐口的烟会被整批错排到人前)。
- **挂在实体身上的实例**(`setInstanceSortHost`,手持火把 / 燃烧火苗)整团钉在宿主同一侧,对别的实体照常分桶——
  否则起火点离身体那几 wu 抵不过湍流,一团火被人身劈成前后两半。
- **遮挡拿粒子自己的纵深比原画深度**(同一条 `depth_mapping` 解码、同一个 `depth_tolerance`),不是角色那套脚深度代理。
- **着色三条路,逐帧校验、条件变了就重建视图**(`viewStale`):**lit**(有照明载荷)/ **tone**(要受光但本场景 / 时段没载荷,
  走 NPC 同一套色调融入)/ **unlit**(`lit:false`)。三条都过与背景同一组显示变换(少了就是"背景很亮、粒子漆黑")。
  载荷晚到、开关、贴图、发射器换了都要重建——只在建视图时问一次会一路错到换场景。
- **受光必须吃场景那一次 `packLights`,灯循环原样拼接角色的 `ENTITY_SCENE_LIGHTS_GLSL`**,不许粒子侧另写
  (`worldSpaceShading.test.ts` 钉着 `vfxShaders.ts` 里不许出现 `lc*Light`)。probe 查表传 nQ、灯循环用世界法线(同角色口径)。
- **受光倍率**:lit 路 `E = (probe 间接项 · 间接factor + 实体灯直接项 · 直接factor) · 总factor · lightGain`。三项 factor 与 `eChroma`
  来自当前场景 / 时段的 `lighting.lightFactors.particles`(不是逐效果数据,也不跟角色运行时曝光覆盖);天气 / 演出压暗 `envDim`
  乘在总倍率上、粒子每帧重取所以自动跟上(口径见 [[scene-lighting]])。逐发射器的 `appearance.lightGain`(0..10)乘在收到的光上、
  **不乘自发光份额**;unlit 恒 1。逐效果强度只许写进本视图自己的 uniform 组——场景采样组 / 角色灯组与角色共用。
- **角色 / 粒子那组实体灯与显示变换换场景时归零**(lighting unloader),否则下一个没写 lighting 块的场景接着用上一个场景的灯与 wuPerQ。
- **受光只有漫反射**,没有镜面、没有前向散射。靠高光才看得见的(水滴、火星)写 `appearance.emissive`;靠散射才看得见的环境颗粒
  (尘埃、雾)走 `lit:false + blend:add + tint`(代价:不随场景光变,是作者摆的氛围件)。别拿 tint 硬提亮受光粒子。
- **长活 shader 的场景纹理槽位与 `createLitShader` 同处维护**;切场景前粒子先销毁自己的 shader——漏一个槽 = 整局卡死([[pixi-v8-traps]])。
- 🔴 **首帧不卡三件事,缺一件回到原样**(09-16 实测进茶馆第一帧 11 s):
  ① 受光粒子主函数只 `probeE`,**不拼 `gatherRT`**(uMode 0 体素步进对粒子不可达,拼进来画面不变、D3D 编译 3 s → 11 s);
  ② 全部粒子 GL 程序列在 `vfxGlPrograms()`,开局 `GlProgramWarmup` 用并行编译扩展后台编,揭幕前闸里等编完再交给 Pixi——
  **新增粒子程序必须进这张清单**(测试扫目录拦);
  ③ 进场景的实例在揭幕前闸里建好模拟并跑完预热;中途新建的按**工作量**预算分帧跑(不按毫秒,第几帧跑完可复现),
  预热中的模拟不画。闸的时序见 [[scene-onenter-reveal-timing]]。

## 已知坑(都不报错)

- 粒子 / 薄片 / 雷 / 光柱的着色器都有 GLSL 与 WGSL 两份:WGSL 在 `vfxShaders.ts` / `vfxBeamShaders.ts` 并排,雷与光柱的核函数
  另有 `vfxBoltWgsl.ts` / `vfxBeamWgsl.ts`(与 `vfxBoltGlsl.ts` / `vfxBeamGlsl.ts` 对应;GLSL 版粒子工作台也在用,原样保留)。
  算法改动两份一起改,改完跑 `node tools/render_parity/run.mjs --case 粒子`(见 pixi-shader-wgsl-port)。

| 坑 | 症状 |
|---|---|
| 粒子 GLSL 只拼 `LC` 不拼 `WR_CORE` | 编译失败,Pixi 只报 "Could not initialize shader",整批不画 |
| 薄片受光 program 声明 `aNrm`,配了 billboard 网格 | 绑定抛异常 = 整局卡死;两种网格各配各的 program |
| 浅色材质受光整体偏暗(跑马梁白纸画成深灰) | 09-12 量过:受光亮度只有无光的 4.9%,而原画 / albedo = 1.00——probe 绝对量级与原画对不上,归角色照明那条线;浅色纸钱暂走 `lit:false` + 按原画标定的 tint |
| 纯漫反射画水 / 尘 | 水滴 23 vs 背景 68、尘埃均值 3.3/255:像素 A/B 全是"画了",肉眼全是"没有"——判据同时看变化像素数**和**截图 |
| 全画面 diff 为 0 就判"没画" | 先 `mesh.parent.toGlobal()` 确认那一团在不在画布里(相机跟着玩家,锚点可能在屏外) |
| 揭幕闸超时用 `performance.now()` | 揭幕前跑了多少预热随机器快慢变;之后分片与一口气逐位相同,最终状态不受影响 |

## 怎么验证

- `npx vitest run src/rendering/vfx src/rendering/glProgramWarmup.test.ts src/rendering/lighting/worldSpaceShading.test.ts src/systems/SceneManagerRevealGate.test.ts`。
- 真机着色路:`window.__game.vfxRenderer.views`(`lit` / `toneSrc` / `depthGroup.uniforms.uHasDepth`);夜里是否借了几何看
  `characterLighting.isGeometryOnly`。量卡帧:包 `WebGL2RenderingContext.prototype.getProgramParameter` / `shaderSource` 计时,
  `fixedTickMode` + `debugStepTicks(1)` 逐帧推;`window.__game.glProgramWarmup.pending` 看交接。
  画面取证走 [headless-visual-verification](../recipes/headless-visual-verification.md)。
