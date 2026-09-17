---
id: scene-onenter-reveal-timing
title: 场景 onEnter 揭幕时机契约
domain: runtime
type: mechanism
summary: loadScene 尾序=scene:ready → 揭幕前闸(限时,遮罩下做完会卡帧的准备) → 揭幕(onReveal) → onEnter;初始进场同样先遮罩后揭幕;主 tick 必须先于任何场景装载挂载
status: active
authority:
  - src/systems/SceneManager.ts
  - src/systems/SceneManager.ts#loadInitialScene
  - src/core/Game.ts
  - src/data/types.ts
triggers:
  paths: ["src/systems/SceneManager.ts", "src/rendering/Renderer.ts", "src/core/Game.ts"]
  topics: [onEnter, 场景加载, 揭幕, 过渡遮罩, 开场演出, 主循环挂载]
last_governed: 2026-09-17
---

## 是什么(一句话)

场景根 `onEnter` 的执行时机契约:`loadScene` 尾部 = 进度 100% → emit scene:enter/scene:ready →
await 揭幕前闸 `revealGate?(sceneId)` → await `onReveal?()` → 跑 onEnter → 消化在途重入切换。

## 权威源(读代码从哪进)

`SceneManager.loadScene` 尾部与 `onReveal` 参数、`SceneManager.setRevealGate`、`SceneManager.loadInitialScene`;
`Game.start` 的 ticker 挂载点;`types.ts` 的 `SceneData.onEnter` 注释;
图层栈 worldContainer < cutsceneOverlay < uiLayer(`Renderer.ts`)。

## 硬契约(为什么必须这个顺序,别拆散)

- `scene:ready` 给实体挂深度遮挡/光照滤镜、启动巡逻——必须在揭幕**前**,揭出来才是完整表现。
- **揭幕前闸**(`setRevealGate`,`Game` 注入):scene:ready 的监听全跑完之后、撤遮罩之前 await。
  给"必须在遮罩下做完、否则就停在可见画面上"的活——粒子 shader 交给 Pixi、粒子预热(见 [vfx-system](vfx-system.md);
  2026-09-16 之前它们落在揭幕后第一帧,进茶馆那一帧 11 s)。**闸自己限时、永不悬挂**(`Game` 里 shader 15 s、粒子 8 s,
  超时放行、剩下的按帧接着做);抛了只记一笔照常揭幕。没有 `onReveal` 的直达 / 重载也过闸(不影响即时性,只是 onEnter 晚一点)。
  往闸里加东西之前先问:它能不能在揭幕后按帧分摊?能就别加——闸越长,每次切场景的黑屏越长。
- 揭幕必须在 onEnter **前**:过渡遮罩挂 uiLayer,过场图挂 cutsceneOverlay 在其**之下**;
  onEnter 在遮罩下播过场的症状 = 只有字幕 + 音频、没有图。
- onEnter 里的长阻塞演出(runActions→startCutscene 会一路 await 到过场播完)不得扣住 loadScene
  收尾——新顺序里 onEnter 在揭幕之后,天然不扣。
- **初始进场同样走"遮罩装载 + 揭幕"**(`loadInitialScene`):无前场景可淡出,故遮罩 instant 置黑
  起手,揭幕仍是 loadScene 的 `onReveal`。装载失败也必须撤遮罩,否则首屏锁死。
  dev 直达路由与 reload 不走它(要即时)。
- **主 tick 必须先于任何场景装载挂载**,onEnter 演出才有世界侧驱动。

## 已知坑

- 开场演出期间玩家滞留世界原点、NPC 定格首帧、通知不弹、实体渲染成半透,**跳过后一切"突然正常"**
  ≈ 主 tick 尚未挂载(世界冻结),不是过场收尾 bug。
- 进场时看着背景/NPC 逐个刷出(首启贴图未命中缓存最明显)= 该场景没走遮罩装载路径。
- 这是引擎级契约:任何"给某场景 onEnter 特殊处理"来绕时序问题的想法都是错方向
  (历史教训:茶馆开场说书从 initialCutscene 搬进 onEnter 引爆)。

## 怎么验证

真前台标签进带 onEnter 演出的场景,确认遮罩撤掉后演出画面完整出现、主角在出生点;
无头下带字幕过场会悬死(rAF 停摆,见 [start-gate-audio-unlock](start-gate-audio-unlock.md)),与本契约无关。
