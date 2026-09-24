import { describe, expect, it } from 'vitest';
import type { PackItem, PackItemResult, PackRunHandle } from './hubPack';
import { PackPages, parsePackBody, runDirectPack, sseFrame, summarizeTelemetry } from './packChannel';

const item = (id: string, over: Partial<PackItem> = {}): PackItem => ({
  id, state: {}, questions: { q: {} }, priority: 50, scheduling: 'normal', expireMs: 5000, ...over,
});

function fakeRun(): PackRunHandle & { cancelled: string[]; all: number; finish: () => void } {
  let finish!: () => void;
  const done = new Promise<void>((r) => { finish = r; });
  const h = {
    cancelled: [] as string[],
    all: 0,
    cancel(ids: readonly string[]) { h.cancelled.push(...ids); },
    cancelAll() { h.all++; },
    done,
    finish,
  };
  return h;
}

describe('一拍一包：页面与推送通道', () => {
  it('推送通道断了：这个页面在途的包全撤；别的页面不受影响', () => {
    const pages = new PackPages();
    const sent: string[] = [];
    const detachA = pages.attach('A', { send: (ev) => sent.push(`A:${ev}`) });
    pages.attach('B', { send: (ev) => sent.push(`B:${ev}`) });
    const ra = fakeRun();
    const rb = fakeRun();
    pages.track('A', ra);
    pages.track('B', rb);
    pages.push('A', 'result', {});
    detachA();
    expect(ra.all).toBe(1);
    expect(rb.all).toBe(0);
    expect(pages.has('A')).toBe(false);
    pages.push('A', 'result', {});                 // 走了的页面：丢掉
    expect(sent).toEqual(['A:result']);
  });

  it('同一页面号重连：旧通道断开不撤新通道的包', () => {
    const pages = new PackPages();
    const oldDetach = pages.attach('A', { send: () => {} });
    const r = fakeRun();
    pages.track('A', r);
    pages.attach('A', { send: () => {} });
    oldDetach();
    expect(r.all).toBe(0);
    expect(pages.has('A')).toBe(true);
  });

  it('撤单转给这个页面的每个包；没开通道的页面交包直接全撤', () => {
    const pages = new PackPages();
    pages.attach('A', { send: () => {} });
    const r1 = fakeRun();
    const r2 = fakeRun();
    pages.track('A', r1);
    pages.track('A', r2);
    pages.cancel('A', ['x', 'y']);
    expect(r1.cancelled).toEqual(['x', 'y']);
    expect(r2.cancelled).toEqual(['x', 'y']);
    const orphan = fakeRun();
    pages.track('nobody', orphan);
    expect(orphan.all).toBe(1);
  });

  it('交来的包：字段不对整包拒；优先级夹到 0~100，scheduling 只认 idle', () => {
    expect(parsePackBody({ page: 'A', pack: 'p', items: [] })).toBe('items 为空');
    expect(parsePackBody({ pack: 'p', items: [{}] })).toBe('缺 page / pack');
    expect(parsePackBody({ page: 'A', pack: 'p', items: [{ id: 'a' }] })).toBe('单 a 没有 questions');
    const ok = parsePackBody({ page: 'A', pack: 'p', items: [{ id: 'a', questions: {}, priority: 300, scheduling: 'weird', expireMs: 1200 }] });
    expect(ok).toMatchObject({ page: 'A', pack: 'p', items: [{ id: 'a', priority: 100, scheduling: 'normal', expireMs: 1200 }] });
  });

  it('SSE 帧与 Hub 遥测摘要', () => {
    expect(sseFrame('result', { id: 'a' })).toBe('event: result\ndata: {"id":"a"}\n\n');
    expect(summarizeTelemetry({ active_group: 'qwen:gpu', lanes: { gpu: '运行中' } })).toEqual({ gpuBusyOther: true, activeGroup: 'qwen:gpu', gpu: '运行中' });
    expect(summarizeTelemetry({ active_group: 'laya:gpu' }).gpuBusyOther).toBe(false);
    expect(summarizeTelemetry({ active_group: null }).gpuBusyOther).toBe(false);
  });
});

describe('一拍一包：直连上游（公网 Jev / 直连 Laya）', () => {
  it('按并发上限一单一单调；撤掉的没发就不发；错误按上游的说法报', async () => {
    let clock = 0;
    let inFlight = 0;
    let peak = 0;
    const called: string[] = [];
    const gates = new Map<string, () => void>();
    const got: PackItemResult[] = [];
    const run = runDirectPack({
      items: ['a', 'b', 'c', 'd'].map((id) => item(id)),
      concurrency: 2,
      now: () => clock,
      call: (it) => {
        called.push(it.id);
        inFlight++;
        peak = Math.max(peak, inFlight);
        return new Promise((resolve) => {
          gates.set(it.id, () => {
            inFlight--;
            resolve(it.id === 'b'
              ? { status: 401, json: { error: { message: 'bad key' } } }
              : { status: 200, json: { answers: {}, model: 'jev-1.13' } });
          });
        });
      },
      onResult: (r) => got.push(r),
    });
    await Promise.resolve();
    expect(called).toEqual(['a', 'b']);
    run.cancel(['c']);
    gates.get('a')!();
    await new Promise((r) => setTimeout(r, 0));
    gates.get('b')!();
    await new Promise((r) => setTimeout(r, 0));
    clock = 100;
    gates.get('d')!();
    await run.done;
    expect(called).toEqual(['a', 'b', 'd']);
    expect(peak).toBe(2);
    expect(got.map((r) => [r.id, r.ok ? 'ok' : r.error_type])).toEqual([['a', 'ok'], ['b', 'upstream'], ['d', 'ok']]);
    expect(got[0]).toMatchObject({ model: 'jev-1.13' });
    expect((got[1] as { message: string }).message).toBe('bad key');
  });

  it('排队到保质期还没轮到 / 回来已过期：报 timeout', async () => {
    let clock = 0;
    const got: PackItemResult[] = [];
    await runDirectPack({
      items: [item('a', { expireMs: 50 }), item('b', { expireMs: 50 })],
      concurrency: 1,
      now: () => clock,
      call: async () => { clock += 80; return { status: 200, json: {} }; },
      onResult: (r) => got.push(r),
    }).done;
    expect(got.map((r) => (r.ok ? 'ok' : r.error_type))).toEqual(['timeout', 'timeout']);
  });
});
