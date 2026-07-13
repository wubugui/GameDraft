---
id: cutscene-step-semantics
title: 过场步骤语义(parallel/镜头位/字幕推进)
domain: runtime
type: mechanism
summary: parallel 是 fork-join 组内无时序;匿名镜头位自动顶掉;showImg 有 kenBurns/zIndex;subtitleAutoAdvance 三态——编排过场先认这套边界
status: active
authority:
  - src/systems/CutsceneManager.ts
  - src/rendering/CutsceneRenderer.ts
  - src/data/types.ts#CUTSCENE_ANON_SHOT_ID
triggers:
  paths: ["src/systems/CutsceneManager.ts", "src/rendering/CutsceneRenderer.ts", "public/assets/data/cutscenes*"]
  topics: [过场, cutscene, parallel, kenBurns, 字幕, showImg]
last_governed: 2026-07-11
---

## 是什么(一句话)

cutscene 声画编排可用的原语边界:哪些时序纯数据做得到、哪些做不到(L2 候选)。

## 权威源(读代码从哪进)

`CutsceneManager.ts`(step 执行/parallel/字幕)、`CutsceneRenderer.ts`(showImg/kenBurns/图层)。present 类型清单三处必须一致:CutsceneManager.executePresent / validator / timeline_editor。

## 硬契约(违反即 bug)

- **parallel 是 fork-join**:tracks 同时启动、全部完成才继续,组内**没有 sequence**,"先等 N 秒再做 X"纯数据做不到(是 L2 候选,不要硬凑)。可行替代:`parallel{flashWhite|showImg}` 白闪盖切图、`parallel{playSfx|showSubtitle}` 音效随字幕起。skip 用 race 放弃在途轨道,靠步代际终止,别绕过。
- **匿名镜头位**:showImg 不写 `id` / parallaxScene 不写 `handle` → 共用内部槽 `CUTSCENE_ANON_SHOT_ID`,任何新镜头(含具名 parallaxScene)挂载时自动顶掉+杀在途加载;**具名 showImg 不顶匿名槽**(它可能是压在镜头上的 FX 叠层);`hideImg` 不写 id 也指匿名槽。语义=「不写句柄=自动销毁,写了=手动管理」。
- **showImg**:`kenBurns`(缓推缓移,fire-and-forget 不阻塞,hideImg/换图/跳过即停)、`zIndex`(parallel 并发加载 z 序不定,多层合成**必须**显式 zIndex;电影黑边恒 10000)。渲染器只支持静态纹理+kenBurns,真动画 FX 走 present:animLayer。
- **showSubtitle 的 `subtitleAutoAdvance`**:`"voice"`=配音自然播完自动推进(配音缺失/加载失败/手动停都退化为等点击)、正数=毫秒定时、缺省=等点击;点击始终可提前跳。
- playSfx 支持 action 级 `volume`(0–1,替换 entry 基础音量再乘全局)。

## 已知坑

- 全屏插画下 `subtitleEmote` 气泡被 cutsceneOverlay 盖住不可见——别往全屏图字幕上挂 emote。
- 分层视差的前景句柄要管完整生命周期:每个基帧要么 show 要么 hideImg,结尾也要 hide,否则残留到后帧。

## 怎么验证

改完跑 validate-data+素材审计+过场往返测试;真跑用 [runtime-command-channel](../recipes/runtime-command-channel.md)(触发→playerTap 连点→查 console);带字幕过场无头会卡,见 [headless-visual-verification](../recipes/headless-visual-verification.md)。
