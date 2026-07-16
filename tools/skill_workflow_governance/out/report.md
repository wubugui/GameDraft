# Skill / Workflow Governance Report

- Generated: `2026-07-11T10:16:38`
- Root: `/Users/dannyteng/AIWork/GameDraft`
- Artifacts: `70`
- Issues: `25`

## Summary

### Artifacts By Type

- `agent_rules`: `2`
- `ci_workflow`: `1`
- `package_script`: `11`
- `script`: `24`
- `skill`: `15`
- `tool_requirements`: `9`
- `workflow_doc`: `8`

### Issues By Severity

- `info`: `15`
- `warn`: `10`

## Issues

| Severity | Category | Artifact | Evidence | Suggestion |
|---|---|---|---|---|
| warn | missing-metadata | .claude/skills/agent-docs-cli/SKILL.md:1 | No obvious trigger/use/scope section was detected. | Add a short 'when to use / when not to use' section near the top of the skill. |
| warn | missing-metadata | .cursor/skills/agent-docs-cli/SKILL.md:1 | No obvious trigger/use/scope section was detected. | Add a short 'when to use / when not to use' section near the top of the skill. |
| warn | missing-metadata | .cursor/skills/animation-production/SKILL.md:1 | No obvious trigger/use/scope section was detected. | Add a short 'when to use / when not to use' section near the top of the skill. |
| warn | drift-risk | .cursor/skills/gameplay-iteration/SKILL.md:22 | `docs/玩法功能需求清单.md` is about 16 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/gameplay-iteration/SKILL.md:33 | `docs/玩法功能需求清单.md` is about 16 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/gameplay-iteration/SKILL.md:58 | `docs/玩法功能需求清单.md` is about 16 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | .cursor/skills/push-gamedraft-story-temp-proxy/SKILL.md:20 | `.git/config` is about 20 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | artifact/cursor-workflow-guide.md:42 | `docs/玩法功能需求清单.md` is about 16 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | artifact/cursor-workflow-guide.md:47 | `docs/玩法功能需求清单.md` is about 16 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| warn | drift-risk | artifact/cursor-workflow-guide.md:138 | `src/core/Game.ts` is about 28 days newer than this file. | Check whether the skill/workflow still describes the current implementation. |
| info | missing-lifecycle | .claude/skills/agent-docs-cli/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | possible-overlap | .claude/skills/agent-docs-cli/SKILL.md:1 | `.claude/skills/agent-docs-cli/SKILL.md` and `.cursor/skills/agent-docs-cli/SKILL.md` have token overlap score 1.00. | Compare triggers and decide whether they should be split more clearly, merged, or cross-linked. |
| info | missing-lifecycle | .cursor/skills/add-game-action/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/add-text-ref/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/agent-docs-cli/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/animation-production/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/debug-panel-extension/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/editor-tools-iteration/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/feature-iteration/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/gameplay-iteration/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/interactive-architecture-html/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/production-mode/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/pure-data-iteration/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/push-gamedraft-story-temp-proxy/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |
| info | missing-lifecycle | .cursor/skills/restart-gamedraft/SKILL.md:1 | No status/owner/last-verified style metadata was detected. | Consider adding status, owner, and last verified fields once the registry format is settled. |

## Inventory

| Type | ID | Title | Path | Source |
|---|---|---|---|---|
| agent_rules | agent.agents | GameDraft Agent Entry | AGENTS.md | agent_entry |
| agent_rules | agent.claude | GameDraft — Claude 工作规则 | CLAUDE.md | agent_entry |
| ci_workflow | .github-workflows-publish-findingdog-dist | 将 Vite 构建产物推送到独立仓库 wubugui/findingdogdist，供帽子云等静态托管拉取。 | .github/workflows/publish-findingdog-dist.yml | github_actions |
| package_script | package-script.build | npm run build | package.json | package_json |
| package_script | package-script.build-narrative-editor | npm run build:narrative-editor | package.json | package_json |
| package_script | package-script.dev | npm run dev | package.json | package_json |
| package_script | package-script.dev-anim-preview | npm run dev:anim-preview | package.json | package_json |
| package_script | package-script.dev-narrative-editor | npm run dev:narrative-editor | package.json | package_json |
| package_script | package-script.dev-parallax-editor | npm run dev:parallax-editor | package.json | package_json |
| package_script | package-script.filter-tool | npm run filter-tool | package.json | package_json |
| package_script | package-script.planner-gui | npm run planner:gui | package.json | package_json |
| package_script | package-script.preview | npm run preview | package.json | package_json |
| package_script | package-script.test | npm run test | package.json | package_json |
| package_script | package-script.typecheck-narrative-editor | npm run typecheck:narrative-editor | package.json | package_json |
| script | bootstrap | GameDraft bootstrap for macOS/Linux. Creates a project venv (.tools/venv) | bootstrap.sh | script |
| script | dev | macOS/Linux task entry: ./dev.sh <task> [args] | dev.sh | script |
| script | scripts-build-player-atlas | build-player-atlas | scripts/build-player-atlas.py | script |
| script | scripts-commit-all | Add DVC/git changes and create a commit. | scripts/commit-all.sh | script |
| script | scripts-console | Open the unified GameDraft control console. | scripts/console.sh | script |
| script | scripts-generate_demo_audio | generate_demo_audio | scripts/generate_demo_audio.py | script |
| script | scripts-ingest_demo_assets | 近黑判定阈值：像素 max(r,g,b) <= 此值才可能被当作背景（从边界泛洪可达才会被抠掉） | scripts/ingest_demo_assets.py | script |
| script | scripts-narrative_cross_graph_endpoint_report | narrative_cross_graph_endpoint_report | scripts/narrative_cross_graph_endpoint_report.py | script |
| script | scripts-pull-all | Pull git and DVC resources. | scripts/pull-all.sh | script |
| script | scripts-push-all | Push DVC resources and git commits. | scripts/push-all.sh | script |
| script | scripts-pytool | pytool | scripts/pytool.cjs | script |
| script | scripts-sync-dvc-cache | sync-dvc-cache | scripts/sync-dvc-cache.py | script |
| script | scripts-test_oss_bootstrap_contract | test_oss_bootstrap_contract | scripts/test_oss_bootstrap_contract.py | script |
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
| skill | claude-skill.agent-docs-cli | agent-docs-cli(薄壳) | .claude/skills/agent-docs-cli/SKILL.md | cursor_skill |
| skill | cursor-skill.add-game-action | 添加游戏 Action（项目约定） | .cursor/skills/add-game-action/SKILL.md | cursor_skill |
| skill | cursor-skill.add-text-ref | 文本引用系统扩展清单 | .cursor/skills/add-text-ref/SKILL.md | cursor_skill |
| skill | cursor-skill.agent-docs-cli | agent-docs-cli(薄壳) | .cursor/skills/agent-docs-cli/SKILL.md | cursor_skill |
| skill | cursor-skill.animation-production | 动画生产 — agent 入口(SOP) | .cursor/skills/animation-production/SKILL.md | cursor_skill |
| skill | cursor-skill.core-framework-architecture-review | 核心框架架构审查 | .cursor/skills/core-framework-architecture-review/SKILL.md | cursor_skill |
| skill | cursor-skill.debug-panel-extension | Debug Panel Extension | .cursor/skills/debug-panel-extension/SKILL.md | cursor_skill |
| skill | cursor-skill.editor-tools-iteration | GameDraft 编辑器工具迭代 | .cursor/skills/editor-tools-iteration/SKILL.md | cursor_skill |
| skill | cursor-skill.feature-iteration | Feature Iteration | .cursor/skills/feature-iteration/SKILL.md | cursor_skill |
| skill | cursor-skill.gameplay-iteration | Gameplay Iteration | .cursor/skills/gameplay-iteration/SKILL.md | cursor_skill |
| skill | cursor-skill.interactive-architecture-html | 交互式 C4 架构图 HTML（与 architecture-v3 同形） | .cursor/skills/interactive-architecture-html/SKILL.md | cursor_skill |
| skill | cursor-skill.production-mode | 策划模式（Production Mode） | .cursor/skills/production-mode/SKILL.md | cursor_skill |
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
| tool_requirements | tools-scene_depth_editor-requirements | requirements | tools/scene_depth_editor/requirements.txt | tool_doc |
| tool_requirements | tools-video_to_atlas-requirements | requirements | tools/video_to_atlas/requirements.txt | tool_doc |
| workflow_doc | artifact-cursor-workflow-guide | Cursor 工作流使用说明 | artifact/cursor-workflow-guide.md | artifact |
| workflow_doc | docs-plan-production-tooling-requirements | GameDraft 生产工具需求总表 | docs/plan/production-tooling-requirements.md | docs |
| workflow_doc | docs-plan-production-workbench-acceptance-checklist | 生产工作台功能验收清单 | docs/plan/production-workbench-acceptance-checklist.md | docs |
| workflow_doc | docs-plan-production-workbench-acceptance-status | 生产工作台交付验收状态 | docs/plan/production-workbench-acceptance-status.md | docs |
| workflow_doc | tools-animation_pipeline-readme | animation_pipeline — stabilized clips → game-ready sprite atlas | tools/animation_pipeline/README.md | tool_doc |
| workflow_doc | tools-chronicle_sim_v2-readme | ChronicleSim v2 | tools/chronicle_sim_v2/README.md | tool_doc |
| workflow_doc | tools-filter_tool-readme | 滤镜工具 | tools/filter_tool/README.md | tool_doc |
| workflow_doc | tools-video_to_atlas-readme | Video-to-Atlas Workspace (GameDraft) | tools/video_to_atlas/README.md | tool_doc |
