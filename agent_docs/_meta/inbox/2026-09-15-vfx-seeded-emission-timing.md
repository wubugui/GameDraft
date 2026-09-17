---
target: vfx-system
date: 2026-09-15
---
现象: 实例种子虽不同，首批 burst 与固定 rate 仍齐拍；新增可选的效果 prewarmSeconds 范围和发射器 spawn.intervalJitter 比例，用种子控制起始进度与后续发射节拍。
证据: vfxSim.ts 静默预热按真实空间与风推进，排除当前玩家/接触/刺激、清除历史事件；独立 timingRng 不扰动粒子随机流。vfxTiming.test.ts、test_timing.py、timing-selftest.js 及 artifacts/vfx_timing_20260915/runtime_probe.json 验证确定性、错峰与保存往返。
建议: 机制卡补充此可选能力；默认关闭保持旧行为。工作台「起播错峰→预热时长」0..15 秒、「发射→间隔浮动」0..0.95；只给确实需要常驻错峰的效果启用，勿强制所有演出从中途开始。
