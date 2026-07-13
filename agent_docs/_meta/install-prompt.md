# 治理台一句话安装

**用户只需做一件事**:用任意 agent 打开本项目后,把下面这句原样发给它:

```
读 agent_docs/_meta/install-prompt.md 并严格照做,把 agent_docs 治理台装进你这个客户端,完成后报告。
```

幂等:对已装好的客户端重复执行只会校验/修复。

---

## agent 收到上面那句后,照此执行

你要装三样东西(能装几样装几样,层层降级不强求):①「治理台 CLI 薄壳」——让未来会话
遇到治理类业务(治理/建库/收编/炼化/intake…)时能发现统一入口
`python3 agent_docs/_meta/cli.py`;②「开工闸门块」——让你客户端**每会话自动载入**的
指令文件里带上"动手前查 agent_docs 必读卡"的指引;③「强制层 hook」——若你客户端有
编辑后事件钩子机制,把 `agent_docs/_meta/hooks/paths_reminder.py` 接上:编辑命中登记
路径时自动提醒读卡(①②③均为 2026-07-11 制作人批准的接线)。

1. 在仓库根跑 `python3 agent_docs/_meta/cli.py list`,确认 CLI 可用、能看到全部治理流程。
2. 按你客户端的项目级技能/规则发现机制安装(你最了解你自己,自行判断):
   - **Cursor / Claude Code / 读 CLAUDE.md 或 AGENTS.md 的客户端(如 Codex)** →
     直接跑 `python3 agent_docs/_meta/cli.py install`,完成(自动:安装/修复薄壳、清理旧的
     分流程壳、闸门块接进 CLAUDE.md 与 AGENTS.md、强制层 hook 接进 .claude/settings.json)。
   - **其它客户端,有"目录+文件"式技能机制** → `python3 agent_docs/_meta/cli.py install
     --dir <你的技能目录>`;若格式不是 SKILL.md 惯例,`install --print` 取薄壳内容自行适配。
     另跑 `install --print-gate` 取闸门块接进你客户端自动载入的指令/规则文件;若你的
     客户端有编辑后事件钩子,`install --print-hook` 取强制层接法(脚本支持
     `paths_reminder.py <文件路径> [会话id]` 纯文本通用模式)。
   - **没有任何技能机制** → 只接闸门块(若你有自动载入文件),否则什么都不建,
     回复说明你将按需直接访问 CLI。
3. **硬约束(任何客户端一样)**:壳内只有触发词 + CLI 用法,禁止复制任何流程正文;
   对 CLAUDE.md / AGENTS.md 等全局指令文件,**只允许写入带标记的闸门块**
   (`<!-- agent-docs-gate:begin/end -->`,由 install 维护),不得改动其余内容;
   发现旧的分流程壳(agent-docs-governance / agent-docs-intake)一律删除。
4. 自检:`python3 agent_docs/_meta/cli.py route "收编方法论"` 应返回 intake 流程;
   你客户端的自动载入文件中能看到闸门块。
5. 报告:装在了哪些路径 + 薄壳/闸门位置;或说明为何无需安装。
