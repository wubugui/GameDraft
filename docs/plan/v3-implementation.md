# 计划: ChronicleSim v3 — 实施 Roadmap

状态：Draft  
配套：`v3-engine.md`、`v3-llm.md`、`v3-node-catalog.md`

---

## 0. 总览

按 6 个阶段（P0 – P5）推进，**每个阶段交付一个可独立 ship 的能力**。每个阶段内部按 PR 拆分，每 PR 范围明确、可独立 review。

```
P0  项目骨架 + LLMService（无图、无节点、无 GUI）          可独立 ship
     验收：csim llm test --model offline --prompt "你好" 跑通

P1  Engine 骨架 + 23 个最小 NodeKind + CLI cook            可独立 ship
     验收：手写一个 4 节点的 yaml，csim cook run 跑通端到端

P2  补全 ~61 个 NodeKind + Subgraph 完整支持               可独立 ship
     验收：编年史所有领域算子都有节点；可拼复杂图

P3  出厂图（week / range / seed / probe）+ golden 回归     v3 功能与 v2 对齐
     验收：stub 路径 N 周端到端产物 hash 稳定；真实 LLM 跑通

P4  GUI 图编辑器                                           v3 用户可用
     验收：拖节点 / 连线 / 调参 / cook / 看时间线全部可用

P5  体验：用量统计 / wedge / 缓存优化 / cook 对比           持续
```

每阶段的 PR 数量与大小：
- P0：5 PR，总 S/M（约 2500 行）
- P1：8 PR，总 M（约 4000 行）
- P2：10 PR，按节点抽屉拆，每 PR 一个 category（M）
- P3：6 PR
- P4：4 PR
- P5：开放

> 不估计绝对工时，只标 S（< 200 行）/ M（200–800 行）/ L（800+ 行）。Cloud agent 跑节奏不固定。

---

## 1. P0：项目骨架 + LLMService

### 目标

无 GUI、无图、无节点，只交付：
- v3 包目录结构、依赖锁定、CI 配置
- 端口标签 + 表达式求值器（被后续阶段共用）
- LLMService 完整实现（4 backend：cline / openai_compat_chat / openai_compat_embed + ollama 兜底 / stub）
- 最小 CLI：`csim run`、`csim llm`

### 验收

```bash
csim run init runs/test --name "smoke"
csim llm test --model offline --prompt "你好"          # stub backend，立即返回
csim llm test --model smart --prompt "你好"            # 真实 cline backend
csim llm test-emb --model embed --texts "a,b,c"
csim llm route show
csim llm usage
csim llm audit tail -n 10
```

### PR 拆解

#### P0-1：项目骨架与依赖（S）

- 新建 `tools/chronicle_sim_v3/`，目录结构按 `v3-engine.md §3.1`
- `requirements.txt`：`pydantic>=2 typer>=0.12 ruamel.yaml>=0.18 rich>=13 anyio>=4 chromadb>=0.4.24 mcp>=1.0 openai>=1.0 httpx>=0.27 networkx>=3 numpy>=1.24 PyYAML>=6 json-repair>=0.58 PySide6>=6.6 markdown>=3.5`（PySide6 留到 P4 用，但锁版本）
- `pyproject.toml`（可选；至少 entry_point `csim = tools.chronicle_sim_v3.cli.main:app`）
- `tools/chronicle_sim_v3/__init__.py`、`__main__.py`（仅打印 `csim --help` 引导）
- `chronicle-sim.cmd`（Windows 包装：`@python -m tools.chronicle_sim_v3 %*`）
- `tests/__init__.py` + `tests/conftest.py`（PYTHONPATH 注入；与 v2 conftest 完全独立）
- `pytest.ini`：`testpaths = tools/chronicle_sim_v3/tests`、`asyncio_mode = auto`

**测试**：仅 `test_smoke.py`：`import tools.chronicle_sim_v3` 不报错。

**完成标准**：CI（如有）pip install + pytest 通过；老 v2 测试不受影响。

---

#### P0-2：CI 隔离 lint（S）

- `tools/chronicle_sim_v3/tests/test_layering.py`：
  - 扫描 `engine/ llm/ nodes/ cli/` 任何 `.py` 不允许 import `PySide6` / `Qt` / 任何 `tools.chronicle_sim_v2.*`
  - 扫描 `engine/ nodes/` 不允许 import `cli/` / `gui/`
  - 用 `ast` 解析 import 语句，违反即 fail
- `tools/chronicle_sim_v3/tests/test_no_v2_import.py`（独立测试，方便单独跑）

**测试**：构造若干允许 / 违反的 fixture 验证扫描器正确性。

**完成标准**：所有现有空目录通过，故意写一行违规 import 后立即 fail。

---

#### P0-3：端口标签 + 表达式求值器（M）

- `engine/types.py`：
  - `PortType` 枚举（含所有标签）
  - `TagRef` 解析器：`parse_tag("List[Agent]") → TagRef(base="List", args=(TagRef("Agent"),))`
  - `normalize_alias` + `can_connect` 实现
  - `PortSpec` Pydantic 模型
- `engine/expr.py`：
  - `parse(expr_str) -> ExprAST`
  - `evaluate(ast, scope: dict) -> Any`
  - 用 Python `ast` 解析后白名单遍历（`v3-engine.md §7.3`）
  - 字面量 / 路径 / 算术 / 比较 / 逻辑 / whitelist 函数 / 表达式根 `${...}` 解包
  - 引用解析：`${ctx.X}` `${nodes.X.Y}` `${item.X}` `${params.X}` `${inputs.X}` `${subgraph:NAME}` `${preset:TOPIC/NAME}`
  - 子图引用 / preset 引用解析为占位 `SubgraphRef` / `PresetRef`，由 GraphLoader 实例化
- `engine/canonical.py`：
  - `canonical_json(value) -> str`（sort_keys, ensure_ascii=False, float 固定精度）
  - `canonical_hash(value) -> str` (sha256 hex)
- `engine/io.py`（最小版）：
  - `read_yaml(path) -> dict`（ruamel round-trip 模式）
  - `write_yaml_canonical(path, data, key_order: list[str])`
  - `atomic_write_text(path, text)`、`atomic_write_json(path, data)`

**测试**：
- `test_types.py`：标签解析、connect 矩阵
- `test_expr.py`：所有合法语法 + 所有非法语法（lambda / 推导式 / `__` 等）
- `test_canonical.py`：相同 dict 不同顺序 hash 相同

**完成标准**：≥ 30 个 expr 用例覆盖；can_connect 真值表全过

---

#### P0-4：LLMService 数据结构与 Resolver（M）

- `llm/__init__.py`：导出主接口
- `llm/config.py`：
  - 上述 RFC §2.2 的 Pydantic 模型
  - `load_llm_config(run_dir) -> LLMConfig`（ruamel 加载 + Pydantic 校验 + `api_key:` 出现即报错）
  - `ApiKeyRef.parse / resolve`
- `llm/resolver.py`：
  - `Resolver(config, run_dir)`
  - `resolve_route(logical) -> ResolvedModel`
  - `policy_for(logical, ref) -> CallPolicy`（合并 default / per-route / ref override）
- `llm/errors.py`：`LLMError` 全部子类（§10.1）
- `llm/types.py`：`Prompt / OutputSpec / LLMRef / LLMResult / ResolvedModel / CallPolicy / RetryPolicy / RateLimit`
- 默认模板：`tools/chronicle_sim_v3/data/templates/llm.example.yaml`，`csim run init` 复制为初始 `<run>/config/llm.yaml`

**测试**：
- `test_config.py`：合法 / 缺字段 / `api_key:` 出现报错
- `test_resolver.py`：路由解析、policy 合并、`route_hash` 不含 api_key
- `test_api_key_ref.py`：env / file / 缺失报错

**完成标准**：可以从 yaml 解析并解析路由

---

#### P0-5：LLMService 主体 + Backend + Limiter + Audit + Cache + CLI（L）

- `llm/limiter.py`：semaphore + qpm/tpm 漏桶
- `llm/cache.py`：chat / embed cache key 计算 + 文件存储 + `CacheStore.lookup/store`
- `llm/audit.py`：`AuditWriter`（写 `<run>/audit/llm/<day>.jsonl`，ULID 分配）
- `llm/usage.py`：`UsageStats` + 增量更新
- `llm/render.py`：spec TOML 加载 + `{{key}}` 渲染（与 v2 同语义但完全重写）
- `llm/backend/`：
  - `base.py`：`ChatBackend` / `EmbedBackend` / `BackendObserver` Protocol + `BackendResult`
  - `cline.py`：`ClineBackend` 完整实现（§5.2）
    - 临时 cwd / `.clinerules/` / `input.md` / 凭据刷新 / argv / env / Windows 处理 / stderr 流式 / 工作区文件回读 / 归档
    - 全部从零写，**0 行 import v2**
  - `openai_compat_chat.py`：`OpenAICompatChatBackend`（直 HTTP，httpx 实现；P0 实现但 P6 才默认放进 routes 示例）
  - `openai_compat_embed.py`：`OpenAICompatEmbedBackend`（DashScope 单批 ≤10）
  - `ollama_embed.py`：`OllamaEmbedBackend`
  - `stub.py`：`StubBackend`（确定性占位，根据 spec_ref 简单分流）
- `llm/service.py`：
  - `LLMService` 主类
  - `chat(ref, prompt) -> LLMResult` 完整流程：Resolver → Audit.start → Cache.lookup → Limiter.acquire → Retry → Backend → Cache.store → Audit.end → Usage.record
  - `embed(model, texts) -> list[Vector]`
  - 异常分类与重试
- `llm/output_parse.py`：JSON / JSONL 解析（json-repair 兜底）
- `cli/main.py`：typer.Typer() 总入口，子命令路由
- `cli/run.py`：`csim run init/list/show/delete/fork`
- `cli/llm.py`：`csim llm test/test-emb/route show/route set/models/usage/audit tail/audit show/cache stats/cache clear/cache invalidate`

**测试**：
- `test_stub_backend.py`：占位响应稳定
- `test_resolver_integration.py`：从 yaml → resolve → policy 一条路
- `test_limiter.py`：并发限制、qpm 漏桶
- `test_cache.py`：hash key 稳定性、命中后回放、`cache.enabled=false` 关闭
- `test_audit.py`：写 jsonl、ULID 唯一、不写 api_key
- `test_chat_e2e_stub.py`：完整 chat 走 stub，校验 LLMResult 各字段
- `test_cli_run.py`：`csim run init` 落盘正确
- `test_cli_llm.py`：`csim llm test --model offline` 输出正确

**完成标准**：
- `csim run init runs/x --name x` 落盘 `meta.json + config/llm.yaml + config/cook.yaml`
- `csim llm test --model offline --prompt "hi"` 走 stub 返回结果
- `csim llm audit tail` 看到刚才那条
- `csim llm usage` 显示 1 calls / offline route
- 真实模型 cline / direct 不强制要在 CI 跑（凭据敏感），用本地手动验证

---

## 2. P1：Engine 骨架 + 最小 NodeKind 集 + cook CLI

### 目标

引擎可跑、节点可注册、cook 可缓存可重入；最小 23 个节点足以跑一个端到端示例图。

### 验收

写一个 `data/graphs/p1_smoke.yaml`：
- `read.world.agents` → `npc.filter_active` → `npc.partition_by_tier` → `agent.cline(stub)` → `write.chronicle.intent`

```bash
csim run init runs/p1 --name p1
# 手动塞几个 agent 到 runs/p1/world/agents/
csim cook run data/graphs/p1_smoke.yaml --run runs/p1 --input week=1
csim cook list runs/p1
csim cook timeline runs/p1 <cook_id>
csim cook output runs/p1 <cook_id> filter_alive --port out
# 改 yaml 中 agent.cline 的 vars 后再跑，看 cache miss/hit
csim cook resume <cook_id>      # 中断后续跑
```

### PR 拆解

#### P1-1：Context + Mutation + ContextStore（M）

- `engine/context.py`：
  - `ContextRead` Protocol + `Slice` decorator
  - `Mutation` dataclass + 验证
  - `ContextStore` 完整实现（read 视图 + slice hash 缓存 + commit）
- `engine/io.py` 扩展：
  - `key_to_path / path_to_key / scan_keys`（§5.6 映射表）

**测试**：
- `test_context_read.py`：从手工 fixture Run 读各种 slice
- `test_context_commit.py`：mutation 写盘 + slice hash 失效
- `test_key_path_mapping.py`：所有映射规则双向

---

#### P1-2：Node 协议 + Registry + 最小节点（M）

- `engine/node.py`：`NodeKindSpec / Param / Node Protocol / NodeOutput / NodeServices`
- `engine/registry.py`：`@register_node` 装饰器；`REGISTRY: dict[str, type[Node]]`
- `engine/errors.py`：节点错误体系
- `nodes/__init__.py`：集中 import 各子模块触发注册
- 实现以下节点（见 `v3-node-catalog.md` 标 P1 的）：
  - `nodes/io/read_world.py`：`read.world.agents` / `read.world.setting`
  - `nodes/io/read_chronicle.py`：`read.chronicle.events`
  - `nodes/data/__init__.py`：`filter.where` / `map.expr` / `sort.by` / `take.n` / `count` / `list.concat` / `dict.merge`
  - `nodes/text/__init__.py`：`template.render` / `text.concat` / `json.encode` / `json.decode`
  - `nodes/math/__init__.py`：`math.compare` / `math.range`
  - `nodes/random/__init__.py`：`rng.from_seed`
  - `nodes/npc/__init__.py`：`npc.filter_active` / `npc.partition_by_tier`

**测试**：每节点至少一个单测；`test_registry.py` 校验 84 个节点的 23 个本期已注册

---

#### P1-3：Graph 加载与校验（M）

- `engine/graph.py`：
  - `GraphSpec / NodeRef` Pydantic 模型
  - `GraphLoader.load(path) -> GraphSpec`：ruamel 加载、表达式静态解析、子图占位标记
  - `GraphLoader.expand_subgraphs(spec, registry)`：递归展开子图与 fanout
  - `GraphLoader.validate(spec) -> list[ValidationError]`：
    - kind 在 registry
    - in_ 表达式可解析
    - 引用 `${nodes.X.Y}` 中 X 存在 / Y 是 X.outputs.name
    - can_connect(src.tag, dst.tag)
    - reads/writes 模板可实例化
    - DAG 无环
  - `GraphLoader.normalize_inplace`：canonical 排序
  - `GraphSpec.write(path)`：用 ruamel round-trip 写出，固定键序

**测试**：
- `test_graph_load.py`：合法 graph 加载
- `test_graph_validate.py`：各种非法情形（端口不匹配、循环、未知 kind）
- `test_graph_canonical.py`：load → write → load 二进制一致

---

#### P1-4：Cook + Cache + EventBus（L）

- `engine/eventbus.py`：`EventBus` 实现 + `CookEvent` 枚举
- `engine/cache.py`：节点级 `CacheStore`（lookup / store / GC stub）
- `engine/audit.py`：`<run>/audit/nodes/<day>.jsonl` 节点级审计
- `engine/cook.py`：
  - `Cook` 状态机
  - `CookManager.create / load / save_state`（state.json 原子写）
  - `manifest.json` / `<node_id>/{inputs,output,mutations,cache_key}.json` 落盘
  - `timeline.jsonl` 追加写

**测试**：
- `test_cook_persistence.py`：state.json 各种状态迁移
- `test_cache_key.py`：组合各种节点产出稳定 sha
- `test_cache_hit_replay.py`：命中后 mutation 正确 commit
- `test_eventbus.py`：多 sink 订阅

---

#### P1-5：Engine 调度核心（L）

- `engine/engine.py`：
  - `Engine.__init__(run_dir, services)`
  - `run(graph, inputs, cook_id, cancel) -> CookResult`：
    - 加载 graph、展开子图、初始化状态机
    - 主循环：拓扑 ready → 缓存检查 → cook → mutation commit → unlock 下游
    - LLM 节点 await 与非 LLM 节点串行的混合调度（§8.2 伪代码）
    - cancel 响应、timeout、错误分类
  - `resume(cook_id)`：从 state.json 续跑（running → ready 重设）
  - `branch(parent_cook_id, overrides)`：分支 cook
- `engine/services.py`：`EngineServices` 容器（llm / chroma / clock / rng_factory）
- `engine/cancel.py`：`CancelToken`

**测试**：
- `test_engine_minimal.py`：4 节点线性图跑通
- `test_engine_fanout.py`：fanout_per_agent 展开后顺序正确
- `test_engine_cache_hit.py`：第二次跑时上游 cache 命中
- `test_engine_resume.py`：模拟中断后 resume 续跑
- `test_engine_cancel.py`：cancel 中断不留垃圾
- `test_engine_concurrent_off.py`：`--no-concurrency` 完全串行

---

#### P1-6：flow 节点 + agent.cline 节点（M）

- `nodes/flow/__init__.py`：
  - `flow.foreach`、`flow.fanout_per_agent`、`flow.parallel`、`flow.when`、`flow.merge`、`flow.subgraph`
  - 这些节点的特殊性：在 GraphLoader.expand_subgraphs 阶段需要展开
- `nodes/agent/cline.py`：`agent.cline` 节点（详见 `v3-llm.md §11`）

**测试**：
- `test_flow_foreach.py`：展开 + 数据流正确
- `test_flow_when.py`：condition false 跳过
- `test_agent_cline_stub.py`：走 stub backend 端到端

---

#### P1-7：cook CLI（M）

- `cli/cook.py`：
  - `csim cook run <graph> --run <dir> --input k=v --cook-id <id> --no-cache --no-concurrency --max-inflight N --strict-types`
  - `csim cook list / show / cancel / resume / timeline / output / inputs / artifact / branch / gc`
- `cli/graph.py`：
  - `csim graph new / list / show / validate / format / dot / diff`
  - 编辑命令（`add-node / remove-node / connect / disconnect / set-param / set-expr / rename / pack-as-subgraph`）作为 P2 工具，P1 只放 `validate / format / dot / show`
- `cli/node.py`：`csim node list / show / docs`

**测试**：
- `test_cli_cook.py`：跑、看 timeline、看 output
- `test_cli_graph.py`：validate 通过 / 失败的退出码

---

#### P1-8：smoke 端到端集成（S）

- `data/graphs/p1_smoke.yaml`：手写一个最小图
- `tests/integration/test_p1_smoke.py`：构造 fixture Run + 跑 graph + 校验产物
- `data/agent_specs/_p1_test.toml`：最小 prompt（stub 路径用）

**完成标准**：CI 跑 stub 路径全绿；本地手动跑真实 LLM 验证 agent.cline

---

## 3. P2：补全 NodeKind 集 + Subgraph 体验

### 目标

把 catalog 剩余 ~61 个节点补齐；subgraph 在 GUI 出来前先用 CLI 拼通；编辑命令补齐。

### 验收

```bash
csim node list                    # 84 个节点
csim node show rumor.bfs_engine
csim graph new my_test --in <run>/graphs/
csim graph add-node my_test --kind read.world.agents --id agents
csim graph add-node my_test --kind npc.filter_active --id alive
csim graph connect my_test agents.out alive.agents
# ...
csim graph pack-as-subgraph my_test --select agents,alive --name agent_loader \
                            --out "agents:AgentList"
csim cook run my_test --run <dir>
```

### PR 拆解（按抽屉）

每 PR 实现一个抽屉的剩余节点 + 单测；拓扑无依赖，可并行 review。

| PR | 抽屉 | 节点数 | 大小 |
|---|---|---|---|
| P2-1 | io 剩余（read.world.* / read.chronicle.* / read.config.* / read.ideas.* / write.* 全套） | 22 | M |
| P2-2 | flow 剩余（foreach_with_state / switch / barrier） | 3 | S |
| P2-3 | data 剩余 | 11 | M |
| P2-4 | text 剩余 | 3 | S |
| P2-5 | math/random 剩余 | 6 | S |
| P2-6 | npc 剩余（location_resolve / context_compose） | 2 | S |
| P2-7 | event + eventtype + pacing | 10 | M |
| P2-8 | social + rumor + belief | 8 | M（rumor.bfs_engine 是大头） |
| P2-9 | tier + chroma | 7 | M |
| P2-10 | graph 编辑 CLI（add/remove/connect/disconnect/set-param/set-expr/rename/pack-as-subgraph） | — | M |

每 PR 含：
- 节点实现 + 单测
- `csim node show <kind>` 文档自动生成
- `csim node list --category X` 显示

---

## 4. P3：出厂图与 golden 回归

### 目标

用 P1/P2 的节点拼出标准编年史模拟流程；建立 stub 路径下的 golden 回归测试。

### 验收

```bash
csim cook run data/graphs/seed_from_ideas.yaml --run <run> --input ideas_blob_limit=50000
csim cook run data/graphs/week.yaml --run <run> --input week=1
# ... 跑到 week=8
csim chron show <run> --week 4
csim cook run data/graphs/probe.yaml --run <run> --input "question=朝天门发生什么"
# CI 跑 stub 路径，产物 hash 与 golden 一致
```

### PR 拆解

#### P3-1：v3 prompt TOML 重写（M）

- 先写 `docs/prompt-design-notes.md`：从 v2 经验抽设计原则（output_contract、ACT 模式契约、tier 分层 prompt 风格、JSON schema 提示）
- `data/agent_specs/`：从空白重写
  - `tier_s_npc.toml` / `tier_a_npc.toml` / `tier_b_npc.toml`
  - `director.toml` / `gm.toml`
  - `rumor.toml`
  - `week_summarizer.toml` / `month_historian.toml` / `style_rewriter.toml`
  - `initializer.toml`
  - `probe.toml`
  - `_universal_output_contract.md`（被 ClineBackend 自动注入到 .clinerules）

**测试**：每 spec 的 stub 路径调用产生预期占位输出

---

#### P3-2：默认数据（S）

- `data/event_types.yaml`：事件类型表（从 v2 抽，但完全重写格式以适配 v3）
- `data/rumor_sim.yaml`：默认参数
- `data/pacing.yaml`：默认节奏
- `data/style_fingerprints.yaml`：风格指纹
- `data/presets/rumor_sim/{default,aggressive,conservative}.yaml`
- `data/presets/pacing/{default,steady,wartime}.yaml`

---

#### P3-3：subgraphs（M）

- `data/subgraphs/single_agent_intent.yaml`：单 NPC 意图生成（含上下文构建）
- `data/subgraphs/npc_context_compose.yaml`：上下文文本拼装（取代 v2 _build_npc_context）
- `data/subgraphs/week_end.yaml`：周末更新（信念 / state / outcome / world / chroma 索引）

每 subgraph 自含单测：直接 cook run 可独立跑

---

#### P3-4：顶层 graph - week.yaml + range.yaml（M）

- `data/graphs/week.yaml`：标准周流水线，引用上述 subgraphs
- `data/graphs/range.yaml`：foreach 跑多周，每周引用 `subgraph:week`

---

#### P3-5：seed_from_ideas + probe（M）

- `data/graphs/seed_from_ideas.yaml`：read.ideas → text.concat → agent.cline(initializer) → 解析 → 多个 write.world.*
- `data/graphs/probe.yaml`：多轮探针（参考 v2 引用校验机制）；含一个 `flow.while` 用 BFS-like 重试

---

#### P3-6：golden 回归（M）

- `tests/golden/runs/<scenario>/world/`：手工准备的 fixture 世界
- `tests/golden/runs/<scenario>/expected/cook_result.json`：stub 路径下的预期产物
- `tests/integration/test_golden.py`：跑 graph → 与 expected 比对（白名单忽略 ts/uuid 等不稳定字段）

---

## 5. P4：GUI 图编辑器

### 目标

Layer 3 出场。GUI 是 yaml 文件的图形编辑器 + cook 执行控制台 + 编年史浏览器；不引入新业务能力。

### 验收

打开 GUI → 选 Run → 打开 `data/graphs/week.yaml` → 看到节点图 → 改一个 director 的 model → 保存 yaml → 顶部 Cook 按钮 → 看节点状态实时变化 → 看 LLM 用量面板。

### PR 拆解

#### P4-1：主窗口骨架 + Run/Graph 选择（M）

- `gui/main_window.py`、`gui/run_panel.py`、`gui/graph_picker.py`
- 顶部栏：Run 切换 / Graph 选择 / Cook 按钮 / 取消
- 中央占位（图编辑器在 P4-2）
- 底部：cook 列表 + 时间线（订阅 EventBus）
- 调用 Layer 0 完成所有动作

#### P4-2：图编辑器 Canvas（L）

- `gui/graph_editor/canvas.py`：QGraphicsView 画布
- `gui/graph_editor/items.py`：节点图元、端口、连线
- `gui/graph_editor/palette.py`：左侧节点抽屉
- `gui/graph_editor/inspector.py`：右侧选中节点参数表单
- 拖拽 / 连线 / 类型校验 / 节点状态徽标
- 任何操作 → 调 Layer 0 修改 GraphSpec → ruamel 保存 yaml

#### P4-3：编年史浏览（M）

- `gui/chronicle_browser.py`：参考 v2 经验从空白写
- 树状目录 + 详情面板 + 探针对话
- 全部走 Layer 0：`ContextStore.read_view()` + `csim chron probe` 等价 API

#### P4-4：LLM 面板（S）

- `gui/llm_panel.py`：用量表 + 路由表 + 审计 tail
- 全部走 Layer 0：`LLMService.usage()` / `audit.tail()`

---

## 6. P5：体验与性能

PR 按需开。建议：

- P5-1：cook 对比（branch 后产物 diff 高亮）
- P5-2：Wedge（同图多组路由 / 参数批量 cook）
- P5-3：Cost estimate（model 表加 cost_per_1k_in / out；audit 算 cost；GUI 用量页显示）
- P5-4：节点搜索 / 撤销重做 / 注释节点
- P5-5：Cache 命中率诊断面板
- P5-6：DirectHttpBackend 默认放进 routes 示例

---

## 7. 各 PR 之间的依赖

```
P0-1 ── P0-2 ── P0-3 ── P0-4 ── P0-5  ──┐
                  │                       │
                  └─→ P1-1 ─→ P1-2 ─→ P1-3 ─→ P1-4 ─→ P1-5 ─→ P1-6 ─→ P1-7 ─→ P1-8
                                                                     │
                                                                     ├─→ P2-1 ┐
                                                                     ├─→ P2-2 │
                                                                     ├─→ P2-3 │  并行 review
                                                                     ├─→ P2-4 │
                                                                     ├─→ P2-5 │
                                                                     ├─→ P2-6 │
                                                                     ├─→ P2-7 │
                                                                     ├─→ P2-8 │
                                                                     ├─→ P2-9 ┘
                                                                     └─→ P2-10
                                                                          │
                                                                          ├─→ P3-1 ─→ P3-3 ─→ P3-4 ─→ P3-5 ─→ P3-6
                                                                          ├─→ P3-2 ┘
                                                                          │
                                                                          └─→ P4-1 ─→ P4-2 ─→ P4-3 ─→ P4-4
```

P2 内部 10 个 PR 完全独立，可任意顺序并行。

---

## 8. CI 配置（每阶段必跑）

```
1. pytest tools/chronicle_sim_v3/tests          # 全部测试
2. python -c "import tools.chronicle_sim_v3"    # 包可导入
3. tools/chronicle_sim_v3/tests/test_layering.py # 层级隔离
4. csim --help                                  # CLI 入口
5. csim run init /tmp/ci_run --name ci          # CLI smoke
6. csim llm test --model offline --prompt hi    # stub 端到端

# P1 后追加
7. csim cook run tests/golden/graphs/p1_smoke.yaml --run /tmp/ci_run

# P3 后追加
8. pytest tests/integration/test_golden.py
```

CI **不**跑真实 LLM（凭据敏感）；本地手动跑或专用 secrets 跑。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 表达式求值器写出 bug 导致缓存命中错值 | P0-3 单测覆盖率拉到 100%；P1-4 cache key 测试再覆盖一遍组合 |
| ClineBackend 与 v2 经验偏离 | P0-5 实现时对照 v2 cline_runner 的所有边角处理（Windows 重试 / NO_PROXY / argv 短句 / input.md / 工作区文件回读 / CLINE_DIR / auth -m 省略策略），逐项打勾；不 import 但行为对齐 |
| 子图展开导致 state.json 爆炸 | P1-4 用 jsonl + lazy load；GUI 中 collapsed_subgraphs 折叠显示 |
| LLM 缓存与节点 cache 互相影响导致命中错位 | RFC §10/§7.3 分层设计 + CI 防回归测；物理目录隔离 |
| 节点 reads 声明遗漏导致 cache 命中错值 | CI 加 ast 检查节点 cook 函数实际调用 ctx 方法 vs 声明 reads；偏差即 fail |
| GUI 与 CLI yaml 写出不一致 | P0-3 canonical 写出 + golden round-trip 测试 |
| Pydantic v2 schema 变更兼容麻烦 | 锁版本 `pydantic>=2,<3`；schema 改动加 schema_version |
| 节点 80+ 个，文档跟不上 | 节点实现强制带 docstring，`csim node docs --md` 自动生成 markdown，进 docs/ |

---

## 10. 不做什么

- 不做 v2 → v3 数据迁移
- 不做插件机制（NodeKind 必须在仓库 register）
- 不做远程 / 分布式
- 不做插件式 backend（必须在 v3 内 register）
- 不做 i18n（纯中文）
- 不做 cli 安装包发布（保持 `python -m` 即可）
- 不做 Web GUI（PySide6 即终态）

---

## 11. 立即下一步

本 RFC + 计划合并后，第一个实施 PR 是 **P0-1（项目骨架与依赖）**，约 200-400 行，无业务逻辑，纯基础设施。

PR 描述模板：

> ## P0-1: ChronicleSim v3 项目骨架与依赖
>
> 第一阶段第一步。建 `tools/chronicle_sim_v3/` 目录结构，锁定依赖，加 PYTHONPATH/conftest，加 smoke 测试。无业务代码。
>
> 配套 RFC：docs/rfc/v3-engine.md / docs/rfc/v3-llm.md / docs/plan/v3-implementation.md / docs/plan/v3-node-catalog.md
>
> ### 包含
> - 目录骨架（engine/ llm/ nodes/ cli/ data/ tests/）
> - requirements.txt
> - pytest 配置
> - chronicle-sim.cmd 包装脚本
> - tests/test_smoke.py
>
> ### 不包含
> - 业务逻辑、节点实现、CLI 子命令
>
> ### 验收
> - `pip install -r tools/chronicle_sim_v3/requirements.txt` 通过
> - `pytest tools/chronicle_sim_v3/tests/test_smoke.py` 绿
> - `python -c "import tools.chronicle_sim_v3"` 不报错

之后每 PR 类似格式。
