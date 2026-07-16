# agent_docs — 面向所有 agent 的公共知识库

对项目理解的**缓存**:只存不变量、工作法、机制指路牌、配方、决策记录。
ground truth 在代码与实践史里;会漂移的事实不收(收录标准见
[_meta/constitution.md](_meta/constitution.md),frontmatter 契约见
[_meta/schema.md](_meta/schema.md))。

## 怎么用(任何 agent)

1. **按任务找**:读 [INDEX.md](INDEX.md)(生成物,按域×类型分组,每篇一行钩子)。
2. **按改动文件找**:`python3 agent_docs/_meta/audit.py --paths <将改动的文件...>`
   → 输出这些路径登记的必读机制卡。
3. **发现文档和现实打架**:往 [_meta/inbox/](_meta/inbox/README.md) 丢一条偏差记录(零门槛)。

## 怎么治理

- **统一入口 = 治理台 CLI**:遇到任何治理类业务先跑
  `python3 agent_docs/_meta/cli.py list`(或 `route "业务一句话"`),现场发现流程,
  再 `get <id>` 取权威正文照做。现有流程:governance(深度治理)、intake(零散知识收编)。
- 流程注册即文件:`_meta/<id>-skill.md` + frontmatter,CLI 自动发现;新增治理流程零接线。
- 新客户端接入 = **对任何 agent 贴一句话**(幂等,已装:Cursor、Claude Code):
  `读 agent_docs/_meta/install-prompt.md 并严格照做,把 agent_docs 治理台装进你这个客户端,完成后报告。`
  agent 会按自身客户端机制自适配(细则在 [_meta/install-prompt.md](_meta/install-prompt.md))。
- 机械体检+索引重生成:`python3 agent_docs/_meta/cli.py audit`(门禁模式加 `--check`)。
- `INDEX.md` 与 `paths-triggers.json` 是生成物,**禁止手写**。
