---
target: pixi-v8-traps
date: 2026-09-16
session: 体积光（光柱）落地
---

现象: 卡里写"实际编译目标是 GLSL ES 1.00"是无条件的；实际 Pixi v8 `GlProgram` 按片元源码里有没有 `#version 300 es` 逐个决定——有就去掉再插回、按真 ES3 编译（数组构造式等照常能用），没有才走 ES 1.00 反向转译。
证据: node_modules/pixi.js/lib/rendering/renderers/gl/shader/GlProgram.mjs 的 `isES300 = options.fragment.indexOf("#version 300 es") !== -1`；src/rendering 下 CharacterLitSprite / BurnFilters / backgroundSway / vfx 着色器都带这一行。
建议: 改成"没写 `#version 300 es` 的源按 ES 1.00 编译（坑照旧）；写了就是 ES3"，免得后来者为了一条不存在的限制手写展开。
