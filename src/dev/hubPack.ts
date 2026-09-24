/**
 * 开发服：世界脑「一拍一包」经推理 Hub 的那一段（设计稿 §13）。只在 dev server（Node）侧跑。
 *
 * 页面把同一帧要问的一群题打成一个包交过来；这里：
 * 1. 按 Hub 的微批规格拆块（每块 ≤32 个请求 / ≤256 道题），每块用 `POST /v1/batches` **原子入队**，
 *    每块一个 `Idempotency-Key`；网络错误 / 429 用**同一个键、同一个 body** 重试（Hub 说明第 4 条）；
 * 2. 等结果：长轮询块里一个还没完的任务（`/wait`，它一完多半整块都完了——同一个微批），
 *    再 `GET /v1/batches/{id}` 一次把整块的状态和结果取回，完一个报一个；
 * 3. 每一单有自己的保质期：到点没回就撤掉 Hub 那边的单、报 timeout；
 * 4. 页面撤单 / 页面断开：撤掉 Hub 那边对应的单（只管自己提交的任务）。
 *
 * 请求函数、时钟可注入（测试用假 Hub），不引第三方库。
 */
import type { HubRequester, HubResponse } from './layaHub';
import { normalizeHubResult } from './layaHub';

/** Hub 的 Laya 微批规格（`/guide.md`：每个 GPU 微批最多 32 个请求 / 256 个问题） */
export const HUB_PACK_MAX_REQUESTS = 32;
export const HUB_PACK_MAX_QUESTIONS = 256;

export interface PackItem {
  /** 页面给的单号（一个页面内唯一），结果按它对回去 */
  id: string;
  state: unknown;
  questions: Record<string, unknown>;
  /** Hub 队列优先级 0~100（大的先） */
  priority: number;
  /** `idle` = 空闲队列（反思单）；缺省 normal */
  scheduling: 'normal' | 'idle';
  /** 保质期：从转发口收到这个包起，多少毫秒没回就撤单、报 timeout */
  expireMs: number;
  /** Hub 上显示的任务名（谁、哪类题），只为好认 */
  name?: string;
}

export type PackErrorType = 'timeout' | 'upstream' | 'unreachable' | 'no_key' | 'no_config';

export type PackItemResult =
  | { id: string; ok: true; body: unknown; model: string | null; ms: number }
  | { id: string; ok: false; error_type: PackErrorType; message: string; ms: number };

/** 一个在跑的包：撤几单 / 全撤（页面断开）；`done` 在每一单都有了结果（或被撤）之后落定 */
export interface PackRunHandle {
  cancel(ids: readonly string[]): void;
  cancelAll(): void;
  readonly done: Promise<void>;
}

function questionCount(it: PackItem): number {
  return it.questions && typeof it.questions === 'object' ? Object.keys(it.questions).length : 0;
}

/**
 * 按微批规格拆块：顺序不变，每块 ≤maxReq 个请求、≤maxQ 道题；单个请求自己就超过 maxQ 的自成一块
 * （题目上限是页面那侧要守的，这里不替它砍题）。
 */
export function chunkPack(
  items: readonly PackItem[],
  maxReq = HUB_PACK_MAX_REQUESTS,
  maxQ = HUB_PACK_MAX_QUESTIONS,
): PackItem[][] {
  const out: PackItem[][] = [];
  let cur: PackItem[] = [];
  let q = 0;
  for (const it of items) {
    const n = questionCount(it);
    if (cur.length > 0 && (cur.length >= maxReq || q + n > maxQ)) {
      out.push(cur);
      cur = [];
      q = 0;
    }
    cur.push(it);
    q += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface HubPackOptions {
  base: string;
  key: string;
  /** 空串 = 不传（Laya 按 state 的语言自己选）；设计稿 §13.2 要求显式写，由 `.env.local` 的 LAYA_MODEL 给 */
  model: string;
  device: 'gpu' | 'cpu' | null;
  /** 包号：页面给的（页面内唯一），拼进每块的幂等键 */
  packId: string;
  /** 页面号：拼进幂等键（不同页面的包号可能撞） */
  pageId: string;
  items: readonly PackItem[];
  request: HubRequester;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onResult: (r: PackItemResult) => void;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'needs_review']);

function parse(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function detailOf(json: unknown, fallback: string): string {
  const j = (json ?? {}) as Record<string, unknown>;
  const d = j.detail ?? j.message ?? j.error;
  if (typeof d === 'string') return d;
  if (d !== undefined && d !== null) return JSON.stringify(d).slice(0, 300);
  return fallback;
}

interface Slot {
  item: PackItem;
  taskId: string | null;
  done: boolean;
  cancelled: boolean;
}

/** 跑一个包（经 Hub）。立即返回句柄；结果经 `onResult` 一单一单报回去。 */
export function runHubPack(o: HubPackOptions): PackRunHandle {
  const t0 = o.now();
  const elapsed = () => Math.max(0, Math.round(o.now() - t0));
  const auth = { Authorization: `Bearer ${o.key}` };
  const slots = new Map<string, Slot>();
  for (const it of o.items) slots.set(it.id, { item: it, taskId: null, done: false, cancelled: false });

  const report = (s: Slot, r: PackItemResult): void => {
    if (s.done) return;
    s.done = true;
    if (!s.cancelled) o.onResult(r);
  };
  const fail = (s: Slot, error_type: PackErrorType, message: string): void =>
    report(s, { id: s.item.id, ok: false, error_type, message, ms: elapsed() });
  const cancelTask = (taskId: string): void => {
    void o.request('POST', `${o.base}/v1/tasks/${encodeURIComponent(taskId)}/cancel`, auth, null, 3000)
      .catch(() => undefined);
  };
  const cancelSlot = (s: Slot): void => {
    if (s.done) return;
    s.cancelled = true;
    s.done = true;
    if (s.taskId) cancelTask(s.taskId);
  };

  /** Hub 的任务对象 → 这一单的结果（没到终态返回 null） */
  const settle = (s: Slot, task: Record<string, unknown>): void => {
    const st = String(task.state ?? task.status ?? '');
    if (!TERMINAL.has(st) || s.done) return;
    if (st === 'succeeded') {
      const body = normalizeHubResult(task.result);
      const m = (body as { model?: unknown } | null)?.model;
      report(s, { id: s.item.id, ok: true, body, model: typeof m === 'string' ? m : null, ms: elapsed() });
      return;
    }
    const why = st === 'needs_review'
      ? '是否完成不确定（needs_review），没有盲目重试'
      : detailOf({ detail: task.error }, st);
    fail(s, 'upstream', `Hub 任务${st === 'failed' ? '失败' : st === 'cancelled' ? '被取消' : '待核对'}：${why}`);
  };

  const runChunk = async (chunk: PackItem[], idx: number): Promise<void> => {
    const mine = chunk.map((it) => slots.get(it.id)!).filter((s) => !s.done);
    if (!mine.length) return;
    const latest = Math.max(...mine.map((s) => s.item.expireMs));
    const left = () => latest - elapsed();
    const jobs = mine.map((s) => {
      const params: Record<string, unknown> = { state: s.item.state, questions: s.item.questions };
      if (o.model) params.model = o.model;
      if (o.device) params.device = o.device;
      return {
        backend: 'laya',
        name: s.item.name ?? 'world-brain',
        priority: Math.max(0, Math.min(100, Math.round(s.item.priority))),
        scheduling: s.item.scheduling,
        params,
      };
    });
    const body = JSON.stringify({ name: `world-brain ${o.packId}#${idx}`, jobs });
    const idemKey = `wb-${o.pageId}-${o.packId}-${idx}`;

    // ① 原子入队：网络错误 / 429 用同一个键、同一个 body 重试
    let taskIds: string[] | null = null;
    let lastNetErr = '';
    for (let attempt = 0; attempt < 6 && !taskIds; attempt++) {
      if (mine.every((s) => s.done)) return;
      if (left() <= 0) {
        for (const s of mine) fail(s, 'timeout', `Hub 提交在保质期内没成功${lastNetErr ? `（${lastNetErr}）` : ''}`);
        return;
      }
      let res: HubResponse;
      try {
        res = await o.request('POST', `${o.base}/v1/batches`, {
          ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': idemKey,
        }, body, Math.max(500, Math.min(left(), 5000)));
      } catch (e) {
        lastNetErr = String((e as { code?: unknown })?.code ?? (e as Error)?.message ?? e);
        if (attempt >= 1 && /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/.test(lastNetErr)) {
          for (const s of mine) fail(s, 'unreachable', `连不上推理 Hub ${new URL(o.base).host}：${lastNetErr}`);
          return;
        }
        await o.sleep(Math.min(150 * (attempt + 1), Math.max(0, left())));
        continue;
      }
      const json = parse(res.body) as Record<string, unknown> | null;
      if (res.status === 200 || res.status === 201 || res.status === 202) {
        const ids = Array.isArray(json?.task_ids) ? (json!.task_ids as unknown[]).map(String) : [];
        if (ids.length !== mine.length) {
          for (const s of mine) fail(s, 'upstream', `Hub 接受了批次但任务数对不上（${ids.length}/${mine.length}）`);
          return;
        }
        taskIds = ids;
        break;
      }
      if (res.status === 401) {
        for (const s of mine) fail(s, 'no_key', `推理 Hub 不认这个 key（401）：${detailOf(json, '')}`);
        return;
      }
      if (res.status === 429) {
        const ra = Number(res.headers['retry-after']);
        await o.sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 200, Math.max(0, left())));
        continue;
      }
      for (const s of mine) fail(s, 'upstream', `Hub 拒绝批次（${res.status}）：${detailOf(json, res.body.slice(0, 200))}`);
      return;
    }
    if (!taskIds) {
      for (const s of mine) fail(s, lastNetErr ? 'unreachable' : 'upstream', `Hub 提交一直没成功${lastNetErr ? `：${lastNetErr}` : ''}`);
      return;
    }
    mine.forEach((s, i) => {
      s.taskId = taskIds![i]!;
      // 入队途中页面已经撤了：Hub 那边补撤
      if (s.cancelled) cancelTask(s.taskId);
    });

    // ② 等结果：长轮询一个没完的任务，再一次取回整块
    let batchId: string | null = null;
    while (true) {
      const open = mine.filter((s) => !s.done);
      if (!open.length) return;
      // 过了保质期的：撤单、报 timeout
      const now = elapsed();
      for (const s of open) {
        if (now < s.item.expireMs) continue;
        if (s.taskId) cancelTask(s.taskId);
        fail(s, 'timeout', `Hub 任务 ${s.item.expireMs} ms 内没算完（GPU 可能正被图像 / 视频任务占着），已撤单`);
      }
      const still = mine.filter((s) => !s.done);
      if (!still.length) return;
      const soonest = Math.min(...still.map((s) => s.item.expireMs)) - elapsed();
      const head = still[0]!;
      try {
        if (soonest >= 1000 && head.taskId) {
          const waitSec = Math.max(1, Math.min(25, Math.floor(soonest / 1000)));
          const w = await o.request('GET', `${o.base}/v1/tasks/${encodeURIComponent(head.taskId)}/wait?timeout=${waitSec}`,
            auth, null, waitSec * 1000 + 5000);
          const wj = parse(w.body) as Record<string, unknown> | null;
          if (w.status === 200 && wj) {
            settle(head, wj);
            if (typeof wj.batch_id === 'string') batchId = wj.batch_id;
          }
        } else {
          await o.sleep(Math.max(5, Math.min(40, soonest)));
        }
        if (mine.every((s) => s.done)) return;
        // 整块一次取回：同一个微批里的多半一起完了
        const bid = batchId ?? await (async () => {
          const t = await o.request('GET', `${o.base}/v1/tasks/${encodeURIComponent(head.taskId!)}`, auth, null, 5000);
          const tj = parse(t.body) as Record<string, unknown> | null;
          if (tj) settle(head, tj);
          return typeof tj?.batch_id === 'string' ? tj.batch_id : null;
        })();
        if (!bid) continue;
        batchId = bid;
        const b = await o.request('GET', `${o.base}/v1/batches/${encodeURIComponent(bid)}`, auth, null, 5000);
        const bj = parse(b.body) as { tasks?: unknown } | null;
        if (b.status !== 200 || !bj || !Array.isArray(bj.tasks)) continue;
        const byTask = new Map<string, Record<string, unknown>>();
        for (const t of bj.tasks as Record<string, unknown>[]) {
          if (t && typeof t.id === 'string') byTask.set(t.id, t);
        }
        for (const s of mine) {
          const t = s.taskId ? byTask.get(s.taskId) : undefined;
          if (t) settle(s, t);
        }
      } catch {
        // 网络错误不等于任务失败：只重试查询，不重新提交
        await o.sleep(Math.max(5, Math.min(100, soonest)));
      }
    }
  };

  const chunks = chunkPack(o.items);
  const done = Promise.all(chunks.map((c, i) => runChunk(c, i).catch((e) => {
    for (const it of c) {
      const s = slots.get(it.id)!;
      fail(s, 'upstream', `转发口出错：${String((e as Error)?.message ?? e)}`);
    }
  }))).then(() => undefined);

  return {
    cancel(ids) {
      for (const id of ids) {
        const s = slots.get(id);
        if (s) cancelSlot(s);
      }
    },
    cancelAll() {
      for (const s of slots.values()) cancelSlot(s);
    },
    done,
  };
}
