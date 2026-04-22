# 给实施 Agent 的提示词（v3 PR 通用模板）

> 用法：复制下面 ` ``` ` 包起来的整段文本，把 `<<PR-ID>>` 与 `<<PR-标题>>` 换成具体值，发给其它 cloud agent。

---

```text
# 任务：ChronicleSim v3 实施 — <<PR-ID>>: <<PR-标题>>

## 背景

你在 GameDraft 项目里实施 ChronicleSim v3 的一个具体 PR。v3 是对 v2 的完全重写，
采用「图驱动算法 + 统一 LLM 抽象 + CLI/GUI 解耦」三大原则。

完整架构 RFC 与实施计划已经写好，是本次任务的**唯一权威**（master 分支已合并，
若未合并则在 PR #8 / 分支 cursor/v3-architecture-rfc-d630）：

- docs/rfc/v3-engine.md          引擎核心（Context / Node / Graph / Cook / Cache）
- docs/rfc/v3-llm.md             LLM 抽象层（Service / Backend / Limiter / Cache / Audit）
- docs/plan/v3-node-catalog.md   84 个 builtin NodeKind 清单
- docs/plan/v3-implementation.md 33 PR 阶段拆解（P0–P5）

**第一步：打开这 4 份文档完整读一遍**。任何与 RFC 矛盾的实现选择都是错的，
RFC 之外的设计自由由你判断，但要保守、最小化、可解释。

## 本 PR 的范围

参见 docs/plan/v3-implementation.md 中 <<PR-ID>> 一节。该节列了：
- 包含的文件 / 模块
- 关键接口与签名
- 测试清单
- 验收标准

**严格按该节实现**。不要做该节范围外的事，哪怕看起来「顺手」（比如顺便实现下个 PR
的某个节点）——这会破坏 PR review 边界。如果发现 RFC / 计划本身有错或不清，
不要擅自决定，**在 PR 里以「待澄清」comment 标出**。

## 工作流

1. **创建分支**：`git checkout -b cursor/v3-<<PR-ID>>-<short-desc>-<random-suffix>` （从 master）
2. **读 RFC + 本 PR 节**
3. **实施**：按 RFC 接口签名 1:1 实现；写代码注释只解释「为什么」不解释「做什么」
4. **写测试**：按本 PR 节的测试清单写；覆盖率要求见后面「质量门槛」
5. **本地跑 CI**：`pytest tools/chronicle_sim_v3/tests` 全绿 + 层级隔离测试通过
6. **commit**：每个逻辑变更独立 commit，commit msg 用 `feat(v3): ...` / `test(v3): ...` / `docs(v3): ...`
7. **push + 开 PR**：标题 `<<PR-ID>>: <<PR-标题>>`；PR 描述用下面 PR 描述模板
8. **自检**：合上 PR 前，对照 RFC 与本 PR 节逐条打勾（在 PR 描述里勾选）
9. **不要合并**：开 draft PR 等用户 review

## 硬约束（违反即拒绝合并）

### 隔离

- 任何 v3 文件 **0 行 import** `tools.chronicle_sim_v2.*`（CI lint 会拒）
- `engine/` `llm/` `nodes/` `cli/` 任何文件 **不许 import** PySide6 / Qt（CI lint 会拒）
- `engine/` `nodes/` 不许 import `cli/` 或 `gui/`（CI lint 会拒）
- 业务节点不许直接 IO 写 Run 目录，**所有写都通过返回 Mutation**（runtime 沙箱 + lint 双重保护）
- 业务节点不许直接调 httpx / Cline / openai SDK，**LLM 调用只能通过 LLMService**

### Cache 安全（v3-engine.md §10 是必读）

- 任何节点的 cache key 必须按 RFC §10.2 的所有 component 计算；**漏掉一个就可能命中错值**
- write.* 节点永不缓存（cacheable=False）
- agent.cline 节点 deterministic=False（默认不命中除非用户显式 cache: hash）
- 节点行为有任何改动，`spec.version` 必须 bump
- CI 防回归测试不能跳

### LLM

- llm.yaml 里出现 `api_key:` 字面量直接拒绝；必须 `api_key_ref: env:VAR` 或 `file:path`
- API key 永不进日志（audit / timeline / EventBus 全部）
- `routes:` 是必需的；业务节点引用逻辑模型 id（routes key），物理 id 在 routes 表
- agent.cline 节点除了 LLMService 不许调任何外部

### 文件格式

- 所有写出的 yaml 走 `engine/io.py` 的 canonical 写出函数；保证「读 → 写」二进制一致
- mutation key 必须用 RFC §5.6 的格式；不许节点自己拼路径

### 表达式

- 表达式求值器只支持 RFC §7.3 的 BNF 子集；禁止 lambda / 推导式 / `__attribute__` / import / eval
- 节点参数表达式由 GraphLoader 静态解析；不允许运行时动态构造表达式字符串再 eval

## 质量门槛

- 单测：每个新增公开函数 / 类都要有；覆盖率不强求 100% 但关键路径必须覆盖
- 端口标签：每个 NodeKind 的输入输出端口标签必须明确（不许全 Any）
- reads/writes 声明：必须如实，CI 会 ast 扫描检测
- 文档：节点必须有 docstring；CLI 命令必须有 typer help 字符串
- error 信息：所有抛出的异常必须含足够上下文（cook_id / node_id / 关键字段值）让人能定位

## 不要做的事

- 不要 import v2 任何模块（哪怕只是「参考」）。如要参考 v2 经验，只能 read v2 文件，不能 import
- 不要在本 PR 顺带实现下个 PR 的功能
- 不要为了「灵活性」给节点加 RFC 没规定的端口或参数
- 不要在 engine 层加 GUI 字段（颜色、坐标、注释）；这些只在 GraphSpec 的 `gui:` 块
- 不要给 Cline backend 之外的 backend 加「兜底走 Cline」的逻辑
- 不要在 LLMService 之外做 retry / 限流 / 缓存
- 不要静默吞异常；要么处理要么往上抛
- 不要写「TODO：以后再做」式残缺代码；本 PR 范围内必须完整

## 与既有 v2 仓库的关系

- v2 在 tools/chronicle_sim_v2/ 仍然存在，**保持不动**
- 本 PR 不允许改 v2 任何文件
- 如果发现 v2 有 bug 想顺手修：另开独立 PR，不要混在 v3 PR 里

## 不确定时怎么办

按以下顺序：
1. 重读 RFC 相关章节
2. 看 v3 已有代码（之前 PR 的实现）是否有先例
3. 看 v2 同类逻辑（**只读不引**）作灵感
4. 在 PR 描述里以「待澄清」comment 列出问题，给出你的临时选择并说明可逆方案
5. 不要静默地按自己理解走

## PR 描述模板

```markdown
# <<PR-ID>>: <<PR-标题>>

## 范围
（按 docs/plan/v3-implementation.md 的 <<PR-ID>> 一节复述）

## 主要变更
- 新增 / 修改 / 删除文件清单
- 关键设计决策（RFC 没明说、本 PR 自行判断的部分）

## RFC 锚点
- 实现的 RFC 章节：v3-engine.md §X.Y / v3-llm.md §X.Y
- 引用的节点 / 接口

## 测试
- [ ] 单测覆盖：列出主要测试文件
- [ ] CI 全绿
- [ ] 层级隔离测试通过
- [ ] cache 防回归测试（如本 PR 涉及缓存）

## 自检（对照 RFC）
- [ ] 隔离硬约束（无 v2 import / 无 Qt import / 无直接 IO）
- [ ] mutation key 用 RFC §5.6 格式
- [ ] 端口标签如实声明
- [ ] reads/writes 如实声明
- [ ] 节点 version 已设
- [ ] 错误信息含上下文
- [ ] canonical yaml 写出（如涉及）

## 待澄清
（若有 RFC / 计划层面的疑问列在这里；没有写「无」）

## 不在范围（明确说明本 PR 不做什么）
- 后续 PR 的功能
- 性能优化
- ...
```

## 完成标准

- PR 描述模板填完
- 所有 self-check 项打勾
- CI 绿
- draft PR 状态等待 review，不要自动合并
- 把 PR URL 报给用户
```

---

## 用法示例

实施 P0-1（项目骨架）时：

> 我把上面那段提示词的 `<<PR-ID>>` 换成 `P0-1`，`<<PR-标题>>` 换成
> `项目骨架与依赖`，发给一个 cloud agent。

实施 P1-5（Engine 调度核心）时：

> 同样套模板，`P1-5` / `Engine 调度核心`。

## 给 GitHub Copilot Workspace / Cursor Background Agent 的额外补充

如果用 background agent 跑：

- 默认从 master 拉最新代码
- 资源敏感的 PR（P1-4 / P1-5 / P0-5）一次只让一个 agent 跑
- 节点抽屉 PR（P2-1 ~ P2-9）可以并行跑（彼此完全独立）
- 任何 PR 完成后人工 review，不要自动 merge

## 给 Codex CLI / 命令行 agent 的补充

可以在仓库根加一个 `AGENTS.md` 软链到本文件，让 codex 自动读：

```bash
ln -s docs/plan/v3-agent-prompt.md AGENTS.md
```

或者直接把上面 ` ``` ` 包的整段贴到 codex 的初始 prompt。
