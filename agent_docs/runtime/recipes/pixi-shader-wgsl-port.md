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
`tools/render_parity/cases/<模块>.ts` 里有覆盖它全部分支 / 开关的用例,且 `node tools/render_parity/run.mjs --case <前缀>` 全绿,
**并且**证明 WebGL 一侧的输出与移植前逐字节相同(对移植前后的源码各跑一遍对照,哈希 GL 侧结果)——
GL 侧就是对照的「master」参考,它自己漂了,对照一致也没有意义。

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
- 纹理在 WGSL 里要单独的采样器:resources 里补 `<名>Sampler: samplerOf(source)`(`src/rendering/legacy/gpuSampler.ts`),
  **不许直接放 `source.style`**——纹理销毁会连带销毁它的 style,style 销毁让同组 BindGroup 自毁,WebGL 下整帧也抛
  (换了纹理漏换采样器就中招)。`samplerOf` 按采样参数共享、永不销毁;`gpuSampler.test.ts` 扫源码拦 `.style` 写法。
- **uniform 组成员在 WGSL struct 里的顺序必须与 JS 里 uniforms 对象的声明顺序一致**(Pixi 按声明顺序、WGSL 对齐规则算偏移)。
  `size: N` 的数组 → `array<T, N>`。
- **补了 gpu 程序后资源分组会变**:原来全在第 99 组,之后按 WGSL 声明的组号走;WebGL 按组号升序分配纹理单元,
  所以 WGSL 里纹理的声明顺序要与原 resources 对象里的相对顺序一致,纹理单元才不挪(这是「GL 侧逐字节不变」的前提)。
- 运行时换某个纹理资源(ping-pong 等)时,它的 `<名>Sampler` 跟着换成 `samplerOf(新纹理)`(参数不同就是另一份采样器)。
- **共用同一份 GLSL 源的所有 Shader 必须在同一次改动里一起补上同一个 gpu 程序、同样的资源布局**:WebGL 侧
  按 GLSL 程序缓存 uniform 同步函数,按第一个 Shader 的分组布局生成;布局不一致会让别的 Shader 的 uniform 错位。
- 每个资源键都要在 WGSL 里有同名声明(掉进第 99 组 → WebGPU `setBindGroup(99)` 失败);Pixi 的解析要求
  `var` / `var<uniform>` 后面正好一个空格。自定义 Geometry 属性按 WGSL `@location` 参数名匹配。
- WGSL 不许给多分量 swizzle 赋值(`c.rgb /= c.a`),整向量重建。`discard` 之后不许 `textureSample`:采样挪到前面。
- WGSL 的 `clamp` / `min` / `max` 不许向量配标量(写 `vec2<f32>(0.0)`)。几何体的每个属性(哪怕没用到,如 `aUV`)都要在
  WGSL 顶点输入里声明,否则 Pixi 每次绘制都告警。
- **光栅化填充规则两后端相反**:Pixi-WebGL 画 RT 时翻了投影,水平三角形边若恰好落在像素中心(1/32 像素内),
  两边一个画这一行、一个不画(整行差)。这是光栅化差异不是着色器差异:用例几何避开这种边;整画面对比 master 时
  出现零星的整行差也按这个归因。
- WGSL 模板字符串标 `/* wgsl */`,别标 `/* glsl */`(`glslSymbols.test.ts` 会把所有 `/* glsl */` 当 GLSL 检查)。
- 共享 WGSL 函数文件可以直接引用一个模块作用域的 uniform 变量,只要每个包含它的程序都用同一个变量名声明它
  (WGSL 模块作用域不讲声明先后)。
- **共享光照片段的 WGSL 版已就位**(各文件顶部写了用法约定):`src/rendering/lighting/wgslChunks.ts` 导出
  `WR_CORE_WGSL` / `WR_TEX_WGSL` / `WR_SPRITE_WGSL` / `LC_WGSL`(与 GLSL 同样的切片)及整文件;`CharacterShadingFilter.ts`
  导出 `CHAR_LIGHT_COMMON_WGSL` / `PROBE_SAMPLING_WGSL` / `SKYAO_SAMPLING_WGSL`;`CharacterLitSprite.ts` 导出
  `CHAR_LIGHTS_WGSL`(结构体)/ `ENTITY_SCENE_LIGHTS_WGSL`(灯循环);`charShadeCore.wgsl`。要点:片段不读绑定,纹理与采样器作
  函数参数;GLSL 片段自带的 uniform 变成按名赋值的值结构体(`ClcProbe` 等,**逐字段按名赋值,别用位置构造**——
  同为 f32 的字段会静默错位);灯循环读模块作用域的 `charLights` 绑定,由宿主以自己的 group/binding 声明;
  WGSL 没有 include 守卫,每个片段每个模块只拼一次。
- 共享片段(lightingCore / worldReconstruct 等)的 WGSL 版放同目录 `.wgsl` 文件,`import x from './foo.wgsl?raw'` 打进包里,
  不要运行时 fetch(发行包的 MIME 表没有 wgsl)。

## 静默出错的翻译点(每条都会编过、画面不对)

- **Pixi 用正则解析 WGSL**(`extractStructAndGroups`):结构体体内不许写注释(注释里的 `名: 类型` 会被当成成员),
  注释里不许出现 `@group(` / `@binding(`。
- GLSL 三目改写成 `if / else`,不要用 `select()`:`select` 两边都求值,`smoothstep` 两端相等时出 NaN。
- WGSL 内建 `smoothstep` 与 GLSL 内建差几个 ulp(SwiftShader 实测);会被放大的地方(GGX 峰值、灯锥边缘)写成规范定义的
  展开式 `t = clamp((x - e0) / (e1 - e0), 0, 1); t * t * (3 - 2 * t)`,两边逐位一致。
- `dpdx` / `dpdy` 不许在非一致分支里:挪到分支前算(结果与 GLSL 在分支里算相同)。追查半精度以下的差异时,
  临时把目标改成 `rgba32float` 逐侧比原始输出。

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
- `rgba32float` 目标在 WebGPU 核心里不可混合:`installPixiWebGpuPatches` 已在建管线时对 32 位浮点 / 整数格式去掉混合。
  `rgba32float` **输入**纹理则不可过滤(Pixi 按可过滤浮点声明纹理绑定)——运行时别用 32F 做被采样的纹理。
- 没指定 `format` 的 Pixi 渲染目标缺省是 `bgra8unorm`:WebGPU 显存里真是 BGRA 字节序(WebGL 侧照样存 RGBA)。
  采样出来通道是对的,只有回读要按存储格式解释——`env.readTexture` 已经按格式换好,用例里别再自己换。
- Node 单测里构造 `GlProgram` 需要 canvas 桩(它要探精度):照 `VfxRenderer.test.ts` 用
  `DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) })`。
- 值得加一条 Node 单测:用 Pixi 自己的 WGSL 解析器核对「每个 resources 键都有同名 WGSL 绑定、uniform 结构体成员
  名 / 类型 / 顺序与 JS 声明一致」(见 `src/rendering/burn/burnWgsl.test.ts`)——键名对不上时资源掉进第 99 组,
  WebGPU 下那次绘制直接失败,对照里只表现为「那一 pass 什么都没画」。

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
