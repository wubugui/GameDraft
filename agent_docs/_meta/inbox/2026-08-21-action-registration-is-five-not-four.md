---
kind: deviation
date: 2026-08-21
target: action-registration-quadruple
---

- **说的**：`agent_docs/runtime/mechanisms/action-registration-quadruple.md` 与
  `add-game-action` skill 都讲「四件套」（ActionRegistry / action_editor 的
  ACTION_TYPES+_PARAM_SCHEMAS / validator 递归 / ENTITY_REF_PARAMS 条件性第五件）。
- **实际**：还有一个**必填**登记面 `src/core/actionParamManifest.ts`。漏了它 tsc 与
  validate-data 都不报，但 `tools/editor/tests/` 里有 **4 条**测试直接红
  （test_param_schema_manifest_parity / test_action_manifest_parity ×2 /
  test_narrative_required_params），断言语是「网页叙事校验会当未知类型**拦保存**」。
  今天加 `setEntityShadow` 时按四件套做完，就是这 4 条把缺口抓出来的。
- **建议**：卡名与正文改成「五件套」，把 manifest 列为必填第三件（它与
  `_PARAM_SCHEMAS` 是 parity 关系，天然成对）；`ENTITY_REF_PARAMS` 仍是条件性的那件。
