/**
 * 布置按「场景 × 时段外观」取份（2026-09-14）：
 * - 取哪份与背景换装同判据（`getAppearancePhase`），**没配就没有、不回退到基底**；
 * - 时段推进外观键变了 → 同场景按 id 差分换表（没变的实例对象原样留着，群不重飞）；
 * - 工作台推来的整份工作态库顶替盘上那份，撤销后回到盘上那份；
 * - 临时实例（手持火把的火焰）不归布置表管。
 *
 * 效果资产一律装不到（loadJson 对效果 URL 抛错）：这里只看实例表，不跑模拟。
 */
import { describe, expect, it } from 'vitest';

import type { AssetManager } from '../../core/AssetManager';
import { EventBus } from '../../core/EventBus';
import type { GameContext, SceneData, VfxPlacementLibrary } from '../../data/types';
import { VfxSystem } from './VfxSystem';
import type { VfxSpace } from './vfxSpace';

const inst = (id: string, effect = 'fx', x = 0) => ({ id, effect, anchor: { x, y: 0 } });

const DISK: VfxPlacementLibrary = {
  scenes: {
    梁: {
      base: [inst('纸钱'), inst('尘')],
      variants: { 夜: [inst('纸钱'), inst('萤火', 'fireflies')] },
    },
    只有夜: { variants: { 夜: [inst('蝠', 'bats')] } },
  },
};

function harness(opts: { library?: unknown; sceneId?: string } = {}) {
  const eventBus = new EventBus();
  const state = { phase: '', sceneId: opts.sceneId ?? '梁', libraryLoads: 0 };
  const assetManager = {
    dropJson: () => true,
    loadJson: async (url: string) => {
      if (url.endsWith('vfx_placements.json')) {
        state.libraryLoads++;
        if (opts.library instanceof Error) throw opts.library;
        return JSON.parse(JSON.stringify(opts.library ?? DISK));
      }
      throw new Error(`no effect in test: ${url}`);
    },
  } as unknown as AssetManager;
  const logs: string[] = [];
  const sys = new VfxSystem({
    assetManager,
    getSceneData: () => ({ id: state.sceneId } as unknown as SceneData),
    buildSpace: () => ({ kind: 'field' } as unknown as VfxSpace),
    getPlayerContact: () => null,
    getAppearancePhase: () => state.phase,
    getActiveLights: () => [],
    conditionContext: () => ({}) as never,
    hasFieldGeometry: () => true,
    playSfxAt: () => {},
    log: (m) => logs.push(m),
  });
  sys.init({ eventBus } as unknown as GameContext);
  const ids = () => sys.debugSnapshot().map((r) => r.id).sort();
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  const ready = async () => { eventBus.emit('scene:ready'); await flush(); };
  const phaseTo = async (p: string) => {
    state.phase = p;
    eventBus.emit('time:phaseChanged');
    sys.update(0);
    await flush();
  };
  // 读私有实例表：差分换表的判据是"同一个运行时对象留着"
  const runtimeOf = (id: string) => (sys as unknown as { instances: Map<string, unknown> }).instances.get(id);
  return { sys, state, eventBus, ids, flush, ready, phaseTo, logs, runtimeOf };
}

describe('VfxSystem 布置取份', () => {
  it('只预览梁的白天修改：另一场景与梁的夜间实例完全不动', async () => {
    const room = harness({ sceneId: '只有夜' });
    room.state.phase = '夜';
    await room.ready();
    const untouched = room.runtimeOf('蝠');
    const changes: VfxPlacementLibrary = { scenes: { 梁: { base: [inst('修改的纸钱')] } } };
    room.sys.applyPreviewPlacementLibrary(changes);
    await room.flush();
    expect(room.ids()).toEqual(['蝠']);
    expect(room.runtimeOf('蝠')).toBe(untouched);
    expect(room.sys.currentPlacement?.preview).toBe(false);
    const hill = harness();
    await hill.ready();
    hill.sys.applyPreviewPlacementLibrary(changes);
    await hill.flush();
    expect(hill.ids()).toEqual(['修改的纸钱']);
    await hill.phaseTo('夜');
    expect(hill.ids()).toEqual(['纸钱', '萤火']);
    expect(hill.sys.currentPlacement?.preview).toBe(false);
  });

  it('显式空数组只清空编辑过的份；保存清除覆盖后读取最新磁盘', async () => {
    const disk: VfxPlacementLibrary = JSON.parse(JSON.stringify(DISK));
    const h = harness({ library: disk });
    await h.ready();
    h.sys.applyPreviewPlacementLibrary({ scenes: { 梁: { base: [] } } });
    await h.flush();
    expect(h.ids()).toEqual([]);
    disk.scenes['梁'].base = [inst('保存后的纸钱')];
    h.sys.applyPreviewPlacementLibrary({ scenes: {} });
    await h.flush();
    expect(h.ids()).toEqual(['保存后的纸钱']);
    expect(h.sys.currentPlacement?.preview).toBe(false);
  });

  it('基底外观取 base，夜外观取 variants.夜', async () => {
    const h = harness();
    await h.ready();
    expect(h.ids()).toEqual(['尘', '纸钱']);
    expect(h.sys.currentPlacement).toEqual({ sceneId: '梁', phase: '', preview: false });

    const h2 = harness();
    h2.state.phase = '夜';
    await h2.ready();
    expect(h2.ids()).toEqual(['纸钱', '萤火']);
  });

  it('没配就没有：夜里没摆的场景不回退到基底，基底没摆的场景白天就是空的', async () => {
    const h = harness({ sceneId: '只有夜' });
    await h.ready();
    expect(h.ids()).toEqual([]);
    await h.phaseTo('夜');
    expect(h.ids()).toEqual(['蝠']);

    const lib: VfxPlacementLibrary = { scenes: { 梁: { base: [inst('纸钱')] } } };
    const h2 = harness({ library: lib });
    h2.state.phase = '夜';
    await h2.ready();
    expect(h2.ids()).toEqual([]);
  });

  it('时段推进：外观键变了按 id 差分换表，定义没变的实例对象原样留着', async () => {
    const h = harness();
    await h.ready();
    const keep = h.runtimeOf('纸钱');
    const drop = h.runtimeOf('尘');
    expect(keep).toBeTruthy();
    await h.phaseTo('夜');
    expect(h.ids()).toEqual(['纸钱', '萤火']);
    expect(h.runtimeOf('纸钱')).toBe(keep);
    expect(h.runtimeOf('尘')).toBeUndefined();
    expect(drop).toBeTruthy();
    expect(h.sys.currentPlacement).toEqual({ sceneId: '梁', phase: '夜', preview: false });
    // 时段变了但外观键没变（例：辰 → 午都是基底）：什么都不动
    await h.phaseTo('夜');
    expect(h.runtimeOf('纸钱')).toBe(keep);
  });

  it('定义变了的同 id 实例重建', async () => {
    const lib: VfxPlacementLibrary = {
      scenes: { 梁: { base: [inst('纸钱', 'fx', 0)], variants: { 夜: [inst('纸钱', 'fx', 50)] } } },
    };
    const h = harness({ library: lib });
    await h.ready();
    const before = h.runtimeOf('纸钱');
    await h.phaseTo('夜');
    expect(h.ids()).toEqual(['纸钱']);
    expect(h.runtimeOf('纸钱')).not.toBe(before);
  });

  it('工作台整份工作态库顶替盘上那份；撤销回到盘上那份；布置库只装一次', async () => {
    const h = harness();
    await h.ready();
    const keep = h.runtimeOf('纸钱');
    const working: VfxPlacementLibrary = JSON.parse(JSON.stringify(DISK));
    working.scenes['梁'].base = [inst('纸钱'), inst('新摆的')];
    h.sys.applyPreviewPlacementLibrary(working);
    await h.flush();
    expect(h.ids()).toEqual(['新摆的', '纸钱']);
    expect(h.runtimeOf('纸钱')).toBe(keep);
    expect(h.sys.currentPlacement?.preview).toBe(true);
    // 工作态库里夜那份也生效（整份顶替，不是只顶当前那份）
    working.scenes['梁'].variants = { 夜: [inst('只在工作态里')] };
    h.sys.applyPreviewPlacementLibrary(JSON.parse(JSON.stringify(working)));
    await h.phaseTo('夜');
    expect(h.ids()).toEqual(['只在工作态里']);
    h.sys.applyPreviewPlacementLibrary(null);
    await h.flush();
    expect(h.ids()).toEqual(['纸钱', '萤火']);
    expect(h.sys.currentPlacement?.preview).toBe(false);
    expect(h.state.libraryLoads).toBe(2);
  });

  it('临时实例不归布置表管：换表时留着', async () => {
    const h = harness();
    await h.ready();
    const tid = h.sys.playVfx({ effect: 'torch', anchor: { x: 1, y: 2 } });
    expect(tid).toBeTruthy();
    await h.phaseTo('夜');
    expect(h.ids()).toContain(tid!);
    expect(h.ids()).toContain('萤火');
  });

  it('布置库装不到 = 没有任何布置，场景照常进、log 一句', async () => {
    const h = harness({ library: new Error('404') });
    await h.ready();
    expect(h.ids()).toEqual([]);
    expect(h.logs.some((m) => m.includes('vfx_placements.json'))).toBe(true);
    const h2 = harness({ library: { nope: true } });
    await h2.ready();
    expect(h2.ids()).toEqual([]);
    expect(h2.logs.some((m) => m.includes('scenes'))).toBe(true);
  });
});
