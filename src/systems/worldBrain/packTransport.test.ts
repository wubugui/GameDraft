import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionBreaker, PackedJevTransport, percentile, type StreamLike } from './packTransport';
import type { JevCallResult } from './jevTransport';

class FakeStream implements StreamLike {
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  private readonly fns = new Map<string, ((ev: { data: string }) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (ev: { data: string }) => void): void {
    this.fns.set(type, [...(this.fns.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.fns.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
  close(): void { this.closed = true; }
}

const Q = { state: { s: 1 }, questions: { a: { type: 'noul', instructions: 'x' } } } as never;

function world(opts: { packStatus?: number[]; maxPacks?: number; route?: 'hub' | 'direct' } = {}) {
  const streams: FakeStream[] = [];
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const statuses = [...(opts.packStatus ?? [])];
  let clock = 0;
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    posts.push({ url, body });
    if (url.includes('/pack')) {
      const st = statuses.shift() ?? 202;
      return new Response(JSON.stringify(st === 202 ? { accepted: 1, route: opts.route ?? 'hub' } : { error_type: st === 409 ? 'no_stream' : 'no_key', message: 'x' }), {
        status: st, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const t = new PackedJevTransport({
    fetch: fetchFn as never,
    now: () => clock,
    pageId: 'pg',
    maxPacksInFlight: opts.maxPacks ?? 4,
    breaker: { window: 10, minSamples: 3, probeIntervalMs: 1000 },
    probeExpireMs: 800,
    openStream: (url) => {
      const s = new FakeStream(url);
      streams.push(s);
      queueMicrotask(() => s.emit('hello', { page: 'pg' }));
      return s;
    },
  });
  const packs = () => posts.filter((p) => p.url.includes('/pack'));
  const cancels = () => posts.filter((p) => p.url.includes('/cancel')).flatMap((p) => p.body.ids as string[]);
  const answer = (id: string, ms = 50) => {
    clock += ms;
    streams[streams.length - 1]!.emit('result', { id, ok: true, body: { answers: { a: { noul: 0.7 } } } });
  };
  return { t, streams, packs, cancels, answer, tick: (ms: number) => { clock += ms; } };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

afterEach(() => { vi.useRealTimers(); });

describe('一拍一包：页面这头', () => {
  it('同一帧的几题攒成一个包，交一次；结果从推送通道一条条回来', async () => {
    const w = world();
    const got: JevCallResult[] = [];
    void w.t.decide(Q, 5000, { tier: 'near' }).then((r) => got.push(r));
    void w.t.decide(Q, 5000, { tier: 'reply' }).then((r) => got.push(r));
    void w.t.decide(Q, 5000, { tier: 'reflect' }).then((r) => got.push(r));
    await settle();
    expect(w.streams).toHaveLength(1);
    expect(w.streams[0]!.url).toContain('/stream?page=pg');
    expect(w.packs()).toHaveLength(1);
    const items = w.packs()[0]!.body.items as { id: string; priority: number; scheduling: string }[];
    expect(items.map((i) => [i.priority, i.scheduling])).toEqual([[70, 'normal'], [90, 'normal'], [30, 'idle']]);
    for (const it of items) w.answer(it.id);
    await settle();
    expect(got).toHaveLength(3);
    expect(got.every((r) => r.ok)).toBe(true);
    expect(w.t.stats().p50Ms).not.toBeNull();
  });

  it('到了保质期：当场回 timeout，并从同一条路撤单', async () => {
    vi.useFakeTimers();
    const w = world();
    const p = w.t.decide(Q, 1200, { tier: 'far' });
    await settle();
    const id = (w.packs()[0]!.body.items as { id: string }[])[0]!.id;
    vi.advanceTimersByTime(1200);
    const r = await p;
    expect(r).toMatchObject({ ok: false, kind: 'timeout' });
    await settle();
    expect(w.cancels()).toEqual([id]);
    w.answer(id);                                    // 晚到的：丢掉
    expect(w.t.stats().cancelled).toBe(1);
  });

  it('调用方不要了（signal）：回 cancelled 并撤单', async () => {
    const w = world();
    const ctrl = new AbortController();
    const p = w.t.decide(Q, 5000, { tier: 'near', signal: ctrl.signal });
    await settle();
    ctrl.abort();
    expect(await p).toMatchObject({ ok: false, kind: 'cancelled' });
    await settle();
    expect(w.cancels()).toHaveLength(1);
  });

  it('在途包满了：下一拍的题等腾出包位再交（回话不等）', async () => {
    const w = world({ maxPacks: 1 });
    void w.t.decide(Q, 5000, { tier: 'near' });
    await settle();
    void w.t.decide(Q, 5000, { tier: 'far' });
    await settle();
    expect(w.packs()).toHaveLength(1);
    void w.t.decide(Q, 5000, { tier: 'reply' });
    await settle();
    expect(w.packs()).toHaveLength(2);                // 回话连同排着的一起交
    const first = (w.packs()[0]!.body.items as { id: string }[])[0]!.id;
    w.answer(first);
    await settle();
    expect(w.t.stats().packsInFlight).toBe(1);
  });

  it('转发口不认推送通道（开发服重启过，409）：重开一次再交', async () => {
    const w = world({ packStatus: [409, 202] });
    void w.t.decide(Q, 5000, { tier: 'near' });
    await settle();
    await settle();
    expect(w.streams).toHaveLength(2);
    expect(w.streams[0]!.closed).toBe(true);
    expect(w.packs()).toHaveLength(2);
  });

  it('推送通道断了：发出去的一律回网络错（转发口那边已撤单）', async () => {
    const w = world();
    const p = w.t.decide(Q, 5000, { tier: 'near' });
    await settle();
    w.streams[0]!.onerror?.({});
    expect(await p).toMatchObject({ ok: false, kind: 'network' });
    expect(w.streams[0]!.closed).toBe(true);
  });

  it('换一路决策服务：在途的全撤；之后的包带 ?backend=', async () => {
    const w = world();
    const p = w.t.decide(Q, 5000, { tier: 'near' });
    await settle();
    w.t.setBackend('jev');
    expect(await p).toMatchObject({ ok: false, kind: 'cancelled' });
    void w.t.decide(Q, 5000, { tier: 'near' });
    await settle();
    expect(w.packs()[1]!.url).toContain('?backend=jev');
  });
});

describe('熔断', () => {
  it('Hub 说 GPU 被图像 / 视频占着 → 开：非回话当场回 breaker，回话照发；发探针；探针按时回来且 GPU 让出来 → 关', async () => {
    vi.useFakeTimers();
    const w = world();
    void w.t.decide(Q, 5000, { tier: 'near' });
    await settle();
    w.streams[0]!.emit('hub', { gpuBusyOther: true, activeGroup: 'h3:gpu' });
    expect(w.t.stats().breakerOpen).toBe(true);
    expect(w.t.stats().hubActiveGroup).toBe('h3:gpu');
    const r = await w.t.decide(Q, 5000, { tier: 'mid' });
    expect(r).toMatchObject({ ok: false, kind: 'breaker' });
    expect(w.t.stats().substituted).toBe(1);
    void w.t.decide(Q, 5000, { tier: 'reply' });
    await settle();
    const lastItems = () => w.packs().flatMap((p) => p.body.items as { id: string; name?: string }[]);
    expect(lastItems().some((i) => i.name === 'world-brain probe')).toBe(true);
    // GPU 还被占着：探针回来也不关
    const probe = lastItems().find((i) => i.name === 'world-brain probe')!;
    w.answer(probe.id, 10);
    await settle();
    expect(w.t.stats().breakerOpen).toBe(true);
    // GPU 让出来了，下一发探针按时回来 → 关
    w.streams[0]!.emit('hub', { gpuBusyOther: false, activeGroup: 'laya:gpu' });
    w.tick(1100);
    vi.advanceTimersByTime(600);
    await settle();
    const probe2 = lastItems().filter((i) => i.name === 'world-brain probe')[1]!;
    w.answer(probe2.id, 10);
    await settle();
    expect(w.t.stats().breakerOpen).toBe(false);
  });

  it('只有经 Hub 的那一路看 Hub 的 GPU 占用：直连的不开；换一路熔断清零', async () => {
    const direct = world({ route: 'direct' });
    void direct.t.decide(Q, 5000, { tier: 'near' });
    await settle();
    direct.streams[0]!.emit('hub', { gpuBusyOther: true, activeGroup: 'h3:gpu' });
    expect(direct.t.stats().breakerOpen).toBe(false);

    const hub = world();
    void hub.t.decide(Q, 5000, { tier: 'near' });
    await settle();
    hub.streams[0]!.emit('hub', { gpuBusyOther: true, activeGroup: 'h3:gpu' });
    expect(hub.t.stats().breakerOpen).toBe(true);
    hub.t.setBackend('jev');
    expect(hub.t.stats().breakerOpen).toBe(false);
    // 还不知道新的一路怎么走：Hub 的遥测先不看
    hub.streams[0]!.emit('hub', { gpuBusyOther: true, activeGroup: 'h3:gpu' });
    expect(hub.t.stats().breakerOpen).toBe(false);
  });

  it('近档 P95 超过保质期 → 开', () => {
    const b = new DecisionBreaker({ window: 10, minSamples: 3, probeIntervalMs: 1000 });
    b.noteNear(100, 1000, 0);
    b.noteNear(200, 1000, 0);
    expect(b.isOpen).toBe(false);
    b.noteNear(null, 1000, 5);                      // 没回来
    expect(b.isOpen).toBe(true);
    expect(b.reason).toContain('P95');
    expect(b.takeProbe(10)).toBe(true);
    expect(b.takeProbe(500)).toBe(false);
    expect(b.takeProbe(1100)).toBe(true);
    b.noteProbe(true);
    expect(b.isOpen).toBe(false);
  });

  it('percentile', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBe(0);
  });
});
