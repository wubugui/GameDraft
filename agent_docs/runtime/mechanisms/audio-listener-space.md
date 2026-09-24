---
id: audio-listener-space
title: 听者与音频坐标(单一听者 / 两级精度 / 相机视距 / 透视重整)
domain: runtime
type: mechanism
summary: 全游戏只有一个听者,绑定走一条优先级链;所有发声点经唯一的音频解算器落到 M-world(field/planar 自报级别);相机听者视距用 zoom 比值不用可视宽度且不叠耳高;配了透视线的场景音频坐标要透视重整,因此与光照/粒子那份 M-world 不重合,两边不许互借坐标
status: active
authority:
  - src/utils/audioSpace.ts
  - src/utils/sceneSpace.ts
  - src/core/Game.ts#resolveAudioListener
  - src/core/Game.ts#effectiveListenerBinding
  - src/core/Game.ts#buildAudioSpaceResolver
triggers:
  paths:
    - "src/utils/audioSpace.ts"
    - "src/utils/sceneSpace.ts"
  topics: [听者, listener, acousticListener, listenerBinding, 空间化, 声像, pan, 音频坐标, 透视重整, perspectiveScale, 视距, backAtBaseZoomWu, 耳高, playSfxAt]
  tasks: [改听者, 加有位置的声源, 让某个声音跟着东西走, 排查声音远近或左右不对]
verified_by:
  - src/utils/audioSpace.test.ts
  - src/dev/runtimeAcousticsSync.test.ts
last_governed: 2026-09-23
---

## 是什么(一句话)

有位置的声音(脚步、雷、试听声源、场景回音)共用**一个听者**;场景坐标经**唯一**的音频解算器换到
M-world(wu),距离、声像、回音全在那里算。

## 权威源(读代码从哪进)

`utils/audioSpace.ts`(解算器、相机听者、透视重整;本层不写坐标数学,换算只在 `sceneSpace.ts`);
`Game.effectiveListenerBinding`(绑定链)→ `resolveAudioListener`(解出耳点)→ `updateAcousticListener`(每帧喂总线);
`Game.buildAudioSpaceResolver`(场景几何 + 透视标定)。

## 硬契约(违反即 bug)

1. **听者只有一个,绑定只有一条链**:运行时覆盖 > 场景 JSON `acousticListener` > 活动声学空间的
   `listenerBinding`(有空间没写 = 跟玩家)> `footstep_sets.json.listener` > 相机。
   `player / entity` 取 **contactX/Y**(不是 x/y)落到行走面抬耳高;目标不在场回落玩家并报 `targetMissing`,**不许静默变哑**。
2. **所有空间量在 M-world 算,两级精度必须自报**:`field`(行走面真深度)/ `planar`(平面近似,纵深符号不能丢)。
   **只要照明载荷在就是 field,不看 `sceneLighting.active`**——按 active 门控会把没配 lighting 块的回音场景全打回 planar
   (实测听者 z 差 800 wu)。
3. **`wuPerQUnit ≤ 1` 一律当可疑值拒绝、退 planar**:它是光照系统没载荷时的 `?? 1` 回落,真值逐场景上百;
   拿 1 算坐标缩在 q 尺度,整场声音不是全满幅就是全静音,不报错。
4. **相机听者就是镜头:不叠耳高;视距 = 基准视距 × (基准 zoom / 当前 zoom) ÷ f(画面中心)**。
   **不许用可视宽度**(它随窗口大小变,拉大窗口全场声音变远)。基准视距逐场景可调、推不出来(正交相机没有位置,
   是作者约定);它同时是透视重整的基准深度,**两处必须同源**。这段数学只许在 `cameraListener` 一处。
5. **配了 `perspectiveScale` 的场景,音频坐标必须透视重整**:行走面是正交斜平面、纵深不含透视,画面上人缩小数倍
   声音却不变甚至方向反。重整只作用于**由场景坐标解出来的点**(听者 / 实体 / 热点),离地高度在重整之后加;
   声学空间的反射面是作者数据,不重整。于是**音频的世界空间 ≠ 光照 / 粒子的 M-world**(只在这几个场景),
   两边不许互借坐标;作者面画听者用状态回传的 `worldOrtho`(未重整),算距离用 `world/ear`。
6. **声像在听者系里算**(`right = up × forward`,反了整个声像左右颠倒且不报错),相机听者与实体听者同一条式子,无特例分支。
7. **听者更新排在 `camera.update` 之后、脚步之前**:拿本帧定稿的相机与实体;排前面 = 平移镜头时声像拖尾。
8. **每个声源是独立 voice**:第 N 声的音量 / 声像影响不到第 N−1 声。
9. **进场要强制重算两次**:换场景时 `setAudioApplier` 那次强制重算跑在照明载荷落地**之前**(拿的是上一个场景的场,
   `field` 照样自报);载荷的 `characterLighting.onReady` 里必须再强制一次,否则要等玩家走出重算阈值才对。
   解算器也因此**每帧现建、不按场景缓存**(`Game.buildAudioSpaceResolver` 注释)。

## 已知坑

- **有两类发声点绕过音频解算器,直接用粒子的 M-world**:威胁存在声(`healthThreat.presenceSfx`)与粒子事件音 / 循环音。
  透视场景里它们与听者不在同一空间;粒子空间不存在时这类声音直接不响。落雷是明确改走解算器的那个(保留采样表面偏移)。
  新加有位置的声源一律走解算器。
- 空间绑定的 `fixed` 听者直接取作者的 M-world 点、不经重整,而声源是重整过的——透视场景里两者不在同一空间(推断,无测试)。
- "运行时覆盖"只有调试命令入口(`__gameDevAPI.setAudioListener`),**没有同名动作**;覆盖不随换场景 / 读档清除、不进存档。
- 音频未解锁时总线建不出来,绑定链看不到声学空间,会落到脚步配置 / 相机层,解锁后才切过去。
- 透视场景的相机视距按最远处重算:远端 f 很小时视距成倍放大,会吃掉声学空间 `direct.maxDistanceM` 的大半,
  连脚下的声音都可能判成听不见。
- 画布舞台上的粒子 `playSfxAt` 是刻意的 no-op。

## 怎么验证

`npx vitest run src/utils/audioSpace.test.ts`(planar 纵深符号、相机听者右 = +X、耳点到画面中心距离 = 视距)。
真机看 `window.__gameDevAPI.getFootstepDebugState().space`(绑定、来源层、`field/planar`、`targetMissing`)
或 F2「声学」页听者行;声学工作台左栏「游戏 · 坐标」行比对同一画面点两边换算(<5 wu 绿)。
上层:脚步见 [footstep-and-spatial-audio](footstep-and-spatial-audio.md),回音见 [scene-acoustics](scene-acoustics.md)。
