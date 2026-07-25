---
target: sprite-atlas-anim-contract
date: 2026-07-25
session: 表情气泡锚点 P1–P5
---

现象: 契约卡说 states 是"廉价参数、主编辑器可直接格式保真写回"，但 video_to_atlas 重导出同名动画包是**从零拼 dict 整份覆盖 anim.json**，人在 anim 编辑器里调的 `referenceSpeed` 会被静默抹掉（新加的 `bubbleAnchor` 同样暴露）。
证据: `tools/video_to_atlas/atlas_core.py` 的 `export_gamedraft_anim_multi` 无 merge；`export_panel.py:345` 提示明文写"选已有 = 覆盖其图集与 anim.json"。已在 `atlas_core.save_outputs` 加 `merge_preserved_anim_fields`（`PRESERVED_STATE_FIELDS = referenceSpeed, bubbleAnchor`）并配 `test_anim_editor_save_fidelity.test_reexport_preserves_manual_state_fields`。
建议: 卡里补一条"人工 per-state 字段清单 + 重导出必须并回"；以后新增此类字段要同步登记 `PRESERVED_STATE_FIELDS`，否则又是一轮白调。
