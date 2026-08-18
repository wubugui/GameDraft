---
target: headless-visual-verification
date: 2026-08-18
session: 过场台词逐字显示（打字机）落地后的真机验证
---

# 隐藏页验"动画中间态"：ticker 手动喂帧 + 把注入的 provider 冻住

- **现象**：Browser pane 的页恒 `visibilityState:"hidden"`，rAF 实测 ~6Hz（3 次/500ms）。
  验"过场台词逐字打出来"这种**动画中间态**时，`setInterval`/链式 rAF 采样器一条都采不到
  （采样器自己也被节流），截图直接报 "not compositing frames"。
- **有用的两招（都不改一行代码）**：
  ① **ticker 手动喂帧**：`window.__game.renderer.app.ticker.update(t)`，`t` 自己按
  `performance.now() + i*100` 递增——同步跑完 tick+render，逐帧读私有字段就能看到
  `0/26 → 3/26 → 5/26 → 8/26` 这种真实推进。比配方里说的"临时调试桩 forceFrame"省事：
  dev 下 `__game` 已暴露，不用改码也不用重启实例。
  ② **把注入的 provider 冻住**：想抓"正在动"的那一瞬，就临时把注入口换成常量桩
  （本次是 `cr.textSettings = { isTypewriterEnabled:()=>true, getTypewriterSpeedScale:()=>0.02 }`），
  动画慢到近乎静止，`await sleep` 的抖动就吃不掉中间态了。走的仍是生产注入口、
  代码路径一字未改；`finally` 里换回原对象。**别改玩家偏好本体**（`setTypewriterSpeedScale`
  会落 localStorage，会把人家的设置改掉；真改了收尾必须还原并核对 localStorage）。
- **踩到的坑**：`devPlayCutscene` 在隐藏页反复调会把过场会话搅乱（残留 resolver /
  停在 `present:waitClick`），表现是"点了没反应/自己往前跑"。要干净起一段就整页
  `?mode=dev&play_cutscene=<id>` reload，别连着 replay。
- **另一条**：过场对白/字幕的点击推进走**双 rAF 武装**，隐藏页 ~350ms 才armed。
  没等 armed 就 dispatch pointerdown＝这一下**静默丢掉**，很容易误判成"契约不生效"。
  断言前先轮询 `cutsceneManager.dialogueResolve` 变成 function 再点。
- **待办**：把 ①② 两招并进 headless-visual-verification 配方的"页内驱动工具箱"节。
