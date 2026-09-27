---
target: sprite-atlas-anim-contract
date: 2026-09-25
session: 动画生产路线实测（artifact/AnimRoute_20260925）
---

现象: referenceSpeed 契约说它是「步速匹配基准」，但没有任何产线量它；player_anim/walk 写 50，按图集实测支撑脚后蹭对应的不打滑速度只有 32.4，游戏里走 100 时倍率夹在 2，脚每次支撑往前溜约 11 世界单位。
证据: artifact/AnimRoute_20260925/measure_bundle_stride.py、planted_metric.py 输出；ingame/final_feet.png（游戏录制回放，每行一帧只画脚）。
建议: referenceSpeed 应由产线从「地面（支撑脚）逐帧位移」算出而不是手填；见 artifact/AnimRoute_20260925/route_build.py 的 belt_track_ends + 帧率反推。
