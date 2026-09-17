/**
 * 燃烧系统的**实时联动**（游戏侧）。DEV 专用。
 *
 * 燃烧工作台（`tools/burn_workbench`）是可燃物**模板** `assets/data/burnables/` **唯一的作者面与写入者**（哪个宿主用哪份模板
 * 写在宿主自己身上，不走这条通道）；游戏在这条通道上只是**预览器**：工作台推来的模板工作态（存没存都算）当场顶替盘上那份、
 * 当前场景与手上用到它的实例按它重建；按「在游戏里点着 / 熄灭 / 复原」游戏就对那个实例（场景实体 / 某人手上的挂件）做一次。
 * 反向，游戏回传「在哪个场景、当前场景与手上的每个实例用哪份模板、什么状态、几条事件、模拟花多久」。
 *
 * 形状与三条防死机制照抄粒子联动（`runtimeVfxSync.ts`，理由见那边的头注释）：每发挂超时 + 看门狗、连不上指数退避到 3 s、
 * `statusLine()` 带收发计数。探针靠序号：第一次看到槽里的文档只记序号不做；工作台换了进程（writer 变了）序号从头数。
 */

export const RUNTIME_BURN_API = '/__gamedraft-api/runtime-burn';
export const RUNTIME_BURN_STATUS_API = '/__gamedraft-api/runtime-burn-status';

const POLL_MS = 400;
const POLL_MS_MAX = 3000;
const REQUEST_TIMEOUT_MS = 2000;
const INFLIGHT_WATCHDOG_MS = 15000;
const STATUS_HEARTBEAT_MS = 2000;
/** 同步槽的新鲜期（"当前会话的对讲机"，不是状态存档）。与粒子 / 光照同值 */
const STALE_MS = 5 * 60 * 1000;

export type BurnProbeAction = 'ignite' | 'extinguish' | 'reset';

/** 工作台 → 游戏 */
export interface BurnSyncDoc {
  rev: number;
  writer: string;
  /** 工作态可燃物模板（id → 文档）；缺席 = 不覆盖 */
  burnables?: Record<string, unknown>;
  /** 探针：序号递增一次做一次。`socket` 缺席 = 当前场景的可燃实体（`target` = 实体 id）；给了 = `target` 这个人这个挂点上的挂件 */
  probe?: { seq: number; action: BurnProbeAction; target: string; socket?: string; point?: string };
  /**
   * 站位能不能站：请游戏用**它自己的** `isCollision` 判这些画面点（≤ 256 个；与地形工作台的运行时对齐同一个思路）。
   * 序号规则同 `probe`；只在游戏正好在 `sceneId` 时判，结果回 `walkProbeResult`。
   */
  walkProbe?: { seq: number; sceneId: string; points: [number, number][] };
}

/** 游戏 → 工作台 */
export interface BurnStatusDoc {
  writer: string;
  ts: number;
  bootId?: string;
  sceneId: string | null;
  appliedRev: number;
  probeSeqDone: number;
  /** 当前场景的可燃实体 + 手上的可燃挂件 */
  items: { kind: 'scene' | 'held'; sceneId?: string; target: string; socket?: string; template: string; state: string; events: number; ready: boolean }[];
  stats: { items: number; held: number; burning: number; lights: number; particles: number; simMs: number; clock: number };
  /** 最近一次站位判定：`bits` 每个点一位（'1' = 站得了） */
  walkProbeResult?: { seq: number; sceneId: string; bits: string };
  href?: string;
  startedAt?: number;
}

export function isBurnDocStale(ageMs: number | null | undefined): boolean {
  return typeof ageMs === 'number' && ageMs > STALE_MS;
}

export function shouldApplyBurnDoc(doc: BurnSyncDoc | null | undefined, me: string, lastSeenRev: number): boolean {
  if (!doc || typeof doc.rev !== 'number') return false;
  if (doc.writer === me) return false;
  if (doc.rev <= lastSeenRev) return false;
  return !!doc.burnables;
}

export interface RuntimeBurnSyncDeps {
  /** 套模板工作态（null = 撤掉覆盖、回到盘上那份） */
  applyPreview: (burnables: Record<string, unknown> | null) => void;
  /** 做一次探针；返回 false = 没有这个实例 */
  probe: (action: BurnProbeAction, target: string, socket: string | undefined, point: string | undefined) => boolean;
  /** 当前场景 id（站位判定只在对的场景里做） */
  getSceneId: () => string | null;
  /** 画面点站不站得了（游戏自己的碰撞判定） */
  walkable: (x: number, y: number) => boolean;
  getStatus: () => Omit<BurnStatusDoc, 'writer' | 'ts' | 'appliedRev' | 'probeSeqDone' | 'href' | 'startedAt' | 'walkProbeResult'>;
  log: (msg: string) => void;
}

export class RuntimeBurnSync {
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
  private lastWalkSeq = -1;
  private walkResult: { seq: number; sceneId: string; bits: string } | undefined;
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

  constructor(private readonly deps: RuntimeBurnSyncDeps, private readonly writerId: string) {}

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
      if (this.lastOkAt === 0) return `↔ 燃烧联动等待 dev server…${this.lastError ? `（${this.lastError}）` : ''}　${io}`;
      return `⚠ 燃烧联动已断（自动重连中）${this.lastError ? `：${this.lastError}` : ''}　${io}`;
    }
    const peer = this.lastWriter
      ? `　工作台${this.lastDocAgeMs === null ? '' : `(${(this.lastDocAgeMs / 1000).toFixed(0)}s前)`}`
      : '　工作台还没发过东西';
    const applied = this.appliedRev > 0 ? `　预览工作态#${this.appliedRev}` : '　用的是磁盘上那份';
    return `↔ 燃烧联动　${io}${peer}${applied}${this.suppressed ? `　⏸ ${this.suppressed}` : ''}`;
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
        this.deps.log('燃烧联动：上一发卡太久，已强制放行（看门狗）');
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
        this.deps.log(`燃烧联动暂时连不上（会自动重连）：${this.lastError}`);
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

  /** 读槽并按规则套用（导出给测试直接喂文档） */
  handleDoc(doc: BurnSyncDoc | null, ageMs: number | null): void {
    this.lastDocAgeMs = ageMs;
    this.lastWriter = doc?.writer ?? '';
    if (!doc) { this.suppressed = '槽是空的'; return; }
    const firstSight = this.lastProbeSeq < 0;
    if (isBurnDocStale(ageMs)) {
      this.lastSeenRev = Math.max(this.lastSeenRev, doc.rev);
      if (firstSight) { this.lastProbeSeq = doc.probe?.seq ?? 0; this.lastWalkSeq = doc.walkProbe?.seq ?? 0; this.probeWriter = doc.writer; }
      this.suppressed = '工作台那份太旧（>5 分钟），不套用';
      return;
    }
    if (firstSight) {
      this.lastProbeSeq = doc.probe?.seq ?? 0;
      // 站位判定是只读的：第一次看到也判（工作台开着页、游戏后起来时能立刻有结果）
      this.lastWalkSeq = 0;
      this.probeWriter = doc.writer;
    } else if (doc.writer !== this.probeWriter) {
      this.probeWriter = doc.writer;
      this.lastProbeSeq = 0;
      this.lastWalkSeq = 0;
    }
    const wp = doc.walkProbe;
    if (wp && wp.seq > this.lastWalkSeq && wp.sceneId === this.deps.getSceneId() && Array.isArray(wp.points)) {
      this.lastWalkSeq = wp.seq;
      let bits = '';
      for (const pt of wp.points.slice(0, 256)) {
        const ok = Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1]) && this.deps.walkable(pt[0], pt[1]);
        bits += ok ? '1' : '0';
      }
      this.walkResult = { seq: wp.seq, sceneId: wp.sceneId, bits };
      this.lastStatusJson = '';
    }
    this.suppressed = '';
    if (shouldApplyBurnDoc(doc, this.writerId, this.lastSeenRev)) {
      this.lastSeenRev = doc.rev;
      try {
        this.deps.applyPreview(doc.burnables ?? null);
        this.previewApplied = true;
        this.appliedRev = doc.rev;
        this.appliedCount += 1;
      } catch (e) {
        console.error('[burnSync] 套用工作台推来的工作态失败', e);
        this.suppressed = '工作态套用失败（见 console）';
        return;
      }
    }
    const seq = doc.probe?.seq ?? 0;
    if (!firstSight && doc.probe && seq > this.lastProbeSeq) {
      this.lastProbeSeq = seq;
      const pr = doc.probe;
      const ok = this.deps.probe(pr.action, pr.target, pr.socket || undefined, pr.point);
      if (ok) {
        this.probesDone += 1;
        this.lastProbeDoneSeq = Math.max(this.lastProbeDoneSeq, seq);
        this.lastStatusJson = '';
      } else {
        const who = pr.socket ? `${pr.target} 手上 ${pr.socket} 的挂件` : `「${pr.target}」`;
        this.deps.log(`[燃烧] 工作台要${pr.action}${who}，没有这个可燃实例`);
      }
    }
  }

  private async pullOnce(): Promise<void> {
    const body = await this.request(RUNTIME_BURN_API) as { doc?: BurnSyncDoc | null; ageMs?: number | null };
    this.handleDoc(body?.doc ?? null, typeof body?.ageMs === 'number' ? body.ageMs : null);
  }

  private async pushStatus(): Promise<void> {
    const st: BurnStatusDoc = {
      ...this.deps.getStatus(),
      writer: this.writerId,
      ts: 0,
      appliedRev: this.appliedRev,
      probeSeqDone: this.lastProbeDoneSeq,
      walkProbeResult: this.walkResult,
      href: typeof location !== 'undefined' ? `${location.pathname}${location.search}` : undefined,
      startedAt: this.startedAt,
    };
    const json = JSON.stringify(st);
    const t = now();
    if (json === this.lastStatusJson && t - this.lastStatusAt < STATUS_HEARTBEAT_MS) return;
    st.ts = Date.now();
    await this.request(RUNTIME_BURN_STATUS_API, {
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
