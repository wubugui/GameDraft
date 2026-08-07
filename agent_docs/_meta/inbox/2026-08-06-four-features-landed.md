---
target: runtime-norms
date: 2026-08-06
session: 四条需求实装（色板/气泡台词本/主角待机/叙事断点）
---

现象: 本次落地四套新机制，库内暂无对应卡；同时发现并修掉三个**既有**缺陷，都属于"配了没反应"这一族，值得单独入卡。
证据:
 ① `Game.loadGameConfig` 是**白名单拷贝**不是整包赋值——`playerAvatar.portraitSlug` / `playerActs` / `emoteBubbleScale` 三个键从来没被拷进来，JSON 里配了运行时永远读到 undefined（消费端 Game.ts:919/1208、applyPlayerAvatarFromAction 都在读）。新加 game_config 键必须在此登记一行。
 ② `Player.animationOwnedByAction` 是 PlayerActionSystem 与新待机系统**共用的一个裸布尔**，而 `syncPostureAnimation()` 每帧在"当前无姿态"时无条件写 false——共用会让待机动画刚接管就被下一行 `Player.update` 顶回 idle（一帧都放不出来）。已拆成 `animationOwnedByAction` / `animationOwnedByIdle` 两个独立位，`update` 只认合成结果。
 ③ 纯表现系统不能消耗 `runtimeRandom`：它的 state 进存档、`randomBranch` 也从同一条取值，让表现层抽签会使"玩家有没有从 NPC 旁边走过"改变后续 randomBranch 结果。已另开 `presentationRandom`。
建议: 治理时按四条新机制建卡（语义色板 `[c:…]` 与 Pixi tagged text 的边界、头顶闲聊台词本三来源优先级、主角待机的动画所有权纪律、叙事断点闸的代际复核），并把 ①②③ 收进 runtime 机制卡——三条都是"数据/配置写了但运行时收不到"的同型坑。

补记（三轮 subagent 审查后）:
 ④ **叙事断点的放行钩子必须是集合不是单槽**：引擎允许嵌套排空（onEnter 里 `waitMs` 期间来的信号走 nestedDrain），而按用户拍板不冻 setTimeout——于是断住期间第二条链也会撞上断点。单槽会把前一条 resolver 覆盖丢掉：那条 promise 永不 resolve → 队列那格永不落定 → `isIdle()` 永假 → 存不了档；若那条信号是动作批 await 的，玩家直接卡死。
 ⑤ **调试器与游戏是 1:1**：hub 的 `_game` 是单槽，第二个游戏页签连上后 `paused` 仍从旧页签上报、`continue` 却发给新页签，旧页签的 `onclose` 自救永远不触发 → 冻死到关标签。现在新 hello 会踢掉旧客户端（踢掉即触发旧页签自救）。
 ⑥ **冻结只盖住 tick 是不够的**：`endFrame()` 是 tick 的最后一句，跳过 tick 会让 `keyJustPressed` 一直攒着，放行后同一帧全部生效；Pixi 的 DOM 事件与 tick 无关，UI 面板照样能点。两处都要单独处理（stage.eventMode 改回前要**记住原值**，缺省是 passive 不是 static）。
 ⑦ **挂了 `tagStyles` 的 Text，正文里字面写的 `<某个色板id>` 就是真 tag**——Pixi 会把它整段吞掉、其后所有字被无声染色且永不闭合（fuzz 实测 1778 处）。所以色板必须**按串开关**（`needsTagStyles`：有 `[c:…]` 且无裸 `<` 才挂），而不是给每个 Text 无条件挂上。量高的样式必须与渲染端同口径，否则量歪、整列错位。
 ⑧ **编辑器的"坏元素只读透传"不能靠 `original is not None` 判**：JSON 的 `null` 会被当成正常行，读表时去取不存在的控件 → KeyError → 主窗兜底把整页记进 skipped，**该页所有编辑静默不落盘**。要挂显式 `raw` 标记。
 ⑨ **保值（keep_raw）必须与"用户动没动过"配对判断**：只按"盘上是坏值"就无条件保值，会把用户刚改的值又盖回去且不标脏——改动凭空消失，且那个字段从编辑器里永远修不好。要拿载入时的控件快照比。
