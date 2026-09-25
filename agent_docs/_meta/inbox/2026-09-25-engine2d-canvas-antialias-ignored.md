---
target: engine2d
date: 2026-09-25
session: parallax_editor 迁 engine2d
---

现象: engine2d 收下 `Application.init({ antialias: true })` 但画布不做 MSAA(RHI 没有 sampleCount / resolve),Graphics 线与圆、Sprite 边缘是锯齿;Pixi WebGL 同参数是 MSAA 平滑边。卡里「与 Pixi 的已知差异」没列这条。
证据: tools/parallax_editor 迁移前后同页截图逐像素比,差异只在描边/精灵边缘(内部逐像素相同);grep `sampleCount|multisample` 在 src/rendering/rhi 与 src/engine2d/gpu 无命中,antialias 只进滤镜纹理池键。游戏自己是 antialias:false,不受影响。
建议: 已知差异补一条「画布 antialias 被忽略(无 MSAA)」;另外本卡「parallax_editor 自成一体」一句已过期——它现在也走 engine2d。
