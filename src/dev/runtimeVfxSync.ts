import type { VfxEffectDef, VfxFieldDef, VfxInstanceState } from '../data/types';

/**
 * 世界空间粒子 / 群体的**实时联动**（游戏侧）。DEV 专用。
 *
 * 粒子工作台（`tools/vfx_workbench`）是效果资产 `assets/data/vfx/` **唯一的作者面与写入者**；
 * 游戏在这条通道上只是**预览器**：工作台里每改一个参数，游戏下一拍就用工作态定义重建引用它的
 * 实例；按一下「发一个刺激」游戏就在那个画面点发一个 `fear/attract/wind` 场。反向，游戏把
 * 「现在在哪个场景、这个效果被哪些实例引用着、各自什么状态、活了多少只、模拟花了多久、玩家站在哪」
 * 回传给工作台画在 3D 里。
 *
 * ## 照抄声学那套（`runtimeAcousticsSync.ts`），理由一条不少
 *
 * 走 dev server 的文件槽而不是工作台直接问游戏：游戏可能跑在外部 Chrome、内嵌页签或弹出窗口，
 * 两边各自中途开关重启，dev server 是唯一两边都始终可达的点。不新增端口：走页面自己的
 * origin + 两条新路径。
 *
 * 三个必须照抄的防死机制：
 * 1. **每发都挂超时**（`fetch` 默认没有，挂死一发就把 `inFlight` 钉死、同步静默死亡，外加看门狗）；
 * 2. **连不上指数退避到 3s**（游戏没在 dev server 下跑时不要每 400ms 敲一次）；
 * 3. **`statusLine()` 带收发计数**——「以为在同步、其实早断了」是最贵的一种坏。
 *
 * ## 两个槽，方向不同
 *
 * | 路径 | 方向 | 内容 |
 * |---|---|---|
 * | `runtime-vfx` | 工作台 → 游戏 | 正在编辑的效果 id、工作态定义、刺激请求（序号 + 场 + 画面点）。`rev` 服务端自增 |
 * | `runtime-vfx-status` | 游戏 → 工作台 | 场景、引用该效果的实例与状态与只数、stats、玩家脚点、bootId、心跳。整份覆盖，按页分桶 |
 *
 * ## 刺激靠序号
 *
 * 工作台把 `probe.seq` 加一，游戏看到比记住的大就发一次。**第一次看到槽里的文档时只记序号不发**：
 * 否则游戏一刷新就把上一次的刺激重放一遍。工作台换了 writer（服务重开）则相反——那份文档是**新**
 * 来的，序号从 0 重数，不重置就会把新工作台的第一下吞掉（声学 2026-09-08 真机抓到）。
 *
 * ## 换场景后重新套用
 *
 * 进场景时 `VfxSystem` 整批散掉重建（`scene:beforeUnload` / `scene:ready`），工作台那份工作态覆盖
 * 还在 `effectCache` 里但实例已重建 —— 所以换场景后把 `lastSeenRev` 归零，下一拍若文档仍新鲜就重新
 * 套一次，作者走到另一个场景看到的仍是工作台里正在调的那份。
 */

export const RUNTIME_VFX_API = '/__gamedraft-api/runtime-vfx';
export const RUNTIME_VFX_STATUS_API = '/__gamedraft-api/runtime-vfx-status';

const POLL_MS = 400;
const POLL_MS_MAX = 3000;
const REQUEST_TIMEOUT_MS = 2000;
const INFLIGHT_WATCHDOG_MS = 15000;
/** 状态回传的心跳：内容没变也至少这么久发一次，工作台据此判「游戏还活着」。 */
const STATUS_HEARTBEAT_MS = 2000;
/** 同步槽的新鲜期。槽是"当前会话的对讲机"，不是状态存档。与光照 / 声学同值。 */
const STALE_MS = 5 * 60 * 1000;

export function isVfxDocStale(ageMs: number | null | undefined): boolean {
  return typeof ageMs === 'number' && ageMs > STALE_MS;
}

/** 工作台 → 游戏 */
export interface VfxSyncDoc {
  rev: number;
  writer: string;
  /** 正在编辑的效果 id */
  effectId: string;
  /** 工作态定义（未落盘） */
  def: VfxEffectDef;
  /** 工作台当前展开的场景（只用于显示 / 诊断，不做门槛） */
  sceneId?: string;
  /** 刺激请求：序号递增一次发一次。`at` = 画面点 + 离地高（wu），游戏侧解成 M-world */
  probe?: { seq: number; field: VfxFieldDef; at: { x: number; y: number; h?: number } };
}

/** 游戏 → 工作台：一个实例的现状 */
export interface VfxInstanceStatus {
  id: string;
  state: VfxInstanceState | string;
  live: number;
  eligible: boolean;
}

/** 游戏 → 工作台 */
export interface VfxStatusDoc {
  writer: string;
  /** 游戏侧写入时刻（Date.now()，服务端会盖一次） */
  ts: number;
  sceneId: string | null;
  /** 已套用的工作台文档 rev；0 = 用的是磁盘上那份，不是工作态 */
  appliedRev: number;
  /** 工作台正在编辑的那个效果，在本场景被哪些实例引用着 */
  effectId: string;
  instances: VfxInstanceStatus[];
  /** 本场景所有实例的总览（不止工作台那个效果） */
  allInstances: number;
  stats: { instances: number; live: number; drawCalls: number; fields: number; simMs: number };
  /** 玩家脚点（场景坐标 wu）与它的 M-world 地面点：工作台拿同一画面点过本地换算比一次（活证据） */
  playerScene: { x: number; y: number } | null;
  playerWorld: [number, number, number] | null;
  /** 模拟空间的种类（field = 有照明载荷；planar = 平面近似，没有墙也没有地形） */
  spaceKind: string | null;
  /** 最近一次真发出去的刺激序号 */
  probeSeqDone: number;
  /** 这个游戏页的实例 id（= 运行时命令队列的 targetBootId）：多开页签时工作台用它只指挥这一页 */
  bootId?: string;
  /** 页面地址（不含 origin）与开页时刻：几个页同时回传时，槽挑最新开的那页当"游戏" */
  href?: string;
  startedAt?: number;
}

/**
 * 这份文档要不要应用。与声学同一套规则（少一道「场景对不上」——一个效果可以被任何场景的实例引用，
 * 工作台展开哪个场景不影响该不该预览）。
 */
export function shouldApplyVfxDoc(
  doc: VfxSyncDoc | null | undefined,
  me: string,
  lastSeenRev: number,
): boolean {
  if (!doc || typeof doc.rev !== 'number') return false;
  if (!doc.effectId || typeof doc.effectId !== 'string') return false;
  const def = doc.def as VfxEffectDef | undefined;
  if (!def || typeof def !== 'object' || !Array.isArray(def.emitters)) return false;
  if (doc.writer === me) return false;
  if (doc.rev <= lastSeenRev) return false;
  return true;
}

export interface VfxSyncStatus {
  connected: boolean;
  sinceOkMs: number | null;
  failStreak: number;
  lastError: string;
  pollMs: number;
  applied: number;
  published: number;
  probesDone: number;
  lastWriter: string;
  lastDocAgeMs: number | null;
  lastDocEffect: string;
  appliedRev: number;
  suppressed: string;
}

export interface RuntimeVfxSyncDeps {
  getSceneId: () => string | null;
  /** 套用工作态：用这份定义覆盖效果缓存并重建引用它的实例（`VfxSystem.applyPreviewEffect`） */
  applyPreview: (effectId: string, def: VfxEffectDef) => void;
  /** 撤销覆盖（回到磁盘上那份） */
  clearPreview: (effectId: string) => void;
  /** 在画面点 `at`（+ 离地高）发一个刺激场；返回 false = 根本没发（没有模拟空间 / 不在场景里） */
  emitField: (def: VfxFieldDef, at: { x: number; y: number; h?: number }) => boolean;
  /** 回传给工作台的那一份现状（除 writer / ts / probeSeqDone / appliedRev 之外的全部） */
  getStatus: (effectId: string) => Omit<VfxStatusDoc, 'writer' | 'ts' | 'appliedRev' | 'effectId' | 'probeSeqDone'>;
  log: (msg: string) => void;
}

export class RuntimeVfxSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private inFlightSince = 0;
  private lastSeenRev = 0;
  private appliedRev = 0;
  private appliedEffect = '';
  /** 最近一次见过的刺激序号；-1 = 还没见过任何文档（第一次只记不发） */
  private lastProbeSeq = -1;
  /** 上一份文档的 writer：工作台换了进程 / 重开页（序号从头数）就当第一次看到 */
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
  private lastDocEffect = '';
  private suppressed = '';
  /** 开页时刻：几个游戏页同时回传时，槽按它挑最新开的那页 */
  private readonly startedAt = Date.now();

  constructor(
    private readonly deps: RuntimeVfxSyncDeps,
    private readonly writerId: string,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.inFlight = false;
    // 拆联动 = 不再预览工作态：把覆盖撤掉，下次装载读磁盘那份
    if (this.appliedEffect) {
      try { this.deps.clearPreview(this.appliedEffect); } catch { /* 拆的时候游戏可能已经在拆了 */ }
      this.appliedEffect = '';
    }
  }

  /**
   * 换场景：实例整批重建，工作态得重新套。归零 `lastSeenRev` 让下一拍重判；
   * 刺激序号**不**归零，否则换个场景就把上一次的刺激重放一遍。
   */
  onSceneChanged(): void {
    this.lastSeenRev = 0;
    this.appliedRev = 0;
    this.lastStatusJson = '';
  }

  status(): VfxSyncStatus {
    return {
      connected: this.failStreak === 0 && this.lastOkAt > 0,
      sinceOkMs: this.lastOkAt > 0 ? Math.max(0, now() - this.lastOkAt) : null,
      failStreak: this.failStreak,
      lastError: this.lastError,
      pollMs: this.currentPollMs(),
      applied: this.appliedCount,
      published: this.publishedCount,
      probesDone: this.probesDone,
      lastWriter: this.lastWriter,
      lastDocAgeMs: this.lastDocAgeMs,
      lastDocEffect: this.lastDocEffect,
      appliedRev: this.appliedRev,
      suppressed: this.suppressed,
    };
  }

  /** 一行给人看的状态。**必须带收发计数**——"发 0 收 0"是最直接的死亡证明。 */
  statusLine(): string {
    const s = this.status();
    const io = `收${s.applied} 发${s.published} 刺激${s.probesDone}`;
    const peer = s.lastWriter
      ? `　工作台${s.lastDocAgeMs === null ? '' : `(${(s.lastDocAgeMs / 1000).toFixed(0)}s前)`}`
        + `${s.lastDocEffect ? `「${s.lastDocEffect}」` : ''}`
      : '　工作台还没发过东西';
    const applied = s.appliedRev > 0 ? `　预览工作态#${s.appliedRev}` : '　用的是磁盘上那份';
    const gate = s.suppressed ? `　⏸ ${s.suppressed}` : '';
    if (!s.connected) {
      if (s.sinceOkMs === null) {
        return `↔ 粒子联动等待 dev server…${s.lastError ? `（${s.lastError}）` : ''}　${io}`;
      }
      return `⚠ 粒子联动已断 ${(s.sinceOkMs / 1000).toFixed(0)}s（自动重连中）`
        + `${s.lastError ? `：${s.lastError}` : ''}　${io}`;
    }
    const ago = s.sinceOkMs === null ? '' : `${(s.sinceOkMs / 1000).toFixed(1)}s前`;
    return `↔ 粒子联动(${ago})　${io}${peer}${applied}${gate}`;
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
        this.deps.log('粒子联动：上一发卡太久，已强制放行并继续（看门狗）');
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
      if (this.failStreak > 0) this.deps.log(`粒子联动已恢复（断了 ${this.failStreak} 次重试）`);
      this.lastOkAt = now();
      this.failStreak = 0;
      this.lastError = '';
      this.errorLogged = false;
    } catch (e) {
      this.failStreak += 1;
      this.lastError = e instanceof Error ? e.message : String(e);
      if (!this.errorLogged) {
        this.errorLogged = true;
        this.deps.log(`粒子联动暂时连不上（会自动重连）：${this.lastError}`);
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

  private async pullOnce(): Promise<void> {
    const body = await this.request(RUNTIME_VFX_API) as { doc?: VfxSyncDoc | null; ageMs?: number | null };
    const doc = body?.doc ?? null;
    this.lastDocAgeMs = typeof body?.ageMs === 'number' ? body.ageMs : null;
    this.lastWriter = doc?.writer ?? '';
    this.lastDocEffect = doc?.effectId ?? '';
    if (!doc) { this.suppressed = '槽是空的'; return; }
    if (isVfxDocStale(body?.ageMs)) {
      this.lastSeenRev = Math.max(this.lastSeenRev, doc.rev);
      if (this.lastProbeSeq < 0) { this.lastProbeSeq = doc.probe?.seq ?? 0; this.probeWriter = doc.writer; }
      this.suppressed = '工作台那份太旧（>5 分钟），不套用';
      return;
    }
    const firstSight = this.lastProbeSeq < 0;
    if (firstSight) { this.lastProbeSeq = doc.probe?.seq ?? 0; this.probeWriter = doc.writer; }
    else if (doc.writer !== this.probeWriter) { this.probeWriter = doc.writer; this.lastProbeSeq = 0; }
    if (!shouldApplyVfxDoc(doc, this.writerId, this.lastSeenRev)) {
      this.suppressed = '';
      if (doc.rev > this.lastSeenRev && doc.writer === this.writerId) this.lastSeenRev = doc.rev;
    } else {
      this.suppressed = '';
      this.lastSeenRev = doc.rev;
      try {
        // 换了效果：先把上一个的覆盖撤掉，不然作者切一次就留一份幽灵工作态在缓存里
        if (this.appliedEffect && this.appliedEffect !== doc.effectId) this.deps.clearPreview(this.appliedEffect);
        this.deps.applyPreview(doc.effectId, doc.def);
        this.appliedEffect = doc.effectId;
        this.appliedRev = doc.rev;
        this.appliedCount += 1;
      } catch (e) {
        console.error(`[vfxSync] 套用工作台推来的效果失败: ${(e as Error)?.stack ?? e}\n`
          + `  doc.rev=${doc.rev} effect=${doc.effectId} emitters=${doc.def?.emitters?.length}`);
        this.suppressed = '工作台 doc 套用失败(见 console),本拍跳过';
        return;
      }
    }
    // 刺激：序号比记住的大就发一次。中间漏看的一律不补发——作者要的是"现在看一下"
    const seq = doc.probe?.seq ?? 0;
    if (!firstSight && doc.probe?.field && seq > this.lastProbeSeq) {
      this.lastProbeSeq = seq;
      const accepted = this.deps.emitField(doc.probe.field, doc.probe.at ?? { x: 0, y: 0 });
      if (accepted) {
        this.probesDone += 1;
        this.lastProbeDoneSeq = Math.max(this.lastProbeDoneSeq, seq);
        this.lastStatusJson = '';   // 让下一拍立刻把已发序号回传出去
      } else {
        this.deps.log(`[粒子] 刺激「${doc.probe.field.kind}:${doc.probe.field.tag}」没发出去：当前场景没有模拟空间`);
      }
    }
  }

  private buildStatus(): VfxStatusDoc {
    const effectId = this.lastDocEffect;
    const base = this.deps.getStatus(effectId);
    return {
      ...base,
      writer: this.writerId,
      ts: 0,
      effectId,
      appliedRev: this.appliedRev,
      probeSeqDone: this.lastProbeDoneSeq,
      href: typeof location !== 'undefined' ? `${location.pathname}${location.search}` : undefined,
      startedAt: this.startedAt,
    };
  }

  private async pushStatus(): Promise<void> {
    const st = this.buildStatus();
    const json = JSON.stringify(st);
    const t = now();
    if (json === this.lastStatusJson && t - this.lastStatusAt < STATUS_HEARTBEAT_MS) return;
    st.ts = Date.now();
    await this.request(RUNTIME_VFX_STATUS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(st),
    });
    this.lastStatusJson = json;
    this.lastStatusAt = t;
    this.publishedCount += 1;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
