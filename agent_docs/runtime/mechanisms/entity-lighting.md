---
id: entity-lighting
title: 场景光环境 / 实体阴影 / 深度遮挡
domain: runtime
type: mechanism
summary: 行走面深度场是遮挡·阴影·碰撞的唯一脚点锚(没场就整体关,不回落拟合直线);阴影一律 planar 剪影;色调与阴影解耦
status: active
authority:
  - src/rendering/EntityShadow.ts#PlanarEntityShadow
  - src/rendering/EntityLightingFilter.ts
  - src/rendering/DepthOcclusionFilter.ts
  - src/rendering/lightEnv.ts
  - src/rendering/lightEnvCurve.ts
  - src/core/SceneDepthSystem.ts#setGroundDepthField
  - src/core/Game.ts#createShadowImpl
triggers:
  paths: ["src/rendering/*Shadow*", "src/rendering/lightEnv*", "src/rendering/EntityLightingFilter.ts", "src/rendering/DepthOcclusionFilter.ts", "src/core/SceneDepthSystem.ts"]
  topics: [光照, 阴影, AO, lightEnv, 色调, 遮挡, 行走面深度, ground_d]
last_governed: 2026-08-05
---

## 是什么(一句话)

场景侧的实体受光表现:投影阴影 + 场景色调融入 / AO + 深度遮挡(角色被场景前景挡住);
角色本体的逐像素受光是另一套,见 [character-lighting](character-lighting.md)。
总开关 `game_config.json` 的 `entityLighting.enabled`。

## 权威源(读代码从哪进)

阴影工厂 `Game.createShadowImpl` → `EntityShadow.ts`;滤镜两支(遮挡 / 光照)共用
`EntityLightingFilter.ts` 顶部的 `IEntityShadingFilter` 驱动接口;光环境解析与位置驱动曲线
在 `lightEnv*.ts`;地面/深度上下文在 `SceneDepthSystem.ts`。

## 硬契约(违反即 bug)

- **行走面深度场(`lighting/ground_d.png`)是脚点的唯一来源**,遮挡 / 阴影落地面 /
  `isCollision` 反投影三处并列适用。传 null = 本场景没烘 → **三者一律关闭**,
  绝不悄悄退回旧的 `floor_depth_A/B` 拟合直线(多层街巷可偏出 200+ 行地面,
  站在可见地面上的站位整块被吞)。
- **遮挡与着色是两个代理,禁止合并**:遮挡用脚深度处的代理体、着色用直立 quad;
  合成一个必回上半身 pop-through。
- 阴影实现**一律 planar 剪影**(角色 mask 剪影 + 剪影上模糊)。`shadowMode` 的
  `real`/`planar` 现已同义,`DeferredEntityShadow.ts` 是待清理死码;
  planar 的方位角是**屏幕约定**(影朝 `az+180` 铺地),调参按这个读。
- **色调独立于阴影**:`toneEnabled` 与 `shadowMode` 解耦,`off` 不连带关色调。
- **`lightEnvCurve` 必须原地写回 `currentLightEnv`**:阴影实例与 shadowField 持引用逐帧读,
  换对象引用会静默失联。

## 已知坑

- F2 滑块必须 `noRefresh` + 就地 sync,否则点按钮 / 切模式滑块复位;F2 只改
  `currentLightEnv`,不进存档。
- 未做,勿当缺陷重报:灯光方向场(`shadowField.ts` 只留了接口)、点光、多角色阴影 RT 并集。

## 怎么验证

`./dev.sh audit-depth`(场景 JSON depthConfig / 运行时深度+碰撞图 / 资产尺寸三处落点一致性);
画面对错肉眼难判,取证走 [headless-visual-verification](../recipes/headless-visual-verification.md);
看形状退化用 darkness=1.0 + 关 AO + 低 elevation。
