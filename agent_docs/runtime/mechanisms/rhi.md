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
- **渲染图每帧新建**:pass 只能取自己在 reads / writes 里声明过的资源;结果没人要的 pass 被剔除
  (根 = `sideEffect` 或写导入资源);读了此前没人写过的图内资源 = 编译错误;瞬时资源由 `RgTransientPool`
  跨帧复用、同帧内生命期不重叠者共用一块,闲置 `maxIdleTicks` 次后销毁。

## 与 engine2d 的分工

- 设备归 RHI:`createRenderer` 在画布上建 RHI 设备(建前先把画布摆到目标尺寸,零面积会配出 0×0 的深度缓冲),
  engine2d 的 WebGPURenderer 只经 RHI 接口建资源、录命令;`Renderer.destroy` 由 engine2d 负责拆设备(`ownsDevice`)。
- 画布尺寸由 engine2d 改 `canvas.width/height`,改完调 `rhi.resizeSwapchain(w, h)`(luma 自己记着绘制缓冲尺寸,
  不告诉它深度缓冲会停在旧尺寸);零面积忽略,那一帧 engine2d 也不录。
- 模板遮罩:engine2d 用 `frame.swapchainWithDepth(format)` / 离屏深度模板纹理;pass 描述里的 `stencilOp` 与管线的 `stencil`
  状态由 luma 后端自己拼 GPURenderPassDescriptor 下发(luma 9.4 不传模板操作,且给了 depthStencilAttachmentFormat 会把模板参数弄坏)。
- 着色器 / 渲染对照:`tools/render_parity` 已改成 **master(Pixi WebGL)对本分支(engine2d)**,见 engine2d 卡。
  Pixi 的 WebGPU 渲染器与 `pixiWebGpuPatches` 已删除,`?renderer=webgpu` 开关不再存在(只有 WebGPU)。

## 已知坑

- 画布后备缓冲只在 `runFrame` 期内可用,且**第一次当 pass 目标时才向画布取纹理**;没画画布的帧不碰画布。
- 管线建好后首次使用前 await `pipeline.ready`,否则 luma 可能跳过 draw(计入 `skippedDraws` 并告警一次)。
- 图像源上传(`uploadImage`)可能有 ±2 的舍入:浏览器解码 / 拷贝链路内部会做一次预乘往返;没有被乘上 alpha。
- 云端容器里**无头** Chromium 的 WebGPU 呈现到画布会丢设备(裸 WebGPU 也一样);离屏与 compute 正常。
  **有头**(`xvfb-run`)+ `--enable-features=Vulkan --use-vulkan=swiftshader --use-angle=swiftshader` 上屏正常(2026-09-25 实测),
  整局截图对照(`tools/render_parity/game_sweep.mjs --swiftshader`)就这么跑。

## 怎么验证

- 单测(空后端,不需要 GPU):`npx vitest run src/rendering/rhi`。
- 真机冒烟:`npx vite --config tools/rhi_smoke/vite.config.ts` 后浏览器打开,`?case=关键字` 只跑部分用例;
  无头:`node tools/rhi_smoke/run.mjs`(要 playwright-core,见文件头)。每个用例回读像素 / 缓冲逐一核对。
