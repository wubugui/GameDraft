---
target: character-animation-production
date: 2026-09-25
session: 动画生产路线实测（artifact/AnimRoute_20260925）
---

现象: 09-14 Meshy 批次草鬼婆 slow_walk 的提示词写「在原站姿里抬一只脚再放回原处、支撑脚不许滑」，生成出来是原地踏步——支撑脚逐帧后蹭量为 0，游戏里一移动就是溜冰，任何后处理都救不回；位移类动作要的是「跑步机式」（支撑脚匀速往后蹭、身体居中），Dir8Walk 的 walk_W 用 "walking IN PLACE as on a treadmill" 才对。
证据: artifact/AnimRoute_20260925/gait/cgb_slow_walk_gait.png（红点平=支撑脚不动）对比 gait/ge_walkW_gait.png（红点斜线=匀速后蹭）。
建议: 位移动作提示词模板写死「跑步机：着地的脚随地面匀速往后，身体居中不前进」，并把「支撑脚逐帧后蹭量>0」列为生成后第一道程序检查。
