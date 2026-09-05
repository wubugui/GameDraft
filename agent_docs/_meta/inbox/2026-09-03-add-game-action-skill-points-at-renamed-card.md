---
target: action-registration-registry-surfaces
date: 2026-09-03
session: 实体轨迹动画（烘焙式）第 12 步 · 文档与知识库收尾
---

现象: `.cursor/skills/add-game-action/SKILL.md` 第 9-10 行指向 `agent_docs/runtime/mechanisms/action-registration-quadruple.md`，该卡已改名为 `action-registration-registry-surfaces.md` —— 死链，照着 skill 走的 agent 读不到登记面全景（同段的"四件套"措辞也随改名过期）。
证据: `grep -rn action-registration-quadruple .cursor/ .claude/` 两处命中；`ls agent_docs/runtime/mechanisms/ | grep action-reg` 只有 `action-registration-registry-surfaces.md`。governance-log §3 第 21 条已把"改名的连带影响（库外）"列为待办，至 2026-09-03 仍未修。
建议: 本轮改动面被限定在 `agent_docs/**` + `docs/**`，故未动 `.cursor/`。修法是把两处路径与措辞同步到新卡名（`.claude/worktrees/**` 下的副本随各自 worktree 自愈，不必单独修）。
