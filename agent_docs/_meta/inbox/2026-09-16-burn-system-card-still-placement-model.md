---
target: burn-system
date: 2026-09-16
session: burn-workbench 模板化改造
---

现象: burn-system 卡仍写"可燃物就是热点 + burn_placements.json 布置库 / burnHotspotFrameOf / 按热点展示图挂滤镜"，现实已是模板 + 宿主 burnable 块（布置库已删、摆放走 burnEntityPlacement），其 triggers.paths 还挂着 burn_placements.json。
证据: public/assets/data/burn_placements.json 不存在；src/systems/burn/burnGeometry.ts 已无 burnHotspotFrameOf；agent_docs/editor-tools/mechanisms/burn-workbench.md 已按新模型改写。
建议: 运行时侧（BurnSystem / runtimeBurnSync 协议 v2）落地后按 A3.8「模板 + 实例」重写该卡；另外燃烧工作台的场景视图照 Hotspot/Npc 实体本身取透视口径，运行时 BurnSystem 若另定口径需回头对齐 preview.js 的 entityPerspective。
