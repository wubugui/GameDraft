---
id: cutscene-audio-reclamation
title: 过场音频回收契约
domain: runtime
type: mechanism
summary: 过场 SFX 作用域捕获 + 快照音频基线;中断路径停尾音、自然播完保留末拍——cleanup 布尔语义勿回退
status: active
authority:
  - src/systems/AudioManager.ts#beginCutsceneSfxCapture
  - src/systems/CutsceneManager.ts
  - src/data/types.ts#ICutsceneAudioPlayer
triggers:
  paths: ["src/systems/CutsceneManager.ts", "src/systems/AudioManager.ts"]
  topics: [过场, 音频回收, SFX, BGM 基线, restoreState, 尾音, 跳过过场]
  tasks: [过场里放音效, 过场里换 BGM 或环境音, 排查过场后声音残留或变响]
last_governed: 2026-09-23
---

## 是什么(一句话)

过场各条退出路径上音频不泄漏的契约:一次性 SFX 进作用域捕获,BGM/环境音进快照基线,
退出时按"中断 / 自然播完"区别回收。

## 权威源(读代码从哪进)

`types.ts` 的 `ICutsceneAudioPlayer` 接口;`AudioManager` 的 begin/endCutsceneSfxCapture;
`CutsceneManager` 的 startCutscene / cleanup / captureSnapshot / restoreSnapshot。

## 硬契约(违反即 bug)

- 捕获在 `cutscene:start` **之后**开始(避免误捕开场提示音)。
- **`cleanup(stopCutsceneSfx)` 布尔语义(勿回退)**:中断路径(Esc 跳过 / 读档 / 拆除)传 `true`
  停尾音;**自然播完传 `false`**,只关作用域、让末拍音效按作者编排收尾。
- BGM/环境音基线:**只在同场景恢复分支**调 restoreAudioBaseline——跨场景由
  loadScene→applySceneAudio 重建,勿重复;playBgm/addAmbient 幂等。
  **不受 `restoreState` 门控**:`restoreState:false` 说的是"过场自己拥有结束时的**位置与相机**",
  音频基线属于场景不属于过场——两者曾被同一个开关捆住,于是这类过场只能在"位置对"与"音频对"之间二选一。
- 捕获在 `playSfx` 的**同步入口**记下"是否在捕获中",回调里再复查一次:被推迟到过场结束后才真正起播的不登记。
- **循环音没有自然尾巴**:无论自然结束还是中断都停;一次性音只在中断时停。
- 快进(Esc 连按)跳过一次性音效类动作,**不跳** `playBgm` / 环境音——它们建立基线,跳了排演起点听感不对。
- 配音:中断一律 `stopAll`;自然播完只可能剩 hold 留声那条,让它播完(见 [dialogue-voice-channel](dialogue-voice-channel.md))。
- **快照存的是带本处音量的引用**(`getCurrentBgmCue` / `getActiveAmbientCues`),不是裸 id。
  只记 id 的话,场景把某层环境音压到 0.3、过场里停掉它,还原时会按素材原音量回来——变响
  一大截,且只在真机听得出来。口径见[逐处音量](per-site-audio-volume.md)。
- 手动 stop 一次性 SFX 必须 `off('end')`,防死闭包累积。

## 已知坑

- BGM/ambient 基线是 reachable-by-design(allowlist 允许 playBgm/stopBgm、playSignalCue 会间接停
  环境音),别因"当前内容只用 playSfx"当死代码删。
- **基线还原只"补回"不"撤走"**:过场里 `playSceneAmbient` 新加的层,过场后会留在场景里,除非内容自己停
  (该动作注释说"统一还原、内容层不必收尾",与实现不符)。
- 快照读的是**已提交**的播放(不是请求意图):进场景即开过场、BGM 还在解码或音频未解锁时,快照拿到上一场景的
  BGM 或空,还原时会切回旧曲 / 停掉新曲(推断,未见测试)。
- 捕获只管 `playSfx` 与循环音;过场里直接走 `playSfxAt` 的声音(落雷、粒子事件音)不在捕获表里,
  它们的回收靠各自的 owner / 句柄。
- 普通批的 `duckAudio` 在过场里被 Esc 跳过后,`restoreAudio` 不执行,世界闷到闪避层 20s 兜底才抬。

## 怎么验证

tsc + vitest 过后,**听感行为无法 headless 验证**(隐藏页过场悬死),需真人有声试玩:
一段带 SFX 的过场分别 Esc 跳过(尾音应停)与看完(末拍应保留)。
