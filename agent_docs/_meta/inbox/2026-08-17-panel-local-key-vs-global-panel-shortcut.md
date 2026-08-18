---
target: ui-component-layer
date: 2026-08-17
session: K3 事件日志（对话记录升级成时间线 + 可点跳转）
---

# 面板内部想绑的键，若已被 `registerPanel` 注册成某面板的全局快捷键，就绑不上

- **现象**：`DialogueLogUI` 给「全部 / 只看事件」过滤条绑了 `Tab`，面板开着时按 `Tab`
  **完全没反应**——面板自己的 `window keydown` 处理器压根没收到那一下。同一处理器对
  `ArrowUp` / `PageUp` 一切正常（实测焦点从 `row:6` 走到 `row:2`），所以不是监听没挂上。
- **背景**：`Tab` 是任务面板的注册快捷键（`registerPanel('quest', …, 'Tab')`）。
  `GameStateController` 经 `InputManager.subscribeKeyDown` 先拿到键，命中快捷键表就
  `preventDefault()` + `togglePanel` + `return`。代码里没有 `stopPropagation`，
  按理不该拦住后续 window 监听——**但实测就是拦住了**，根因没查到底（怀疑在
  `InputManager` 的分发或浏览器对 `Tab` 的特殊处理，未证实）。
- **影响**：任何面板想在自己内部复用一个"此刻全局用不上"的键（面板开着时
  `togglePanel` 因 `canOpen` 为假而空转，看起来像"这个键闲着"），都可能踩同一脚，
  而且**表现是纯静默**：没有报错、没有日志，只是那个键不工作。
- **本次处理**：不绑键。过滤条按全站惯例进焦点环（`UIFocus` 分组：行一组、过滤条一组，
  过滤条的焦点矩形 y 取负数使其位于列表内容原点之上），键盘/手柄从列表顶端按「上」到达、
  回车激活，鼠标直接点。实测通过。
- **待办**：① 查清 `Tab` 究竟被谁吃掉（是 `InputManager` 分发顺序还是浏览器默认行为），
  ② ui-component-layer 卡里补一条「面板内部键位不得与 `registerPanel` 的快捷键表重名，
  切页签/切档一律走焦点导航」，把这条从"踩过才知道"变成"动手前就知道"。
