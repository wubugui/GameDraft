---
target: sprite-atlas-anim-contract
date: 2026-10-02
---

现象: 动画包新增人工 per-state 字段 contactAoEnabled，人工保留字段清单的机制卡仍只列 referenceSpeed/bubbleAnchor/footOffset。
证据: tools/video_to_atlas/atlas_core.py 的 PRESERVED_STATE_FIELDS 已包含 contactAoEnabled，tools/editor/tests/test_anim_reexport_preserves_manual_fields.py 与保存保真测试已通过。
建议: 将该布尔字段加入动画人工编辑与重导出保留契约；未配置旧包按共享默认表解析，不需批量改写资产。
