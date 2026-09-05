---
id: save-restore-contracts
title: 存读档硬契约
domain: runtime
type: mechanism
summary: load 坏档先拒+快照回滚、save 返 Promise<boolean>(落盘是文件 I/O);查询走内存镜像保持同步;读档静默清 zone、清位面 manual override;新游戏=净化 URL 整页 reload
status: active
authority:
  - src/core/SaveManager.ts
  - src/core/Game.ts#collectSaveData
  - src/core/storage/persistentStore.ts
  - src/systems/ZoneSystem.ts#clearActiveZonesForRestore
  - src/core/NarrativeStateManager.ts#NarrativeSaveMigrations
triggers:
  paths: ["src/core/SaveManager.ts", "src/core/storage/**", "src/systems/ZoneSystem.ts", "src/core/NarrativeStateManager.ts"]
  topics: [存档, 读档, save, load, deserialize, migrations, 改名迁移, 玩家站位]
last_governed: 2026-09-03
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
  - **一次性水化要记住"在飞的那个 Promise",不能记一个布尔完成位**——布尔版是已知陷阱:
    第二个并发调用方会拿到一个立刻 resolve 的 promise,而镜像其实还是空的。当前只有一处
    串行调用方,所以这是"装好了但还没踩的陷阱";加第二个调用点前先读这一条。
- **旧档的一次性迁移标记写在来源侧,不写目标侧**。目标那一侧的目录会随 worktree 切换/清理
  消失,标记跟着没了就会**把旧档反复重灌**一遍。
- **读档静默清活跃 zone、不跑 onExit 动作**(走 `clearActiveZonesForRestore`)——读档瞬间跑 onExit
  会污染刚恢复的状态。
- `save:restoring` 时位面 manual override 一律清(旧档无位面桶也覆盖,见 [plane-system](plane-system.md));
  过场 deserialize 停尾音(见 [cutscene-audio-reclamation](cutscene-audio-reclamation.md))。
- **新游戏 = 净化 URL 整页 reload**,不做进程内软重置——依赖这点的初始化代码不必支持"二次冷启动"。
- FlagStore 拒空 key(validator 同步报 error)。
- **瞬态不入档**:zone 层气味、位面激活态等由位置/叙事状态在读档后重建(各卡自述)。
- **玩家站位/朝向入档,单列顶层 `player` 桶**——玩家不是场景实体,`sceneMemory` 那个覆盖桶
  够不着他。落位**不能就地写坐标**(必被随后的场景重载盖掉):只登记待落位,
  由场景重载透传给 `loadScene` 的**位置覆盖参数**。⚠ **那个参数名带 camera,
  但它同时是玩家落点覆盖**(给了就顶掉 spawnPoint),落点发生在 onEnter 之前——
  这条反直觉命名坑过人,改场景装载签名前先读它的注释。朝向不受装载影响,就地设即可。
  旧档无该桶 = 回落出生点,故**未升存档版本**。
- **进档的随机源不许被纯表现层消耗**:它的 state 进存档、内容侧的随机分支也从同一条取值。
  让表现系统(闲聊/待机这类)去抽签,等于"玩家有没有从某个 NPC 旁边走过"会改变后续随机分支的
  结果——存档因此分叉。表现层另开一条独立随机源。
- **叙事图/状态改名走存档迁移表**(narrative_graphs.json 顶层 `migrations`,与 flag_registry 同套路,
  单跳不追链):deserialize **先重映射再校验**;重映射后仍未知的图/状态**不静默丢**——warn + recentIssues
  点名,active 态回退 initialState、reached 态出集。编辑器改名重构自动登记该表。
  **该字段无 GUI**,属专家盲区;场景实体/sceneMemory **无**此机制(2026-07-13 拍板暂不管,
  见 [entity-refactor-engine](../../content/mechanisms/entity-refactor-engine.md))。

## 怎么验证

存档 → 改状态 → 读档,断言 zone onExit 未触发、位面/气味按派生重建;
喂截断 JSON 断言拒档且旧状态完好。
