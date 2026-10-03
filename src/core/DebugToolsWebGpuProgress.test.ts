import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugTools, type DebugToolsDeps } from './DebugTools';
import type { WebGpuCaptureJob, WebGpuCaptureProgress } from '../dev/webgpuCaptureClient';

class DomElement {
  textContent = ''; hidden = false; disabled = false; max = 1;
  dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  private storedValue: string | number = '';
  get value(): string | number { return this.storedValue; }
  set value(value: string | number) { this.storedValue = value; this.attributes.set('value', String(value)); }
  removeAttribute(name: string): void { this.attributes.delete(name); if (name === 'value') this.storedValue = 0; }
  replaceChildren(): void {}
  appendChild(_child: DomElement): void {}
}
type View = Record<'root' | 'status' | 'progress' | 'input' | 'directoryInput' | 'directorySave' | 'directoryStatus' |
  'single' | 'burst' | 'stop' | 'view' | 'historySelect' | 'historyOpen' | 'historyRefresh' | 'historyStatus', DomElement> & { attached: boolean };
type CaptureStatus = { ready: boolean; reason: string; job: WebGpuCaptureJob | null; framesCaptured: number; error: string; frozen: boolean; progress?: WebGpuCaptureProgress };
const createdAt = '2026-10-03T00:00:00.000Z';
const makeJob = (state: WebGpuCaptureJob['state']): WebGpuCaptureJob => ({ id: 'fixture-job', state, targetBootId: 'fixture-boot',
  requestedFrames: 5, actualFrames: 0, detailedFrameIndex: 2, bytes: 0, sha256: null, outputDir: null, captureFile: null, error: null,
  createdAt, updatedAt: '2026-10-03T00:00:03.000Z' });
function harness(job: WebGpuCaptureJob | null, progress?: WebGpuCaptureProgress) {
  const debug = new DebugTools({ renderer: { rhi: { gpuProfiler: { status: () => ({ state: 'enabled' }) } } } } as unknown as DebugToolsDeps);
  const status: CaptureStatus = { ready: true, reason: '', job, framesCaptured: 0, error: '', frozen: false, progress };
  const receiver = debug as unknown as { webgpuCapture: { status: CaptureStatus }; webgpuUiError: string; webgpuBusy: boolean; webgpuDirectory: string };
  receiver.webgpuCapture = { status }; receiver.webgpuDirectory = 'E:/capture-output';
  const names = ['root', 'status', 'progress', 'input', 'directoryInput', 'directorySave', 'directoryStatus', 'single', 'burst', 'stop',
    'view', 'historySelect', 'historyOpen', 'historyRefresh', 'historyStatus'] as const;
  const view = Object.assign(Object.fromEntries(names.map(name => [name, new DomElement()])), { attached: false }) as unknown as View;
  const paint = (): void => (DebugTools.prototype as unknown as { paintWebGpuView(view: View): void }).paintWebGpuView.call(debug, view);
  return { receiver, status, view, paint };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T00:00:12.500Z'));
  vi.stubGlobal('document', { activeElement: null, createElement: () => new DomElement() });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('actual DebugTools WebGPU capture DOM paint', () => {
  it('paints byte stage, true saved-resource frame count, elapsed time and determinate progress without claiming capture equals persistence', () => {
    const job = makeJob('uploading'); job.actualFrames = 3; job.resourceFrames = [1, 2, 3, 4];
    const h = harness(job, { phase: '写入原始字节', completed: 3 * 1048576, total: 8 * 1048576, unit: '字节', bytes: 12 * 1048576, detail: 'native raw' });
    h.status.framesCaptured = 1; h.status.frozen = true; h.paint();
    expect(h.view.status.textContent.split('\n')).toEqual([
      '本窗口：可抓帧', '游戏已冻结：等待完整读回 / 文件写盘 / 分析完成；完成或停止后恢复。', 'GPU Pass 计时：已启用',
      '任务：fixture-job · 写入中', '已采集：4 / 5 帧（不代表写盘及分析完成）', '资源读回：4 帧已落盘',
      '耗时：12.5 秒', '当前阶段：写入原始字节 · 3.0 MiB / 8.0 MiB · native raw · 12.0 MiB',
    ]);
    expect(h.view.progress.hidden).toBe(false); expect(h.view.progress.max).toBe(8 * 1048576); expect(h.view.progress.value).toBe(3 * 1048576);
    expect(h.view.progress.attributes.get('value')).toBe(String(3 * 1048576));
    expect([h.view.single.disabled, h.view.burst.disabled, h.view.stop.disabled, h.view.view.disabled, h.view.input.disabled])
      .toEqual([true, true, false, true, true]);
  });

  it.each(['pending', 'capturing', 'uploading'] as const)('%s without a known total uses indeterminate HTML progress and keeps stop usable', state => {
    const h = harness(makeJob(state), { phase: '等待 GPU', completed: 0, total: 0, unit: '' });
    h.view.progress.value = 99; h.paint(); expect(h.view.progress.attributes.has('value')).toBe(false);
    expect(h.view.progress.max).toBe(1); expect(h.view.progress.value).toBe(0); expect(h.view.progress.hidden).toBe(false);
    expect(h.view.status.textContent.split('\n').slice(-2)).toEqual(['耗时：12.5 秒', '当前阶段：等待 GPU · 进行中']);
    expect(h.view.stop.disabled).toBe(false); expect(h.view.single.disabled).toBe(true); expect(h.view.directorySave.disabled).toBe(true);
  });

  it('completed job uses terminal timestamps, exact 100% progress and enables view/new capture', () => {
    const job = makeJob('completed'); job.actualFrames = 5; job.captureFile = 'E:/capture-output/job.capture';
    const h = harness(job, { phase: '完成分析', completed: 8, total: 8, unit: '项' }); h.paint();
    expect(h.view.status.textContent.split('\n')).toEqual(['本窗口：可抓帧', 'GPU Pass 计时：已启用', '任务：fixture-job · 已完成',
      '已采集：5 / 5 帧', '资源读回：旧版仅第 2 帧', '项目外文件：E:/capture-output/job.capture', '耗时：3.0 秒', '结束阶段：完成分析 · 8 / 8 项']);
    expect([h.view.progress.max, h.view.progress.value, h.view.progress.hidden]).toEqual([1, 1, false]);
    expect([h.view.single.disabled, h.view.stop.disabled, h.view.view.disabled, h.view.input.disabled]).toEqual([false, true, false, false]);
  });

  it.each(['failed', 'stopped'] as const)('%s retains partial stage, terminal duration and honest unsaved wording', state => {
    const job = makeJob(state); job.error = state === 'failed' ? 'disk rejected' : null;
    const h = harness(job, { phase: '保存资源', completed: 7, total: 10, unit: '项' }); h.status.framesCaptured = 2; h.paint();
    expect(h.view.status.textContent.split('\n')).toEqual(['本窗口：可抓帧', 'GPU Pass 计时：已启用',
      `任务：fixture-job · ${state === 'failed' ? '失败' : '已停止'}`,
      `已采集：2 / 5 帧${state === 'stopped' ? '（本地采集未保存）' : '（不代表写盘及分析完成）'}`,
      '资源读回：每帧全部 Buffer、贴图和 RT', ...(state === 'failed' ? ['失败原因：disk rejected'] : []),
      '耗时：3.0 秒', '结束阶段：保存资源 · 7 / 10 项']);
    expect([h.view.progress.max, h.view.progress.value, h.view.stop.disabled, h.view.view.disabled]).toEqual([10, 7, true, true]);
  });

  it('idle/unready hides progress, disables capture and preserves a focused or dirty input while painting errors', () => {
    const h = harness(null); h.status.ready = false; h.status.reason = 'RHI initializing'; h.status.error = 'service offline'; h.receiver.webgpuUiError = 'operation failed';
    h.view.input.value = '17'; h.view.directoryInput.value = 'E:/unsaved'; h.view.directoryInput.dataset.dirty = '1';
    (document as unknown as { activeElement: DomElement }).activeElement = h.view.input; h.paint();
    expect(h.view.status.textContent.split('\n')).toEqual(['本窗口：尚不可抓帧（RHI initializing）', 'GPU Pass 计时：已启用',
      '服务错误：service offline', '操作失败：operation failed']);
    expect([h.view.progress.hidden, h.view.progress.max, h.view.progress.value]).toEqual([true, 1, 0]);
    expect([h.view.single.disabled, h.view.burst.disabled, h.view.stop.disabled]).toEqual([true, true, true]);
    expect(h.view.input.value).toBe('17'); expect(h.view.directoryInput.value).toBe('E:/unsaved');
    delete h.view.directoryInput.dataset.dirty; (document as unknown as { activeElement: DomElement | null }).activeElement = null; h.paint();
    expect(h.view.input.value).toBe('8'); expect(h.view.directoryInput.value).toBe('E:/capture-output');
  });
});
