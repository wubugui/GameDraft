/**
 * 世界脑 → dev server 的「一拍一包」请求通道（设计稿 §13）。
 *
 * 旧通道一题一个 HTTP 请求，转发口把"提交 + 长轮询"整个包在里面，一次占一条连接直到答案回来；
 * 浏览器对同一个 dev server 只开 6 条，天黑那一下 40 多发同时出去要排好几轮，Hub 被占时 6 条全部挂满、
 * 回话根本发不出去。这里改成：
 *
 * - **一拍一包**：同一帧（同一轮同步代码）里要问的题攒成一个包，POST 一次、**立即返回**；
 * - **推送通道**：结果从一条常开的 SSE 一题一条推回，每道题不再各占一条连接；
 * - **撤单**：到了保质期没回 / 调用方不要了（`signal`）→ 从同一条路发撤单，转发口立刻撤 Hub 那边的单；
 *   推送通道断了（关页面、热更新）转发口把这个页面的单全撤；
 * - **在途上限按包计**；
 * - **熔断**（{@link DecisionBreaker}）：近档的 P95 超过保质期，或 Hub 说 GPU 正被图像 / 视频占着 → 打开：
 *   除回话以外的题一律当场回 `breaker`（调用方走状态图写好的缺省），回话照发兼作探针，另外定时发探针；
 *   探针在保质期内回来 → 关上。
 *
 * 所有数（保质期、探针间隔、在途包数）由调用方从世界脑数据的 `tuning` 给（设计值，两个模型共用）。
 */
import {
  HttpJevTransport, JEV_API_BASE,
  type JevBackend, type JevCallResult, type JevDecideOptions, type JevErrorKind, type JevStatus, type JevTransport,
} from './jevTransport';
import type { JevQuestion } from './jevProtocol';

/** 一单属于哪一档（优先级与熔断都看它）：回话 / 近 / 中 / 远 / 反思 / 探针 */
export type PackTier = 'reply' | 'near' | 'mid' | 'far' | 'reflect' | 'probe';

/** 熔断的设计值（世界脑数据 `tuning` 给） */
export interface BreakerTuning {
  /** 近档延迟看最近多少单 */
  window: number;
  /** 至少攒够几单才按 P95 判 */
  minSamples: number;
  /** 熔断开着时多久发一次探针 */
  probeIntervalMs: number;
}

/**
 * 熔断（纯状态机，时钟由调用方给）。
 *
 * - 近档每一单回来记一个"用掉保质期的几成"（没回来的记 2）；最近 `window` 单的 P95 超过 1 = 近档普遍过期 → 开；
 * - Hub 遥测说 GPU 正被别的模型占着 → 开；
 * - 开着时：到了探针间隔就该发一发探针；探针（或兼作探针的回话）在保质期内回来、且 Hub 不再说 GPU 被占 → 关，
 *   清空延迟样本（旧的慢样本不该让它一关上又打开）。
 */
export class DecisionBreaker {
  private ratios: number[] = [];
  private openSinceMs: number | null = null;
  private reasonText = '';
  private hubBusy = false;
  private lastProbeMs = -Infinity;

  constructor(private tuning: BreakerTuning) {}

  setTuning(t: BreakerTuning): void {
    this.tuning = t;
  }

  /** 换了一路上游：之前的延迟、GPU 占用跟新的那一路无关，全清 */
  reset(): void {
    this.ratios = [];
    this.openSinceMs = null;
    this.reasonText = '';
    this.hubBusy = false;
    this.lastProbeMs = -Infinity;
  }

  get isOpen(): boolean {
    return this.openSinceMs !== null;
  }

  get reason(): string {
    return this.reasonText;
  }

  openForMs(nowMs: number): number {
    return this.openSinceMs === null ? 0 : Math.max(0, nowMs - this.openSinceMs);
  }

  /** 近档一单的结局：`ms` 用了多久（没回来 / 超时传 null） */
  noteNear(ms: number | null, expireMs: number, nowMs: number): void {
    const ratio = ms === null ? 2 : ms / Math.max(1, expireMs);
    this.ratios.push(ratio);
    while (this.ratios.length > this.tuning.window) this.ratios.shift();
    if (!this.isOpen && this.ratios.length >= this.tuning.minSamples && percentile(this.ratios, 0.95) > 1) {
      this.open(nowMs, '近档 P95 超过保质期');
    }
  }

  /** Hub 遥测：GPU 是不是正被别的模型（图像 / 视频）占着 */
  noteHub(busyOther: boolean, nowMs: number): void {
    this.hubBusy = busyOther;
    if (busyOther && !this.isOpen) this.open(nowMs, 'Hub 的 GPU 正被图像 / 视频占着');
  }

  /** 探针（或兼作探针的回话）回来了：在保质期内且 GPU 不被别人占着 → 关 */
  noteProbe(inTime: boolean): void {
    if (!this.isOpen || !inTime || this.hubBusy) return;
    this.openSinceMs = null;
    this.reasonText = '';
    this.ratios = [];
  }

  /** 开着时，这一刻该不该发探针（该发就记下发了） */
  takeProbe(nowMs: number): boolean {
    if (!this.isOpen || nowMs - this.lastProbeMs < this.tuning.probeIntervalMs) return false;
    this.lastProbeMs = nowMs;
    return true;
  }

  private open(nowMs: number, why: string): void {
    this.openSinceMs = nowMs;
    this.reasonText = why;
    this.lastProbeMs = -Infinity;
  }
}

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[i]!;
}

/** 状态牌上要的：熔断开了多久、为什么、暂代了几单、撤了几单、P50 / P95、在途几个包 */
export interface PackStats {
  breakerOpen: boolean;
  breakerReason: string;
  breakerOpenMs: number;
  /** 熔断期间当场回了 breaker 的单数（调用方走缺省） */
  substituted: number;
  /** 撤单数（到期 + 不要了 + 换后端） */
  cancelled: number;
  p50Ms: number | null;
  p95Ms: number | null;
  packsInFlight: number;
  /** 推送通道连着没有 */
  streamOpen: boolean;
  /** Hub 最近一次遥测：GPU 此刻被谁占着（null = 空着 / 没拿到） */
  hubActiveGroup: string | null;
}

/** 推送通道（浏览器里是 EventSource；测试注入假的） */
export interface StreamLike {
  addEventListener(type: string, fn: (ev: { data: string }) => void): void;
  close(): void;
  onerror: ((ev: unknown) => void) | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PackTransportOptions {
  fetch?: FetchLike;
  openStream?: (url: string) => StreamLike;
  /** 毫秒时钟（缺省 performance.now） */
  now?: () => number;
  base?: string;
  /** 页面号（缺省现造一个；同一页面重连推送通道要用同一个） */
  pageId?: string;
  maxPacksInFlight?: number;
  breaker?: BreakerTuning;
  /** 探针的保质期（= 近档保质期） */
  probeExpireMs?: number;
  /** 推送通道多久没说 hello 就当开不了 */
  streamOpenTimeoutMs?: number;
}

interface Entry {
  id: string;
  body: { state: unknown; questions: Record<string, JevQuestion> };
  expireMs: number;
  priority: number;
  tier: PackTier;
  name: string | undefined;
  t0: number;
  sent: boolean;
  settled: boolean;
  resolve: (r: JevCallResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
  unlisten: (() => void) | null;
  pack: string | null;
}

/** 档 → 上游排队优先级（Hub 认，0~100 大的先）；调用方显式给的 priority 优先 */
export const TIER_PRIORITY: Record<PackTier, number> = { reply: 90, near: 70, probe: 70, mid: 60, far: 50, reflect: 30 };

const PROBE_BODY: { state: unknown; questions: Record<string, JevQuestion> } = {
  state: { 街上: '老街上很安静，没得啥子事。' },
  questions: { p: { type: 'noul', instructions: '街上的人会害怕。' } as unknown as JevQuestion },
};

let pageSeq = 0;
function makePageId(): string {
  pageSeq++;
  const t = Date.now().toString(36);
  return `wb-${t}-${pageSeq}`;
}

export class PackedJevTransport implements JevTransport {
  private readonly fetchFn: FetchLike;
  private readonly openStreamFn: (url: string) => StreamLike;
  private readonly now: () => number;
  private readonly base: string;
  readonly pageId: string;
  private maxPacks: number;
  private probeExpireMs: number;
  private readonly streamOpenTimeoutMs: number;
  private readonly http: HttpJevTransport;
  readonly breaker: DecisionBreaker;

  private backend: JevBackend | null = null;
  /** 这一路实际怎么走：经推理 Hub / 直连（转发口在状态和交包回执里说）；只有经 Hub 的才看 Hub 的 GPU 占用 */
  private route: 'hub' | 'direct' | null = null;
  private seq = 0;
  private packSeq = 0;
  private readonly entries = new Map<string, Entry>();
  private buffer: Entry[] = [];
  private flushQueued = false;
  private cancelBuf: string[] = [];
  private cancelQueued = false;
  private readonly packs = new Map<string, Set<string>>();

  private stream: StreamLike | null = null;
  private streamReady: Promise<boolean> | null = null;
  private streamOpen = false;
  private hubActiveGroup: string | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private latencies: number[] = [];
  private substituted = 0;
  private cancelled = 0;

  constructor(o: PackTransportOptions = {}) {
    this.fetchFn = o.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : () => Promise.reject(new Error('fetch unavailable')));
    this.openStreamFn = o.openStream ?? ((url) => {
      if (typeof EventSource === 'undefined') throw new Error('EventSource unavailable');
      return new EventSource(url) as unknown as StreamLike;
    });
    this.now = o.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.base = o.base ?? JEV_API_BASE;
    this.pageId = o.pageId ?? makePageId();
    this.maxPacks = Math.max(1, o.maxPacksInFlight ?? 4);
    this.probeExpireMs = o.probeExpireMs ?? 1500;
    this.streamOpenTimeoutMs = o.streamOpenTimeoutMs ?? 3000;
    this.breaker = new DecisionBreaker(o.breaker ?? { window: 20, minSamples: 6, probeIntervalMs: 5000 });
    this.http = new HttpJevTransport(this.fetchFn, this.base);
  }

  configure(t: { maxPacksInFlight: number; breaker: BreakerTuning; probeExpireMs: number }): void {
    this.maxPacks = Math.max(1, Math.round(t.maxPacksInFlight));
    this.probeExpireMs = Math.max(200, t.probeExpireMs);
    this.breaker.setTuning(t.breaker);
  }

  setBackend(b: JevBackend | null): void {
    if (b === this.backend) return;
    this.backend = b;
    this.http.setBackend(b);
    // 换了一路：在途的都是问上一路的，全撤；熔断跟着上一路走的，清零（这一路怎么走等转发口再说）
    this.cancelAllPending('换了决策服务');
    this.route = null;
    this.breaker.reset();
    this.stopProbing();
  }

  async status(): Promise<JevStatus> {
    const st = await this.http.status();
    if (st.route) this.noteRoute(st.route);
    return st;
  }

  private noteRoute(route: 'hub' | 'direct'): void {
    if (route === this.route) return;
    this.route = route;
    // 直连的一路不看 Hub 的 GPU 占用：因它开的熔断作废
    if (route === 'direct') {
      this.breaker.reset();
      this.stopProbing();
    }
  }

  stats(): PackStats {
    return {
      breakerOpen: this.breaker.isOpen,
      breakerReason: this.breaker.reason,
      breakerOpenMs: this.breaker.openForMs(this.now()),
      substituted: this.substituted,
      cancelled: this.cancelled,
      p50Ms: this.latencies.length ? Math.round(percentile(this.latencies, 0.5)) : null,
      p95Ms: this.latencies.length ? Math.round(percentile(this.latencies, 0.95)) : null,
      packsInFlight: this.packs.size,
      streamOpen: this.streamOpen,
      hubActiveGroup: this.hubActiveGroup,
    };
  }

  decide(
    body: { state: unknown; questions: Record<string, JevQuestion> },
    timeoutMs: number,
    opts?: JevDecideOptions,
  ): Promise<JevCallResult> {
    const tier: PackTier = opts?.tier ?? 'near';
    const t0 = this.now();
    if (this.closed) this.closed = false;
    // 熔断开着：除回话 / 探针以外当场回，调用方走缺省（不发、不占 Hub）
    if (this.breaker.isOpen && tier !== 'reply' && tier !== 'probe') {
      this.substituted++;
      this.ensureProbing();
      return Promise.resolve({ ok: false, kind: 'breaker', message: `熔断中：${this.breaker.reason}`, latencyMs: 0 });
    }
    if (opts?.signal?.aborted) {
      return Promise.resolve({ ok: false, kind: 'cancelled', message: '还没发就不要了', latencyMs: 0 });
    }
    return new Promise<JevCallResult>((resolve) => {
      const id = `q${++this.seq}`;
      const expireMs = Math.max(200, timeoutMs);
      const entry: Entry = {
        id, body, expireMs, tier, t0,
        priority: typeof opts?.priority === 'number' && Number.isFinite(opts.priority) ? opts.priority : TIER_PRIORITY[tier],
        name: opts?.name,
        sent: false, settled: false, resolve, timer: null, unlisten: null, pack: null,
      };
      this.entries.set(id, entry);
      // 到了保质期：当场回 timeout，已经发出去的撤单
      entry.timer = setTimeout(() => {
        this.settle(entry, { ok: false, kind: 'timeout', message: `超过 ${expireMs} ms 没回（已撤单）`, latencyMs: Math.round(this.now() - t0) }, true);
      }, expireMs);
      const signal = opts?.signal;
      if (signal) {
        const onAbort = () => this.settle(entry, { ok: false, kind: 'cancelled', message: '不要了（已撤单）', latencyMs: Math.round(this.now() - t0) }, true);
        signal.addEventListener('abort', onAbort, { once: true });
        entry.unlisten = () => signal.removeEventListener('abort', onAbort);
      }
      this.buffer.push(entry);
      this.queueFlush();
    });
  }

  /** 关掉通道（世界脑关了 / 拆了）：在途的全撤，推送通道关掉 */
  close(): void {
    this.cancelAllPending('世界脑关了');
    this.stopProbing();
    this.closeStream();
    this.closed = true;
  }

  // ───────────────────────── 结局 ─────────────────────────

  private settle(entry: Entry, r: JevCallResult, cancelUpstream: boolean): void {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.unlisten?.();
    this.entries.delete(entry.id);
    const bi = this.buffer.indexOf(entry);
    if (bi >= 0) this.buffer.splice(bi, 1);
    if (cancelUpstream && entry.sent) {
      this.cancelled++;
      this.queueCancel(entry.id);
    }
    if (entry.tier === 'near') {
      this.breaker.noteNear(r.ok ? r.latencyMs : null, entry.expireMs, this.now());
    }
    if (entry.tier === 'probe' || entry.tier === 'reply') {
      this.breaker.noteProbe(r.ok && r.latencyMs <= entry.expireMs);
    }
    if (r.ok) {
      this.latencies.push(r.latencyMs);
      while (this.latencies.length > 200) this.latencies.shift();
    }
    if (this.breaker.isOpen) this.ensureProbing();
    else this.stopProbing();
    this.releaseFromPack(entry);
    entry.resolve(r);
  }

  private releaseFromPack(entry: Entry): void {
    if (!entry.pack) return;
    const ids = this.packs.get(entry.pack);
    if (!ids) return;
    ids.delete(entry.id);
    if (ids.size === 0) {
      this.packs.delete(entry.pack);
      // 腾出一个包位：排着的接着发
      if (this.buffer.length) this.queueFlush();
    }
  }

  private cancelAllPending(why: string): void {
    for (const e of [...this.entries.values()]) {
      this.settle(e, { ok: false, kind: 'cancelled', message: `${why}（已撤单）`, latencyMs: Math.round(this.now() - e.t0) }, true);
    }
    this.flushCancels();
  }

  // ───────────────────────── 交包 ─────────────────────────

  private queueFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (!this.buffer.length) return;
    // 在途包满了：回话不等（玩家亲手按的），其余等腾出包位
    const hasReply = this.buffer.some((e) => e.tier === 'reply' || e.tier === 'probe');
    if (this.packs.size >= this.maxPacks && !hasReply) return;
    const batch = this.buffer.splice(0, this.buffer.length).filter((e) => !e.settled);
    if (!batch.length) return;
    const packId = `p${++this.packSeq}`;
    const ids = new Set(batch.map((e) => e.id));
    this.packs.set(packId, ids);
    for (const e of batch) {
      e.sent = true;
      e.pack = packId;
    }
    const failAll = (kind: JevErrorKind, message: string, status?: number): void => {
      for (const e of batch) {
        this.settle(e, { ok: false, kind, message, ...(status !== undefined ? { status } : {}), latencyMs: Math.round(this.now() - e.t0) }, false);
      }
    };
    if (!(await this.ensureStream())) {
      failAll('network', '推送通道开不了（开发服务器没这条路，或太旧没重启）');
      return;
    }
    const post = async (): Promise<Response | null> => {
      try {
        return await this.fetchFn(`${this.base}/pack${this.query()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            page: this.pageId,
            pack: packId,
            items: batch.filter((e) => !e.settled).map((e) => ({
              id: e.id, state: e.body.state, questions: e.body.questions,
              priority: e.priority, scheduling: e.tier === 'reflect' ? 'idle' : 'normal',
              expireMs: Math.max(1, Math.round(e.expireMs - (this.now() - e.t0))),
              ...(e.name ? { name: e.name } : {}),
            })),
          }),
        });
      } catch (err) {
        failAll('network', String((err as Error)?.message ?? err));
        return null;
      }
    };
    let res = await post();
    if (!res) return;
    if (res.status === 409) {
      // 转发口不认这个页面的推送通道（开发服重启过）：重开一次再交
      this.closeStream();
      if (!(await this.ensureStream())) {
        failAll('network', '推送通道重开不了');
        return;
      }
      res = await post();
      if (!res) return;
    }
    if (res.status === 202) {
      const ack = (await res.json().catch(() => null)) as { route?: unknown } | null;
      if (ack?.route === 'hub' || ack?.route === 'direct') this.noteRoute(ack.route);
      return;
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) {
      failAll('no_server', '开发服务器上没有 Jev 转发（不是开发模式，或开发服务器太旧没重启）', res.status);
      return;
    }
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const et = j.error_type;
    const kind: JevErrorKind = et === 'no_key' ? 'no_key' : et === 'no_config' ? 'no_config' : 'http';
    failAll(kind, typeof j.message === 'string' ? j.message : `交包回 ${res.status}`, res.status);
  }

  private query(): string {
    return this.backend ? `?backend=${this.backend}` : '';
  }

  // ───────────────────────── 撤单 ─────────────────────────

  private queueCancel(id: string): void {
    this.cancelBuf.push(id);
    if (this.cancelQueued) return;
    this.cancelQueued = true;
    queueMicrotask(() => {
      this.cancelQueued = false;
      this.flushCancels();
    });
  }

  private flushCancels(): void {
    if (!this.cancelBuf.length) return;
    const ids = this.cancelBuf.splice(0, this.cancelBuf.length);
    void this.fetchFn(`${this.base}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ page: this.pageId, ids }),
    }).catch(() => undefined);
  }

  // ───────────────────────── 推送通道 ─────────────────────────

  private ensureStream(): Promise<boolean> {
    if (this.stream && this.streamReady) return this.streamReady;
    let s: StreamLike;
    try {
      s = this.openStreamFn(`${this.base}/stream?page=${encodeURIComponent(this.pageId)}`);
    } catch {
      return Promise.resolve(false);
    }
    this.stream = s;
    this.streamReady = new Promise<boolean>((resolve) => {
      let said = false;
      const timer = setTimeout(() => {
        if (said) return;
        said = true;
        if (this.stream === s) this.closeStream();
        resolve(false);
      }, this.streamOpenTimeoutMs);
      s.addEventListener('hello', () => {
        if (said) return;
        said = true;
        clearTimeout(timer);
        this.streamOpen = true;
        resolve(true);
      });
      s.onerror = () => {
        if (this.stream !== s) return;
        if (!said) {
          said = true;
          clearTimeout(timer);
          resolve(false);
        }
        // 断了：转发口已经把这个页面的单全撤了——发出去的一律当网络错，下次交包再重开
        this.closeStream();
        for (const e of [...this.entries.values()]) {
          if (!e.sent) continue;
          this.settle(e, { ok: false, kind: 'network', message: '推送通道断了（转发口已撤单）', latencyMs: Math.round(this.now() - e.t0) }, false);
        }
      };
    });
    s.addEventListener('result', (ev) => this.onResult(ev.data));
    s.addEventListener('hub', (ev) => this.onHub(ev.data));
    return this.streamReady;
  }

  private closeStream(): void {
    const s = this.stream;
    this.stream = null;
    this.streamReady = null;
    this.streamOpen = false;
    if (s) {
      s.onerror = null;
      try { s.close(); } catch { /* 已关 */ }
    }
  }

  private onResult(data: string): void {
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const entry = typeof r.id === 'string' ? this.entries.get(r.id) : undefined;
    if (!entry) return;   // 已经到期 / 撤掉：晚到的丢掉
    const latencyMs = Math.round(this.now() - entry.t0);
    if (r.ok === true) {
      this.settle(entry, { ok: true, body: r.body, latencyMs }, false);
      return;
    }
    const et = r.error_type;
    const kind: JevErrorKind = et === 'no_key' ? 'no_key' : et === 'no_config' ? 'no_config' : et === 'unreachable' ? 'unreachable'
      : et === 'timeout' ? 'timeout' : 'http';
    this.settle(entry, { ok: false, kind, message: typeof r.message === 'string' ? r.message : '上游出错', latencyMs }, false);
  }

  private onHub(data: string): void {
    let h: Record<string, unknown>;
    try {
      h = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    this.hubActiveGroup = typeof h.activeGroup === 'string' ? h.activeGroup : null;
    // 只有经 Hub 的那一路才看它（问 Jev / 直连 Laya 时 GPU 被谁占着跟我们无关；还不知道怎么走也先不看）
    if (this.route !== 'hub') return;
    this.breaker.noteHub(h.gpuBusyOther === true, this.now());
    if (this.breaker.isOpen) this.ensureProbing();
  }

  // ───────────────────────── 探针 ─────────────────────────

  private ensureProbing(): void {
    if (this.probeTimer !== null || this.closed) return;
    this.probeTimer = setInterval(() => {
      if (!this.breaker.isOpen) {
        this.stopProbing();
        return;
      }
      if (this.breaker.takeProbe(this.now())) {
        void this.decide(PROBE_BODY, this.probeExpireMs, { tier: 'probe', name: 'world-brain probe' });
      }
    }, 500);
    if (this.breaker.takeProbe(this.now())) {
      void this.decide(PROBE_BODY, this.probeExpireMs, { tier: 'probe', name: 'world-brain probe' });
    }
  }

  private stopProbing(): void {
    if (this.probeTimer === null) return;
    clearInterval(this.probeTimer);
    this.probeTimer = null;
  }
}
