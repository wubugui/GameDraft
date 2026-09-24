import { describe, expect, it } from 'vitest';
import { chunkPack, runHubPack, type PackItem, type PackItemResult } from './hubPack';
import type { HubRequester } from './layaHub';

const item = (id: string, nq = 1, over: Partial<PackItem> = {}): PackItem => ({
  id, state: { s: id },
  questions: Object.fromEntries(Array.from({ length: nq }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'x' }])),
  priority: 70, scheduling: 'normal', expireMs: 5000, ...over,
});

/** 假 Hub：记下每一发；任务状态由测试推进 */
function fakeHub() {
  const calls: { method: string; url: string; headers: Record<string, string>; body: string | null }[] = [];
  const tasks = new Map<string, { state: string; result?: unknown; error?: string; batch: string }>();
  const batches = new Map<string, string[]>();
  let clock = 0;
  let seq = 0;
  let submitFail: number[] = [];
  const request: HubRequester = async (method, url, headers, body) => {
    calls.push({ method, url, headers, body });
    const u = new URL(url);
    if (method === 'POST' && u.pathname === '/v1/batches') {
      const code = submitFail.shift();
      if (code === -1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      if (code) return { status: code, headers: code === 429 ? { 'retry-after': '0' } : {}, body: '{"detail":"x"}' };
      const b = JSON.parse(body!) as { jobs: unknown[] };
      const bid = `b${++seq}`;
      const ids = b.jobs.map(() => `t${++seq}`);
      for (const id of ids) tasks.set(id, { state: 'queued', batch: bid });
      batches.set(bid, ids);
      return { status: 202, headers: {}, body: JSON.stringify({ batch_id: bid, task_ids: ids }) };
    }
    const wait = /^\/v1\/tasks\/([^/]+)\/wait$/.exec(u.pathname);
    if (wait) {
      const t = tasks.get(wait[1]!)!;
      return { status: 200, headers: {}, body: JSON.stringify({ id: wait[1], batch_id: t.batch, state: t.state, result: t.result ?? null, error: t.error ?? null }) };
    }
    const bg = /^\/v1\/batches\/([^/]+)$/.exec(u.pathname);
    if (method === 'GET' && bg) {
      const ids = batches.get(bg[1]!) ?? [];
      return { status: 200, headers: {}, body: JSON.stringify({ id: bg[1], tasks: ids.map((id) => ({ id, ...tasks.get(id), batch_id: bg[1] })) }) };
    }
    const cancel = /^\/v1\/tasks\/([^/]+)\/cancel$/.exec(u.pathname);
    if (cancel) {
      const t = tasks.get(cancel[1]!);
      if (t && t.state !== 'succeeded') t.state = 'cancelled';
      return { status: 200, headers: {}, body: '{}' };
    }
    return { status: 404, headers: {}, body: '{}' };
  };
  return {
    calls, tasks, batches, request,
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    advance: (ms: number) => { clock += ms; },
    failSubmits: (codes: number[]) => { submitFail = codes; },
    finishAll: (answer = 0.8) => {
      for (const t of tasks.values()) {
        if (t.state === 'queued') {
          t.state = 'succeeded';
          t.result = { answers: { q0: { noul: answer } }, model: 'laya-multilingual' };
        }
      }
    },
  };
}

const flush = async (n = 30): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve(); };

describe('一拍一包：按 Hub 微批规格拆块', () => {
  it('每块 ≤32 个请求、≤256 道题，顺序不变；单个超大的自成一块', () => {
    const many = Array.from({ length: 70 }, (_, i) => item(`a${i}`));
    expect(chunkPack(many).map((c) => c.length)).toEqual([32, 32, 6]);
    const fat = [item('x', 200), item('y', 100), item('z', 300), item('w', 1)];
    expect(chunkPack(fat).map((c) => c.map((i) => i.id))).toEqual([['x'], ['y'], ['z'], ['w']]);
    expect(chunkPack([item('p', 100), item('q', 100), item('r', 56), item('s', 1)]).map((c) => c.length)).toEqual([3, 1]);
  });
});

describe('一拍一包：经 Hub', () => {
  it('原子入队（/v1/batches，带幂等键和 model），整块完了一单一单报回去', async () => {
    const hub = fakeHub();
    const got: PackItemResult[] = [];
    const run = runHubPack({
      base: 'http://hub', key: 'k', model: 'laya-multilingual', device: null, packId: 'p1', pageId: 'pg',
      items: [item('a'), item('b', 1, { scheduling: 'idle', priority: 30 })],
      request: hub.request, now: hub.now, sleep: hub.sleep, onResult: (r) => got.push(r),
    });
    await flush();
    const submit = hub.calls.find((c) => c.url.endsWith('/v1/batches'))!;
    expect(submit.headers['Idempotency-Key']).toBe('wb-pg-p1-0');
    const jobs = (JSON.parse(submit.body!) as { jobs: { params: { model?: string }; scheduling: string; priority: number }[] }).jobs;
    expect(jobs.map((j) => [j.params.model, j.scheduling, j.priority])).toEqual([
      ['laya-multilingual', 'normal', 70], ['laya-multilingual', 'idle', 30],
    ]);
    hub.finishAll();
    await run.done;
    expect(got.map((r) => [r.id, r.ok])).toEqual([['a', true], ['b', true]]);
    expect(got[0]).toMatchObject({ ok: true, model: 'laya-multilingual', body: { answers: { q0: { noul: 0.8 } } } });
  });

  it('网络错误 / 429 用同一个键、同一个 body 重试，不换键重复提交', async () => {
    const hub = fakeHub();
    hub.failSubmits([-1, 429]);
    const got: PackItemResult[] = [];
    const run = runHubPack({
      base: 'http://hub', key: 'k', model: '', device: null, packId: 'p2', pageId: 'pg', items: [item('a')],
      request: hub.request, now: hub.now, sleep: hub.sleep, onResult: (r) => got.push(r),
    });
    await flush(60);
    const submits = hub.calls.filter((c) => c.url.endsWith('/v1/batches'));
    expect(submits).toHaveLength(3);
    expect(new Set(submits.map((s) => s.headers['Idempotency-Key'])).size).toBe(1);
    expect(new Set(submits.map((s) => s.body)).size).toBe(1);
    hub.finishAll();
    await run.done;
    expect(got[0]?.ok).toBe(true);
  });

  it('过了保质期：撤 Hub 那边的单、报 timeout', async () => {
    const hub = fakeHub();
    const got: PackItemResult[] = [];
    const run = runHubPack({
      base: 'http://hub', key: 'k', model: '', device: null, packId: 'p3', pageId: 'pg',
      items: [item('slow', 1, { expireMs: 300 })],
      request: hub.request, now: hub.now, sleep: hub.sleep, onResult: (r) => got.push(r),
    });
    await run.done;
    expect(got[0]).toMatchObject({ id: 'slow', ok: false, error_type: 'timeout' });
    expect(hub.calls.some((c) => /\/v1\/tasks\/t\d+\/cancel$/.test(c.url))).toBe(true);
    expect([...hub.tasks.values()][0]!.state).toBe('cancelled');
  });

  it('页面撤单 / 页面断开：撤 Hub 那边的单，不再报结果', async () => {
    const hub = fakeHub();
    const got: PackItemResult[] = [];
    const run = runHubPack({
      base: 'http://hub', key: 'k', model: '', device: null, packId: 'p4', pageId: 'pg',
      items: [item('a'), item('b'), item('c')],
      request: hub.request, now: hub.now, sleep: hub.sleep, onResult: (r) => got.push(r),
    });
    await flush();
    run.cancel(['a']);
    await flush();
    run.cancelAll();
    await run.done;
    const cancelled = hub.calls.filter((c) => c.url.endsWith('/cancel')).length;
    expect(cancelled).toBe(3);
    expect(got).toEqual([]);
  });

  it('key 不认（401）：整块报 no_key；任务失败：报 upstream', async () => {
    const hub = fakeHub();
    hub.failSubmits([401]);
    const got: PackItemResult[] = [];
    await runHubPack({
      base: 'http://hub', key: 'bad', model: '', device: null, packId: 'p5', pageId: 'pg', items: [item('a'), item('b')],
      request: hub.request, now: hub.now, sleep: hub.sleep, onResult: (r) => got.push(r),
    }).done;
    expect(got.map((r) => (r.ok ? 'ok' : r.error_type))).toEqual(['no_key', 'no_key']);

    const hub2 = fakeHub();
    const got2: PackItemResult[] = [];
    const run2 = runHubPack({
      base: 'http://hub', key: 'k', model: '', device: null, packId: 'p6', pageId: 'pg', items: [item('a')],
      request: hub2.request, now: hub2.now, sleep: hub2.sleep, onResult: (r) => got2.push(r),
    });
    await flush();
    for (const t of hub2.tasks.values()) { t.state = 'failed'; t.error = 'questions.a.criteria: bad'; }
    await run2.done;
    expect(got2[0]).toMatchObject({ ok: false, error_type: 'upstream' });
    expect((got2[0] as { message: string }).message).toContain('criteria');
  });
});
