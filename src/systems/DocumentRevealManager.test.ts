import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import type { DocumentRevealDef } from '../data/types';
import { DocumentRevealManager } from './DocumentRevealManager';

/** 揭示音效：id 来自 audio_config.sfx，与叠化同起（等过 animation.delayMs），走统一动作通道。 */
function makeManager(def: Partial<DocumentRevealDef>): {
  manager: DocumentRevealManager;
  executeAwait: ReturnType<typeof vi.fn>;
  blend: ReturnType<typeof vi.fn>;
  revealedPayloads: Array<{ documentId?: string; customSfx?: boolean }>;
} {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const full: DocumentRevealDef = {
    id: 'doc',
    blurredImagePath: 'blur.png',
    clearImagePath: 'clear.png',
    revealCondition: { all: [] },
    animation: { durationMs: 100, delayMs: 0 },
    ...def,
  };
  const executeAwait = vi.fn(async () => {});
  const manager = new DocumentRevealManager(
    { loadJson: vi.fn(async () => [full]) } as any,
    eventBus,
    flagStore,
    {} as any,
    {} as any,
    { executeAwait } as any,
  );
  const blend = vi.fn(async () => {});
  manager.setBlendExecutor(blend);
  const revealedPayloads: Array<{ documentId?: string; customSfx?: boolean }> = [];
  eventBus.on('document:revealed', (p) => revealedPayloads.push(p ?? {}));
  return { manager, executeAwait, blend, revealedPayloads };
}

describe('DocumentRevealManager 揭示音效', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delayMs=0 时随叠化立即经 playSfx 播放，并带上音量覆盖', async () => {
    const { manager, executeAwait } = makeManager({
      revealSfx: 'paper_reveal',
      revealSfxVolume: 0.4,
    });
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    expect(executeAwait).toHaveBeenCalledWith({
      type: 'playSfx',
      params: { id: 'paper_reveal', volume: 0.4 },
    });
  });

  it('delayMs>0 时等过延迟才响（与叠化起始对齐），未填音量则不写 volume', async () => {
    const { manager, executeAwait } = makeManager({
      animation: { durationMs: 100, delayMs: 800 },
      revealSfx: 'paper_reveal',
    });
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    expect(executeAwait).not.toHaveBeenCalled();
    vi.advanceTimersByTime(800);
    expect(executeAwait).toHaveBeenCalledWith({
      type: 'playSfx',
      params: { id: 'paper_reveal' },
    });
  });

  it('未配置 revealSfx 则不发任何动作', async () => {
    const { manager, executeAwait } = makeManager({});
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    expect(executeAwait).not.toHaveBeenCalled();
  });

  it('销毁后已排期的音效不得再响（生命周期对称）', async () => {
    const { manager, executeAwait } = makeManager({
      animation: { durationMs: 100, delayMs: 800 },
      revealSfx: 'paper_reveal',
    });
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    manager.destroy();
    vi.advanceTimersByTime(2000);
    expect(executeAwait).not.toHaveBeenCalled();
  });

  it('读档丢弃旧时间线排期的音效', async () => {
    const { manager, executeAwait } = makeManager({
      animation: { durationMs: 100, delayMs: 800 },
      revealSfx: 'paper_reveal',
    });
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    manager.deserialize({ revealed: [] });
    vi.advanceTimersByTime(2000);
    expect(executeAwait).not.toHaveBeenCalled();
  });

  it('自带音效时事件带 customSfx，让 AudioManager 跳过全局默认揭示音（不叠响）', async () => {
    const { manager, revealedPayloads } = makeManager({ revealSfx: 'paper_reveal' });
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    expect(revealedPayloads).toEqual([{ documentId: 'doc', customSfx: true }]);
  });

  it('没自带音效时 customSfx 为假：全局默认揭示音照旧响', async () => {
    const { manager, revealedPayloads } = makeManager({});
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    expect(revealedPayloads).toEqual([{ documentId: 'doc', customSfx: false }]);
  });

  it('已揭示的文档重复触发不再重播音效', async () => {
    const { manager, executeAwait } = makeManager({ revealSfx: 'paper_reveal' });
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    await manager.checkAndReveal('doc');
    expect(executeAwait).toHaveBeenCalledTimes(1);
  });
});
