---
id: save-restore-contracts
title: 存读档硬契约
domain: runtime
type: mechanism
summary: load 坏档先拒+快照回滚、save/load 返 boolean;读档静默清 zone、清位面 manual override;新游戏=净化 URL 整页 reload
status: active
authority:
  - src/core/SaveManager.ts
  - src/systems/ZoneSystem.ts#clearActiveZonesForRestore
  - src/core/NarrativeStateManager.ts#NarrativeSaveMigrations
triggers:
  paths: ["src/core/SaveManager.ts", "src/systems/ZoneSystem.ts", "src/core/NarrativeStateManager.ts"]
  topics: [存档, 读档, save, load, deserialize, migrations, 改名迁移]
last_governed: 2026-07-13
---

## 是什么(一句话)

存读档路径上散在多个系统里的一组不变量;改任何系统的 serialize/deserialize 前先对表。

## 权威源(读代码从哪进)

`src/core/SaveManager.ts`;各系统 IGameSystem.serialize/deserialize;`save:restoring` 事件是各系统清瞬态的统一钩子。

## 硬契约(违反即 bug)

- **坏档先拒 + 快照回滚**:SaveManager.load 解析失败不得半程写入;save/load 返回 boolean,调用方要消费。
- **读档走 `ZoneSystem.clearActiveZonesForRestore`**(只挂 SaveManager 线):静默清活跃 zone、**不跑 onExit 动作**——读档瞬间跑 onExit 会污染刚恢复的状态。
- `save:restoring` 时位面 manual override 一律清(旧档无位面桶也覆盖,见 [plane-system](plane-system.md));过场 deserialize 停尾音(见 [cutscene-audio-reclamation](cutscene-audio-reclamation.md))。
- **新游戏 = 净化 URL 整页 reload**,不做进程内软重置——依赖这点的初始化代码不必支持"二次冷启动"。
- FlagStore.set/deserialize 拒空 key(validator 同步把空 key 报 error)。
- 各层 serialize 语义遵循"瞬态不入档":zone 层气味、位面激活态等由位置/叙事状态在读档后重建(各卡自述)。
- **叙事图/状态改名走存档迁移表**:narrative_graphs.json 顶层 `migrations: {graphs, states}`(与 flag_registry.migrations 同套路,单跳不追链);deserialize **先重映射再校验**,重映射后仍未知的图/状态不静默丢——console.warn + recentIssues 点名,active 态回退 initialState、reached 态出集。编辑器改名重构自动登记该表(signal_refactor),`validateSaveMigrations` 四类检查全 warning;**该字段无 GUI**,属 flag_registry.migrations 同类专家盲区。场景实体/sceneMemory **无**此机制(2026-07-13 拍板暂不管,见 [entity-refactor-engine](../../content/mechanisms/entity-refactor-engine.md))。

## 怎么验证

存档→改状态→读档,断言 zone onExit 未触发、位面/气味按派生重建;喂截断 JSON 断言拒档且旧状态完好。
