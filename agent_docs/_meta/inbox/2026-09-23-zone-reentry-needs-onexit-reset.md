---
target: narrative-flow-authoring
date: 2026-09-23
session: 游戏关卡与演出问题修复
---

现象: "走到某处弹地图/弹选择"写成「区域 onEnter 发信号 + 区域条件只认起始状态」，一旦玩家关掉面板不走，状态已离开起始格、区域永远不再触发 = 卡关（夜出南门·跑马梁地图）。修法是区域 onExit 发"离开"信号把场景图退回中性格、区域条件只认主线那一格；切场景（地图传送）也会跑 onExit，所以"到达"迁移要从中性格和目标格两处都能收。
证据: narrative_graphs.json scenario_夜出南门（t_离开南头_* / t_到跑马梁_未在南头）+ 梦_醒来土路.json z_南门小路_南头.onExit。
建议: narrative-flow-authoring 的地图关补一条"可反复触发的门口"写法；map_config 节点解锁可以直接写 heldProp 叶做硬验（火把燃着）。
