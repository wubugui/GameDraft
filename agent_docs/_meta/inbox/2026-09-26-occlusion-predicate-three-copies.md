---
target: entity-lighting
date: 2026-09-26
session: 场景前景图层基建(跑马梁歪脖子树)
---

现象: 计划与卡都说遮挡判据"两份实现"(DepthOcclusionFilter / EntityLightingFilter),实际烘焙角色走 CharacterShadingFilter,里面有第三份同判据的遮挡段;mesh 路径角色(CharacterLitSprite)的遮挡则仍挂 DepthOcclusionFilter。只改两份,烘焙场景里的人照样被糊开的深度切。
证据: src/rendering/CharacterShadingFilter.ts main() 的"深度遮挡(P2a 契约)"段;本次三份一起接了 uFgCoverage,SceneForegroundLayers.test.ts 按源码钉三份同一行判据。
建议: entity-lighting 卡"权威源"那句改成三支(遮挡 / 光照 / 烘焙着色)共用 IEntityShadingFilter;已在硬契约里补了一条前景层覆盖图的说明。
