---
id: scene-onenter-reveal-timing
title: 场景 onEnter 揭幕时机契约
domain: runtime
type: mechanism
summary: loadScene 尾序=scene:ready → 揭幕(onReveal) → onEnter;onEnter 在"已就绪且已揭幕"后执行,里面可安全起可见/长演出
status: active
authority:
  - src/systems/SceneManager.ts
  - src/data/types.ts
triggers:
  paths: ["src/systems/SceneManager.ts", "src/rendering/Renderer.ts"]
  topics: [onEnter, 场景加载, 揭幕, 过渡遮罩, 开场演出]
last_governed: 2026-07-11
---

## 是什么(一句话)

场景根 `onEnter` 的执行时机契约(2026-07-04 重排):`SceneManager.loadScene` 尾部顺序 = 进度100% → emit scene:enter/scene:ready → await `onReveal?()` → 跑 onEnter → consumePendingReentrantSwitch。

## 权威源(读代码从哪进)

- `src/systems/SceneManager.ts` 的 loadScene 尾部与 `onReveal` 参数
- `src/data/types.ts` 的 `SceneData.onEnter` 注释(类型侧契约)
- 图层栈:worldContainer < cutsceneOverlay < uiLayer(Renderer.ts)

## 硬契约(为什么必须这个顺序,别拆散)

- `scene:ready` 给实体挂深度遮挡/光照滤镜、启动巡逻——必须在揭幕**前**,揭出来才是完整表现。
- 揭幕必须在 onEnter **前**:过渡遮罩挂 uiLayer,过场图挂 cutsceneOverlay 在其**之下**;onEnter 在遮罩下播过场的症状 = 只有字幕+音频、没有图(字幕后 addChild 恰好盖遮罩之上)。
- onEnter 里的长阻塞演出(runActions→startCutscene 会一路 await 到过场播完)不得扣住 loadScene 收尾——新顺序里 onEnter 在揭幕之后,天然不扣。
- seam:`switchScene` 传 `onReveal=()=>fadeIn(300)` 并删掉 job 尾部原 fadeIn;初始进场/dev/reload 不传(本就无遮罩)。fadeIn 按真实 `performance.now()` 计时 resolve,不会结构性卡死。

## 已知坑

- 这是引擎级契约:任何"给某场景 onEnter 特殊处理"来绕时序问题的想法都是错方向(历史教训:茶馆开场说书从 initialCutscene 搬进 onEnter 引爆;梦境场景只因图很快撞 line 阻塞点才侥幸没暴露)。

## 怎么验证

真前台标签进带 onEnter 演出的场景(如茶馆),确认遮罩撤掉后演出画面完整出现;无头下带字幕过场会卡首字幕步(rAF 停摆,见 [start-gate-audio-unlock](start-gate-audio-unlock.md)),与本契约无关。
