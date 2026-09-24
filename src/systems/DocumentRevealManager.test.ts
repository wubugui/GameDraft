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
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
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
  const show = vi.fn(async () => {});
  const hide = vi.fn();
  manager.setLayerPresenter({ show, blend, hide });
  const revealedPayloads: Array<{ documentId?: string; customSfx?: boolean }> = [];
  eventBus.on('document:revealed', (p) => revealedPayloads.push(p ?? {}));
  return { manager, executeAwait, blend, show, hide, revealedPayloads };
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

/**
 * 三态（2026-09-12 制作人定调）：作者只发「显示这份文档」，由管理器自己判该显示什么。
 * 关键判据是**任何一态都出图**——早期实现在"条件不满足"和"已揭示"两态都直接 return，
 * 于是第一次揭示后收掉图，再触发就永远是一片空白（真机踩到）。
 */
describe('DocumentRevealManager 三态显示', () => {
  const 不成立条件 = { flag: 'f_never', op: '==' as const, value: true };

  it('条件不满足：出揭示前的图，不揭示、不记档、不响音效、不发事件', async () => {
    const { manager, show, blend, executeAwait, revealedPayloads } = makeManager({
      revealCondition: 不成立条件,
      revealSfx: 'paper_reveal',
    });
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    expect(show).toHaveBeenCalledWith('doc', 'blur.png', 50, 50, 40, undefined);
    expect(blend).not.toHaveBeenCalled();
    expect(manager.isRevealed('doc')).toBe(false);
    expect(executeAwait).not.toHaveBeenCalled();
    expect(revealedPayloads).toEqual([]);
  });

  it('条件满足且未揭示：播揭示动画并记进存档', async () => {
    const { manager, show, blend } = makeManager({});
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    expect(blend).toHaveBeenCalledWith('doc', 'blur.png', 'clear.png', 50, 50, 40, 100, 0, undefined);
    expect(show).not.toHaveBeenCalled();
    expect(manager.isRevealed('doc')).toBe(true);
  });

  it('已揭示：瞬时出揭示后的图，不重播动画、不响音效、不发事件', async () => {
    const { manager, show, blend, executeAwait, revealedPayloads } = makeManager({
      revealSfx: 'paper_reveal',
    });
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    executeAwait.mockClear();
    revealedPayloads.length = 0;
    await manager.checkAndReveal('doc');
    expect(show).toHaveBeenCalledWith('doc', 'clear.png', 50, 50, 40, undefined);
    expect(blend).toHaveBeenCalledTimes(1);
    expect(executeAwait).not.toHaveBeenCalled();
    expect(revealedPayloads).toEqual([]);
  });

  it('收图后再触发：直接出揭示后的图（这就是真机那个"第二次啥都不显示"）', async () => {
    const { manager, show, blend, hide } = makeManager({});
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    manager.hideDocument('doc');
    expect(hide).toHaveBeenCalledWith('doc');
    await manager.checkAndReveal('doc');
    expect(show).toHaveBeenCalledWith('doc', 'clear.png', 50, 50, 40, undefined);
    expect(blend).toHaveBeenCalledTimes(1);
  });

  it('force：条件不满足也直接播揭示动画并记档', async () => {
    const { manager, show, blend } = makeManager({ revealCondition: 不成立条件 });
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc', { force: true });
    expect(blend).toHaveBeenCalledOnce();
    expect(show).not.toHaveBeenCalled();
    expect(manager.isRevealed('doc')).toBe(true);
  });

  it('force 不让已揭示的重播动画：仍是瞬时出清晰图', async () => {
    const { manager, show, blend } = makeManager({ revealCondition: 不成立条件 });
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc', { force: true });
    await manager.checkAndReveal('doc', { force: true });
    expect(blend).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith('doc', 'clear.png', 50, 50, 40, undefined);
  });

  it('同态重复触发是幂等的：只是重贴同一张，不会再叠化', async () => {
    const { manager, show, blend } = makeManager({ revealCondition: 不成立条件 });
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    await manager.checkAndReveal('doc');
    expect(show).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenNthCalledWith(2, 'doc', 'blur.png', 50, 50, 40, undefined);
    expect(blend).not.toHaveBeenCalled();
  });

  it('order 透传到显示层：作者把文书当底图用时靠它排到实体 / 特效后面', async () => {
    const { manager, show, blend } = makeManager({ order: -50, revealCondition: 不成立条件 });
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    // 条件不满足那一态：出模糊图，order 照样往下给
    expect(show).toHaveBeenCalledWith('doc', 'blur.png', 50, 50, 40, -50);
    await manager.checkAndReveal('doc', { force: true });
    // 揭示动画那一态同样要带上（两条路各有一个调用点，漏哪条都是"填了没反应"）
    expect(blend).toHaveBeenCalledWith('doc', 'blur.png', 'clear.png', 50, 50, 40, 100, 0, -50);
  });

  it('overlayId 已作废：配了也不参与寻址，显示层的键恒为 documentId', async () => {
    const { manager, blend, hide } = makeManager({ overlayId: '_img' });
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    expect(blend).toHaveBeenCalledWith('doc', 'blur.png', 'clear.png', 50, 50, 40, 100, 0, undefined);
    manager.hideDocument('doc');
    expect(hide).toHaveBeenCalledWith('doc');
  });

  it('未知 documentId：收图不抛、只告警', async () => {
    const { manager, hide } = makeManager({});
    await manager.loadDefinitions();
    manager.hideDocument('不存在');
    expect(hide).not.toHaveBeenCalled();
  });
});
