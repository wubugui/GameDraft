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
last_governed: 2026-07-11
---

## 是什么(一句话)

过场退出的五条路径里音频不泄漏的契约:一次性 SFX 进作用域捕获,BGM/环境音进快照基线,退出时按"中断/自然播完"区别回收。

## 权威源(读代码从哪进)

- 接口:`src/data/types.ts` 的 `ICutsceneAudioPlayer`
- 捕获:`AudioManager.beginCutsceneSfxCapture` / `endCutsceneSfxCapture(stopPlaying)`
- 调用点与快照:`CutsceneManager.ts`(startCutscene / cleanup / captureSnapshot / restoreSnapshot)

## 硬契约(违反即 bug)

- 捕获在 `cutscene:start` **之后**开始(避免误捕开场提示音)。
- **`cleanup(stopCutsceneSfx)` 布尔语义(勿回退)**:中断路径(Esc 跳过 wasSkipping / 读档 deserialize / 拆除 destroy)传 `true` 停尾音;**自然播完传 `false`**,只关作用域、让末拍音效按作者编排收尾。
- BGM/环境音基线:captureSnapshot 存 bgmId+ambientIds;**只在 restoreSnapshot 的同场景分支**调 restoreAudioBaseline——跨场景由 loadScene→applySceneAudio 重建,勿重复;受 `restoreState!==false` 门控;playBgm/addAmbient 幂等,未改动即 no-op。
- playTransientSfx 手动 stop 必须 `off('end')`,防死闭包累积。

## 已知坑

- cutscene allowlist 允许 playBgm/stopBgm、经 playSignalCue 间接 stopSceneAmbient——BGM/ambient 基线是 reachable-by-design,别因"当前内容只用 playSfx"当死代码删。

## 怎么验证

tsc+vitest 过后,音频**听感**行为无法 headless 验证(隐藏页过场卡首字幕),需真人有声试玩:播一段带 SFX 的过场分别 Esc 跳过(尾音应停)与看完(末拍应保留)。
