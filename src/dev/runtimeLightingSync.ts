import type { SceneLightingDef } from '../data/types';

/**
 * 场景光照的**双向实时同步**（游戏侧）。DEV 专用。
 *
 * 游戏里 F3 摆灯 / F2 拖滑条，与桌面编辑器场景页的灯表，改的是同一份 `lighting`：
 * 任一边动了，另一边下一拍轮询就跟上，**不用按任何按钮**。
 *
 * ## 为什么走 dev server 的一个文件槽
 *
 * 游戏可能跑在外部 Chrome、编辑器内嵌页签、或弹出窗口，两边还会各自中途开关重启。
 * dev server 是唯一**两边都始终可达**的点：先到的写、后到的读，谁重启都自动接上。
 * 第一版用编辑器的 `runJavaScript` 直接问游戏，只在"游戏正好跑在编辑器里"时成立——
 * 游戏开在外部浏览器时整条线是断的，而那恰恰是最常见的用法。
 *
 * ## 不新增端口，不与别的调试通道打架
 *
 * 请求走**页面自己的 origin + 一条新路径**（相对 URL），与运行时命令通道、快照上报是
 * 同一个 vite server 的不同路径；叙事调试器那条 WebSocket（另开端口）互不相干。
 * 也就是说：本机制**不新增任何监听端口**，游戏跑在哪个端口，同步就跟到哪个端口。
 *
 * ## 回声抑制（不做就是无限写循环）
 *
 * `rev` 由服务端自增。每一方记住「我发出去/应用过的最大 rev」，只应用
 * `rev > 已见 && writer ≠ 我` 的文档；应用之后把内容记成"已同步基线"，
 * 于是不会把刚吃进来的东西再吐回去。
 *
 * ## 忙的时候不吃对面的
 *
 * 正在拖灯、或开着独奏时，吃进对面的整块参数会当场把手上的动作/视图冲掉。
 * 这两种情况只发不收（发的还是**退了独奏的**那份，见 `exportFixup`）。
 *
 * ## 「连着连着就没了」的三个真实死法，逐条堵死
 *
 * 1. **请求挂死**：`fetch` 默认没有超时。dev server 重启到一半、代理抽风，这一发就可能
 *    永不 settle，而 `inFlight` 标志永远为真——同步从此**静默死亡**，没有任何异常痕迹。
 *    对策：每发都挂 `AbortController` 超时；外加 `inFlight` 看门狗二重保险。
 * 2. **失败后死磕**：连不上时仍按 400ms 猛发，日志刷屏，也占着别的调试通道的带宽。
 *    对策：指数退避到 3s，一成功立刻回到 400ms。
 * 3. **断了没人知道**：安静重试的代价是"以为在同步、其实早断了"。
 *    对策：{@link statusLine} 暴露连接状态，F2 光影页与编辑模式 HUD 都显示它。
 */

export const RUNTIME_LIGHTING_API = '/__gamedraft-api/runtime-lighting';

/** 正常轮询间隔：拖灯时对面每 ~0.4s 跟一次，够跟手又不至于把 dev server 打满。 */
const POLL_MS = 400;
/** 连不上时退避到这个上限（一成功立刻回到 `POLL_MS`）。 */
const POLL_MS_MAX = 3000;
/** 单发请求超时。**没有它就没有可靠的同步**：挂死的那一发会把 `inFlight` 永久钉住。 */
const REQUEST_TIMEOUT_MS = 2000;
/**
 * `inFlight` 看门狗。超时已经能兜住绝大多数挂死，但这个标志一旦因为任何未来的改动泄漏成真，
 * 症状就是"同步再也不跑了，且毫无痕迹"——这是本模块最贵的一种坏，值得二重保险。
 */
const INFLIGHT_WATCHDOG_MS = 15000;
/** 本地改动的合并窗口：拖灯一帧一改，不合并会把这个窗口打成每秒 60 次写文件。 */
const PUBLISH_DEBOUNCE_MS = 180;

/**
 * 同步槽的**新鲜期**。超过这个岁数的文档不再自动套用。
 *
 * 槽是"当前会话的对讲机"，不是状态存档。没有这道闸的话：昨天调灯留下的残留，
 * 会在今天游戏一开就被当成"对面刚改的"套回来，把这中间在编辑器里存过的改动顶掉。
 * 只要有一边还活着、真的改了东西，它发出来的文档就是新鲜的，同步照常。
 */
const STALE_MS = 5 * 60 * 1000;

/** 这份文档是不是陈年残留。拿不到岁数就当新鲜——宁可同步，也别假装没有对面。 */
export function isDocStale(ageMs: number | null | undefined): boolean {
  return typeof ageMs === 'number' && ageMs > STALE_MS;
}

export interface LightingSyncDoc {
  rev: number;
  writer: string;
  sceneId: string;
  lighting: SceneLightingDef;
  /**
   * 当前选中的灯 id。**会话态，不是策划数据** —— 住在文档层，不进 `lighting`，
   * 所以编辑器 Save All 落盘时带不出去。
   *
   * 为什么要同步它：灯一多，「编辑器灯表里选的是哪盏」与「画面上高亮的是哪盏」
   * 对不上，就等于没法找灯 —— 只能靠改一个参数看画面哪里变了来反推。
   */
  selectedId?: string | null;
}

/**
 * 这份文档要不要应用。**两侧（TS 与编辑器 Python）实现同一套规则**——
 * 规则分家会表现为"某一边偶尔不跟"，极难查。
 */
export function shouldApplyDoc(
  doc: LightingSyncDoc | null | undefined,
  me: string,
  lastSeenRev: number,
  mySceneId: string | null,
): boolean {
  if (!doc || typeof doc.rev !== 'number') return false;
  if (!doc.lighting || !Array.isArray(doc.lighting.lights)) return false;
  if (doc.writer === me) return false;              // 自己写的，别读回来
  if (doc.rev <= lastSeenRev) return false;         // 旧的或已经见过
  if (!mySceneId || doc.sceneId !== mySceneId) return false;  // 跨场景绝不套用
  return true;
}

/** 连接状态。给人看的——"以为在同步、其实早断了"是最难查的一种坏。 */
export interface LightingSyncStatus {
  /** 最近一次往返成功且此后没再失败 */
  connected: boolean;
  /** 距上次成功多久（ms）；从没成功过为 null */
  sinceOkMs: number | null;
  /** 连续失败次数 */
  failStreak: number;
  lastError: string;
  /** 这一刻的实际轮询间隔（退避后会变大） */
  pollMs: number;

  // ---- 下面这些是**诊断项**：不是锦上添花，是这条通道的必备仪表 ----
  //
  // 2026-08-22 的事故：编辑器那半边因为拿错对象，tick 一次都没跑过。
  // 而当时两边的状态行**只报传输连通性** —— 游戏侧确实连着、编辑器侧的标签
  // 停在初始那句"等待游戏（会自动连上）"，看着都像正常。
  // 排查花了整轮，而只要有下面任何一项，一眼就能看穿：
  //   · 收/发次数 —— "发 0 收 0" 是最直接的死亡证明
  //   · 最后写入者 —— 59 次全是 game，编辑器从没写过
  //   · 当前被什么闸挡着 —— 静默抑制是这条通道最贵的一种坏

  /** 我套用过对面几次 */
  applied: number;
  /** 我发出去过几次 */
  published: number;
  /** 槽里最后一次是谁写的（'' = 还没读到过） */
  lastWriter: string;
  /** 那份文档多老（ms）；null = 没读到过 */
  lastDocAgeMs: number | null;
  /** 那份文档是哪个场景的 */
  lastDocScene: string;
  /** 此刻本侧为什么不收（'' = 没被挡） */
  suppressed: string;
}

export interface RuntimeLightingSyncDeps {
  getSceneId: () => string | null;
  getParams: () => SceneLightingDef | null;
  /** 应用对面来的整块参数（走与 F2/编辑模式同一个入口，保证角色与背景一起更新） */
  applyParams: (def: SceneLightingDef) => void;
  /**
   * 本地正忙（拖灯中 / 独奏中）：忙时**只发不收**。
   * 收会把手上的拖拽或独奏视图当场冲掉。
   */
  isBusy: () => boolean;
  /** 发布前的修正：独奏是临时视图状态，交出去前要还原成真实开关 */
  exportFixup: (def: SceneLightingDef) => SceneLightingDef;
  /** 本侧当前选中的灯 id（没有选中返回 null） */
  getSelectedId: () => string | null;
  /** 套用对面的选中。与灯参分开走 —— 选中变化不该触发重打光。 */
  setSelectedId: (id: string | null) => void;
  log: (msg: string) => void;
}

export class RuntimeLightingSync {
  /** 定时器句柄。用**裸** setTimeout 不用 window.setTimeout：宿主不一定有 window
   *  （单测在 node 环境里跑），而这条通道的可测性正是永远连着的前提。 */
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private inFlightSince = 0;
  private lastSeenRev = 0;
  /**
   * 已与对面对齐的那份内容（JSON 文本）。本地内容与它不同即"我有新东西要发"。
   *
   * ⚠ 里面**必须含选中 id**：只比 `lighting` 的话，"只换了选中的灯"这件事
   *   永远发不出去，选中同步就成了单向的（对面选谁我跟，我选谁对面不知道）。
   */
  private syncedJson = '';
  private pendingSince = 0;
  private lastOkAt = 0;
  private failStreak = 0;
  private lastError = '';
  private errorLogged = false;
  private appliedCount = 0;
  private publishedCount = 0;
  private lastWriter = '';
  private lastDocAgeMs: number | null = null;
  private lastDocScene = '';
  private suppressed = '';

  constructor(
    private readonly deps: RuntimeLightingSyncDeps,
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

  /** 换场景后基线作废：新场景的第一份内容不该被当成"和对面已经对齐了"。 */
  resetBaseline(): void {
    this.syncedJson = '';
    this.pendingSince = 0;
  }

  status(): LightingSyncStatus {
    return {
      connected: this.failStreak === 0 && this.lastOkAt > 0,
      sinceOkMs: this.lastOkAt > 0 ? Math.max(0, performance.now() - this.lastOkAt) : null,
      failStreak: this.failStreak,
      lastError: this.lastError,
      pollMs: this.currentPollMs(),
      applied: this.appliedCount,
      published: this.publishedCount,
      lastWriter: this.lastWriter,
      lastDocAgeMs: this.lastDocAgeMs,
      lastDocScene: this.lastDocScene,
      suppressed: this.suppressed,
    };
  }

  /**
   * 一行给人看的状态；F2 光影页与编辑模式 HUD 直接贴这一行。
   *
   * ⚠ **必须带收发计数与最后写入者**。只报"连没连上"是不够的：2026-08-22 那次
   *   编辑器半边一次都没跑，而两边的状态行都显示正常（游戏侧真连着，编辑器侧的
   *   标签停在初始文案）。排查花了一整轮。有了 `发x 收y` 与 `最后:writer`，
   *   "发 0 收 0、最后写的一直是我自己" 一眼就是死的。
   */
  statusLine(): string {
    const s = this.status();
    const io = `发${s.published} 收${s.applied}`;
    const peer = s.lastWriter
      ? `　最后写入:${s.lastWriter.startsWith('game:') ? '游戏' : '编辑器'}`
        + `${s.lastDocAgeMs === null ? '' : `(${(s.lastDocAgeMs / 1000).toFixed(0)}s前)`}`
      : '　槽里还没有任何文档';
    const gate = s.suppressed ? `
　⏸ ${s.suppressed}` : '';
    if (!s.connected) {
      if (s.sinceOkMs === null) {
        return `↔ 同步等待连接…${s.lastError ? `（${s.lastError}）` : ''}　${io}`;
      }
      return `⚠ 同步已断 ${(s.sinceOkMs / 1000).toFixed(0)}s（自动重连中）`
        + `${s.lastError ? `：${s.lastError}` : ''}　${io}`;
    }
    const ago = s.sinceOkMs === null ? '' : `${(s.sinceOkMs / 1000).toFixed(1)}s前`;
    // 连着、但从没收发过任何东西 —— 这正是那次事故的样子，必须自己喊出来
    if (s.published === 0 && s.applied === 0) {
      return `⚠ 通道连着(${ago})但**一次都没收发过**　${io}${peer}${gate}`;
    }
    return `↔ 同步中(${ago})　${io}${peer}${gate}`;
  }

  /**
   * 基线的序列化：**灯参 + 选中**。收发两侧共用这一处 ——
   * 两边算法分家就会出现"我以为发过了/我以为收过了"的死角。
   */
  private baselineOf(lighting: SceneLightingDef, selectedId: string | null): string {
    return JSON.stringify({ lighting, selectedId });
  }

  /** 退避：连不上时逐步放慢到 3s，一成功立刻回到 400ms。 */
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
    // 看门狗：inFlight 泄漏成真 = 同步永久静默死亡，卡太久一律强制放行
    if (this.inFlight) {
      if (performance.now() - this.inFlightSince > INFLIGHT_WATCHDOG_MS) {
        this.inFlight = false;
        this.deps.log('光照同步：上一发卡太久，已强制放行并继续（看门狗）');
      } else {
        this.schedule(this.currentPollMs());
        return;
      }
    }
    const sceneId = this.deps.getSceneId();
    const params = this.deps.getParams();
    if (!sceneId || !params) {          // 没进场景 / 这个场景没配 lighting：不算失败，安静等
      this.schedule(POLL_MS);
      return;
    }
    this.inFlight = true;
    this.inFlightSince = performance.now();
    try {
      await this.pullOnce(sceneId);
      await this.pushOnce(sceneId);
      if (this.failStreak > 0) this.deps.log(`光照同步已恢复（断了 ${this.failStreak} 次重试）`);
      this.lastOkAt = performance.now();
      this.failStreak = 0;
      this.lastError = '';
      this.errorLogged = false;
    } catch (e) {
      this.failStreak += 1;
      this.lastError = e instanceof Error ? e.message : String(e);
      // dev server 没在跑 / 刚重启：安静退避重试，只出声一次（否则每 0.4s 刷一行）
      if (!this.errorLogged) {
        this.errorLogged = true;
        this.deps.log(`光照同步暂时连不上（会自动重连）：${this.lastError}`);
      }
    } finally {
      this.inFlight = false;
      this.schedule(this.currentPollMs());
    }
  }

  /** 带超时的请求。超时是这条通道能不能"永远连着"的分界线。 */
  private async request(init?: RequestInit): Promise<unknown> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(RUNTIME_LIGHTING_API, {
        ...init,
        signal: ac.signal,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  private async pullOnce(sceneId: string): Promise<void> {
    const body = await this.request() as { doc?: LightingSyncDoc | null; ageMs?: number | null };
    const doc = body?.doc ?? null;
    this.lastDocAgeMs = typeof body?.ageMs === 'number' ? body.ageMs : null;
    this.lastWriter = doc?.writer ?? '';
    this.lastDocScene = doc?.sceneId ?? '';
    if (!doc) { this.suppressed = '槽是空的'; return; }
    if (isDocStale(body?.ageMs)) {
      // 陈年残留：记下 rev 免得每拍重判，但绝不套用（岁数只会越来越大）
      this.lastSeenRev = Math.max(this.lastSeenRev, doc.rev);
      this.suppressed = '对面那份太旧（>5 分钟），不套用';
      return;
    }
    if (!shouldApplyDoc(doc, this.writerId, this.lastSeenRev, sceneId)) {
      this.suppressed = doc.writer === this.writerId ? ''
        : (doc.sceneId !== sceneId ? `场景对不上（槽里是 ${doc.sceneId}）` : '');
      // 见过就记下，省得每拍都重新判定同一份
      if (doc.rev > this.lastSeenRev && doc.writer === this.writerId) this.lastSeenRev = doc.rev;
      return;
    }
    if (this.deps.isBusy()) {
      // 忙：这一拍不收，rev 不推进，等会儿再来。**必须让人看见**——
      // 静默抑制正是"以为在同步、其实没在收"的来源。
      this.suppressed = '本侧忙（拖灯中／独奏中）只发不收';
      return;
    }
    this.suppressed = '';
    this.lastSeenRev = doc.rev;
    const incomingSel = doc.selectedId ?? null;
    this.syncedJson = this.baselineOf(doc.lighting, incomingSel);
    this.pendingSince = 0;
    this.appliedCount += 1;
    this.deps.applyParams(doc.lighting);
    // 选中放在灯参之后：applyParams 可能重建灯表，先设选中会被冲掉
    this.deps.setSelectedId(incomingSel);
  }

  private async pushOnce(sceneId: string): Promise<void> {
    const params = this.deps.getParams();
    if (!params) return;
    const fixed = this.deps.exportFixup(params);
    const sel = this.deps.getSelectedId();
    const mine = this.baselineOf(fixed, sel);
    if (mine === this.syncedJson) {
      this.pendingSince = 0;
      return;
    }
    // 合并窗口：拖灯期间每帧都在变，等它稳定一小会儿再发
    const now = performance.now();
    if (this.pendingSince === 0) {
      this.pendingSince = now;
      return;
    }
    if (now - this.pendingSince < PUBLISH_DEBOUNCE_MS) return;

    const body = await this.request({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sceneId, writer: this.writerId, lighting: fixed, selectedId: sel,
      }),
    }) as { rev?: number };
    if (typeof body?.rev === 'number') this.lastSeenRev = Math.max(this.lastSeenRev, body.rev);
    this.syncedJson = mine;
    this.pendingSince = 0;
    this.publishedCount += 1;
  }
}
