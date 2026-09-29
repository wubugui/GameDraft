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
