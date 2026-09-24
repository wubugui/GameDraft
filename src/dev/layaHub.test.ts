import { describe, expect, it } from 'vitest';
import { hubDecide, normalizeHubResult, type HubDecideOptions, type HubResponse } from './layaHub';

type Call = { method: string; url: string; headers: Record<string, string>; body: string | null };

/** 假推理 Hub：按次序吐回应（函数可以按请求决定），记下每一发 */
function makeHub(script: ((c: Call) => HubResponse | Error)[]) {
  const calls: Call[] = [];
  let clock = 0;
  const opts = (over: Partial<HubDecideOptions> = {}): HubDecideOptions => ({
    base: 'http://hub:8765',
    key: 'k',
    payload: { state: { 地方: '一条街' }, questions: { sal: { type: 'noul', instructions: '会害怕。' } } },
    model: '',
    device: null,
    priority: 50,
    timeoutMs: 9000,
    idempotencyKey: 'idem-1',
    name: 'world-brain',
    request: async (method, url, headers, body) => {
      const c = { method, url, headers, body };
      calls.push(c);
      const step = script.shift();
      if (!step) throw new Error('script exhausted');
      const r = step(c);
      if (r instanceof Error) throw r;
      return r;
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    ...over,
  });
  return { calls, opts, advance: (ms: number) => { clock += ms; } };
}

const ok = (status: number, body: unknown, headers: Record<string, string> = {}): HubResponse =>
  ({ status, headers, body: JSON.stringify(body) });
const LAYA = { answers: { sal: { type: 'noul', noul: 0.91 } }, usage: { input_tokens: 40, state_tokens: 30 }, model: 'laya-multilingual' };

describe('推理 Hub 客户端', () => {
  it('提交（带幂等键、backend=laya、state/questions 放 params）→ 长轮询 → succeeded 交回 result', async () => {
    const hub = makeHub([
      () => ok(202, { task_id: 't1', batch_id: 'b1', task_ids: ['t1'] }),
      () => ok(200, { id: 't1', state: 'running', phase: '运行中' }),
      () => ok(200, { id: 't1', state: 'succeeded', phase: '完成', result: LAYA }),
    ]);
    const r = await hubDecide(hub.opts({ model: 'laya-multilingual', priority: 80 }));
    expect(r).toEqual({ status: 200, body: LAYA });
    const [submit, wait1, wait2] = hub.calls;
    expect(submit.method).toBe('POST');
    expect(submit.url).toBe('http://hub:8765/v1/tasks');
    expect(submit.headers).toMatchObject({ Authorization: 'Bearer k', 'Idempotency-Key': 'idem-1' });
    expect(JSON.parse(submit.body!)).toEqual({
      backend: 'laya', name: 'world-brain', priority: 80,
      params: { state: { 地方: '一条街' }, questions: { sal: { type: 'noul', instructions: '会害怕。' } }, model: 'laya-multilingual' },
    });
    expect(wait1.url).toMatch(/^http:\/\/hub:8765\/v1\/tasks\/t1\/wait\?timeout=\d+$/);
    expect(wait2.headers.Authorization).toBe('Bearer k');
  });

  it('提交遇到网络错误 / 429：用同一个幂等键、同一个 body 重试，429 按 Retry-After 退避', async () => {
    const hub = makeHub([
      () => new Error('socket hang up'),
      () => ok(429, { detail: 'slow down' }, { 'retry-after': '1' }),
      () => ok(202, { task_id: 't2' }),
      () => ok(200, { id: 'tx', state: 'succeeded', result: LAYA }),
    ]);
    const r = await hubDecide(hub.opts());
    expect(r.status).toBe(200);
    const submits = hub.calls.filter((c) => c.method === 'POST');
    expect(submits).toHaveLength(3);
    expect(new Set(submits.map((c) => c.headers['Idempotency-Key']))).toEqual(new Set(['idem-1']));
    expect(new Set(submits.map((c) => c.body)).size).toBe(1);
  });

  it('拿到 task_id 之后网络断了：只重试等待，不重新提交', async () => {
    const hub = makeHub([
      () => ok(202, { task_id: 't3' }),
      () => new Error('ECONNRESET'),
      () => ok(200, { id: 'tx', state: 'succeeded', result: LAYA }),
    ]);
    expect((await hubDecide(hub.opts())).status).toBe(200);
    expect(hub.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('key 不对（401）→ no_key；任务 failed / needs_review → 如实报，不盲目重试', async () => {
    const a = makeHub([() => ok(401, { detail: 'API key required' })]);
    expect(await hubDecide(a.opts())).toEqual({ status: 401, body: { error_type: 'no_key', message: expect.stringContaining('401') } });

    const b = makeHub([() => ok(202, { task_id: 't4' }), () => ok(200, { id: 't4', state: 'failed', error: 'CUDA out of memory' })]);
    const rb = await hubDecide(b.opts());
    expect(rb.status).toBe(502);
    expect((rb.body as { message: string }).message).toContain('CUDA out of memory');

    const c = makeHub([() => ok(202, { task_id: 't5' }), () => ok(200, { id: 't5', state: 'needs_review' })]);
    const rc = await hubDecide(c.opts());
    expect((rc.body as { message: string }).message).toContain('needs_review');
    expect(c.calls).toHaveLength(2);
  });

  it('到点没算完（GPU 被图像 / 视频占着）：取消自己这一个任务、报超时', async () => {
    let hubRef: ReturnType<typeof makeHub> | null = null;
    const hub = makeHub([
      () => ok(202, { task_id: 't6' }),
      ...Array.from({ length: 20 }, () => () => { hubRef!.advance(2000); return ok(200, { id: 't6', state: 'queued' }); }),
    ]);
    hubRef = hub;
    const r = await hubDecide(hub.opts({ timeoutMs: 9000 }));
    await Promise.resolve();
    expect(r.status).toBe(504);
    expect((r.body as { error_type: string }).error_type).toBe('timeout');
    const cancel = hub.calls.find((c) => c.url.endsWith('/v1/tasks/t6/cancel'));
    expect(cancel?.method).toBe('POST');
  });

  it('连不上 Hub（拒绝连接）→ unreachable', async () => {
    const e = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const hub = makeHub([() => e, () => e]);
    expect((await hubDecide(hub.opts())).body).toMatchObject({ error_type: 'unreachable' });
  });

  it('任务状态字段叫 state（Hub 1.0.0 实测）；叫 status 的也认', async () => {
    const hub = makeHub([() => ok(202, { task_ids: ['t7'] }), () => ok(200, { task_id: 't7', status: 'succeeded', result: LAYA })]);
    expect(await hubDecide(hub.opts())).toEqual({ status: 200, body: LAYA });
    expect(hub.calls[1].url).toContain('/v1/tasks/t7/wait');
  });

  it('result 包了一层也认得出（response / output）', () => {
    expect(normalizeHubResult({ response: LAYA })).toBe(LAYA);
    expect(normalizeHubResult({ output: LAYA })).toBe(LAYA);
    expect(normalizeHubResult(LAYA)).toBe(LAYA);
  });
});
