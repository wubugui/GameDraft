# Skill / Workflow Governance Report

- Generated: `2026-09-04T00:01:10`
- Root: `E:/GameDev/GameDraft`
- Artifacts: `119`
- Issues: `173`

## Summary

### Artifacts By Type

- `agent_rules`: `3`
- `ci_workflow`: `1`
- `package_script`: `29`
- `script`: `36`
- `skill`: `25`
- `tool_requirements`: `9`
- `workflow_doc`: `16`

### Issues By Severity

- `info`: `32`
- `warn`: `141`

## Issues

| Severity | Category | Artifact | Evidence | Suggestion |
|---|---|---|---|---|
| warn | missing-metadata | .claude/skills/agent-docs-cli/SKILL.md:1 | No obvious trigger/use/scope section was detected. | Add a short 'when to use / when not to use' section near the top of the skill. |
| warn | broken-reference | .cursor/skills/add-game-action/SKILL.md:10 | `agent_docs/runtime/mechanisms/action-registration-quadruple.md` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | .cursor/skills/add-game-action/SKILL.md:10 | `agent_docs/runtime/mechanisms/action-registration-quadruple.md` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:10 | `agent_docs/content/mechanisms/l2-action-primitive-registration.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:10 | `agent_docs/content/mechanisms/l2-action-primitive-registration.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:23 | `src/core/ActionRegistry.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:23 | `src/core/ActionRegistry.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:26 | `src/core/Game.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:26 | `src/core/Game.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:28 | `tools/editor/shared/action_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:28 | `tools/editor/shared/action_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:34 | `tools/editor/validator.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:34 | `tools/editor/validator.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:37 | `tools/editor/shared/entity_refactor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:37 | `tools/editor/tests/test_entity_refactor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:37 | `tools/editor/shared/entity_refactor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:37 | `tools/editor/tests/test_entity_refactor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:53 | `src/core/ActionRegistry.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:53 | `src/core/Game.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:53 | `src/core/ActionRegistry.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:53 | `src/core/Game.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:55 | `tools/editor/shared/action_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:55 | `tools/editor/shared/action_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:56 | `tools/editor/validator.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-game-action/SKILL.md:56 | `tools/editor/validator.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-text-ref/SKILL.md:12 | `agent_docs/content/mechanisms/text-ref-tag-system.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-text-ref/SKILL.md:12 | `agent_docs/content/mechanisms/text-ref-tag-system.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-text-ref/SKILL.md:17 | `src/core/Game.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/add-text-ref/SKILL.md:17 | `src/core/Game.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | missing-metadata | .cursor/skills/agent-docs-cli/SKILL.md:1 | No obvious trigger/use/scope section was detected. | Add a short 'when to use / when not to use' section near the top of the skill. |
| warn | missing-metadata | .cursor/skills/animation-production/SKILL.md:1 | No obvious trigger/use/scope section was detected. | Add a short 'when to use / when not to use' section near the top of the skill. |
| warn | broken-reference | .cursor/skills/animation-production/SKILL.md:49 | `tmp/libtv_animation_batch_run_20260702/run_animation_batch.py` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | drift-risk | .cursor/skills/animation-production/SKILL.md:60 | `src/rendering/SpriteEntity.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | broken-reference | .cursor/skills/commit-push-gamedraft/SKILL.md:35 | `.tools/venv/bin/python` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | .cursor/skills/commit-push-gamedraft/SKILL.md:149 | `.tools/venv/.../python` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | drift-risk | .cursor/skills/commit-push-gamedraft/SKILL.md:153 | `agent_docs/meta/recipes/dvc-oss-restore.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/debug-panel-extension/SKILL.md:34 | `src/core/Game.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/debug-panel-extension/SKILL.md:34 | `src/core/Game.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | broken-reference | .cursor/skills/editor-tools-iteration/SKILL.md:8 | `tools/scene_depth_editor` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | .cursor/skills/editor-tools-iteration/SKILL.md:8 | `tools/scene_depth_editor` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:10 | `agent_docs/editor-tools/mechanisms/editor-data-sync-paradigm.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:10 | `agent_docs/editor-tools/mechanisms/mainwindow-editor-hooks.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:10 | `agent_docs/editor-tools/mechanisms/save-all-dirty-buckets.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:10 | `agent_docs/editor-tools/mechanisms/shared-widget-value-fidelity.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:10 | `agent_docs/editor-tools/norms.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:10 | `agent_docs/editor-tools/recipes/editor-change-verification-gate.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:10 | `agent_docs/editor-tools/mechanisms/editor-data-sync-paradigm.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:10 | `agent_docs/editor-tools/mechanisms/mainwindow-editor-hooks.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:10 | `agent_docs/editor-tools/mechanisms/save-all-dirty-buckets.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:10 | `agent_docs/editor-tools/mechanisms/shared-widget-value-fidelity.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:10 | `agent_docs/editor-tools/norms.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:10 | `agent_docs/editor-tools/recipes/editor-change-verification-gate.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:16 | `tools/editor/validator.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:16 | `tools/editor/validator.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:31 | `tools/editor/shared/action_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:31 | `tools/editor/shared/action_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:32 | `tools/editor/shared/action_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:32 | `tools/editor/shared/action_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:33 | `tools/editor/shared/action_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:33 | `tools/editor/shared/action_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:35 | `tools/editor/shared/action_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:35 | `tools/editor/shared/action_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:37 | `tools/editor/editors/scene_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:37 | `tools/editor/editors/timeline_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:37 | `tools/editor/editors/scene_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:37 | `tools/editor/editors/timeline_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:50 | `tools/editor/editors/scene_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/editor-tools-iteration/SKILL.md:50 | `tools/editor/editors/scene_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/feature-iteration/SKILL.md:31 | `docs/游戏架构设计文档.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/feature-iteration/SKILL.md:31 | `docs/游戏架构设计文档.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/feature-iteration/SKILL.md:46 | `docs/游戏架构设计文档.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/feature-iteration/SKILL.md:46 | `docs/游戏架构设计文档.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/gameplay-iteration/SKILL.md:22 | `docs/玩法功能需求清单.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/gameplay-iteration/SKILL.md:22 | `docs/玩法功能需求清单.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/gameplay-iteration/SKILL.md:33 | `docs/玩法功能需求清单.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/gameplay-iteration/SKILL.md:33 | `docs/玩法功能需求清单.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/gameplay-iteration/SKILL.md:34 | `docs/游戏架构设计文档.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/gameplay-iteration/SKILL.md:34 | `docs/游戏架构设计文档.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/gameplay-iteration/SKILL.md:58 | `docs/玩法功能需求清单.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/gameplay-iteration/SKILL.md:58 | `docs/玩法功能需求清单.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/gameplay-iteration/SKILL.md:81 | `docs/游戏架构设计文档.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/gameplay-iteration/SKILL.md:81 | `docs/游戏架构设计文档.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/interactive-architecture-html/SKILL.md:81 | `docs/游戏架构设计文档.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | broken-reference | .cursor/skills/production-mode/SKILL.md:156 | `故事设计/关二狗的故事.md` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | .cursor/skills/production-mode/SKILL.md:156 | `故事设计/关二狗的故事.md` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:10 | `agent_docs/content/mechanisms/content-expression-channels.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:10 | `agent_docs/content/mechanisms/editor-roundtrip-contract.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:10 | `agent_docs/content/norms.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:10 | `agent_docs/content/recipes/content-validation-gate.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:10 | `agent_docs/content/mechanisms/content-expression-channels.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:10 | `agent_docs/content/mechanisms/editor-roundtrip-contract.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:10 | `agent_docs/content/norms.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:10 | `agent_docs/content/recipes/content-validation-gate.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:29 | `docs/游戏架构设计文档.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:29 | `public/assets/scenes/bridge_underpass.json` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:29 | `docs/游戏架构设计文档.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:29 | `public/assets/scenes/bridge_underpass.json` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:45 | `docs/游戏架构设计文档.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:45 | `docs/游戏架构设计文档.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:75 | `agent_docs/content/mechanisms/editor-roundtrip-contract.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:75 | `agent_docs/content/recipes/content-validation-gate.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:75 | `agent_docs/content/mechanisms/editor-roundtrip-contract.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:75 | `agent_docs/content/recipes/content-validation-gate.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:77 | `docs/玩法功能需求清单.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/pure-data-iteration/SKILL.md:77 | `docs/玩法功能需求清单.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | AGENTS.md:8 | `agent_docs/INDEX.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | broken-reference | CLAUDE.md:64 | `agent-context-current.md` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | drift-risk | artifact/cursor-workflow-guide.md:42 | `docs/玩法功能需求清单.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | artifact/cursor-workflow-guide.md:47 | `docs/玩法功能需求清单.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | artifact/cursor-workflow-guide.md:96 | `docs/游戏架构设计文档.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | artifact/cursor-workflow-guide.md:138 | `src/core/Game.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | artifact/cursor-workflow-guide.md:144 | `docs/游戏架构设计文档.md` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | docs/plan/production-tooling-requirements.md:414 | `resources/editor_projects/editor_data/production_workbench/runtime_debug_snapshot.json` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | broken-reference | docs/plan/production-workbench-acceptance-checklist.md:18 | `.tools/venv/bin/python` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | scripts/lib/build_helpers.mjs:238 | `resources/runtime/audio/x.wav` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | scripts/lib/build_helpers.mjs:239 | `audio/x.wav` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | scripts/lib/build_helpers.mjs:242 | `resources/runtime/audio/...wav` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | scripts/lib/scene_index.mjs:2 | `assets/scene_index.json` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | scripts/package.mjs:328 | `audio/bgm/x.wav` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | scripts/package.mjs:425 | `audio/bgm/x.wav` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | tools/anim_preview/README.md:106 | `setup.png` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | tools/anim_preview/README.md:125 | `setup.png` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | tools/animation_pipeline/README.md:6 | `tmp/libtv_animation_batch_run_20260702/run_animation_batch.py` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | tools/character_lighting_lab/README.md:73 | `tools/scene_relight/bake.py` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | tools/character_lighting_lab/README.md:387 | `tools/scene_depth_editor` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | tools/chronicle_sim_v2/README.md:7 | `.tools/venv/bin/python` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | drift-risk | tools/json_lang/README.md:7 | `src/core/actionParamManifest.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | tools/json_lang/README.md:29 | `tools/json_lang/refs.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | tools/json_lang/README.md:43 | `tools/json_lang/lsp_server.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | tools/json_lang/README.md:125 | `src/core/actionParamManifest.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | tools/json_lang/README.md:126 | `tools/editor/shared/action_editor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | tools/json_lang/README.md:127 | `tools/editor/shared/entity_refactor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | tools/json_lang/README.md:129 | `src/data/types.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | tools/json_lang/README.md:166 | `tools/editor/shared/entity_refactor.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | tools/narrative_debugger/README.md:180 | `vite.config.ts` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | tools/narrative_xref/README.md:140 | `agent_docs/editor-tools/mechanisms/emitted-signal-catalog.md` is about 14 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | tools/narrative_xref/README.md:145 | `tools/json_lang/search.py` is about 15 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | broken-reference | tools/narrative_xref/README.md:166 | `tools/editor/tests/test_signal_xref_bridge.py::SignalXrefSourceParityTests::test_model_source_matches_disk_source_on_the_real_project` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | tools/narrative_xref/README.md:168 | `tools/narrative_debugger/tests/test_signal_xref_window.py::test_mcp_signal_info_says_the_same_thing_as_the_window` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | tools/scene_relight/README.md:68 | `d=(R*256+G)/65535*scale+offset` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| warn | broken-reference | tools/video_to_atlas/README.md:7 | `.tools/venv/bin/python` resolves to no existing file or directory. | Fix the path, remove the stale reference, or create/register the missing artifact. |
| info | missing-lifecycle | .claude/skills/agent-docs-cli/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | possible-overlap | .claude/skills/agent-docs-cli/SKILL.md:1 | `.claude/skills/agent-docs-cli/SKILL.md` and `.cursor/skills/agent-docs-cli/SKILL.md` have token overlap score 1.00. | Compare triggers and decide whether they should be split more clearly, merged, or cross-linked. |
| info | missing-lifecycle | .cursor/skills/add-game-action/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/add-game-action/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | possible-overlap | .cursor/skills/add-game-action/SKILL.md:1 | `.cursor/skills/add-game-action/SKILL.md` and `.cursor/skills/add-game-action/SKILL.md` have token overlap score 1.00. | Compare triggers and decide whether they should be split more clearly, merged, or cross-linked. |
| info | missing-lifecycle | .cursor/skills/add-text-ref/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/add-text-ref/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | possible-overlap | .cursor/skills/add-text-ref/SKILL.md:1 | `.cursor/skills/add-text-ref/SKILL.md` and `.cursor/skills/add-text-ref/SKILL.md` have token overlap score 1.00. | Compare triggers and decide whether they should be split more clearly, merged, or cross-linked. |
| info | missing-lifecycle | .cursor/skills/agent-docs-cli/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/animation-production/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | possible-overlap | .cursor/skills/core-framework-architecture-review/SKILL.md:1 | `.cursor/skills/core-framework-architecture-review/SKILL.md` and `.cursor/skills/core-framework-architecture-review/SKILL.md` have token overlap score 1.00. | Compare triggers and decide whether they should be split more clearly, merged, or cross-linked. |
| info | missing-lifecycle | .cursor/skills/debug-panel-extension/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/debug-panel-extension/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | possible-overlap | .cursor/skills/debug-panel-extension/SKILL.md:1 | `.cursor/skills/debug-panel-extension/SKILL.md` and `.cursor/skills/debug-panel-extension/SKILL.md` have token overlap score 1.00. | Compare triggers and decide whether they should be split more clearly, merged, or cross-linked. |
| info | missing-lifecycle | .cursor/skills/editor-tools-iteration/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/editor-tools-iteration/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | possible-overlap | .cursor/skills/editor-tools-iteration/SKILL.md:1 | `.cursor/skills/editor-tools-iteration/SKILL.md` and `.cursor/skills/editor-tools-iteration/SKILL.md` have token overlap score 1.00. | Compare triggers and decide whether they should be split more clearly, merged, or cross-linked. |
| info | missing-lifecycle | .cursor/skills/feature-iteration/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/feature-iteration/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | possible-overlap | .cursor/skills/feature-iteration/SKILL.md:1 | `.cursor/skills/feature-iteration/SKILL.md` and `.cursor/skills/feature-iteration/SKILL.md` have token overlap score 1.00. | Compare triggers and decide whether they should be split more clearly, merged, or cross-linked. |
| info | missing-lifecycle | .cursor/skills/gameplay-iteration/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/gameplay-iteration/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | possible-overlap | .cursor/skills/gameplay-iteration/SKILL.md:1 | `.cursor/skills/gameplay-iteration/SKILL.md` and `.cursor/skills/gameplay-iteration/SKILL.md` have token overlap score 1.00. | Compare triggers and decide whether they should be split more clearly, merged, or cross-linked. |
| info | missing-lifecycle | .cursor/skills/interactive-architecture-html/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/production-mode/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/production-mode/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | possible-overlap | .cursor/skills/production-mode/SKILL.md:1 | `.cursor/skills/production-mode/SKILL.md` and `.cursor/skills/production-mode/SKILL.md` have token overlap score 1.00. | Compare triggers and decide whether they should be split more clearly, merged, or cross-linked. |
| info | missing-lifecycle | .cursor/skills/pure-data-iteration/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/pure-data-iteration/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | possible-overlap | .cursor/skills/pure-data-iteration/SKILL.md:1 | `.cursor/skills/pure-data-iteration/SKILL.md` and `.cursor/skills/pure-data-iteration/SKILL.md` have token overlap score 1.00. | Compare triggers and decide whether they should be split more clearly, merged, or cross-linked. |
| info | missing-lifecycle | .cursor/skills/push-gamedraft-story-temp-proxy/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/restart-gamedraft/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |

## Inventory

| Type | ID | Title | Path | Source |
|---|---|---|---|---|
| agent_rules | agent..mcp | .mcp | .mcp.json | agent_entry |
| agent_rules | agent.agents | GameDraft Agent Entry | AGENTS.md | agent_entry |
| agent_rules | agent.claude | GameDraft — Claude 工作规则 | CLAUDE.md | agent_entry |
| ci_workflow | .github-workflows-publish-findingdog-dist | 将 Vite 构建产物推送到独立仓库 wubugui/findingdogdist，供帽子云等静态托管拉取。 | .github/workflows/publish-findingdog-dist.yml | github_actions |
| package_script | package-script.assemble-anim-preview-remote | npm run assemble:anim-preview-remote | package.json | package_json |
| package_script | package-script.build | npm run build | package.json | package_json |
| package_script | package-script.build-anim-preview-remote | npm run build:anim-preview-remote | package.json | package_json |
| package_script | package-script.build-gui | npm run build:gui | package.json | package_json |
| package_script | package-script.build-narrative-editor | npm run build:narrative-editor | package.json | package_json |
| package_script | package-script.build-tools | npm run build:tools | package.json | package_json |
| package_script | package-script.build-web-only | npm run build:web-only | package.json | package_json |
| package_script | package-script.dev | npm run dev | package.json | package_json |
| package_script | package-script.dev-anim-preview | npm run dev:anim-preview | package.json | package_json |
| package_script | package-script.dev-narrative-editor | npm run dev:narrative-editor | package.json | package_json |
| package_script | package-script.dev-parallax-editor | npm run dev:parallax-editor | package.json | package_json |
| package_script | package-script.filter-tool | npm run filter-tool | package.json | package_json |
| package_script | package-script.manifest-dev | npm run manifest:dev | package.json | package_json |
| package_script | package-script.manifest-release | npm run manifest:release | package.json | package_json |
| package_script | package-script.package-dev | npm run package:dev | package.json | package_json |
| package_script | package-script.package-release | npm run package:release | package.json | package_json |
| package_script | package-script.planner-gui | npm run planner:gui | package.json | package_json |
| package_script | package-script.preview | npm run preview | package.json | package_json |
| package_script | package-script.release | npm run release | package.json | package_json |
| package_script | package-script.tauri | npm run tauri | package.json | package_json |
| package_script | package-script.tauri-build | npm run tauri:build | package.json | package_json |
| package_script | package-script.tauri-dev | npm run tauri:dev | package.json | package_json |
| package_script | package-script.test | npm run test | package.json | package_json |
| package_script | package-script.test-anim-preview | npm run test:anim-preview | package.json | package_json |
| package_script | package-script.test-tauri | npm run test:tauri | package.json | package_json |
| package_script | package-script.typecheck-anim-preview | npm run typecheck:anim-preview | package.json | package_json |
| package_script | package-script.typecheck-narrative-editor | npm run typecheck:narrative-editor | package.json | package_json |
| package_script | package-script.verify-dev | npm run verify:dev | package.json | package_json |
| package_script | package-script.verify-release | npm run verify:release | package.json | package_json |
| script | bootstrap | GameDraft bootstrap for macOS/Linux. Creates a project venv (.tools/venv) | bootstrap.sh | script |
| script | dev | macOS/Linux task entry: ./dev.sh <task> [args] | dev.sh | script |
| script | scripts-agent_hooks-validation_gate | validation_gate | scripts/agent_hooks/validation_gate.py | script |
| script | scripts-build-player-atlas | build-player-atlas | scripts/build-player-atlas.py | script |
| script | scripts-commit-all | Add DVC/git changes and create a commit. | scripts/commit-all.sh | script |
| script | scripts-console | Open the unified GameDraft control console. | scripts/console.sh | script |
| script | scripts-dev_agent | dev_agent | scripts/dev_agent.cjs | script |
| script | scripts-generate_demo_audio | generate_demo_audio | scripts/generate_demo_audio.py | script |
| script | scripts-ingest_demo_assets | 近黑判定阈值：像素 max(r,g,b) <= 此值才可能被当作背景（从边界泛洪可达才会被抠掉） | scripts/ingest_demo_assets.py | script |
| script | scripts-lib-build_helpers | build_helpers | scripts/lib/build_helpers.mjs | script |
| script | scripts-lib-build_helpers.test | build_helpers.test | scripts/lib/build_helpers.test.mjs | script |
| script | scripts-lib-scene_index | scene_index | scripts/lib/scene_index.mjs | script |
| script | scripts-lib-scene_index.test | scene_index.test | scripts/lib/scene_index.test.mjs | script |
| script | scripts-narrative_cross_graph_endpoint_report | narrative_cross_graph_endpoint_report | scripts/narrative_cross_graph_endpoint_report.py | script |
| script | scripts-package | package | scripts/package.mjs | script |
| script | scripts-pull-all | Pull git and DVC resources. | scripts/pull-all.sh | script |
| script | scripts-push-all | Push DVC resources and git commits. | scripts/push-all.sh | script |
| script | scripts-py | 跨平台 python 入口:优先项目 venv,其次能真实执行的 python3/python。 | scripts/py.sh | script |
| script | scripts-pytool | pytool | scripts/pytool.cjs | script |
| script | scripts-release | release | scripts/release.mjs | script |
| script | scripts-sync-dvc-cache | sync-dvc-cache | scripts/sync-dvc-cache.py | script |
| script | scripts-test_oss_bootstrap_contract | test_oss_bootstrap_contract | scripts/test_oss_bootstrap_contract.py | script |
| script | scripts-verify_build | verify_build | scripts/verify_build.mjs | script |
| script | tools-chronicle_sim_v2-scripts-__init__ | scripts 包：MCP stdio 入口等 | tools/chronicle_sim_v2/scripts/__init__.py | tool_doc |
| script | tools-chronicle_sim_v2-scripts-analyze_npc_context_run | analyze_npc_context_run | tools/chronicle_sim_v2/scripts/analyze_npc_context_run.py | tool_doc |
| script | tools-chronicle_sim_v2-scripts-bootstrap_demo_full_seed_and_sim | bootstrap_demo_full_seed_and_sim | tools/chronicle_sim_v2/scripts/bootstrap_demo_full_seed_and_sim.py | tool_doc |
| script | tools-chronicle_sim_v2-scripts-chroma_mcp_stdio | chroma_mcp_stdio | tools/chronicle_sim_v2/scripts/chroma_mcp_stdio.py | tool_doc |
| script | tools-chronicle_sim_v2-scripts-probe_manual_exercise | probe_manual_exercise | tools/chronicle_sim_v2/scripts/probe_manual_exercise.py | tool_doc |
| script | tools-chronicle_sim_v2-scripts-run_initializer_once | run_initializer_once | tools/chronicle_sim_v2/scripts/run_initializer_once.py | tool_doc |
| script | tools-chronicle_sim_v2-scripts-run_probe_smoke_once | run_probe_smoke_once | tools/chronicle_sim_v2/scripts/run_probe_smoke_once.py | tool_doc |
| script | tools-chronicle_sim_v2-scripts-run_rumor_spread_standalone | run_rumor_spread_standalone | tools/chronicle_sim_v2/scripts/run_rumor_spread_standalone.py | tool_doc |
| script | tools-chronicle_sim_v2-scripts-run_rumor_week_stats | run_rumor_week_stats | tools/chronicle_sim_v2/scripts/run_rumor_week_stats.py | tool_doc |
| script | tools-chronicle_sim_v2-scripts-run_simulation_once | run_simulation_once | tools/chronicle_sim_v2/scripts/run_simulation_once.py | tool_doc |
| script | tools-chronicle_sim_v3-scripts-bootstrap_v2_demo_seed_to_v3 | bootstrap_v2_demo_seed_to_v3 | tools/chronicle_sim_v3/scripts/bootstrap_v2_demo_seed_to_v3.py | tool_doc |
| script | tools-editor-tests-test_lighting_sync_status | 这条为什么值一个测试文件 | tools/editor/tests/test_lighting_sync_status.py | tool_doc |
| script | tools-json_lang-vscode-ext-install | 把本扩展目录符号链接进 VS Code / Cursor 的用户扩展目录(唯一的手动安装步骤)。 | tools/json_lang/vscode-ext/install.sh | tool_doc |
| skill | claude-skill.agent-docs-cli | agent-docs-cli(薄壳) | .claude/skills/agent-docs-cli/SKILL.md | cursor_skill |
| skill | claude-skill.add-game-action | 添加游戏 Action（项目约定） | .cursor/skills/add-game-action/SKILL.md | cursor_skill |
| skill | cursor-skill.add-game-action | 添加游戏 Action（项目约定） | .cursor/skills/add-game-action/SKILL.md | cursor_skill |
| skill | claude-skill.add-text-ref | 文本引用系统扩展清单 | .cursor/skills/add-text-ref/SKILL.md | cursor_skill |
| skill | cursor-skill.add-text-ref | 文本引用系统扩展清单 | .cursor/skills/add-text-ref/SKILL.md | cursor_skill |
| skill | cursor-skill.agent-docs-cli | agent-docs-cli(薄壳) | .cursor/skills/agent-docs-cli/SKILL.md | cursor_skill |
| skill | cursor-skill.animation-production | 动画生产 — agent 入口(SOP) | .cursor/skills/animation-production/SKILL.md | cursor_skill |
| skill | cursor-skill.commit-push-gamedraft | GameDraft 提交 / 推送（git + DVC） | .cursor/skills/commit-push-gamedraft/SKILL.md | cursor_skill |
| skill | claude-skill.core-framework-architecture-review | 核心框架架构审查 | .cursor/skills/core-framework-architecture-review/SKILL.md | cursor_skill |
| skill | cursor-skill.core-framework-architecture-review | 核心框架架构审查 | .cursor/skills/core-framework-architecture-review/SKILL.md | cursor_skill |
| skill | claude-skill.debug-panel-extension | Debug Panel Extension | .cursor/skills/debug-panel-extension/SKILL.md | cursor_skill |
| skill | cursor-skill.debug-panel-extension | Debug Panel Extension | .cursor/skills/debug-panel-extension/SKILL.md | cursor_skill |
| skill | claude-skill.editor-tools-iteration | GameDraft 编辑器工具迭代 | .cursor/skills/editor-tools-iteration/SKILL.md | cursor_skill |
| skill | cursor-skill.editor-tools-iteration | GameDraft 编辑器工具迭代 | .cursor/skills/editor-tools-iteration/SKILL.md | cursor_skill |
| skill | claude-skill.feature-iteration | Feature Iteration | .cursor/skills/feature-iteration/SKILL.md | cursor_skill |
| skill | cursor-skill.feature-iteration | Feature Iteration | .cursor/skills/feature-iteration/SKILL.md | cursor_skill |
| skill | claude-skill.gameplay-iteration | Gameplay Iteration | .cursor/skills/gameplay-iteration/SKILL.md | cursor_skill |
| skill | cursor-skill.gameplay-iteration | Gameplay Iteration | .cursor/skills/gameplay-iteration/SKILL.md | cursor_skill |
| skill | cursor-skill.interactive-architecture-html | 交互式 C4 架构图 HTML（与 architecture-v3 同形） | .cursor/skills/interactive-architecture-html/SKILL.md | cursor_skill |
| skill | claude-skill.production-mode | 策划模式（Production Mode） | .cursor/skills/production-mode/SKILL.md | cursor_skill |
| skill | cursor-skill.production-mode | 策划模式（Production Mode） | .cursor/skills/production-mode/SKILL.md | cursor_skill |
| skill | claude-skill.pure-data-iteration | Pure Data Iteration | .cursor/skills/pure-data-iteration/SKILL.md | cursor_skill |
| skill | cursor-skill.pure-data-iteration | Pure Data Iteration | .cursor/skills/pure-data-iteration/SKILL.md | cursor_skill |
| skill | cursor-skill.push-gamedraft-story-temp-proxy | GameDraft 与 Story 推送（用户提供代理端口，临时代理，不改配置） | .cursor/skills/push-gamedraft-story-temp-proxy/SKILL.md | cursor_skill |
| skill | cursor-skill.restart-gamedraft | GameDraft 重启游戏（开发服） | .cursor/skills/restart-gamedraft/SKILL.md | cursor_skill |
| tool_requirements | tools-asset_browser-requirements | requirements | tools/asset_browser/requirements.txt | tool_doc |
| tool_requirements | tools-chronicle_sim_v2-requirements | requirements | tools/chronicle_sim_v2/requirements.txt | tool_doc |
| tool_requirements | tools-chronicle_sim_v3-requirements | requirements | tools/chronicle_sim_v3/requirements.txt | tool_doc |
| tool_requirements | tools-copy_manager-requirements | requirements | tools/copy_manager/requirements.txt | tool_doc |
| tool_requirements | tools-dialogue_graph_editor-requirements | 图对话编辑器流程画布（OdenGraphQt / PySide6） | tools/dialogue_graph_editor/requirements.txt | tool_doc |
| tool_requirements | tools-editor-requirements | 主编辑器 + 内嵌对话图（与 tools/dialogue_graph_editor/requirements.txt 一致） | tools/editor/requirements.txt | tool_doc |
| tool_requirements | tools-filter_tool-requirements | requirements | tools/filter_tool/requirements.txt | tool_doc |
| tool_requirements | tools-video_to_atlas-requirements | requirements | tools/video_to_atlas/requirements.txt | tool_doc |
| tool_requirements | tools-voice_workbench-requirements | 配音工作台。装进共用 venv：.tools/venv/Scripts/python -m pip install -r tools/voice_workbench/requirements.txt | tools/voice_workbench/requirements.txt | tool_doc |
| workflow_doc | artifact-cursor-workflow-guide | Cursor 工作流使用说明 | artifact/cursor-workflow-guide.md | artifact |
| workflow_doc | docs-plan-production-tooling-requirements | GameDraft 生产工具需求总表 | docs/plan/production-tooling-requirements.md | docs |
| workflow_doc | docs-plan-production-workbench-acceptance-checklist | 生产工作台功能验收清单 | docs/plan/production-workbench-acceptance-checklist.md | docs |
| workflow_doc | docs-plan-production-workbench-acceptance-status | 生产工作台交付验收状态 | docs/plan/production-workbench-acceptance-status.md | docs |
| workflow_doc | tools-anim_preview-readme | 统一动画资源工作台 | tools/anim_preview/README.md | tool_doc |
| workflow_doc | tools-animation_pipeline-readme | animation_pipeline — stabilized clips → game-ready sprite atlas | tools/animation_pipeline/README.md | tool_doc |
| workflow_doc | tools-character_lighting_lab-readme | 角色照明实验室(伪世界 RT / irradiance cache) | tools/character_lighting_lab/README.md | tool_doc |
| workflow_doc | tools-chronicle_sim_v2-readme | ChronicleSim v2 | tools/chronicle_sim_v2/README.md | tool_doc |
| workflow_doc | tools-filter_tool-readme | 滤镜工具 | tools/filter_tool/README.md | tool_doc |
| workflow_doc | tools-json_lang-readme | json_lang —「JSON=语言」工具链(第一块:schema 索引器) | tools/json_lang/README.md | tool_doc |
| workflow_doc | tools-narrative_debugger-readme | 叙事调试器 | tools/narrative_debugger/README.md | tool_doc |
| workflow_doc | tools-narrative_xref-readme | 叙事关系交叉引用（共享基建） | tools/narrative_xref/README.md | tool_doc |
| workflow_doc | tools-scene_relight-readme | 场景重打光工作台(scene_relight) | tools/scene_relight/README.md | tool_doc |
| workflow_doc | tools-task_orchestration_editor-readme | 任务编排工具 | tools/task_orchestration_editor/README.md | tool_doc |
| workflow_doc | tools-video_to_atlas-readme | Video-to-Atlas Workspace (GameDraft) | tools/video_to_atlas/README.md | tool_doc |
| workflow_doc | tools-voice_workbench-readme | 配音工作台 | tools/voice_workbench/README.md | tool_doc |
