---
id: entity-lighting
title: 逐 entity 光照/投影阴影/AO
domain: runtime
type: mechanism
summary: 阴影三模式 real/planar/off + 独立色调开关 + 位置驱动光照曲线;方位角双约定与"脚点锚必须与深度图同源"是最大的坑
status: active
authority:
  - src/rendering/DeferredEntityShadow.ts
  - src/rendering/EntityShadow.ts
  - src/rendering/EntityLightingFilter.ts
  - src/rendering/lightEnv.ts
  - src/rendering/lightEnvCurve.ts
  - src/rendering/entityShadowTypes.ts
triggers:
  paths: ["src/rendering/*Shadow*", "src/rendering/lightEnv*", "src/rendering/EntityLightingFilter.ts"]
  topics: [光照, 阴影, AO, lightEnv, 色调]
last_governed: 2026-07-11
---

## 是什么(一句话)

给玩家/NPC 挂逐实体投影阴影(`real` 深度图射线求交 / `planar` 平面铺贴 / `off`)+ 接触/形体 AO + 场景色调融入的渲染子系统;总开关 `game_config.json` 的 `entityLighting.enabled`,关掉完全回旧管线。

## 权威源(读代码从哪进)

- 模式解析与合并:`lightEnv.ts` 的 `resolveLightEnv`(场景 `lightEnv` < config `shadowMode` < 基线 real)
- 两种阴影实现:`DeferredEntityShadow.ts`(real)/ `EntityShadow.ts`(planar);接口与工厂 `entityShadowTypes.ts`
- 色调/AO 滤镜:`EntityLightingFilter.ts`;接线在 Game.ts(rebuildEntityShadows / applyShadowAndAO)
- 位置驱动光照:`lightEnvCurve.ts`(纯模块可测);深度上下文:SceneDepthSystem.getShadowSceneContext

## 硬契约(违反即 bug)

- **方位角双约定**:real 用世界约定(az=0=+X东,绕Y逆时针),planar 用屏幕约定(影朝 az+180 铺地)。同一 `azimuthDeg` 两模式视觉方向不同,调参/写工具都要分清。
- **脚点锚与表面点必须同源**:deferred 阴影的脚点 F 必须用深度图采样(与 P 同源);用线性 floor 模型会产生系统性标定偏移 → 阴影退化成远处无面积细片(2026-06-17 修过,勿回退)。
- **色调独立于阴影**:`toneEnabled` 与 `shadowMode` 解耦,off 模式不连带关色调。
- **lightEnvCurve 必须原地写回 `currentLightEnv`**:shadowField 与各阴影实例持引用逐帧读,换对象引用会静默失联。
- 深度上下文的 `enabled`(深度图加载成功)≠ `lightingEnabled`,是两个标志;无深度的场景 real 自动退化为 planar。
- real 的 billboard 默认 `'light'`(法线⊥光,不退化);`'camera'` 某些角度会变窄。

## 已知坑

- F2 面板滑块必须 `noRefresh:true` + 就地 sync,否则按按钮/切模式滑块复位。F2 只改 `currentLightEnv`,不动存档。
- 热区 displayImage 仍走旧 depth-only 滤镜(无 tone/AO);场景中途动态 spawn 的 NPC 暂无光照/阴影。
- 未做(勿当缺陷重报):灯光方向场(接口 `shadowField.ts` 已留)、点光、多角色阴影 RT 并集。

## 怎么验证

画面对错肉眼难判且 headless 有 rAF 障碍,用 [headless-visual-verification](../recipes/headless-visual-verification.md):跳不同地图/点/光向各截一张;看形状退化用 darkness=1.0+关 AO+低 elevation。
