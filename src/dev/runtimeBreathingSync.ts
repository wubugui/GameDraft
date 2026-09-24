/**
 * 呼吸图的**实时联动**(游戏侧)。DEV 专用。
 *
 * 呼吸工作台(`tools/breathing_workbench`)是呼吸图资产 `assets/data/breathing/` **唯一的作者面与写入者**;
 * 游戏在这条通道上只是**预览器**:
 * - 工作台推来的呼吸图工作态(存没存都算)当场顶替盘上那份:之后新显示的呼吸图用它;
 *   **正在显示**的同一张图立刻换上新参数(拖滑条游戏里跟着变)。
 * - 探针:在游戏里显示 / 收起一张预览呼吸图,或让正在显示的那张「从头来 / 呼吸 / 渐弱 / 猛吸 / 立刻停」。
 * 反向,游戏回传当前显示着的每张呼吸图在演什么、胸口与纸的当前值。
 *
 * 形状与三条防死机制照抄燃烧联动(`runtimeBurnSync.ts`):每发挂超时 + 看门狗、连不上指数退避到 3 s、
 * `statusLine()` 带收发计数。探针靠序号:第一次看到槽里的文档只记序号不做;工作台换了进程(writer 变了)序号从头数。
 */

export const RUNTIME_BREATHING_API = '/__gamedraft-api/runtime-breathing';
export const RUNTIME_BREATHING_STATUS_API = '/__gamedraft-api/runtime-breathing-status';

const POLL_MS = 250;
const POLL_MS_MAX = 3000;
const REQUEST_TIMEOUT_MS = 2000;
const INFLIGHT_WATCHDOG_MS = 15000;
const STATUS_HEARTBEAT_MS = 2000;
const STALE_MS = 5 * 60 * 1000;

export const BREATHING_PROBE_ACTIONS = ['show', 'hide', 'restart', 'breathe', 'fadeOut', 'gasp', 'stopNow'] as const;
export type BreathingProbeAction = (typeof BREATHING_PROBE_ACTIONS)[number];

/** 工作台 → 游戏 */
export interface BreathingSyncDoc {
  rev: number;
  writer: string;
  /** 工作态呼吸图(id → 资产文档);缺席 = 不覆盖 */
  breathing?: Record<string, unknown>;
  /** 探针:序号递增一次做一次。`target` = 呼吸图资产 id(显示着这张图的每个实例都做) */
  probe?: { seq: number; action: BreathingProbeAction; target: string };
}

export interface BreathingInstanceStatus {
  handle: string;
  asset: string;
  mode: string;
  phase: string;
  chest: number;
  paperMm: number;
  t: number;
}

/** 游戏 → 工作台 */
export interface BreathingStatusDoc {
  writer: string;
  ts: number;
  bootId?: string;
  sceneId: string | null;
  appliedRev: number;
  probeSeqDone: number;
  instances: BreathingInstanceStatus[];
  href?: string;
  startedAt?: number;
}

export function isBreathingDocStale(ageMs: number | null | undefined): boolean {
  return typeof ageMs === 'number' && ageMs > STALE_MS;
}

export function shouldApplyBreathingDoc(doc: BreathingSyncDoc | null | undefined, me: string, lastSeenRev: number): boolean {
  if (!doc || typeof doc.rev !== 'number') return false;
  if (doc.writer === me) return false;
  if (doc.rev <= lastSeenRev) return false;
  return !!doc.breathing;
}

export interface RuntimeBreathingSyncDeps {
  /** 套工作态(null = 撤掉覆盖、回到盘上那份) */
  applyPreview: (breathing: Record<string, unknown> | null) => void;
  /** 做一次探针;返回 false = 没有显示着这张图的实例(show 除外) */
  probe: (action: BreathingProbeAction, target: string) => boolean;
  getStatus: () => { bootId?: string; sceneId: string | null; instances: BreathingInstanceStatus[] };
  log: (msg: string) => void;
}

export class RuntimeBreathingSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private inFlightSince = 0;
  private lastSeenRev = 0;
  private appliedRev = 0;
  private previewApplied = false;
  private lastProbeSeq = -1;
  private probeWriter = '';
  private lastProbeDoneSeq = 0;
  private lastStatusJson = '';
  private lastStatusAt = 0;
  private lastOkAt = 0;
  private failStreak = 0;
  private lastError = '';
  private errorLogged = false;
  private appliedCount = 0;
  private publishedCount = 0;
  private probesDone = 0;
  private lastWriter = '';
  private lastDocAgeMs: number | null = null;
  private suppressed = '';
  private readonly startedAt = Date.now();

  constructor(private readonly deps: RuntimeBreathingSyncDeps, private readonly writerId: string) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.inFlight = false;
    if (this.previewApplied) {
      try { this.deps.applyPreview(null); } catch { /* 拆的时候游戏可能已经在拆了 */ }
      this.previewApplied = false;
    }
  }

  statusLine(): string {
    const io = `收${this.appliedCount} 发${this.publishedCount} 探针${this.probesDone}`;
    const connected = this.failStreak === 0 && this.lastOkAt > 0;
    if (!connected) {
      if (this.lastOkAt === 0) return `↔ 呼吸联动等待 dev server…${this.lastError ? `(${this.lastError})` : ''}　${io}`;
      return `⚠ 呼吸联动已断(自动重连中)${this.lastError ? `:${this.lastError}` : ''}　${io}`;
    }
    const peer = this.lastWriter
      ? `　工作台${this.lastDocAgeMs === null ? '' : `(${(this.lastDocAgeMs / 1000).toFixed(0)}s前)`}`
      : '　工作台还没发过东西';
    const applied = this.appliedRev > 0 ? `　预览工作态#${this.appliedRev}` : '　用的是磁盘上那份';
    return `↔ 呼吸联动　${io}${peer}${applied}${this.suppressed ? `　⏸ ${this.suppressed}` : ''}`;
  }

  private currentPollMs(): number {
    if (this.failStreak === 0) return POLL_MS;
    return Math.min(POLL_MS_MAX, POLL_MS * 2 ** Math.min(this.failStreak, 4));
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.tick(); }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    if (this.inFlight) {
      if (now() - this.inFlightSince > INFLIGHT_WATCHDOG_MS) {
        this.inFlight = false;
        this.deps.log('呼吸联动:上一发卡太久,已强制放行(看门狗)');
      } else {
        this.schedule(this.currentPollMs());
        return;
      }
    }
    this.inFlight = true;
    this.inFlightSince = now();
    try {
      await this.pullOnce();
      await this.pushStatus();
      this.lastOkAt = now();
      this.failStreak = 0;
      this.lastError = '';
      this.errorLogged = false;
    } catch (e) {
      this.failStreak += 1;
      this.lastError = e instanceof Error ? e.message : String(e);
      if (!this.errorLogged) {
        this.errorLogged = true;
        this.deps.log(`呼吸联动暂时连不上(会自动重连):${this.lastError}`);
      }
    } finally {
      this.inFlight = false;
      this.schedule(this.currentPollMs());
    }
  }

  private async request(url: string, init?: RequestInit): Promise<unknown> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  /** 读槽并按规则套用(导出给测试直接喂文档) */
  handleDoc(doc: BreathingSyncDoc | null, ageMs: number | null): void {
    this.lastDocAgeMs = ageMs;
    this.lastWriter = doc?.writer ?? '';
    if (!doc) { this.suppressed = '槽是空的'; return; }
    const firstSight = this.lastProbeSeq < 0;
    if (isBreathingDocStale(ageMs)) {
      this.lastSeenRev = Math.max(this.lastSeenRev, doc.rev);
      if (firstSight) { this.lastProbeSeq = doc.probe?.seq ?? 0; this.probeWriter = doc.writer; }
      this.suppressed = '工作台那份太旧(>5 分钟),不套用';
      return;
    }
    if (firstSight) {
      this.lastProbeSeq = doc.probe?.seq ?? 0;
      this.probeWriter = doc.writer;
    } else if (doc.writer !== this.probeWriter) {
      this.probeWriter = doc.writer;
      this.lastProbeSeq = 0;
    }
    this.suppressed = '';
    if (shouldApplyBreathingDoc(doc, this.writerId, this.lastSeenRev)) {
      this.lastSeenRev = doc.rev;
      try {
        this.deps.applyPreview(doc.breathing ?? null);
        this.previewApplied = true;
        this.appliedRev = doc.rev;
        this.appliedCount += 1;
      } catch (e) {
        console.error('[breathingSync] 套用工作台推来的工作态失败', e);
        this.suppressed = '工作态套用失败(见 console)';
        return;
      }
    }
    const seq = doc.probe?.seq ?? 0;
    if (!firstSight && doc.probe && seq > this.lastProbeSeq) {
      this.lastProbeSeq = seq;
      const pr = doc.probe;
      const ok = this.deps.probe(pr.action, pr.target);
      if (ok) {
        this.probesDone += 1;
        this.lastProbeDoneSeq = Math.max(this.lastProbeDoneSeq, seq);
        this.lastStatusJson = '';
      } else {
        this.deps.log(`[呼吸图] 工作台要对「${pr.target}」做 ${pr.action},游戏里没有显示着这张图`);
      }
    }
  }

  private async pullOnce(): Promise<void> {
    const body = await this.request(RUNTIME_BREATHING_API) as { doc?: BreathingSyncDoc | null; ageMs?: number | null };
    this.handleDoc(body?.doc ?? null, typeof body?.ageMs === 'number' ? body.ageMs : null);
  }

  private async pushStatus(): Promise<void> {
    const st: BreathingStatusDoc = {
      ...this.deps.getStatus(),
      writer: this.writerId,
      ts: 0,
      appliedRev: this.appliedRev,
      probeSeqDone: this.lastProbeDoneSeq,
      href: typeof location !== 'undefined' ? `${location.pathname}${location.search}` : undefined,
      startedAt: this.startedAt,
    };
    const json = JSON.stringify(st);
    const t = now();
    if (json === this.lastStatusJson && t - this.lastStatusAt < STATUS_HEARTBEAT_MS) return;
    st.ts = Date.now();
    await this.request(RUNTIME_BREATHING_STATUS_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st),
    });
    this.lastStatusJson = json;
    this.lastStatusAt = t;
    this.publishedCount += 1;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
