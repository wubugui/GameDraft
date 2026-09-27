---
target: vfx-rendering
date: 2026-09-27
session: 粒子工作台 2D 迁 RHI（wt/vfx2d）
---

现象: `VfxRenderer.ensureView` 在 `getDepth()` 为 null 时用 `sheet.texture.source` 顶替深度槽，雷层（`appearance.bolt`）拿的是 `BOLT_STUB_SHEET`（texture 为 null）⇒ `Cannot read properties of null (reading 'source')`，没有深度的场景 / 画布特效（`CanvasVfxHost` 的 getDepth 恒 null）一放雷就抛；卡片没写这条。
证据: `src/rendering/vfx/VfxRenderer.ts` ensureView 里 `const depthTex = depthSrc ?? sheet.texture.source;`（在 `isBolt` 分支之前求值）；粒子工作台雷预览先按 getDepth null 接线，Chrome 里当场复现同一个异常（2026-09-27）。
建议: 雷层的深度槽本来就绑 `depthSrc ?? Texture.WHITE.source`，把 `depthTex` 的求值挪进非雷分支即可（改运行时行为，要走运行时的改法与回归，不在工具迁移里顺手改）。
