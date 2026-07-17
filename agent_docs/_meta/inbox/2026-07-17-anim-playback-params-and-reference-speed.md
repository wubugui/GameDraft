---
target: sprite-atlas-anim-contract
date: 2026-07-17
session: 动画播放头参数扩展 + 步速匹配
---

现象: anim.json 的 state 新增可选字段 referenceSpeed（步速匹配基准，世界单位/秒），playNpcAnimation 新增可选参数 speed/reverse/holdFrame/thenState，NpcDef 新增 initialAnimPlayback（场景实体初始播放参数：speed/reverse/holdFrame/startFrame，进场起播一次性生效）——契约卡的 state 字段清单与"播放模型"描述未覆盖这些新能力。
证据: src/data/types.ts（AnimationStateDef.referenceSpeed / AnimationPlaybackParams / NpcInitialAnimPlayback）、src/rendering/SpriteEntity.ts（playbackSpeed/reverse/hold/startFrame + applyLocomotionSpeed 夹取 0.5~2）、tools/editor/editors/anim_editor.py（states 表新增 refSpeed 列）、tools/editor/editors/scene_editor.py（NPC 面板「初始播放参数」组）、actionParamManifest.ts playNpcAnimation.optional。
建议: 契约卡补一句"state 可选 referenceSpeed=步速匹配基准（编辑器 refSpeed 列，留空不参与）"；播放模型注明播放头参数属 action 层非 anim.json 层。
