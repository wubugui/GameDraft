---
target: engine2d
date: 2026-09-27
session: wt/breath 呼吸工作台迁 RHI(出片改离屏渲染纹理 + 异步回读)
---

现象: 同一场景画到画布与画进离屏 RenderTexture 在少数像素上差 1——画布 pass 为与 master 逐位一致是上下颠倒光栅化(FrameBuilder flipY)再翻上屏,离屏纹理不翻,插值末位舍入不同;engine2d 卡没写这一条,离屏回读对"游戏画面"做逐字节对照会误报。
证据: tools/breathing_workbench/tests/parity/run.mjs 出片例:工作台离屏回读 vs 引擎 extract 0 差,vs 游戏画布 1664×928 上 120–149 像素差 1(≤0.01%,集中在位移后的胸口区);tools/workbench_rhi/README.md「离屏渲染纹理 + 异步回读」一节。
建议: engine2d 卡的"画布翻转"处补一句:离屏目标不翻,与画布同场景可差 1;离屏读法的对照基准用 renderer.extract / generateTexture。
