---
target: dialogue-graph-editor / runtime owner 注入
date: 2026-08-06
session: ownerState 只认 npc/hotspot/场景onEnter 的诊断与修复
---

现象: 对话图 ownerState 的 owner 归属，运行时有四档（显式 ownerType/ownerId > npcId > 动作来源实体 > 场景 onEnter ambient），编辑器静态解算只认三种来源（NPC.dialogueGraphId / hotspot.data.graphId / 场景根 onEnter），且 narrative_state_editor 里还有一份更窄的镜像副本。后果是 zone / 热区动作 / 叙事图状态动作 / 任务动作里开的对话，编辑器判为「未找到引用」→ 状态下拉空、validate-data 假警告、新建 ownerState 节点被硬拦（真实工程里 `寻狗_崖墓任务发布` 正是此状：运行时跑得通、编辑器不让编）。同时运行时侧 zone / 热区动作 / 叙事图状态动作 / 对话链式接续四条路径**根本没有注入 owner**，那里的 ownerState 会静默走 missingWrapperNext。

证据: 全工程扫 startDialogueGraph 调用点 = 场景根 onEnter 4 处 + zone 11 处 + 热区 data.actions 2 处 + 叙事图 onEnterActions 1 处；旧 `dialogue_owner_refs_from_scenes` 只覆盖第一类。另：4 个 hotspot wrapper 的 ownerId 写成 `义庄:hs_镇尸_X` 限定形式，而运行时 InteractionCoordinator 以裸 `hotspot.def.id` 建 owner 索引 → 这批 wrapper 的 owner 查询一直落空（编辑器却因同时登记两种形式而看不出来）。

建议: 已落地——运行时把 zone 上下文升格为 `ActionOriginContext{zoneId?, ownerType?, ownerId?}`（仍按参数显式线程化，遵 zone-lifecycle-contracts 的禁全局栈铁律），四档优先级收敛到唯一判定源 `src/core/actionOrigin.ts::resolveDialogueOwner`；编辑器 `dialogue_start_sites` 全工程扫描镜像同一套口径，镜像副本已删除；限定形式 ownerId 由 validator 报 error。治理时建议把「owner 四档优先级 + 注入点登记面」收成一张 runtime 机制卡，parity 门在 `tools/editor/tests/test_dialogue_owner_parity.py` 与 `src/core/actionOrigin.test.ts`。
