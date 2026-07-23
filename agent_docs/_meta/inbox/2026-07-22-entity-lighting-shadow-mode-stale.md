---
target: entity-lighting
date: 2026-07-22
session: 角色着色与阴影系统通读
---

现象: 机制卡仍写 real=DeferredEntityShadow、planar=EntityShadow 的三模式分流，当前 Game.createShadowImpl 对 real/planar 一律创建 PlanarEntityShadow，DeferredEntityShadow 已不在运行时工厂链路中。
证据: src/core/Game.ts:2316-2324 与 src/rendering/DeferredEntityShadow.ts；F2 文案及 src/data/types.ts 仍把 real 描述为深度重建真实阴影。
建议: 治理时把模式卡更新为「off/启用门 + 当前统一 planar 剪影」，并明确 Deferred 与 real 枚举是待清理兼容残留还是计划恢复能力。
