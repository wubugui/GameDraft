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
 * 与那两条**不同**的一点：推的不是内容，是"盘上那几张 PNG 变了"。所以重装时 URL 要带
 * `?v=<rev>` —— `AssetManager` 按 URL 缓存纹理，不换 URL 就永远是旧图（改完没反应，且不报错）。
 */
export const RUNTIME_SWAY_API = '/__gamedraft-api/runtime-sway';
const DOC_PATH = RUNTIME_SWAY_API;
const POLL_MS = 900;
const TIMEOUT_MS = 2500;
const BACKOFF_MAX_MS = 3000;

/** 槽里那一行 */
export interface SwaySyncDoc {
  rev?: number;
  sceneId?: string;
  ts?: number;
}

/**
 * 要不要按这份文档重装（纯函数，便于逐条钉死）。
 *
 * - `lastRev < 0` = **第一次看到槽**：只认下 rev，不重装。否则页面一刷新就把上一次的推送重放一遍；
 * - 场景对不上不重装：作者在另一个场景里烘的，别把这边的拆层换掉；
 * - rev 不比见过的新不重装（同一份推送不重复干活）。
 */
export function shouldReloadSway(doc: SwaySyncDoc | null, sceneId: string | null, lastRev: number): boolean {
  const rev = typeof doc?.rev === 'number' ? doc.rev : -1;
  if (rev < 0 || !sceneId) return false;
  if (lastRev < 0) return false;
  if (doc?.sceneId !== sceneId) return false;
  return rev > lastRev;
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

  constructor(private readonly deps: RuntimeSwaySyncDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => void this.tick(), POLL_MS);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** 换场景后重新认一次：新场景的拆层是刚装的，别拿上一个场景的 rev 去比 */
  resetSeen(): void {
    this.lastRev = -1;
  }

  statusLine(): string {
    return `草木联动：轮询 ${this.polls} 次 / 重装 ${this.applied} 次`
      + (this.lastErr ? `　最后一次出错：${this.lastErr}` : '');
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    if (this.backoff > 0) { this.backoff -= POLL_MS; return; }
    const sid = this.deps.currentSceneId();
    if (!sid) return;
    this.inFlight = true;
    try {
      const ctl = new AbortController();
      const t = window.setTimeout(() => ctl.abort(), TIMEOUT_MS);
      const res = await fetch(DOC_PATH, { cache: 'no-store', signal: ctl.signal });
      window.clearTimeout(t);
      this.polls++;
      const body = await res.json() as { doc?: SwaySyncDoc | null };
      const doc = body?.doc ?? null;
      const rev = typeof doc?.rev === 'number' ? doc.rev : -1;
      this.backoff = 0;
      this.lastErr = '';
      if (rev < 0) return;
      const go = shouldReloadSway(doc, sid, this.lastRev);
      this.lastRev = Math.max(this.lastRev, rev);
      if (!go) return;
      const ok = await this.deps.reload(String(rev));
      if (ok) this.applied++;
      this.deps.log?.(ok ? `[sway] 已按工作台的第 ${rev} 次重烘原地重装` : `[sway] 第 ${rev} 次重烘装不上（看上面的原因）`);
    } catch (e) {
      this.lastErr = String((e as Error)?.message ?? e);
      this.backoff = Math.min(BACKOFF_MAX_MS, Math.max(POLL_MS, this.backoff * 2 || POLL_MS));
    } finally {
      this.inFlight = false;
    }
  }
}
