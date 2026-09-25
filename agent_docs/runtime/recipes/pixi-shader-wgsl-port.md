---
id: pixi-shader-wgsl-port
title: 把 Pixi 自定义着色器补上 WGSL(迁移到 WebGPU 的逐个移植配方)
domain: runtime
type: recipe
summary: 给运行时每个 GLSL 自定义着色器补一份 WGSL(Shader/Filter 的 gpu 程序),GLSL 原样保留;用 tools/render_parity 证明 Pixi-WebGL(= master)与 Pixi-WebGPU(RHI 设备)逐像素一致才算完成;列出 WGSL 与 GLSL 语义不同、翻译时静默出错的点和工具依赖的禁改清单
status: active
authority:
  - tools/render_parity/harness.ts
  - src/rendering/legacy/pixiWebGpuPatches.ts
triggers:
  paths: ["tools/render_parity/**"]
  tasks: [移植着色器到 WGSL, 补 gpuProgram, 着色器像素对照, 迁移 WebGPU]
  topics: [WGSL, GpuProgram, WebGPU, 像素对照, render_parity, 着色器移植]
last_governed: 2026-09-25
---

## 目标与完成判据

迁移期游戏仍在 Pixi-WebGL 上跑(与 master 一致);每个自定义着色器**补一份 WGSL,GLSL 一个字不动**
(多个工具直接切片编译这些 GLSL,见文末禁改清单)。一个着色器算移植完成 =
`tools/render_parity/cases/<模块>.ts` 里有覆盖它全部分支 / 开关的用例,且 `node tools/render_parity/run.mjs --case <前缀>` 全绿。

像素对照的两侧:参考 = Pixi WebGL 渲染器跑 GLSL;候选 = Pixi WebGPU 渲染器(用 RHI 的 GPUDevice,装了
`installPixiWebGpuPatches`)跑 WGSL。同一个 `build(env)` 各调一次,输入(`env.dataTexture` 固定种子)逐字节相同。

## 写法

- `Shader.from({ gl: {...}, gpu: { vertex: { source, entryPoint }, fragment: { source, entryPoint } }, resources })`;
  `Filter` 同理(`Filter.from` 或 `new Filter({ glProgram, gpuProgram, resources })`)。宿主类对外接口不变。
- 网格 WGSL 的 Pixi 约定:`@group(0) @binding(0) var<uniform> globalUniforms`(`uProjectionMatrix`、`uWorldTransformMatrix`、
  `uWorldColorAlpha`、`uResolution`)、`@group(1) @binding(0) var<uniform> localUniforms`(`uTransformMatrix`、`uColor`、`uRound`),
  程序里声明了它们 Pixi 才自动绑。自定义资源放 `@group(2)` 起,**变量名 = resources 的键名**。
  参考 `node_modules/pixi.js/lib/rendering/high-shader/shader-bits/*.mjs`。
- 滤镜 WGSL 约定:`@group(0)` 固定 `gfu`(GlobalFilterUniforms)、`uTexture`、`uSampler`;滤镜自己的 uniform 组放 `@group(1)` 起。
  参考 `node_modules/pixi.js/lib/filters/defaults/alpha/alpha.wgsl.mjs`。
- 纹理在 WGSL 里要单独的采样器:resources 里补 `<名>Sampler: source.style`(GLSL 侧多出来的资源名 Pixi 会忽略;以对照结果为准)。
- **uniform 组成员在 WGSL struct 里的顺序必须与 JS 里 uniforms 对象的声明顺序一致**(Pixi 按声明顺序、WGSL 对齐规则算偏移)。
  `size: N` 的数组 → `array<T, N>`。
- 共享片段(lightingCore / worldReconstruct 等)的 WGSL 版放同目录 `.wgsl` 文件,`import x from './foo.wgsl?raw'` 打进包里,
  不要运行时 fetch(发行包的 MIME 表没有 wgsl)。

## 静默出错的翻译点(每条都会编过、画面不对)

- `mod(x, y)`(GLSL,向下取整)≠ WGSL `x % y`(向零截断):负数结果不同。写 `x - y * floor(x / y)`。
- WGSL 的 `textureSample` 只能在一致控制流里调(否则编译失败);分支里改用 `textureSampleLevel(t, s, uv, 0.0)`
  ——只对**没有 mip 的纹理**与 GLSL `texture()` 等价(本项目运行时纹理基本都是单级)。
- `texelFetch` → `textureLoad`;`textureSize` → `textureDimensions`;`atan(y, x)` → `atan2(y, x)`;`dFdx/dFdy` → `dpdx/dpdy`;
  `inversesqrt` → `inverseSqrt`;`mix/clamp/smoothstep/step/fract` 同名同序。
- 片元坐标:离屏目标上 GLSL `gl_FragCoord` 与 WGSL `@builtin(position)` 在 Pixi 里行序一致(Pixi WebGL 画 RT 时翻了投影);
  直接画到画布时两者 y 方向相反。以对照结果为准,别凭印象翻。
- `bool` / 整型 uniform:Pixi 的 uniform 类型串只有 f32/i32/u32 系列;GLSL 里 `if (uFlag > 0.5)` 这类照搬。
- 浮点目标(`rgba16float`)对照时容差按值域给(1e-3 相对量级),8 位目标 `2/255` 起;**不许为了过对照调大容差掩盖真差异**,
  差异集中在某片区域时先查翻译。
- `rgba32float` 目标在 WebGPU 核心里不可混合:画进去的管线要关混合,否则建管线失败。

## 禁改清单(工具直接读这些,改了工具或工具测试会坏)

- GLSL 源文件与切片标记原样保留:`src/rendering/burn/burnShade.glsl`(`//__BURN_SHADE_BEGIN__/END__`,且 `BurnFilters.ts` 里要出现
  `sliceGlsl(BURN_SHADE_SRC, 'BURN_SHADE')`)、`src/rendering/breathingShade.glsl`、`src/rendering/charShadeCore.glsl`、
  `src/rendering/vfx/vfxBeamGlsl.ts`、`src/rendering/vfx/vfxBoltGlsl.ts` 的导出名与内容。
- `anim_preview` 直接用 `SpriteEntity` / `EntityLightingFilter.createForEntity` 与其 setter / `PlanarEntityShadow`:对外 API 不变,
  且它自建的 Pixi 是 WebGL,GLSL 必须继续能用。
- 工具测试按正则读的常量:`contactAo.ts` 的常量、`lightEnv.ts` 的 `contact: X, contactSize: Y,`、`backgroundSway.ts` 的
  `const GRID_CELL = 24;`、`lightPacking.ts` 的 `export const DEFAULT_*_WU = v;`、`SceneLightingSystem.ts` 的 `defaultSceneLighting`、
  `Renderer.ts` 的 `entitySortZ`。`vfxBeam.ts` / `vfxSpace.ts` / `vfxProgram.ts` 要能在 Node 里跑(不许引 DOM / Pixi)。
- 数据格式(`public/assets/**` 的 JSON、烘焙产物)一律不动。

## 跑对照

```
PLAYWRIGHT_CORE=<playwright-core 包目录> RENDER_PARITY_BROWSER=<chrome 可执行文件> node tools/render_parity/run.mjs --case <前缀>
```
或 `npx vite --config tools/render_parity/vite.config.ts` 后浏览器打开(`?case=` 过滤,页面有参考 / 候选 / 差异缩略图)。
