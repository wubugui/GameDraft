import { afterEach, expect, it, vi } from 'vitest';
import { WorkerManager } from './WorkerManager';

const postedUrls: string[] = [];

class ReplyingWorker {
  private onMessage?: (event: MessageEvent) => void;

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.onMessage = listener;
  }

  postMessage(message: { data: [string]; uuid: number }): void {
    postedUrls.push(message.data[0]);
    queueMicrotask(() => this.onMessage?.({
      target: this,
      data: { uuid: message.uuid, data: { width: 1, height: 1 } },
    } as unknown as MessageEvent));
  }

  terminate(): void {}
}

afterEach(() => {
  WorkerManager.reset();
  postedUrls.length = 0;
  vi.unstubAllGlobals();
});

it('gives Blob workers absolute asset URLs under the packaged game protocol', async () => {
  vi.stubGlobal('location', { href: 'gamedraft://game/index.html' });
  vi.stubGlobal('navigator', { hardwareConcurrency: 1 });
  vi.stubGlobal('Worker', ReplyingWorker);

  await WorkerManager.loadImageBitmap('/resources/runtime/images/backgrounds/menu_wujin_dock.png');
  await WorkerManager.loadImageBitmap('https://cdn.example.test/portrait.png');

  expect(postedUrls).toEqual([
    'gamedraft://game/resources/runtime/images/backgrounds/menu_wujin_dock.png',
    'https://cdn.example.test/portrait.png',
  ]);
});

it('取消busy worker会释放队列槽，reset拒绝busy和queued请求并终止全部worker', async () => {
  const workers: Array<{ terminated: boolean }> = [];
  class HangingWorker {
    terminated = false;
    constructor() { workers.push(this); }
    addEventListener(): void {}
    postMessage(): void {}
    terminate(): void { this.terminated = true; }
  }
  vi.stubGlobal('navigator', { hardwareConcurrency: 1 });
  vi.stubGlobal('Worker', HangingWorker);
  const cancel = new AbortController();
  const first = WorkerManager.loadImageBitmap('https://example.test/first.png', undefined, cancel.signal);
  const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const second = WorkerManager.loadImageBitmap('https://example.test/second.png');
  const third = WorkerManager.loadImageBitmap('https://example.test/third.png');
  const rest = Promise.allSettled([second, third]);
  await Promise.resolve(); await Promise.resolve();
  expect(workers).toHaveLength(1);
  cancel.abort();
  await firstRejected;
  expect(workers).toHaveLength(2);
  expect(workers[0].terminated).toBe(true);
  WorkerManager.reset();
  expect((await rest).every(result => result.status === 'rejected')).toBe(true);
  expect(workers.every(worker => worker.terminated)).toBe(true);
});
