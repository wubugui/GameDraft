---
target: pixi-v8-traps
date: 2026-09-02
session: 「切场景就卡死」定位与修复（dev 模式跳场景必现）
---

# 渲染抛一次异常 = 整局死透（Ticker 再也不排下一帧）

- **现象**：dev 模式跳场景，3～4 次之内画面定格、输入全无、在途的切场景永久悬住，
  只能刷页面。控制台一条 `TypeError: Cannot read properties of null (reading '0')`
  （`GlShaderSystem.bind` ← `MeshPipe.execute` ← `_Application.render`）。
- **根因**：`CharacterLightingSystem.parkLitShaders()` 那张"卸载前退回白图"的槽位表是
  **手抄的镜像**，`createLitShader` 2026-09-01 加了 `uSkyaoTex` 而它没跟上。场景卸载时
  skyao 的 `BufferImageSource` 被 destroy → 玩家（**跨场景长活**，不在任何 unload 名单里）
  身上还活着的 lit shader 的 BindGroup 见死自毁（`resources = null`）→ 下一帧渲染即抛。
- **影响放大器（这条卡里没有，值得收编）**：Pixi 的 `Ticker._tick` 先把 `_requestId`
  置 null、再调 `update()`，**只有 update 正常返回才排下一帧**。所以任何从 render 逃出来
  的异常都不是"掉一帧"，是 `started` 仍为 true 却再没人申请 rAF —— 主循环永久死亡。
  卡里"把那个滤镜永久烧毁"其实低估了：烧毁的是**整局游戏**。

## 已修（2026-09-02）

1. 槽位表挪到 `CharacterLitSprite.LIT_SHADER_SCENE_TEXTURE_SLOTS`，与 `createLitShader`
   的 resources 同处维护，`parkLitShaders` 改吃它（补上 `uSkyaoTex`）。
2. `Renderer` 在 `app.init()` **之前**给 `app.render` 套 crash guard —— 异常照旧大声报
   （控制台 + dev 错误面），但绝不逃到 ticker。必须在 init 之前装：TickerPlugin 在 init
   里就把 `this.render` 的函数引用交给 ticker 了。

留给知识库的那句话：**手抄的槽位镜像必然会漏；而在 Pixi 里，渲染路径上漏一个槽位的代价
不是画面不对，是整局卡死。**
