---
target: strike-threat
date: 2026-09-23
session: 游戏关卡与演出问题修复
---

现象: 雷形旧贴图是 22 根正弦推开的细丝"绞成一束"，游戏里读成 40–60 px 粗的蓝电绳；Γ 形"顶上一拐下面一根直棍"是 DBM 侧壁太近（81 格、远场 Dirichlet 壁不受通道屏蔽）的边界假象，不是 η。卡里只写"雷形资产 vfx/lightning_bolt_*.json"，没说一道雷现在是两层（主通道 bolt + 枝 bolt_branches，枝只在第一次回击亮）。
证据: tools/vfx_workbench/bake_lightning.py（GRID_W 181、ETA 2.3、render_layers、EXPOSURE、MAX_MAIN_LATERAL 挑种子、已有资产只换雷本体两层）；scratchpad 实机对照 bolt/ingame*/compare-before-after.png；备份 artifact/LightningRedo_20260923/before/。
建议: strike-threat 卡补"一道雷 = 两个发射器、雷高沿用已调值、重烘不冲其余发射器"；items.json 雷符用 effects 池（09-21 被改成单个 lightning_bolt_01，5 道同形）。
