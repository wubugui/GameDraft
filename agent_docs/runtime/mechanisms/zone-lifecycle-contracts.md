---
id: zone-lifecycle-contracts
title: zone 生命周期与上下文契约
domain: runtime
type: mechanism
summary: 触发载体两路(进出即触发 / 按键才触发);zone 上下文按参数线程化(executeBatchInZoneContext),禁回退全局栈;位面重注册仅 Exploring
status: active
authority:
  - src/systems/ZoneSystem.ts
  - src/systems/ZoneSystem.ts#executeBatchInZoneContext
triggers:
  paths: ["src/systems/ZoneSystem.ts", "src/core/ActionExecutor.ts"]
  topics: [zone, 触发器, onEnter, onExit, onInteract, 按 E, zone 上下文]
last_governed: 2026-09-03
---

## 是什么(一句话)

场景 zone 的触发与动作执行契约:zone 是各系统(气味/位面/规矩 offers)的声明式触发载体,
ZoneSystem 本体保持薄。

## 权威源(读代码从哪进)

`src/systems/ZoneSystem.ts`(enter/stay/exit 批执行);消费 zone 上下文的 action 看
`ActionRegistry.ts` 里的 `zctx` 参数。

## 硬契约(违反即 bug)

- **触发载体有两路:进出即触发,以及"按键才触发"**。后者(`onInteract` + 提示文案)
  **进区不发生任何事**,只在 HUD 出提示条、按交互键才跑动作批。优先级是
  **目标级(热点/NPC)先于区域级**,位面禁交互时一并禁。
- **zone 上下文按参数显式线程化**:各触发载体的动作批带 `{zoneId}` 执行,嵌套动作(runActions /
  chooseAction / randomBranch)逐层转发——跨 zone 并发不共享栈。**别回退成全局"当前 zone"栈**
  (历史缺陷:交错触发时 action 拿错 zone)。同一条线程化上下文也负责携带
  [对话图 owner 来源](dialogue-owner-origin.md)。
- **读档不跑 onExit**(见 [save-restore-contracts](save-restore-contracts.md))。
- **位面切换的 zone 重注册仅限 Exploring**:过场策略栈会吞 onExit 里的改存档动作;非 Exploring
  挂起、回边沿补刷(见 [plane-system](plane-system.md))。
- 新系统要"进出某区域就 X",优先声明式字段挂 ZoneDef + 自己订阅 zone:enter/exit
  (气味系统是范式,见 [smell-system](smell-system.md)),不改 ZoneSystem。

## 怎么验证

两个重叠 zone 交错进出,断言各自 onEnter/onExit 拿到自己的 zoneId;读档后断言 onExit 未跑。
