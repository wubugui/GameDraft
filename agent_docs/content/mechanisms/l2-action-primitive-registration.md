---
id: l2-action-primitive-registration
title: L2 能力原语登记面(action 三件套)
domain: content
type: mechanism
summary: 一条可用 Action = 运行时注册 + 编辑器可配 + 校验认可,缺一视为未完成;含嵌套/异步/可选参数三个已知坑与审批边界
status: active
authority:
  - src/core/ActionRegistry.ts
  - tools/editor/shared/action_editor.py#ACTION_TYPES
  - tools/editor/validator.py#_walk_action_defs
  - src/core/actionParamManifest.ts#ACTION_PARAM_MANIFEST
triggers:
  paths: ["src/core/ActionRegistry.ts", "tools/editor/shared/action_editor.py"]
  topics: [新增action, 新command, L2升级, 三件套, ActionRegistry]
  tasks: [加动作, 加命令, L2升级]
last_governed: 2026-08-05
---

## 是什么(一句话)

策划模式里唯一允许的代码改动是 L2 新增能力原语;而"一条可用 Action"由三个登记面共同构成,只做其中一步视为未完成。

## 权威源(读代码从哪进)

1. **运行时注册**:`src/core/ActionRegistry.ts`(`executor.register`)。
2. **编辑器可配**:`action_editor.py` 的 `ACTION_TYPES`(下拉可选)+ `_PARAM_SCHEMAS`(参数形状)。
3. **校验认可**:`validator.validate` 拿数据里的 `action.type` 与 `ACTION_TYPES` 比对,未登记报 error。

对等机制(新 cutscene present 类型 / 新条件叶子 / 新图节点)同样要求"运行时 + 编辑器 + 校验"三面齐;
**新图节点的运行时那一面 = `DialogueGraphNodeDef` + `GraphDialogueManager`**(编辑器侧另在
[dialogue-graph-editor](../../editor-tools/mechanisms/dialogue-graph-editor.md))。

## 硬契约

- **params 内含 `ActionDef[]`(子动作)时**,必须在 `validator.py` 的 `_walk_action_defs`
  加递归,否则子动作不参与"类型已登记"校验。
- **要进 cutscene 用**,同步 `src/data/cutscene_action_allowlist.json`。
- **参数含实体/场景/出生点引用时**,同步登记 `entity_refactor.py` 的 `ENTITY_REF_PARAMS`
  ——漏登记会让该引用对重构与校验**双双隐形**(parity 测试只拦 `_PARAM_SCHEMAS` 内的漏网,
  自定义分支 action 得自己钉单测试)。
- **async handler**:在 register 内 `void promise.catch(...)`;**不许**把 `ActionExecutor.execute`
  改成 async(影响全链路)。
- **最小新增**:不顺手重构、不改既有 command 语义、handler 只做本动作逻辑。
- **审批边界**(须用户确认再做):扩 `ActionRegistryDeps`(牵动 Game 与多系统耦合)、改既有
  action 语义/参数约定、动 `_walk_action_defs` 以外的全局校验策略、任何会实质改变玩法结果
  (奖励/进度/规矩/遭遇结局)的动作——后者先对照玩法文档。

## 已知坑

- **可选参数会被 Python 兜底当必填**、拦住保存:兜底校验把 `_PARAM_SCHEMAS` 的参数一律视为
  必填,可选参数须按 `emitNarrativeSignal` 范式覆盖 required;TS 侧 `actionParamManifest.ts`
  才是参数权威。
- 只改 TS 不更新 action_editor:策划选不到、校验报 error,等于没加。

## 怎么验证

`npx tsc --noEmit` + `./dev.sh validate-data`;主编辑器里实际加一条该动作并保存,确认无回归。完成后必须告知用户新增了哪个原语、改了哪些文件。步骤细节见 `.cursor/skills/add-game-action/SKILL.md`。
