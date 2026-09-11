import type { AcousticPoint, AcousticSpaceDef, AcousticTap } from '../audio/acousticSpace';
import type { AudioListenerSnapshot } from '../utils/audioSpace';

/**
 * 场景声学的**实时联动**（游戏侧）。DEV 专用。
 *
 * 声学工作台（`tools/acoustic_workbench`）是回音几何**唯一的作者面与写入者**；
 * 游戏在这条通道上只是**预览器**：工作台里每动一下，游戏下一拍就重算 IR，
 * 按一下试听键游戏就播一条干声。反向，游戏把「现在在哪个场景、听者站在哪、算出了
 * 哪些抽头、重算花了多久、音频解没解锁」回传给工作台画在 3D 里。
 *
 * ## 照抄光照那套（`runtimeLightingSync.ts`），理由一条不少
 *
 * 走 dev server 的文件槽而不是编辑器直接问游戏：游戏可能跑在外部 Chrome、
 * 内嵌页签或弹出窗口，两边各自中途开关重启，dev server 是唯一两边都始终可达的点。
 * 不新增端口：走页面自己的 origin + 两条新路径。
 *
 * 三个必须照抄的防死机制：每发都挂超时（`fetch` 默认没有，挂死一发就把 `inFlight`
 * 钉死、同步静默死亡）；连不上指数退避到 3s；`statusLine` 暴露连接状态与收发计数
 * （"以为在同步、其实早断了"是最贵的一种坏）。
 *
 * ## 两个槽，方向不同
 *
 * | 路径 | 方向 | 内容 |
 * |---|---|---|
 * | `runtime-acoustics` | 工作台 → 游戏 | 正在编辑的空间定义、要预览的空间 id、试听请求（序号 + 音效 id）。`rev` 服务端自增 |
 * | `runtime-acoustics-status` | 游戏 → 工作台 | 场景、听者（场景点 / 世界点）、抽头表、重算耗时、音频是否解锁。整份覆盖，不需要 rev |
 *
 * 光照那条是双方共写同一份 `lighting`；这里编辑只在工作台，所以拆成两个单向槽，
 * 天然没有回声风暴——但 `writer ≠ 我 && rev > 已见` 的闸门照样保留，万一将来游戏内
 * 也能改，规则不必重写。
 *
 * ## 试听靠序号
 *
 * 工作台把 `probe.seq` 加一，游戏看到比记住的大就播。**第一次看到槽里的文档时只记
 * 序号不播**：否则游戏一刷新就把上一次的试听重放一遍。
 *
 * ## 换场景后重新套用
 *
 * 进场景时 `setAudioApplier` 会把总线换成场景绑定的空间，工作台那份工作态就被冲掉了。
 * 所以换场景后把 `lastSeenRev` 归零，下一拍若文档仍新鲜就重新套用——作者在游戏里
 * 走到另一个场景，听到的仍是工作台里正在调的那份。
 */

export const RUNTIME_ACOUSTICS_API = '/__gamedraft-api/runtime-acoustics';
export const RUNTIME_ACOUSTICS_STATUS_API = '/__gamedraft-api/runtime-acoustics-status';

const POLL_MS = 400;
const POLL_MS_MAX = 3000;
const REQUEST_TIMEOUT_MS = 2000;
const INFLIGHT_WATCHDOG_MS = 15000;
/** 状态回传的心跳：内容没变也至少这么久发一次，工作台据此判「游戏还活着」。 */
const STATUS_HEARTBEAT_MS = 2000;
/** 状态回传里最多带多少个抽头（工作台画路径够用；整表可能上百个） */
const STATUS_TAPS_MAX = 24;
/** 同步槽的新鲜期。槽是"当前会话的对讲机"，不是状态存档。与光照同值。 */
const STALE_MS = 5 * 60 * 1000;

export function isAcousticsDocStale(ageMs: number | null | undefined): boolean {
  return typeof ageMs === 'number' && ageMs > STALE_MS;
}

/** 工作台 → 游戏 */
export interface AcousticsSyncDoc {
  rev: number;
  writer: string;
  /** 要预览的空间 id（工作台当前编辑的那个）。强行绑到任何场景上都能响。 */
  spaceId: string;
  /** 工作态定义（未落盘）。 */
  def: AcousticSpaceDef;
  /** 试听请求：序号递增一次播一次。`at` = 从哪个发声点播（wu，M-world）；没有 = 从听者自己发出（自己喊）。 */
  probe?: { seq: number; sfxId: string; at?: AcousticPoint | null };
  /** 工作台当前展开的场景（只用于显示 / 诊断，不做门槛） */
  sceneId?: string;
}

/** 游戏 → 工作台 */
export interface AcousticsStatusDoc {
  writer: string;
  /** 游戏侧写入时刻（Date.now()） */
  ts: number;
  sceneId: string | null;
  /** 场景 JSON 绑定的空间 */
  boundSpaceId: string | null;
  /** 总线上实际挂着的空间 */
  activeSpaceId: string | null;
  /** 已套用的工作台文档 rev；0 = 听的是场景绑定，不是工作态 */
  appliedRev: number;
  listenerMode: string;
  /** 运行时解出来的听者（地面点 + 耳点 + 绑定来源） */
  listener: AudioListenerSnapshot | null;
  /** 最近 3 秒主输出峰值（dBFS）；null = 没有电平表 / 一片静默。试听发出去后工作台看它才算"真出声了" */
  outputPeakDb?: number | null;
  taps: AcousticTap[];
  tapCount: number;
  costMs: number;
  thresholdM: number;
  audioUnlocked: boolean;
  /** 最近一次真播出去的试听序号 */
  probeSeqPlayed: number;
  /** 空间还欠着没挂上（音频没解锁，总线建不出来）：「已套用」≠「在响」 */
  pendingSpace?: boolean;
  /** 这个游戏页的实例 id（= 运行时命令队列的 targetBootId）：多开页签时工作台用它只指挥这一页 */
  bootId?: string;
  /** 页面地址（不含 origin）与开页时刻：几个页同时回传时，槽挑最新开的那页当"游戏" */
  href?: string;
  startedAt?: number;
  /** 音频没靠任何手势就解锁了 = 跑在免手势的专用预览窗 / 桌面客户端里，而不是普通浏览器页签 */
  autoplayAllowed?: boolean;
}

/**
 * 这份文档要不要应用。与光照同一套规则，只少一道「场景对不上」——
 * 制作人 2026-09-08 定：一个空间可以强行绑到任何场景上，逻辑上不负责效果对。
 */
export function shouldApplyAcousticsDoc(
  doc: AcousticsSyncDoc | null | undefined,
  me: string,
  lastSeenRev: number,
): boolean {
  if (!doc || typeof doc.rev !== 'number') return false;
  if (!doc.spaceId || typeof doc.spaceId !== 'string') return false;
  const def = doc.def as AcousticSpaceDef | undefined;
  if (!def || typeof def !== 'object' || !Array.isArray(def.reflectors) || !def.listener) return false;
  if (doc.writer === me) return false;
  if (doc.rev <= lastSeenRev) return false;
  return true;
}

export interface AcousticsSyncStatus {
  connected: boolean;
  sinceOkMs: number | null;
  failStreak: number;
  lastError: string;
  pollMs: number;
  applied: number;
  published: number;
  probesPlayed: number;
  lastWriter: string;
  lastDocAgeMs: number | null;
  lastDocSpace: string;
  appliedRev: number;
  suppressed: string;
}

export interface RuntimeAcousticsSyncDeps {
  getSceneId: () => string | null;
  /** 场景 JSON 绑定的空间 */
  getBoundSpaceId: () => string | null;
  /** 总线上实际挂着的空间 */
  getActiveSpaceId: () => string | null;
  /** 套用工作态：喂定义 + 换到那个空间（走 AudioManager 的同一入口，立刻重算 IR） */
  applyDef: (spaceId: string, def: AcousticSpaceDef) => void;
  /**
   * 从发声点 `at`（null = 听者自己）播一条干声试听。返回 false = 根本没发（音频没解锁 / 没这条音效）。
   * `onStarted` 在**真正开始出声**那一刻回调（解码完、没超出最远距离）——状态里的「已播序号」只认它。
   */
  playProbe: (sfxId: string, at: AcousticPoint | null, onStarted: () => void) => boolean;
  getListenerMode: () => string;
  getListener: () => AcousticsStatusDoc['listener'];
  /** 最近几秒主输出峰值（dBFS，-Infinity = 静默） */
  getOutputPeakDb?: () => number;
  getTaps: () => AcousticTap[];
  getPerf: () => { costMs: number; thresholdM: number };
  isAudioUnlocked: () => boolean;
  /** 空间还欠着没挂上（总线要用户手势才建得出来） */
  hasPendingSpace?: () => boolean;
  /** 本页实例 id（运行时命令队列的 targetBootId） */
  getBootId?: () => string;
  /** 音频是不是没靠手势就解锁了（免手势预览窗 / 桌面客户端） */
  isAutoplayAllowed?: () => boolean;
  log: (msg: string) => void;
}

export class RuntimeAcousticsSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private inFlightSince = 0;
  private lastSeenRev = 0;
  private appliedRev = 0;
  /** 最近一次见过的试听序号；-1 = 还没见过任何文档（第一次只记不播） */
  private lastProbeSeq = -1;
  /** 上一份文档的 writer：工作台换了进程 / 重开页（序号从头数）就当第一次看到，只记不播 */
  private probeWriter = '';
  private lastStatusJson = '';
  private lastStatusAt = 0;
  private lastOkAt = 0;
  private failStreak = 0;
  private lastError = '';
  private errorLogged = false;
  private appliedCount = 0;
  private publishedCount = 0;
  private probesPlayed = 0;
  private lastWriter = '';
  private lastDocAgeMs: number | null = null;
  private lastDocSpace = '';
  private suppressed = '';
  /** 开页时刻：几个游戏页同时回传时，槽按它挑最新开的那页 */
  private readonly startedAt = Date.now();

  constructor(
    private readonly deps: RuntimeAcousticsSyncDeps,
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
  }

  /**
   * 换场景：总线已被换成场景绑定，工作态得重新套。归零 `lastSeenRev` 让下一拍
   * 重判；试听序号**不**归零，否则换个场景就把上一次的试听重放一遍。
   */
  onSceneChanged(): void {
    this.lastSeenRev = 0;
    this.appliedRev = 0;
    this.lastStatusJson = '';
  }

  status(): AcousticsSyncStatus {
    return {
      connected: this.failStreak === 0 && this.lastOkAt > 0,
      sinceOkMs: this.lastOkAt > 0 ? Math.max(0, now() - this.lastOkAt) : null,
      failStreak: this.failStreak,
      lastError: this.lastError,
      pollMs: this.currentPollMs(),
      applied: this.appliedCount,
      published: this.publishedCount,
      probesPlayed: this.probesPlayed,
      lastWriter: this.lastWriter,
      lastDocAgeMs: this.lastDocAgeMs,
      lastDocSpace: this.lastDocSpace,
      appliedRev: this.appliedRev,
      suppressed: this.suppressed,
    };
  }

  /** 一行给人看的状态。**必须带收发计数**——"发 0 收 0"是最直接的死亡证明。 */
  statusLine(): string {
    const s = this.status();
    const io = `收${s.applied} 发${s.published} 试听${s.probesPlayed}`;
    const peer = s.lastWriter
      ? `　工作台${s.lastDocAgeMs === null ? '' : `(${(s.lastDocAgeMs / 1000).toFixed(0)}s前)`}`
        + `${s.lastDocSpace ? `「${s.lastDocSpace}」` : ''}`
      : '　工作台还没发过东西';
    const applied = s.appliedRev > 0 ? `　预览工作态#${s.appliedRev}` : '　听的是场景绑定';
    const gate = s.suppressed ? `　⏸ ${s.suppressed}` : '';
    if (!s.connected) {
      if (s.sinceOkMs === null) {
        return `↔ 声学联动等待 dev server…${s.lastError ? `（${s.lastError}）` : ''}　${io}`;
      }
      return `⚠ 声学联动已断 ${(s.sinceOkMs / 1000).toFixed(0)}s（自动重连中）`
        + `${s.lastError ? `：${s.lastError}` : ''}　${io}`;
    }
    const ago = s.sinceOkMs === null ? '' : `${(s.sinceOkMs / 1000).toFixed(1)}s前`;
    return `↔ 声学联动(${ago})　${io}${peer}${applied}${gate}`;
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
        this.deps.log('声学联动：上一发卡太久，已强制放行并继续（看门狗）');
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
      if (this.failStreak > 0) this.deps.log(`声学联动已恢复（断了 ${this.failStreak} 次重试）`);
      this.lastOkAt = now();
      this.failStreak = 0;
      this.lastError = '';
      this.errorLogged = false;
    } catch (e) {
      this.failStreak += 1;
      this.lastError = e instanceof Error ? e.message : String(e);
      if (!this.errorLogged) {
        this.errorLogged = true;
        this.deps.log(`声学联动暂时连不上（会自动重连）：${this.lastError}`);
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
    const body = await this.request(RUNTIME_ACOUSTICS_API) as {
      doc?: AcousticsSyncDoc | null; ageMs?: number | null;
    };
    const doc = body?.doc ?? null;
    this.lastDocAgeMs = typeof body?.ageMs === 'number' ? body.ageMs : null;
    this.lastWriter = doc?.writer ?? '';
    this.lastDocSpace = doc?.spaceId ?? '';
    if (!doc) { this.suppressed = '槽是空的'; return; }
    if (isAcousticsDocStale(body?.ageMs)) {
      this.lastSeenRev = Math.max(this.lastSeenRev, doc.rev);
      if (this.lastProbeSeq < 0) { this.lastProbeSeq = doc.probe?.seq ?? 0; this.probeWriter = doc.writer; }
      this.suppressed = '工作台那份太旧（>5 分钟），不套用';
      return;
    }
    // 游戏页第一次看到槽（刷新页面）：只记不播，否则把上一次的试听重放一遍。
    // 工作台换了 writer（服务重开）则相反：游戏一直开着，那份文档是**新**来的，里面的试听是真按的——序号从 0 重数，
    // 否则新工作台的第一下试听会被当成旧序号吞掉（2026-09-08 真机抓到）。
    const firstSight = this.lastProbeSeq < 0;
    if (firstSight) { this.lastProbeSeq = doc.probe?.seq ?? 0; this.probeWriter = doc.writer; }
    else if (doc.writer !== this.probeWriter) { this.probeWriter = doc.writer; this.lastProbeSeq = 0; }
    if (!shouldApplyAcousticsDoc(doc, this.writerId, this.lastSeenRev)) {
      this.suppressed = '';
      if (doc.rev > this.lastSeenRev && doc.writer === this.writerId) this.lastSeenRev = doc.rev;
      return;
    }
    this.suppressed = '';
    this.lastSeenRev = doc.rev;
    try {
      this.deps.applyDef(doc.spaceId, doc.def);
      this.appliedRev = doc.rev;
      this.appliedCount += 1;
    } catch (e) {
      console.error(`[acousticsSync] 套用工作台推来的空间失败: ${(e as Error)?.stack ?? e}\n`
        + `  doc.rev=${doc.rev} space=${doc.spaceId} reflectors=${doc.def?.reflectors?.length}`);
      this.suppressed = '工作台 doc 套用失败(见 console),本拍跳过';
      return;
    }
    const seq = doc.probe?.seq ?? 0;
    if (!firstSight && doc.probe && seq > this.lastProbeSeq) {
      // 中间漏看的序号一律不补播：作者要的是"现在听一下"，不是把积压的都放一遍
      this.lastProbeSeq = seq;
      const accepted = this.deps.playProbe(doc.probe.sfxId, doc.probe.at ?? null, () => {
        // 真出声了才算：解码完、没超出最远距离
        this.probesPlayed += 1;
        this.lastProbePlayedSeq = Math.max(this.lastProbePlayedSeq, seq);
        this.lastStatusJson = '';   // 让下一拍立刻把已播序号回传出去
      });
      if (!accepted) {
        this.deps.log(`[声学] 试听「${doc.probe.sfxId}」没播出去：音频还没解锁，去游戏窗口点一下`);
      }
    }
  }
  /** 最近一次**真出声**的试听序号（看到但没播出去 / 超出最远距离的不算） */
  private lastProbePlayedSeq = 0;

  private buildStatus(): AcousticsStatusDoc {
    const perf = this.deps.getPerf();
    const taps = this.deps.getTaps();
    return {
      writer: this.writerId,
      ts: 0,
      sceneId: this.deps.getSceneId(),
      boundSpaceId: this.deps.getBoundSpaceId(),
      activeSpaceId: this.deps.getActiveSpaceId(),
      appliedRev: this.appliedRev,
      listenerMode: this.deps.getListenerMode(),
      listener: this.deps.getListener(),
      taps: taps.slice(0, STATUS_TAPS_MAX),
      tapCount: taps.length,
      costMs: perf.costMs,
      thresholdM: perf.thresholdM,
      audioUnlocked: this.deps.isAudioUnlocked(),
      probeSeqPlayed: this.lastProbePlayedSeq,
      pendingSpace: this.deps.hasPendingSpace?.() ?? false,
      outputPeakDb: (() => { const v = this.deps.getOutputPeakDb?.(); return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null; })(),
      bootId: this.deps.getBootId?.(),
      href: typeof location !== 'undefined' ? `${location.pathname}${location.search}` : undefined,
      startedAt: this.startedAt,
      autoplayAllowed: this.deps.isAutoplayAllowed?.() ?? false,
    };
  }

  private async pushStatus(): Promise<void> {
    const st = this.buildStatus();
    const json = JSON.stringify(st);
    const t = now();
    if (json === this.lastStatusJson && t - this.lastStatusAt < STATUS_HEARTBEAT_MS) return;
    st.ts = Date.now();
    await this.request(RUNTIME_ACOUSTICS_STATUS_API, {
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
