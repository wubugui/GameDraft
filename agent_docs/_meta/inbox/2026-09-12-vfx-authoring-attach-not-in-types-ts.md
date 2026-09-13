---
target: vfx-workbench
date: 2026-09-12
session: 粒子工作台「角色挂点」锚点模式
---

现象: 卡说效果资产键序「按 types.ts」,但工作台新加的工作态 `authoring.attach`(挂点预览:heightWu / offsetX)
在 `src/data/types.ts#VfxEffectDef.authoring` 里没有对应字段 —— 本次不许改 src/(另一会话在改),镜像只落在
`tools/vfx_workbench/assets.py#_AUTHORING_ORDER`。
证据: `tools/vfx_workbench/assets.py`(`_ATTACH_ORDER` / `_attach`)对 `src/data/types.ts:4318` 的 `authoring` 块;
`--selftest` S16 21 条(含存盘往返与键序)全绿,`validate-data` 错误集与基线逐字相同(authoring 不被任何校验器读)。
建议: 往 `types.ts` 的 `VfxEffectDef.authoring` 补 `attach?: { heightWu: number; offsetX?: number }`(运行时仍然忽略),
并在卡的「作者面怎么用」补一行锚点模式三档;顺带在卡里写清"挂点预览跑的是运行时 `VfxInstanceSim.moveAnchor`,不许在 JS 里另写跟随"。
