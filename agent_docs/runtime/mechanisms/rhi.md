---
id: rhi
title: RHI(渲染硬件接口 · 显式 pass · 渲染图 · luma.gl 后端)
domain: runtime
type: mechanism
summary: 取代 Pixi 做底层图形的引擎式 RHI——显式 render/compute pass、创建后不可变的管线、按名字绑定、资源一律经作用域创建(有主);渲染图按声明的读写剔除 pass、算生命期、别名复用瞬时资源;唯一实现是 luma.gl(WebGPU 优先、WebGL2 回落),两后端差异(compute、Y 朝向、命令时序、采样器)在后端里抹平或经 caps 暴露,不静默降级。游戏尚未接入
status: active
authority:
  - src/rendering/rhi/types.ts
  - src/rendering/rhi/RhiDevice.ts
  - src/rendering/rhi/RhiResourceScope.ts
  - src/rendering/rhi/graph/RenderGraph.ts
  - src/rendering/rhi/graph/RgTransientPool.ts
  - src/rendering/rhi/backends/luma/LumaRhiDevice.ts
  - src/rendering/rhi/backends/null/NullRhiDevice.ts
triggers:
  paths: ["src/rendering/rhi/**", "tools/rhi_smoke/**"]
  topics: [RHI, luma.gl, WebGPU, compute shader, render pass, 渲染图, render graph, frame graph, 瞬时资源, 替换 Pixi, 移植渲染]
  tasks: [往 RHI 上迁渲染代码, 写 compute pass, 加渲染后端, 加 pass, 排查 WebGL2 与 WebGPU 画面不一致]
verified_by:
  - src/rendering/rhi/RhiResourceScope.test.ts
  - src/rendering/rhi/graph/RenderGraph.test.ts
  - src/rendering/rhi/backends/luma/lumaMapping.test.ts
  - tools/rhi_smoke/cases.ts
last_governed: 2026-09-25
---

## 是什么(一句话)

`src/rendering/rhi/` 是照游戏引擎做的图形层:上层只认 `index.ts` 导出的接口,具体图形 API 由后端翻译。
目标是把 Pixi 从世界渲染里换走(Pixi 没有 compute、没有 pass 概念);**截至本卡,游戏代码还没有任何一处接入它**。

## 分层(依赖只许往下)

`types` / `RhiDevice`(接口)→ `RhiResourceScope`(所有权)→ `graph/`(渲染图,只依赖接口)→ `backends/luma`(WebGPU,回落 WebGL2)、`backends/null`(不碰 GPU 的空后端,单测用)。
上层**不许 import `@luma.gl/*`**;要什么能力先在 RHI 接口上加,再在两个后端各实现一遍。

## 硬契约

- **资源有主**:缓冲 / 纹理 / 管线一律经 `scope.createXxx` 建;场景级资源挂场景作用域,切场景销毁作用域一次收干净。
  `destroy()` 立即失效(再用当场报 `destroyed-resource`),底层句柄等当前这批命令提交后才释放。
- **帧级异常隔离**:`runFrame` / `submit` 截住录制期的一切异常 → 上报诊断、这一批作废、返回 false。
  主循环不会因为画错一次而死(对照 pixi-v8-traps 第一条)。
- **按名字绑定**:uniform = WGSL 变量名 = GLSL uniform block **块名**;采样器命名「纹理名 + Sampler」,
  传了就设成该纹理的采样状态(两后端同一条路),不传用纹理创建时的 `sampler` 描述(缺省 clamp + 线性)。
  着色器要的名字没给,当场 `invalid-usage`(不像 luma 那样静默跳过 draw)。
- **朝向一律照 WebGPU**:纹理第 0 行 = 画面顶部,uv(0,0) = 左上,视口 / 裁剪矩形左上原点。
  WebGL2 后端对**离屏目标**用自动生成的 Y 翻转顶点着色器变体渲染(剔除面随之对调),对画布换算视口 Y;
  上层着色器照 WebGPU 约定写一份逻辑即可。
- **命令按录制顺序生效**:luma 的 WebGL2 路径 pass 当场执行、拷贝却攒到提交时,后端已改成拷贝也当场执行。
- **录制期不许写本批已引用的资源**:WebGPU 的 writeBuffer 在整批命令之前生效、WebGL2 当场生效,
  两边结果不同,所以直接报错。逐 draw 变化的数据用不同缓冲 / 偏移,或在录制前写好。
- **不静默降级**:WebGL2 没有 compute / 存储缓冲 / 存储纹理,建这些当场 `unsupported`;
  渲染图 `addComputePass` 同样当场报。上层按 `device.caps` 选路径。
- **图像上传缺省不预乘**(`premultiplyAlpha: false`):alpha 当数据的图不会被乘掉;颜色图要预乘就显式传 true。
- **渲染图每帧新建**:pass 只能取自己在 reads / writes 里声明过的资源;结果没人要的 pass 被剔除
  (根 = `sideEffect` 或写导入资源);读了此前没人写过的图内资源 = 编译错误;瞬时资源由 `RgTransientPool`
  跨帧复用、同帧内生命期不重叠者共用一块,闲置 `maxIdleTicks` 次后销毁。

## 已知坑

- 画布后备缓冲只在 `runFrame` 期内可用,且**第一次当 pass 目标时才向画布取纹理**;没画画布的帧不碰画布。
- WebGL2 上 GLSL 的 `gl_FragCoord.y` 在**画布** pass 里是自下而上(离屏已翻成与 WebGPU 一致);
  WebGL2 的 `copyTextureToTexture` 源必须是可当颜色附件的格式。
- WebGL2 每条渲染管线建两个程序(离屏翻转 / 画布),`pipeline.ready` 两个都等;首次使用前 await 它,
  否则 luma 会跳过 draw(计入 `skippedDraws` 并告警一次)。
- luma 对"只有一个成员、无实例名的 uniform block"会打一条命名告警,是它的启发式误报,按块名绑定正是 RHI 的约定。
- 本仓库云端容器(无头 SwiftShader)里 WebGPU **呈现到画布**会丢设备,裸 WebGPU 也一样;离屏与 compute 正常。
  画布上屏的 WebGPU 验证要在真显卡的 Chrome / Edge 上跑。

## 怎么验证

- 单测(空后端,不需要 GPU):`npx vitest run src/rendering/rhi`。
- 真机冒烟:`npx vite --config tools/rhi_smoke/vite.config.ts` 后浏览器打开,`?backend=webgpu|webgl2`、`?case=关键字`;
  无头:`node tools/rhi_smoke/run.mjs`(要 playwright-core,见文件头)。两后端核对的是同一组像素期望值。
