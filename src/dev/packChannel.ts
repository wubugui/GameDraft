/**
 * 开发服：世界脑「一拍一包」请求通道的页面这一侧（设计稿 §13.2）。只在 dev server（Node）侧跑。
 *
 * - 页面先开一条**推送通道**（SSE：`GET …/jev/stream?page=<页面号>`），结果一题一条从这里推回，
 *   每道题不再各占一条连接（浏览器对同一个 dev server 只开 6 条）；
 * - 页面把同一帧要问的题打成一个包 `POST …/jev/pack`，**立即返回**，不占连接；
 * - 撤单 `POST …/jev/cancel`：转发口立刻撤 Hub 那边的单；
 * - 推送通道断了（关页面、热更新重载）：这个页面在途的单**全部撤掉**。
 *
 * 经 Hub 的包见 `hubPack.ts`；直连（公网 Jev、直连 Laya）的包在这里按并发上限一单一单调。
 */
import type { PackItem, PackItemResult, PackRunHandle } from './hubPack';

/** 往一个页面推一条（SSE 的一个事件） */
export interface PageSink {
  send(event: string, data: unknown): void;
}

interface PageEntry {
  sink: PageSink;
  runs: Set<PackRunHandle>;
}

/** 在线页面与它们在途的包。页面断开 = 它的包全撤。 */
export class PackPages {
  private readonly pages = new Map<string, PageEntry>();

  /** 页面开了推送通道；同一页面号重连时顶掉旧的（旧通道上的包照旧归它）。返回"通道断了"时调的收尾。 */
  attach(pageId: string, sink: PageSink): () => void {
    const prev = this.pages.get(pageId);
    const entry: PageEntry = { sink, runs: prev?.runs ?? new Set() };
    this.pages.set(pageId, entry);
    return () => {
      if (this.pages.get(pageId) !== entry) return;   // 已被新通道顶掉：旧的断开不撤新通道的单
      this.pages.delete(pageId);
      for (const r of entry.runs) r.cancelAll();
      entry.runs.clear();
    };
  }

  has(pageId: string): boolean {
    return this.pages.has(pageId);
  }

  get size(): number {
    return this.pages.size;
  }

  /** 往页面推（页面已走就丢掉：它的单已经全撤了） */
  push(pageId: string, event: string, data: unknown): void {
    const p = this.pages.get(pageId);
    if (!p) return;
    try {
      p.sink.send(event, data);
    } catch {
      /* 通道正在断：收尾会撤单 */
    }
  }

  /** 推给所有在线页面（Hub 的遥测） */
  broadcast(event: string, data: unknown): void {
    for (const id of this.pages.keys()) this.push(id, event, data);
  }

  /** 登记一个在跑的包：跑完自己摘掉；页面在它跑完之前走了，收尾时一起撤 */
  track(pageId: string, run: PackRunHandle): void {
    const p = this.pages.get(pageId);
    if (!p) {
      run.cancelAll();
      return;
    }
    p.runs.add(run);
    void run.done.finally(() => { p.runs.delete(run); });
  }

  cancel(pageId: string, ids: readonly string[]): void {
    const p = this.pages.get(pageId);
    if (!p) return;
    for (const r of p.runs) r.cancel(ids);
  }

  /** 开发服关掉：全撤 */
  closeAll(): void {
    for (const p of this.pages.values()) for (const r of p.runs) r.cancelAll();
    this.pages.clear();
  }
}

/** 直连上游问一单：回状态码 + JSON（与旧的 `/systemone` 路一样的形状） */
export type DirectCall = (item: PackItem) => Promise<{ status: number; json: unknown }>;

export interface DirectPackOptions {
  items: readonly PackItem[];
  /** 同时在途几单（公网 Jev 走代理隧道，池子本来就小；直连 Laya 在 GPU 上合批，多给） */
  concurrency: number;
  call: DirectCall;
  now: () => number;
  onResult: (r: PackItemResult) => void;
}

/**
 * 直连上游的包：按并发上限一单一单调。撤掉的单还没发就不发；已经发出去的，回来也不报
 * （直连的上游没有撤单接口，能省的只有还没发的）。每一单的保质期照样算：到点报 timeout。
 */
export function runDirectPack(o: DirectPackOptions): PackRunHandle {
  const t0 = o.now();
  const elapsed = () => Math.max(0, Math.round(o.now() - t0));
  const state = new Map<string, { item: PackItem; done: boolean }>();
  for (const it of o.items) state.set(it.id, { item: it, done: false });
  const queue = [...o.items];
  const report = (id: string, r: PackItemResult): void => {
    const s = state.get(id);
    if (!s || s.done) return;
    s.done = true;
    o.onResult(r);
  };
  const worker = async (): Promise<void> => {
    while (queue.length) {
      const it = queue.shift()!;
      const s = state.get(it.id)!;
      if (s.done) continue;
      if (elapsed() >= it.expireMs) {
        report(it.id, { id: it.id, ok: false, error_type: 'timeout', message: `排队 ${it.expireMs} ms 还没轮到，已撤单`, ms: elapsed() });
        continue;
      }
      let out: { status: number; json: unknown };
      try {
        out = await o.call(it);
      } catch (e) {
        report(it.id, { id: it.id, ok: false, error_type: 'upstream', message: String((e as Error)?.message ?? e), ms: elapsed() });
        continue;
      }
      if (elapsed() > it.expireMs) {
        report(it.id, { id: it.id, ok: false, error_type: 'timeout', message: `超过 ${it.expireMs} ms 才回`, ms: elapsed() });
        continue;
      }
      if (out.status === 200) {
        const m = (out.json as { model?: unknown } | null)?.model;
        report(it.id, { id: it.id, ok: true, body: out.json, model: typeof m === 'string' ? m : null, ms: elapsed() });
        continue;
      }
      const j = (out.json ?? {}) as Record<string, unknown>;
      const et = j.error_type;
      const error_type = et === 'no_key' || et === 'no_config' || et === 'unreachable' || et === 'timeout' ? et : 'upstream';
      const upErr = (j.error ?? null) as { message?: unknown } | null;
      const message = typeof j.message === 'string' ? j.message
        : upErr && typeof upErr.message === 'string' ? upErr.message
          : `上游回 ${out.status}`;
      report(it.id, { id: it.id, ok: false, error_type, message, ms: elapsed() });
    }
  };
  const n = Math.max(1, Math.min(o.concurrency, o.items.length));
  const done = Promise.all(Array.from({ length: n }, () => worker())).then(() => undefined);
  const cancelOne = (id: string): void => {
    const s = state.get(id);
    if (s) s.done = true;
  };
  return {
    cancel(ids) { for (const id of ids) cancelOne(id); },
    cancelAll() { for (const id of state.keys()) cancelOne(id); },
    done,
  };
}

/** 页面交来的包 → 校验过的单子（字段缺了 / 类型不对的整包拒） */
export function parsePackBody(raw: unknown): { page: string; pack: string; items: PackItem[] } | string {
  const b = (raw ?? {}) as Record<string, unknown>;
  const page = typeof b.page === 'string' ? b.page.trim() : '';
  const pack = typeof b.pack === 'string' ? b.pack.trim() : '';
  if (!page || !pack) return '缺 page / pack';
  if (!Array.isArray(b.items) || b.items.length === 0) return 'items 为空';
  const items: PackItem[] = [];
  for (const x of b.items as unknown[]) {
    const o = (x ?? {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    if (!id) return '有一单没有 id';
    if (!o.questions || typeof o.questions !== 'object') return `单 ${id} 没有 questions`;
    const pr = Number(o.priority);
    const ex = Number(o.expireMs);
    items.push({
      id,
      state: o.state,
      questions: o.questions as Record<string, unknown>,
      priority: Number.isFinite(pr) ? Math.max(0, Math.min(100, Math.round(pr))) : 50,
      scheduling: o.scheduling === 'idle' ? 'idle' : 'normal',
      expireMs: Number.isFinite(ex) && ex > 0 ? ex : 9000,
      ...(typeof o.name === 'string' && o.name ? { name: o.name.slice(0, 200) } : {}),
    });
  }
  return { page, pack, items };
}

/** SSE 的一帧 */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Hub 遥测 → 熔断要的那点事：GPU 此刻是不是被别的模型（图像 / 视频）占着。
 * `active_group` 为空 = GPU 空着；以 `laya` 开头 = Laya 在显存里。其余 = 被别的模型占着。
 */
export function summarizeTelemetry(raw: unknown): { gpuBusyOther: boolean; activeGroup: string | null; gpu: string | null } {
  const t = (raw ?? {}) as Record<string, unknown>;
  const ag = typeof t.active_group === 'string' && t.active_group ? t.active_group : null;
  const lanes = (t.lanes ?? {}) as Record<string, unknown>;
  const gpu = typeof lanes.gpu === 'string' ? lanes.gpu : null;
  return { gpuBusyOther: ag !== null && !ag.startsWith('laya'), activeGroup: ag, gpu };
}
