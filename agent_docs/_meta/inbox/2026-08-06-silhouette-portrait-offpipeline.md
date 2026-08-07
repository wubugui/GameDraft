---
target: dialogue-portrait-pipeline
date: 2026-08-06
session: 五需求评估 + 通用剪影头像落地
---

现象: 新增立绘集 `silhouette/`(单姿态通用黑影)未走卡里写的 3×3 表情大图 + 灰底 flood-fill 管线,而是「洋红底单图生成 → 色键抠底 → 去 AI 角标 → 512×512」。卡内没有"单姿态/非九表情立绘集"这条路径。
证据: public/resources/runtime/images/dialogue_portraits/silhouette/(silhouette_calm.png + silhouette_portrait_meta.json,expressions 只有一项);tools/dialogue_portrait_pipeline.py 只接 3×3 sheet;抠底按 colorkey-matting 配方(键色测出 (252,20,228),可见洋红像素 0)。
建议: 治理时决定是把"单姿态特殊立绘集"补进卡(注明 meta.expressions 可只写一项、编辑器与运行时都已支持),还是要求这类资产也并进 dialogue_portrait_pipeline.py;另:seedream 出图自带右下「AI生成」角标,任何走 arkcli 出的立绘素材都要有去角标步骤,当前是一次性脚本、未并入管线。
