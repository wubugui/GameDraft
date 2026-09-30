import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebGpuCaptureClient, type WebGpuCaptureJob } from './webgpuCaptureClient';
import type { RhiDevice, RhiFrameDebugCapture } from '../rendering/rhi/RhiDevice';
import type { CapturedFrameDiagnostics } from './webgpuFrameDiagnostics';

const job = (state: WebGpuCaptureJob['state'], frames = 2): WebGpuCaptureJob => ({
  id: 'job-1', targetBootId: 'boot-1', state, requestedFrames: frames,
  detailedFrameIndex: 1,
  actualFrames: state === 'completed' ? frames : 0,
  bytes: 0, sha256: null, outputDir: null, captureFile: null, error: null,
  createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
});

function response(data: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
}

function installBrowser(inspector: object): void {
  vi.stubGlobal('window', {
    setTimeout, clearTimeout, setInterval, clearInterval,
    webgpuInspector: { disableRecording() {}, enableRecording() {}, ...inspector },
    __gamedraftWebgpuCaptureInitialized: true,
  });
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubGlobal('location', { href: 'http://127.0.0.1:5216/?mode=dev' });
}

function diagnosticRhi(): { rhi: RhiDevice; submit: (frame: number) => void } {
  let armed: Parameters<RhiFrameDebugCapture['captureNextSubmission']>[0] | null = null;
  const rhi = {
    native: { device: {} },
    frameDebugCapture: { captureNextSubmission(hooks: NonNullable<typeof armed>) {
      armed = hooks;
      return () => {
        if (armed === hooks) { armed = null; hooks.onAborted?.(); }
      };
    } },
    gpuProfiler: {
      status: () => ({ state: 'unsupported', reason: '测试设备无 timestamp-query' }),
      onResult: () => () => {}, setEnabled: () => {},
    },
  } as unknown as RhiDevice;
  return { rhi, submit(frame) {
    const hooks = armed;
    if (!hooks) throw new Error('本帧未安装 RHI 诊断钩子');
    armed = null;
    hooks.onPassEnd({ frame, submissionKind: 'frame', submissionLabel: 'test',
      encoder: {} as GPUCommandEncoder, texture: null, copyable: false,
      reason: '测试纹理不可回读', label: 'test pass', passOrdinal: 0,
      targetLabel: 'RT', colorIndex: 0, width: 2, height: 2, format: 'rgba8unorm' });
    hooks.onDrawInput?.({ encoder: {} as GPUCommandEncoder, passOrdinal: 0,
      bindingName: 'tex', groupSlot: 0, binding: 0, texture: null,
      textureId: null, viewId: null, contentVersion: 0, mipLevel: 0, arrayLayer: 0,
      width: 2, height: 2, format: 'rgba8unorm', reason: '测试输入不可回读' });
    hooks.onDrawBuffer?.({ encoder: {} as GPUCommandEncoder, passOrdinal: 0,
      role: 'uniform', buffer: null, bufferId: null, bufferLabel: 'Uniform',
      totalSize: 4, offset: 0, size: 4, rangeScope: 'binding', reason: '测试 Buffer 不可回读' });
    hooks.onAspectEnd?.({ frame, submissionKind: 'frame', submissionLabel: 'test',
      encoder: {} as GPUCommandEncoder, texture: null, textureId: null, viewId: null,
      label: 'test pass', passOrdinal: 0, targetLabel: 'Depth', aspect: 'depth',
      width: 2, height: 2, sourceFormat: 'depth24plus', sampleCount: 1,
      reason: '测试深度不可回读' });
    hooks.onResourceInventory?.({ textureCount: 0, bufferCount: 0, textureSubresourceCount: 0 });
    hooks.onSubmitted?.();
  } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WebGPU 真帧抓取', () => {
  it('把连续抓帧中指定的详细分析帧交给服务端，并拒绝越界帧', async () => {
    const diagnostic = diagnosticRhi();
    installBrowser({ beginFrameCapture() {}, endFrameCapture() {},
      saveCaptureData: async () => ({ metadata: {}, payloads: [] }),
      captureStreamToBlob: () => new Blob(['unused']) });
    const requests: Record<string, unknown>[] = [];
    let held = 0;
    vi.stubGlobal('fetch', vi.fn((_input: string, init: RequestInit) => {
      const url = new URL(_input, location.href);
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.action === 'register') return response({ captureReady: true });
        if (body.action === 'request') {
          requests.push(body);
          return response({ ...job('pending', 3), detailedFrameIndex: 2 });
        }
      }
      if (url.searchParams.get('action') === 'poll' || url.searchParams.get('action') === 'status') {
        return response(null);
      }
      throw new Error(`unexpected ${url}`);
    }));
    const client = new WebGpuCaptureClient({
      bootId: 'boot-1', sceneId: () => 'dev_room', isGpuReady: () => true,
      getRhi: () => diagnostic.rhi,
      suspendFrameLoop: () => { held++; return () => { held--; }; },
      advanceFrameLoop: () => {},
      setFrameHook: () => {}, onChange: () => {},
    });
    await (client as unknown as { tick(): Promise<void> }).tick();
    const request = client.request(3, 2);
    expect(held).toBe(1);
    await request;
    expect(requests).toEqual([expect.objectContaining({ frames: 3, detailedFrameIndex: 2 })]);
    await expect(client.request(3, 4)).rejects.toThrow('详细分析帧');
    client.dispose();
    expect(held).toBe(0);
  });

  it('场景就绪状态在心跳之后变化时，拒绝新抓帧且不冻结游戏', async () => {
    installBrowser({ beginFrameCapture() {}, endFrameCapture() {},
      saveCaptureData: async () => ({ metadata: {}, payloads: [] }),
      captureStreamToBlob: () => new Blob(['unused']) });
    const diagnostic = diagnosticRhi();
    let sceneReady = true;
    const suspend = vi.fn(() => () => {});
    const fetchMock = vi.fn((_input: string, init: RequestInit) => {
      const url = new URL(_input, location.href);
      if (init.method === 'POST') return response({ captureReady: true });
      if (url.searchParams.get('action') === 'poll' || url.searchParams.get('action') === 'status') return response(null);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new WebGpuCaptureClient({
      bootId: 'boot-1', sceneId: () => 'dev_room', isGpuReady: () => true,
      getRhi: () => diagnostic.rhi,
      getCaptureReadiness: () => ({ ready: sceneReady, reason: '场景加载中' }),
      suspendFrameLoop: suspend, advanceFrameLoop: () => {}, setFrameHook: () => {}, onChange: () => {},
    });
    await (client as unknown as { tick(): Promise<void> }).tick();
    expect(client.status.ready).toBe(true);
    sceneReady = false;
    await expect(client.request(1)).rejects.toThrow('场景加载中');
    expect(suspend).not.toHaveBeenCalled();
    expect(client.status.frozen).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => init.method === 'POST'
      && JSON.parse(String(init.body)).action === 'request')).toBe(false);
    client.dispose();
  });

  it('请求后场景开始切换时，拒绝领取并释放本地预冻结锁', async () => {
    installBrowser({ beginFrameCapture() {}, endFrameCapture() {},
      saveCaptureData: async () => ({ metadata: {}, payloads: [] }),
      captureStreamToBlob: () => new Blob(['unused']) });
    const diagnostic = diagnosticRhi();
    let sceneReady = true;
    let held = 0;
    let requested = false;
    let releasePoll!: (response: Response) => void;
    const poll = new Promise<Response>(resolve => { releasePoll = resolve; });
    const advance = vi.fn();
    vi.stubGlobal('fetch', vi.fn((_input: string, init: RequestInit) => {
      const url = new URL(_input, location.href);
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.action === 'register') return response({ captureReady: body.captureReady });
        if (body.action === 'request') { requested = true; return response(job('pending', 1)); }
        if (body.action === 'fail') return response(job('failed', 1));
      }
      if (url.searchParams.get('action') === 'poll') return requested ? poll : response(null);
      if (url.searchParams.get('action') === 'status') return response(null);
      throw new Error(`unexpected ${url}`);
    }));
    const client = new WebGpuCaptureClient({
      bootId: 'boot-1', sceneId: () => 'dev_room', isGpuReady: () => true,
      getRhi: () => diagnostic.rhi,
      getCaptureReadiness: () => ({ ready: sceneReady, reason: '场景加载中' }),
      suspendFrameLoop: () => { held++; return () => { held--; }; },
      advanceFrameLoop: advance, setFrameHook: () => {}, onChange: () => {},
    });
    const internal = client as unknown as { tick(): Promise<void>; tickInFlight: boolean };
    await internal.tick();
    await client.request(1);
    expect(held).toBe(1);
    sceneReady = false;
    releasePoll(await response(job('capturing', 1)));
    await vi.waitFor(() => expect(internal.tickInFlight).toBe(false));
    expect(advance).not.toHaveBeenCalled();
    expect(held).toBe(0);
    expect(client.status.frozen).toBe(false);
    expect(client.status.job?.state).toBe('failed');
    client.dispose();
  });

  it('请求响应丢失时保留心跳已领取的抓帧冻结锁', async () => {
    const diagnostic = diagnosticRhi();
    installBrowser({ beginFrameCapture() {}, endFrameCapture() {},
      saveCaptureData: async () => ({ metadata: {}, payloads: [] }),
      captureStreamToBlob: () => new Blob(['unused']) });
    let held = 0;
    let adopted = false;
    let rejectRequest!: (error: Error) => void;
    const lostResponse = new Promise<Response>((_, reject) => { rejectRequest = reject; });
    vi.stubGlobal('fetch', vi.fn((_input: string, init: RequestInit) => {
      const url = new URL(_input, location.href);
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.action === 'register') return response({ captureReady: true });
        if (body.action === 'request') { adopted = true; return lostResponse; }
        if (body.action === 'stop') return response(job('stopped', 1));
      }
      if (url.searchParams.get('action') === 'poll') return response(adopted ? job('capturing', 1) : null);
      if (url.searchParams.get('action') === 'status') return response(job('capturing', 1));
      throw new Error(`unexpected ${url}`);
    }));
    const client = new WebGpuCaptureClient({
      bootId: 'boot-1', sceneId: () => 'dev_room', isGpuReady: () => true,
      getRhi: () => diagnostic.rhi,
      suspendFrameLoop: () => { held++; return () => { held--; }; },
      advanceFrameLoop: () => {}, setFrameHook: () => {}, onChange: () => {},
    });
    const tick = () => (client as unknown as { tick(): Promise<void> }).tick();
    await tick();
    const request = client.request(1);
    const rejected = expect(request).rejects.toThrow('request response lost');
    await tick();
    expect(client.status.job?.state).toBe('capturing');
    rejectRequest(new Error('request response lost'));
    await rejected;
    expect(held).toBe(1);
    expect(client.status.frozen).toBe(true);
    await client.stop();
    expect(held).toBe(0);
    expect(client.status.frozen).toBe(false);
    client.dispose();
  });

  it('逐帧写盘确认后只推进一次，完整文件与分析完成前持续冻结游戏', async () => {
    const order: string[] = [];
    const stream = { metadata: {}, payloads: [] };
    const inspector = {
      beginFrameCapture: vi.fn(() => order.push('begin')),
      endFrameCapture: vi.fn(() => order.push('end')),
      disableRecording: vi.fn(() => order.push('pause-diagnostic')),
      enableRecording: vi.fn(() => order.push('resume-diagnostic')),
      saveCaptureData: vi.fn(async () => stream),
      captureStreamToBlob: vi.fn(() => new Blob(['WGPUCAP test'])),
    };
    installBrowser(inspector);
    const diagnostic = diagnosticRhi();
    const reports: Record<string, unknown>[] = [];
    let suspended = 0;
    let drawn = 0;
    let firstFrameStored!: (value: Response) => void;
    const firstFrameDiskWrite = new Promise<Response>((resolve) => { firstFrameStored = resolve; });
    let allFilesStored!: (value: Response) => void;
    const finalDiskWrite = new Promise<Response>((resolve) => { allFilesStored = resolve; });
    const fetchMock = vi.fn((_input: string, init: RequestInit) => {
      const url = new URL(_input, location.href);
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.action === 'diagnostics') {
          reports.push(body);
          if (body.frameIndex === 1) return firstFrameDiskWrite;
        }
        return response({ captureReady: true });
      }
      if (url.searchParams.get('action') === 'poll') return response(job('capturing'));
      if (url.searchParams.get('action') === 'status') return response(job('uploading'));
      if (init.method === 'PUT') return finalDiskWrite;
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    let hook: ((draw: () => void) => void) | null = null;
    const client = new WebGpuCaptureClient({
      bootId: 'boot-1', sceneId: () => 'dev_room', isGpuReady: () => true,
      getRhi: () => diagnostic.rhi,
      suspendFrameLoop: () => { suspended++; return () => { suspended--; }; },
      advanceFrameLoop: () => {
        expect(suspended).toBe(1);
        drawn++;
        hook!(() => { order.push(`draw-${drawn}`); diagnostic.submit(drawn); });
      },
      setFrameHook: (next) => { hook = next; }, onChange: () => {},
    });

    await (client as unknown as { tick(): Promise<void> }).tick();
    expect(client.status.ready).toBe(true);
    expect(drawn).toBe(1);
    expect(suspended).toBe(1);
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(drawn).toBe(1);
    expect(client.status.frozen).toBe(true);
    firstFrameStored(await response({}));
    await vi.waitFor(() => expect(inspector.captureStreamToBlob).toHaveBeenCalledOnce());
    expect(drawn).toBe(2);
    expect(suspended).toBe(1);
    expect(client.status.frozen).toBe(true);
    expect(order.filter(item => item === 'begin' || item === 'end' || item.startsWith('draw-')))
      .toEqual(['begin', 'draw-1', 'end', 'begin', 'draw-2', 'end']);
    expect(inspector.beginFrameCapture).toHaveBeenCalledWith({ maxBufferSize: 0, maxTextureSize: 0 });
    expect(inspector.disableRecording).toHaveBeenCalledTimes(8);
    expect(inspector.enableRecording).toHaveBeenCalledTimes(8);
    for (let index = 0; index < order.length; index++) {
      if (order[index] === 'pause-diagnostic') expect(order[index + 1]).toBe('resume-diagnostic');
    }
    expect(hook).toBeNull();
    allFilesStored(await response(job('completed')));
    await vi.waitFor(() => expect(client.status.job?.state).toBe('completed'));
    expect(reports.map(report => report.frameIndex)).toEqual([1, 2]);
    for (const report of reports) {
      expect(report.passes).toHaveLength(1);
      expect(report.inputs).toHaveLength(1);
      expect(report.aspects).toHaveLength(1);
      expect(report.buffers).toHaveLength(1);
    }
    expect(suspended).toBe(0);
    expect(client.status.frozen).toBe(false);
    expect(inspector.saveCaptureData).toHaveBeenCalledWith('job-1.wgpuc', { download: false });
    const upload = fetchMock.mock.calls.find(([, init]) => init.method === 'PUT');
    expect(upload?.[0]).toContain('actualFrames=2');
    expect(upload?.[0]).toContain('action=upload');
    expect(upload?.[1].body).toBeInstanceOf(Blob);
    client.dispose();
  });

  it('每帧的 RT、输入贴图、深度与 Buffer 原始数据使用各自 frameIndex 上传', async () => {
    installBrowser({});
    const uploads: Array<{ action: string | null; frameIndex: string | null }> = [];
    const reports: number[] = [];
    vi.stubGlobal('fetch', vi.fn((_input: string, init: RequestInit) => {
      const url = new URL(_input, location.href);
      if (init.method === 'PUT') uploads.push({
        action: url.searchParams.get('action'), frameIndex: url.searchParams.get('frameIndex'),
      });
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { action: string; frameIndex?: number };
        if (body.action === 'diagnostics') reports.push(body.frameIndex!);
      }
      return response({});
    }));
    const client = new WebGpuCaptureClient({
      bootId: 'boot-1', sceneId: () => 'dev_room', isGpuReady: () => true,
      setFrameHook: () => {}, onChange: () => {},
    });
    (client as unknown as { latestJob: WebGpuCaptureJob }).latestJob = job('capturing');
    (client as unknown as { encodeFrameImage: () => Promise<Blob> }).encodeFrameImage =
      async () => new Blob(['PNG'], { type: 'image/png' });
    const sample = (): CapturedFrameDiagnostics => ({
      passes: [{ passOrdinal: 0, label: 'Pass', targetLabel: 'RT', colorIndex: 0,
        width: 1, height: 1, format: 'rgba8unorm', rawBytesPerRow: 256,
        rawPixels: new Uint8Array(256) }],
      inputs: [{ passOrdinal: 0, bindingName: 'source', groupSlot: 0, binding: 0,
        textureId: 1, viewId: 2, contentVersion: 0, mipLevel: 0, arrayLayer: 0, width: 1,
        height: 1, format: 'rgba8unorm', rawBytesPerRow: 256,
        rawPixels: new Uint8Array(256) }],
      aspects: [{ passOrdinal: 0, label: 'Pass', targetLabel: 'Depth', aspect: 'depth',
        textureId: 3, viewId: 4, width: 1, height: 1, sourceFormat: 'depth24plus',
        rawFormat: 'r32float', sampleCount: 1, sampleIndex: null,
        rawBytesPerRow: 4, rawPixels: new Uint8Array(new Float32Array([0.5]).buffer) }],
      buffers: [{ passOrdinal: 0, role: 'uniform', bufferId: 5, bufferLabel: 'Uniform',
        totalSize: 4, offset: 0, size: 4, copiedOffset: 0, copiedSize: 4,
        rangeScope: 'binding', rawBytes: new Uint8Array([1, 2, 3, 4]) }],
      resourceInventory: { textureCount: 1, bufferCount: 1, textureSubresourceCount: 1 },
      resourceTextures: [{ textureOrdinal: 0, textureId: 6, label: 'Atlas',
        width: 1, height: 1, sourceFormat: 'rgba8unorm', rawFormat: 'rgba8unorm',
        mipLevel: 0, arrayLayer: 0, aspect: 'color', sampleCount: 1,
        captureMoment: 'frame-end', rawBytesPerRow: 256,
        rawPixels: new Uint8Array(256) }],
      resourceBuffers: [{ bufferId: 7, label: 'All bytes', totalSize: 4,
        copiedOffset: 0, copiedSize: 4, captureMoment: 'frame-end',
        rawBytes: new Uint8Array([5, 6, 7, 8]) }],
      gpuPasses: [], gpuProfilerStatus: { state: 'unsupported', reason: '测试设备' },
    });
    const exportFrame = (client as unknown as { exportDiagnostics: (
      captureJob: WebGpuCaptureJob, frameIndex: number,
      diagnostics: CapturedFrameDiagnostics) => Promise<void> }).exportDiagnostics.bind(client);
    await exportFrame(job('capturing'), 1, sample());
    await exportFrame(job('capturing'), 2, sample());
    expect(reports).toEqual([1, 2]);
    for (const frameIndex of ['1', '2']) {
      expect(uploads.filter(upload => upload.frameIndex === frameIndex).map(upload => upload.action))
        .toEqual(['pass-image', 'pass-raw', 'input-image', 'input-raw',
          'aspect-image', 'aspect-raw', 'buffer-raw',
          'resource-texture-image', 'resource-texture-raw', 'resource-buffer-raw']);
    }
    client.dispose();
  });

  it('同纹理同版本的多个 Draw 保留各自绑定记录并复用已上传的原始输入', async () => {
    installBrowser({});
    const uploads: string[] = [];
    const reports: Array<{ inputs: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal('fetch', vi.fn((_input: string, init: RequestInit) => {
      const url = new URL(_input, location.href);
      if (init.method === 'PUT') uploads.push(url.searchParams.get('action') ?? '');
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { action: string; inputs: Array<Record<string, unknown>> };
        if (body.action === 'diagnostics') reports.push(body);
      }
      return response({});
    }));
    const client = new WebGpuCaptureClient({
      bootId: 'boot-1', sceneId: () => 'dev_room', isGpuReady: () => true,
      setFrameHook: () => {}, onChange: () => {},
    });
    (client as unknown as { latestJob: WebGpuCaptureJob }).latestJob = job('capturing', 1);
    (client as unknown as { encodeFrameImage: () => Promise<Blob> }).encodeFrameImage =
      async () => new Blob(['PNG'], { type: 'image/png' });
    const sharedPixels = new Uint8Array(256);
    const input = (passOrdinal: number, bindingName: string) => ({
      passOrdinal, bindingName, groupSlot: 0, binding: 0,
      textureId: 7, viewId: 8, contentVersion: 4,
      mipLevel: 0, arrayLayer: 0, width: 1, height: 1,
      format: 'rgba8unorm', rawBytesPerRow: 256, rawPixels: sharedPixels,
    });
    const diagnostics: CapturedFrameDiagnostics = {
      passes: [], inputs: [input(0, 'first'), input(1, 'second')],
      aspects: [], buffers: [], resourceTextures: [], resourceBuffers: [],
      resourceInventory: { textureCount: 0, bufferCount: 0, textureSubresourceCount: 0 },
      gpuPasses: [], gpuProfilerStatus: { state: 'unsupported', reason: 'test' },
    };
    await (client as unknown as { exportDiagnostics(job: WebGpuCaptureJob, frame: number,
      diagnostics: CapturedFrameDiagnostics): Promise<void> }).exportDiagnostics(job('capturing', 1), 1, diagnostics);
    expect(uploads).toEqual(['input-image', 'input-raw']);
    expect(reports[0]?.inputs).toHaveLength(2);
    expect(reports[0]?.inputs[0]).toMatchObject({ inputOrdinal: 0, contentVersion: 4,
      rawBytesPerRow: 256, rawByteLength: 256 });
    expect(reports[0]?.inputs[1]).toMatchObject({ inputOrdinal: 1, contentVersion: 4,
      rawAliasInputOrdinal: 0, rawBytesPerRow: 256, rawByteLength: 256 });
    client.dispose();
  });

  it('停止后不被旧 poll 重新激活；清空失败时拒绝下一次抓帧', async () => {
    const diagnostic = diagnosticRhi();
    let suspended = 0;
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
      getRhi: () => diagnostic.rhi,
      suspendFrameLoop: () => { suspended++; return () => { suspended--; }; },
      setFrameHook: (next) => { hook = next; }, onChange: () => {},
    });

    await (client as unknown as { tick(): Promise<void> }).tick();
    hook!(() => diagnostic.submit(1));
    expect(suspended).toBe(1);
    await client.stop();
    expect(suspended).toBe(0);
    await vi.waitFor(() => expect(client.status.ready).toBe(false));
    await (client as unknown as { tick(): Promise<void> }).tick();
    expect(hook).toBeNull();
    expect(client.status.job?.state).toBe('stopped');
    await expect(client.request(1)).rejects.toThrow('刷新游戏页面');
    client.dispose();
  });

  it('等待 Inspector 清理期间停止，不会重新冻结或推进已停止任务', async () => {
    installBrowser({ beginFrameCapture() {}, endFrameCapture() {},
      saveCaptureData: async () => ({ metadata: {}, payloads: [] }),
      captureStreamToBlob: () => new Blob(['unused']) });
    const diagnostic = diagnosticRhi();
    let held = 0;
    let requested = false;
    let polls = 0;
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
    const advance = vi.fn();
    vi.stubGlobal('fetch', vi.fn((_input: string, init: RequestInit) => {
      const url = new URL(_input, location.href);
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.action === 'register') return response({ captureReady: true });
        if (body.action === 'request') { requested = true; return response(job('pending', 1)); }
        if (body.action === 'stop') return response(job('stopped', 1));
      }
      if (url.searchParams.get('action') === 'poll') { polls++; return response(requested ? job('capturing', 1) : null); }
      if (url.searchParams.get('action') === 'status') return response(null);
      throw new Error(`unexpected ${url}`);
    }));
    const client = new WebGpuCaptureClient({
      bootId: 'boot-1', sceneId: () => 'dev_room', isGpuReady: () => true,
      getRhi: () => diagnostic.rhi,
      suspendFrameLoop: () => { held++; return () => { held--; }; },
      advanceFrameLoop: advance, setFrameHook: () => {}, onChange: () => {},
    });
    const internal = client as unknown as { tick(): Promise<void>; cleanup: Promise<void>; tickInFlight: boolean };
    await internal.tick();
    internal.cleanup = cleanup;
    await client.request(1);
    await vi.waitFor(() => expect(polls).toBe(2));
    expect(held).toBe(1);
    await client.stop();
    finishCleanup();
    await vi.waitFor(() => expect(internal.tickInFlight).toBe(false));
    expect(advance).not.toHaveBeenCalled();
    expect(held).toBe(0);
    expect(client.status.frozen).toBe(false);
    expect(client.status.job?.state).toBe('stopped');
    client.dispose();
  });

  it('导出期间停止旧任务并提交新任务，旧 PUT 失败不能覆盖新任务', async () => {
    const diagnostic = diagnosticRhi();
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
      getRhi: () => diagnostic.rhi,
      setFrameHook: (next) => { hook = next; }, onChange: () => {},
    });

    await (client as unknown as { tick(): Promise<void> }).tick();
    hook!(() => diagnostic.submit(1));
    await client.stop();
    await client.request(1);
    releaseSave({ metadata: {}, payloads: [] });
    await vi.waitFor(() => expect((client as unknown as { exportInFlight: boolean }).exportInFlight).toBe(false));
    expect(client.status.job?.id).toBe('job-2');
    expect(fetchMock.mock.calls.some(([, init]) => init.method === 'POST' &&
      JSON.parse(String(init.body)).action === 'fail')).toBe(false);
    client.dispose();
  });

  it.each(['stop', 'dispose'] as const)('最终容器 PUT 等待时 %s 会中止上传并通知服务端', async (action) => {
    const diagnostic = diagnosticRhi();
    installBrowser({ beginFrameCapture() {}, endFrameCapture() {},
      saveCaptureData: async () => ({ metadata: {}, payloads: [] }),
      captureStreamToBlob: () => new Blob(['WGPUCAP test']) });
    let uploadSignal: AbortSignal | null = null;
    let held = 0;
    const stops: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn((_input: string, init: RequestInit) => {
      const url = new URL(_input, location.href);
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { action: string };
        if (body.action === 'register') return response({ captureReady: true });
        if (body.action === 'diagnostics') return response({});
        if (body.action === 'stop') { stops.push(init); return response(job('stopped', 1)); }
      }
      if (url.searchParams.get('action') === 'poll') return response(job('capturing', 1));
      if (url.searchParams.get('action') === 'status') return response(job('stopped', 1));
      if (init.method === 'PUT' && url.searchParams.get('action') === 'upload') {
        uploadSignal = init.signal ?? null;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      throw new Error(`unexpected ${url}`);
    }));
    let hook: ((draw: () => void) => void) | null = null;
    const client = new WebGpuCaptureClient({
      bootId: 'boot-1', sceneId: () => 'dev_room', isGpuReady: () => true,
      getRhi: () => diagnostic.rhi,
      suspendFrameLoop: () => { held++; return () => { held--; }; },
      setFrameHook: (next) => { hook = next; }, onChange: () => {},
    });
    await (client as unknown as { tick(): Promise<void> }).tick();
    hook!(() => diagnostic.submit(1));
    await vi.waitFor(() => expect(uploadSignal).not.toBeNull());
    expect(held).toBe(1);
    expect(client.status.frozen).toBe(true);
    if (action === 'stop') await client.stop();
    else client.dispose();
    await vi.waitFor(() => expect(uploadSignal?.aborted).toBe(true));
    expect(held).toBe(0);
    expect(client.status.frozen).toBe(false);
    await vi.waitFor(() => expect(stops).toHaveLength(1));
    if (action === 'dispose') expect(stops[0].keepalive).toBe(true);
    await vi.waitFor(() => expect((client as unknown as { exportInFlight: boolean }).exportInFlight).toBe(false));
    client.dispose();
  });
});
