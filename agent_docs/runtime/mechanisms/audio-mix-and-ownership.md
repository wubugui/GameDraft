---
id: audio-mix-and-ownership
title: 混音状态与声音归属(总音量 / 玩家偏好 / 演出闪避 / owner)
domain: runtime
type: mechanism
summary: AudioManager 是唯一出口与唯一混音状态持有者;玩家偏好落 settings 不进存档,演出压低走闪避层不许动偏好;混音是持续状态(活实例逐个跟随),声音按 owner 归属、owner 退役一次收干净
status: active
authority:
  - src/systems/AudioManager.ts#pushAudioDuck
  - src/systems/AudioManager.ts#releaseAudioOwner
  - src/systems/AudioManager.ts#prepareSfx
  - src/systems/AudioManager.ts#applyMasterToOutput
  - src/audio/audioMixPreferences.ts
  - src/core/ActionRegistry.ts#registerActionHandlers
triggers:
  paths:
    - "src/systems/AudioManager.ts"
    - "src/audio/audioMixPreferences.ts"
    - "src/core/ActionRegistry.ts"
  topics: [混音, 总音量, 通道音量, 音量设置, 闪避, duck, duckAudio, restoreAudio, 压音, mixOwner, 声音归属, 预备音频, prepareSfx, 同名停错]
  tasks: [演出里临时压低背景音, 加新的播放路径, 改音量设置页, 让一段演出的声音能被整段收掉]
verified_by:
  - src/systems/AudioManagerMasterVolume.test.ts
  - src/systems/AudioManagerDuck.test.ts
  - src/systems/AudioManagerSiteVolume.test.ts
last_governed: 2026-09-23
---

## 是什么(一句话)

全游戏的声音只有一个出口、一份混音状态,都在 `AudioManager`;谁起的声音归谁(owner),
演出临时压低是叠在玩家偏好之上的**临时层**,不是改设置。

## 权威源(读代码从哪进)

`AudioManager`:`applyMasterToOutput`(总音量)、`hydrateMixPreferences`(偏好读写)、
`pushAudioDuck / releaseAudioDuck / getAudioDuck`(闪避层)、`releaseAudioOwner`(owner 退役)、
`prepareSfx`(演出音频预备);纯数据解析在 `audioMixPreferences.ts`;动作侧的会话归属在
`ActionRegistry.registerActionHandlers` 的 `ownSessionAudio` / `performanceSfx`。

## 硬契约(违反即 bug)

- **一个出口**:Howler 自己的声音、空间音总线、解锁提示音都汇到 Howler 主增益;**总音量只乘在这里**。
  新播放路径必须接到这个出口,且**不许自己再乘一遍总音量**(双乘,且与编辑器试听口径对不上)。
- **玩家偏好(总音量 + 四通道)落 `settings/audio.json`,不进存档**(2026-09-23):读老档不许改设置页。
  出厂值是跨语言镜像(编辑器试听表),漂了不报错只会让试听说谎——测试钉着。
- **演出压低一律走闪避层,不许调通道音量**:通道音量是玩家偏好,演出写它 = 替玩家改了设置页的档位。
  闪避是 post-fader:`clamp01(本处×通道) × duck`,满幅声也得被压住;多层取最狠一档,每层各自渐变互不覆盖。
- **释放按实例,不按名字**:`pushAudioDuck` 返回的句柄只抬自己那层。按名字抬会让旧会话抬掉新会话的同名层。
- **普通批的闪避层有墙钟到期兜底(缺省 20s,到期 warn);会话托管层没有**,由会话精确释放。切场景 / 拆除全抬。
- **混音是持续状态,不是起播快照**:所有活实例(含在途解码)登记在案,闪避 / 偏好一变逐个重算。
  短音只在起播时取一次音量的写法,会让"压低期间起的雷"在抬起后仍是闷的。
- **owner 豁免只豁免自己的层**:会话里起的声音不被本会话的闪避压,仍服从别人的层。
  空间音的闪避作用在 owner 子总线输出端(直达 + 回音尾之后),在飞的回音一起压。
- **owner 退役一次收干净,且不可复活**:`releaseAudioOwner` 停掉该 owner 的实例、取消在途预备、拆子总线;
  之后该 owner 的任何播放 / 压层 / 预备一律拒绝——迟到的解码回调不能让声音诈尸。
  会话以**实例身份**当 owner(不是名字),同名顶替的新会话不会被旧会话收尾误停。
- **预备不占时间线**:开会话时静态扫整棵动作树(所有分支,不求值条件、不耗随机数)预解码 sfx 与空间路由,
  **绝不** await 在动作时间线上、不播放、不推游戏时钟。冷首雷迟响就是靠它治的。
- **配置区不回落**:`sfx` / `voice` 各查各的,查不到当场 warn 返回 null。新增配置区要同步装配白名单,
  否则 JSON 里有、运行时空、零报错。
- **停只停实例**:按 id 停要同时扫 Howler 实例与空间音实例两张表;绝不 `unload` 共享 Howl;
  手动停要摘掉 soundId 上的监听(否则死闭包挂在长寿共享 Howl 上)。声像只许逐实例写。

## 已知坑

- **动作层 volume 解析把 `null` / `''` 读成 0(静音)**:`playBgm/playSfx/playSceneAmbient` 用 `Number(raw)`;
  配音通道专门防了这条,动作层没有。
- **会话账本里的 `duckNames` / `sfxIds` 两栏生产代码零写入**(只有测试调 `ledgerTakeDuck/ledgerTakeSfx`),
  宿主注入的 `releaseDuck` / `stopSfx` 永远跑不到;会话音频归还**实际**只走 cleanup 里的 `releaseAudioOwner`。
  改那两段没有任何效果;即便被调,它们不带 owner,也找不到会话压的层。
- 不带 owner 的 `stopSfxById(id)` 停掉该 id 的**全部**实例(含别处起的)。
- **环境层按 id 单一所有者、无引用计数**:物件检视会话加一层与场景基线同 id 的环境音,关会话时连场景那层一起撤。
- 两个 bgm/ambient 条目指向同一文件时共用一个 Howl,一个的 `stop()` 会掐掉另一个。
- 过场里普通批 `duckAudio` 后被 Esc 跳过,后续 `restoreAudio` 不执行,世界闷到 20s 兜底才抬。
- 闪避渐变 / 到期、床的淡入淡出都是墙钟 `setTimeout`:世界暂停不冻结它们(音频不冻是刻意的,见
  [world-pause-and-game-clock](world-pause-and-game-clock.md))。
- 通道 `setVolume` 不挡 NaN,总音量挡(NaN 进增益节点 = 全哑不报错)。

## 怎么验证

`npx vitest run src/systems/AudioManagerMasterVolume.test.ts src/systems/AudioManagerDuck.test.ts src/systems/AudioManagerSiteVolume.test.ts`。
真机:演出中途 `audioManager.getAudioDuck('bgm')` < 1、会话结束后回 1,设置页数值不变;
出声证据看 `getRecentOutputPeakDb()`(只量空间音总线)。
相关:本处音量口径见 [per-site-audio-volume](per-site-audio-volume.md),会话见
[detached-performance-session](detached-performance-session.md)。
