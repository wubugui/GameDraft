---
target: missing
date: 2026-07-22
session: 角色着色与阴影系统通读
---

现象: 定稿推导禁止 probe 吸附到自由点后仍冒充原规则格点，当前 stage_probes 仍把实体内 origin 吸附到最近自由体素、只以 off_grid 判 valid，而运行时按规则格点插值且载荷不携带 probes_pos。
证据: artifact/Design/伪世界角色照明-修正版完整推导-2026-07-21.md §10.4/§15.3；tools/character_lighting_lab/pipeline.py:628-662、src/core/CharacterLightingSystem.ts:494-530。
建议: 为新角色着色系统治理机制卡时列为实现缺口，改为无吸附有效掩码/连通约束，或让运行时显式消费真实 probe 位置，禁止两套位置语义并存。
