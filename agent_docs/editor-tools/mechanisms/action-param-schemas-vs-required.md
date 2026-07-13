---
id: action-param-schemas-vs-required
title: _PARAM_SCHEMAS 是控件清单不是必填集
domain: editor-tools
type: mechanism
summary: 给 action 加"可选"参数时,叙事编辑器的 Python 兜底校验默认把 _PARAM_SCHEMAS 每项当必填拦保存——必须显式覆盖 required
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
last_governed: 2026-07-11
---

## 是什么(一句话)

action 参数清单在三处镜像,语义各不同:`_PARAM_SCHEMAS`(编辑器"要建哪些控件")≠ 必填集;required/optional 的权威区分只在 `src/core/actionParamManifest.ts`。

## 权威源(读代码从哪进)

- `src/core/actionParamManifest.ts`:三方同步的权威(区分 required/optional/nonEmpty;TS 校验只对 required 判空)
- `tools/editor/shared/action_editor.py` 的 `_PARAM_SCHEMAS`:GUI 控件清单
- `tools/editor/editors/narrative_state_editor.py` 的 `_validate_action_def`:Python 兜底校验(无 required/optional 之分的手抄清单)

## 硬契约

1. **凡给 `_PARAM_SCHEMAS` 加可选参数,必查 `_validate_action_def` 的 required 覆盖**:它默认 `required = schemas.get(action_type, [])` 把每项当必填,对 undefined/空串报 error → save_all 直接 raise、黄金往返先炸。修法照 emitNarrativeSignal 范式显式覆盖(全可选就写 `required = []`)。
2. 三方 parity(运行时 register ↔ 编辑器 ACTION_TYPES/_PARAM_SCHEMAS ↔ TS manifest)由 `test_action_manifest_parity.py` 锁定——加 action 走 add-game-action 三件套,别只改一处。

## 已知坑

- 历史根因:五处手工镜像清单零 parity 护栏时代产生过"保存即删参数/幻影 error 拦保存/写 0 改行为"整族 bug;任何新镜像清单出现都应立刻配 parity 测试。

## 怎么验证

`pytest tools/editor/tests/test_action_manifest_parity.py` + `test_canvas_roundtrip_safety.py`(narrative 校验在保存路径上,兜底过严会在这里暴露)。
