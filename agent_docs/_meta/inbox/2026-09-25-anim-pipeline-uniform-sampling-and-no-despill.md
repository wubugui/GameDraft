---
target: animation-pipeline
date: 2026-09-25
session: 动画生产路线实测（artifact/AnimRoute_20260925）
---

现象: tools/animation_pipeline 原样跑 AI 原地走视频：①抠图只出 alpha、边缘 RGB 仍混着底色（绿幕出一圈绿边）；②周期内等时间取帧，而 AI「跑步机」视频的地面并不匀速（脚尖原地拖约 8 帧、且每 4 帧一次跳变=视频 VAE 4 帧一块），等时间取帧游戏里脚必滑；③侧面走路的第一个自相似谷是「一步」不是一个循环（左右腿互换轮廓几乎一样），需要按 2 倍重找。
证据: artifact/AnimRoute_20260925/stock_run/guan_ergou/inspect/zoom_slow_walk.png（绿边）；gait/stance_20_36.png、stance_33_48.png（脚尖拖地）；gait/ge_walkW_ends_belt.json（逐帧地面位移，周期 4 的跳变）。
建议: 取帧按地面位移动态规划重定时 + 残余用整帧横移（根修正）抵掉；抠图对饱和底色加边缘带取内部实色 + 去溢色；走/跑周期强制含左右两步。
