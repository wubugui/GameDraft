---
id: action-registration-registry-surfaces
title: 加 Action 的登记面
domain: runtime
type: mechanism
summary: 新 action 要同步的登记面不止一处(运行时注册 / TS 参数清单 / 编辑器授权面 / 校验器 / 条件性的实体引用表);漏哪一处的报错通道各不相同,有一处漏了 tsc 与 validate-data 全绿、只有编辑器测试红
status: active
authority:
  - src/core/ActionRegistry.ts
  - src/core/actionParamManifest.ts#ACTION_PARAM_MANIFEST
  - tools/editor/shared/action_editor.py
  - tools/editor/shared/action_editor.py#_ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT
  - tools/editor/shared/entity_refactor.py#ENTITY_REF_PARAMS
triggers:
  paths: ["src/core/ActionRegistry.ts", "src/core/actionParamManifest.ts", "tools/editor/shared/action_editor.py", "tools/editor/shared/entity_refactor.py"]
  tasks: [加 action, 新命令, L2 升级, 加可选参数]
  topics: [ActionRegistry, actionParamManifest, 动作参数, 实体引用登记, ENTITY_REF_PARAMS, 可选参数往返]
verified_by:
  - tools/editor/tests/test_entity_refactor.py
  - tools/editor/tests/test_socket_action_params.py
  - tools/editor/tests/test_action_manifest_parity.py
last_governed: 2026-09-03
---

## 是什么(一句话)

游戏行为原语(command/action)的注册契约:**多个登记面必须同步**,而漏掉不同的面
报错通道完全不同——有的运行时静默跳过,有的编辑器写不出,有的**四条门全绿只有一类测试红**。

## 登记面清单(漏了会怎样)

**必填**

| 登记面 | 权威源 | 漏了的表现 |
|---|---|---|
| 运行时执行注册 | `ActionRegistry.register`(经 ActionExecutor 统一执行) | 该 type 运行时不执行;校验器报未登记 |
| **TS 侧参数清单** | `actionParamManifest.ts` 的 `ACTION_PARAM_MANIFEST` | **`tsc` 与 `validate-data` 都不报**;只有 `tools/editor/tests/` 里的 parity/必填参数测试红,断言语是"网页叙事校验会当未知类型**拦保存**" |
| 编辑器授权面 | `action_editor.py` 的 `ACTION_TYPES` / `_PARAM_SCHEMAS`(同时是 Action 类型清单的权威列举源,别信架构文档的表) | 编辑器里选不到该类型 / 参数编辑不出来 |
| 校验器认可 | `tools/editor/validator.py` | 合法数据被误报,或该 type 的引用/必填检查整片缺席 |

`_PARAM_SCHEMAS` 与 TS manifest 是 **parity 关系、天然成对**——只改一处必被 parity 测试拦。
**Python 侧 schema 是投影,冲突以 TS 为准。**

**条件性(参数含实体/场景/出生点引用时必填)**

`entity_refactor.py` 的 `ENTITY_REF_PARAMS`:实体重构、引用扫描、validator 可达性检查
共同消费这张表,漏登记 = 该引用对重构与校验**双双隐形**。parity 测试拦 `_PARAM_SCHEMAS`
内的漏网;走自定义参数分支的 action 由 `test_custom_branch_actions_pinned` 钉死清单,新增要补钉单。

## 硬契约(违反即 bug)

- 登记面一个不能少;DEV 启动有 manifest↔registry 一致性审计兜底,但兜底响了再补 = 返工。
- **数据文件自身的实体引用不进这张表**:长在数据结构里(不是 action、没有 `type`/`params`
  那层壳)的实体引用,按参数类型判别的遍历器根本看不见,硬登记还会被 `test_manifest_parity`
  拦(键必须是真 action)。照既有先例(bubble_lines speaker / quest guidance)**单写一条改写
  函数,接进 scan / rename / move / undo-move 三条路径,并配跟随测试**。新写这类引用时,
  **场景限定写法(sceneId + entityKind + entityId)零歧义、可机械跟随**,比裸 id 好维护。
- cutscene 内可用的 action 是白名单制且**禁改存档**(ActionExecutor 策略栈递归强制,嵌套
  runActions 也逃不掉)——新原语要进过场,先判断它是否纯表演。
- **可选参数缺省不写键**:登记 `_OMIT_WHEN_ABSENT_AND_DEFAULT`(按**参数名全局**)或
  `_ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT`(按 `(action, param)`)。同名参数在别的
  action 里可能是 required,**这种一律用作用域表**,进全局表会误伤。

## 已知坑

- 新增可选参数后"打开→什么都不改→保存"凭空多出键,把支点/光照/翻面等写成中性值 =
  **改行为不是格式漂移**。往返测试只覆盖"给了值保不保值",探不到凭空多键——加可选参数
  必须单独探一次"最小形态打开→保存"的产物。
- **运行时默认为 true 的可选 bool 不能用勾选框**:控件中性值(false)≠ 运行时缺省(true),
  会让 false 配不出来;走三态字符串惯例(照 `playNpcAnimation.loop`)。
- 加可选参数时 Python 侧兜底校验可能当必填拦保存,按 `emitNarrativeSignal` 的既有范式覆盖 required。

## 怎么验证

`npx tsc --noEmit` + DEV 启动看一致性审计零告警 + 数据校验 + **`tools/editor/tests/` 全绿**
(TS manifest 那一面只有这里能抓);编辑器里能选到新类型,且**最小形态**与**填满形态**
两条往返都无漂移。
