---
target: entity-lighting
date: 2026-07-24
session: 光照数据加载瘦身
---

现象: 机制卡/代码原先「体素卷(vol_rad/vol_emit)仅 dev 进场景预载」——实测每场景 20–27MB,dev 每切一次场景都拉、进场景后还占显存,而它只有 F2 实时 RT 对比(mode 0)用得上。现改为**任何构建都不进场景预载**:`characterLighting.load()` 删掉 `loadVolumes` 参数、恒用 1×1 占位卷;F2 切到 RT 时 `ensureVolumes()` 现拉、切离时 `releaseVolumes()` 立即卸并还显存。进茶馆总下载 38.5MB→11.5MB。
证据: `src/core/CharacterLightingSystem.ts`(新增 ensureVolumes/releaseVolumes/swapVolumeTextures/disposeStaleVolumeTextures + volTextures/staleVolTextures 独立管理);`src/core/Game.ts#applyRtVolumeMode`(F2 mode 跨 0/≥1 边界时拉/卸并重挂滤镜);真机验:进场景 vol 请求=0、F2 开 RT 拉 27MB 且 uMode=0 渲染非黑、关 RT 卷回 1×1、并发去重、切场景重置全过。
建议: entity-lighting 机制卡把「体素卷 dev 预载」更新为「体素卷永不预载、F2 RT 时按需拉/卸」;并强调换卷时序硬约束——**先重挂滤镜再销毁旧卷纹理**(Pixi v8 BindGroup 见 destroyed 资源即自毁,顺序反了永久烧滤镜,与 2026-07-23-pixi-bindgroup 同根因)。
