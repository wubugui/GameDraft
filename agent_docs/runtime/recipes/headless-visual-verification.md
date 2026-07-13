---
id: headless-visual-verification
title: 无头画面/逻辑全自动验证
domain: runtime
type: recipe
summary: 隐藏页 rAF 完全暂停——dev模式+命令通道+rAF pump/forceFrame 出帧截图;含 MessageChannel 让步与合成钟追平配方
status: active
authority:
  - src/core/Game.ts
  - vite.config.ts
triggers:
  tasks: [画面验证, 渲染迭代验证, 过场验证, 无头测试]
  topics: [headless, rAF, 截图, 节流]
last_governed: 2026-07-13
---

**实测环境与日期**:2026-07-06 实测 rAF 计数为 0(完全暂停非节流);2026-07-07 位面/背尸全环真机验证增补四条;2026-07-08 立绘验证沿用;2026-07-13 无头驱动主线①听书全拍跑通,增补"读 src 炸页/warp 守卫/驱动口"三组。

## 为什么需要

预览页是隐藏标签:`setTimeout` 节流到 ~1Hz,**rAF 完全暂停**——游戏主循环冻结,截图是旧帧、切场景卡淡入淡出、带字幕过场必卡首字幕步(与音频/数据无关)。必须主动出帧。

## 配方

1. 进 dev 模式:URL 加 `?mode=dev`(跳过首启手势门)。
2. 驱动用 [runtime-command-channel](runtime-command-channel.md)(debugSwitchScene / debugSetPlayerPosition)。
3. 出帧两条路:
   - **forceFrame**:`renderer.app.ticker.update()`×n,同步跑 tick+render(临时调试桩,验完删)。
   - **rAF pump(零改码)**:eval 里 patch `window.requestAnimationFrame` 只入队+暴露 `__pumpRaf(n)` 按需排空;`window.__gameDestroy()` 杀旧实例;`import('/src/core/Game.ts')` 页内重启(Vite 可直接 import,补丁对新实例全生效);后台驱动循环 pump+注入事件,把 Game 实例存 window 直接读私有字段断言。
4. 需要真实墙钟的段(淡入淡出按 `performance.now()` 计时)靠 eval 之间的真实间隔;截图用 preview 截图(CDP 合成)。

## 坑(每条都踩过)

- 不要用连续 MessageChannel/setTimeout 驱动 rAF——Pixi ticker 挂上就饿死事件循环整页卡死;只能"按需排空队列"。
- 链式 setTimeout 超 5 个后被节流到 1/分钟——让步一律用 **MessageChannel**(不被节流,但不流逝真实时间)。
- **合成 rAF 钟每次 pump 前须追平真实钟**(`__rafT=Math.max(__rafT,performance.now())`)——混合计时的消费者(长按 UI 等)否则得到恒负 dt。
- **JS canvas readback 在按需渲染下返回全黑**(backbuffer 已清),亮度分析用截图。
- `switchScene` 经 sceneSwitchTail 串行,被冻 rAF 卡住的旧切换永久阻塞后续——reload 救。
- `debugSwitchScene` 到已加载过的场景用内存缓存不重取磁盘 JSON——改了 scene JSON 要整页 reload;改 public/ 下 JSON 触发 vite 整页刷新,window 上的 patch/钩子全丢,长流程结果写 localStorage 中继,每个 eval 先 guard patch 还在。
- 驱动 UI 的私有口:图对话选项走 playerChoose;chooseAction 的 ActionChoiceUI 要直调 `game['actionChoiceUI']['close'](0)`;长按=window 派发 KeyboardEvent。
- Esc 连打跳过场会误开暂停菜单;进场自动事件对话会占用会话,新 start 被拒,先 debugAdvanceDialogue 冲掉。
- **【重坑】驱动会话期间 agent 读 src/ 会炸掉在跑的游戏页**(2026-07-13 实测):macOS fsevents 连 Read/grep 读 src/*.ts(元数据变化)都会让 vite 对非热更模块整页 reload,rAF 补丁/游戏实例/驱动钩子全丢(vite 日志 `page reload src/core/Game.ts` 与读文件时刻精确吻合)。要看代码用 `git show HEAD:src/...`(.git 对象库 chokidar 不看);注意工作区未提交改动与 HEAD 有偏差。
- **narrativeWarp 必须配 `?mode=dev`**:main.ts 只在 isDevMode 才消费 warp,单独带只会跳过开始门、warp 被忽略。warp 的 `set[]` 直设 scenario 图状态经 `canRemoteEnterState` 守卫——只许 entryState/exitStates,中段直设被拒(recentIssues 记 error `scenario.boundary.stateCommand` + console.warn,**无红条**);中段要靠真信号推。flow 图(非 scenario)不受此限。

## 页内驱动工具箱(2026-07-13 实测,比命令通道抗隐藏节流)

- 一发 eval 连做:patch rAF(入队+`__pumpRaf(n)` 排空+合成钟追平)→ `setInterval(pump,800)` 低频自动泵(隐藏页节流至~1Hz,恰好不饿死事件循环)→ `__gameDestroy()` → `import('/src/core/Game.ts')` → `new Game().start({devMode:true, narrativeWarp:'…'})`。
- 驱动口:走路易 navStuck(1200 帧弃疗)→ **直接 `player.x/y=` 瞬移**;NPC 有 patrol 会溜达,**用活体 npc.x/y 不用 def.x/y**;E 键=`inputManager.injectKeyJustPressed('KeyE')`;对话推进=eventBus `dialogue:advance`;**选项 eventBus `dialogue:choiceSelected` 无效,直调 `graphDialogueManager.chooseOption(i)`**;cutscene 字幕等点击=canvas dispatch PointerEvent;inspect 面板卡 UIOverlay 态用 Escape keydown 关。
- `choicePhase` 是对象 `{nodeId, stage:'options'}`,不是字符串。

## 判读技巧

阴影/光照对错:darkness=1.0+关 AO+低 elevation 最不容易看漏;A/B 开关确认脚下暗块是阴影非 sprite。实战案例:这套抓出 deferred 阴影脚点锚不同源的 bug(见 [entity-lighting](../mechanisms/entity-lighting.md))。
