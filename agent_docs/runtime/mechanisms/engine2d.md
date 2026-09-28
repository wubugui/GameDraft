---
id: engine2d
title: engine2d(Pixi v8 同名 API 的 2D 层 · 跑在 RHI / WebGPU 上 · 运行时已不依赖 Pixi)
domain: runtime
type: mechanism
summary: 运行时全部渲染走 src/engine2d——照 Pixi 8.17 移植的同名 API(Container/Sprite/Mesh/Filter/Graphics/Text/事件/Ticker/Assets…),底下是引擎式 RHI(只有 WebGPU)。离屏结果与 Pixi WebGL 逐位一致;与 master 的整局对照只差半像素水平边一行。src 运行时代码与动画工作台 anim_preview 都不许再 import pixi.js(守门测试)
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
  paths: ["src/engine2d/**", "tools/engine2d_parity/**", "tools/render_parity/**", "tools/anim_preview/main.ts"]
  topics: [engine2d, 脱离 Pixi, pixi.js, 渲染器, 合批, 滤镜, 遮罩, 模板缓冲, RenderTexture, generateTexture, 上屏, 对照 master]
  tasks: [改渲染核心, 加引擎 API, 迁移 Pixi 写法, 渲染对照, 整局截图对照]
verified_by:
  - src/engine2d/noPixiInRuntime.test.ts
  - src/engine2d/gpu/deviceLoss.test.ts
  - tools/engine2d_parity/run.mjs
  - tools/render_parity/run.mjs
  - tools/render_parity/game_sweep.mjs
last_governed: 2026-09-25
---

## 是什么(一句话)

`src/engine2d/` 是运行时唯一的 2D 渲染层:**对外是 Pixi v8.17 的同名 API**(游戏代码只是把 `from 'pixi.js'`
换成了 engine2d 的入口,上层逻辑没动),**对内是引擎式结构**——收集 → 规划 → 上传 → 在 RHI 上录制,只有 WebGPU。
(2026-09-25 整体迁移,制作人定:不要 WebGL 后端、编辑器不动、数据格式不动。
同日制作人另批:动画工作台 `tools/anim_preview` 的游戏真实预览页也迁到 engine2d,见「已知坑」。)

## 一帧怎么走(WebGPURenderer.render)

1. `prepareTree`:从根算相对变换 / 颜色 / alpha / 混合 / 可见性(根本身用单位阵,根的变换与颜色进 globalUniforms);
2. `collect`:遍历出指令流(合批元素 / 自定义网格 / 不合批图形 / 滤镜进出 / 遮罩进出);
3. `FrameBuilder`:把指令规划成虚拟 pass / draw 命令,uniform 快照进 Arena(256 对齐),纹理与缓冲在这一步上传;
4. 写本帧的合批顶点 / 索引 / uniform 缓冲 → 在 RHI 上录制(画布走 `runFrame`,纯离屏走 `submit`)。
   **录制期间不写任何资源**(RHI 硬契约)。嵌套 render(滤镜里再 render)用独立的 RenderState。
   uniform 片段(`ArenaRef`)本身就是 RHI 的缓冲区段绑定 `{ buffer, offset, size }`,uniform 缓冲建好后统一填 `buffer`,
   绑定表原样交给 RHI(不逐 draw 另拼;合批的 34 项绑定表用对象字面量一次建好,不逐键填成字典模式);管线缓存先按
(程序 × 布局对象 × 状态整数)查,没命中才拼串键;几何的顶点布局按 `Geometry._attributesVersion`(addAttribute 加一)失效,
流上的 Buffer 绘制时按属性名现取(照 Pixi setGeometry)。

## 硬契约

- **src 运行时代码不许 import `pixi.js`**(含子路径 / 类型 / 动态 import):`src/engine2d/noPixiInRuntime.test.ts` 守门;
  同一个测试也守 `tools/anim_preview`(构建产物 `dist-remote/` 除外)——它直接渲染运行时的 SpriteEntity 等类,
  两套渲染器的对象不能混挂。
  缺 API 就在 engine2d 里照 Pixi 8.17 补(对照 Pixi 源码的行为,不是凭名字猜),再从 `index.ts` 导出。
- **与 Pixi 的一致性口径 = 离屏逐位相同**:合批打包公式、顶点格式(24 字节)、每批 16 张纹理、非预乘混合变体、
  投影 / 视口取整、FilterSystem(纹理池、gfu、padding、嵌套偏移)、遮罩(照 Pixi 8.17 按遮罩值选类型:Graphics → 模板、
  Sprite → alpha 遮罩、数字 → 颜色遮罩)、不合批图形、UBO 布局都照 Pixi 做。
  改这些地方必须跑 `tools/engine2d_parity`(对 Pixi WebGL 逐位)。
- **着色器只有 WGSL**:`GlProgram` 只是为兼容构造签名留的壳,不参与渲染;`renderer.gl` 不存在。
- **管线在第一次用到时才建,建的时候 GPU 进程才把 WGSL 编成后端着色器**(不挡 JS,但用到它的那一帧要等编完)。
  大着色器要提前:`renderer.prewarmPipelines(specs)` 按(程序 × 几何顶点布局 × 混合 × 目标格式)预建进同一份缓存,
  `renderer.pipelinesReady(timeout)` 等全部已建管线编完(揭幕前闸在用,见 vfx-rendering):超时放行 false、建坏的不挂住,
  等待中渲染器销毁立刻放行 false(同 master GlProgramWarmup);空后端 `pendingPipeline` 选项可模拟没编完的管线。
  预建的键必须与真画时逐项相同:几何取自真实网格类、混合按网格纹理算非预乘变体、格式缺省画布 + 离屏 bgra8unorm;
  每个目标都建「不带模板」与「带深度模板、模板停用」两份——目标用过一次模板遮罩就一直带模板(照 Pixi),只建前一份的话第一次对话之后预建全部落空。
- **设备丢失恢复后照常画**(照 Pixi `runners.contextChange`):WebGPURenderer 订 `rhi.onRestored`,丢掉全部 GPU 缓存
  (纹理 / 采样器、缓冲、着色器 / 管线含预建的、模板 / MSAA 目标、合批顶点 / 索引 / uniform 缓冲),下一次 render 按需重建、
  CPU 源重传;RenderTexture 重建成空的(画过的内容丢了,同 WebGL)。新加持有 RHI 资源的缓存必须一并在 `contextChange` 里清。
- **画布零面积整帧不录**(布局前的头几帧);画布尺寸变化经 `Renderer.resize → rhi.resizeSwapchain` 通知 RHI 重配交换链与深度缓冲。
- **绑定已销毁的纹理源 = 当帧抛错**(`GpuTextures.get` 直接抛,等价 Pixi 的 BindGroup 自毁):卸载时先解绑再销毁
  那一条 pixi-v8-traps 的契约照旧成立;游戏 `Renderer` 的渲染兜错(crash guard)仍然必要——engine2d 的 Ticker
  照 Pixi 移植,render 抛出去同样不再排下一帧。

- **场景层级照 Unity**:节点 = GameObject + Transform(setActive / 组件 / 玩家循环 / Unity 名字的变换 API),
  见 [scene-hierarchy](scene-hierarchy.md)。这是在 Pixi 语义之上加的,Pixi 对照测试不受影响。

## 与 Pixi(master)的已知差异

- ~~半像素水平边差一行~~(2026-09-27 已对齐):画布这一帧照 master 的 WebGL 默认帧缓冲自下而上,把内容上下颠倒画进
  同尺寸同格式的**画布中间纹理**(`FrameBuilder.bind` 画布用翻转投影、滤镜 `uOutputTexture.z = 1`、`uRoundFlipY = 1`),
  帧末 `WebGPURenderer.presentCanvasFlip` 用 textureLoad 逐像素翻回正向写进交换链。光栅化平局归属、gl_FragCoord 朝向
  (`@builtin(position)`)都与 master 画布一致;画布的模板 / MSAA 走与离屏目标同一条路(resolve 回中间纹理)。离屏目标不变。
- `Container.worldTransform` 与当前父链一致(按版本缓存,不走 Pixi 的"上一帧渲染结果")。**Culler 例外、照 Pixi**
  (2026-09-28 对齐):缺省 `skipUpdateTransform = true` 读**上一次渲染时**的世界变换(`renderedWorldTransform` =
  所属渲染组的历史世界矩阵 × 自己的历史组内矩阵;`prepareTree` 对未激活子树也照算变换,同 Pixi 更新 visible=false 节点的变换)——
  本帧逻辑里挪过的节点晚一帧反映,这一帧才新建的节点按单位组内矩阵判。单独 render 已挂树的子树会持久开启组边界,
  显式 `render({ transform })` 同样进入历史;`prepareDetached` 的临时绘制矩阵与历史分开。重挂立即改所属组,
  组内矩阵等下次 render 更新;完全脱组保留上次读取值。三条 API 边界与重挂/隐藏/遮罩隔离钉在
  `culling/cullerRenderGroups.test.ts`(单测证据,不代表已确认游戏画面缺陷)。以前读当帧变换,落雷第一帧的满载粒子网格
  (impact_core / impact_hot)master 被剔、分支照画,A/B 在 strike+120 差一团白光。钉在 `culling/cullerRenderedTransform.test.ts`。
- 需要背景纹理的混合滤镜(`blendRequired`)没实现(运行时没有用到;用到会直接抛)。
- 引擎扩展(Pixi 没有,2026-09-28 加,游戏滤镜都还没用):`FilterSystemLike.filterPassOrigin(output)`——滤镜顶点位置 + 它 = 渲染根上的坐标(照 Pixi,`uOutputFrame.xy` 只在链的最后一道带 bounds 偏移,中间几道是 0;燃烧材质 / 深度遮挡 / 受光滤镜排在链中间时屏幕坐标因此是错的,master 同样如此、本分支不改,见 `agent_docs/_meta/inbox/2026-09-28-filters-mid-chain-screen-pos.md`);`renderer.readCanvasPixels()`——异步回读画布中间纹理(最近一次画到画布的内容,自上而下 RGBA,不经浏览器上屏 / 合成;工作台自检读像素用)。
- **`renderer.extract.*` 全是异步**(返回 Promise;WebGPU 回读)。Pixi 的 `extract.canvas / pixels` 是同步的,
  照搬的调用点要补 `await`。调用当下就同步把目标画进离屏纹理,之后只等像素回来。

与 Pixi **相同**、容易误以为不同的:`renderer.width / height` 是逻辑尺寸(= `screen`,画布像素看 `canvas.width`);
`renderer.resize(0, h)` 把 0 当"沿用旧尺寸"(隐藏的 `resizeTo` 元素量出 0×0 时画布不缩没),逻辑尺寸按整像素回算
(`round(w × res) / res`);`antialias: true`(画布跟渲染器选项、RenderTexture 跟纹理源)= MSAA×4,每个 pass 结束
resolve 回目标——32 位浮点 / 整数这类不能 resolve 的格式照常单采样。游戏自己 `antialias: false`,不受影响。
合批节点(Sprite / 合批 Mesh / NineSlice / Text / HTMLText)的 `roundPixels` 在**第一次被渲染时锁定**
(`渲染器 roundPixels | 节点 roundPixels`),之后再改不生效,`unload()` / destroy 后才重取——运行中切换取整要先 `unload()`;
`roundPixels` 在离屏目标(RenderTexture / 滤镜纹理)里的平局方向照 master 的 WebGL 翻转投影:离屏投影本身不翻,
全局 uniform 尾字段 `uRoundFlipY`(离屏与画布中间纹理都是 1,两类目标的投影都与 master 相反)让内置合批 / 图形 / 网格着色器翻 y 再取整(`batchShader` 的 `roundPixelsTarget`);
Sprite 的合批四边形只在换纹理 / 改锚点 / 动态纹理 update 时重算(非动态 RenderTexture 改尺寸后停在旧尺寸);
`renderer.render({ container })` 的根自己的 `blendMode` 不生效(按 normal 画,要混合就挂一层父节点);
带 shader 却没有 `gpuProgram` 的网格告警并跳过绘制;
纹理的**采样参数在一个渲染器 / 一次设备里第一次用到时定下**(照 Pixi WebGPU 的 `_resourceId`:键与参数由各渲染器的 `GpuTextures` 按 style 各记一份,
GPU 采样器按记下的参数建),之后改 `scaleMode` / `addressMode` 等字段要调 `style.update()`(`_updateId` 加一)才生效。新渲染器、设备丢失恢复
从空表开始,第一次取采样器按字段现值算键,同 master(WebGL)上下文恢复后 GL 纹理重建读现值;两个渲染器同时在用时互不影响;
源被 GC 回收(unload)后重传同样按字段现值重算(同 master 的 GL 纹理重建)——但用过之后改字段不 update 的写法仍别写。

## 怎么验证

- 单测:`npx vitest run src/engine2d`(大量用例直接拿 Pixi 当参考实现比对,Pixi 只作为测试依赖)。
- 核心逐位对照(engine2d vs Pixi WebGL,36 个用例,含 alpha / 颜色 / 反向遮罩与 roundPixels 平局):`node tools/engine2d_parity/run.mjs`。
- **与 master 的对照以 `tools/ab_compare` 为准**(制作人 2026-09-25 定:两个分支各自跑起来比,不许把 master 的代码拿进本分支比)。
  它的做法:
  - master 与本分支各检出一棵独立工作树,各自 `npm ci`、各自起未改动的 dev 服;
  - 外部用同一套输入和确定性控制(假时钟、随机种子、固定步长)驱动两局真游戏;
  - 逐检查点比截图、状态、报错,并用 A/A、B/B 量出噪声底。
  用法、方法与局限见 `tools/ab_compare/README.md`。光照与美术只有在素材齐全(DVC)的机器上才比得到。
- 着色器单元级辅助(**不是**干净的 master 对照):`node tools/render_parity/run.mjs`(176 个用例)。
  它把 master 的 src 放进**本分支**的对照框架里跑,master 缺的模块还从本分支补。
  只能用来快速看着色器移植,不能当 master 行为对照的证据。
  容差口径:无头 SwiftShader 上两侧同一个编译器,大多逐位相同;真显卡上两侧是 FXC(ANGLE-D3D11)对 Dawn-D3D12,
  浮点差是编译器的(乘加合并 / 常量折叠 / acos 多项式 / 除法 1 ulp),用例按取证结果改了输入、个别 tile 按 ulp 或
  误差界给容差,依据都写在用例旁(见 pixi-shader-wgsl-port)。`--mutants` 跑变异自检(`mutants.json`,改一处运行时源必须变红)。
  2026-09-27 RTX 4070 SUPER 上 Edge / Chrome、有头 / 无头、Dawn 走 D3D11 都 176/176,变异 14/14。
- `tools/render_parity/game_sweep.mjs` 已被 ab_compare 取代:它共用本分支的 node_modules,又按真实时间跑,两边动画不同步、噪声大。
  Linux 无显示环境跑浏览器类工具一律 `xvfb-run` + 有头 + `--swiftshader`(无头 Chromium 的 WebGPU 上屏会丢设备)。
  这些工具都要 playwright-core(用 `PLAYWRIGHT_CORE` 指过去),见各文件头。

## 已知坑

- 动画工作台 `tools/anim_preview` 的游戏真实预览页(`main.ts`)用 engine2d 的 `Application` 渲染运行时的
  `SpriteEntity` / `EntityLightingFilter` / `PlanarEntityShadow`(2026-09-25 从 Pixi 迁过来):浏览器没有 WebGPU 时
  舞台区显示明确提示,不留空白画布;GIF 导出走异步 extract。它的公开镜像 `dist-remote/` 是**手工构建后入库**的产物
  (没有 CI 构建它),改了预览页或它引到的运行时渲染代码要重跑 `npm run build:anim-preview-remote` 一并提交。
  视差编辑器 `tools/parallax_editor` 同样走 engine2d(2026-09-25 迁过来,自带 tsconfig 把 `@src` 指到 src)。
- 两个 dev 服共用一份 `node_modules/.vite` 会互相把预构建判过期(`504 Outdated Optimize Dep`),game_sweep 给基准侧单独建了 node_modules 链接目录。
