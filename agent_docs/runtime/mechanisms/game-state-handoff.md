---
id: game-state-handoff
title: 游戏状态机与控制权交接(进出 Exploring)
domain: runtime
type: mechanism
summary: GameState 只有一个写入口、状态变了才同步通知唯一旁听席;Exploring 是唯一"玩家有控制权"的态,主循环一大批系统只挂在它的分支上——"只在探索态做 / 收尾硬写回探索态"是一族静默 bug 的共同形态
status: active
authority:
  - src/core/GameStateController.ts#applyCurrentState
  - src/core/GameStateController.ts#setStateChangeObserver
  - src/core/GameStateController.ts#requestPanelOpen
  - src/core/EventBridge.ts
  - src/entities/Player.ts#settleLocomotion
  - src/systems/InteractionSystem.ts#refreshVisibilityChannels
triggers:
  paths: ["src/core/GameStateController.ts", "src/core/EventBridge.ts", "src/core/Game.ts", "src/entities/Player.ts", "src/entities/Npc.ts"]
  topics: [GameState, 游戏状态机, Exploring, 探索态, 控制权交接, setState, 状态恢复, 状态观察者, ActionSequence, UIOverlay]
  tasks: [加只在探索态跑的系统, 改收尾回探索态, 排查非探索态下的残留表现]
last_governed: 2026-09-23
---

## 是什么(一句话)

`GameState` 状态机决定"此刻谁拥有控制权";**Exploring 是唯一玩家自由操作的态**,
主循环里移动、交互选目标、条件通道、zone 进出、伤害等一大批系统**只挂在它的分支上**。
进出 Exploring = 控制权交接,交接两侧各有一种静默出错的方式。

## 权威源(读代码从哪进)

`GameStateController`:唯一写入口 `applyCurrentState`(状态真变才动作)、单槽同步旁听席
`setStateChangeObserver`、非探索态挂起开面板 `requestPanelOpen`、死亡守卫 `setDepletionGuard`。
各收尾回探索态的监听集中在 `EventBridge.ts`;主循环按态分支见 `Game.tick`(注释里点名了
哪些系统**必须**无条件跑、哪些只在 Exploring 跑)。

## 硬契约(违反即 bug)

- **状态只经一个口写**,状态真变了才清本帧输入沿、才通知旁听席。绕开它直接改态 =
  推进对话的那下 Space 被下一帧探索态再吃一次(跳/踢/交互)。
- **旁听席只有一个槽,后设的顶替前面的**(不是事件总线):要"状态一变就当场收摊"的新需求,
  并进组装层那一个观察者里,**别再调一次 `setStateChangeObserver`**——那会静默顶掉脱手演出的收摊与收腿。
- **收尾"回探索态"必须是条件恢复**:只在状态仍是自己设的那个态时才写回 Exploring;
  链尾已被别人切走(开铺子 → UIOverlay、起过场、死亡)就归那一边自己收尾。
  死亡另有控制器级守卫兜底,但铺子/面板这类没有。
- 非探索态里要"替玩家开面板"走挂起通道(回到 Exploring 那一刻才开),直接 toggle 会被静默丢掉。

## 已知坑(同一族:"某件事只在 Exploring 里做")

新增或排查任何"只在探索态跑 / 收尾回探索态"的东西,按三问过一遍——每一问都有真机实例:

1. **回来时会不会盖掉别人的态?** 对话结束无条件写回 Exploring,而对话末尾 `openShop` 已切到
   UIOverlay → 铺子开着玩家却能在后面走,Esc 再叠一层暂停菜单(2026-09-23,`dialogue:end`
   与 `startDialogueGraph` 收尾两处;已改条件恢复,见 [dialogue-end-payload](dialogue-end-payload.md))。
2. **离开期间它的输入变了,谁补刷?** 条件通道只在探索态分支刷,而叙事状态多在动作链/对话/过场里推进
   → 条件刚变真的实体要等回探索态才现身(气泡已在喊,喊话的人两张说明卡读完才冒出来)。
   修法是在**触发源事件上补刷**(时刻变化、叙事状态变化两处),**不是**把整个系统挪出探索分支
   ——那会连带跑选目标/autoTrigger 等副作用。见 [entity-visibility-channels](entity-visibility-channels.md)。
3. **离开那一刻它该收什么?** 非探索态下 `update` 停了、位置冻住,但演出分支仍在推精灵动画
   → 走着踩进起动作链的 zone,人钉在原地走路动画照转,落脚帧照常命中,脚步声连响数秒。
   修法是旁听席里"离开 Exploring 收腿"(有脚本位移或动画归别人时不碰)。
   **NPC 巡逻中被切非探索态的同类问题未查。**

另外几处交接细节(都读代码核过):
- 普通动作批的探索锁是**逐条**加的,批里相邻两条之间会路过一次 Exploring——挂起的开面板请求就在这个边沿弹出来。
  背景演出要玩家全程能走,用脱手演出(见 [detached-performance-session](detached-performance-session.md))。
- 说明卡直接切 UIOverlay 态,不走面板栈;"关所有面板"只清面板不弹覆盖层返回栈,进死亡走的正是它
  (死亡流程见 [death-and-retry-checkpoint](death-and-retry-checkpoint.md))。

反方向同样成立:有些东西**必须**每帧无条件跑(待机归还动画所有权、闲聊撤气泡、身体动词复位姿态),
挂进探索分支就会在进对话那一刻丢掉收尾帧。

## 怎么验证

对话图末尾 `openShop`,结束后断言状态是 UIOverlay、方向键不移动玩家;动作链里推叙事状态,
断言条件实体在动作链结束**前**已出现;走路中踩进起动作链的 zone,断言动画回 idle、无脚步声。
真跑手法见 [runtime-command-channel](../recipes/runtime-command-channel.md)。
