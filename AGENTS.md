# GameDraft Agent Entry

This repository uses `CLAUDE.md` as the full project rulebook. Codex agents should read and follow `CLAUDE.md` first, then apply any narrower instructions from the current task.

<!-- agent-docs-gate:begin (由 agent_docs/_meta/cli.py install 维护,勿手改) -->
## §A 开工先查公共知识库(agent_docs)

- 动手前按任务域读 `agent_docs/INDEX.md` 对应条目;确定要改的文件后跑
  `python3 agent_docs/_meta/audit.py --paths <files...>` 取必读机制卡,先读卡再动手。
- 治理类业务(治理/建库/收编方法论/炼化/intake)统一入口:`python3 agent_docs/_meta/cli.py`。
- 发现库内文档与现实打架:收尾往 `agent_docs/_meta/inbox/` 丢一条三行偏差记录(零门槛)。
<!-- agent-docs-gate:end -->

## Governance Context

For Skill / Workflow governance tasks, do not use the dashboard screenshot as source of truth. Use one of these structured entry points:

- `tools/skill_workflow_governance/out/agent-context-current.md`: portable context pack for Codex / Claude clients.
- `tools/skill_workflow_governance/out/registry.json`: full machine-readable audit state.
- `governance://hub`: MCP Host snapshot when the governance MCP server is connected.
- `governance://dashboard/elements`: index of every referenceable dashboard element.
- `governance://workpacks`, `governance://issues`, `governance://artifacts`: structured governance resources.
- `governance://workpack/<id>`, `governance://issue/<id>`, `governance://artifact/<id>`, `governance://tool/<name>`, `governance://prompt/<name>`, `governance://source/<path>`: individual dashboard elements.

Refresh governance outputs before relying on them:

```bash
python3 -B tools/skill_workflow_governance/govern.py audit
```

MCP server configuration for capable clients:

```json
{
  "mcpServers": {
    "gamedraft-governance": {
      "command": "python3",
      "args": [
        "-B",
        "tools/skill_workflow_governance/mcp_server.py",
        "/Users/dannyteng/AIWork/GameDraft"
      ]
    }
  }
}
```

In read-only governance analysis, do not modify files. In fix work, only edit files implicated by the selected workpacks or evidence, then rerun the audit command above and report remaining risk.
