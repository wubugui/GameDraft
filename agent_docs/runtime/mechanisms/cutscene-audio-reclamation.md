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
  topics: [过场, 音频回收, SFX, BGM 基线]
last_governed: 2026-08-05
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
  loadScene→applySceneAudio 重建,勿重复;受 `restoreState!==false` 门控;playBgm/addAmbient 幂等。
- **快照存的是带本处音量的引用**(`getCurrentBgmCue` / `getActiveAmbientCues`),不是裸 id。
  只记 id 的话,场景把某层环境音压到 0.3、过场里停掉它,还原时会按素材原音量回来——变响
  一大截,且只在真机听得出来。口径见[逐处音量](per-site-audio-volume.md)。
- 手动 stop 一次性 SFX 必须 `off('end')`,防死闭包累积。

## 已知坑

- BGM/ambient 基线是 reachable-by-design(allowlist 允许 playBgm/stopBgm、playSignalCue 会间接停
  环境音),别因"当前内容只用 playSfx"当死代码删。

## 怎么验证

tsc + vitest 过后,**听感行为无法 headless 验证**(隐藏页过场悬死),需真人有声试玩:
一段带 SFX 的过场分别 Esc 跳过(尾音应停)与看完(末拍应保留)。
