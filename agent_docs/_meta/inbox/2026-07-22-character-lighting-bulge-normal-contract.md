---
target: missing
date: 2026-07-22
session: 角色着色与阴影系统通读
---

现象: 定稿推导要求法线随当前角色尺寸与 bulge 同步更新，当前 spriteNormalAtlas 以固定 0.35 高度烘死法线，运行时 uBulge 只偏移 q.z、不改变 n，界面却称其同时影响法线。
证据: artifact/Design/伪世界角色照明-修正版完整推导-2026-07-21.md §4.4/§14.1.8/§15.5；src/rendering/spriteNormalAtlas.ts:119-139、src/rendering/CharacterShadingFilter.ts:370-377。
建议: 为新角色着色系统治理机制卡时明确现状；若保留可调 bulge，应重算法线或把参数拆成固定法线形状与独立采样位移，避免一个控件承诺两种未同步语义。
