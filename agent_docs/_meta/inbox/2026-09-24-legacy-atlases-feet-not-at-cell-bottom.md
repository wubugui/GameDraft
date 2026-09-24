---
target: sprite-atlas-anim-contract
date: 2026-09-24
session: 图集脚底离格底 → 制作人定 per-state footOffset(运行时补、素材像素不动),已落地
---

现象: 契约写"锚点=底中=脚",但 6 套 cld_reprocess_20260711 图集整体悬空 5–11 wu(jump/lie_down 片段蹲起、躺下帧落在定线以下,旧产线按全帧最大下沿 B 定格高,其余 state 一起被抬);static_bundle_20260806 的 prop_funeral_coffin_anim 底部留白 28px(卡上"这批同样紧裁"不成立)。已按制作人定加 `states[*].footOffset` 落地,契约卡只做了最小事实修正。
证据: src/rendering/SpriteEntity.ts#effectiveAnchorY / getDisplayTexture(投影剪影裁掉脚底线以下) + SpriteEntityFootOffset.test.ts;tools/animation_pipeline/foot_offset.py(量 + --write,42 包已写,原件备份 tmp/foot_offset_backup_20260924/ 与 DVC 缓存哈希一致);atlas_core.PRESERVED_STATE_FIELDS 已登记;编辑器动画面板「脚底偏移%」列 + 按图测;画布 npc_anim / 气泡舞台用 anim_atlas_preview.lower_frame_to_foot 同口径。
建议: 治理 run 盲对账时把 footOffset 并进契约卡正文(画面锚点 vs 逻辑锚点两层、光照 mesh 原点=脚所以不能落 sprite.y);static-single-frame-bundle 卡补"早期手搓包并非都紧裁(棺材)";旧产线跳跃/躺下片段自身起落帧仍不齐(源素材问题),目前无内容使用。
