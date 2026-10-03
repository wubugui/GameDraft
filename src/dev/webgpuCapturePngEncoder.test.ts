import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebGpuCapturePngEncoder } from './webgpuCapturePngEncoder';
import type { WebGpuCapturePngTask, WebGpuCapturePngWorkerRequest, WebGpuCapturePngWorkerResponse } from './webgpuCapturePngCodec';

const workers: TestWorker[] = [];
const encoders: WebGpuCapturePngEncoder[] = [];
class TestWorker {
  onmessage: ((event: MessageEvent<WebGpuCapturePngWorkerResponse>) => void) | null = null;
  onerror: ((event: { preventDefault(): void; message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: WebGpuCapturePngWorkerRequest[] = [];
  terminated = false;
  constructor() { workers.push(this); }
  postMessage(message: WebGpuCapturePngWorkerRequest, transfer: Transferable[]): void {
    this.messages.push(structuredClone(message, { transfer }));
  }
  terminate(): void { this.terminated = true; }
  emit(message: WebGpuCapturePngWorkerResponse): void { this.onmessage?.({ data: message } as MessageEvent<WebGpuCapturePngWorkerResponse>); }
  ready(supported = true): void { this.emit({ type: 'ready', supported, reason: supported ? undefined : 'fixture unsupported' }); }
  result(index = 0): void { this.emit({ type: 'result', id: this.messages[index].id, blob: new Blob(['fixture'], { type: 'image/png' }) }); }
}
function create(options: ConstructorParameters<typeof WebGpuCapturePngEncoder>[0] = {}): WebGpuCapturePngEncoder {
  const encoder = new WebGpuCapturePngEncoder(options); encoders.push(encoder); return encoder;
}
const task = (): WebGpuCapturePngTask => ({ kind: 'rgba', width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 255]) });
beforeEach(() => {
  workers.length = 0; encoders.length = 0; vi.useFakeTimers();
  vi.stubGlobal('Worker', TestWorker);
  vi.stubGlobal('OffscreenCanvas', class { convertToBlob(): void {} });
  vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray) {} });
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ putImageData: vi.fn() }), toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['fixture'], { type: 'image/png' })) }) });
});
afterEach(() => {
  for (const encoder of encoders) encoder.dispose();
  expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('capture PNG bounded worker ownership', () => {
  it('clamps worker count, admits only one task under the byte budget, and copies only the exact typed-array view', async () => {
    const encoder = create({ workerCount: 1, maxInFlightBytes: 12 });
    const source = new Uint8Array([99, 1, 2, 3, 255, 98]);
    const a = encoder.encode({ kind: 'rgba', width: 1, height: 1, pixels: source.subarray(1, 5) });
    const b = encoder.encode(task()); expect(workers).toHaveLength(2); workers.forEach(w => w.ready());
    expect(workers.map(w => w.messages.length)).toEqual([1, 0]); expect([...source]).toEqual([99, 1, 2, 3, 255, 98]);
    const transferred = workers[0].messages[0].task;
    expect([...(transferred.kind === 'rgba' ? transferred.pixels : [])]).toEqual([1, 2, 3, 255]);
    workers[0].result(); await expect(a).resolves.toBeInstanceOf(Blob);
    expect(workers[0].messages).toHaveLength(2); workers[0].result(1); await expect(b).resolves.toBeInstanceOf(Blob);
    expect(create({ workerCount: 99 }).workerCount).toBe(4);
  });

  it('rejects memory oversize, invalid options, and pre-abort without allocating workers', async () => {
    expect(() => create({ maxInFlightBytes: 0 })).toThrow(); expect(() => create({ timeoutMs: NaN })).toThrow();
    const encoder = create({ maxInFlightBytes: 11 }); await expect(encoder.encode(task())).rejects.toThrow(/工作内存/);
    const controller = new AbortController(); controller.abort();
    await expect(encoder.encode(task(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(workers).toHaveLength(0);
  });

  it.each(['pass', 'input', 'aspect', 'resource'] as const)('transfers an independent exact raw view for %s while preserving source bytes and metadata', async (kind) => {
    const encoder = create(); const source = new Uint8Array([99, 1, 2, 3, 255, 98]);
    const capture = { width: 1, height: 1, format: 'rgba8unorm', rawFormat: 'rgba8unorm', sourceFormat: 'rgba8unorm',
      aspect: 'color' as const, rawPixels: source.subarray(1, 5), rawBytesPerRow: 4, passOrdinal: 0, label: 'fixture', targetLabel: 'fixture',
      colorIndex: 0, bindingName: 'fixture', groupSlot: 0, binding: 0, textureId: null, viewId: null, contentVersion: 4,
      mipLevel: 0, arrayLayer: 0, textureOrdinal: 0, sampleCount: 1, sampleIndex: null, captureMoment: 'frame-end' as const };
    const pending = encoder.encode({ kind, capture } as unknown as WebGpuCapturePngTask); workers[0].ready();
    const transferred = workers[0].messages[0].task; expect(transferred.kind).toBe(kind);
    if (transferred.kind === 'rgba') throw new Error('Expected native raw texture task');
    expect([...transferred.capture.rawPixels!]).toEqual([1, 2, 3, 255]); expect(transferred.capture.rawPixels!.byteLength).toBe(4);
    expect(transferred.capture.rawBytesPerRow).toBe(4); expect([...source]).toEqual([99, 1, 2, 3, 255, 98]);
    workers[0].result(); await expect(pending).resolves.toBeInstanceOf(Blob);
  });

  it('cancels queued work without terminating another job, then ignores a terminated active worker late result', async () => {
    const encoder = create({ maxInFlightBytes: 12 }); const active = new AbortController(); const queued = new AbortController();
    const a = encoder.encode(task(), { signal: active.signal }); const rejectedA = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    const b = encoder.encode(task(), { signal: queued.signal }); const rejectedB = expect(b).rejects.toMatchObject({ name: 'AbortError' });
    workers.forEach(w => w.ready()); const old = workers[0]; const late = old.onmessage!; const oldId = old.messages[0].id;
    queued.abort(); await rejectedB; expect(old.terminated).toBe(false);
    active.abort(); await rejectedA; expect(old.terminated).toBe(true);
    const c = encoder.encode(task()); const current = workers.find(w => !w.terminated && w.messages.length > 0)!;
    late({ data: { type: 'result', id: oldId, blob: new Blob(['late'], { type: 'image/png' }) } } as MessageEvent<WebGpuCapturePngWorkerResponse>);
    current.result(); await expect(c).resolves.toBeInstanceOf(Blob);
  });

  it('disposes active and queued tasks, clears all worker timers, and rejects reuse', async () => {
    const encoder = create({ maxInFlightBytes: 12 }); const promises = [encoder.encode(task()), encoder.encode(task()), encoder.encode(task())];
    const rejections = promises.map(p => expect(p).rejects.toThrow(/关闭/)); workers.forEach(w => w.ready());
    encoder.dispose(); await Promise.all(rejections); expect(workers.every(w => w.terminated)).toBe(true);
    await expect(encoder.encode(task())).rejects.toThrow(/关闭/); encoder.dispose();
  });

  it.each(['onerror', 'onmessageerror', 'wrong-id'] as const)('drains all work on %s and preserves the failure for future requests', async (kind) => {
    const encoder = create(); const pending = [encoder.encode(task()), encoder.encode(task()), encoder.encode(task())];
    const rejections = pending.map(p => expect(p).rejects.toThrow(/PNG Worker/)); workers.forEach(w => w.ready());
    if (kind === 'onerror') workers[0].onerror!({ preventDefault: vi.fn(), message: 'fixture failure' });
    else if (kind === 'onmessageerror') workers[0].onmessageerror!();
    else workers[0].emit({ type: 'result', id: 9999, blob: new Blob(['bad'], { type: 'image/png' }) });
    await Promise.all(rejections); expect(workers.every(w => w.terminated)).toBe(true);
    await expect(encoder.encode(task())).rejects.toThrow(/PNG Worker/);
  });

  it('rejects a worker encode error or invalid blob locally while the next task can finish', async () => {
    const encoder = create({ maxInFlightBytes: 12 }); const a = encoder.encode(task()); const rejectedA = expect(a).rejects.toThrow('fixture codec error');
    const b = encoder.encode(task()); const rejectedB = expect(b).rejects.toThrow(/有效 PNG/); workers.forEach(w => w.ready());
    workers[0].emit({ type: 'error', id: workers[0].messages[0].id, message: 'fixture codec error' }); await rejectedA;
    workers[0].emit({ type: 'result', id: workers[0].messages[1].id, blob: new Blob([]) }); await rejectedB;
    const c = encoder.encode(task()); workers[0].result(2); await expect(c).resolves.toBeInstanceOf(Blob);
  });

  it('times out worker startup and active encoding, drains timers, and allows replacement after an encode timeout', async () => {
    const startup = create({ timeoutMs: 20 }); const first = startup.encode(task()); const rejectedFirst = expect(first).rejects.toThrow(/启动超时/);
    await vi.advanceTimersByTimeAsync(20); await rejectedFirst;
    const encoder = create({ timeoutMs: 20 }); const pending = encoder.encode(task()); const rejected = expect(pending).rejects.toThrow(/编码超时/);
    workers.filter(w => !w.terminated).forEach(w => w.ready()); await vi.advanceTimersByTimeAsync(20); await rejected;
    const next = encoder.encode(task()); workers.filter(w => !w.terminated).forEach(w => w.ready());
    const owner = workers.find(w => !w.terminated && w.messages.length > 0)!; owner.result(); await expect(next).resolves.toBeInstanceOf(Blob);
  });

  it('reports main-thread fallback when unsupported and requeues an already-started worker from its unchanged original bytes', async () => {
    const encoder = create(); const bytes = new Uint8Array([1, 2, 3, 255]);
    const pending = encoder.encode({ kind: 'rgba', width: 1, height: 1, pixels: bytes }); workers[0].ready(); workers[1].ready(false);
    expect(encoder.backend).toBe('main-thread'); expect(encoder.workerCount).toBe(0); expect(encoder.fallbackReason).toBe('fixture unsupported');
    expect([...bytes]).toEqual([1, 2, 3, 255]); expect(workers.every(w => w.terminated)).toBe(true);
    await vi.advanceTimersByTimeAsync(0); await expect(pending).resolves.toBeInstanceOf(Blob);
    vi.stubGlobal('Worker', undefined); const fallback = create(); expect(fallback.backend).toBe('main-thread');
    const next = fallback.encode(task()); await vi.advanceTimersByTimeAsync(0); await expect(next).resolves.toBeInstanceOf(Blob);
  });
});
