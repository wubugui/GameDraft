# Skill / Workflow Governance

这个独立工具用来先把项目里的 skill 和 workflow 看清楚，并把治理过程放进一个 Agent Workbench：它扫描入口规则、Cursor/Codex/Claude 风格的 skill、工作流文档、脚本入口和 `package.json` scripts，然后生成可审计的清单、问题报告、本地 dashboard、agent 可感知的 Host Hub，以及一个 stdio MCP server。

治理台现在不是简单日志页。它有四层：

- `registry`：扫描出来的事实、治理包、证据和资产清单。
- `Agent Workbench`：页面里的 MCP Host 风格画布，展示 apps / resources / tools / prompts。
- `Agent shell`：Codex / Claude / Local 可切换执行壳，发送任务时自动携带当前 canvasState 和 Host/MCP 快照。
- `MCP server`：可被外部 MCP client 连接的 stdio JSON-RPC server。

第一阶段重点是 skill / workflow 治理：

- skill / workflow 在哪里
- 每个条目的标题、来源、触发线索、命令和引用
- 引用路径是否断裂
- skill 是否缺少触发条件或生命周期信息
- 文档 / skill 是否可能落后于它引用的文件
- skill 之间是否可能重叠

## 运行

在项目根目录执行：

```bash
python3 tools/skill_workflow_governance/govern.py audit
```

默认输出：

```text
tools/skill_workflow_governance/out/registry.json
tools/skill_workflow_governance/out/report.md
tools/skill_workflow_governance/out/dashboard.html
tools/skill_workflow_governance/out/inventory.csv
tools/skill_workflow_governance/out/agent-context-current.md
```

打开静态 dashboard：

```bash
open tools/skill_workflow_governance/out/dashboard.html
```

也可以从项目控制台打开：

```bash
./scripts/console.sh
```

然后点击 `Skill/Workflow 治理`，控制台会运行 audit 并自动打开 dashboard。

治理台 URL：

```text
http://127.0.0.1:<console-port>/governance/
```

## Agent Workbench

治理台上方的 `Agent Workbench` 是 agent 的工作环境快照：

- `应用`：内置治理应用和外部 MCP/命令应用，可启用/停用，也可添加自定义应用。
- `资源`：`governance://hub`、`governance://canvas/current`、`governance://workpacks`、`governance://issues` 等结构化资源。
- `工具`：`governance.scan`、`governance.read_resource`、`governance.open_source`、`governance.apply_patch`、`governance.add_app` 等 host 侧动作。
- `提示词`：治理总览、自动/确认分流、修复计划，以及每个治理包对应的 prompt。

当页面向 Codex / Claude 发送任务时，会把当前选中引用、筛选条件、启用应用、resources/tools/prompts 一起写入 prompt。Agent 不需要猜页面内容，也不需要靠截图理解治理台。

## Codex / Claude 直接引用

治理页面只是可视化层。给 Codex、Claude 或其它 agent client 的稳定入口是：

```text
tools/skill_workflow_governance/out/agent-context-current.md
```

每次运行 `python3 -B tools/skill_workflow_governance/govern.py audit` 都会刷新这个文件。它包含：

- 客户端工作边界
- `registry.json` / `report.md` / `dashboard.html` 路径
- MCP server 配置片段
- `governance://...` 资源清单
- 可调用工具清单
- 治理包摘要和每个治理包的 agent prompt
- compact Host snapshot JSON

页面里每个数据元素都有稳定引用。核心 URI 模式：

```text
governance://dashboard/elements
governance://workpack/<id>
governance://issue/<id>
governance://artifact/<id>
governance://app/<id>
governance://tool/<name>
governance://prompt/<name>
governance://source/<path>
governance://stat/<id>
governance://view/<id>
```

dashboard 会在对应卡片、行、路径 chip、应用、资源、工具、prompt 上挂 `data-ref-uri`，并提供“引用 / 复制 URI”。MCP client 可以用 `resources/read` 读取同一个 URI。

推荐用法：

- Codex：让客户端读取根目录 `AGENTS.md`，或直接引用 `tools/skill_workflow_governance/out/agent-context-current.md`。
- Claude：`CLAUDE.md` 已列出治理入口；也可以在对话里 `@tools/skill_workflow_governance/out/agent-context-current.md`。
- 支持 MCP 的客户端：连接本 README 下方的 `gamedraft-governance` MCP server，再读取 `governance://hub` 或具体 `governance://workpack/<id>`。

## MCP server

启动 stdio MCP server：

```bash
python3 -B tools/skill_workflow_governance/mcp_server.py /Users/dannyteng/AIWork/GameDraft
```

MCP client 配置示例：

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

它支持：

- `resources/list`
- `resources/read`
- `tools/list`
- `tools/call`
- `prompts/list`
- `prompts/get`

核心资源：

- `governance://hub`
- `governance://canvas/current`
- `governance://audit/stats`
- `governance://workpacks`
- `governance://issues`
- `governance://artifacts`
- `governance://apps`
- `governance://agent/jobs`

核心工具：

- `governance.scan`
- `governance.read_resource`
- `governance.list_apps`
- `governance.add_app`
- `governance.enable_app`

## 常用参数

```bash
python3 tools/skill_workflow_governance/govern.py audit \
  --root . \
  --out tools/skill_workflow_governance/out \
  --stale-days 45 \
  --drift-days 14
```

- `--stale-days 0`：关闭“久未更新”提示
- `--drift-days 0`：关闭“引用文件比文档更新”提示
- `--json`：同时把完整 registry JSON 打到 stdout

## 输出怎么看

- `Inventory`：所有扫描到的 skill / workflow / script / package script。
- `Issues`：确定性问题和低置信风险，按 error / warn / info 排序。
- `Agent Workbench`：agent 当前可感知的应用、资源、工具和提示词。
- `治理包`：按 P0/P1/P2/P3 分组后的治理任务，不需要逐条看原始 issue。
- `证据库`：原始问题列表，可逐条引用给 agent。
- `Agent 原始输出`：外部 Codex/Claude CLI 的 stdout/stderr 原样输出，同时落盘到 `out/agent_runs/<job>/stdout.log`。

## 当前扫描范围

- `.cursor/skills/*/SKILL.md`
- `.claude/skills/*/SKILL.md`
- `.codex/skills/*/SKILL.md`
- `CLAUDE.md`、`AGENTS.md`、`.mcp.json`
- `.github/workflows/*`
- `docs/**/*workflow*` / `docs/**/*流程*` / `docs/**/*requirements*` / `docs/**/*checklist*` / `docs/**/*status*` / `docs/**/*guide*`
- `artifact/cursor-workflow-guide.md`
- `tools/*/README.md`
- `tools/*/requirements.txt`
- `scripts/**`
- `dev.sh`、`bootstrap.sh`
- `package.json` scripts

## 设计边界

这个工具现在只治理 skill / workflow，不治理所有代码和文档。后续要扩大范围时，优先新增扫描器、resources、tools 和 policy gate，而不是让 agent 直接口头判断。

写入边界：

- `chat` 模式只读，只做分析和计划。
- `fix` 模式允许 agent 在 GameDraft 工作空间内修改被引用治理项。
- 修复后控制台会自动运行 `python3 -B tools/skill_workflow_governance/govern.py audit` 刷新诊断。
- 不触碰 `~/AIWork/agent-canvas-os`。
