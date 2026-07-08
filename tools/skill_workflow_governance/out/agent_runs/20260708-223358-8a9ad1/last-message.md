本轮未改文件。`selected_references` 为空，以下按治理包和只读抽样证据解释。

**为什么重要**
- `P0 broken-reference`：断链会让 agent 找不到真实入口或验证依据。动画 Skill 明确说“主入口是程序” `.cursor/skills/animation-production/SKILL.md:8`，并要求依据管线 README `.cursor/skills/animation-production/SKILL.md:11`；如果这些引用失效，agent 会改用猜测流程，影响可复现性。
- `P1 drift-risk`：规则写死了当前实现细节，代码一变规则就可能误导 agent。例：Debug Skill 要调用 `mcp_task` 做 review `.cursor/skills/debug-panel-extension/SKILL.md:66`；Action Skill 要同时改运行时、编辑器、校验 `.cursor/skills/add-game-action/SKILL.md:8`、`.cursor/skills/add-game-action/SKILL.md:21`、`.cursor/skills/add-game-action/SKILL.md:26`、`.cursor/skills/add-game-action/SKILL.md:31`。一旦实现已变，后续自动改动会漏步骤。
- `P1 missing-metadata`：Skill 触发条件不够结构化，容易误触发或漏触发。`animation-production` 当前 frontmatter 只有 `name/description` `.cursor/skills/animation-production/SKILL.md:1`，但正文又强约束 agent 只做三类事 `.cursor/skills/animation-production/SKILL.md:8`。这类边界应被机器可读化。
- `P2 missing-lifecycle`：缺 `status / owner / last verified` 会让审计无法判断“已验证”还是“长期没人维护”。生产工具文档有静态日期 `2026-05-31` `docs/plan/production-tooling-requirements.md:3`，但 Skill 本身没有生命周期块 `.cursor/skills/gameplay-iteration/SKILL.md:1`。

**自动处理**
- 断链：能定位新路径的直接替换；明显过期引用删除。
- metadata/lifecycle：批量补统一块，不改正文语义。
- drift-risk：能通过代码对照确认仍正确的，标记已验证。

**需要确认**
- 断链但无法判断是“移动”还是“废弃”的引用。
- drift-risk 中规则与当前实现冲突时，要确认以代码、文档还是产品决策为准。

**建议顺序**
1. 先跑 `P0 broken-reference`，生成确认清单。
2. 再补 `P1 missing-metadata`。
3. 然后处理 `P1 drift-risk`，按 Skill 分批复核。
4. 最后批量补 `P2 missing-lifecycle`。