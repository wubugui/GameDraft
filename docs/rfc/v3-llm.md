# RFC: ChronicleSim v3 — LLM 抽象层

状态：Draft（**Provider+Agent 三层重构后** 修订）  
作者：架构组  
范围：LLMService、Backend、Resolver、Limiter、Cache、Audit、Usage、`llm.yaml` schema、`csim llm` 命令  
配套：`v3-provider.md`、`v3-agent.md`、`v3-engine.md`、`v3-node-catalog.md`、`v3-implementation.md`

---

## 0. 文档范围

本 RFC 描述 v3 的 **LLM 抽象层**：单次 chat / embed 调用的调度（limiter / cache / audit）。

**关键定位（重构后）**：
- 不再是业务节点的入口；业务节点只见 `services.agents`（见 `v3-agent.md`）
- LLMService 是 **Agent 层的内部依赖**：`SimpleChatRunner` 调一次 chat，`ReActRunner` 调 N 次
- LLMService **不**自己持有凭据，凭据来自 **ProviderService**（见 `v3-provider.md`）
- `ClineBackend` 已移除：cline 子进程现在是 `agents/runners/cline.py` 的职责，凭据直接向 ProviderService 取，**绕过 LLM 层**
- `csim llm test` 保留为开发调试入口；业务测试请走 `csim agent test`

**新依赖关系**：

```
agents/SimpleChatRunner       agents/ClineRunner
agents/ReActRunner                │
       │                          │
       ▼                          │
   LLMService ──→ ProviderService ←┘
       │              │
   (chat/embed)   (raw api_key)
```

---

## 1. 设计目标

1. **统一入口**：业务通过 `LLMService.chat(...)` / `embed(...)` 两个方法即可，所有后端差异内部消化
2. **逻辑模型 id**：业务只引用 `model="smart"` / `model="fast"` / `model="embed"` 等逻辑名，物理路由（用哪个云、哪个 key、哪个 base_url）在 `llm.yaml` 配置
3. **可观测**：单一审计源、按角色/模型/天聚合的用量统计、命令行可查
4. **可控并发**：LLM 调用的并发上限内部控制，业务层完全无感知；带全局开关
5. **可缓存**：默认对 LLM chat 不缓存（输出非确定性），对 embed / 显式 opt-in 的 chat 调用缓存
6. **后端可插拔**：Cline / 直 HTTP / Ollama / Stub，统一 backend 协议，加新 backend 不动业务
7. **凭据隔离**：API key 不进 git，不进审计日志，子进程 env 隔离（不读宿主机 OPENAI_API_KEY 等）

---

## 2. `llm.yaml` Schema

每 Run 一份：`<run>/config/llm.yaml`。**重构后**：`base_url / api_key_ref / ollama_host / cline_*` 字段全部迁到 `providers.yaml`；`models[*]` 只引用 `provider` 与 `model_id`。

```yaml
schema: chronicle_sim_v3/llm@1

# 物理模型注册（引用 providers.yaml 中的 provider_id）
models:
  qwen-max:
    provider: dashscope_main
    model_id: qwen-max
    invocation: openai_compat_chat
    extra:
      thinking: false
      enable_thinking: false

  qwen-turbo:
    provider: dashscope_main
    model_id: qwen-turbo
    invocation: openai_compat_chat

  qwen-coding:
    provider: dashscope_coding
    model_id: qwen3.5-plus
    invocation: openai_compat_chat

  kimi:
    provider: moonshot_main
    model_id: kimi-k2.5
    invocation: openai_compat_chat

  local-llama:
    provider: ollama_local
    model_id: llama3:70b
    invocation: ollama_chat

  embed-cn:
    provider: dashscope_main
    model_id: text-embedding-v4
    invocation: openai_compat_embed

  embed-local:
    provider: ollama_local
    model_id: nomic-embed-text
    invocation: ollama_embed

  stub:
    provider: stub_local
    model_id: ""
    invocation: stub

# 路由：逻辑 id → 物理 id
# Agent 层 SimpleChatRunner / ReActRunner 引用 llm_route="smart" / "fast" / "embed"
routes:
  smart:    qwen-max
  fast:     qwen-turbo
  coding:   qwen-coding
  rumor:    qwen-turbo                 # 谣言改写专用（成本/速度优先）
  probe:    qwen-max                   # 探针要细致
  embed:    embed-cn
  offline:  stub

# Backend 全局策略（cline_* 已删除——cline 子进程现归 agents/runners/cline.py）

# 并发与限流
concurrency:
  enabled: true                        # false → max_inflight 强制 1
  max_inflight: 4                      # 全局；可被 per-route 覆盖

rate_limits:
  default:                              # 所有未单独配置的路由
    qpm: 60                             # 每分钟请求数
    tpm: 200000                         # 每分钟 token 数
  routes:
    smart: { qpm: 30, tpm: 100000 }    # qwen-max 限制更严
    embed: { qpm: 200 }                # 嵌入只限 qpm

# 重试
retry:
  default:
    max_attempts: 3
    backoff: exp                        # exp | fixed
    base_ms: 800
    retry_on:                           # 哪些错误重试
      - timeout
      - network
      - rate_limit
      - server_5xx
      - cline_libuv_crash               # Windows 下 0xC0000409 这类
    no_retry_on:
      - auth_error
      - bad_request

# 缓存
cache:
  enabled: true                         # false → 整个 LLM 缓存关
  default_mode: off                     # off | hash | exact
  per_route:
    embed:    hash                      # 嵌入向量天然适合 hash
    offline:  hash                      # stub 调用也可缓存（CI 加速）

# 超时
timeout:
  default_sec: 600
  per_route:
    smart: 1200                         # 大模型放宽
    embed: 60

# 审计
audit:
  enabled: true
  log_user_prompt: false                # 默认不记完整 user（隐私）
  log_user_prompt_max_chars: 4000       # 记则截断

# Stub 行为
stub:
  fixed_seed: 42
```

### 2.1 关键约束（重构后）

- `models[*].provider` **必须**指向已注册的 `providers.yaml` provider；缺失 → `LLMConfigError`
- `llm.yaml` 里出现字面 `api_key:` 直接拒绝（凭据迁到 `providers.yaml`，且必须 `api_key_ref:`）
- `models[*]` 不再含 `base_url / api_key_ref / ollama_host / cline_*` 字段
- 物理 model id 不限格式；逻辑 id（routes 的 key）建议 `[a-z][a-z0-9_]*`
- routes 必须包含 `embed`（嵌入）和至少一个对话路由

### 2.2 Pydantic 模型

```python
class ApiKeyRef(BaseModel):
    """env:VAR | file:path"""
    kind: Literal["env", "file"]
    value: str

    @classmethod
    def parse(cls, raw: str) -> "ApiKeyRef":
        if raw.startswith("env:"):
            return cls(kind="env", value=raw[4:])
        if raw.startswith("file:"):
            return cls(kind="file", value=raw[5:])
        raise ValueError(f"api_key_ref 必须以 env: 或 file: 开头，得到 {raw!r}")

    def resolve(self, run_dir: Path) -> str:
        if self.kind == "env":
            v = os.environ.get(self.value, "")
            if not v: raise LLMConfigError(f"环境变量 {self.value} 未设置")
            return v
        # file
        p = (run_dir / "config" / self.value).resolve()
        if not p.is_file(): raise LLMConfigError(f"密钥文件不存在: {p}")
        return p.read_text(encoding="utf-8").strip()


class ModelDef(BaseModel):
    """重构后：base_url / api_key_ref / ollama_host 已迁到 ProvidersConfig。"""
    provider: str                              # provider_id（指 providers.yaml）
    model_id: str = ""
    invocation: Literal[
        "openai_compat_chat", "openai_compat_embed",
        "ollama_chat", "ollama_embed",
        "stub",
    ]
    extra: dict = Field(default_factory=dict)


class RetryPolicy(BaseModel):
    max_attempts: int = 3
    backoff: Literal["exp", "fixed"] = "exp"
    base_ms: int = 800
    retry_on: list[str] = Field(default_factory=lambda: [
        "timeout", "network", "rate_limit", "server_5xx", "cline_libuv_crash",
    ])
    no_retry_on: list[str] = Field(default_factory=lambda: [
        "auth_error", "bad_request",
    ])


class RateLimit(BaseModel):
    qpm: int | None = None
    tpm: int | None = None


class CacheConfig(BaseModel):
    enabled: bool = True
    default_mode: Literal["off", "hash", "exact"] = "off"
    per_route: dict[str, Literal["off", "hash", "exact"]] = Field(default_factory=dict)


class ConcurrencyConfig(BaseModel):
    enabled: bool = True
    max_inflight: int = 4


class AuditConfig(BaseModel):
    enabled: bool = True
    log_user_prompt: bool = False
    log_user_prompt_max_chars: int = 4000


class LLMConfig(BaseModel):
    schema_version: str = Field(alias="schema")
    models: dict[str, ModelDef]
    routes: dict[str, str]
    concurrency: ConcurrencyConfig = Field(default_factory=ConcurrencyConfig)
    rate_limits: dict = Field(default_factory=dict)
    retry: dict = Field(default_factory=dict)
    cache: CacheConfig = Field(default_factory=CacheConfig)
    timeout: dict = Field(default_factory=dict)
    audit: AuditConfig = Field(default_factory=AuditConfig)
    stub: dict = Field(default_factory=dict)
    # 重构后删除：backends / cline_config_dir（cline 已迁出 LLM 层）
```

---

## 3. LLMService — Agent 层内部依赖（重构后）

> **业务节点不再直接持有 LLMService**：业务通过 `services.agents` 调 `AgentService.run`；
> SimpleChatRunner / ReActRunner 在内部使用注入的 `llm_service.chat(...)`。
> `csim llm test` 仅作开发调试入口。

### 3.1 数据结构

```python
@dataclass
class Prompt:
    """渲染前的 prompt 描述。"""
    spec_ref: str                              # data/agent_specs/<x>.toml
    vars: dict[str, Any] = field(default_factory=dict)   # 模板变量
    system_extra: str = ""                     # 罕见追加


@dataclass
class OutputSpec:
    kind: Literal["text", "json_object", "json_array", "jsonl"]
    artifact_filename: str = ""                # ACT 模式工作区落盘文件名
    json_schema: dict | None = None            # 可选；解析时校验


@dataclass
class LLMRef:
    """节点端构造的调用引用（agent.cline 节点 params 里的 llm 块）。"""
    role: str                                  # audit/usage 标签，不影响路由
    model: str                                 # 逻辑模型 id（routes 的 key）
    output: OutputSpec
    cache: Literal["off", "hash", "exact"] = "off"
    timeout_sec: int | None = None             # 覆盖默认
    retry_max_attempts: int | None = None      # 覆盖默认
    extra_argv: list[str] = field(default_factory=list)   # 给 backend（极少用）


@dataclass
class LLMResult:
    text: str                                  # 原始文本（jsonl 模式是拼接后的 say.text）
    parsed: Any                                # 按 OutputSpec 解析后的结构
    tool_log: list[dict] = field(default_factory=list)   # jsonl 模式的工具调用日志
    exit_code: int = 0
    cache_hit: bool = False
    cached_at: str | None = None
    timings: dict[str, int] = field(default_factory=dict)   # auth/exec/parse ms
    audit_id: str = ""                         # 写到 audit 后的可定位 id
    raw_response: dict | None = None           # 仅 backend 内部诊断用，可能为 None
```

### 3.2 接口

```python
class LLMService:
    def __init__(
        self,
        run_dir: Path,
        provider_service: ProviderService,        # 新：必传
        config: LLMConfig | None = None,
        spec_search_root: Path | None = None,
    ): ...

    async def chat(self, ref: LLMRef, prompt: Prompt) -> LLMResult: ...

    async def embed(
        self,
        model: str,                            # 逻辑 id，例 "embed"
        texts: list[str],
        cache: Literal["off", "hash", "exact"] = "hash",
    ) -> list[list[float]]: ...

    def usage(self) -> "UsageStats": ...
    def stream_events(self) -> AsyncIterator[dict]: ...

    async def aclose(self) -> None: ...

    # 工具：路由解析（CLI / GUI 显示用）
    def resolve_route(self, logical: str) -> ResolvedModel: ...
```

### 3.3 内部分层

```
LLMService.chat / embed
   │
   ├─ Resolver       逻辑 id → ResolvedModel + Policy（凭据来自 ProviderService）
   │
   ├─ Audit.start    分配 audit_id；写 "request" 事件
   │
   ├─ Cache.lookup   按 mode 计算 key；命中 → 返回 LLMResult(cache_hit=True)
   │
   ├─ Limiter.acquire    Per-route + 全局并发/qpm/tpm 漏桶
   │
   ├─ RetryWrapper       带重试调用 backend
   │      │
   │      └─ Backend.invoke
   │            │
   │            ├─ OpenAICompatChatBackend  httpx 直调
   │            ├─ OllamaChatBackend
   │            ├─ EmbedBackend       /embeddings or /api/embed
   │            └─ StubBackend        本地占位
   │   （ClineBackend 已删除：cline 现在是 agents/runners/cline.py 的子进程）
   │
   ├─ Cache.store    deterministic 时落
   │
   ├─ Audit.end      写 "response" 事件，含 cache_hit/timings/usage
   │
   └─ Usage.record   tokens/calls/latency 累计
```

---

## 4. Resolver

### 4.1 ResolvedModel

```python
@dataclass(frozen=True)
class ResolvedModel:
    logical: str                       # "smart"
    physical: str                      # "qwen-max"
    provider_id: str                   # 新：来自 ModelDef.provider
    invocation: str                    # "openai_compat_chat" | ... | "stub"
    base_url: str                      # 来自 ResolvedProvider.base_url
    api_key: str                       # 来自 ResolvedProvider.api_key（不要写日志）
    model_id: str
    extra: dict
    route_hash: str                    # 用于 cache key（不含 api_key）
```

### 4.2 解析流程（重构后：通过 ProviderService 拿凭据）

```python
def resolve_route(self, logical: str) -> ResolvedModel:
    physical = self.config.routes.get(logical)
    if not physical:
        raise LLMConfigError(f"未知逻辑模型 id: {logical}")
    mdef = self.config.models.get(physical)
    if not mdef:
        raise LLMConfigError(f"路由 {logical}→{physical} 但 {physical} 未注册")
    # 通过 ProviderService 拿凭据（唯一持有 raw key 的层）
    rp = self.provider_service.resolve(mdef.provider)
    return ResolvedModel(
        logical=logical,
        physical=physical,
        provider_id=mdef.provider,
        invocation=mdef.invocation,
        base_url=rp.base_url,
        api_key=rp.api_key,
        model_id=mdef.model_id,
        extra=mdef.extra,
        route_hash=sha256_hex(canonical_json({
            "physical": physical,
            "provider_hash": rp.provider_hash,    # 不含 api_key
            "invocation": mdef.invocation,
            "model_id": mdef.model_id,
            "extra": mdef.extra,
        }))[:16],
    )
```

`route_hash` 进 cache key（业务侧），api_key 变化不应失效缓存（key 换了内容没换）。

### 4.3 Policy 解析

```python
@dataclass(frozen=True)
class CallPolicy:
    timeout_sec: int
    retry: RetryPolicy
    rate_limit: RateLimit
    cache_mode: Literal["off", "hash", "exact"]
    audit_log_user_prompt: bool

def policy_for(self, logical: str, ref: LLMRef) -> CallPolicy:
    cfg = self.config
    timeout = ref.timeout_sec or cfg.timeout.get("per_route", {}).get(logical) or cfg.timeout.get("default_sec", 600)
    retry = parse_retry(cfg.retry.get(logical, cfg.retry.get("default", {})))
    if ref.retry_max_attempts: retry.max_attempts = ref.retry_max_attempts
    rl = parse_rl(cfg.rate_limits.get("routes", {}).get(logical, cfg.rate_limits.get("default", {})))
    cache_mode = ref.cache or cfg.cache.per_route.get(logical, cfg.cache.default_mode)
    if not cfg.cache.enabled:
        cache_mode = "off"
    return CallPolicy(
        timeout_sec=timeout, retry=retry, rate_limit=rl,
        cache_mode=cache_mode, audit_log_user_prompt=cfg.audit.log_user_prompt,
    )
```

---

## 5. Backend 协议

### 5.1 接口

```python
class ChatBackend(Protocol):
    name: str                                  # "cline_openai_compat" / ...

    async def invoke(
        self,
        resolved: ResolvedModel,
        prompt: Prompt,
        output: OutputSpec,
        timeout_sec: int,
        cancel: CancelToken,
        observer: BackendObserver,             # 用于 stream stderr / 进度回调
    ) -> BackendResult: ...


class EmbedBackend(Protocol):
    name: str
    async def invoke(
        self,
        resolved: ResolvedModel,
        texts: list[str],
        timeout_sec: int,
        cancel: CancelToken,
    ) -> list[list[float]]: ...


@dataclass
class BackendResult:
    text: str                                  # 原始 stdout 或工作区文件合并后的内容
    tool_log: list[dict] = field(default_factory=list)
    exit_code: int = 0
    timings: dict[str, int] = field(default_factory=dict)
    raw: dict | None = None                    # 诊断用（非必须）
    workspace_archive: Path | None = None      # ClineBackend 归档路径
    tokens_in: int | None = None               # 后端能提供则填
    tokens_out: int | None = None
```

### 5.2 ClineBackend（已删除，迁至 Agent 层）

> **重构说明**：原 `LLMService` 内的 `ClineBackend` 已删除。Cline 子进程现在归 `agents/runners/cline.py` 的 `ClineRunner`，
> 由 `AgentService` 在 `runner_kind == "cline"` 时实例化；凭据直接来自 `ProviderService`，**不再经过 LLM 层**。
>
> 详见 `v3-agent.md §7.1`。

### 5.3 OpenAICompatChatBackend

- `httpx.AsyncClient(trust_env=False)` POST `<base>/chat/completions`
- 请求体严格按 OpenAI 兼容格式
- 返回 `BackendResult(text=msg.content, tokens_in=usage.prompt_tokens, tokens_out=usage.completion_tokens)`
- 不写工作区，只走 stdout 等价路径

### 5.4 OpenAICompatEmbedBackend / OllamaEmbedBackend

- `httpx.AsyncClient(trust_env=False)` 直调 `/embeddings` 或 `/api/embed`
- 自动分批（DashScope 单批 ≤10）

> **代理硬纪律**：本层所有 `httpx.AsyncClient` 一律 `trust_env=False`，不读 `HTTP_PROXY` / `HTTPS_PROXY` / `.netrc`；
> Cline 子进程的 env 剥代理见 `v3-agent.md §5.1`。本系统全网无代理（用户硬约束）。

### 5.5 StubBackend

- 不发网络
- 按 spec_ref 与 vars 内容做规则化占位（与 v2 `stub_response_text` 同等行为，但完全重写）
- 可注入 fixed_seed 让占位文本确定性

### 5.6 BackendObserver

```python
class BackendObserver(Protocol):
    def on_stderr_line(self, line: str) -> None: ...
    def on_phase(self, phase: str, detail: dict) -> None: ...
```

> 重构后 LLM 层已无子进程 backend；`BackendObserver` 仅留给 OpenAICompat / Ollama HTTP 调用做流式 phase 回调。
> 子进程编排（cline / external）由 Agent 层 `SubprocessAgentRunner` 基类处理。

---

## 6. Limiter（并发与限流）

### 6.1 设计

LLM 层 limiter **只覆盖直调 LLM 的路径**（即 `LLMService.chat / embed` 自身）。Agent 层另有 `AgentLimiter`（per-runner_kind 信号量），与 LLM 层 limiter 串联：例如 ReActRunner 一次 task 受 `react=2` 限制，每轮 chat 又受 LLM 层 `concurrency.max_inflight` 限制。

```python
class Limiter:
    def __init__(self, cfg: LLMConfig):
        self._gate = asyncio.Semaphore(
            cfg.concurrency.max_inflight if cfg.concurrency.enabled else 1
        )
        self._qpm_buckets: dict[str, TokenBucket] = {}
        self._tpm_buckets: dict[str, TokenBucket] = {}

    @asynccontextmanager
    async def acquire(self, route: str, est_tokens: int):
        await self._gate.acquire()
        await self._qpm_bucket(route).acquire(1)
        if est_tokens:
            await self._tpm_bucket(route).acquire(est_tokens)
        try:
            yield
        finally:
            self._gate.release()
```

### 6.2 关闭并发

```yaml
concurrency:
  enabled: false
```

→ semaphore 容量 = 1，所有调用串行（沿用 v2 全局 gate 的行为）。CLI `--no-concurrency` 同效。

### 6.3 估算 token 数

调用前简单估算（中文 1 char ≈ 1.5 token，英文 1 word ≈ 1.3 token），用于 tpm 桶预扣；调用后用真实 `tokens_in/out` 校准（多扣的退回桶）。

```python
def estimate_tokens(prompt: Prompt) -> int:
    # 渲染后总字符数 / 2 粗估
    rendered = render_prompt_for_count(prompt)
    return max(1, len(rendered) // 2)
```

### 6.4 TokenBucket 实现

标准漏桶：`capacity = qpm`、`refill_rate = qpm / 60` per second。`acquire(n)` 不够时 `await asyncio.sleep(...)` 到够。

---

## 7. Cache

### 7.1 三种模式

- **off**：永不命中、永不写
- **hash**：key = sha256(物理路由 + 渲染后 prompt + output_spec + 重要 extra) → 命中
- **exact**：key = sha256(渲染后 prompt 的精确字节) + 物理路由 → 命中（更严，几乎等同 hash 但避免一些 normalize 差异）

默认行为见 §2 `cache.per_route`：
- `embed` 默认 `hash`（嵌入向量天然适合）
- 普通 chat 默认 `off`
- `agent.cline` 节点 params 显式传 `cache: hash` 才开

### 7.2 LLM Cache key

```python
def chat_cache_key(resolved: ResolvedModel, prompt: Prompt, output: OutputSpec, mode: str) -> str:
    rendered_system, rendered_user = render(prompt)
    components = [
        "chat",
        resolved.route_hash,                   # 路由变化失效（不含 api_key）
        sha256_hex(read_spec_file(prompt.spec_ref)),  # spec 文件变化失效
        sha256_hex(rendered_system),
        sha256_hex(rendered_user),
        canonical_json(output.dict()),
        mode,
        LLM_CACHE_FORMAT_VER,
    ]
    return sha256_hex("\x1f".join(components))
```

```python
def embed_cache_key(resolved: ResolvedModel, text: str) -> str:
    return sha256_hex("\x1f".join([
        "embed",
        resolved.route_hash,
        sha256_hex(text),
        LLM_CACHE_FORMAT_VER,
    ]))
```

### 7.3 存储

```
<run>/cache/llm/
  chat/<sha[:2]>/<sha>.json
  embed/<sha[:2]>/<sha>.json
```

LLM cache 与节点 cache 物理分离，**避免引擎 cache 失效误删 LLM cache**。

LLM cache 条目：

```json
{
  "schema": "chronicle_sim_v3/llm_cache@1",
  "key": "sha256:...",
  "kind": "chat",
  "physical_model": "qwen-max-cline",
  "route_hash": "...",
  "created_at": "...",
  "result": {
    "text": "...",
    "parsed": {...},
    "tool_log": [...],
    "exit_code": 0,
    "tokens_in": 1234,
    "tokens_out": 567
  }
}
```

### 7.4 全局开关

`cache.enabled: false` 整个 LLM 缓存关。CLI `--no-llm-cache` 等同（与 cook 的 `--no-cache` 独立）。

---

## 8. Audit

### 8.1 文件

`<run>/audit/llm/<YYYYMMDD>.jsonl`，每行一个事件：

```json
{
  "ts": "2026-04-22T12:00:00.123Z",
  "audit_id": "ulid:01HW...",
  "phase": "request",
  "route": "smart",
  "physical": "qwen-max-cline",
  "backend": "cline_openai_compat",
  "role": "director",
  "spec_ref": "director.toml",
  "system_chars": 4123,
  "user_chars": 12345,
  "user_preview": "...",                        // 仅 audit.log_user_prompt=true
  "cache_mode": "off"
}
{
  "ts": "...",
  "audit_id": "ulid:01HW...",
  "phase": "response",
  "status": "ok",                               // ok | error | timeout | cancelled
  "cache_hit": false,
  "tokens_in": 1234,
  "tokens_out": 567,
  "latency_ms": 4321,
  "exit_code": 0,
  "ws_archive": "ws_archive/20260422T120000Z_director_a1b2c3",
  "tool_log_count": 7
}
```

### 8.2 Audit ID

[ULID](https://github.com/ulid/spec) 形式（时间戳 + 随机），可排序、可定位单次调用：

```
csim llm audit show ulid:01HW...
```

### 8.3 隐私

- API key **永不入日志**（解析后只在内存）
- user prompt 默认不记（`log_user_prompt: false`），打开后按 `log_user_prompt_max_chars` 截断
- system prompt 不记（按 spec_ref 引用）

### 8.4 与 EventBus 关系

Audit 写文件；同时把 `request/response` 事件转发给 EventBus → cook timeline / GUI / CLI tail 可以实时看：

```
csim llm audit tail -f
```

---

## 9. UsageStats

### 9.1 结构

```python
@dataclass
class UsageStats:
    by_route_day:  dict[tuple[str, str], UsageBucket]      # (route, "20260422")
    by_role_day:   dict[tuple[str, str], UsageBucket]
    by_model_day:  dict[tuple[str, str], UsageBucket]      # 物理 model
    totals:        UsageBucket

@dataclass
class UsageBucket:
    calls: int = 0
    cache_hits: int = 0
    errors: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    latency_ms_p50: int = 0
    latency_ms_p95: int = 0
    cost_estimate_usd: float = 0.0             # 可选；按模型表内 cost-per-1k 计算
```

### 9.2 持久化

`<run>/audit/usage/<YYYYMMDD>.json` 每天一份汇总（按需重算 vs 增量更新）。简单实现：每次 LLMService 启动时重扫当天 `audit/llm/<today>.jsonl`，命中即触发增量更新；CLI 查询时按需聚合。

### 9.3 Cost estimate

可选：在 ModelDef 增加 `cost_per_1k_in` / `cost_per_1k_out`，audit 时算 cost 字段。无成本表则 0。P0 不做，P5/P6 加。

---

## 10. Retry 与错误分类

### 10.1 错误类目

```python
class LLMError(Exception): ...
class LLMTimeoutError(LLMError): ...
class LLMNetworkError(LLMError): ...
class LLMRateLimitError(LLMError): ...
class LLMAuthError(LLMError): ...
class LLMServerError(LLMError): ...                # 5xx
class LLMBadRequestError(LLMError): ...            # 4xx 非鉴权
class LLMBackendCrashError(LLMError): ...          # Cline 子进程异常退出
class LLMOutputParseError(LLMError): ...           # 无法解析为 OutputSpec.kind
class LLMCancelledError(LLMError): ...
```

### 10.2 错误分类（backend → tag）

ClineBackend：
- 子进程超时 → `LLMTimeoutError`，retry tag `timeout`
- exit code != 0 含 "401" / "403" / "auth" → `LLMAuthError`，tag `auth_error`
- exit code != 0 含 "rate" / "429" → `LLMRateLimitError`，tag `rate_limit`
- Windows 0xC0000409 / `UV_HANDLE_CLOSING` → `LLMBackendCrashError`，tag `cline_libuv_crash`
- exit code != 0 含 "500" / "502" / "503" → `LLMServerError`，tag `server_5xx`
- 其它 exit != 0 → `LLMError`，tag `unknown`

DirectHttpBackend / EmbedBackend：标准 HTTP 状态码映射。

### 10.3 重试逻辑

```python
async def _with_retry(self, policy: RetryPolicy, fn):
    last_err = None
    for attempt in range(1, policy.max_attempts + 1):
        try:
            return await fn()
        except LLMCancelledError:
            raise
        except LLMError as e:
            tag = classify(e)
            if tag in policy.no_retry_on or tag not in policy.retry_on:
                raise
            if attempt == policy.max_attempts:
                raise
            await asyncio.sleep(_backoff_delay(policy, attempt))
            last_err = e
    raise last_err
```

### 10.4 输出解析失败

`OutputSpec.kind=json_object` 但 backend 返回非 JSON → 抛 `LLMOutputParseError`，**默认不重试**（重试同样的 prompt 大概率同样失败）。

例外：业务节点（如 `agent.cline`）可在 params 里设 `parse_retry: 1`，由节点自己内部重试一轮（不是 LLMService 的事）。

---

## 11. agent.cline / agent.run 节点（已迁至 Agent 层）

> **重构后**：`agent.cline` / `agent.run` 节点的实现详见 `v3-agent.md §8`。
>
> - `agent.run` 为新主节点（统一接口），通过 `services.agents.run(AgentRef, AgentTask)` 调用
> - `agent.cline` 为 thin alias 节点（兼容 P3 graph），内部固定 `agent: cline_default` 转发到 `agent.run`
> - 业务节点 **不再** import `services.llm`；CI lint 强制
>
> 写盘原则不变：`agent.run / agent.cline` 不直接产生 mutation；后续 `write.*` 节点引用其 `parsed` 输出。

---

## 12. CLI（`csim llm *` —— 开发调试入口）

> **重构后**：`csim llm *` 标注为「开发调试入口；业务请走 csim agent test」。
> 所有命令保留可用，help 字符串新增提示。

### 12.1 命令

```
csim llm route show
    展示 routes 表与解析结果（physical/backend/base_url，api_key 显示长度+头尾）

csim llm route set <logical>=<physical>
    修改 llm.yaml 的 routes（保留注释）

csim llm models
    列所有物理 model 及 backend / base_url

csim llm test --model <logical> --prompt "<text>" [--system "<text>"]
    最小调用，不走 spec_ref；用于排错连接

csim llm test-emb --model <logical> --texts a,b,c
    测试嵌入

csim llm usage [--by route|role|model|day] [--from YYYY-MM-DD]
    展示用量表（rich 格式）

csim llm audit tail [-n 50] [-f]
csim llm audit show <ulid>
    单次调用详情（不含 api_key / 默认不含 user_prompt）

csim llm cache stats
csim llm cache clear [--kind chat|embed]
csim llm cache invalidate --route <logical>
```

### 12.2 全局选项（与 cook 命令叠加）

```
--no-llm-cache               覆盖 cache.enabled=false
--no-llm-concurrency         覆盖 concurrency.enabled=false
```

---

## 13. 与 v2 的差异说明（仅对照，不引用 v2 代码）

| v2 | v3 |
|---|---|
| `provider_profile_for_agent(slot, cfg)` 读 12 套槽位 | `routes:` 路由表，业务只见逻辑 id |
| `effective_connection_block` 复杂 override 规则 | 没有 override；所有 agent 通过 routes 显式 |
| `cline_runner.run_agent_cline` 业务直调 | 业务调 `LLMService.chat`，runner 是 backend 内部 |
| `audit_log` + `llm_effective` + `traces/` 三处 | 单一 `audit/llm/<day>.jsonl` + ULID 关联 |
| 全局 `_llm_gate` `asyncio.Lock` 串行 | `Limiter` 内 semaphore + qpm/tpm + per-route |
| 无并发 | `concurrency.max_inflight` 可调；可关 |
| 无统计 | `usage()` + `csim llm usage` |
| 无缓存 | LLM 缓存（默认 off，embed 默认 hash） |
| `embeddings` 顶层块 + 可从对话槽推导 | `routes.embed` 必须显式 |

---

## 14. 关键决策备忘

### 14.1 为什么 routes 是必需的，不允许"裸物理 id"

业务节点直接写物理 id 会让"换模型"动业务图。routes 这层抽象代价小（一行 yaml）但隔离力强。

### 14.2 为什么 api_key 必须 ref

避免误进 git；config 文件可分享审阅；CI 只校验结构不需要密钥。

### 14.3 为什么 LLM cache 与 cook cache 物理分离

- cook cache 失效（节点版本变）不应丢 LLM 调用结果
- LLM cache 可跨 cook 跨 Run 共享（未来甚至可全局；P5+）
- 容量与 GC 策略不同

### 14.4 为什么 agent.cline 不直接写 mutation

- 写 = 显式 NodeKind = 图上可见；agent 输出怎么落盘是图的事，不是 agent 的事
- 同一个 agent 输出可以同时被多个 write 节点引用（一份输出落多处）
- 测试时 mock 写节点比 mock agent 容易

### 14.5 为什么 spec_ref 是路径而不是 inline prompt

- prompt 单源：所有 prompt 都在 `data/agent_specs/` 一处
- prompt 与 graph 解耦：调 prompt 不用改图
- prompt 内容 hash 进 cache key：改 prompt 自然失效

### 14.6 为什么不在 LLMService 做 prompt 渲染

LLMService 接收 `Prompt(spec_ref, vars)`，渲染发生在 LLMService 内部（在调 backend 之前）。原因：cache key 计算需要"渲染后的字节"才稳定；audit 也需要记录 system_chars / user_chars。
