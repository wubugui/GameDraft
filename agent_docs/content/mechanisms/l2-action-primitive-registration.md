---
id: l2-action-primitive-registration
title: L2 能力原语登记面
domain: content
type: mechanism
summary: 策划模式唯一允许的代码改动;一条可用 Action 要同步多个登记面(完整清单以 runtime 的登记面卡为准,别只做编辑器那一面),含嵌套/异步/可选参数三个已知坑与审批边界
status: active
authority:
  - src/core/ActionRegistry.ts
  - tools/editor/shared/action_editor.py#ACTION_TYPES
  - tools/editor/validator.py#_walk_action_defs
  - src/core/actionParamManifest.ts#ACTION_PARAM_MANIFEST
triggers:
  paths: ["src/core/ActionRegistry.ts", "tools/editor/shared/action_editor.py"]
  topics: [新增action, 新command, L2升级, 登记面, ActionRegistry]
  tasks: [加动作, 加命令, L2升级]
last_governed: 2026-08-05
---

## 是什么(一句话)

策划模式里唯一允许的代码改动是 L2 新增能力原语;而"一条可用 Action"由**多个登记面**共同
构成,只做其中一步视为未完成。**登记面的完整清单与"漏哪一处报哪种错"以
[加 Action 的登记面](../../runtime/mechanisms/action-registration-registry-surfaces.md) 为准,
这里不另抄一份**——那张卡上的 TS 参数清单尤其容易漏:漏了它 `tsc` 与数据校验**都不报**,
只有编辑器测试红。

## 权威源(读代码从哪进)

1. **运行时注册**:`src/core/ActionRegistry.ts`(`executor.register`)。
2. **TS 参数清单**:`src/core/actionParamManifest.ts`(参数唯一权威源,与下面的 `_PARAM_SCHEMAS` 成对)。
3. **编辑器可配**:`action_editor.py` 的 `ACTION_TYPES`(下拉可选)+ `_PARAM_SCHEMAS`(参数形状)。
4. **校验认可**:`validator.validate` 拿数据里的 `action.type` 与 `ACTION_TYPES` 比对,未登记报 error。

对等机制(新 cutscene present 类型 / 新条件叶子 / 新图节点)同样要求"运行时 + 编辑器 + 校验"三面齐;
**新图节点的运行时那一面 = `DialogueGraphNodeDef` + `GraphDialogueManager`**(编辑器侧另在
[dialogue-graph-editor](../../editor-tools/mechanisms/dialogue-graph-editor.md))。

## 硬契约

- **params 内含 `ActionDef[]`(子动作)时**,登记容器槽位表(`NESTED_ACTION_SLOTS` 及其 TS 镜像)并转发执行作用域;
  校验器那条容器分支仍是手写链,要同步补,否则子动作不参与"类型已登记"校验。
  全部登记面见 [action-registration-registry-surfaces](../../runtime/mechanisms/action-registration-registry-surfaces.md)。
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

- 必填集只认 TS 侧 `actionParamManifest.ts`(Python 兜底按它解析、解析失败 fail-open);别再给可选参数
  另写 required 覆盖——那是 07-20 之前"兜底把控件清单整表当必填"时代的绕法。
- 只改 TS 不更新 action_editor:策划选不到、校验报 error,等于没加。

## 怎么验证

`npx tsc --noEmit` + `./dev.sh validate-data`;主编辑器里实际加一条该动作并保存,确认无回归。完成后必须告知用户新增了哪个原语、改了哪些文件。步骤细节见 `.cursor/skills/add-game-action/SKILL.md`。
