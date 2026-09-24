---
id: start-gate-audio-unlock
title: 播放门、音频解锁与保活(这是桌面游戏,不是网页)
domain: runtime
type: mechanism
summary: 浏览器"没点过不出声 / 没焦点就降级"一律禁止——宿主窗口带免手势与不后台降级开关、运行时关 autoSuspend 每秒保活;首启遮罩给 sticky 激活让 init 时直接解锁;没解锁时普通播放排队、有位置的声音直接丢
status: active
authority:
  - src/main.ts#showStartGateThenStart
  - src/systems/AudioManager.ts#installAudioGestureGate
  - src/systems/AudioManager.ts#installAudioKeepAlive
  - src/systems/AudioManager.ts#isAudioAutoUnlocked
  - tools/dev/game_preview.py
  - src-tauri/src/main.rs
triggers:
  paths: ["src/main.ts", "src/systems/AudioManager.ts", "tools/dev/game_preview.py", "src-tauri/src/main.rs"]
  topics: [autoplay, 音频解锁, 手势门, 开场配音, 保活, autoSuspend, 后台降级, 没声音, 点一下才有声, 预览窗]
  tasks: [排查游戏没声音, 新开一个内嵌游戏页的窗口, 改开场配音]
last_governed: 2026-09-23
---

## 是什么(一句话)

浏览器那套 autoplay / 后台节流 / 遮挡降级是给网页立的规矩,对这个桌面游戏一律禁止(制作人 2026-09-08 定死)。
两头一起做才是"打开就有声、一直有声":**宿主窗口**不给浏览器挂起的机会,**运行时**自己保活;
兜底还有一道播放门(没解锁时排队)与首启「点击开始」遮罩。

## 权威源(读代码从哪进)

- 宿主:开发期游戏页一律开在专用 Chromium 实例(`tools/dev/game_preview.py`:专用 profile、免手势音频、
  不后台降级三件、禁遮挡检测、禁缓存);发行客户端 `src-tauri/src/main.rs` 给 WebView2 同一套参数。
- 运行时:`AudioManager.installAudioKeepAlive`(保活)、`installAudioGestureGate`(播放门)、
  `isAudioAutoUnlocked`(免手势环境探针);首启遮罩 `main.ts#showStartGateThenStart`。

## 硬契约(违反即 bug)

- **任何宿主只要内嵌 / 打开游戏页,就必须带免手势播放与不后台降级**(Chromium 开关、WebView2 参数、
  QtWebEngine 的 `PlaybackRequiresUserGesture=False`)。开关只对新实例生效,共用日常 profile 会被吞。
  找不到 Chromium 才退系统浏览器,而且要明说。
- **`Howler.autoSuspend = false` + 每秒 / 可见性 / 焦点变化时检查并 resume**(只挂一个在飞)。
  Howler 到第一个 Howl 才建上下文:没有就先借 `Howler.volume()` 建出来。
- **上下文已 running 而播放门还关着 ⇒ 直接开门放队列,不放解锁提示音**——否则免手势窗口里
  `playSfx` 永远等一个不来的手势。
- **Howler 在首个 Howl 时若上下文采样率 ≠ 44100(本机 48k)就关掉重建上下文**(`_unlockAudio`):保活先逼它稳定一次
  (只逼一次——44.1k 设备上每调一次都再挂一组 document 监听);空间音总线见上下文关了 / 换了
  就重建重挂(两道都要,建在旧上下文上的总线全哑不报错)。
- **首启遮罩的解锁靠 sticky `hasBeenActive` 在 init 时自查**,不能靠 AudioManager 自己的手势监听
  ——遮罩点击发生在它存在之前。老 WebView 无 `userActivation` 时回退原手势门,别删。dev 与预览参数跳过遮罩。
- **没解锁时**:普通播放排队、解锁时补放;**有位置的声音直接丢弃不排队**;脚步不发声也不排队(解锁那一刻不补一串)。

## 已知坑

- **首次手势若有排队播放,会吞掉这次输入**(preventDefault + stopImmediatePropagation):第一下点击 / 按键可能不传给游戏。
- "解锁"有两个判据:`isAudioUnlocked()`(见过一次 running 即算)与内部播放门;脚步 / 试听用前者,`playSfxAt` 用后者。
- 空间音总线建不出来时 `playSfxAt` 退到普通排队路径:解锁那一刻**不带位置**补放,且退路不回调 `onStart`。
- 声学空间在总线建不出来时记账、解锁后每帧补挂(见 [scene-acoustics](scene-acoustics.md));不补就"进场景 → 点一下"后该场景永远没回音。
- vite HMR **不会**让已开的游戏页重跑 init:验这段改动要杀掉预览实例重开,看启动时刻变了才算新页。
- 无头下带字幕过场悬死在首个字幕步是隐藏页不跑 rAF,**与音频是否解锁无关**;见
  [headless-visual-verification](../recipes/headless-visual-verification.md)。

## 怎么验证

真前台冷启动:开场首句配音与字幕同步出声;`?mode=dev` 无遮罩直进。专用预览窗里 `isAudioAutoUnlocked()` 为真、
`getDebugOutputState().audioUnblocked` 为真,盖住窗口放一分钟声音不断。出声证据看 `getRecentOutputPeakDb()`,
"播放函数返回了"不算。
