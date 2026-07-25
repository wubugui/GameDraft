---
target: entity-lighting
date: 2026-07-24
session: 角色着色核心单一 GLSL 源
---

现象/不变量: 角色着色曾有三处独立手写 GLSL——运行时 `CharacterShadingFilter.ts` FRAG + 灯光实验室 `viewer/app.js` 的 CHAR_FS/CHAR3D_FS。实验室是调着色参数(eChroma/beta…)的唯一入口,预览若与运行时漂移则调出的值到游戏里就是错的、且**不报错**。已抽出单一真相源消灭镜像:任何角色着色迭代(尤其后续 E 颜色/明暗分离)**只改** `src/rendering/charShadeCore.glsl` 的 `shadeCharacterLinear()`,三处自动对齐——**禁止在任一 shader 内联重写这段**。
证据: `src/rendering/charShadeCore.glsl`(核心:E 分解 + albedo×E,返回线性域,依赖调用方 srgb2lin)。运行时:vite `?raw` import 注入到 FRAG(lin2srgb 之后)。实验室:`serve.py` 加 `/api/char_shade_core.js` 端点读同一文件包成 `window.CHAR_SHADE_CORE`,`index.html` 在 app.js 前同步载入,`app.js` 追加进 COMMON prelude;两个角色 shader 都 `col=shadeCharacterLinear(alb,E,uEChroma,uBeta)*uPGain`(pgain 仅实验室预览增益,游戏不乘)。tsc/329 单元/JS+py 语法全绿。
建议: entity-lighting 机制卡记这条不变量与三处接线(?raw / serve 端点 / COMMON append);pgain 是实验室专用差异、其余口径必须一致。改 glsl 后实验室需硬刷(端点 no-store,已防缓存)。
