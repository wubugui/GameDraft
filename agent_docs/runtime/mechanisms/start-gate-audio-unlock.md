---
id: start-gate-audio-unlock
title: 首启手势门 + 音频解锁快路径
domain: runtime
type: mechanism
summary: 「点击开始」遮罩给页面 sticky 激活;AudioManager init 时按 hasBeenActive 直接解锁——救开场首句配音音画同步
status: active
authority:
  - src/main.ts#showStartGateThenStart
  - src/systems/AudioManager.ts#installAudioGestureGate
triggers:
  paths: ["src/main.ts", "src/systems/AudioManager.ts"]
  topics: [autoplay, 音频解锁, 手势门, 开场配音]
last_governed: 2026-08-05
---

## 是什么(一句话)

浏览器 autoplay 策略要求用户手势后才许出声;首启全屏「点击开始」遮罩让 `game.start()` 前页面
已有 sticky 激活,AudioManager 初始化时直接解锁,开场自动播的配音字幕不再哑掉/错位。

## 权威源(读代码从哪进)

`src/main.ts#showStartGateThenStart`(遮罩)、`AudioManager.installAudioGestureGate`
(读 `navigator.userActivation.hasBeenActive`)。

## 硬契约(违反即 bug)

- **解锁必须靠 sticky `hasBeenActive` 在 init 时自查**,不能依赖 AudioManager 自己的手势监听
  ——遮罩点击发生在 AudioManager 存在之前,监听器抓不到那一下。
- 老 WebView 无 `navigator.userActivation` 时回退走原手势门(不比现状差),别把回退删掉。
- **dev 与各预览参数跳过遮罩**——阻塞编辑器预览与命令通道自动化即回归。

## 已知坑

- 无头下带字幕过场必悬死在首个字幕步:隐藏页**完全暂停 rAF**,而字幕推进的武装依赖 rAF,
  **与音频是否解锁、与数据无关**。验证过场要么真前台标签,要么按
  [headless-visual-verification](../recipes/headless-visual-verification.md) 的 rAF pump 配方。

## 怎么验证

真前台标签冷启动点「开始」,开场首句配音应与字幕同步出声;带 `?mode=dev` 确认无遮罩直进。
