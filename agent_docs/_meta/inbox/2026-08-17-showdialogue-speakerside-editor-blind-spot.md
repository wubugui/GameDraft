---
target: editor-roundtrip-contract
date: 2026-08-17
session: 台词配音通道(voice/autoAdvance)
---

现象：过场 `present:showDialogue` 的 `speakerSide`（运行时 CutsceneManager 真消费，覆盖"主角在右"分边）在编辑器里**没有任何控件**，而 present 步属重建区——用编辑器打开这一步再保存，该键会被静默抹掉。
证据：`grep -rn speakerSide tools/` 零命中；`timeline_editor._serialize_step` 的 showDialogue 分支 `d.update(wdg.to_step_dict())`，而 `CutsceneShowDialogueFields.to_step_dict` 不产出这个键。当前数据里恰好零处使用，故没炸过。
建议：按"盲区即升级信号"补一个分边下拉（与图对话拍的 speakerSide 同语义），或在 to_step_dict 里做原值透传兜底；本次改动只加配音字段，未顺手扩这一处。
