---
id: smell-system
title: 气味系统(双层 action/zone)
domain: runtime
type: mechanism
summary: action 层永远压过 zone 层;zone 气味声明式挂 ZoneDef.smell,SmellSystem 听 zone:enter 驱动,ZoneSystem 不动
status: active
authority:
  - src/systems/SmellSystem.ts
  - src/ui/smell/SmellIndicatorRenderer.ts
  - public/assets/data/smell_profiles.json
triggers:
  paths: ["src/systems/SmellSystem.ts", "src/ui/smell/**", "public/assets/data/smell_profiles.json"]
  topics: [气味, smell, 香粉味, 嗅]
last_governed: 2026-08-05
---

## 是什么(一句话)

玩家当前"闻到什么"的常驻机制:`SmellSystem` 内部两层——action 层(动作驱动)+ zone 层
(场景 `ZoneDef.smell` 声明式触发),合成一个生效气味给 HUD 与条件系统。

## 权威源(读代码从哪进)

`src/systems/SmellSystem.ts`(两层合成、zone 订阅、serialize);词库与烟形数据在 `smell_profiles.json`。

## 硬契约(违反即 bug)

- **优先级**:生效 = action 非空取 action,否则 zone,否则无味。`clearSmell` 后若仍在 zone 内,
  zone 气味自动浮回。
- **生效值单点广播**:进 FlagStore(`current_smell*`)+ `player:smellChanged` 事件(含 source);
  消费方读这两处,别自己再算。
- **serialize 只存 action 层**:zone 层是玩家位置的瞬时函数,读档进场由 zone:enter 重建。
- zone 重叠取最后进入。
- `setSmell`/`clearSmell`/`sniff` 是**写存档态的普通 command、不在 cutscene allowlist**——
  演出里要出味,在演出前后用普通 command,别塞 present 步。
- zone 触发是声明式的:改气味触发逻辑动 SmellSystem 的订阅,不动 ZoneSystem。

## 已知坑

- "闻不到"先查 profile 再查代码:衰减参数在数据里(hold 时长不够就是秒衰减)。
- 分不清谁在压谁:F2「系统」页标记生效来源;`?smellDebug` 暴露 `__smell*` 钩子。

## 怎么验证

F2 工具页可实时调烟形并读出可粘回 JSON 的数值;流程验证走
[runtime-command-channel](../recipes/runtime-command-channel.md)(进出 zone + setSmell 断言 FlagStore)。
