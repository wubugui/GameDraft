/**
 * 地形（碰撞 / 可走区 / 行走面）的**实时联动**（游戏侧）。DEV 专用。
 *
 * 地形工作台（`tools/terrain_workbench`）是 `runtime/scenes/<id>/terrain/` 作者层的唯一写入者；它把作者层
 * 合成成游戏读的产物（`collision.png` + `collision.json` 旁挂 + 各时段 `ground_d.png`），往 dev server 的槽里写一行
 * `{rev, sceneId, source, ts}`。游戏看到 rev 变大、且正是自己当前的场景，就**原地换掉**碰撞与行走面——
 * 不切场景、玩家不动、相机不跳。
 *
 * 与草木那条（`runtimeSwaySync.ts`）同一套形状，三条防死机制照抄（每发超时 / 指数退避 / 计数状态行）；
 * 两种来源同样是制作人定的名字：`preview` = **推给游戏**（工作台页面此刻那份，烘在本机 `local/terrain_preview/`，
 * 经 dev server 的 `<槽>/preview/<场景>/…` 读，资源一个字节不动）；`export` = **导出到游戏**（已写进资源，换回资源那份）。
 * 🔴 两种都带缓存戳 `?v=<rev>`：`AssetManager` 按 URL 缓存位图 / 纹理，不换 URL 永远是旧图。
 *
 * 多出来的一样：**运行时对齐探测**。工作台把一批画面点写进槽（`probe: {seq, sceneId, points}`），游戏用**自己的**
 * `isCollision` 逐点判，把 0/1 串 POST 回 `<槽>/status`。工作台据此在顶栏亮「运行时对齐 ✓ n/n」——
 * 这是真判据（游戏真跑的那条反投影链），不是页面里再抄一份公式。
 */
export const RUNTIME_TERRAIN_API = '/__gamedraft-api/runtime-terrain';
/** 预览在盘上的目录（相对仓库根）；Python 侧 `tools/terrain_workbench/authoring.py` 的 `PREVIEW_ROOT` 与它对齐，测试断言 */
export const RUNTIME_TERRAIN_PREVIEW_DIR = 'local/terrain_preview';
/** 预览目录里游戏会来要的文件（dev server 只放行这几个名字；Python 侧 `PREVIEW_FILES` 同一份） */
export const TERRAIN_PREVIEW_FILES: readonly string[] = ['collision.png', 'collision.json', 'ground_d.png', 'ground_d.json'];
const DOC_PATH = RUNTIME_TERRAIN_API;
const STATUS_PATH = `${RUNTIME_TERRAIN_API}/status`;
const POLL_MS = 900;
const TIMEOUT_MS = 2500;
const BACKOFF_MAX_MS = 3000;

/** 某场景的预览目录 URL（碰撞在根；各时段行走面在 `ground/<烘焙目录名>/`） */
export function terrainPreviewDirUrl(sceneId: string): string {
  return `${RUNTIME_TERRAIN_API}/preview/${encodeURIComponent(sceneId)}`;
}

/** 槽里那一行 */
export interface TerrainSyncDoc {
  rev?: number;
  sceneId?: string;
  source?: 'preview' | 'export';
  ts?: number;
  /** 工作台请游戏判的一批画面点（世界坐标 wu，场景平面） */
  probe?: { seq?: number; sceneId?: string; points?: Array<[number, number]> } | null;
}

/**
 * 这一行是不是**这一局里新来的推送**（纯函数，与草木那条同式）：见过槽就比 rev；第一次看到槽只认 `ts` 晚于本局启动的。
 */
export function isFreshTerrainPush(doc: TerrainSyncDoc | null, lastRev: number, bootAt?: number): boolean {
  const rev = typeof doc?.rev === 'number' ? doc.rev : -1;
  if (rev < 0) return false;
  if (lastRev >= 0) return rev > lastRev;
  return typeof bootAt === 'number' && typeof doc?.ts === 'number' && doc.ts > bootAt;
}

export function shouldReloadTerrain(doc: TerrainSyncDoc | null, sceneId: string | null, lastRev: number, bootAt?: number): boolean {
  if (!sceneId || doc?.sceneId !== sceneId) return false;
  return isFreshTerrainPush(doc, lastRev, bootAt);
}

/** 这份探测请求要不要答（纯函数）：序号比答过的大、场景对得上、点有效 */
export function shouldAnswerProbe(doc: TerrainSyncDoc | null, sceneId: string | null, lastSeq: number): boolean {
  const p = doc?.probe;
  if (!p || !sceneId || p.sceneId !== sceneId) return false;
  const seq = typeof p.seq === 'number' ? p.seq : -1;
  return seq > lastSeq && Array.isArray(p.points) && p.points.length > 0;
}

export interface RuntimeTerrainSyncDeps {
  /** 当前场景 id；没进场景 ⇒ null */
  currentSceneId: () => string | null;
  /** 原地换碰撞 + 行走面（带缓存戳）。返回是否真的换上了 */
  reload: (cacheBust: string) => Promise<boolean>;
  /** 用游戏自己的 isCollision 判这些画面点；null = 现在判不了（没深度 / 没碰撞） */
  probe: (points: Array<[number, number]>) => { blocked: string; grid: unknown } | null;
  log?: (msg: string) => void;
}

export class RuntimeTerrainSync {
  private timer: number | null = null;
  private inFlight = false;
  private backoff = 0;
  private lastRev = -1;
  private lastProbeSeq = -1;
  private polls = 0;
  private applied = 0;
  private answered = 0;
  private lastErr = '';
  private readonly previews = new Map<string, number>();
  private readonly busts = new Map<string, number>();
  private readonly appliedRevs = new Map<string, number>();
  private readonly bootAt: number;
  private readonly bootId: string;
  private reloading = false;

  constructor(private readonly deps: RuntimeTerrainSyncDeps, now: number = Date.now()) {
    this.bootAt = now;
    this.bootId = `${now.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }

  previewFor(sceneId: string): { rev: number } | null {
    const rev = this.previews.get(sceneId);
    return rev === undefined ? null : { rev };
  }

  /** 这一局里推过（预览或导出）这个场景 ⇒ 最近那次的 rev（进场景后要按它原地换一次，绕开按 URL 的缓存） */
  bustFor(sceneId: string): string | undefined {
    const rev = this.busts.get(sceneId);
    return rev === undefined ? undefined : String(rev);
  }

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

  statusLine(): string {
    return `地形联动：轮询 ${this.polls} 次 / 换上 ${this.applied} 次 / 答探测 ${this.answered} 次`
      + (this.lastErr ? `　最后一次出错：${this.lastErr}` : '');
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    if (this.backoff > 0) { this.backoff -= POLL_MS; return; }
    const sid = this.deps.currentSceneId();
    const loading = !sid || this.reloading;
    let reloadNow: { sid: string; rev: number; what: string } | null = null;
    let answer: { seq: number; blocked: string; grid: unknown } | null = null;
    this.inFlight = true;
    try {
      const ctl = new AbortController();
      const t = window.setTimeout(() => ctl.abort(), TIMEOUT_MS);
      const q = `scene=${encodeURIComponent(sid ?? '')}&boot=${encodeURIComponent(this.bootId)}`
        + `&preview=${(sid && this.previews.get(sid)) || 0}&applied=${(sid && this.appliedRevs.get(sid)) || 0}`
        + (loading ? '&loading=1' : '');
      const res = await fetch(`${DOC_PATH}?${q}`, { cache: 'no-store', signal: ctl.signal });
      window.clearTimeout(t);
      this.polls++;
      const body = await res.json() as { doc?: TerrainSyncDoc | null };
      this.backoff = 0;
      this.lastErr = '';
      if (loading || !sid) return;
      const doc = body?.doc ?? null;
      // 探测：不管 rev，序号新就答（工作台每次合成后都重测一次）
      if (shouldAnswerProbe(doc, sid, this.lastProbeSeq)) {
        const p = doc!.probe!;
        const r = this.deps.probe(p.points as Array<[number, number]>);
        this.lastProbeSeq = p.seq as number;
        if (r) answer = { seq: p.seq as number, blocked: r.blocked, grid: r.grid };
      }
      const rev = typeof doc?.rev === 'number' ? doc.rev : -1;
      if (rev >= 0) {
        if (rev < this.lastRev) { this.lastRev = -1; this.appliedRevs.clear(); }
        if (isFreshTerrainPush(doc, this.lastRev, this.bootAt) && doc?.sceneId) {
          if (doc.source === 'preview') this.previews.set(doc.sceneId, rev);
          else this.previews.delete(doc.sceneId);
          this.busts.set(doc.sceneId, rev);
        }
        const go = shouldReloadTerrain(doc, sid, this.lastRev, this.bootAt);
        this.lastRev = Math.max(this.lastRev, rev);
        if (go) {
          const what = doc?.source === 'preview' ? '推来的预览（资源没动）' : '导出的资源';
          this.reloading = true;
          reloadNow = { sid, rev, what };
        }
      }
    } catch (e) {
      this.lastErr = String((e as Error)?.message ?? e);
      this.backoff = Math.min(BACKOFF_MAX_MS, Math.max(POLL_MS, this.backoff * 2 || POLL_MS));
    } finally {
      this.inFlight = false;
    }
    if (answer) await this.postStatus(sid!, answer);
    if (reloadNow) await this.reloadInPlace(reloadNow.sid, reloadNow.rev, reloadNow.what);
  }

  private async postStatus(sid: string, a: { seq: number; blocked: string; grid: unknown }): Promise<void> {
    try {
      const ctl = new AbortController();
      const t = window.setTimeout(() => ctl.abort(), TIMEOUT_MS);
      await fetch(STATUS_PATH, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: ctl.signal,
        body: JSON.stringify({ bootId: this.bootId, sceneId: sid, probeSeq: a.seq, blocked: a.blocked, grid: a.grid,
          applied: this.appliedRevs.get(sid) ?? 0 }),
      });
      window.clearTimeout(t);
      this.answered++;
    } catch (e) {
      this.lastErr = String((e as Error)?.message ?? e);
    }
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
    this.deps.log?.(ok ? `[terrain] 已原地换上地形工作台第 ${rev} 次${what}` : `[terrain] 第 ${rev} 次${what}换不上（看上面的原因）`);
  }
}
