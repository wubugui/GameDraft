# RFC: ChronicleSim v3 — Engine（图编排核心）

状态：Draft（**Provider+Agent 三层重构后** 修订）  
作者：架构组  
范围：v3 引擎、Context、节点、Graph、Cook、Cache、CLI（Layer 0–2）  
配套：`v3-provider.md`（Provider 层）、`v3-llm.md`（LLM 层）、`v3-agent.md`（Agent 层）、`v3-node-catalog.md`（节点目录）、`v3-implementation.md`（实施计划）

> **重构提示（2025）**：原 LLM 层是业务节点的唯一入口；现已变为 **Provider → LLM → Agent → Engine → Node** 四层。
> 业务节点只见 `services.agents`（AgentService），不再 import `llm.service` / `providers.service`；详见 §2、§6.2、`v3-agent.md`。

---

## 0. 文档范围

本 RFC 仅描述 **引擎、节点抽象、Graph 编排、Cook 执行与缓存、CLI**。
LLM 调用细节在 `v3-llm.md`；具体节点列表与端口签名在 `v3-node-catalog.md`；实施步骤在 `v3-implementation.md`。

GUI 是 Layer 3，本 RFC **不涉及**任何 Qt / 渲染细节，仅约定 GUI 通过哪些 Layer 0 接口与文件契约接入。

---

## 1. 设计目标与非目标

### 1.1 目标

1. **算法即数据**：模拟流程（编年史按周推进、谣言传播、信念更新、月志、探针）以 YAML 图描述，**改算法 = 改 yaml**，无须改 Python 代码
2. **GUI 不耦合**：所有能力 Layer 0（Python API）+ Layer 1（CLI）完整可用；GUI 仅是 Layer 2 yaml 文件的图形编辑器与 cook 状态查看器
3. **可重入**：cook 状态完全持久化，进程崩溃 / 关机 / 几天后均可 `csim cook resume <id>` 续跑
4. **可回溯**：cook 历史保留中间产物，支持"从某节点重 cook"、"分支 cook 比对"
5. **可观测**：每节点的 `start/end/error/cache_hit/mutation_committed` 走 EventBus，CLI/GUI 共享
6. **缓存安全**：缓存命中只在严格 hash 一致时触发；任意改动算法 / 输入 / 引用都自动失效；带全局开关
7. **小核 + 富节点**：引擎本身极薄；80% 业务能力在 builtin 节点（数据小算子）+ 用户子图组合表达

### 1.2 非目标（Out of Scope）

1. **不做兼容**：与 v2 磁盘格式、配置、API 全部隔离，不做迁移工具
2. **不做分布式**：单机 / 单 Run / 单进程；远程 Run / 共享 cook 不在范围
3. **不做强类型运行时**：端口标签是静态校验提示，运行时节点拿到的就是 Python 对象
4. **不做通用工作流编排引擎**：仅服务于编年史模拟这一领域，不要陷入做 Airflow/Dagster 的诱惑
5. **不做插件机制**：所有 NodeKind 在仓库里注册（Python 装饰器），不支持第三方动态加载
6. **不做远程 LLM 调度**：LLM 并发只在本地进程内（详见 `v3-llm.md`）

---

## 2. 三层架构

> 重构后 Layer 0 子层：Provider → LLM → Agent → Engine → Node。详见 `v3-provider.md` §8、`v3-agent.md` §2。

```
Layer 0  Programmatic API     tools/chronicle_sim_v3/{providers,llm,agents,engine,nodes}/
         无 Qt 依赖；CI lint 强制保证（含五层依赖方向 lint）

Layer 1  CLI                  tools/chronicle_sim_v3/cli/  (typer 子命令)
         所有 GUI 能做的事都对应一条 CLI

Layer 2  配置文件 (单一事实)
         算法层：tools/chronicle_sim_v3/data/    （进 git）
           graphs/*.yaml         顶层图与可被引用的子图（schema 同源）
           subgraphs/*.yaml      惯例上放可复用片段（也可顶层启动）
           agent_specs/*.toml    LLM prompt 模板
           presets/<topic>/*.yaml  参数预设（rumor_sim/pacing/...）
           event_types.yaml      事件类型表
           rumor_sim.yaml        谣言传播默认参数
           pacing.yaml           节奏默认参数
           style_fingerprints.yaml
         数据层：<run>/                          （不进 git）
           meta.json
           config/providers.yaml Run 级 Provider 凭据（唯一持有 raw key 的位置）
           config/llm.yaml       Run 级 LLM 路由（models 引用 provider_id）
           config/agents.yaml    Run 级 Agent 注册（runner / provider 或 llm_route）
           config/cook.yaml      cache / 调度开关
           ideas/                设定库
           world/                世界状态
           chronicle/            编年史产物
           cooks/                cook 历史
           cache/                节点缓存
           audit/                审计
           .cline_config/        Cline 凭据目录

Layer 3  GUI                  tools/chronicle_sim_v3/gui/  (PySide6)
         调 Layer 0；编辑结果直接写 Layer 2 yaml
         CI lint 禁止 engine/ llm/ nodes/ cli/ 反向 import gui/
```

### 2.1 隔离纪律（CI 强制）

- `providers/` / `llm/` / `agents/` / `engine/` / `nodes/` / `cli/` 任何文件 **import PySide6 / Qt 即 CI red**
- `engine/` / `nodes/` 任何文件 **import gui/ 即 CI red**
- v3 任何文件 **import tools.chronicle_sim_v2.* 即 CI red**
- **重构后五层 lint**：
  - `providers/` 不许 import `llm.*` / `agents.*` / `engine.*` / `nodes.*` / `cli.*`
  - `llm/` 不许 import `agents.*` / `nodes.*` / `cli.*`（可 import `providers.*`）
  - `agents/` 不许 import `nodes.*` / `cli.*`（可 import `llm.*` / `providers.*`）
  - `nodes/` 不许 import `llm.service` / `providers.*` / `agents.runners.*` / `agents.service`（仅可通过 `services.agents` 间接调用）

实现：在 `tests/test_layering.py` + `_layering_scan.py` 加一个 `ast` 扫描，遍历包内所有 `.py`，违反规则即 fail。少数无状态工具模块（如 `engine.io` / `engine.canonical`）列入 whitelist，可被 `providers/` 等下层 import。

---

## 3. 文件布局总览

### 3.1 仓库内（算法层）

```
tools/chronicle_sim_v3/
  __init__.py
  __main__.py                    # python -m tools.chronicle_sim_v3 → CLI 入口
  cli/
    __init__.py
    main.py                      # typer.Typer() 总入口
    run.py                       # csim run *
    graph.py                     # csim graph *
    cook.py                      # csim cook *
    node.py                      # csim node *
    provider.py                  # csim provider *  (重构后新增)
    llm.py                       # csim llm *  (调试入口)
    agent.py                     # csim agent *  (重构后新增；业务入口)
    chron.py                     # csim chron *
    ideas.py                     # csim ideas *
    cache.py                     # csim cache *
  engine/
    __init__.py
    types.py                     # 端口标签、PortType、PortSpec
    expr.py                      # 表达式求值器
    context.py                   # Context 协议、ContextStore 实现、Slice、Mutation
    node.py                      # NodeKindSpec、Node 协议、NodeOutput
    graph.py                     # Graph、GraphSpec、Subgraph 加载
    engine.py                    # Engine、调度、cancel
    cook.py                      # Cook、状态机、持久化
    cache.py                     # CacheStore、键计算、GC
    eventbus.py                  # EventBus、事件类型
    audit.py                     # 节点级审计
    io.py                        # canonical YAML 读写、文件原子操作
    errors.py                    # 异常体系
    canonical.py                 # canonical hash 计算
    registry.py                  # NodeKind 注册表
  providers/
    ...                          # 见 v3-provider.md（最底层凭据管理）
  llm/
    ...                          # 见 v3-llm.md（chat/embed 调度；Agent 内部依赖）
  agents/
    ...                          # 见 v3-agent.md（业务入口；4 种 Runner）
  nodes/
    __init__.py                  # 集中注册所有 NodeKind
    io/                          # read.* / write.*
    flow/                        # flow.*
    data/                        # filter / map / fold / sort / set / dict / list
    text/                        # template / json / text
    math/
    random/
    npc/
    event/
    eventtype/
    social/
    rumor/
    belief/
    pacing/
    tier/
    chroma/
    agent/                       # agent.cline
  data/
    graphs/
    subgraphs/
    agent_specs/
    presets/
      rumor_sim/{default,aggressive,conservative}.yaml
      pacing/{default,steady,wartime}.yaml
    event_types.yaml
    rumor_sim.yaml
    pacing.yaml
    style_fingerprints.yaml
  gui/                           # 见后续 GUI RFC（P4 阶段）
  tests/
    test_layering.py
    engine/
    llm/
    nodes/
    cli/
    integration/
    golden/                      # 端到端 golden 文件
docs/
  rfc/v3-engine.md  v3-llm.md
  plan/v3-implementation.md  v3-node-catalog.md
chronicle-sim.cmd                # Windows 包装脚本（可选）
```

### 3.2 Run 内（数据层）

```
<run>/
  meta.json                      # run_id / name / created_at / engine_format_ver / graph_default
  config/
    llm.yaml                     # Run 级 LLM 路由与凭据（详见 v3-llm.md）
    cook.yaml                    # cache.enabled / concurrency.* / engine 行为开关
  ideas/
    manifest.json
    <id>.md
  world/
    setting.json
    pillars.json
    anchors.json
    edges.json
    agents/<aid>.json
    factions/<fid>.json
    locations/<lid>.json
  chronicle/
    week_001/
      intents/<aid>.json
      drafts/<id>.json
      events/<eid>.json
      rumors.json
      summary.md
      observation.json
      public_digest.json
      beliefs/<aid>.json
      intent_outcomes/<aid>.json
    month_01.md
  cooks/
    <cook_id>/
      manifest.json              # graph 文件路径与内容 hash、cli 输入参数、起始时间
      state.json                 # 节点状态机（pending/ready/running/done/cached/failed/skipped）
      timeline.jsonl             # 事件流（追加写）
      <node_id>/
        inputs.json
        params.json
        output.json
        mutations.json
        cache_key.txt
        cache_hit.txt | absent
        ws_archive_ref.txt | absent   # agent.cline 的 cwd 归档相对路径
  cache/
    <sha[:2]>/<sha>.json         # 节点缓存条目
    index.jsonl                  # 命中/失效审计可选
  audit/
    nodes/<YYYYMMDD>.jsonl       # 节点级审计（cook_id / node_id / status / timing / cache_hit）
    llm/<YYYYMMDD>.jsonl         # LLM 调用审计（详见 v3-llm.md）
    cache.jsonl                  # cache 命中/写入/失效记录
  .cline_config/                 # Cline 子进程的 CLINE_DIR
  .v3_lock                       # 进程级锁文件（只防同一 Run 多进程同时 cook）
```

---

## 4. 端口标签（Port Tags）

### 4.1 设计原则

**没有运行时类型系统**。端口标签的唯一作用：

1. GUI 拖线时校验（不匹配红线拒绝）
2. `csim graph validate` 静态检查表达式 `${nodes.x.out}` 引用源端口标签 ≠ 目标端口标签时报错
3. 文档（`csim node show <kind>` 列出来）

运行时引擎拿到啥就传啥；可选 `--strict-types` 在 cook 时校验，开发期排错用。

### 4.2 标签集合

```python
# engine/types.py

class PortType(str, Enum):
    # 原生
    Any         = "Any"
    Trigger     = "Trigger"        # 仅控制连接，无数据
    Int         = "Int"
    Float       = "Float"
    Str         = "Str"
    Bool        = "Bool"
    Bytes       = "Bytes"
    Json        = "Json"           # 任意 JSON 兼容值

    # 容器（在 schema 里写成 "List[Agent]" 字符串，引擎解析）
    # 不在枚举里穷举，由 PortType 解析器处理

    # 域类型
    AgentId     = "AgentId"
    Agent       = "Agent"
    AgentList   = "AgentList"      # alias for List[Agent]
    FactionId   = "FactionId"
    Faction     = "Faction"
    FactionList = "FactionList"
    LocationId  = "LocationId"
    Location    = "Location"
    LocationList= "LocationList"
    EdgeList    = "EdgeList"
    Path        = "Path"
    Event       = "Event"
    EventList   = "EventList"
    Draft       = "Draft"
    DraftList   = "DraftList"
    Rumor       = "Rumor"
    RumorList   = "RumorList"
    Intent      = "Intent"
    IntentList  = "IntentList"
    Belief      = "Belief"
    BeliefList  = "BeliefList"
    EventType   = "EventType"
    EventTypeList = "EventTypeList"
    Pacing      = "Pacing"
    Week        = "Week"
    RunId       = "RunId"
    Seed        = "Seed"
    LLMRef      = "LLMRef"
    SubgraphRef = "SubgraphRef"
    Mutation    = "Mutation"
```

### 4.3 容器标签解析

字符串形式：`"List[Agent]"`、`"Dict[Str, IntentList]"`、`"Optional[Event]"`、`"Union[Str, Int]"`。

引擎解析为内部表示：

```python
@dataclass(frozen=True)
class TagRef:
    base: str                              # "List" / "Dict" / "Optional" / "Union" / 域类型名
    args: tuple["TagRef", ...] = ()
```

### 4.4 标签等价（alias）

仓库内固定 alias 表（`engine/types.py`）：

```
AgentList     ≡ List[Agent]
FactionList   ≡ List[Faction]
LocationList  ≡ List[Location]
EventList     ≡ List[Event]
DraftList     ≡ List[Draft]
RumorList     ≡ List[Rumor]
IntentList    ≡ List[Intent]
BeliefList    ≡ List[Belief]
EventTypeList ≡ List[EventType]
EdgeList      ≡ List[Edge]
```

不允许用户自定义新 alias。

### 4.5 端口连接合法性

```python
def can_connect(src: TagRef, dst: TagRef) -> bool:
    if src.base == "Any" or dst.base == "Any": return True
    if normalize_alias(src) == normalize_alias(dst): return True
    if dst.base == "Optional" and can_connect(src, dst.args[0]): return True
    if dst.base == "Union" and any(can_connect(src, t) for t in dst.args): return True
    return False
```

**没有协变 / 逆变 / 子类型推导**。`Json` 不能连 `Event`，要显式 `json.decode → event.coerce` 或在节点里用 `Any`。

### 4.6 PortSpec

```python
@dataclass(frozen=True)
class PortSpec:
    name: str
    type: TagRef
    required: bool = True
    default: Any = None            # 仅 required=False 时有意义
    multi: bool = False             # GUI 上允许多重入边（语义 = 自动 List 包装）
    doc: str = ""
```

`multi=True` 的输入端口在 cook 时拿到的是 list；连接 0 个 = `[]`，连接 N 个 = 按连接顺序拼接。

---

## 5. Context 抽象

### 5.1 设计原则

- Context 是节点访问 Run 数据的**唯一入口**
- Context 的**读视图**（`ContextRead`）暴露给节点；**写**只能通过返回 `Mutation` 由引擎统一 commit
- 节点禁止 `open()` / `Path.write_text()` 直接写 Run 目录；CI lint + 运行时沙箱（cwd 切换 + 路径校验）双重保护
- Context 的所有读方法对应一个**切片标识**（slice key），用于 cache 键

### 5.2 ContextRead 接口

```python
class ContextRead(Protocol):
    run_id: str
    run_dir: Path                  # 只读快照路径（节点不应直接写）
    week: int | None               # 顶层 cook 输入指定时有值

    # ---- 世界 ----
    @slice("world.setting")
    def world_setting(self) -> dict: ...

    @slice("world.pillars")
    def world_pillars(self) -> list: ...

    @slice("world.anchors")
    def world_anchors(self) -> list: ...

    @slice("world.agents")
    def world_agents(self) -> list[dict]: ...

    @slice("world.agent")
    def world_agent(self, agent_id: str) -> dict | None: ...

    @slice("world.factions")
    def world_factions(self) -> list[dict]: ...

    @slice("world.locations")
    def world_locations(self) -> list[dict]: ...

    @slice("world.edges")
    def world_edges(self) -> list[dict]: ...

    # ---- 编年史 ----
    @slice("chronicle.events")
    def chronicle_events(self, week: int) -> list[dict]: ...

    @slice("chronicle.intents")
    def chronicle_intents(self, week: int) -> list[dict]: ...

    @slice("chronicle.rumors")
    def chronicle_rumors(self, week: int) -> list[dict]: ...

    @slice("chronicle.summary")
    def chronicle_summary(self, week: int) -> str: ...

    @slice("chronicle.beliefs")
    def chronicle_beliefs(self, week: int, agent_id: str) -> list[dict]: ...

    @slice("chronicle.observation")
    def chronicle_observation(self, week: int) -> dict: ...

    @slice("chronicle.public_digest")
    def chronicle_public_digest(self, week: int) -> dict: ...

    @slice("chronicle.intent_outcome")
    def chronicle_intent_outcome(self, week: int, agent_id: str) -> dict: ...

    @slice("chronicle.weeks")
    def chronicle_weeks_list(self) -> list[int]: ...

    # ---- 设定库 ----
    @slice("ideas.list")
    def ideas_list(self) -> list[dict]: ...

    @slice("ideas.body")
    def ideas_body(self, idea_id: str) -> str: ...

    # ---- 配置（Run 内）----
    @slice("config.llm")
    def config_llm(self) -> dict: ...

    @slice("config.cook")
    def config_cook(self) -> dict: ...
```

### 5.3 Slice Key 与 hash

`@slice` 装饰器记录方法名为 slice key 前缀；带参数的方法把参数 canonical 化拼到 key 后：

```
"world.setting"
"world.agent:npc_guan"
"chronicle.events:week=3"
"chronicle.beliefs:week=3,agent_id=npc_guan"
```

**Slice hash** = `sha256(canonical_json(value))`，由 ContextStore 在第一次访问时缓存到内存（同一 cook 内一致），写发生时（commit mutation 后）失效相关 key。

节点声明 `reads`（`frozenset[str]`）= 用到的 slice key（可含参数模板，例 `"chronicle.events:week=*"` 表示所有 week）。引擎 cook 时对节点声明的每个 slice 调用一次取 hash，组合进 cache key。

### 5.4 ContextWrite 与 Mutation

节点不直接写。Mutation 通过返回值告诉引擎要做什么：

```python
@dataclass(frozen=True)
class Mutation:
    op: Literal["put_json", "put_text", "delete", "rename"]
    key: str                       # canonical key，如 "chronicle.events:week=3,id=evt_x"
    payload: Any = None            # put_json 是 dict/list；put_text 是 str；delete/rename 不用
    payload_path: Path | None = None  # 大文件不入 mutations.json，落 cooks/<id>/<node>/payload/<n>.json
    new_key: str | None = None     # rename 用
```

**Mutation 仅描述意图，不指定磁盘路径**。`ContextStore` 内部把 key 翻译成 Run 内的实际路径（路径映射表见 §5.6）。这意味着磁盘布局以后改了不动节点。

### 5.5 ContextStore 实现

```python
class ContextStore:
    def __init__(self, run_dir: Path): ...

    def read_view(self, week: int | None) -> ContextRead: ...
    def slice_hash(self, key: str) -> str: ...

    def commit(self, mutations: list[Mutation]) -> None:
        """原子写：临时文件 + os.replace；多 mutation 按 key 排序避免死锁；
        commit 后失效内存 slice hash 缓存。"""

    def revert(self, mutations: list[Mutation]) -> None:
        """仅供 cook 失败回滚（v0 不实现，先简单 fail-fast）。"""
```

### 5.6 Key → Path 映射表

```
world.setting              → world/setting.json
world.pillars              → world/pillars.json
world.anchors              → world/anchors.json
world.agents               → world/agents/*.json (列出)
world.agent:<aid>          → world/agents/<aid>.json
world.factions             → world/factions/*.json
world.faction:<fid>        → world/factions/<fid>.json
world.locations            → world/locations/*.json
world.location:<lid>       → world/locations/<lid>.json
world.edges                → world/edges.json

chronicle.events:week=N           → chronicle/week_NNN/events/*.json (列出)
chronicle.event:week=N,id=X       → chronicle/week_NNN/events/<X>.json
chronicle.intents:week=N          → chronicle/week_NNN/intents/*.json (列出)
chronicle.intent:week=N,id=A      → chronicle/week_NNN/intents/<A>.json
chronicle.drafts:week=N           → chronicle/week_NNN/drafts/*.json
chronicle.draft:week=N,id=X       → chronicle/week_NNN/drafts/<X>.json
chronicle.rumors:week=N           → chronicle/week_NNN/rumors.json
chronicle.summary:week=N          → chronicle/week_NNN/summary.md
chronicle.observation:week=N      → chronicle/week_NNN/observation.json
chronicle.public_digest:week=N    → chronicle/week_NNN/public_digest.json
chronicle.beliefs:week=N,agent_id=A → chronicle/week_NNN/beliefs/<A>.json
chronicle.intent_outcome:week=N,agent_id=A → chronicle/week_NNN/intent_outcomes/<A>.json
chronicle.month:n=N                 → chronicle/month_NN.md
chronicle.weeks                     → chronicle/week_*/ 目录扫描

ideas.list                  → ideas/manifest.json + 列出
ideas.entry:id=X            → ideas/<X>.md
config.llm                  → config/llm.yaml
config.cook                 → config/cook.yaml
```

实现：`engine/io.py` 提供 `key_to_path(key) -> Path`、`path_to_key(p) -> str`、`scan_keys(prefix) -> list[str]`；其它模块只见 key。

### 5.7 沙箱（双重保护）

1. **CI lint**：`engine/`、`nodes/`、`agent.cline` 实现里不允许 `open(...)` / `Path.write_*` 写 Run 目录
2. **运行时**：节点 cook 在切换的 cwd 中运行（临时目录），任何 `Path.write_text` 落不到 Run；要写就必须返回 Mutation

`agent.cline` 是例外：它需要给 Cline 子进程一个 cwd，但 cwd 是 `<run>/.chronicle_sim/ws/<uuid>/` 而非 Run 数据目录；cwd 内的产物由 `agent.cline` 节点解析后转成 Mutation 返回。

---

## 6. Node 抽象

### 6.1 NodeKindSpec

```python
@dataclass(frozen=True)
class Param:
    name: str
    type: Literal["int", "float", "str", "bool", "json", "enum", "expr", "subgraph_ref", "preset_ref"]
    required: bool = True
    default: Any = None
    enum_values: tuple[str, ...] | None = None
    doc: str = ""

@dataclass(frozen=True)
class NodeKindSpec:
    kind: str                              # 全局唯一：例 "rumor.bfs_engine"
    category: str                          # 面板分组：例 "rumor"
    title: str                             # GUI 显示名
    description: str                       # GUI tooltip / csim node show
    inputs: tuple[PortSpec, ...]           # 输入端口
    outputs: tuple[PortSpec, ...]          # 输出端口
    params: tuple[Param, ...]              # 标量参数（GUI Inspector 渲染）
    reads: frozenset[str] = frozenset()    # Context 切片 key 模板
    writes: frozenset[str] = frozenset()   # Mutation key 模板
    version: str = "1"                     # 实现版本（影响 cache key）
    cacheable: bool = True                 # False = 该 NodeKind 永不缓存
    deterministic: bool = True             # False = 即便缓存开也不命中（agent.cline 默认 False）
    color: str = "#cbd5e0"                 # GUI 节点配色
    icon: str = ""                         # 可选
```

**reads/writes 是模板**，运行时根据节点参数与表达式输入实例化。例：

```
"chronicle.events:week=*"              # 模板：所有 week 的 events
"chronicle.events:week=${ctx.week}"    # 运行时实例化为具体 week
"world.agent:*"                        # 所有 agent
"world.agent:${item.id}"               # fanout 中针对单个 agent
```

引擎用模板做静态依赖解算（写集冲突检查），用实例化后的 key 做缓存键。

### 6.2 Node 协议

```python
class Node(Protocol):
    spec: NodeKindSpec

    async def cook(
        self,
        ctx: ContextRead,
        inputs: dict[str, Any],
        params: dict[str, Any],
        services: NodeServices,
        cancel: CancelToken,
    ) -> NodeOutput: ...
```

```python
@dataclass
class NodeServices:
    """Provider+Agent 三层重构后：业务节点只见 agents 字段。"""
    agents: "AgentService"         # 见 v3-agent.md（业务唯一入口）
    rng: random.Random             # 由引擎按 (run_id, cook_id, node_id) 派生确定性种子
    clock: "Clock"                 # 可注入（测试用），默认 datetime.now
    chroma: "ChromaService"        # 嵌入与检索
    eventbus: "EventBus"           # 节点发自定义事件
    artifacts: "ArtifactDir"       # cook 中写大文件的临时区
    _llm: "LLMService" | None = None
    # ↑ 私有字段：仅 chroma.* 等基础设施节点（embed 调用）与 csim llm test 调试入口可用
    # CI lint 强制业务节点不许使用 services._llm

@dataclass
class NodeOutput:
    values: dict[str, Any] = field(default_factory=dict)        # 端口名 → 数据
    mutations: list[Mutation] = field(default_factory=list)
    events: list[NodeEvent] = field(default_factory=list)        # 自定义观测事件
```

**契约**：
- `cook` 必须在 `cancel` 被触发时尽快返回（在每个 await 边界检查）
- `NodeOutput.values` 的 keys 必须正好等于 `spec.outputs` 的 names
- `NodeOutput.mutations` 的 key 必须 ⊆ `spec.writes`（实例化后）
- 同一 cook 内多个节点的 mutations 写同一 key 视为冲突（schedule 时拒绝）

### 6.3 Node 注册

```python
# nodes/npc/filter_active.py
from chronicle_sim_v3.engine.registry import register_node
from chronicle_sim_v3.engine.node import NodeKindSpec, ...

@register_node
class NpcFilterActive(Node):
    spec = NodeKindSpec(
        kind="npc.filter_active",
        category="npc",
        title="过滤活跃 NPC",
        description="保留 life_status == 'alive' 的角色",
        inputs=(PortSpec("agents", TagRef("AgentList")),),
        outputs=(PortSpec("out", TagRef("AgentList")),),
        params=(),
        reads=frozenset(),
        writes=frozenset(),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        agents = inputs["agents"]
        out = [a for a in agents if a.get("life_status", "alive") == "alive"]
        return NodeOutput(values={"out": out})
```

`@register_node` 把 spec 加到全局 `REGISTRY: dict[str, type[Node]]`。`nodes/__init__.py` import 各子模块触发注册。

---

## 7. Graph 与 Subgraph

### 7.1 Graph YAML schema

```yaml
schema: chronicle_sim_v3/graph@1
id: week                          # 全局唯一 id
title: 标准周流水线
description: |
  从 NPC 意图到周总结的完整流程。

inputs:                            # 顶层启动时由 cli/外层传入
  week:
    type: Week
    required: true
outputs:
  result:
    type: Json

spec:
  nodes:
    active:
      kind: read.world.agents
    alive:
      kind: npc.filter_active
      in:
        agents: ${nodes.active.out}
    by_tier:
      kind: npc.partition_by_tier
      in:
        agents: ${nodes.alive.out}
    intent_s:
      kind: flow.fanout_per_agent
      params:
        body: ${subgraph:single_agent_intent}     # 引用另一个 graph 文件
      in:
        over: ${nodes.by_tier.out.S}
        body_inputs:
          tier: "S"
          agent_spec: tier_s_npc.toml
    select_types:
      kind: chronicle.select_event_types
      in:
        week: ${ctx.week}
        pacing: ${preset:pacing/default}
    director:
      kind: agent.cline
      params:
        agent_spec: director.toml
        llm:
          role: director
          model: smart
          output: { kind: json_object, artifact_filename: agent_output.json }
      in:
        vars:
          week:        ${ctx.week}
          intents:     ${nodes.intent_s.collected}
          event_types: ${nodes.select_types.text}
          world_bible: ${nodes.world_bible.out}
    # ...

  edges:                           # 冗余表，与 in: 引用一致；GUI / dot 用
    - { from: active.out,    to: alive.agents }
    - { from: alive.out,     to: by_tier.agents }
    # ...

  result:                          # 顶层图的 outputs 绑定
    result: ${nodes.summary.out}

gui:                               # 可选；GUI 写出，CLI 也可有
  positions:
    active:    [100, 100]
    alive:     [300, 100]
    by_tier:   [500, 100]
    intent_s:  [700, 200]
  collapsed_subgraphs: [intent_s]
  comments:
    - at: [800, 50]
      text: "P3 实验：把 director 的 model 换成 fast"
```

### 7.2 Subgraph

子图就是 graph，没有概念区别。被引用的 graph 通过 `flow.subgraph` 节点接入：

```yaml
nodes:
  outer_call:
    kind: flow.subgraph
    params:
      ref: subgraphs/single_agent_intent.yaml
    in:
      tier: "S"
      agent_spec: tier_s_npc.toml
      agent_id: ${item.id}
    # 子图的 outputs 自动成为本节点的 outputs
```

引擎加载时把 subgraph 展开成内部节点（带 id 前缀避免冲突）；表达式引用 `${nodes.outer_call.out}` 实际指向子图内部某个节点的输出（由子图 `outputs:` 块映射）。

### 7.3 表达式语法（极简）

完整 BNF：

```
expr      := "${" path "}" | "${" "subgraph:" id "}" | "${" "preset:" topic "/" name "}"
           | literal | binop | call | "(" expr ")"
path      := segment ("." segment | "[" key "]")*
segment   := identifier
key       := number | string
literal   := number | string | bool | null
binop     := expr op expr
op        := "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or"
call      := whitelist_func "(" expr ("," expr)* ")"
whitelist_func := "len" | "str" | "int" | "float" | "bool" | "min" | "max" | "sum" | "abs"
```

**根上下文**：`ctx`、`nodes`、`item`（fanout 内）、`params`、`inputs`（子图内）。

**禁止**：lambda、推导式、`__attribute__`、import、自定义函数。

实现：`engine/expr.py` 用 Python `ast` 解析后白名单遍历，非法节点直接 raise。

### 7.4 引用：`${subgraph:...}` 与 `${preset:...}`

- `${subgraph:NAME}` → 解析为 `data/subgraphs/NAME.yaml` 或 `data/graphs/NAME.yaml` 的 `SubgraphRef`，`flow.subgraph` 等节点的 `body` / `ref` 参数接受
- `${preset:TOPIC/NAME}` → 加载 `data/presets/TOPIC/NAME.yaml` 内容作为字面 dict 嵌入；常用：`${preset:pacing/default}`、`${preset:rumor_sim/aggressive}`

### 7.5 Graph 加载、校验、规范化

```python
class GraphSpec(BaseModel):
    schema_version: str
    id: str
    title: str = ""
    description: str = ""
    inputs: dict[str, PortSpec] = {}
    outputs: dict[str, PortSpec] = {}
    nodes: dict[str, NodeRef]
    edges: list[Edge] = []                  # 静态可推导，加载时若缺则自动从 in: 表达式补
    result: dict[str, str] = {}             # outputs 映射
    gui: dict = {}

class NodeRef(BaseModel):
    kind: str
    in_: dict[str, str | dict | list] = Field(alias="in", default_factory=dict)
    params: dict = {}
    when: str | None = None                  # 表达式，false 跳过
```

```python
class GraphLoader:
    def load(self, path: Path) -> GraphSpec: ...
    def validate(self, spec: GraphSpec) -> list[ValidationError]:
        """
        - 表达式可静态解析
        - ${nodes.X.Y} 中 X 存在 / Y 是 X.spec 的 output
        - 端口标签兼容（can_connect）
        - reads/writes 模板可实例化
        - 无环（DAG）
        - 子图 ref 文件存在且自身合法
        """
    def normalize_inplace(self, spec: GraphSpec) -> None:
        """canonical 排序：node id 字典序、edges 排序、键序固定。
        ruamel.yaml round-trip 时可保留注释。"""
```

### 7.6 Canonical 写出

```python
def write_graph(spec: GraphSpec, path: Path) -> None:
    """ruamel.yaml 写出，确保：
       - 顶层键固定顺序: schema, id, title, description, inputs, outputs, spec, gui
       - spec.nodes 字典序
       - edges 排序
       - 浮点数固定精度
    """
```

GUI 与 CLI 共用此函数；任何路径写出的同义图，diff 必须为零。

---

## 8. 引擎执行模型

### 8.1 调度核心

```python
class Engine:
    def __init__(self, run_dir: Path, services: EngineServices): ...

    async def run(
        self,
        graph: GraphSpec,
        inputs: dict[str, Any],
        cook_id: str,
        cancel: CancelToken,
    ) -> CookResult: ...

    async def resume(self, cook_id: str, cancel: CancelToken) -> CookResult: ...
```

```
1. 加载 graph.yaml（含子图递归展开），实例化 nodes 表
2. 静态校验（端口、表达式、reads/writes 冲突、DAG）
3. 为每节点计算 in_hash（输入 + 参数 + reads slice hash）
4. 创建 cook 目录、写 manifest.json、初始化 state.json
5. 进入主循环：
    while ready_queue:
        node = ready_queue.popleft()
        if cancel.is_set(): break
        # 缓存命中检查
        if cacheable(node) and (entry := cache.lookup(in_hash)):
            apply_cached(node, entry)
            mark_cached(node)
            commit_mutations(entry.mutations)
            unlock_downstream(node)
            continue
        # 跑节点
        mark_running(node)
        try:
            result = await node.cook(...)
        except CancelledError:
            mark_cancelled(node); break
        except Exception as e:
            mark_failed(node, e); break
        commit_mutations(result.mutations)
        if cacheable(node) and deterministic(node):
            cache.store(in_hash, result)
        mark_done(node)
        unlock_downstream(node)
6. 写最终 result.json，关闭 cook
```

### 8.2 单线程串行 + LLM 让出

引擎主循环单协程驱动；当节点 cook 内 `await llm.chat(...)` 时让出 event loop，**引擎本身不并发拉取下一个 ready 节点**——保持你要求的"非 LLM 节点串行"。

LLM 并发完全在 LLMService 内部：多个节点的 `await llm.chat` 进入同一 limiter 排队，limiter 决定真正的 in-flight 数量（详见 `v3-llm.md`）。

实践含义：
- 你跑 `flow.fanout_per_agent` 展开 20 个 `agent.cline`，引擎按 ready 顺序逐个发起 `await llm.chat(...)`，每个调用入 LLMService limiter 排队
- LLMService 设 `max_inflight=4` 时，最多 4 个 Cline 子进程同时跑
- 第 1 个调用 await 后，引擎下一轮循环看 ready 队列还有 19 个 → 继续发起 await（也进 limiter 排队）→ 引擎主循环 await 整批
- 全部完成后引擎继续推进下游

**伪代码更精确版本**：

```python
async def _drive(self):
    while not self._cancel.is_set():
        ready = self._next_ready_batch()
        if not ready and self._all_done():
            break
        if not ready:
            await self._wait_any_running_finish()
            continue
        # 把 ready 节点的 cook 全部 schedule，让 LLM 并发由 LLMService 决定
        tasks = [asyncio.create_task(self._cook_one(n)) for n in ready]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        # 处理完成的节点 → unlock 下游 → 下一轮
```

`concurrency.enabled: false`（cook.yaml）→ `_drive` 改为每次只 schedule 1 个节点，等其完成再下一轮（彻底串行）。

### 8.3 fanout 与展开

`flow.fanout_per_agent` / `flow.foreach` 在 graph 加载时静态展开为 N 个内部节点（id = `parent_id.<index_or_key>`），每个节点的 `in:` 中 `${item.X}` 替换为对应数据。

展开发生在静态校验之后、状态机初始化之前；`state.json` 里看到的就是展开后的节点。

### 8.4 取消与超时

```python
class CancelToken:
    def is_set(self) -> bool: ...
    def cancel(self) -> None: ...
    async def wait(self) -> None: ...
```

- 引擎层 cancel：每节点 cook 前后检查；cook 中节点自己负责在 await 边界响应
- 节点级超时：`NodeKindSpec.timeout_sec` 可选；超时引擎 raise CancelledError 给该节点
- agent.cline 的 Cline 子进程超时由 LLMService 内部管理（kill 子进程 + raise）

### 8.5 错误模型

```
ValidationError       graph 加载/校验失败
NodeCookError         节点 cook 抛异常的包装（含 cook_id, node_id, 原异常 traceback）
CacheError            缓存读写异常（不影响 cook，降级为 miss）
ContextError          Context 读写非法（路径越界、key 不存在等）
EngineCancelled       cook 被外部取消
```

Fail-fast：节点失败 → 整 cook 暂停（其它已 done 的节点保留）→ `csim cook resume` 续跑该节点；引擎不内置 retry。

---

## 9. Cook 生命周期

### 9.1 Cook ID

时间戳 + 短 uuid：`20260422T120000Z_a1b2c3`。可由 `--cook-id <name>` 指定（必须新唯一）。

### 9.2 持久化布局

```
<run>/cooks/<cook_id>/
  manifest.json              # 一次性，cook 开始时写
  state.json                 # 节点状态机，每次状态变迁原子重写
  timeline.jsonl             # 事件追加；每行一个事件
  result.json                # cook 完成时写顶层 outputs
  <node_id>/
    inputs.json              # 节点 cook 前快照
    params.json
    output.json              # NodeOutput.values
    mutations.json           # NodeOutput.mutations 描述
    cache_key.txt            # 计算出的 sha
    cache_hit.txt            # 仅命中时存在，含命中的 sha
    ws_archive_ref.txt       # agent.cline 的 cwd 归档相对路径（若有）
    payload/                 # 大文件（mutations 引用）
      <0001>.json
```

### 9.3 manifest.json schema

```json
{
  "cook_id": "20260422T120000Z_a1b2c3",
  "created_at": "2026-04-22T12:00:00Z",
  "graph_path": "data/graphs/week.yaml",
  "graph_content_hash": "sha256:...",
  "engine_format_ver": "1",
  "inputs": { "week": 3 },
  "concurrency": { "enabled": true, "max_inflight": 4 },
  "cache": { "enabled": true },
  "parent_cook_id": null,
  "branched_from": null,
  "branch_overrides": null
}
```

### 9.4 state.json schema

```json
{
  "status": "running",         // pending | running | completed | failed | cancelled
  "started_at": "...",
  "finished_at": null,
  "current_running": ["intent_s.npc_guan", "intent_s.npc_liu"],
  "nodes": {
    "active":          { "status": "done",   "duration_ms": 12 },
    "alive":           { "status": "done",   "duration_ms": 4 },
    "by_tier":         { "status": "done",   "duration_ms": 7 },
    "intent_s.npc_guan": { "status": "running", "started_at": "..." },
    "intent_s.npc_liu":  { "status": "ready" },
    "director":        { "status": "pending" },
    "...": "..."
  },
  "ready_queue": ["intent_s.npc_zhou", "..."],
  "failed_nodes": []
}
```

每次状态迁移 atomic write 一遍 `state.json`（用 tmp + rename）。

### 9.5 timeline.jsonl

每行 JSON：

```json
{"ts":"...","cook_id":"...","node_id":"director","event":"start","in_hash":"sha:..."}
{"ts":"...","cook_id":"...","node_id":"director","event":"llm_call","model":"smart","role":"director"}
{"ts":"...","cook_id":"...","node_id":"director","event":"llm_done","tokens_in":1234,"tokens_out":567,"latency_ms":4321}
{"ts":"...","cook_id":"...","node_id":"director","event":"end","status":"done","duration_ms":4500,"out_hash":"sha:..."}
```

### 9.6 Resume 语义

```python
async def resume(cook_id: str) -> CookResult:
    state = read_state(cook_id)
    if state.status in ("completed",):
        return load_result(cook_id)
    # running 节点视为崩溃中断（mutation 没 commit），回到 ready
    for nid, ns in state.nodes.items():
        if ns.status == "running":
            ns.status = "ready"
    write_state(cook_id, state)
    # 继续主循环
    return await self._drive(...)
```

**关键**：节点 mutation 在 cook 完成且 commit 后才标 done；中断重跑安全。Cline 子进程崩溃也走这个路径——agent.cline 节点重跑会起一个新 cwd，不复用旧的（旧 cwd 归档但不参与）。

### 9.7 Branch（分支 cook）

```
csim cook branch <parent_cook_id> --override <node_id>.<param>=<value>
```

实现：
1. 复制 parent 的 manifest，置 `parent_cook_id` 与 `branch_overrides`
2. 应用 overrides 到 graph spec（只在新 cook 内存中）
3. 分配新 cook_id，从头跑；上游缓存命中（因 in_hash 一致）→ 直接复用；下游因输入变化 miss → 实跑
4. 不修改 parent 的任何文件

---

## 10. Cache（严格设计）

### 10.1 全局开关

```yaml
# <run>/config/cook.yaml
cache:
  enabled: true                # false = 整 Run 全部 cook 都不命中、不写入
  read_only: false             # true = 只命中、不写入（用于审计）
  max_size_gb: 10              # 超出 GC
  retention_days: 30
concurrency:
  enabled: true
  max_inflight: 4              # LLMService 看；非 LLM 节点不受影响
```

CLI 覆盖：
```
csim cook run ... --no-cache
csim cook run ... --cache-read-only
csim cook run ... --no-concurrency
csim cook run ... --max-inflight 1
```

### 10.2 缓存键计算

```python
def compute_cache_key(node: Node, ctx: ContextRead, inputs: dict, params: dict) -> str:
    components = [
        node.spec.kind,
        node.spec.version,
        canonical_hash(inputs),
        canonical_hash(params),
        slice_hash_combined(ctx, instantiate_reads(node.spec.reads, params, inputs)),
        agent_spec_hash(params) if node.spec.kind == "agent.cline" else "",
        llm_route_hash(params, ctx.config_llm()) if node.spec.kind == "agent.cline" else "",
        subgraph_hash(params) if node.spec.kind in ("flow.subgraph", "flow.foreach", "flow.fanout_per_agent") else "",
        ENGINE_FORMAT_VER,
    ]
    return sha256_hex("\x1f".join(components))
```

**canonical_hash**：JSON 序列化 → sort_keys=True、ensure_ascii=False、float 固定精度 → sha256。

**slice_hash_combined**：对 `reads` 模板实例化后的每个 slice key 取 hash，按 key 字典序拼接再 hash。

### 10.3 cacheable / deterministic 矩阵

| NodeKind 类别 | cacheable | deterministic | 默认行为 |
|---|---|---|---|
| 纯数据节点（filter/map/sort/...） | true | true | 默认开缓存 |
| read.* | true | true | 默认开缓存（key 含 slice hash） |
| write.* | false | - | 永不缓存（缓存计算不缓存"已写入"状态） |
| agent.cline | true | **false** | 开关默认 off；用户在节点 params 显式 `cache: hash` 才命中 |
| flow.* | true | true | 缓存编排结果（子节点的 outputs 集合） |
| random.* | true | false | 显式开 |
| chroma.upsert / chroma.search | false / true | -/ true | upsert 不缓存；search 默认开（key 含集合内容 hash） |

**deterministic=False 的含义**：即使整 Run cache enabled，引擎也不命中此节点，除非节点 params 里显式 `cache: hash` 或 `cache: exact`。

### 10.4 三层防错

1. **写入即校验**：写缓存条目时把 `in_hash` 与节点声明的 `reads` 切片 hash 一并存；命中时再算一遍当前切片 hash 比对，不一致即失效该条目并 miss
2. **格式版本**：`ENGINE_FORMAT_VER` 改 → 所有旧条目 schema mismatch → 自动失效
3. **CI 防回归测**：
   - "改输入下游 miss" 测试：跑图 → 改某节点参数 → 跑图 → 校验依赖该节点的下游 cache_hit=false
   - "改 prompt 失效 agent.cline" 测试：改 spec TOML 内容 → cache miss
   - "改 LLM 路由失效" 测试：改 llm.yaml routes.smart → cache miss

### 10.5 缓存条目格式

```json
{
  "schema": "chronicle_sim_v3/cache_entry@1",
  "key": "sha256:...",
  "node_kind": "rumor.bfs_engine",
  "node_version": "1",
  "engine_format_ver": "1",
  "created_at": "...",
  "in_hash_components": {
    "inputs":     "sha:...",
    "params":     "sha:...",
    "reads":      { "world.edges": "sha:...", "world.agents": "sha:..." },
    "agent_spec": "",
    "llm_route":  "",
    "subgraph":   ""
  },
  "values": {                            // NodeOutput.values
    "rumors": [...]
  },
  "mutations": [                          // NodeOutput.mutations 完整描述
    { "op": "put_json", "key": "chronicle.rumors:week=3", "payload_path": "../payload/0001.json" }
  ]
}
```

大 payload 落到同目录 `<sha>.payload/` 子目录，避免 cache JSON 过大。

### 10.6 GC

```
csim cache gc                        # 同时按 max_size_gb 与 retention_days
csim cache gc --orphan               # 不被任何 cook 引用的条目
csim cache gc --older-than 7d
csim cache stats                     # 总大小 / 条目数 / 命中率
```

实现：扫所有 cook 的 state.json 收集"被引用 cache_key"集合，删除不在集合内的条目。

### 10.7 审计

`<run>/audit/cache.jsonl` 每行：

```json
{"ts":"...","cook_id":"...","node_id":"director","event":"hit","key":"sha:...","saved_ms":4500}
{"ts":"...","cook_id":"...","node_id":"director","event":"miss","key":"sha:..."}
{"ts":"...","cook_id":"...","node_id":"director","event":"store","key":"sha:...","bytes":12345}
{"ts":"...","cook_id":"...","node_id":"director","event":"invalidate","key":"sha:...","reason":"slice_hash_mismatch"}
```

---

## 11. EventBus 与可观测

### 11.1 事件类型

```python
class CookEvent(str, Enum):
    cook_start      = "cook.start"
    cook_end        = "cook.end"
    node_ready      = "node.ready"
    node_start      = "node.start"
    node_end        = "node.end"
    node_failed     = "node.failed"
    node_cancelled  = "node.cancelled"
    node_cache_hit  = "node.cache_hit"
    mutation_commit = "mutation.commit"
    llm_call        = "llm.call"            # 由 LLMService 触发，引擎转发
    llm_done        = "llm.done"
    custom          = "custom"              # 节点内 services.eventbus.emit
```

### 11.2 EventBus 接口

```python
class EventBus(Protocol):
    def emit(self, event: dict) -> None: ...
    def subscribe(self, callback: Callable[[dict], None]) -> SubscriptionHandle: ...
    async def stream(self) -> AsyncIterator[dict]: ...
```

**多 sink**：CLI 订阅 → 写 timeline.jsonl + 终端打印；GUI 订阅 → 节点徽标更新；测试订阅 → assertion。Sink 之间相互独立。

### 11.3 节点级审计

`<run>/audit/nodes/<YYYYMMDD>.jsonl` 每行：

```json
{
  "ts": "...",
  "cook_id": "...",
  "node_id": "director",
  "node_kind": "agent.cline",
  "node_version": "1",
  "status": "done",
  "duration_ms": 4321,
  "in_hash": "sha:...",
  "out_hash": "sha:...",
  "cache_hit": false,
  "mutations_count": 1,
  "error": null
}
```

由引擎在每个节点完成时统一写。

---

## 12. CLI 命令谱（详细）

入口：`python -m tools.chronicle_sim_v3 <subcommand>`，包装为 `csim`。

### 12.1 `csim run *`

```
csim run init <dir> --name <s> [--llm-from <yaml>]
    创建 Run 目录、写 meta.json / config/llm.yaml / config/cook.yaml；
    --llm-from 指定一个模板 yaml 作为初始 llm.yaml

csim run list
    列所有已知 Run（搜索 ~/.chronicle_sim_v3/runs/ 和 cwd 子目录）

csim run show <dir>
    展示 meta.json 与目录结构概况

csim run delete <dir>
    确认后删除（保留 ideas/ 备份默认）

csim run fork <src> <dst> --name <s>
    完整复制 Run（不含 cooks/cache 默认）
```

### 12.2 `csim ideas *`

```
csim ideas list   <run>
csim ideas new    <run> --title <s> [--body @file.md] [--tags a,b]
csim ideas import <run> <file.md>...
csim ideas delete <run> <id>
csim ideas show   <run> <id>
csim ideas search <run> <query> [--semantic] [--top 10]
```

### 12.3 `csim graph *`

```
csim graph new     <name> [--in <dir>] [--from-template <name>]
    新建 graph yaml；默认写到 data/graphs/<name>.yaml；--in <dir> 写到指定目录

csim graph list    [--in <dir>]
csim graph show    <path>
    打印结构（节点/连接树状）

csim graph validate <path>
    端口标签 / 表达式 / 拓扑 / 子图引用 完整校验

csim graph format  <path>
    canonical 重写（diff 校验用；幂等）

csim graph add-node    <path> --kind <k> --id <id> [--at x,y]
csim graph remove-node <path> <id>
csim graph connect     <path> <src_id>.<port> <dst_id>.<port>
csim graph disconnect  <path> <src_id>.<port> <dst_id>.<port>
csim graph set-param   <path> <id> <key>=<value>
csim graph set-expr    <path> <id>.<port> '${nodes.x.y}'
csim graph rename      <path> <id> <new_id>
csim graph pack-as-subgraph <path> --select <id1,id2,...> --name <sub> \
                              --in <port:type,...> --out <port:type,...>
csim graph dot         <path>      # 输出 graphviz dot 给静态可视化
csim graph diff        <a> <b>     # 语义 diff（忽略 gui 块）
```

### 12.4 `csim node *`

```
csim node list [--category <c>] [--search <q>]
csim node show <kind>             # 端口/参数/版本/reads/writes
csim node docs <kind> --md        # markdown 文档导出
```

### 12.5 `csim cook *`

```
csim cook run <graph_path> --run <dir> [--input k=v ...] [--cook-id <s>]
              [--no-cache] [--cache-read-only]
              [--no-concurrency] [--max-inflight N]
              [--strict-types]

csim cook resume <cook_id>            # 在当前 Run cooks/ 找
csim cook list   <run> [--last N]
csim cook show   <run> <cook_id>
csim cook cancel <run> <cook_id>
csim cook timeline <run> <cook_id> [--follow] [--filter node_id=X]
csim cook output <run> <cook_id> <node_id> [--port <name>]
csim cook inputs <run> <cook_id> <node_id>
csim cook artifact <run> <cook_id> <node_id>     # 打开归档目录路径
csim cook branch <run> <cook_id> --override <id>.<param>=<value> [...]
csim cook gc     <run>
```

### 12.6 `csim chron *`

```
csim chron show   <run> --week N [--node intents|events|rumors|summary|observation|...]
csim chron export <run> --to <path.md>
csim chron probe  <run> "你的问题"
csim chron weeks  <run>
```

### 12.7 `csim cache *`

```
csim cache stats    <run>
csim cache gc       <run> [--orphan] [--older-than 30d]
csim cache show     <run> <sha>
csim cache invalidate <run> --node-kind <k> [--all]
```

### 12.8 `csim llm *`

详见 `v3-llm.md`。

---

## 13. 一些设计决策的备忘

### 13.1 为什么 mutation 不直接写

如果允许节点直接 `open` 写 Run 目录，会失去：
- 缓存命中后"自动 commit 旧产物"的能力（需要落到磁盘的事必须经过引擎）
- 崩溃恢复语义清晰性
- 写集冲突静态检查

代价：节点要返回 mutation 而不是直接 IO，多一层。但 mutation 描述很轻（key + dict），实现成本可控。

### 13.2 为什么 fanout 静态展开

- 引擎调度模型简单（看到的就是 N 个独立节点）
- 缓存粒度细（某个 NPC 意图改了不影响其它）
- timeline / state 直观
- 代价：图很大时 state.json 变长，用 jsonl 可以缓解；不是问题

### 13.3 为什么子图与图同源

- 减少概念
- 子图可以独立 cook 测试（顶层启动即可）
- 嵌套自然

### 13.4 为什么不引入 ProcessPool

- LLM 调用大头是子进程 / IO，不是 CPU
- 多进程要序列化 ContextStore / ServiceBundle，复杂
- numpy 计算（spring layout 等）少且短，GIL 影响可接受
- 未来真有 CPU 瓶颈再加（从特定 NodeKind 做 ProcessPool 路径，不动引擎核心）

### 13.5 为什么不让节点 import gui

显然但要写下来：节点是算法，GUI 是脸。任何"为了 GUI 显示而在节点里加字段"的提议必须改成"GUI 自己从 node spec / output 里推导"。

### 13.6 为什么 schema 版本号

- `chronicle_sim_v3/graph@1` / `chronicle_sim_v3/cache_entry@1`
- 未来格式演进有迁移点；旧 cook 自动 invalidate 而不是莫名其妙的 bug
- 升级路径 v3.1 / v3.2 不重写整套
