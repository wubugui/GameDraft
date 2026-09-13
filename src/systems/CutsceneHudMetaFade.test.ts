import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CutsceneManager } from './CutsceneManager';
import type { NewCutsceneDef } from '../data/types';

/**
 * 过场开演事件要带上「这段过场收不收三把火/气味」（`hideMetaHud`）。
 *
 * 缺省 = 不收（2026-09-12 制作人定调）：这两样是体感读数，演出里照样亮着；而且它们的
 * 首现仪式常被编排在过场里，整层淡出等于演给空气看。HUD 只认这个载荷，不回头查过场数据。
 */

function installRafStub(): void {
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id as any);
}

/** 开演事件发在一切装载之前，故后续用桩依赖跑炸不影响本断言（吞掉即可）。 */
async function emitOnStart(def: Partial<NewCutsceneDef>): Promise<Record<string, unknown>> {
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;
  const actionExecutor = {
    executeAwait: vi.fn(async () => { /* noop */ }),
    pushActionPolicy: vi.fn(),
    popActionPolicy: vi.fn(),
  } as any;
  const mgr = new CutsceneManager(eventBus, {} as any, actionExecutor, {} as any);
  const full: NewCutsceneDef = { id: 'cs', steps: [], ...def };
  (mgr as any).cutsceneDefs.set(full.id, full);
  await mgr.startCutscene(full.id).catch(() => { /* 桩依赖收尾失败与本用例无关 */ });
  const call = eventBus.emit.mock.calls.find((c: unknown[]) => c[0] === 'cutscene:start');
  expect(call, 'cutscene:start 必须发出').toBeTruthy();
  return call[1] as Record<string, unknown>;
}

describe('cutscene:start 的 hideMetaHud 载荷', () => {
  beforeEach(installRafStub);

  it('没写 hideMetaHud → false（三把火/气味照常亮着）', async () => {
    expect(await emitOnStart({})).toMatchObject({ id: 'cs', hideMetaHud: false });
  });

  it('hideMetaHud: true → true（纯净镜头，连这一列一起收）', async () => {
    expect(await emitOnStart({ hideMetaHud: true })).toMatchObject({ hideMetaHud: true });
  });

  it('只认真 true：字符串 "true" 当没写（与 disabled 同一纪律）', async () => {
    const payload = await emitOnStart({ hideMetaHud: 'true' as unknown as boolean });
    expect(payload).toMatchObject({ hideMetaHud: false });
  });
});
