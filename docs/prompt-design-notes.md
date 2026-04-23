# v3 Prompt 设计笔记

状态：Draft（**Provider+Agent 三层重构后** 修订）  
配套：`docs/rfc/v3-llm.md` / `docs/rfc/v3-agent.md` §7 / `docs/plan/v3-implementation.md` P3-1 / P-REFACTOR

---

## 0. 范围

本文档抽 v2 一年来踩过的坑，沉淀 v3 的 prompt 设计原则。每条原则**可被 spec TOML 检查或 review 验证**。

---

## 1. TOML spec 文件结构

v3 推荐结构（v2 风格也兼容；见 `llm/render.py:load_spec`）：

```toml
[meta]
agent_id = "tier_s_npc"

[options]
mcp = "chroma"          # 可选：注入 .clinerules/02_mcp.md
thinking = false

[prompt]
system = """..."""
user = """..."""

[output]
contract = """..."""    # 可选：覆盖 universal_output_contract
```

字段映射规则：

| 字段 | v3 推荐 | v2 兼容 |
|---|---|---|
| system | `[prompt] system` | `[prompts] system` |
| user | `[prompt] user` | `[prompts] user_template` |
| mcp | `[options] mcp` 或顶层 `mcp` | 同 |
| output_contract | `[output] contract` 或顶层 `output_contract` | 同 |

---

## 2. 核心设计原则（v2 经验沉淀）

### 2.1 ACT 模式契约（ClineRunner 路径）

Cline CLI 的 ACT 模式下：
- stdout 通常是 `attempt_completion` 摘要，**不是完整产物**
- 完整 JSON 必须 `write_to_file` 落到 cwd 内的约定文件名（如 `agent_output.json`）
- `ClineRunner`（重构后位于 `agents/runners/cline.py`）优先回读约定文件；stdout 兜底

**spec 必须明确告诉模型**：完整 JSON 写到 `agent_output.json`，attempt_completion 只能一句话。

### 2.2 输出契约（output_contract）

每个生成 JSON 的 spec 必须含 `<output_contract>` 段：
- 「只输出一个合法 JSON 对象，从首字符 `{` 到末字符 `}`」
- 「禁止 Markdown 代码围栏 / 前言后记 / 注释 / 单引号 key」
- 「字段类型严格：list 必须是 `["..."]` 而非单字符串」

`_universal_output_contract.md` 作为公用契约由 ClineBackend 自动注入到 `.clinerules/03_output_contract.md`，spec 内可省略重复段落。

### 2.3 类型严格断言

LLM 经常把字符串字段写成数字 / 把 list 写成单字符串。spec 必须用显式类型表注明：

```
- `mood_delta`: **字符串**（用「焦躁」「沉住气」「平」等中文短标签；禁止数字）
- `target_ids`: **字符串数组**（哪怕只有一项也写 `["x"]`，禁止裸字符串）
```

### 2.4 tier 分层 prompt 风格

| Tier | 字数预算 | 细节程度 |
|---|---|---|
| S | 长（含 mood_delta / relationship_hints / 详细 intent_text） | 高 |
| A | 中（含 mood_delta / target_ids） | 中 |
| B | 短（仅 intent_text 一句） | 低 |

不同 tier 共享 schema 子集，B 必须能在 5-10 token 总结。

### 2.5 种子优先（seed_first）

director / gm / 周末 agent 必须先读 `world_bible_text`：
- 具体地点 / 势力 / 锚点必须**来自种子**
- `event_types` 是「类型学提示」，**不是剧情模板**
- 禁止为了类型而捏造无名 NPC

明确写在 spec `<seed_first>` 段。

### 2.6 拒绝爽文 / 现代梗

- 民国川渝市井底色（本项目设定）
- 禁止修仙词（修炼 / 境界 / 法力 / 灵根 / 系统面板）
- 禁止网络梗 / 中英夹杂 / 现代术语

### 2.7 双层契约（system + universal）

`.clinerules/01_role.md` ← `spec.system`（角色身份与本任务约束）  
`.clinerules/02_mcp.md` ← spec.mcp 描述（如有 chroma）  
`.clinerules/03_output_contract.md` ← `spec.output_contract` 或 `_universal_output_contract.md`

冲突时 spec.system 优先；`_universal` 仅作兜底。

---

## 2.5 不同 Runner 的 prompt 差异（重构新增）

同一个 spec 可被 4 种 Runner 复用，但每种 Runner 看到的 prompt 渲染结果略有不同：

| Runner | 看到的 prompt | 工具调用 | 输出回收 |
|---|---|---|---|
| `cline` | `(.clinerules/01_role + 02_mcp + 03_output_contract, input.md)` 注入 cwd；模型在 ACT 模式内自由读写 | cline 内置：`read_file` / `write_to_file` / `attempt_completion` / MCP tools | `agent_output.json` 文件优先 |
| `simple_chat` | `(system, user)` 单轮拼成 messages，单次 chat | 无（简化路径） | LLM raw text 按 `output_kind` 解析 |
| `react` | `system + _react_protocol.md（公共契约）+ <tools> 段` 多轮 chat | 自定义 tools：`read_key` / `chroma_search` / `final` | 最后一轮 `FINAL: ...` 提交 |
| `external` | spec 渲染后的 `(system + user)` 拼成 `input.md`；子进程自行决定怎么读 | 无（取决于 aider / codex 等外部 agent 的能力） | `${output_file}` 文件回读 |

设计建议：
- **优先写在 spec.user / spec.system 内**：四种 Runner 共享
- **ReAct 工具调用契约**：用 `data/agent_specs/_react_protocol.md` 公共片段，spec 不重复
- **JSON 输出契约**：用 `_universal_output_contract.md` 公共片段，spec 不重复
- **runner 专有指令（如 ACT 模式 attempt_completion 长度限制）**：写在 `_universal_output_contract.md` 而不是 spec.system，避免污染其它 runner

---

## 3. 测试策略

### 3.1 stub 路径单测

每个 spec 在 stub backend 下应：
- 渲染不抛错（缺 var 会被 render 检测）
- 返回稳定占位文本（同 vars 同 spec_ref → 同输出）

### 3.2 真实 LLM 验证

CI 不跑（凭据敏感）。本地手动（**重构后只走 cline runner**，避免 dashscope 风控封号）：

```bash
csim agent test --run runs/dev --agent cline_real \
  --spec data/agent_specs/director.toml \
  --vars '{"week":1,"world_bible_text":"..."}' \
  --output json
```

检查输出是否：
- 形式合法（如 JSON 模式无 ``` 围栏）
- 内容遵守 type_rules
- 不含禁用词

`csim llm test` 仅作 stub backend 的连通性自检，不可用于真实账号。

### 3.3 cache 防回归

改 spec 内容（哪怕一个字）→ `spec_sha` 变 → cache key 变 → miss。CI 测试 `test_chat_e2e_stub.py::test_service_cache_hit_replay` 已覆盖 spec 变化场景。

---

## 4. P3 spec 清单

| spec | 用途 | output | 备注 |
|---|---|---|---|
| `tier_s_npc.toml` | S 档 NPC 周意图 | json_object | mood_delta / target_ids / relationship_hints |
| `tier_a_npc.toml` | A 档 NPC 周意图 | json_object | 简化版 |
| `tier_b_npc.toml` | B 档 NPC 周意图 | json_object | 仅 intent_text |
| `director.toml` | 周事件草稿编导 | json_object | drafts: [{type_id, location_id, actor_ids, summary, draft_json}] |
| `gm.toml` | 草稿裁定为正式事件 | json_object | events: [{id, type_id, truth, witness_accounts, ...}] |
| `rumor.toml` | 谣言改写 | text | 简短传播变体 |
| `week_summarizer.toml` | 周总结 | text | markdown |
| `month_historian.toml` | 月编年史 | text | markdown |
| `style_rewriter.toml` | 风格重写 | text | 按 fingerprint 改写 |
| `initializer.toml` | 种子→世界初始化 | json_object | setting/pillars/anchors/agents/factions/locations |
| `probe.toml` | 探针问答 | text | markdown |

`_universal_output_contract.md` 是 markdown 文本（不是 TOML），由 `ClineRunner`（`agents/runners/cline.py`）自动注入到 `.clinerules/03_output_contract.md`。

新增（重构后）：`_react_protocol.md` 描述 ReAct loop 的 `THOUGHT/TOOL/ARGS/FINAL` 公共契约，由 `ReActRunner` 自动注入到 prompt 内 `<tool_protocol>` 段。
