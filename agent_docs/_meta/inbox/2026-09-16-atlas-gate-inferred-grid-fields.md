现象：atlas_gate 直接索引 cellWidth/cellHeight 并要求 atlasFrames，但茶馆在用旧 anim.json 由运行时从图片和 cols/rows 推导这些字段。
证据：tools/animation_pipeline/qa_gate.py:120；public/resources/runtime/animation/fx_patron_chatA/anim.json；本轮保持实际 anim.json 不变，仅在 artifacts/teahouse_sprite_repairs_20260916/qa-anim.json 为 QA 补充派生字段。
建议：后续统一 QA 与运行时合法旧包的字段推导口径；本轮只修素材，未修改检查器代码。
