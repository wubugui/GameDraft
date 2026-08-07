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
last_governed: 2026-08-05
---

**实测环境与日期**:2026-07-06 实测 rAF 计数为 0(完全暂停非节流);2026-07-07 位面/背尸全环增补四条;2026-07-13 主线①听书全拍跑通(读 src 炸页/warp 守卫/驱动口);2026-07-18 Esc 弹 Dev Mode 面板;2026-07-30 public/ JSON 不触发刷新;2026-07-31 stepFixedTicks 时钟漂移;2026-08-03 git 子命令同样炸页 + 多实例叠画布。

## 为什么需要

预览页是隐藏标签:`setTimeout` 节流到 ~1Hz,**rAF 完全暂停**——主循环冻结,截图是旧帧、
切场景卡淡入淡出、带字幕过场必卡首字幕步(与音频/数据无关)。必须主动出帧。

## 配方

1. 进 dev 模式:URL 加 `?mode=dev`(跳过首启手势门)。
2. 驱动走 [runtime-command-channel](runtime-command-channel.md)。
3. 出帧两条路:
   - **forceFrame**:`renderer.app.ticker.update()`×n,同步跑 tick+render(临时调试桩,验完删)。
   - **rAF pump(零改码)**:eval 里 patch `window.requestAnimationFrame` 只入队 + 暴露
     `__pumpRaf(n)` 按需排空;`window.__gameDestroy()` 杀旧实例;`import('/src/core/Game.ts')`
     页内重启(补丁对新实例全生效);后台循环 pump + 注入事件,断言直读 `window.__game` 私有字段。
4. 需要真实墙钟的段(淡入淡出按 `performance.now()` 计时)靠 eval 之间的真实间隔;
   截图用 preview 截图(CDP 合成)。

## 坑(每条都踩过)

- 连续 MessageChannel/setTimeout 驱动 rAF → Pixi ticker 饿死事件循环整页卡死;只能按需排空队列。
- 链式 setTimeout 超 5 个被节流到 1/分钟——让步一律用 **MessageChannel**(不被节流,但不流逝真实时间)。
- 混合计时的消费者(长按 UI 等)拿到恒负 dt → **合成 rAF 钟每次 pump 前须追平真实钟**
  (`__rafT=Math.max(__rafT,performance.now())`)。
- JS canvas readback 全黑 → 按需渲染下 backbuffer 已清,亮度分析只能用截图。
- 旧的 `switchScene` 被冻 rAF 卡住 → 经 sceneSwitchTail 串行,后续切换永久阻塞,只能 reload 救。
- 改了 scene JSON 但行为照旧 → `debugSwitchScene` 到已加载场景吃内存缓存,要整页 reload。
- **改 `public/` 下 JSON 页面不刷新、会话继续吃旧数据**(2026-07-30):热更只覆盖 `src/`
  与已 import 的模块,静态 JSON 须手动 `location.reload()`。
- **驱动会话期间访问仓库文件会炸掉在跑的游戏页**(2026-07-13 / 2026-08-03):macOS fsevents
  让 vite 对非热更模块整页 reload,rAF 补丁/游戏实例/驱动钩子全丢;`Read`/`grep` 读 `src` 会,
  **任何 git 子命令(`diff`/`show`/`status`)stat 工作区同样会**(旧配方"用 git show 读代码"已作废)。
  对策:开工前一次性读完代码,会话期零仓库文件访问;长流程结果写 localStorage 中继,
  每个 eval 先 guard patch 还在。
- 截图里叠了三张画布、旧过场还在播 → `window.__gameDestroy()` **只销毁 main.ts 持有的实例**,
  agent 自建的 `new Game()` 不受管;自建实例必须自己记账并逐个 destroy。
- **含 voice 字幕的过场在隐藏页永久悬死**:`showSubtitle` 的推进 resolver 经"双 rAF 后武装"
  (防同帧点击串步),hidden 页 rAF=0 → 永不武装 → 点击、`skip()`(只落**已武装**的 resolver)、
  配音 onEnd(hidden 页 AudioContext 恒 suspended)三条出路全灭。绕法:每步截一张图当帧泵,
  或素车 `?mode=dev` 绕过该过场。**被动等过场自然放完 = 断帧**,别这么等。
- **dev 模式按 Esc 跳过场会同帧弹出 Dev Mode 全屏面板**,盖住画面且不随 cutscene 结束关闭;
  它是 PIXI 内部 UI,`document.querySelector` 藏不掉。改直调 `cutsceneManager.skip()` 绕开键路径。
  (Esc 连打还会误开暂停菜单。)
- 新 `start` 被拒 → 进场自动事件对话占着会话,先 `debugAdvanceDialogue` 冲掉。
- **`stepFixedTicks(n, dt)` 不是时钟**(2026-07-31):推进的仿真时间与 n×dt 相差一个量级,
  计时类行为(氛围体、衰减)必须用真实等待 + `getMinigameDebugState()` 快照对照,不能拿它推时间。
- **narrativeWarp 必须配 `?mode=dev`**(单独带只跳开始门、warp 被忽略);warp 的 `set[]` 直设
  scenario 图状态经 `canRemoteEnterState` 守卫,只许 entryState/exitStates,中段直设被拒且
  **无红条**(只进 recentIssues + console.warn),中段要靠真信号推。flow 图不受此限。

## 页内驱动工具箱(比命令通道抗隐藏节流)

- 一发 eval 连做:patch rAF(入队 + `__pumpRaf(n)` + 合成钟追平)→ `setInterval(pump,800)`
  低频自动泵(隐藏页节流至 ~1Hz,恰好不饿死事件循环)→ `__gameDestroy()` →
  `import('/src/core/Game.ts')` → `new Game().start({devMode:true, narrativeWarp:'…'})`。
- 驱动口:走路易 navStuck(1200 帧弃疗)→ **直接 `player.x/y=` 瞬移**;NPC 有 patrol 会溜达,
  **用活体 `npc.x/y` 不用 `def.x/y`**;E 键 = `inputManager.injectKeyJustPressed('KeyE')`;
  对话推进 = eventBus `dialogue:advance`;**选项走 eventBus 无效,直调 `graphDialogueManager.chooseOption(i)`**;
  cutscene 字幕等点击 = canvas dispatch PointerEvent;inspect 面板卡 UIOverlay 态用 Escape keydown 关;
  **chooseAction 面板命令通道与像素点击都够不着,直调 `game['actionChoiceUI']['close'](0)`**;
  **长按(压力条)= 往 window 派发 KeyboardEvent**,injectKey 那套只管瞬发。
- `choicePhase` 是对象 `{nodeId, stage:'options'}`,不是字符串。

## 判读技巧

阴影/光照对错:darkness=1.0 + 关 AO + 低 elevation 最不容易看漏;A/B 开关确认脚下暗块是阴影非 sprite。
实战案例见 [entity-lighting](../mechanisms/entity-lighting.md)。
