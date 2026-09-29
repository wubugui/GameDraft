import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebGpuCaptureClient, type WebGpuCaptureJob } from './webgpuCaptureClient';

const job = (state: WebGpuCaptureJob['state'], frames = 2): WebGpuCaptureJob => ({
  id: 'job-1', targetBootId: 'boot-1', state, requestedFrames: frames,
  actualFrames: state === 'completed' ? frames : 0,
  bytes: 0, sha256: null, outputDir: null, captureFile: null, error: null,
  createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
});

function response(data: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
}

function installBrowser(inspector: object): void {
  vi.stubGlobal('window', {
    setTimeout, clearTimeout, setInterval, clearInterval, webgpuInspector: inspector,
    __gamedraftWebgpuCaptureInitialized: true,
  });
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubGlobal('location', { href: 'http://127.0.0.1:5216/?mode=dev' });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WebGPU 真帧抓取', () => {
  it('只包住指定的两个显示帧，合成一个 .wgpuc 后上传且不触发浏览器下载', async () => {
    const order: string[] = [];
    const stream = { metadata: {}, payloads: [] };
    const inspector = {
      beginFrameCapture: vi.fn(() => order.push('begin')),
      endFrameCapture: vi.fn(() => order.push('end')),
      saveCaptureData: vi.fn(async () => stream),
      captureStreamToBlob: vi.fn(() => new Blob(['WGPUCAP test'])),
    };
    installBrowser(inspector);
    const fetchMock = vi.fn((_input: string, init: RequestInit) => {
      const url = new URL(_input, location.href);
      if (init.method === 'POST') return response({ captureReady: true });
      if (url.searchParams.get('action') === 'poll') return response(job('capturing'));
      if (url.searchParams.get('action') === 'status') return response(job('completed'));
      if (init.method === 'PUT') return response(job('completed'));
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    let hook: ((draw: () => void) => void) | null = null;
    const client = new WebGpuCaptureClient({
      bootId: 'boot-1', sceneId: () => 'dev_room', isGpuReady: () => true,
      setFrameHook: (next) => { hook = next; }, onChange: () => {},
    });

    await (client as unknown as { tick(): Promise<void> }).tick();
    expect(client.status.ready).toBe(true);
    expect(hook).toBeTypeOf('function');
    hook!(() => order.push('draw-1'));
    hook!(() => order.push('draw-2'));
    expect(order).toEqual(['begin', 'draw-1', 'end', 'begin', 'draw-2', 'end']);
    expect(hook).toBeNull();
    await vi.waitFor(() => expect(client.status.job?.state).toBe('completed'));
    expect(inspector.saveCaptureData).toHaveBeenCalledWith('job-1.wgpuc', { download: false });
    const upload = fetchMock.mock.calls.find(([, init]) => init.method === 'PUT');
    expect(upload?.[0]).toContain('actualFrames=2');
    expect(upload?.[1].body).toBeInstanceOf(Blob);
    client.dispose();
  });

  it('停止后不被旧 poll 重新激活；清空失败时拒绝下一次抓帧', async () => {
    const inspector = {
      beginFrameCapture: vi.fn(), endFrameCapture: vi.fn(),
      saveCaptureData: vi.fn(async () => { throw new Error('readback failed'); }),
      captureStreamToBlob: vi.fn(() => new Blob(['unused'])),
    };
    installBrowser(inspector);
    const fetchMock = vi.fn((_input: string, init: RequestInit) => {
      const url = new URL(_input, location.href);
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { action: string; captureReady?: boolean };
        if (body.action === 'register') return response({ captureReady: body.captureReady });
        if (body.action === 'stop') return response(job('stopped', 3));
      }
      if (url.searchParams.get('action') === 'poll') return response(job('capturing', 3));
      if (url.searchParams.get('action') === 'status') return response(job('stopped', 3));
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    let hook: ((draw: () => void) => void) | null = null;
    const client = new WebGpuCaptureClient({
      bootId: 'boot-1', sceneId: () => 'dev_room', isGpuReady: () => true,
      setFrameHook: (next) => { hook = next; }, onChange: () => {},
    });

    await (client as unknown as { tick(): Promise<void> }).tick();
    hook!(() => {});
    await client.stop();
    await vi.waitFor(() => expect(client.status.ready).toBe(false));
    await (client as unknown as { tick(): Promise<void> }).tick();
    expect(hook).toBeNull();
    expect(client.status.job?.state).toBe('stopped');
    await expect(client.request(1)).rejects.toThrow('刷新游戏页面');
    client.dispose();
  });

  it('导出期间停止旧任务并提交新任务，旧 PUT 失败不能覆盖新任务', async () => {
    let releaseSave!: (stream: { metadata: Record<string, unknown>; payloads: [] }) => void;
    const save = new Promise<{ metadata: Record<string, unknown>; payloads: [] }>((resolve) => { releaseSave = resolve; });
    const inspector = {
      beginFrameCapture: vi.fn(), endFrameCapture: vi.fn(),
      saveCaptureData: vi.fn(() => save),
      captureStreamToBlob: vi.fn(() => new Blob(['WGPUCAP test'])),
    };
    installBrowser(inspector);
    const nextJob = { ...job('pending', 1), id: 'job-2' };
    let newRequested = false;
    const fetchMock = vi.fn((_input: string, init: RequestInit) => {
      const url = new URL(_input, location.href);
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { action: string; captureReady?: boolean };
        if (body.action === 'register') return response({ captureReady: body.captureReady });
        if (body.action === 'stop') return response(job('stopped', 1));
        if (body.action === 'request') { newRequested = true; return response(nextJob); }
        throw new Error(`unexpected POST ${body.action}`);
      }
      if (init.method === 'PUT') return Promise.resolve(new Response(JSON.stringify({ error: 'stopped' }), { status: 400 }));
      if (url.searchParams.get('action') === 'poll') return response(newRequested ? { ...nextJob, state: 'capturing' } : job('capturing', 1));
      if (url.searchParams.get('action') === 'status') return response(nextJob);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    let hook: ((draw: () => void) => void) | null = null;
    const client = new WebGpuCaptureClient({
      bootId: 'boot-1', sceneId: () => 'dev_room', isGpuReady: () => true,
      setFrameHook: (next) => { hook = next; }, onChange: () => {},
    });

    await (client as unknown as { tick(): Promise<void> }).tick();
    hook!(() => {});
    await client.stop();
    await client.request(1);
    releaseSave({ metadata: {}, payloads: [] });
    await vi.waitFor(() => expect((client as unknown as { exportInFlight: boolean }).exportInFlight).toBe(false));
    expect(client.status.job?.id).toBe('job-2');
    expect(fetchMock.mock.calls.some(([, init]) => init.method === 'POST' &&
      JSON.parse(String(init.body)).action === 'fail')).toBe(false);
    client.dispose();
  });
});
