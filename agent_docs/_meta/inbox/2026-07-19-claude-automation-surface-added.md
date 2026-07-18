---
target: missing
date: 2026-07-19
session: Claude 自动化面搭建(subagent + skill 镜像)
---

现象: Claude Code 侧新增两个存放面,库里没有对应的存放面卡:① `.claude/agents/` 新建 validator(校验门执行者,只报告不修复)与 headless-runner(无头验证驾驶员,开工强制先读 runtime-command-channel 与 headless-visual-verification 两张配方卡);② `.claude/skills/` 把 .cursor/skills 中 9 个工作流/能力 skill 以「真目录 + SKILL.md 文件级 symlink」曝光给 Claude 客户端。**定位澄清(初版本记录表述有误,已改)**:知识真源是 agent_docs 卡,.cursor/skills 是治理体系维护的流程壳(2026-07-11 治理 run 已挂引用化、intake 持续直接维护其文件);symlink 只是客户端曝光面,好处是 intake 改 .cursor 侧壳文件时 Claude 侧零同步成本。agent-docs-cli 薄壳属 `cli.py install` 管辖,symlink 形态已被 install 幂等检查确认"已是最新"。
证据: `.claude/agents/{validator,headless-runner}.md`(会话内已热加载可委派);`ls -la .claude/skills/*/SKILL.md` 全部为指向 ../../../.cursor/skills/ 的 symlink 且 name 解析正常;`python3 agent_docs/_meta/cli.py install --client claude` 输出四项"已是最新";validator 内命令实测(tsc 过、两套 pytest 收集 874 条)。
建议: 治理时:①考虑给「客户端存放面」立一张小卡(`.cursor/skills`=流程壳真文件、`.claude/skills`=symlink 曝光面、`.claude/agents`=Claude 专属 subagent),约束:.cursor 侧 skill 若新增 SKILL.md 之外的附属文件需同步补 symlink;②tools/skill_workflow_governance 审计对 symlink 镜像对报的 possible-overlap 属 by-design,勿当问题修;③restart-gamedraft skill 引用 Windows .cmd 已失效,建议废弃或重写。
