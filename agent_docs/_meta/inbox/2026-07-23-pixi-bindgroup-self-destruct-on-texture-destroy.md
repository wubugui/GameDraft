---
target: runtime
date: 2026-07-23
session: 切场景后照明整包丢失 + 影子崩 addressModeU —— 同一个根因
---

现象: 切场景后第二张起 `characterLighting.active` 恒 false(载荷明明在磁盘上、v2、哈希也对),
`SceneDepthSystem.groundTex` 指向**已销毁**的 TextureSource,渲染时抛
`Cannot read properties of null (reading 'addressModeU')`。表面看像"载荷坏了",实际载荷一路加载
成功(日志已打 `lighting v2 active, 1680 probes`),是**就绪回调 `onReady` 抛出去**、被 `load()`
的 catch 当成载荷故障整包丢弃(连带 destroy 纹理),下游才采到已销毁的源。

证据: Pixi v8 `BindGroup.onResourceChange` 见到所绑资源 `destroyed` 就**把自己作废**
(`resources = null`,见 `lib/rendering/renderers/gpu/shader/BindGroup.mjs:71-86`);此后读
`filter.resources[...]` 直接抛。`BackgroundDebugFilter` 是**跨场景长活**的(只在 Game 销毁时
destroy),却绑着按场景销毁的 `uGroundD`;卸载时它不在任何清扫名单里 → 载荷一 destroy 就把它烧掉
→ 下一张场景的 `onReady → setGroundTexture` 抛 → 整份照明没了。栈:
`get _u (BackgroundDebugFilter.ts) → Object.get (Shader 资源访问器) → BindGroup.getResource`。

建议: 机制卡记两条不变量——①**绑了按场景销毁的纹理的对象,卸载时必须先解绑回占位图,再销毁纹理**;
顺序反了不是"泄漏",是把那个滤镜**永久烧毁**。长活对象尤其危险,因为它不在任何 unload 名单里
(本次修法:`BackgroundDebugFilter.unbindSceneTextures()` + 在 depthUnloader 里 destroy 载荷之前调用,
另给 `_u` 加 try/catch 兜底)。②**调试链路的异常绝不能穿进玩法链路**:`onReady` 里调试可视化那步
要单独兜错并排最后,否则 F2 一个坏了整场景照明陪葬,而且**不报错**(catch 里只有 depthError,
默认日志不开就完全静默)。

附带同日抓到的第二个坑(dev 工具):`__gameDevAPI.stepFixedTicks(n)` 少传 dtMs 时
`undefined/1000 = NaN` → 步长 `0*NaN = NaN` → 玩家 `sprite.x/y` 被写成 NaN(位移分支靠
`stepX !== 0` 放行,NaN 恰好过闸;越界/碰撞判据遇 NaN 又全 false),相机随之 NaN、整个世界渲染不出来
且不可逆。命令通道那头本来有兜底,裸 API 没有——已在 `debugStepTicks` 汇合处夹成有限值。
无头验证脚本注意:**rAF 泵和 stepFixedTicks 是两条独立驱动线,同时开会双跑一帧**。
