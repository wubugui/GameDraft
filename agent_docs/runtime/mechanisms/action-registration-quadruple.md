---
id: action-registration-quadruple
title: 加 Action 四件套
domain: runtime
type: mechanism
summary: 新 action = 运行时 register + actionParamManifest(TS 权威) + 编辑器 ACTION_TYPES/_PARAM_SCHEMAS + validator 认可;参数含实体/场景引用另登记 ENTITY_REF_PARAMS(第五件);DEV 启动一致性审计兜底
status: active
authority:
  - src/core/ActionRegistry.ts
  - src/core/actionParamManifest.ts#ACTION_PARAM_MANIFEST
  - tools/editor/shared/action_editor.py
  - tools/editor/shared/entity_refactor.py#ENTITY_REF_PARAMS
triggers:
  paths: ["src/core/ActionRegistry.ts", "src/core/actionParamManifest.ts", "tools/editor/shared/action_editor.py", "tools/editor/shared/entity_refactor.py"]
  tasks: [加 action, 新命令, L2 升级]
  topics: [ActionRegistry, actionParamManifest, 动作参数, 实体引用登记, ENTITY_REF_PARAMS]
verified_by:
  - tools/editor/tests/test_entity_refactor.py
last_governed: 2026-07-13
---

## 是什么(一句话)

游戏行为原语(command/action)的注册契约:四处必须同步,漏任何一处的后果是运行时静默跳过、编辑器写不出、或校验误报。

## 权威源(读代码从哪进)

- 运行时执行:`ActionRegistry.register`(经 ActionExecutor 统一执行)
- **TS 侧参数唯一权威源:`actionParamManifest.ts` 的 `ACTION_PARAM_MANIFEST`**(Python 侧 schema 是投影,冲突以 TS 为准)
- 编辑器授权面:`action_editor.py` 的 `ACTION_TYPES` / `_PARAM_SCHEMAS`(同时是 Action 类型清单的权威列举源,别信架构文档的表)
- 校验:`tools/editor/validator.py`

## 硬契约(违反即 bug)

- 四件套一个不能少;DEV 启动有 manifest↔registry 一致性审计兜底,但兜底响了再补=返工。
- **参数含实体/场景/出生点引用**(裸 target/npcId、sceneId+entityId 限定、targetScene/
  targetSpawnPoint 之类)的 action,必须同步登记 `entity_refactor.py` 的 `ENTITY_REF_PARAMS`
  (条件性第五件)——实体重构(迁移/改名/安全删除)、引用扫描、validator 可达性检查共同
  消费这张表,漏登记 = 该引用对重构与校验双双隐形;parity 测试机械拦截 `_PARAM_SCHEMAS`
  内的漏网,自定义参数分支的 action(不在 `_PARAM_SCHEMAS`)由
  `test_custom_branch_actions_pinned` 钉死清单——新增自定义分支 action 要同步补这份钉单。
- cutscene 内可用的 action 是白名单制且**禁改存档**(ActionExecutor 策略栈递归强制,嵌套 runActions 也逃不掉)——新原语要进过场,先判断它是否纯表演。
- 可选参数缺省不写键(`_OMIT_WHEN_ABSENT_AND_DEFAULT` 登记),防"编辑器打开即注入"破坏往返。

## 已知坑

- 加可选参数时 Python 侧兜底校验可能当必填拦保存(narrative_state_editor 一线),按 emitNarrativeSignal 的既有范式覆盖 required。

## 怎么验证

`npx tsc --noEmit` + DEV 启动看一致性审计零告警 + validate-data;编辑器里能选到新类型并保存往返无漂移。
