/**
 * 世界脑 → dev server → 决策服务（局域网 Laya，或公网 Jev）的请求通道。
 *
 * 浏览器**不直连**上游：key 放进页面等于公开，官方 Jev 也不给跨域。
 * 由 dev server 的 `/__gamedraft-api/jev/*`（`src/dev/jevProxyPlugin.ts`）读 `.env.local`
 * 里的地址与 key 转发。所以世界脑**只在开发模式可用**；打包版没有这条路，开关会说实话。
 * 两类上游的请求体与返回结构相同（System One 格式），多出来的字段一律忽略。
 */
import type { JevQuestion } from './jevProtocol';

export const JEV_API_BASE = '/__gamedraft-api/jev';

/**
 * - `unreachable`：上游服务连不上（Laya 被关了、地址错、网断）——跟 `no_server`（开发服务器上没这条路）分开
 * - `no_config`：`.env.local` 缺必填地址
 */
export type JevErrorKind =
  | 'no_key' | 'no_config' | 'no_server' | 'unreachable' | 'http' | 'timeout' | 'network' | 'bad_response'
  /** 熔断开着：这一单没发，当场回来——调用方走缺省，**不算出错**（见 packTransport.ts） */
  | 'breaker'
  /** 调用方自己不要了（`signal`）/ 换了决策服务 / 通道关了：已撤单 */
  | 'cancelled';

/**
 * 一单的附加信息：
 * - `priority`：上游排队优先级（0~100，大的先；只有推理 Hub 认），缺省按档；
 * - `tier`：这一单属于哪一档（回话 / 近 / 中 / 远 / 反思 / 探针），包通道按它定优先级、判熔断；
 * - `signal`：调用方不要了（关开关、换场景）→ 撤单；
 * - `name`：Hub 上显示的任务名（谁、哪类题），只为好认。
 */
export interface JevDecideOptions {
  priority?: number;
  tier?: 'reply' | 'near' | 'mid' | 'far' | 'reflect' | 'probe';
  signal?: AbortSignal;
  name?: string;
}

export type JevCallResult =
  | { ok: true; body: unknown; latencyMs: number }
  | { ok: false; kind: JevErrorKind; message: string; status?: number; latencyMs: number };

export interface JevStatus {
  /** dev server 上有没有这条路 */
  reachable: boolean;
  /** 必填键（地址 / key）都填了没有 */
  configured: boolean;
  /** 缺了哪个键 */
  missing?: string | null;
  /** laya / vercel / typesafe / openrouter */
  provider?: string;
  /** 配置里指定的模型；null = 让上游自己选 */
  model?: string | null;
  endpoint?: string | null;
  proxy?: string | null;
  /**
   * 上游健康检查（只有 Laya 有）：服务在不在、版本、装了哪些模型；走推理 Hub 时还有 key 认不认
   * （`auth`：ok / rejected / unknown）
   */
  upstream?: { ok: boolean; version?: string; loaded?: string[]; message?: string; auth?: 'ok' | 'rejected' | 'unknown' } | null;
  /** 这次查的是哪一路（`laya` / `jev`）、`.env.local` 的缺省是哪一路 */
  backend?: JevBackend;
  /** 这一路实际怎么走：经推理 Hub（异步任务、跟图像 / 视频共用 GPU）/ 直连 */
  route?: 'hub' | 'direct';
  defaultBackend?: JevBackend;
  /** 两路各自配没配好（游戏里切换用：没配好的那一路按钮上说实话） */
  backends?: Partial<Record<JevBackend, { configured: boolean; missing: string | null; provider: string; model: string | null }>>;
}

/** 决策服务的两路：局域网 Laya / 公网 Jev（Jev 走哪个入口由 `.env.local` 定） */
export type JevBackend = 'laya' | 'jev';
export const JEV_BACKENDS: readonly JevBackend[] = ['laya', 'jev'];

/** 上游的显示名：页面与状态牌上说"问 Laya"还是"问 Jev" */
export function deciderName(status: JevStatus | null): string {
  return status?.provider === 'laya' ? 'Laya' : 'Jev';
}

export function backendName(b: JevBackend): string {
  return b === 'laya' ? 'Laya' : 'Jev';
}

export interface JevTransport {
  /**
   * `opts.priority`：上游排队时的优先级（0~100，大的先；只有推理 Hub 认，缺省 50）。
   * 玩家亲手按 E 的回话给高一点——Hub 的 GPU 被图像 / 视频占着时它先算。
   */
  decide(
    body: { state: unknown; questions: Record<string, JevQuestion> },
    timeoutMs: number,
    opts?: JevDecideOptions,
  ): Promise<JevCallResult>;
  status(): Promise<JevStatus>;
  /** 游戏里切换走哪一路（null = `.env.local` 的缺省）；不支持切换的通道可以不实现 */
  setBackend?(b: JevBackend | null): void;
  /** 包通道的状态（熔断、撤单、P50 / P95）；一题一请求的旧通道没有 */
  stats?(): import('./packTransport').PackStats;
  /** 世界脑关了 / 拆了：在途的全撤、推送通道关掉 */
  close?(): void;
  /** 包通道的设计值（在途包数、熔断、探针保质期），跟场景的 tuning 走 */
  configure?(t: {
    maxPacksInFlight: number;
    breaker: import('./packTransport').BreakerTuning;
    probeExpireMs: number;
  }): void;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 找不到 fetch（极老的壳 / 测试环境）时的兜底：永远报"没有 dev server" */
const noFetch: FetchLike = () => Promise.reject(new Error('fetch unavailable'));

export class HttpJevTransport implements JevTransport {
  private readonly fetchFn: FetchLike;
  private backend: JevBackend | null = null;

  constructor(fetchFn?: FetchLike, private readonly base = JEV_API_BASE) {
    this.fetchFn = fetchFn ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : noFetch);
  }

  setBackend(b: JevBackend | null): void {
    this.backend = b;
  }

  private query(priority?: number): string {
    const q: string[] = [];
    if (this.backend) q.push(`backend=${this.backend}`);
    if (typeof priority === 'number' && Number.isFinite(priority)) q.push(`priority=${Math.round(priority)}`);
    return q.length ? `?${q.join('&')}` : '';
  }

  async decide(
    body: { state: unknown; questions: Record<string, JevQuestion> },
    timeoutMs: number,
    opts?: JevDecideOptions,
  ): Promise<JevCallResult> {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsed = () => Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    // 超时必须能把在途请求掐死：只 race 不 abort 的话，挂死的请求会一直占着连接
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;
    const timeout = new Promise<JevCallResult>((resolve) => {
      timer = setTimeout(() => {
        ctrl?.abort();
        resolve({ ok: false, kind: 'timeout', message: `超过 ${timeoutMs} ms 没回`, latencyMs: elapsed() });
      }, Math.max(1000, timeoutMs));
      // 调用方不要了：掐掉在途请求
      const signal = opts?.signal;
      if (signal) {
        const onAbort = () => {
          ctrl?.abort();
          resolve({ ok: false, kind: 'cancelled', message: '不要了', latencyMs: elapsed() });
        };
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener('abort', onAbort, { once: true });
          unlisten = () => signal.removeEventListener('abort', onAbort);
        }
      }
    });
    const call = (async (): Promise<JevCallResult> => {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.base}/systemone${this.query(opts?.priority)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
          signal: ctrl?.signal,
        });
      } catch (e) {
        return { ok: false, kind: 'network', message: String((e as Error)?.message ?? e), latencyMs: elapsed() };
      }
      const text = await res.text().catch(() => '');
      const ct = res.headers.get('content-type') ?? '';
      // dev server 上没有这条路时，vite 会回一整页 HTML（200）——判 content-type，不判状态码
      if (!ct.includes('application/json')) {
        return {
          ok: false,
          kind: 'no_server',
          message: '开发服务器上没有 Jev 转发（不是开发模式，或开发服务器太旧没重启）',
          status: res.status,
          latencyMs: elapsed(),
        };
      }
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        return { ok: false, kind: 'bad_response', message: '返回的不是合法 JSON', status: res.status, latencyMs: elapsed() };
      }
      if (!res.ok) {
        const j = (json ?? {}) as Record<string, unknown>;
        const et = j.error_type;
        // 推理 Hub 的任务到点没算完：转发口回 {error_type:'timeout'}（已取消那个任务）
        const kind: JevErrorKind =
          et === 'no_key' ? 'no_key' : et === 'no_config' ? 'no_config' : et === 'unreachable' ? 'unreachable'
            : et === 'timeout' ? 'timeout' : 'http';
        // 转发口自己的错：{error_type, message}；Laya 的错：{error: {message, type}}；Jev 的错：{message}
        const upstreamErr = (j.error ?? null) as { message?: unknown; type?: unknown } | null;
        const msg = typeof j.message === 'string'
          ? j.message
          : upstreamErr && typeof upstreamErr.message === 'string'
            ? `${upstreamErr.message}${typeof upstreamErr.type === 'string' ? `（${upstreamErr.type}）` : ''}`
            : JSON.stringify(json).slice(0, 300);
        return { ok: false, kind, message: msg, status: res.status, latencyMs: elapsed() };
      }
      return { ok: true, body: json, latencyMs: elapsed() };
    })();
    try {
      return await Promise.race([call, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      (unlisten as (() => void) | null)?.();
    }
  }

  async status(): Promise<JevStatus> {
    try {
      const res = await this.fetchFn(`${this.base}/status${this.query()}`, { cache: 'no-store' });
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('application/json')) return { reachable: false, configured: false };
      const j = (await res.json()) as Record<string, unknown>;
      const up = j.upstream && typeof j.upstream === 'object' ? (j.upstream as Record<string, unknown>) : null;
      const asBackend = (v: unknown): JevBackend | undefined => (v === 'laya' || v === 'jev' ? v : undefined);
      let backends: JevStatus['backends'];
      if (j.backends && typeof j.backends === 'object') {
        backends = {};
        for (const [k, v] of Object.entries(j.backends as Record<string, unknown>)) {
          const b = asBackend(k);
          if (!b || !v || typeof v !== 'object') continue;
          const o = v as Record<string, unknown>;
          backends[b] = {
            configured: o.configured === true,
            missing: typeof o.missing === 'string' ? o.missing : null,
            provider: typeof o.provider === 'string' ? o.provider : b,
            model: typeof o.model === 'string' ? o.model : null,
          };
        }
      }
      return {
        backend: asBackend(j.backend),
        route: j.route === 'hub' || j.route === 'direct' ? j.route : undefined,
        defaultBackend: asBackend(j.defaultBackend),
        backends,
        reachable: true,
        configured: j.configured === true,
        missing: typeof j.missing === 'string' ? j.missing : null,
        provider: typeof j.provider === 'string' ? j.provider : undefined,
        model: typeof j.model === 'string' ? j.model : null,
        endpoint: typeof j.endpoint === 'string' ? j.endpoint : null,
        proxy: typeof j.proxy === 'string' ? j.proxy : null,
        upstream: up
          ? {
            ok: up.ok === true,
            version: typeof up.version === 'string' ? up.version : undefined,
            loaded: Array.isArray(up.loaded) ? up.loaded.map(String) : undefined,
            message: typeof up.message === 'string' ? up.message : undefined,
            auth: up.auth === 'ok' || up.auth === 'rejected' || up.auth === 'unknown' ? up.auth : undefined,
          }
          : null,
      };
    } catch {
      return { reachable: false, configured: false };
    }
  }
}
