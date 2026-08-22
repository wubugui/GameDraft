---
target: missing
date: 2026-08-21
session: 修统一光影的四条静默缺陷(法线解码/softening 单位/shadowBias 死值/GI 文档)
---

# 统一光影整套没有机制卡,只有一张单位约定卡

- **现象**:`src/rendering/lighting/`(SceneLightingPass / UnifiedCharacterShader /
  lightPacking / GiBouncePass / lightingCore.glsl)、`src/core/SceneLightingSystem.ts`、
  `tools/scene_relight/` 这一整套 2026-08-20 起的新管线,库里**没有任何 mechanism 卡**。
  `runtime/mechanisms/entity-lighting.md` 与 `character-lighting.md` 的 authority 指的都是
  **旧路径**(`lightEnv.ts` / `EntityLightingFilter.ts` / probe 载荷),读者按图索骥会走到被取代的那套。
- **本次只收编了一件**:`runtime/mechanisms/lighting-authoring-units.md`(作者面用米),
  因为它是单个可验证的知识单元;整套管线的机制卡属于"批",按 intake 流程该停下交治理 run。
- **待治理 run 定夺**:①统一光影主机制卡(两级结构 / 恒等迁移 / 伪世界空间铁律 /
  27 个占位场景的 placeholder 契约)②`entity-lighting.md` 与 `character-lighting.md`
  的 authority 是否该标 superseded 或分流 ③`lightEnv` 那套的最终去向(用户尚未拍板)。
