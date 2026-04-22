# RFC: ChronicleSim v3 — LLM 抽象层

状态：Draft  
作者：架构组  
范围：LLMService、Backend、Resolver、Limiter、Cache、Audit、Usage、`llm.yaml` schema、`csim llm` 命令  
配套：`v3-engine.md`、`v3-node-catalog.md`、`v3-implementation.md`

---

## 0. 文档范围

本 RFC 描述 v3 的 **LLM 抽象层**：业务节点（特别是 `agent.cline`）调用模型的唯一入口。

**关键定位**：节点 / 引擎 / GUI **都不直接接触** Cline 子进程、httpx、API key、base_url 等细节，全部由 LLMService 封装。

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

每 Run 一份：`<run>/config/llm.yaml`。

```yaml
schema: chronicle_sim_v3/llm@1

# 物理模型注册
models:
  qwen-max-cline:
    backend: cline_openai_compat
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    api_key_ref: env:DASHSCOPE_API_KEY
    model_id: qwen-max
    extra:
      thinking: false
      enable_thinking: false

  qwen-turbo-cline:
    backend: cline_openai_compat
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    api_key_ref: env:DASHSCOPE_API_KEY
    model_id: qwen-turbo

  kimi-cline:
    backend: cline_openai_compat
    base_url: https://api.moonshot.cn/v1
    api_key_ref: file:secrets/moonshot.key
    model_id: kimi-k2.5

  local-llama-cline:
    backend: cline_ollama
    ollama_host: http://127.0.0.1:11434
    model_id: llama3:70b

  qwen-max-direct:
    backend: openai_compat_chat        # 不走 Cline 的直调（P6 才默认实现）
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    api_key_ref: env:DASHSCOPE_API_KEY
    model_id: qwen-max

  embed-cn:
    backend: openai_compat_embed
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    api_key_ref: env:DASHSCOPE_API_KEY
    model_id: text-embedding-v4

  embed-local:
    backend: ollama_embed
    ollama_host: http://127.0.0.1:11434
    model_id: nomic-embed-text

  stub:
    backend: stub

# 路由：逻辑 id → 物理 id
# 业务节点引用 model="smart" / "fast" / "embed"，物理映射在这一层
routes:
  smart:    qwen-max-cline
  fast:     qwen-turbo-cline
  rumor:    qwen-turbo-cline           # 谣言改写专用（成本/速度优先）
  probe:    qwen-max-cline             # 探针要细致
  embed:    embed-cn
  offline:  stub

# Backend 全局策略
backends:
  cline_openai_compat:
    cline_executable: ""               # 空 = 自动探测；否则绝对路径
    cline_timeout_sec: 3600
    cline_verbose: false
    cline_stream_stderr: true
    no_proxy: true                     # 强制 NO_PROXY=*

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

# Cline 凭据目录（默认 <run>/.cline_config）
cline_config_dir: null

# Stub 行为
stub:
  fixed_seed: 42
```

### 2.1 关键约束

- `api_key_ref` **必须**是 `env:VAR_NAME` 或 `file:relative/path.key`（相对 `<run>/config/`）；**禁止内联 key**
- CI lint：`llm.yaml` 里出现 `api_key:` 直接拒绝（必须 `api_key_ref:`）
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
    backend: Literal[
        "cline_openai_compat", "cline_ollama",
        "openai_compat_chat", "openai_compat_embed",
        "ollama_chat", "ollama_embed",
        "stub",
    ]
    base_url: str = ""
    api_key_ref: str | None = None             # env:VAR / file:path
    ollama_host: str = ""
    model_id: str = ""
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
    backends: dict[str, dict] = Field(default_factory=dict)
    concurrency: ConcurrencyConfig = Field(default_factory=ConcurrencyConfig)
    rate_limits: dict = Field(default_factory=dict)
    retry: dict = Field(default_factory=dict)
    cache: CacheConfig = Field(default_factory=CacheConfig)
    timeout: dict = Field(default_factory=dict)
    audit: AuditConfig = Field(default_factory=AuditConfig)
    cline_config_dir: str | None = None
    stub: dict = Field(default_factory=dict)
```

---

## 3. LLMService — 业务唯一入口

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
    def __init__(self, run_dir: Path, config: LLMConfig | None = None): ...

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
   ├─ Resolver       逻辑 id → ResolvedModel + Policy
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
   │            ├─ ClineBackend     起子进程，沿用 v2 经验
   │            ├─ DirectHttpBackend  (P6) httpx 直调
   │            ├─ EmbedBackend       /embeddings or /api/embed
   │            └─ StubBackend        本地占位
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
    physical: str                      # "qwen-max-cline"
    backend: str                       # "cline_openai_compat"
    base_url: str
    api_key: str                       # 已解析（不要写日志）
    ollama_host: str
    model_id: str
    extra: dict
    route_hash: str                    # 用于 cache key（不含 api_key）
```

### 4.2 解析流程

```python
def resolve_route(self, logical: str) -> ResolvedModel:
    physical = self.config.routes.get(logical)
    if not physical:
        raise LLMConfigError(f"未知逻辑模型 id: {logical}")
    mdef = self.config.models.get(physical)
    if not mdef:
        raise LLMConfigError(f"路由 {logical}→{physical} 但 {physical} 未注册")
    api_key = ApiKeyRef.parse(mdef.api_key_ref).resolve(self.run_dir) if mdef.api_key_ref else ""
    return ResolvedModel(
        logical=logical,
        physical=physical,
        backend=mdef.backend,
        base_url=mdef.base_url,
        api_key=api_key,
        ollama_host=mdef.ollama_host,
        model_id=mdef.model_id,
        extra=mdef.extra,
        route_hash=sha256_hex(canonical_json({
            "physical": physical,
            "backend": mdef.backend,
            "base_url": mdef.base_url,
            "model_id": mdef.model_id,
            "ollama_host": mdef.ollama_host,
            "extra": mdef.extra,
            # 故意不含 api_key
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

### 5.2 ClineBackend（核心）

封装现 v2 `cline_runner` 的全部逻辑，业务无感：

- 解析 `cline_executable`（PATH / Windows %APPDATA% 自动探测）
- 创建临时 cwd `<run>/.chronicle_sim/ws/<uuid>/`
- 写 `.clinerules/01_role.md`（Prompt.spec 渲染后的 system）
- 写 `.clinerules/02_mcp.md`（如 spec 有 `mcp=chroma`）
- 写 `.clinerules/03_output_contract.md`（仓库通用契约）
- 写 `input.md`（user_text 全文）
- 调 `cline auth --config <run>/.cline_config -p openai -k <key> -m <model> -b <base>` 刷凭据
- 调 `cline task -y -a --config <run>/.cline_config -c <cwd> --timeout <sec> [--json] <SHORT_PROMPT>`
- argv 末参恒为短引导句（不传 user 全文）
- env：`CLINE_DIR=<run>/.cline_config`、剥代理、`NO_PROXY=*`
- Windows：`CREATE_NO_WINDOW`、libuv 抖动重试 3 次
- stderr 流式回调到 `observer`
- 工作区文件优先于 stdout（按 `OutputSpec.artifact_filename` 优先 read，stdout 兜底）
- 完成后 `archive_workspace_after_run` 移到 `.chronicle_sim/ws_archive/`，返回归档路径

### 5.3 OpenAICompatChatBackend（P6 才默认实现）

- `httpx.AsyncClient(trust_env=False)` POST `<base>/chat/completions`
- 请求体严格按 OpenAI 兼容格式
- 返回 `BackendResult(text=msg.content, tokens_in=usage.prompt_tokens, tokens_out=usage.completion_tokens)`
- 不写工作区，只走 stdout 等价路径

### 5.4 OpenAICompatEmbedBackend / OllamaEmbedBackend

- httpx 直调 `/embeddings` 或 `/api/embed`
- 自动分批（DashScope 单批 ≤10）

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

ClineBackend 用于把子进程 stderr 流式吐到 cook timeline / GUI 终端。

---

## 6. Limiter（并发与限流）

### 6.1 设计

按你的拍板：**只对 LLM 做并发；上层无感**。

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

## 11. agent.cline 节点的实现（与 LLMService 的桥接）

`agent.cline` 是唯一的 LLM 调用节点，是 LLMService 的最大客户：

```python
@register_node
class AgentClineNode(Node):
    spec = NodeKindSpec(
        kind="agent.cline",
        category="agent",
        title="Agent (Cline)",
        description="调用 LLM 执行 agent 任务，spec 由 TOML 提供",
        inputs=(
            PortSpec("vars", TagRef("Json"), required=True,
                     doc="prompt 模板变量（dict）"),
        ),
        outputs=(
            PortSpec("text", TagRef("Str"), doc="原始文本输出"),
            PortSpec("parsed", TagRef("Json"), doc="按 output 解析后的结构"),
            PortSpec("tool_log", TagRef("Json"), doc="jsonl 模式工具日志"),
        ),
        params=(
            Param("agent_spec", "str", required=True, doc="data/agent_specs/<x>.toml"),
            Param("llm", "json", required=True, doc="LLMRef 字段：{role, model, output, cache?}"),
            Param("system_extra", "str", required=False, default="", doc="罕见追加"),
        ),
        reads=frozenset(),       # spec 文件读取在 LLMService 内部，不算 Context slice
        writes=frozenset(),
        version="1",
        cacheable=True,
        deterministic=False,     # LLM 输出非确定，引擎默认不缓存；除非 ref.cache != off
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        ref = LLMRef(
            role=params["llm"]["role"],
            model=params["llm"]["model"],
            output=OutputSpec(**params["llm"]["output"]),
            cache=params["llm"].get("cache", "off"),
        )
        prompt = Prompt(
            spec_ref=params["agent_spec"],
            vars=inputs["vars"],
            system_extra=params.get("system_extra", ""),
        )
        result = await services.llm.chat(ref, prompt)
        return NodeOutput(values={
            "text": result.text,
            "parsed": result.parsed,
            "tool_log": result.tool_log,
        })
```

**`agent.cline` 不直接产生 mutation**——后续如有 write.* 节点就把 `parsed` 引到 write 节点。这保证：所有写盘动作都是显式 write 节点，没有"agent 偷偷写了什么"。

---

## 12. CLI（`csim llm *`）

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
