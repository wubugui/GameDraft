# 计划: ChronicleSim v3 — Node Catalog（节点目录）

状态：Draft  
配套：`v3-engine.md`、`v3-llm.md`、`v3-implementation.md`

---

## 0. 目的

列出 v3 出厂自带的所有 builtin NodeKind，每个含：
- `kind`（注册表 key）
- `category`（GUI 面板分组）
- `inputs / outputs / params`（端口与参数）
- `reads / writes`（Context 切片，参与依赖与 cache）
- 一句话作用
- 所属实施 PR（见 `v3-implementation.md`）

总计 **84 个 NodeKind**，分 14 个抽屉。

> **约定**：所有标签写法 = `v3-engine.md §4` 的 PortType 名 / 容器形式（`List[T]` 等）。`reads / writes` 用 `v3-engine.md §5.6` 的 key 模板，参数模板里 `${X}` 由实例化阶段替换。

---

## 1. io（读写 Context）— 26 个

### 1.1 read.world.* — 9 个

| kind | inputs | params | outputs | reads | PR |
|---|---|---|---|---|---|
| `read.world.setting` | — | — | `out: Json` | `world.setting` | P1 |
| `read.world.pillars` | — | — | `out: Json` | `world.pillars` | P3 |
| `read.world.anchors` | — | — | `out: Json` | `world.anchors` | P3 |
| `read.world.agents` | — | — | `out: AgentList` | `world.agents` | P1 |
| `read.world.agent` | — | `agent_id: str` | `out: Agent` | `world.agent:${agent_id}` | P3 |
| `read.world.factions` | — | — | `out: FactionList` | `world.factions` | P3 |
| `read.world.locations` | — | — | `out: LocationList` | `world.locations` | P3 |
| `read.world.edges` | — | — | `out: EdgeList` | `world.edges` | P3 |
| `read.world.bible_text` | — | — | `out: Str` | `world.*` | P3 |

`read.world.bible_text` 是组合节点（拼世界设定 + 支柱 + 势力 + 地点 + 锚点为 LLM 注入文本），声明 `reads = world.*` 表示依赖整个 world。

### 1.2 read.chronicle.* — 12 个

| kind | inputs | params | outputs | reads | PR |
|---|---|---|---|---|---|
| `read.chronicle.events` | `week: Week` | — | `out: EventList` | `chronicle.events:week=${inputs.week}` | P1 |
| `read.chronicle.intents` | `week: Week` | — | `out: IntentList` | `chronicle.intents:week=...` | P3 |
| `read.chronicle.intent` | `week: Week, agent_id: AgentId` | — | `out: Intent` | `chronicle.intent:week=...,id=...` | P3 |
| `read.chronicle.drafts` | `week: Week` | — | `out: DraftList` | `chronicle.drafts:week=...` | P3 |
| `read.chronicle.rumors` | `week: Week` | — | `out: RumorList` | `chronicle.rumors:week=...` | P3 |
| `read.chronicle.summary` | `week: Week` | — | `out: Str` | `chronicle.summary:week=...` | P3 |
| `read.chronicle.observation` | `week: Week` | — | `out: Json` | `chronicle.observation:week=...` | P3 |
| `read.chronicle.public_digest` | `week: Week` | — | `out: Json` | `chronicle.public_digest:week=...` | P3 |
| `read.chronicle.beliefs` | `week: Week, agent_id: AgentId` | — | `out: BeliefList` | `chronicle.beliefs:week=...,agent_id=...` | P3 |
| `read.chronicle.intent_outcome` | `week: Week, agent_id: AgentId` | — | `out: Json` | `chronicle.intent_outcome:...` | P3 |
| `read.chronicle.weeks` | — | — | `out: List[Week]` | `chronicle.weeks` | P3 |
| `read.chronicle.month` | — | `n: int` | `out: Str` | `chronicle.month:n=${n}` | P3 |

### 1.3 read.config.* / read.ideas.* — 5 个

| kind | inputs | params | outputs | reads | PR |
|---|---|---|---|---|---|
| `read.config.event_types` | — | — | `out: EventTypeList` | `config.event_types` (静态) | P3 |
| `read.config.pacing` | — | `preset: str = "default"` | `out: Pacing` | `config.pacing:${preset}` | P3 |
| `read.config.rumor_sim` | — | `preset: str = "default"` | `out: Json` | `config.rumor_sim:${preset}` | P3 |
| `read.ideas.list` | — | — | `out: List[Json]` | `ideas.list` | P3 |
| `read.ideas.body` | — | `idea_id: str` | `out: Str` | `ideas.entry:id=${idea_id}` | P3 |

### 1.4 write.* — 11 个

write 节点 `cacheable=False`、`writes=` 显式。

| kind | inputs | params | outputs | writes | PR |
|---|---|---|---|---|---|
| `write.world.agent` | `agent: Agent` | — | `key: Str` | `world.agent:${agent.id}` | P3 |
| `write.world.edges` | `edges: EdgeList` | — | `key: Str` | `world.edges` | P3 |
| `write.chronicle.intent` | `week: Week, intent: Intent` | — | `key: Str` | `chronicle.intent:week=...,id=${intent.agent_id}` | P3 |
| `write.chronicle.draft` | `week: Week, draft: Draft` | — | `key: Str` | `chronicle.draft:week=...,id=...` | P3 |
| `write.chronicle.event` | `week: Week, event: Event` | — | `key: Str` | `chronicle.event:week=...,id=${event.id}` | P3 |
| `write.chronicle.rumors` | `week: Week, rumors: RumorList` | — | `key: Str` | `chronicle.rumors:week=...` | P3 |
| `write.chronicle.summary` | `week: Week, text: Str` | — | `key: Str` | `chronicle.summary:week=...` | P3 |
| `write.chronicle.observation` | `week: Week, payload: Json` | — | `key: Str` | `chronicle.observation:week=...` | P3 |
| `write.chronicle.public_digest` | `week: Week, payload: Json` | — | `key: Str` | `chronicle.public_digest:week=...` | P3 |
| `write.chronicle.belief` | `week: Week, agent_id: AgentId, beliefs: BeliefList` | — | `key: Str` | `chronicle.beliefs:week=...,agent_id=...` | P3 |
| `write.chronicle.intent_outcome` | `week: Week, agent_id: AgentId, payload: Json` | — | `key: Str` | `chronicle.intent_outcome:...` | P3 |
| `write.chronicle.month` | `n: int, text: Str` | — | `key: Str` | `chronicle.month:n=${n}` | P3 |

> 注：写入端口数算 11 行，加上 `write.chronicle.month` 凑齐；具体在 P3 拆 PR 时按子分类合并提交。

---

## 2. flow（控制流）— 9 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `flow.foreach` | `over: List[Any]` | `body: SubgraphRef, body_inputs: Json` | `collected: List[Any]` | 对 over 每项展开为 body 子图 1 实例 | P1 |
| `flow.foreach_with_state` | `over: List[Any], init_state: Any` | `body: SubgraphRef` | `final_state: Any, collected: List[Any]` | 带累积状态（用于 BFS 等） | P3 |
| `flow.fanout_per_agent` | `over: AgentList` | `body: SubgraphRef, body_inputs: Json` | `collected: List[Any]` | foreach 的 agent 专用便利节点 | P1 |
| `flow.parallel` | — | `children: List[SubgraphRef]` | `outputs: Json` | 语义提示同时跑（v3 中实际仍由引擎按依赖排序） | P1 |
| `flow.when` | `condition: Bool, body: SubgraphRef` | — | `out: Optional[Json], triggered: Bool` | condition true 才跑 body | P1 |
| `flow.switch` | `selector: Any` | `cases: Json` | `out: Any` | cases 为 dict[label, SubgraphRef] | P3 |
| `flow.merge` | `inputs: List[Any]` (multi) | — | `out: List[Any]` | 多入合并为列表 | P1 |
| `flow.subgraph` | `*` (子图 inputs 透传) | `ref: SubgraphRef` | `*` (子图 outputs 透传) | 引用另一个 graph 文件 | P1 |
| `flow.barrier` | — | `children: List[SubgraphRef]` | `done: Trigger` | 等齐再继续，无数据传递 | P3 |

---

## 3. data（通用集合 / 字典 / 列表）— 18 个

### 3.1 集合算子 — 9 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `filter.where` | `list: List[Any]` | `expr: str` | `out: List[Any]` | 表达式取真留下 | P1 |
| `map.expr` | `list: List[Any]` | `expr: str` | `out: List[Any]` | 表达式映射 | P1 |
| `pick.first` | `list: List[Any]` | `default: Any?` | `out: Any` | 取首项 | P3 |
| `pick.nth` | `list: List[Any]` | `n: int` | `out: Any` | 取第 n 项 | P3 |
| `pick.where_one` | `list: List[Any]` | `expr: str` | `out: Any` | 取第一个 expr 真 | P3 |
| `group.by` | `list: List[Any]` | `key_expr: str` | `out: Dict[Str, List[Any]]` | 按 key 分组 | P3 |
| `partition.by` | `list: List[Any]` | `key_expr: str` | `out: Dict[Str, List[Any]]` | 同 group.by；语义提示 | P3 |
| `fold` | `list: List[Any], init: Any` | `op_expr: str` | `out: Any` | 累计 | P3 |
| `count` | `list: List[Any]` | — | `out: Int` | | P1 |

### 3.2 排序 / 截取 / 集合运算 — 6 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `sort.by` | `list: List[Any]` | `key_expr: str, order: enum(asc,desc)` | `out: List[Any]` | | P1 |
| `take.n` | `list: List[Any]` | `n: int` | `out: List[Any]` | 前 n | P1 |
| `take.tail` | `list: List[Any]` | `n: int` | `out: List[Any]` | 后 n | P3 |
| `flatten` | `list: List[List[Any]]` | — | `out: List[Any]` | | P3 |
| `set.union` | `a: List[Any], b: List[Any]` | — | `out: List[Any]` | 去重并集 | P3 |
| `set.diff` | `a: List[Any], b: List[Any]` | — | `out: List[Any]` | a-b | P3 |

### 3.3 列表 / 字典 — 3 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `list.concat` | `lists: List[List[Any]]` (multi) | — | `out: List[Any]` | | P1 |
| `dict.merge` | `dicts: List[Dict]` (multi) | `strategy: enum(replace,deep)` | `out: Dict` | | P1 |
| `dict.kvs` | `d: Dict` | — | `keys: List[Str], values: List[Any]` | | P3 |

---

## 4. text（文本 / 模板 / JSON）— 7 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `template.render` | `vars: Dict` | `template: str` | `out: Str` | `{{key}}` 模板替换 | P1 |
| `text.concat` | `parts: List[Str]` | `sep: str = ""` | `out: Str` | | P1 |
| `text.head` | `text: Str` | `n: int` | `out: Str` | | P3 |
| `text.format` | `vars: Dict` | `pattern: str` | `out: Str` | Python `str.format` | P3 |
| `json.encode` | `value: Any` | `indent: int = 0, ensure_ascii: bool = false` | `out: Str` | | P1 |
| `json.decode` | `text: Str` | — | `out: Json` | | P1 |
| `json.path` | `value: Json` | `path: str` | `out: Any` | `a.b[0].c` 路径取值 | P3 |

---

## 5. math / random — 8 个

### 5.1 math — 3 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `math.eval` | `vars: Dict` | `expr: str` | `out: Any` | 用引擎表达式求值 | P3 |
| `math.compare` | `a: Any, b: Any` | `op: enum` | `out: Bool` | `==/!=/</<=/>/>=` | P1 |
| `math.range` | — | `start: int, end: int, step: int = 1` | `out: List[Int]` | | P1 |

### 5.2 random — 5 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `rng.from_seed` | — | `key: str` | `seed: Seed` | 由 (run_id, cook_id, key) 派生确定性 | P1 |
| `random.bernoulli` | `seed: Seed` | `p: float` | `out: Bool` | | P3 |
| `random.weighted_sample` | `seed: Seed, items_with_weights: List[Json]` | `k: int, replace: bool = false` | `out: List[Any]` | | P3 |
| `random.shuffle` | `seed: Seed, list: List[Any]` | — | `out: List[Any]` | | P3 |
| `random.choice` | `seed: Seed, list: List[Any]` | — | `out: Any` | | P3 |

---

## 6. npc（角色域）— 4 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `npc.filter_active` | `agents: AgentList` | — | `out: AgentList` | `life_status == alive` | P1 |
| `npc.partition_by_tier` | `agents: AgentList` | — | `S: AgentList, A: AgentList, B: AgentList, C: AgentList` | | P1 |
| `npc.location_resolve` | `agent: Agent, locations: LocationList` | — | `loc_id: LocationId` | 把 `current_location/location_hint` 对齐到 loc_* | P3 |
| `npc.context_compose` | `parts: Dict[Str, Json|Str]` | `format: enum(headed,xml)` | `out: Str` | 把"段标题→内容"拼成统一注入文本 | P3 |

---

## 7. event（事件域）— 5 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `event.visible_to` | `event: Event, agent_id: AgentId` | — | `out: Bool` | 含 tier_b_group 展开 | P3 |
| `event.filter_visible` | `events: EventList, agent_id: AgentId` | — | `out: EventList` | 批量版 | P3 |
| `event.normalize_for_rumors` | `event: Event` | — | `out: Event` | 计算 related/spread；过滤非法 id | P3 |
| `event.public_digest_line` | `event: Event` | — | `out: Optional[Str]` | 抽 truth.who_knows_what.公开 | P3 |
| `event.actors_union` | `event: Event` | — | `out: List[AgentId]` | actor∪related∪witness | P3 |

---

## 8. eventtype（事件类型抽样）— 4 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `eventtype.condition_pass` | `et: EventType, week: Week` | — | `out: Bool` | 评估 `conditions` 表达式 | P3 |
| `eventtype.cooldown_pass` | `et: EventType, week: Week` | — | `out: Bool` | 查 `chronicle.events:week=*` 历史 | P3 |
| `eventtype.score` | `et: EventType, week: Week, pacing: Pacing` | — | `out: Float` | pick_weight × pacing × period | P3 |
| `eventtype.format_for_prompt` | `types: EventTypeList` | — | `out: Str` | LLM 注入文本格式化 | P3 |

---

## 9. pacing — 1 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `pacing.multiplier` | `week: Week, pacing: Pacing` | — | `out: Float` | | P3 |

---

## 10. social（社交图）— 3 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `social.neighbors` | `agent_id: AgentId, edges: EdgeList` | `hops: int = 1` | `out: List[Json]` | `[(id, w, type)]` | P3 |
| `social.bfs_reach` | `start: AgentId, edges: EdgeList` | `max_hops: int = 2` | `out: Dict[AgentId, Json]` | `{target: {hops, path}}` | P3 |
| `social.shortest_path` | `a: AgentId, b: AgentId, edges: EdgeList` | — | `out: Path` | | P3 |

---

## 11. rumor（谣言）— 1 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `rumor.bfs_engine` | `events: EventList, edges: EdgeList, params: Json, week: Week` | `mutation: SubgraphRef \| null` | `rumors: RumorList` | BFS 概率传播；走样 callback 是子图（典型为 `agent.cline(rumor.toml)`），传 null = 不做走样 | P3 |

注：本节点是少有的"中粒度算法核"，BFS 与概率内聚；走样行为通过 `mutation` 子图端口外置，业务图可换实现。

---

## 12. belief（信念）— 4 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `belief.decay` | `beliefs: BeliefList` | `factor: float = 0.92, threshold: float = 0.12` | `out: BeliefList` | | P3 |
| `belief.from_events` | `events: EventList, agent_id: AgentId` | `confidence: float = 0.82` | `out: BeliefList` | 仅对本人参与事件 | P3 |
| `belief.from_rumors` | `rumors: RumorList, agent_id: AgentId` | `conf_heard: float = 0.38, conf_spread: float = 0.55` | `out: BeliefList` | | P3 |
| `belief.merge_truncate` | `lists: List[BeliefList]` (multi) | `top_k: int = 24` | `out: BeliefList` | | P3 |

---

## 13. tier（NPC 层级管理）— 3 个

| kind | inputs | params | outputs | reads/writes | PR |
|---|---|---|---|---|---|
| `tier.apply_pending` | — | — | `changes: List[Json]` | reads `world.agents`, `tier.pending`; writes `world.agent:*`, `tier.pending` | P3 |
| `tier.archive` | `agent_id: AgentId` | — | — | reads `chronicle.*`; writes `cold_storage.${agent_id}` | P3 |
| `tier.restore` | `agent_id: AgentId` | — | — | reads `cold_storage.${agent_id}`; writes `chronicle.*` | P3 |

---

## 14. chroma（向量检索）— 4 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `chroma.upsert` | `docs: List[Json]` | `collection: str` | `count: Int` | docs 每项 `{id, text, metadata}`；调 LLMService 嵌入 | P3 |
| `chroma.search` | `query: Str` | `collection: str, n_results: int = 5` | `out: List[Json]` | | P3 |
| `chroma.rebuild_world` | — | — | `count: Int` | 全量重建 world 集合 | P3 |
| `chroma.rebuild_ideas` | — | — | `count: Int` | 全量重建 ideas 集合 | P3 |

---

## 15. agent（LLM 调用）— 1 个

| kind | inputs | params | outputs | 说明 | PR |
|---|---|---|---|---|---|
| `agent.cline` | `vars: Json` | `agent_spec: str, llm: Json, system_extra: str = ""` | `text: Str, parsed: Json, tool_log: Json` | 详见 `v3-llm.md §11` | P1 |

---

## 16. 节点总数与 PR 分布

| 类别 | 节点数 |
|---|---|
| io | 26 |
| flow | 9 |
| data | 18 |
| text | 7 |
| math/random | 8 |
| npc | 4 |
| event | 5 |
| eventtype | 4 |
| pacing | 1 |
| social | 3 |
| rumor | 1 |
| belief | 4 |
| tier | 3 |
| chroma | 4 |
| agent | 1 |
| **合计** | **84** |

按 PR：
- **P1**（最小可跑集）：23 个 — `agent.cline`、4 个 read.world.* / read.chronicle.events、9 个 flow（核心 7 + parallel + barrier 留 P3）的核心 7、5 个 data 算子（filter.where/map.expr/sort.by/take.n/count/list.concat/dict.merge）、template.render / json.encode / json.decode / text.concat、`math.compare` / `math.range`、`rng.from_seed`、`npc.filter_active` / `npc.partition_by_tier`
- **P3**（补全）：61 个

具体每个 PR 含哪些节点见 `v3-implementation.md`。

---

## 17. 节点设计纪律

1. **小、组合、可替换**：宁可 5 个小节点拼一个流程，不要 1 个大节点
2. **`reads` / `writes` 必须如实声明**：cache 与依赖解算靠这个；CI 加测试用静态分析检查 `cook` 函数实际访问的 ctx 方法是否在 `reads` 内
3. **节点不直接 IO**：写盘走 mutation；read.* 节点是唯一 IO 入口
4. **`version` 必须 bump**：节点行为有任何改动，`spec.version` += 1，否则 cache 命中错值
5. **`deterministic` 默认 True**：仅 `agent.cline` / `random.*` / 涉及外部 IO 的节点为 False
6. **多端口输出**：`partition.by` 等节点可以多输出；不要为了"只一个输出"在节点内拼字典再让下游解
7. **错误模式**：节点内业务错误抛 `NodeBusinessError` 含 `details: dict`；引擎包装为 `NodeCookError` 落 timeline
8. **禁止 NodeKind 之间互相 import**：节点是叶子；公共逻辑放 `engine/` 或 `nodes/_lib/`
