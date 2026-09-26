---
id: rhi
title: RHI(渲染硬件接口 · 显式 pass · 渲染图 · 只有 WebGPU)
domain: runtime
type: mechanism
summary: 取代 Pixi 做底层图形的引擎式 RHI——显式 render/compute pass、创建后不可变的管线、按名字绑定(WGSL)、资源一律经作用域创建(有主);渲染图按声明的读写剔除 pass、算生命期、别名复用瞬时资源;唯一图形后端是 WebGPU(经 luma.gl),没有 WebGL 回落,环境没 WebGPU 就在建设备时明确失败。运行时全部 2D 渲染经 engine2d 跑在它上面
status: active
authority:
  - src/rendering/rhi/types.ts
  - src/rendering/rhi/RhiDevice.ts
  - src/rendering/rhi/RhiResourceScope.ts
  - src/rendering/rhi/graph/RenderGraph.ts
  - src/rendering/rhi/graph/RgTransientPool.ts
  - src/rendering/rhi/backends/luma/LumaRhiDevice.ts
  - src/rendering/rhi/backends/null/NullRhiDevice.ts
  - src/rendering/Renderer.ts#init
  - src/engine2d/gpu/WebGPURenderer.ts
triggers:
  paths: ["src/rendering/rhi/**", "src/rendering/legacy/**", "tools/rhi_smoke/**", "tools/render_parity/**"]
  topics: [RHI, luma.gl, WebGPU, WGSL, compute shader, render pass, 渲染图, render graph, frame graph, 瞬时资源, 替换 Pixi, 移植渲染]
  tasks: [往 RHI 上迁渲染代码, 写 compute pass, 加 pass, 写 WGSL 着色器]
verified_by:
  - src/rendering/rhi/RhiResourceScope.test.ts
  - src/rendering/rhi/graph/RenderGraph.test.ts
  - src/rendering/rhi/backends/luma/lumaMapping.test.ts
  - src/rendering/rhi/backends/luma/LumaRhiDevice.test.ts
  - src/rendering/rhi/backends/luma/LumaRhiDevice.deviceLoss.test.ts
  - src/rendering/rhi/backends/null/NullRhiDevice.test.ts
  - tools/rhi_smoke/cases.ts
  - tools/render_parity/cases/00_harness.ts
last_governed: 2026-09-25
---

## 是什么(一句话)

`src/rendering/rhi/` 是照游戏引擎做的图形层:上层只认 `index.ts` 导出的接口,具体图形 API 由后端翻译。
它的第一个使用者是 [engine2d](engine2d.md)(Pixi v8 同名 API 的 2D 层,2026-09-25 起运行时全部渲染经它走);
游戏代码不直接碰 RHI,只有 engine2d 与少数光照 / 诊断代码经 `renderer.rhi` 拿设备。

## 分层(依赖只许往下)

`types` / `RhiDevice`(接口)→ `RhiResourceScope`(所有权)→ `graph/`(渲染图,只依赖接口)→ `backends/luma`(WebGPU)、`backends/null`(不碰 GPU 的空后端,单测用)。
上层**不许 import `@luma.gl/*`**;要什么能力先在 RHI 接口上加,再在两个后端各实现一遍。
**没有 WebGL 后端,也不许加回来**(制作人 2026-09-25 定):着色器一律 WGSL。

## 硬契约

- **资源有主**:缓冲 / 纹理 / 管线一律经 `scope.createXxx` 建;场景级资源挂场景作用域,切场景销毁作用域一次收干净。
  `destroy()` 立即失效(再用当场报 `destroyed-resource`),底层句柄等当前这批命令提交后才释放。
- **帧级异常隔离**:`runFrame` / `submit` 截住录制期的一切异常 → 上报诊断、这一批作废、返回 false。
  主循环不会因为画错一次而死(对照 pixi-v8-traps 第一条)。
- **按名字绑定**:名字 = WGSL 变量名;采样器命名「纹理名 + Sampler」,传了就设成该纹理的采样状态
  (luma 会按这个名字自动补纹理自带的采样器,再单独传一份会同槽位绑两次、建 bind group 失败,所以后端统一走纹理),
  不传用纹理创建时的 `sampler` 描述(缺省 clamp + 线性)。着色器要的名字没给,当场 `invalid-usage`(不像 luma 那样静默跳过 draw)。
- **朝向照 WebGPU**:纹理第 0 行 = 画面顶部,uv(0,0) = 左上,视口 / 裁剪矩形左上原点。
  ⚠ Pixi 的 WebGL 路径 RT 是倒着存的,迁移时照搬 Pixi 着色器里的 uv 翻转会把画面翻过来。
- **录制期不许写本批已引用的资源**:WebGPU 的 writeBuffer 走队列,在整批命令执行之前生效,前面录好的 draw
  也会读到新值(不是"写在哪儿从哪儿生效"),所以直接报错。逐 draw 变化的数据用不同缓冲 / 偏移,或在录制前写好。
- **不静默降级**:环境没有 WebGPU,`createRhiDevice` 抛 `unsupported`,不换别的 API。
- **图像上传缺省不预乘**(`premultiplyAlpha: false`):alpha 当数据的图不会被乘掉;颜色图要预乘就显式传 true。
  `flipY: true` **不支持**,当场报 `unsupported`(luma 的 WebGPU 拷贝写死不翻,不报就是静默丢)。
- **建坏的管线只丢自己的 draw**:着色器编译失败 / 建模块或管线时原生错误作用域(validation + internal,luma 关调试时
  自己不开,后端自己开)接到错误 → `ready` reject、上报一次 error;之后用它的 draw / dispatch 录制时跳过(计入 `skippedDraws`、
  告警一次),帧照常提交——WebGPU 里拿无效管线 setPipeline 会让整批命令作废(一帧全黑),master 的 GL 里坏程序只影响自己。
  失败是异步才知道的:确认之前的那几帧照常画(与正常管线同路)。
- **空后端与真后端校验逐条一致**(`NullRhiDevice.test.ts` 同一段用法两边跑、比错误码):新增真后端校验时空后端同步加,
  两边共用的规则写在 `backends/backendRules.ts`;空后端的着色器布局用 luma 同一个 WGSL 扫描器推。
  要模拟建坏的管线用 `new NullRhiDevice({ failPipeline: (label) => … })`。
- **多重采样(MSAA)只有 1 / 4**:`sampleCount: 4` 的纹理只能当渲染附件(用途只许 RENDER_TARGET,不带数据、单级 mip),
  渲染目标的 `resolveTargets` 给同尺寸同格式的单采样纹理,每个 pass 结束 resolve 进去;管线的 `sampleCount` 必须与目标一致,
  不一致 setPipeline 当场 `invalid-usage`。多重采样纹理跨 pass 保留(load 读到的是上一 pass 的多重采样结果,不是 resolve 目标)。
  画布用 `frame.swapchainMultisampled(4, depthFormat?)`:多重采样颜色由设备持有、随画布尺寸重建,**同采样数下带不带深度共用一张**
  (中途补模板以 load 重开读到的就是刚画的)。32 位浮点 / 整数格式不能 resolve。
- **设备丢失自动恢复**(对照 master 的 Pixi WebGL:contextlost → 浏览器恢复 → `runners.contextChange` 重传):
  `createRhiDevice` 建的设备丢失后(自己 `destroy()` 引起的除外)报 error「图形设备丢失」→ 先拆旧画布上下文 →
  按原参数在**同一画布**上重新要适配器 / 设备(失败按 0 / 0.25 / 1 / 2 / 4 / 8 秒重试,用尽报「恢复失败」)→
  旧设备上的**资源全部作废**(按已销毁处理,作用域保留、照常可建)→ 补回画布尺寸 → 报 warning「图形设备已恢复」→
  `onRestored` 回调。同一个 `RhiDevice` 对象跨代存活;`lost` 每次取都是当前这一代的;恢复前 `runFrame` / `submit` 作废;
  挂着的 `readTexture` / `readBuffer` 遇到丢失就 reject。**持有 RHI 资源的一方必须订 `onRestored` 丢缓存重建**
  (engine2d 已订);只在 GPU 上的内容(渲染纹理画过的)没了,同 WebGL。空后端用 `NullRhiDevice.loseDevice()` 模拟。
- **渲染图每帧新建**:pass 只能取自己在 reads / writes 里声明过的资源;结果没人要的 pass 被剔除
  (根 = `sideEffect` 或写导入资源);读了此前没人写过的图内资源 = 编译错误;瞬时资源由 `RgTransientPool`
  跨帧复用、同帧内生命期不重叠者共用一块,闲置 `maxIdleTicks` 次后销毁。

## 与 engine2d 的分工

- 设备归 RHI:`createRenderer` 在画布上建 RHI 设备(建前先把画布摆到目标尺寸,零面积会配出 0×0 的深度缓冲),
  engine2d 的 WebGPURenderer 只经 RHI 接口建资源、录命令;`Renderer.destroy` 由 engine2d 负责拆设备(`ownsDevice`)。
- 画布尺寸由 engine2d 改 `canvas.width/height`,改完调 `rhi.resizeSwapchain(w, h)`(luma 自己记着绘制缓冲尺寸,
  不告诉它深度缓冲会停在旧尺寸);零面积忽略,那一帧 engine2d 也不录。
- 抗锯齿:engine2d 目标 antialias(画布跟渲染器选项、RenderTexture 跟纹理源)⇒ 画布走 `swapchainMultisampled(4, …)`,
  离屏给每张目标纹理配一张同格式 ×4 颜色(带模板时再配 ×4 深度)并以 `resolveTargets` 落回;管线键带采样数。
- 模板遮罩:engine2d 用 `frame.swapchainWithDepth(format)` / 离屏深度模板纹理;pass 描述里的 `stencilOp` 与管线的 `stencil`
  状态由 luma 后端自己拼 GPURenderPassDescriptor 下发(luma 9.4 不传模板操作,且给了 depthStencilAttachmentFormat 会把模板参数弄坏)。
- 着色器 / 渲染对照:`tools/render_parity` 把 master 的 src 放进本分支的对照框架里跑,只算着色器单元级的辅助检查。
  与 master 的行为对照以 `tools/ab_compare` 为准(两棵独立检出各自跑),见 engine2d 卡。
  Pixi 的 WebGPU 渲染器与 `pixiWebGpuPatches` 已删除,`?renderer=webgpu` 开关不再存在(只有 WebGPU)。

## 已知坑

- 画布后备缓冲只在 `runFrame` 期内可用,且**第一次当 pass 目标时才向画布取纹理**;没画画布的帧不碰画布。
- 管线建好后**不必**等 `ready` 就能用:确认失败之前 draw 照常录制;只有确认建坏的管线,它的 draw / dispatch 才被跳过
  (计入 `skippedDraws`,告警一次)。`pipelinesReady()` / 管线预建的用处是把编译卡顿挪到揭幕遮罩下,不是正确性前提。
- bind group 由 luma 后端按「着色器声明的每个绑定所指资源的身份(+ 缓冲区段偏移 / 尺寸、纹理当前采样器)」缓存在管线上
  (照 Pixi 8 的 BindGroupSystem),命中时直接设给原生 pass、不经 luma 的 setBindings。
- render pass 热路径(setPipeline / bind group / 顶点流 / 索引 / draw / viewport / scissor)不经 luma 的 RenderPass,
  直接调原生 `GPURenderPassEncoder`,并照 Pixi 8 GpuEncoderSystem 按 pass 记已绑状态、相同不重发(luma 那条路每个 draw
  都重设全部顶点缓冲、逐槽分配日志参数,每次 setPipeline 还分配闭包 + Promise)。原生顶点槽 / 偏移取自 luma 9.4
  `WebGPUVertexArray` 的 `resolvedBufferSlots` / `logicalBufferSlots`(建管线时缺了直接报 backend;
  `LumaRhiDevice.test.ts` 有一条拿 luma 自己的 bindBeforeRender 对照,升级 luma 时先看它)。
- 开 / 结束 render pass、命令编码与提交也不经 luma:pass 描述符自己拼、在**原生** `GPUCommandEncoder` 上开,
  finish 后直接 `queue.submit`(luma 的 WebGPURenderPass 构造时每次都 JSON.stringify 描述符、经 probe 读
  `performance.memory`、做资源统计;CommandEncoder / CommandBuffer 也各是一个带统计的 Resource——每帧几十个 pass 就是几毫秒)。
  拷贝 / 计算 pass / 调试组仍经 luma,用到时才把同一个原生编码器包一层。画布目标的附件视图每帧只向画布取一次
  (缓存视图,不缓存 luma 在带 / 不带深度目标间共用的那个帧缓冲对象)。关着 luma 调试时它的错误作用域本来就是空操作,
  校验错误照旧经 uncapturederror 进诊断。
- 画布类图像源(Text 的画布)的 `copyExternalImageToTexture` 在 Chrome 里是同步的:要等 GPU 进程,软件光栅
  (SwiftShader)下每次上传主线程卡 100 ms 上下(master 的 WebGL `texImage2D` 不卡)。Pixi 的 WebGPU 路径同样如此;
  改走 `getImageData` + `writeTexture` 也要回读(实测十几 ms),且依赖浏览器反预乘的舍入,没改。
- 图像源上传(`uploadImage`)可能有 ±2 的舍入:浏览器解码 / 拷贝链路内部会做一次预乘往返;没有被乘上 alpha。
- 云端容器里**无头** Chromium 的 WebGPU 呈现到画布会丢设备(裸 WebGPU 也一样);离屏与 compute 正常。
  **有头**(`xvfb-run`)+ `--enable-features=Vulkan --use-vulkan=swiftshader --use-angle=swiftshader` 上屏正常(2026-09-25 实测),
  整局截图对照(`tools/render_parity/game_sweep.mjs --swiftshader`)就这么跑。

## 怎么验证

- 单测(空后端,不需要 GPU):`npx vitest run src/rendering/rhi`。
- 真机冒烟:`npx vite --config tools/rhi_smoke/vite.config.ts` 后浏览器打开,`?case=关键字` 只跑部分用例;
  无头:`node tools/rhi_smoke/run.mjs`(要 playwright-core,见文件头)。每个用例回读像素 / 缓冲逐一核对。
