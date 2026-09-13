---
target: scene-wind
date: 2026-09-13
session: 01a099b2-3781-75e0-a5c9-381fce1824ed
---

现象: scene-wind 将整份拆层描述为跨时段共用，但 sway_plate 是带光照的主背景 RGB，复制到夜间会混入白天底板；“同一速度场、不另加噪声”也与草木自己的两正弦强迫不一致。
证据: artifact/Reviews/wind-lighting-research-2026-09-13.md 及配套 evidence JSON；真实 build_layers+bake_sway 隔离复现夜图角落 RGB 14、夜底板 RGB 180，日夜底板逐字节相同；backgroundSway.ts:711 与 sceneWind.ts:272 的湍流消费不同。
建议: 区分可共享结构 mask 与逐时段 RGB 底板；收录风摆的二维几何/静态深度/光照缓存接入边界，并把“共用钟与参数”同“采样完全相同的三维风矢量”分开说明。
