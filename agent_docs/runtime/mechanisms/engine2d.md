---
id: engine2d
title: engine2d(Pixi v8 同名 API 的 2D 层 · 跑在 RHI / WebGPU 上 · 运行时已不依赖 Pixi)
domain: runtime
type: mechanism
summary: 运行时全部渲染走 src/engine2d——照 Pixi 8.17 移植的同名 API(Container/Sprite/Mesh/Filter/Graphics/Text/事件/Ticker/Assets…),底下是引擎式 RHI(只有 WebGPU)。离屏结果与 Pixi WebGL 逐位一致;与 master 的整局对照只差半像素水平边一行。src 运行时代码不许再 import pixi.js(守门测试);编辑器(anim_preview)仍用 Pixi
status: active
authority:
  - src/engine2d/index.ts
  - src/engine2d/core/contracts.ts
  - src/engine2d/gpu/WebGPURenderer.ts
  - src/engine2d/gpu/FrameBuilder.ts
  - src/engine2d/gpu/collect.ts
  - src/engine2d/gpu/createRenderer.ts
  - src/engine2d/noPixiInRuntime.test.ts
triggers:
  paths: ["src/engine2d/**", "tools/engine2d_parity/**", "tools/render_parity/**"]
  topics: [engine2d, 脱离 Pixi, pixi.js, 渲染器, 合批, 滤镜, 遮罩, 模板缓冲, RenderTexture, generateTexture, 上屏, 对照 master]
  tasks: [改渲染核心, 加引擎 API, 迁移 Pixi 写法, 渲染对照, 整局截图对照]
verified_by:
  - src/engine2d/noPixiInRuntime.test.ts
  - tools/engine2d_parity/run.mjs
  - tools/render_parity/run.mjs
  - tools/render_parity/game_sweep.mjs
last_governed: 2026-09-25
---

## 是什么(一句话)

`src/engine2d/` 是运行时唯一的 2D 渲染层:**对外是 Pixi v8.17 的同名 API**(游戏代码只是把 `from 'pixi.js'`
换成了 engine2d 的入口,上层逻辑没动),**对内是引擎式结构**——收集 → 规划 → 上传 → 在 RHI 上录制,只有 WebGPU。
(2026-09-25 整体迁移,制作人定:不要 WebGL 后端、编辑器不动、数据格式不动。)

## 一帧怎么走(WebGPURenderer.render)

1. `prepareTree`:从根算相对变换 / 颜色 / alpha / 混合 / 可见性(根本身用单位阵,根的变换与颜色进 globalUniforms);
2. `collect`:遍历出指令流(合批元素 / 自定义网格 / 不合批图形 / 滤镜进出 / 遮罩进出);
3. `FrameBuilder`:把指令规划成虚拟 pass / draw 命令,uniform 快照进 Arena(256 对齐),纹理与缓冲在这一步上传;
4. 写本帧的合批顶点 / 索引 / uniform 缓冲 → 在 RHI 上录制(画布走 `runFrame`,纯离屏走 `submit`)。
   **录制期间不写任何资源**(RHI 硬契约)。嵌套 render(滤镜里再 render)用独立的 RenderState。

## 硬契约

- **src 运行时代码不许 import `pixi.js`**(含子路径 / 类型 / 动态 import):`src/engine2d/noPixiInRuntime.test.ts` 守门。
  缺 API 就在 engine2d 里照 Pixi 8.17 补(对照 Pixi 源码的行为,不是凭名字猜),再从 `index.ts` 导出。
- **与 Pixi 的一致性口径 = 离屏逐位相同**:合批打包公式、顶点格式(24 字节)、每批 16 张纹理、非预乘混合变体、
  投影 / 视口取整、FilterSystem(纹理池、gfu、padding、嵌套偏移)、模板遮罩、不合批图形、UBO 布局都照 Pixi 做。
  改这些地方必须跑 `tools/engine2d_parity`(对 Pixi WebGL 逐位)。
- **着色器只有 WGSL**:`GlProgram` 只是为兼容构造签名留的壳,不参与渲染;`renderer.gl` 不存在。
- **管线在第一次用到时才建,建的时候 GPU 进程才把 WGSL 编成后端着色器**(不挡 JS,但用到它的那一帧要等编完)。
  大着色器要提前:`renderer.prewarmPipelines(specs)` 按(程序 × 几何顶点布局 × 混合 × 目标格式)预建进同一份缓存,
  `renderer.pipelinesReady(timeout)` 等全部已建管线编完(揭幕前闸在用,见 vfx-rendering)。
  预建的键必须与真画时逐项相同:几何取自真实网格类、混合按网格纹理算非预乘变体、格式缺省画布 + 离屏 bgra8unorm。
- **画布零面积整帧不录**(布局前的头几帧);画布尺寸变化经 `Renderer.resize → rhi.resizeSwapchain` 通知 RHI 重配交换链与深度缓冲。
- **绑定已销毁的纹理源 = 当帧抛错**(`GpuTextures.get` 直接抛,等价 Pixi 的 BindGroup 自毁):卸载时先解绑再销毁
  那一条 pixi-v8-traps 的契约照旧成立;游戏 `Renderer` 的渲染兜错(crash guard)仍然必要——engine2d 的 Ticker
  照 Pixi 移植,render 抛出去同样不再排下一帧。

- **场景层级照 Unity**:节点 = GameObject + Transform(setActive / 组件 / 玩家循环 / Unity 名字的变换 API),
  见 [scene-hierarchy](scene-hierarchy.md)。这是在 Pixi 语义之上加的,Pixi 对照测试不受影响。

## 与 Pixi(master)的已知差异

- **半像素水平边差一行**:恰好落在 y+0.5 上的水平边(1 像素网格线、HUD 面板上下边)在画布上比 master 高/低一行——
  WebGL 默认帧缓冲自下而上光栅化、WebGPU 自上而下,平局归属相反。离屏目标两边一致。整局对照里这是唯一的系统性差异。
- `Container.worldTransform` 与当前父链一致(按版本缓存,不走 Pixi 的"上一帧渲染结果");Culler 因此用的是**当帧**变换(Pixi 用上一帧)。
- 需要背景纹理的混合滤镜(`blendRequired`)没实现(运行时没有用到;用到会直接抛)。

## 怎么验证

- 单测:`npx vitest run src/engine2d`(大量用例直接拿 Pixi 当参考实现比对,Pixi 只作为测试依赖)。
- 核心逐位对照(engine2d vs Pixi WebGL,29 个用例):`node tools/engine2d_parity/run.mjs`。
- 运行时着色器对照(**master 对本分支**,176 个用例):`node tools/render_parity/run.mjs`——
  用 git archive 抽出 master 的 src 跑 Pixi WebGL,工作区 src 跑 engine2d,逐像素比。
- 整局画面对照(master 对本分支,逐场景截图 + 新增报错):`node tools/render_parity/game_sweep.mjs`;
  Linux 无显示环境要 `xvfb-run ... --swiftshader`(无头 Chromium 的 WebGPU 上屏会丢设备,有头 + SwiftShader Vulkan 正常)。
  这三个都要 playwright-core(`PLAYWRIGHT_CORE` 指过去),见各文件头。

## 已知坑

- 编辑器 `tools/anim_preview` 直接用 Pixi 的 `Application` 渲染运行时的 `SpriteEntity` 等类:运行时迁走后两边类型对不上,
  需要把它的 `pixi.js` import 换成 engine2d(编辑器改动归制作人定,迁移时没动)。`tools/parallax_editor` 自成一体,不受影响。
- 两个 dev 服共用一份 `node_modules/.vite` 会互相把预构建判过期(`504 Outdated Optimize Dep`),game_sweep 给基准侧单独建了 node_modules 链接目录。
