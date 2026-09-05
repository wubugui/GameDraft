---
id: dialogue-owner-origin
title: 对话图 owner 归属(四档优先级与注入点登记面)
domain: runtime
type: mechanism
summary: ownerState 认谁当 owner 由唯一判定源按四档优先级裁;每条能开对话图的路径都必须显式线程化来源上下文,漏注入无红字、只是静默走 missingWrapperNext
status: active
authority:
  - src/core/actionOrigin.ts#resolveDialogueOwner
  - src/systems/GraphDialogueManager.ts
  - tools/editor/shared/narrative_catalog.py#dialogue_start_sites
triggers:
  paths: ["src/core/actionOrigin.ts", "src/systems/GraphDialogueManager.ts", "tools/editor/shared/narrative_catalog.py"]
  topics: [owner, ownerState, ownerId, ownerType, 对话图归属, startDialogueGraph, wrapper]
  tasks: [加开对话图的新路径, 改 owner 解算, 修"编辑器说未找到引用"]
verified_by:
  - src/core/actionOrigin.test.ts
  - tools/editor/tests/test_dialogue_owner_parity.py
last_governed: 2026-09-03
---

## 是什么(一句话)

一张对话图被打开时"它属于谁"怎么定——`ownerState` 节点读的就是这个 owner;
以及**谁有义务把来源身份传进去**这个登记面。

## 权威源(读代码从哪进)

判定:`actionOrigin.ts` 的 `resolveDialogueOwner`(**唯一判定源**,四档优先级写在这)。
消费:`GraphDialogueManager` 里 `ownerState` 的解析与回落。
编辑器侧同口径镜像:`narrative_catalog.py` 的 `dialogue_start_sites`(全工程扫"这张图会从哪儿被打开")。

## 硬契约(违反即 bug)

- **owner 有且只有一个判定源,四档优先级只在那里写一次**。显式声明最高、其次实体身份、
  再次动作来源实体、最后场景 ambient——具体档位与字段名以判定源为准,**别在任何地方
  拼第二份近似解算**(历史上编辑器与叙事状态编辑器各有一份更窄的副本,已删)。
- **能启动对话图的每一条路径都必须把来源上下文按参数显式线程化**进去
  (与 [zone-lifecycle-contracts](zone-lifecycle-contracts.md) 同一条禁全局栈铁律)。
  漏注入**没有任何红字**:那张图里的 `ownerState` 会静默走 `missingWrapperNext`,
  表现是"分支莫名其妙走了兜底"。**新增一条开图路径 = 必须同时注入 owner**。
- **`ownerId` 一律写运行时索引所用的裸 id**,不写 `场景:实体` 这类限定形式
  (validator 报 error)。编辑器同时登记两种形式,所以限定形式**在编辑器里看不出问题**,
  只在运行时查询恒落空。
- **编辑器/校验器的 owner 解算必须与运行时同口径**(同一份注入点登记面)。
  两边口径一岔,症状是**运行时跑得通、编辑器判"未找到引用"**:状态下拉空、
  validate-data 假警告、新建 `ownerState` 节点被硬拦。

## 已知坑

- **注入点是清单型事实,以代码为准**——照抄任何文档里的"有哪几类调用点"必漏。
  真实事故:场景根 onEnter 之外的四类路径(区域、热区动作、叙事图状态动作、对话链式接续)
  曾整片没注入 owner,运行时无声、编辑器却把这些图判成没有 owner。
- owner 缺失与"owner 有但没有对应 wrapper"是**两件事**,回落到同一个 `missingWrapperNext`;
  排查时先分清是没传进来还是传了但配不上。

## 怎么验证

运行时侧 `src/core/actionOrigin.test.ts`;**运行时↔编辑器同口径由 parity 门锁死**
(`tools/editor/tests/test_dialogue_owner_parity.py`)——改任一侧的解算都要跑它。
