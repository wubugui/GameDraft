---
id: dialogue-voice-channel
title: 台词配音通道(voice/autoAdvance · 跨拍留声)
domain: runtime
type: mechanism
summary: 全部台词面共用一条单声道配音通道;默认跟本拍停、hold 留声给后面、声明跟随配音的那拍接管并收尾
status: active
authority:
  - src/systems/VoiceChannel.ts
  - src/systems/DialogueVoiceDirector.ts
  - src/systems/CutsceneManager.ts#beginBeatVoice
  - src/systems/CutsceneManager.ts#awaitBeatDismiss
  - src/ui/DialogueUI.ts#handleAutoAdvance
  - tools/editor/shared/voice_spec_field.py
  - tools/editor/shared/audio_library.py#audio_id_problem
triggers:
  paths:
    - "src/systems/VoiceChannel.ts"
    - "src/systems/DialogueVoiceDirector.ts"
    - "src/systems/CutsceneManager.ts"
    - "src/ui/DialogueUI.ts"
    - "tools/editor/shared/voice_spec_field.py"
  topics: [配音, voice, autoAdvance, hold, 留声, 字幕配音, 台词配音, 跟随配音结束]
  tasks: [配台词配音, 加配音字段, 改台词推进方式]
verified_by:
  - src/systems/VoiceChannel.test.ts
  - src/systems/CutsceneVoiceBeats.test.ts
  - src/systems/DialogueVoiceDirector.test.ts
  - tools/editor/tests/test_voice_spec_field.py
  - tools/editor/tests/test_action_voice_params.py
  - tools/editor/tests/test_audio_editor_iteration.py
last_governed: 2026-08-17
---

## 是什么(一句话)

一条配音的寿命常常**长于说它那一拍**(一句配音配三条短字幕),所以"谁来停它"必须有一个
跨拍的所有者——全工程唯一一条单声道配音通道 `VoiceChannel`。

## 权威源(读代码从哪进)

`VoiceChannel.ts`(通道 + 两个解析器);过场侧 `CutsceneManager.beginBeatVoice/awaitBeatDismiss`;
世界对话侧 `DialogueVoiceDirector`(听 `dialogue:line`,不碰 UI 状态机);
自动推进落地在 `DialogueUI.handleAutoAdvance`;编辑器唯一录入面 `voice_spec_field.py`。

## 覆盖面(五处台词面,同一套键)

`voice` + `autoAdvance` 两个键在下列位置**语义完全一致**:

| 位置 | 写在哪 |
|---|---|
| 过场字幕 | `present:showSubtitle` 步上 |
| 过场对话框 | `present:showDialogue` 步上 |
| 脚本台词 | `playScriptedDialogue.params.lines[i]` |
| 图对话 | 单拍 line 节点顶层 / 多拍 `lines[i]` / choice 的 `promptLine` |
| 头顶气泡 | `showEmote` / `showSpeechBubble`(只吃 `voice`)、`*AndWait`(两个都吃) |

## 硬契约(违反即 bug)

- **单声道**:任何新配音开播前先停在播的那条(两条人声叠着响必是编排事故)。
- **默认跟拍停**:`voice` 不写 `hold` = 本拍结束即停(与本机制出现之前逐字一致)。
- **`hold: true` = 留声**:本拍结束不停,转入留声态。**只认真布尔 true**(同 `disabled`)。
- **接管即收尾**:本拍**没自带配音**却写了 `autoAdvance: "voice"` → 接管留声的那条,
  并**跟这一拍一起结束**(玩家提前点走也停)。这就是"一条长配音配几句短字幕"的实现。
  没有留声可接管 → 退化为等点击,**绝不闪切**。
- **`onEnd` 只认自然播完**:手动停 / 被顶掉不触发,故"跟随配音推进"在配音被打断时退化为
  等点击。要**封口**的等待方(阻塞气泡 `*AndWait`)必须用 `onSettled`(任何收场都恰好一次),
  否则配音被顶掉时那条 await 永久悬挂。
- **多拍图对话的节点级 `voice` 不作各拍默认**:各拍的配音必然各是一条,继承只会让同一条
  声音每拍重播;节点级只对**无 `lines` 的单拍节点**生效。
- **收尾口径与过场音频回收契约一致**:中断(Esc 跳过 / 读档 / 拆除)一律 `stopAll`;
  自然播完只可能剩一条 hold 留声的,与"末拍音效按编排收尾"同理,让它播完。
- **自动推进不是玩家输入**:`dialogue:autoAdvance` 走与点击等价的路径但**不发**
  `dialogue:advanceInput`——那是点击音的触发口,响一声就成了幽灵点击。
- **音频 id 的合法性口径只有一处**:`audio_library.audio_id_problem`
  ——编辑器三个建 id 的入口(新增 / 重命名 / 扫描登记)与 validator 共用它。
  禁空、禁首尾空白、禁 `空格 " \ /`;**中文照收**(本项目 id 常态)。
  跨频道同名报 warning:各区独立查表不回落,同名两条极易改错一边。
  自动建议的 id **就是文件名**(`suggest_audio_id`),撞名先拿父目录兜再补数字。

## 已知坑

- 非阻塞气泡(`showEmote`/`showSpeechBubble`)没有"本拍结束"这个时刻,其 `voice` **一律留声**
  (自然播完 / 被下一条顶掉 / 被后续拍接管为止),写不写 `hold` 都一样;它们也不吃 `autoAdvance`。
- `volume` 写 `null` 不等于 0:`Number(null) === 0` 会把"没写音量"静默解释成静音,解析器已挡。
- 旧键名 `subtitleVoice` / `subtitleAutoAdvance` 只在 `showSubtitle` 上作兼容别名读;
  **编辑器保存时改写成新键名**(present 步在重建区),不要在新数据里写旧名。

## 怎么验证

`npx tsc --noEmit` + 三个 vitest(通道语义 / 过场拍 / 世界对话导演)+ 两个 pytest
(控件写盘契约 / action 参数往返)+ validate-data。听感仍需真人试玩:
一段"一条长配音盖两条短字幕"的过场,应当第一条按时走、第二条等配音念完才走,中途不断音。
