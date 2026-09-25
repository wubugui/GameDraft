---
id: pixi-shader-wgsl-port
title: 把 Pixi 自定义着色器补上 WGSL(迁移到 WebGPU 的逐个移植配方)
domain: runtime
type: recipe
summary: 运行时自定义着色器的 WGSL 写法与验收(运行时只跑 WGSL,经 engine2d);GLSL 原样保留给 master 对照与编辑器;用 tools/render_parity(master 的 Pixi WebGL 对本分支 engine2d)证明逐像素一致;列出 WGSL 与 GLSL 语义不同、翻译时静默出错的点和工具依赖的禁改清单
status: active
authority:
  - tools/render_parity/harness.ts
  - tools/render_parity/side_cand.ts
  - src/engine2d/shader/GpuProgram.ts
triggers:
  paths: ["tools/render_parity/**"]
  tasks: [移植着色器到 WGSL, 补 gpuProgram, 着色器像素对照, 迁移 WebGPU]
  topics: [WGSL, GpuProgram, WebGPU, 像素对照, render_parity, 着色器移植]
last_governed: 2026-09-25
---

## 目标与完成判据

2026-09-25 起运行时整体跑在 [engine2d](../mechanisms/engine2d.md) 上,**只执行 WGSL**;GLSL 一个字不动地保留——
master 对照的参考侧跑它、编辑器(anim_preview)自建的 Pixi WebGL 跑它、多个工具直接切片编译它(见文末禁改清单)。
改一个着色器 = WGSL 与 GLSL 两份同步改(GLSL 只在还有消费者时);新着色器只给运行时用的,只写 WGSL。一个着色器算移植完成 =
`tools/render_parity/cases/<模块>.ts` 里有覆盖它全部分支 / 开关的用例,且 `node tools/render_parity/run.mjs --case <前缀>` 全绿,
**并且**证明 WebGL 一侧的输出与移植前逐字节相同(对移植前后的源码各跑一遍对照,哈希 GL 侧结果)——
GL 侧就是对照的「master」参考,它自己漂了,对照一致也没有意义。

像素对照的两侧:参考 = **master 的 src 树** + Pixi WebGL 跑 GLSL(run.mjs 用 git archive 抽到 `.tools/render_parity_ref/<sha>/`);
候选 = 工作区 src + engine2d 跑 WGSL(用例里的 `pixi.js` 也别名到 engine2d)。同一个 `build(env)` 各调一次,
输入(`env.dataTexture` 固定种子)逐字节相同。用例要 import 本分支才有的导出(WGSL 常量)时**按命名空间取**
(`import * as M` 再解构),具名 import 会让 master 那侧模块链接失败;master 里缺的整个模块由参考侧补件从本分支补。
master 已知会抛错、本分支已修的用例标 `refKnownError`。

## 写法

- `Shader.from({ gl: {...}, gpu: { vertex: { source, entryPoint }, fragment: { source, entryPoint } }, resources })`;
  `Filter` 同理(`Filter.from` 或 `new Filter({ glProgram, gpuProgram, resources })`)。宿主类对外接口不变。
- 网格 WGSL 的 Pixi 约定:`@group(0) @binding(0) var<uniform> globalUniforms`(`uProjectionMatrix`、`uWorldTransformMatrix`、
  `uWorldColorAlpha`、`uResolution`)、`@group(1) @binding(0) var<uniform> localUniforms`(`uTransformMatrix`、`uColor`、`uRound`),
  程序里声明了它们渲染器才自动绑(engine2d 按变量名绑定,组号只是声明习惯)。自定义资源放 `@group(2)` 起,**变量名 = resources 的键名**。
  参考 `src/engine2d/gpu/batchShader.ts`。
- 滤镜 WGSL 约定:`@group(0)` 固定 `gfu`(GlobalFilterUniforms)、`uTexture`、`uSampler`;滤镜自己的 uniform 组放 `@group(1)` 起。
  参考 `src/engine2d/filters/defaults/`。
- 纹理在 WGSL 里要单独的采样器:resources 里补 `<名>Sampler: samplerOf(source)`(`src/rendering/legacy/gpuSampler.ts`),
  **不许直接放 `source.style`**——纹理销毁会连带销毁它的 style,style 销毁让同组 BindGroup 自毁,WebGL 下整帧也抛
  (换了纹理漏换采样器就中招)。`samplerOf` 按采样参数共享、永不销毁;`gpuSampler.test.ts` 扫源码拦 `.style` 写法。
- **uniform 组成员在 WGSL struct 里的顺序必须与 JS 里 uniforms 对象的声明顺序一致**(Pixi 按声明顺序、WGSL 对齐规则算偏移)。
  `size: N` 的 `vec4` 数组 → `array<vec4<f32>, N>`;**`vec2` / 标量数组不能照搬**:Pixi 按 8 / 4 字节紧排,WGSL uniform 数组
  要 16 字节步长(`array<vec2<f32>, N>` 直接编译失败)——在 WGSL 里把同一段内存看成 `array<vec4<f32>, N/2>` 再拆,
  且该成员在 JS 声明里要落在 16 字节边界上(见 `VfxBeamView` 的 `uBeamAlong`)。Pixi 的 WGSL 数组上传会越界写到后面约 4 倍
  长度(填 NaN),只因后面成员随后覆写才无害——别依赖缓冲里的填充字节。
- (GLSL 侧,Pixi WebGL)补了 gpu 程序后资源分组会变:原来全在第 99 组,之后按 WGSL 声明的组号走;WebGL 按组号升序分配纹理单元,
  所以 WGSL 里纹理的声明顺序要与原 resources 对象里的相对顺序一致,纹理单元才不挪(master 对照 / 编辑器那侧的前提)。
- 运行时换某个纹理资源(ping-pong 等)时,它的 `<名>Sampler` 跟着换成 `samplerOf(新纹理)`(参数不同就是另一份采样器)。
- **共用同一份 GLSL 源的所有 Shader 必须在同一次改动里一起补上同一个 gpu 程序、同样的资源布局**:WebGL 侧
  按 GLSL 程序缓存 uniform 同步函数,按第一个 Shader 的分组布局生成;布局不一致会让别的 Shader 的 uniform 错位。
- 每个资源键都要在 WGSL 里有同名声明,WGSL 声明的每个自有绑定也都要有资源(engine2d 按变量名绑定,缺了那次绘制失败)。
  自定义 Geometry 属性按 WGSL `@location` 参数名匹配。
- WGSL 不许给多分量 swizzle 赋值(`c.rgb /= c.a`),整向量重建。`discard` 之后不许 `textureSample`:采样挪到前面。
- WGSL 的 `clamp` / `min` / `max` 不许向量配标量(写 `vec2<f32>(0.0)`)。几何体的每个属性(哪怕没用到,如 `aUV`)都要在
  WGSL 顶点输入里声明(原 Pixi WebGPU 不声明会每次绘制告警;engine2d 只取程序声明了的属性)。
- **光栅化填充规则两后端相反**:水平三角形边若恰好落在像素中心(1/32 像素内),WebGL 与 WebGPU 一个画这一行、一个不画(整行差)。
  离屏目标上 Pixi-WebGL 翻了投影所以常常一致,画布上则系统性相反(整局对照里 1 像素网格线、HUD 面板上下边差一行)。
  这是光栅化差异不是着色器差异:用例几何避开这种边;整画面对比 master 时出现的整行差按这个归因。
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
- **混合表以 Pixi WebGL(= master)为准**:原版 Pixi WebGPU 的 `add` alpha、`none` 的 alpha、`erase` 的颜色因子与 WebGL 不同;
  engine2d 的混合表照 WebGL 那一份(tools/engine2d_parity 逐位核过)。
- WebGL 侧 Pixi 从不改 `UNPACK_ALIGNMENT`(缺省 4):单 / 双通道缓冲纹理行宽不是 4 字节倍数时 **WebGL 读偏、WebGPU 读对**。
  运行时现存两张 r8:probe 有效性图行宽经 `probeTiling` 补齐到 4 的倍数(无差);天穹可见性网格行宽不对齐,但那条路径无消费者。
  新增这类纹理要么补齐行宽,要么接受两后端不同。
- `rgba32float` 目标在 WebGPU 核心里不可混合:engine2d 建管线时对 32 位浮点 / 整数格式去掉混合。
  `rgba32float` **输入**纹理则不可过滤(Pixi 按可过滤浮点声明纹理绑定)——运行时别用 32F 做被采样的纹理。
- 没指定 `format` 的渲染目标缺省是 `bgra8unorm`:WebGPU 显存里真是 BGRA 字节序(WebGL 侧照样存 RGBA)。
  采样出来通道是对的,只有回读要按存储格式解释——`env.readTexture` 已经按格式换好,用例里别再自己换。
- Node 单测里构造 `GlProgram` 需要 canvas 桩(它要探精度):照 `VfxRenderer.test.ts` 用
  `DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) })`。
- 值得加一条 Node 单测:用 engine2d 的 WGSL 解析(`gpuProgram.structsAndGroups`)核对「每个 resources 键都有同名 WGSL 绑定、uniform 结构体成员
  名 / 类型 / 顺序与 JS 声明一致」(见 `src/rendering/burn/burnWgsl.test.ts`)——键名对不上时那个绑定没有资源,
  那次绘制失败,对照里只表现为「那一 pass 什么都没画」。

## 禁改清单(工具直接读这些,改了工具或工具测试会坏)

- GLSL 源文件与切片标记原样保留:`src/rendering/burn/burnShade.glsl`(`//__BURN_SHADE_BEGIN__/END__`,且 `BurnFilters.ts` 里要出现
  `sliceGlsl(BURN_SHADE_SRC, 'BURN_SHADE')`)、`src/rendering/breathingShade.glsl`、`src/rendering/charShadeCore.glsl`、
  `src/rendering/vfx/vfxBeamGlsl.ts`、`src/rendering/vfx/vfxBoltGlsl.ts` 的导出名与内容。
- `anim_preview` 直接用 `SpriteEntity` / `EntityLightingFilter.createForEntity` 与其 setter / `PlanarEntityShadow`:对外 API 不变,
  且它自建的 Pixi 是 WebGL,GLSL 必须继续能用(它的 `pixi.js` import 要换成 engine2d 才能和迁移后的运行时类型对上,归制作人定)。
- 工具测试按正则读的常量:`contactAo.ts` 的常量、`lightEnv.ts` 的 `contact: X, contactSize: Y,`、`backgroundSway.ts` 的
  `const GRID_CELL = 24;`、`lightPacking.ts` 的 `export const DEFAULT_*_WU = v;`、`SceneLightingSystem.ts` 的 `defaultSceneLighting`、
  `Renderer.ts` 的 `entitySortZ`。`vfxBeam.ts` / `vfxSpace.ts` / `vfxProgram.ts` 要能在 Node 里跑(不许引 DOM / Pixi)。
- 数据格式(`public/assets/**` 的 JSON、烘焙产物)一律不动。

## 跑对照

```
PLAYWRIGHT_CORE=<playwright-core 包目录> RENDER_PARITY_BROWSER=<chrome 可执行文件> node tools/render_parity/run.mjs --case <前缀>
```
`--base <提交>` 换基准(缺省 origin/master);`--serve` 只起两个服务、打印对照页地址,浏览器里看参考 / 候选 / 差异缩略图。
整局截图对照见 `tools/render_parity/game_sweep.mjs`(engine2d 卡)。
