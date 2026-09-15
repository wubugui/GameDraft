/**
 * 背景草木拆层的**实时联动**（游戏侧）。DEV 专用。
 *
 * 草木工作台（`tools/sway_workbench`）是拆层输入 `sway_paint.png` 的唯一作者面；它重烘完往
 * dev server 的槽里写一行 `{rev, sceneId}`，游戏这边看到 rev 变大、且正是自己当前的场景，就
 * **原地重装一次拆层**——不切场景、玩家不动、相机不跳，改完到看见大约一秒。
 *
 * 与声学 / 粒子两条联动同一套形状（`runtimeAcousticsSync` / `runtimeVfxSync`），三条防死机制照抄：
 * 1. **每发都挂超时**（`fetch` 默认没有，挂死一发就把 `inFlight` 钉死、同步静默死亡）；
 * 2. **连不上指数退避到 3 s**（游戏不在 dev server 下跑时别每秒敲一次）；
 * 3. **`statusLine()` 带收发计数**——"以为在同步、其实早断了"是最贵的一种坏。
 *
 * 与那两条**不同**的一点：推的不是内容，是"那几张 PNG 变了"。所以重装时 URL 要带
 * `?v=<rev>` —— `AssetManager` 按 URL 缓存纹理，不换 URL 就永远是旧图（改完没反应，且不报错）。
 *
 * 两种来源（制作人 2026-09-14 定的名字）：
 * - `preview` = **推给游戏**：工作台页面上此刻那份（存没存都算）烘在本机 `local/sway_preview/`，
 *   经 dev server 的 `<槽>/preview/<场景>/<烘焙目录>/` 读——资源一个字节没动。这一局里记住"这个场景用预览"，
 *   之后进这个场景、换时段都用预览，直到那个场景被导出；
 * - `export` = **导出到游戏**：已经写进资源，忘掉预览、换回资源那份。
 *
 * 🔴 两种都要**一直带着缓存戳**（`bustFor`）：同一局里推过的场景，之后进场景 / 换时段装拆层也带 `?v=<最近那次 rev>`，
 * 不只是原地重装那一下——否则导出后走出去再进来，JSON 桶按不带戳的 URL 还回导出之前那份 `sway.json`。
 */
export const RUNTIME_SWAY_API = '/__gamedraft-api/runtime-sway';
/** 预览在盘上的目录（相对仓库根）；Python 侧 `tools/sway_workbench/layers.py` 的 `PREVIEW_ROOT` 与它对齐，测试对着断言 */
export const RUNTIME_SWAY_PREVIEW_DIR = 'local/sway_preview';
/** 预览目录里游戏会来要的文件（dev server 只放行这几个名字） */
export const SWAY_PREVIEW_FILES: readonly string[] = [
  'sway.json', 'sway_plate.png', 'sway_matte.png', 'sway_ids.png', 'sway_rigid.png',
  'sway_plate_normal.png', 'sway_plate_albedo.png', 'sway_plate_depth.png',
];
const DOC_PATH = RUNTIME_SWAY_API;
const POLL_MS = 900;
const TIMEOUT_MS = 2500;
const BACKOFF_MAX_MS = 3000;

/** 某场景某张背景的预览拆层目录 URL（与资源的 `sceneBakeDirUrl` 同形，只是根不同） */
export function swayPreviewDirUrl(sceneId: string, bakeKey: string): string {
  return `${RUNTIME_SWAY_API}/preview/${encodeURIComponent(sceneId)}/${encodeURIComponent(bakeKey)}`;
}

/** 槽里那一行 */
export interface SwaySyncDoc {
  rev?: number;
  sceneId?: string;
  /** 缺省 = export（老推送没有这个字段，推的都是资源里那份） */
  source?: 'preview' | 'export';
  ts?: number;
}

/**
 * 这一行是不是**这一局里新来的推送**（纯函数）。
 *
 * - 见过槽（`lastRev ≥ 0`）：rev 比见过的大才算；
 * - **第一次看到槽**：只有 `ts` 晚于本局启动（`bootAt`）的才算——那是游戏起来之后、第一次轮询之前推的
 *   （工作台"推给游戏 → 游戏没开 → 拉起游戏 → 补发一次"就是这条路；原来一律不认，补发永远落空）。
 *   启动之前就留在盘上的那行（刷新页面、昨天推的）照旧不算，否则每刷新一次都把上一次推送重放一遍。
 */
export function isFreshSwayPush(doc: SwaySyncDoc | null, lastRev: number, bootAt?: number): boolean {
  const rev = typeof doc?.rev === 'number' ? doc.rev : -1;
  if (rev < 0) return false;
  if (lastRev >= 0) return rev > lastRev;
  return typeof bootAt === 'number' && typeof doc?.ts === 'number' && doc.ts > bootAt;
}

/**
 * 要不要按这份文档重装（纯函数，便于逐条钉死）。
 *
 * - 不是这一局里新来的推送不重装（见 `isFreshSwayPush`）；
 * - 场景对不上不重装：作者在另一个场景里烘的，别把这边的拆层换掉。
 */
export function shouldReloadSway(doc: SwaySyncDoc | null, sceneId: string | null, lastRev: number, bootAt?: number): boolean {
  if (!sceneId || doc?.sceneId !== sceneId) return false;
  return isFreshSwayPush(doc, lastRev, bootAt);
}

export interface RuntimeSwaySyncDeps {
  /** 当前场景 id；没进场景 ⇒ null */
  currentSceneId: () => string | null;
  /** 原地重装拆层（带缓存戳）。返回是否真的装上了 */
  reload: (cacheBust: string) => Promise<boolean>;
  log?: (msg: string) => void;
}

export class RuntimeSwaySync {
  private timer: number | null = null;
  private inFlight = false;
  private backoff = 0;
  private lastRev = -1;
  private polls = 0;
  private applied = 0;
  private lastErr = '';
  /** 这一局里被推过预览、还没导出的场景 → 最近那次推送的 rev（重装时当缓存戳） */
  private readonly previews = new Map<string, number>();
  /**
   * 这一局里被推过（**预览与导出都算**）的场景 → 最近那次推送的 rev。进场景装拆层时一律拿它当缓存戳。
   * 只给预览带戳不够：导出之后走出场景再进来，请求的是不带戳的资源 URL，`AssetManager` 的 JSON 桶
   * （换场景不丢）把导出**之前**那份 `sway.json` 原样还回来，配上重新读盘的新 id 图——新补的株不动 / 被裁掉、
   * 锚点与整体摆退回旧的，作者以为导出"回滚"了。
   */
  private readonly busts = new Map<string, number>();
  /** 场景 → 这一局里真在屏幕上换上的最近一次推送 rev（心跳里带给工作台：dev server 收下了 ≠ 游戏换上了） */
  private readonly appliedRevs = new Map<string, number>();
  /** 本局启动时刻（与 dev server 写的 `ts` 同一台机器的钟）：第一眼看到的那行晚于它才算新推送 */
  private readonly bootAt: number;
  /** 本局的 id：轮询时带给 dev server 当心跳，工作台据此知道"游戏页开着、在哪个场景、用没用预览" */
  private readonly bootId: string;
  /** 原地重装（`deps.reload`）还在等：这期间照样心跳（带 `loading=1`），但不看槽 */
  private reloading = false;

  constructor(private readonly deps: RuntimeSwaySyncDeps, now: number = Date.now()) {
    this.bootAt = now;
    this.bootId = `${now.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }

  /**
   * 这个场景现在该不该用推给游戏的预览；该用就给那次推送的 rev。
   * 只认**这一局里亲眼看到**的推送：槽文件跨重启留在盘上，刷新页面后第一眼看到的那行可能是昨天的，
   * 拿它当预览就是作者以为导出了、其实游戏里显示的是一份没进资源的东西。
   */
  previewFor(sceneId: string): { rev: number } | null {
    const rev = this.previews.get(sceneId);
    return rev === undefined ? null : { rev };
  }

  /**
   * 装这个场景的拆层该带的缓存戳：这一局里推过（预览或导出）就是最近那次的 rev，没推过 ⇒ undefined（照常装资源）。
   * 同一局里内容变了 URL 必须跟着变，否则 JSON 桶 / 纹理缓存按旧 URL 还回旧的那份（见 `busts`）。
   */
  bustFor(sceneId: string): string | undefined {
    const rev = this.busts.get(sceneId);
    return rev === undefined ? undefined : String(rev);
  }

  /** 某次推送（rev）已经真在这个场景的屏幕上换上了（原地重装成功、或进场景时按它的缓存戳装上了） */
  noteApplied(sceneId: string, rev: number): void {
    if (!sceneId || !Number.isFinite(rev) || rev <= 0) return;
    this.appliedRevs.set(sceneId, Math.max(this.appliedRevs.get(sceneId) ?? 0, rev));
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => void this.tick(), POLL_MS);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 换场景时调。**不再丢掉见过的 rev**：rev 是槽里全局自增的，不分场景；新场景的拆层装载时已经按
   * `previewFor` 取了该用的那份，之后比它新的推送照常重装。原来这里清成 -1，换完场景第一眼看到的
   * 那行又被当成"第一次看到"——配上「启动后推的算新推送」会让每次换场景都白白重装一遍。
   * 槽被清掉重来（rev 变小）在 `tick` 里按"第一次看到"处理。
   */
  resetSeen(): void {
    /* 见上：刻意不动 lastRev */
  }

  statusLine(): string {
    return `草木联动：轮询 ${this.polls} 次 / 重装 ${this.applied} 次`
      + (this.lastErr ? `　最后一次出错：${this.lastErr}` : '');
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    if (this.backoff > 0) { this.backoff -= POLL_MS; return; }
    const sid = this.deps.currentSceneId();
    /**
     * 场景还没装完（`scene:ready` 之前，含冷启动）/ 原地重装还在等：**照样心跳**，带 `loading=1`，但**不看槽**。
     * 原来这两段一拍都不发：工作台见心跳超过 4 s 就当"没有游戏页"，按 P 时去 `/api/link/open`——
     * 开着控制台就再拉起一个游戏窗口，没开就排一条切场景、把玩家送回入口。
     * 不看槽 = 不记 rev、不记预览：场景还没装好时别往上换；装完第一拍照常按 `isFreshSwayPush` 认这次推送。
     */
    const loading = !sid || this.reloading;
    let reloadNow: { sid: string; rev: number; what: string } | null = null;
    this.inFlight = true;
    try {
      const ctl = new AbortController();
      const t = window.setTimeout(() => ctl.abort(), TIMEOUT_MS);
      // 轮询顺带心跳：此刻在哪个场景、这个场景用的是不是预览（工作台的"游戏里已换上"/徽章按它说真话，
      // 不再把"dev server 收下了"当成"游戏看到了"）
      // `applied` = 这个场景里最近真换上的那次推送：工作台等它 ≥ 自己那次 rev 才说「✔ 已换上」
      // （原地重装装不上时它不涨——原来游戏日志说"已换上"、工作台打勾，画面上什么都没动）
      const q = `scene=${encodeURIComponent(sid ?? '')}&boot=${encodeURIComponent(this.bootId)}`
        + `&preview=${(sid && this.previews.get(sid)) || 0}&applied=${(sid && this.appliedRevs.get(sid)) || 0}`
        + (loading ? '&loading=1' : '');
      const res = await fetch(`${DOC_PATH}?${q}`, { cache: 'no-store', signal: ctl.signal });
      window.clearTimeout(t);
      this.polls++;
      const body = await res.json() as { doc?: SwaySyncDoc | null };
      this.backoff = 0;
      this.lastErr = '';
      if (loading || !sid) return;                        // 只是心跳：槽里那行等场景装好 / 重装完再看
      const doc = body?.doc ?? null;
      const rev = typeof doc?.rev === 'number' ? doc.rev : -1;
      if (rev < 0) return;
      if (rev < this.lastRev) {                            // 槽被清掉重来：按第一次看到处理
        this.lastRev = -1;
        this.appliedRevs.clear();                          // 旧的大 rev 留着会让之后每次推送都被当成"已换上"
      }
      // 这一局里新来的推送：记下"这个场景用预览 / 换回资源"——不管玩家此刻在不在那个场景，进去时照这个装
      if (isFreshSwayPush(doc, this.lastRev, this.bootAt) && doc?.sceneId) {
        if (doc.source === 'preview') this.previews.set(doc.sceneId, rev);
        else this.previews.delete(doc.sceneId);
        this.busts.set(doc.sceneId, rev);
      }
      const go = shouldReloadSway(doc, sid, this.lastRev, this.bootAt);
      this.lastRev = Math.max(this.lastRev, rev);
      if (!go) return;
      const what = doc?.source === 'preview' ? '推来的预览（资源没动）' : '导出的资源';
      this.reloading = true;                             // 放掉 inFlight 之前就立起来：之后几拍只发心跳
      reloadNow = { sid, rev, what };
    } catch (e) {
      this.lastErr = String((e as Error)?.message ?? e);
      this.backoff = Math.min(BACKOFF_MAX_MS, Math.max(POLL_MS, this.backoff * 2 || POLL_MS));
    } finally {
      this.inFlight = false;
    }
    // 重装放在 inFlight 之外等：等的这一两秒里定时器照常敲 tick，心跳不断（带 loading=1）
    if (reloadNow) await this.reloadInPlace(reloadNow.sid, reloadNow.rev, reloadNow.what);
  }

  private async reloadInPlace(sid: string, rev: number, what: string): Promise<void> {
    let ok = false;
    try {
      ok = await this.deps.reload(String(rev));
    } catch (e) {
      this.lastErr = String((e as Error)?.message ?? e);
    } finally {
      this.reloading = false;
    }
    if (ok) { this.applied++; this.noteApplied(sid, rev); }
    this.deps.log?.(ok ? `[sway] 已原地换上草木工作台第 ${rev} 次${what}` : `[sway] 第 ${rev} 次${what}装不上（看上面的原因）`);
  }
}
