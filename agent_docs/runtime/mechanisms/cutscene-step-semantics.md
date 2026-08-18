---
id: cutscene-step-semantics
title: 过场步骤语义(parallel/镜头位/运镜/字幕推进)
domain: runtime
type: mechanism
summary: parallel 是 fork-join 组内无时序;匿名镜头位自动顶掉;运镜受相机夹紧约束、跳过快进到编排终姿;subtitleAutoAdvance 三态;typewriter 缺省按台词面分家
status: active
authority:
  - src/systems/CutsceneManager.ts
  - src/systems/CutsceneManager.ts#applyFinalCameraPoseForSkip
  - src/rendering/CutsceneRenderer.ts
  - src/rendering/Camera.ts#getSceneBaseZoom
  - src/data/types.ts#CUTSCENE_ANON_SHOT_ID
  - src/core/GameStateController.ts#handleEscape
triggers:
  paths: ["src/systems/CutsceneManager.ts", "src/rendering/CutsceneRenderer.ts", "public/assets/data/cutscenes*"]
  topics: [过场, cutscene, parallel, kenBurns, 字幕, showImg, 运镜, cameraMove, cameraZoom, 逐字, 打字机, typewriter]
verified_by:
  - src/systems/CutsceneTypewriter.test.ts
  - tools/editor/tests/test_cutscene_typewriter_toggle.py
last_governed: 2026-08-05
---

## 是什么(一句话)

cutscene 声画编排可用的原语边界:哪些时序纯数据做得到、哪些做不到(L2 候选)。

## 权威源(读代码从哪进)

`CutsceneManager.ts`(step 执行 / parallel / 字幕 / 跳过终姿)、`CutsceneRenderer.ts`(showImg/kenBurns/图层)、
`Camera.ts`(夹紧与场景基线缩放)。present 类型清单三处必须一致:CutsceneManager.executePresent / validator / timeline_editor。

## 硬契约(违反即 bug)

- **步骤级禁用 `disabled: true`**(2026-08-12):数据保留、**播放时整步跳过**——等于把这一步
  临时注释掉。判据只认**真布尔 true**(`"true"` / 1 照常播,校验器构建期报 error)。
  跳过面必须三处一致:执行(`executeOneStep` 顶层与 parallel 子轨同一入口)、图片预热
  (`collectImagePathsFromSteps`)、跳过终姿(`applyFinalCameraPoseForSkip` 不采纳禁用步的镜头目标)。
  禁用步**不发 `cutscene:step`**(调试 HUD / 编辑器播放头当它不存在);顶层下标不变
  (数据仍在数组里),`fastForwardTo`「从第 N 步开播」照旧对得上编辑器行号。
  `parallel` 上写 `disabled` = 整组连子轨一起跳。
- **parallel 是 fork-join**:tracks 同时启动、全部完成才继续,组内**没有 sequence**,
  "先等 N 秒再做 X"纯数据做不到(L2 候选,不要硬凑)。可行替代:`parallel{flashWhite|showImg}`、
  `parallel{playSfx|showSubtitle}`。skip 用 race 放弃在途轨道、靠步代际终止,别绕过。
- **匿名镜头位**:showImg 不写 `id` / parallaxScene 不写 `handle` → 共用内部槽 `CUTSCENE_ANON_SHOT_ID`,
  任何新镜头(含具名 parallaxScene)挂载时自动顶掉 + 杀在途加载;**具名 showImg 不顶匿名槽**
  (它可能是压在镜头上的 FX 叠层);`hideImg` 不写 id 也指匿名槽。语义 =「不写句柄 = 自动销毁,写了 = 手动管理」。
- **运镜受相机夹紧约束**:世界尺寸 ≤ 当前视口时相机中心被钉在世界中心,`cameraMove` 全程 no-op
  ——必须**先 `cameraZoom` 收小视口再 move**,顺序反了照样不动。
- **`cameraZoom` 的 scale 缺省/≤0 = 恢复场景配置基线**(`scene.camera.zoom`),
  内容侧勿写基线字面量。
- **`restoreState:false` 的过场被跳过时,引擎快进相机到编排终姿**(steps 里最后的
  cameraMove/cameraZoom 目标值,先 zoom 后 snap 保证夹紧正确),与自然播完一致——编排者可依赖此语义。
- **showImg**:`kenBurns`(缓推缓移,fire-and-forget 不阻塞,hideImg/换图/跳过即停)、`zIndex`
  (parallel 并发加载 z 序不定,多层合成**必须**显式 zIndex;电影黑边恒 10000)。渲染器只支持
  静态纹理 + kenBurns,真动画 FX 走 present:animLayer。
- **`autoAdvance`**(旧键名 `subtitleAutoAdvance` 仍读):`"voice"` = 配音自然播完自动推进
  (配音缺失/加载失败/手动停都退化为等点击)、正数 = 毫秒定时、缺省 = 等点击;点击始终可提前跳。
  **本拍没自带配音时,`"voice"` = 接管前面某拍留声的那条**,见 [dialogue-voice-channel](dialogue-voice-channel.md)。
- **`typewriter` 逐字显示**(2026-08-18):**缺省按台词面分家**——`showDialogue` 逐字、
  `showSubtitle` 整句上屏;数据写 `typewriter` 才覆盖,**只认真布尔**(同 `disabled`;
  非布尔构建期报 error)。编辑器**只落偏离缺省的那一侧**,回到缺省即删键。
  玩家设置页的「逐字显示」总开关与速度倍率**压过编排**(关掉即全部整句;
  打到一半关掉当帧补完)。速度基准 30 字/秒,与 `DialogueUI` 同值——那边改了
  `CutsceneRenderer.TYPEWRITER_BASE_CPS` 要跟。点击语义:**还在打就只补完这一句,
  补完后再点才过这一拍**(`completeTypewriters()` 的返回值就是这个分岔);
  Esc 跳过不受影响。字幕的说话人段(`说话人：正文`)恒显示,只逐字正文。
- **`voice`**(旧键名 `subtitleVoice` 仍读):字幕与 `showDialogue` **同一套**配音字段;
  `{"hold": true}` = 本拍结束不停、留给后面的拍。收尾口径见配音通道卡。
- **串行 step 一次一个,上一步必须先上屏**:`executeOneStep` 的帧屏障是语义不是优化,
  后人不得为省帧把连续同步步合并回同一帧(白名单里多数 action 是同步 handler,合并即静默丢步)。
- playSfx 支持 action 级 `volume`(0–1,替换 entry 基础音量再乘全局)。

## 已知坑

- **一帧 ≈16ms 人眼仍看不见**:帧屏障只保证"这一步真的发生过",要被看见的节拍必须用
  `present:waitTime` 授权时长——别指望屏障替编排者决定停留多久。
- 全屏插画下 `subtitleEmote` 气泡被 cutsceneOverlay 盖住不可见——别往全屏图字幕上挂 emote。
- **自动推进的拍上开逐字要自己算长度**:`autoAdvance` 定时/配音到点就撤字幕,打字机不会
  为了打完而拖住这一拍——字太长、时间太短就是"没打完就没了"。30 字/秒是基准,
  玩家还能把倍率调到 0.4×。这也是字幕缺省不逐字的原因之一。
- **居中字幕逐字时次行会随自身变宽微移**:整块落位按**整串**算好不漂,但 Pixi `align:center`
  是按当前最宽行居中的,第二行打字期间会左右挪一点。单行字幕无此现象。
- **「说话人：正文」那种字幕走 HTMLText**,逐字是逐帧重建 HTML(Pixi 的 HTMLText 每次改文本
  都要重新栅格化一张 SVG)。短句无碍,长段落别在这类字幕上开逐字。
- 分层视差的前景句柄要管完整生命周期:每个基帧要么 show 要么 hideImg,结尾也要 hide,否则残留到后帧。

## 怎么验证

改完跑 validate-data + 素材审计 + 过场往返测试;真跑用 [runtime-command-channel](../recipes/runtime-command-channel.md)
(触发 → playerTap 连点 → 查 console);带字幕过场无头会悬死,见 [headless-visual-verification](../recipes/headless-visual-verification.md)。

**任何过场按 `Esc` 整段跳过**(`GameStateController.handleEscape` → `CutsceneManager.skip()`)。
验证长过场别干等——走命令通道跳到过场后状态断言;**computer-use 的 key 事件未必送达游戏 canvas**
(实测按 Esc 不生效),这也是"测试走命令通道、不点像素"的又一佐证。
