---
date: 2026-07-20
type: deviation
about: action-param-schemas-vs-required (editor-tools/mechanisms)
---

- 卡「硬契约1」的修法段说：给 `_PARAM_SCHEMAS` 加可选参数时，要照 emitNarrativeSignal 范式在 `narrative_state_editor._validate_action_def` 里手动写 `required = []` 覆盖，否则 Python 兜底把整表当必填、空值报 error 炸保存。
- 实际（审查 P1-10 系统修后）：`_validate_action_def` 已改为从 TS 权威 `actionParamManifest.ts` 经 `narrative_required_params.load_required_params()` 解析 required/non_empty，不再拿 `_PARAM_SCHEMAS` 整表当必填（fail-open）。只要在 `actionParamManifest.ts` 声明 `required: []`，Python 侧零改动即正确。
- 影响/建议：本次新增全可选参数 command（showBlackout/hideBlackout，仅可选 durationMs）**未**触碰 narrative_state_editor.py，四件套 parity + narrative_required_params 测试全绿。卡的「修法」段落已过时，宜更新为「在 actionParamManifest.ts 声明 required 即可，Python 兜底自动同步」。
