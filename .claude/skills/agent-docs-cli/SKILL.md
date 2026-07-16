---
name: agent-docs-cli
description: >-
  agent_docs 公共知识库治理台 CLI 的统一入口。凡遇治理类业务——治理 agent 文档/一键治理/
  更新知识库/建库/蒸馏记忆/govern agent docs/收编方法论/炼化经验/这个坑入库/记到库里/
  intake——先跑 python3 agent_docs/_meta/cli.py,从中现场发现并取用权威流程文件照做。
  本壳不含任何流程内容。
---

# agent-docs-cli(薄壳)

治理类业务统一走 CLI,现场发现流程,不要凭记忆发挥:

```
python3 agent_docs/_meta/cli.py list             # 列出所有治理流程
python3 agent_docs/_meta/cli.py route "一句话"    # 按业务描述匹配流程
python3 agent_docs/_meta/cli.py get <id>         # 打印权威正文,读它并严格照做
python3 agent_docs/_meta/cli.py audit [...]      # 机械体检/索引/--paths 查必读卡
```

权威正文全部在 `agent_docs/_meta/<id>-skill.md`;本壳与 CLI 都不复制正文。
