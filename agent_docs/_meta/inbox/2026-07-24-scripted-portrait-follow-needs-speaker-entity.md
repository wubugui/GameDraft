---
target: dialogue-portrait-runtime
date: 2026-07-24
session: 过场编辑器 scriptedNpcId 主角候选 + 「跟随说话人」立绘失效修复
---

现象: 「满屏没头像」还有第二个根因(卡里只记了"台词行缺 portrait 字段"):脚本台词
(过场 `present:showDialogue` / `playScriptedDialogue`)的「跟随说话人」**只认 speaker 里的
`{{player}}/{{npc[:id]}}` 占位**——策划照常把显示名写成字面("李瞎子")时解析不出说话人实体,
`resolveScriptedPortrait` 静默返回 undefined,选了「跟随说话人」等于没选。且主角不在任何场景的
NPC 表里,过场表单的 `scriptedNpcId` 是不可编辑下拉,策划**根本没法把说话人指成主角**。

证据: 修前 `public/assets/data/cutscenes/index.json` 里 10 条带 portrait 的 showDialogue **全部**
写死 `slug`,零条 follow(其中一条 `scriptedNpcId: waiter_xiaoer` 却配 `slug: npc_lifu_anim`
——手动兜底兜歪了);对照 `Game.ts` 的「…」气泡锚点解析器早就有"字面显示名 + scriptedNpcId"
兜底分支,立绘这条路没有,两者口径不一致。修法:说话人实体收敛成
`Game.resolveScriptedSpeakerEntityForLine` 唯一口径(占位 > scriptedNpcId > 旁白不认),
`player` 升为保留实体 id(`scriptedDialogueSpeaker.PLAYER_ENTITY_ID`)。

建议: 卡里补一句判据——查"某某没头像"时,除了看行有没有 portrait 字段,还要看
**这行的说话人实体解析得出来吗**(speaker 占位 / scriptedNpcId / 旁白);另外凡是"运行时
有两条路径消费同一份策划输入"(此处气泡锚点 vs 立绘跟随),兜底分支必须同源,否则策划看到的是
"气泡冒得出来、头像就是不出来"这种最难自证的半瘫状态。
