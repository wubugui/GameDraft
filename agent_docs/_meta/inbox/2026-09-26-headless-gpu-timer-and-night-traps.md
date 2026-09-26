---
target: headless-visual-verification
date: 2026-09-26
session: 场景前景图层基建(跑马梁歪脖子树)
---

现象: ①隐藏页里对默认帧缓冲的 EXT_disjoint_timer_query 计时常拿到 0、gl.finish 计时抖一倍,量不出零点几毫秒的差;渲进离屏 RT 再计时才稳(清一张 1024×576 RT 就 0.12 ms,要先量清屏基线再减)。②页内同步 readPixels 紧跟 renderer.render(stage) 能取到画面(不必截图),A/B 用它比逐像素最可靠。③跑马梁夜里瞬移会踩区域弹说明卡(UIOverlay,tick 首行返回)、火灭后阳气耗死进 Dead;先 lockHealth、每发 eval 先派键关卡。④隐藏页 devLoadScene 要 35~40 s 墙钟,单发 eval 45 s 超时,要拆两发等。
证据: 本次会话页内取证记录(scratchpad shots/ shots2/);scene-foreground-layers 卡里的覆盖图 GPU 开销即按①②量出。
建议: 配方"取像素的陷阱"补①②,"坑"补③④。
追记(2026-09-27): ⑤ 同一台机器两次开页 `renderer.resolution` 可能一次 1 一次 2(绘制缓冲 2048×1536),readPixels 的矩形要乘 resolution,否则裁到别处还以为画面错了。
