本轮未修改文件；只做了只读取证和分组。

**自动处理**
- `P0 broken-reference` 先做。证据集中在 `tools/skill_workflow_governance/out/report.md:40` 到 `tools/skill_workflow_governance/out/report.md:105`。
- 可自动改成“生成产物/占位路径”的：`finals.json`、`frame_001.png`、`postprocess.txt`、`custom_presets.json`、`config/llm_config.json`、`world/agents` 等，例如 `tools/animation_pipeline/README.md:20`、`docs/plan/production-tooling-requirements.md:250`、`tools/filter_tool/README.md:23`。
- 可自动改成“可选新建模块示例”的：`src/debug/DebugHelper.ts`，证据 `tools/skill_workflow_governance/out/report.md:44`，原文在 `.cursor/skills/debug-panel-extension/SKILL.md:95`。
- `P1 missing-metadata` 可自动补 `.cursor/skills/animation-production/SKILL.md` 的“何时使用/何时不用”，证据 `tools/skill_workflow_governance/out/report.md:39`；现在只有 frontmatter 和 SOP，见 `.cursor/skills/animation-production/SKILL.md:1`、`.cursor/skills/animation-production/SKILL.md:8`。

**需要确认**
- `.cursor/skills/interactive-architecture-html/SKILL.md:22`、`.cursor/skills/interactive-architecture-html/SKILL.md:23` 声称已有两个架构 HTML，但实际审计报缺失，见 `tools/skill_workflow_governance/out/report.md:60`、`tools/skill_workflow_governance/out/report.md:61`。需要确认是“创建这两个 HTML”，还是把文案改成“建议输出路径，当前未落地”。
- `P1 drift-risk` 不建议盲改。它只是说明引用文件更新过，例如 Action 规则引用的 `src/core/ActionRegistry.ts`、`tools/editor/shared/action_editor.py` 比 skill 新，见 `tools/skill_workflow_governance/out/report.md:29` 到 `tools/skill_workflow_governance/out/report.md:37`。若发现规则和代码冲突，再确认以代码、文档还是设计意图为准。

**建议顺序**
1. 先执行 `P0 broken-reference`：只修确定性断链；无法判断的输出确认清单。
2. 再补 `P1 missing-metadata`：只给 `animation-production` 加触发/排除条件，不改 SOP 语义。
3. 然后做 `P1 drift-risk` 复核：逐组对比当前实现，正确则标记已验证，过时才改规则。
4. 最后做 `P2 missing-lifecycle`：补 `status / owner / last_verified`。不要提前补，否则会刷新文件时间，掩盖 drift-risk。
5. 复验命令用 `python3 -B tools/skill_workflow_governance/govern.py audit`，工具入口见 `tools/skill_workflow_governance/README.md:18`，参数默认 drift 14 天见 `tools/skill_workflow_governance/skill_workflow_governance/cli.py:19`。