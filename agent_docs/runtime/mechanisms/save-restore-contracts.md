---
id: save-restore-contracts
title: 存读档硬契约
domain: runtime
type: mechanism
summary: load 坏档先拒+快照回滚、save 返 Promise<boolean>(落盘是文件 I/O);查询走内存镜像保持同步;读档静默清 zone、清位面 manual override;新游戏=净化 URL 整页 reload
status: active
authority:
  - src/core/SaveManager.ts
  - src/core/storage/persistentStore.ts
  - src/systems/ZoneSystem.ts#clearActiveZonesForRestore
  - src/core/NarrativeStateManager.ts#NarrativeSaveMigrations
triggers:
  paths: ["src/core/SaveManager.ts", "src/core/storage/**", "src/systems/ZoneSystem.ts", "src/core/NarrativeStateManager.ts"]
  topics: [存档, 读档, save, load, deserialize, migrations, 改名迁移]
last_governed: 2026-08-28
---

## 是什么(一句话)

存读档路径上散在多个系统里的一组不变量;改任何系统的 serialize/deserialize 前先对表。

## 权威源(读代码从哪进)

`src/core/SaveManager.ts` + 各系统的 `IGameSystem.serialize/deserialize`;
`save:restoring` 事件是各系统清瞬态的统一钩子。

## 硬契约(违反即 bug)

- **坏档先拒 + 快照回滚**:load 解析失败不得半程写入;save/load 返回值调用方要消费。
- **存档落文件,不落 localStorage**(2026-08-28)。落点与后端选择见
  [runtime-persistence](runtime-persistence.md)。由此带来两条形状约束:
  - `save` / `deleteSlot` / `importSlotPayload` 是 **async**——等真写成了才回报成功,
    禁止乐观返回(存档这条路上最不能撒的谎)。写失败**不更新内存镜像**,
    否则菜单会显示一个磁盘上并不存在的档。
  - `getSlotMeta` / `hasSave` / `hasAnySave` / `exportSlotPayload` 走**内存镜像**、保持同步——
    它们在菜单的逐帧渲染路径上。镜像由启动时的 `hydrate()` 一次性水化,
    **必须在 MenuUI 构造之前 await 完**,否则标题页的「继续」按钮会因为读不到档而变灰。
- **读档静默清活跃 zone、不跑 onExit 动作**(走 `clearActiveZonesForRestore`)——读档瞬间跑 onExit
  会污染刚恢复的状态。
- `save:restoring` 时位面 manual override 一律清(旧档无位面桶也覆盖,见 [plane-system](plane-system.md));
  过场 deserialize 停尾音(见 [cutscene-audio-reclamation](cutscene-audio-reclamation.md))。
- **新游戏 = 净化 URL 整页 reload**,不做进程内软重置——依赖这点的初始化代码不必支持"二次冷启动"。
- FlagStore 拒空 key(validator 同步报 error)。
- **瞬态不入档**:zone 层气味、位面激活态等由位置/叙事状态在读档后重建(各卡自述)。
- **叙事图/状态改名走存档迁移表**(narrative_graphs.json 顶层 `migrations`,与 flag_registry 同套路,
  单跳不追链):deserialize **先重映射再校验**;重映射后仍未知的图/状态**不静默丢**——warn + recentIssues
  点名,active 态回退 initialState、reached 态出集。编辑器改名重构自动登记该表。
  **该字段无 GUI**,属专家盲区;场景实体/sceneMemory **无**此机制(2026-07-13 拍板暂不管,
  见 [entity-refactor-engine](../../content/mechanisms/entity-refactor-engine.md))。

## 怎么验证

存档 → 改状态 → 读档,断言 zone onExit 未触发、位面/气味按派生重建;
喂截断 JSON 断言拒档且旧状态完好。
