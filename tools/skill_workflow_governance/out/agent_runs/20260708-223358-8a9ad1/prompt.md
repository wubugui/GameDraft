你是 GameDraft 的 Skill/Workflow 治理 Agent。你在审计控制台里和用户协作。
边界：本轮只分析、分组、提出治理策略和 agent 任务；不要修改文件；不要要求用户逐条手改。
回答要求：中文，短而可执行；优先引用选中的治理包/证据；引用文件时用 path:line；把自动处理、需要确认、建议顺序分清楚。
如果执行了修复，最终必须列出：修改了哪些文件、修了哪类问题、验证命令结果、剩余风险。

审计上下文 JSON：
{
  "stats": {
    "artifact_count": 66,
    "issue_count": 96,
    "by_type": {
      "agent_rules": 1,
      "ci_workflow": 1,
      "package_script": 10,
      "script": 24,
      "skill": 13,
      "tool_requirements": 9,
      "workflow_doc": 8
    },
    "by_severity": {
      "info": 12,
      "warn": 84
    },
    "by_category": {
      "broken-reference": 14,
      "drift-risk": 69,
      "missing-lifecycle": 12,
      "missing-metadata": 1
    }
  },
  "selected_references": [],
  "available_workpacks": [
    {
      "id": "broken-reference",
      "priority": "P0",
      "title": "断链修复包",
      "issue_count": 14,
      "artifact_count": 9,
      "summary": "缺失引用集中处理，不要逐条手改。按文件分组检查改名、移动、删除三种情况。",
      "next": "交给 agent 执行：能确定的路径直接修；明显过期的引用删；无法判断的只列成确认清单。",
      "paths": [
        ".cursor/skills/animation-production/SKILL.md",
        ".cursor/skills/debug-panel-extension/SKILL.md",
        ".cursor/skills/interactive-architecture-html/SKILL.md",
        "docs/plan/production-tooling-requirements.md",
        "tools/animation_pipeline/README.md",
        "tools/chronicle_sim_v2/scripts/run_rumor_spread_standalone.py",
        "tools/chronicle_sim_v2/scripts/run_rumor_week_stats.py",
        "tools/filter_tool/README.md"
      ]
    },
    {
      "id": "drift-risk",
      "priority": "P1",
      "title": "规则漂移复核包",
      "issue_count": 69,
      "artifact_count": 12,
      "summary": "规则/工作流引用的代码或文档更新过，说明文字可能已经落后。",
      "next": "交给 agent 对比规则和当前实现：过时就改规则，仍然正确就标记已验证。",
      "paths": [
        ".cursor/skills/add-game-action/SKILL.md",
        ".cursor/skills/add-text-ref/SKILL.md",
        ".cursor/skills/debug-panel-extension/SKILL.md",
        ".cursor/skills/editor-tools-iteration/SKILL.md",
        ".cursor/skills/gameplay-iteration/SKILL.md",
        ".cursor/skills/production-mode/SKILL.md",
        ".cursor/skills/pure-data-iteration/SKILL.md",
        ".cursor/skills/push-gamedraft-story-temp-proxy/SKILL.md"
      ]
    },
    {
      "id": "missing-metadata",
      "priority": "P1",
      "title": "Skill 触发条件补齐包",
      "issue_count": 1,
      "artifact_count": 1,
      "summary": "Skill 没写清什么时候该用，容易让 Codex 和 Claude 误触发或漏触发。",
      "next": "交给 agent 批量补 when-to-use / when-not-to-use，不改变 skill 正文语义。",
      "paths": [
        ".cursor/skills/animation-production/SKILL.md"
      ]
    },
    {
      "id": "missing-lifecycle",
      "priority": "P2",
      "title": "生命周期元数据补齐包",
      "issue_count": 12,
      "artifact_count": 12,
      "summary": "缺少 status / owner / last verified 这类治理字段，可以标准化批量补。",
      "next": "交给 agent 批量插入统一生命周期块，默认 owner 为 shared，验证日期用本次审计日期。",
      "paths": [
        ".cursor/skills/add-game-action/SKILL.md",
        ".cursor/skills/add-text-ref/SKILL.md",
        ".cursor/skills/animation-production/SKILL.md",
        ".cursor/skills/debug-panel-extension/SKILL.md",
        ".cursor/skills/editor-tools-iteration/SKILL.md",
        ".cursor/skills/feature-iteration/SKILL.md",
        ".cursor/skills/gameplay-iteration/SKILL.md",
        ".cursor/skills/interactive-architecture-html/SKILL.md"
      ]
    }
  ],
  "recent_history": [
    {
      "role": "assistant",
      "content": "我是治理 Agent。你可以切换 Codex / Claude；“发送”是只读分析，“执行修复”会在 GameDraft 工作空间启动 agent CLI 自动改文件，结束后重新诊断。"
    },
    {
      "role": "user",
      "content": "[codex/chat] 你好"
    },
    {
      "role": "assistant",
      "content": "你好，我已加载审计上下文。本轮我只做治理分析和任务拆分，不改文件。\n\n**建议顺序**\n1. `P0 broken-reference`：14 个断链，先交给 agent 批量判定“路径改名 / 文件移动 / 引用过期删除”。\n2. `P1 missing-metadata`：1 个 Skill 触发条件缺失，可自动补 `when-to-use / when-not-to-use`。\n3. `P1 drift-risk`：69 个规则漂移风险，需要对比当前实现后决定更新规则或标记已验证。\n4. `P2 missing-lifecycle`：12 个生命周期字段缺失，可批量补 `status / owner / last verified`。\n\n**自动处理**\n- 断链中能确定的新路径直接修。\n- 明显过期引用删除。\n- 生命周期块统一补齐，默认 `owner: shared`，日期用本次审计日期。\n\n**需要确认**\n- 无法判断的新路径或是否仍需保留的引用。\n- `drift-risk` 中规则描述和实现不一致时，确认以代码还是文档为准。\n\n当前 `selected_references` 为空，所以还没有可引用的具体证据行号。建议先下发 `P0 broken-reference` 的只读诊断任务，生成确认清单后再执行修复。\n\n诊断已更新：issue 96 -> 96"
    }
  ]
}

用户问题：解释这些问题为什么重要