---
target: runtime-norms
date: 2026-07-31
session: object-examine 虫子氛围重做（苍蝇/蜈蚣/爬虫簇/蛆）
---

现象1: scripts/generate_demo_audio.py 的 BASE_DIR 指向 public/assets/audio/（不存在），实际音频资产都在 public/resources/runtime/audio/；新合成的 fly_buzz.wav 只能手工写到后者，脚本与现实脱节。
现象2: __gameDevAPI.stepFixedTicks(n, 16.7) 推进的仿真时间与 n×16.7ms 严重不符（60 tick 后 sim t 跳 ~50s），计时类行为验证不可用它推时间，须用真实 RAF 等待 + getMinigameDebugState().objectExamine.critters 快照对照。
建议: 修脚本 BASE_DIR 或改为参数化输出目录；stepFixedTicks 的 dt 语义需在配方里写清（或修实现）。
