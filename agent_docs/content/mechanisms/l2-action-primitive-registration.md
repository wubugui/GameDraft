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
last_governed: 2026-07-13
---

## 是什么(一句话)

策划模式里唯一允许的代码改动是 L2 新增能力原语;而"一条可用 Action"由三个登记面共同构成,只做其中一步视为未完成。

## 权威源(读代码从哪进)

1. **运行时注册**:`src/core/ActionRegistry.ts` 的 `executor.register('类型名', handler, [参数…])`。
2. **编辑器可配**:`tools/editor/shared/action_editor.py` 的 `ACTION_TYPES`(下拉可选)+
   `_PARAM_SCHEMAS`(参数字段与类型);复杂参数在 `_rebuild_params`/`to_dict` 加专属分支。
3. **校验认可**:新 type 必须过 `validator.validate`(它拿数据中的 `action.type` 与
   `ACTION_TYPES` 比对,未登记报 error)。

对等机制的登记面:新 cutscene present 类型改 CutsceneManager/renderer;新条件叶子改
`evaluateGraphCondition.ts`;新图节点改 DialogueGraphNodeDef + GraphDialogueManager——同样要求"运行时+编辑器+校验"三面齐。

## 硬契约

- **params 内含 `ActionDef[]`(子动作)时**,必须在 `tools/editor/validator.py` 的
  `_walk_action_defs` 增加递归,否则子动作不参与"类型已登记"校验。
- **要进 cutscene 用**,同步 `src/data/cutscene_action_allowlist.json`。
- **参数含实体/场景/出生点引用时**,同步登记 `tools/editor/shared/entity_refactor.py`
  的 `ENTITY_REF_PARAMS`(实体迁移/改名/安全删除与 validator 可达性检查共同消费;
  漏登记该引用对重构与校验双双隐形,parity 测试 `test_entity_refactor.py` 拦
  `_PARAM_SCHEMAS` 内的漏网,自定义分支 action 由其钉单测试锁定)。
- **async handler**:在 register 内 `void promise.catch(...)`,不许把 `ActionExecutor.execute`
  改成 async(影响全链路)。
- **最小新增**:不顺手重构、不改既有 command 语义、handler 只做本动作逻辑。
- **审批边界**(以下须用户确认再做):扩 `ActionRegistryDeps`(牵动 Game 与多系统耦合)、
  改既有 action 语义/参数约定、动 `_walk_action_defs` 以外的全局校验策略、以及任何会
  实质改变玩法结果(奖励/进度/规矩/遭遇结局)的动作——后者先对照玩法文档。

## 已知坑

- **可选参数会被 Python 兜底当必填**:叙事侧兜底校验把 `_PARAM_SCHEMAS` 全部参数视为必填、
  拦住保存;可选参数须按 `emitNarrativeSignal` 范式覆盖 required——TS 侧
  `actionParamManifest.ts` 才是参数权威(实例:`stopSceneAmbient` 为此不在 schema 放可选 id)。
- 只改 TS 不更新 action_editor:策划选不到、校验报 error,等于没加。

## 怎么验证

`npx tsc --noEmit` + `./dev.sh validate-data`;主编辑器里实际加一条该动作并保存,确认无回归。完成后必须告知用户新增了哪个原语、改了哪些文件。步骤细节见 `.cursor/skills/add-game-action/SKILL.md`。
