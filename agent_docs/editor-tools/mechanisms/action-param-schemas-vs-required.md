---
id: action-param-schemas-vs-required
title: _PARAM_SCHEMAS 是控件清单不是必填集
domain: editor-tools
type: mechanism
summary: action 参数清单三处镜像语义各不同;required/optional 的唯一权威是 actionParamManifest.ts,编辑器侧的 schema 只决定建哪些控件
status: active
authority:
  - tools/editor/shared/action_editor.py#_PARAM_SCHEMAS
  - tools/editor/editors/narrative_state_editor.py#_validate_action_def
  - src/core/actionParamManifest.ts
triggers:
  paths: ["tools/editor/shared/action_editor.py", "src/core/actionParamManifest.ts"]
  topics: [action 参数, 可选参数, _PARAM_SCHEMAS, required]
  tasks: [加游戏 action, 给 action 加参数]
verified_by:
  - tools/editor/tests/test_action_manifest_parity.py
last_governed: 2026-08-05
---

## 是什么(一句话)

action 参数清单在三处镜像,语义各不同:`_PARAM_SCHEMAS`(编辑器"要建哪些控件")≠ 必填集;required/optional 的权威区分只在 `src/core/actionParamManifest.ts`。

## 权威源(读代码从哪进)

- `src/core/actionParamManifest.ts`:三方同步的权威(required / optional / nonEmpty)
- `tools/editor/shared/action_editor.py` 的 `_PARAM_SCHEMAS`:GUI 控件清单
- `tools/editor/editors/narrative_state_editor.py` 的 `_validate_action_def`:Python 兜底校验

## 硬契约

1. **必填集只在 TS 权威声明**:加可选参数就在 `actionParamManifest.ts` 里写清 required/optional,Python 兜底从它解析、解析失败 fail-open,**不需要也不要再去 `_validate_action_def` 手写 required 覆盖**(2026-07-20 起;历史写法把 `_PARAM_SCHEMAS` 整表当必填,比 TS 严 25 处、拦死合法最小形态,那段修法已作废)。红线仍是 [兜底 ⊆ TS 权威](../norms.md)。
2. 三方 parity(运行时 register ↔ 编辑器 ACTION_TYPES/_PARAM_SCHEMAS ↔ TS manifest)由 `test_action_manifest_parity.py` 锁定——加 action 走 [登记面清单](../../runtime/mechanisms/action-registration-registry-surfaces.md),别只改一处。

## 已知坑

- 历史根因:五处手工镜像清单零 parity 护栏时代产生过"保存即删参数 / 幻影 error 拦保存 / 写 0 改行为"整族 bug;任何新镜像清单出现都应立刻配 parity 测试。
- 兜底校验跑在保存路径上:过严的表现不是提示,而是 save_all 直接 raise、整工程存不了。

## 怎么验证

`pytest tools/editor/tests/test_action_manifest_parity.py`、`test_narrative_required_params`(TS→Python 解析 parity)+ `test_canvas_roundtrip_safety.py`。
