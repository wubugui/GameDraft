/**
 * 表面材质（落雷的灯照出的反光、落点换水花用）：
 * - 进场景把本场景的表面材质区 + 布置库的全局缺省材质一起交给场景照明（同一份不重复通知）；
 * - 落点判水面：盖着这一点的**最后一块**区说了算（水面里画一块湿地 = 挖出一块滩），与反光遮罩同一次序；
 * - 工作台推来的工作态顶替盘上那份（全局缺省材质也能单独推）；撤掉后回到盘上那份。
 */
import { describe, expect, it } from 'vitest';

import type { AssetManager } from '../../core/AssetManager';
import { EventBus } from '../../core/EventBus';
import type { GameContext, SceneData, VfxPlacementLibrary, VfxSurfaceDefaultsDef, VfxSurfaceRegionDef } from '../../data/types';
import { VfxSystem } from './VfxSystem';
import type { VfxSpace } from './vfxSpace';

const sq = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

const DISK: VfxPlacementLibrary = {
  defaultSurface: { roughness: 0.3 },
  scenes: {
    河: {
      surfaces: [
        { id: 'river', kind: 'water', polygon: sq(0, 0, 100, 100) },
        { id: 'shoal', kind: 'wet', polygon: sq(40, 40, 60, 60) },
      ],
    },
  },
};

function harness() {
  const eventBus = new EventBus();
  const calls: { regions: readonly VfxSurfaceRegionDef[]; defaults: VfxSurfaceDefaultsDef | null }[] = [];
  const assetManager = {
    dropJson: () => true,
    loadJson: async (url: string) => {
      if (url.endsWith('vfx_placements.json')) return JSON.parse(JSON.stringify(DISK));
      throw new Error(`no effect in test: ${url}`);
    },
  } as unknown as AssetManager;
  const sys = new VfxSystem({
    assetManager,
    getSceneData: () => ({ id: '河' } as unknown as SceneData),
    buildSpace: () => ({ kind: 'field' } as unknown as VfxSpace),
    getPlayerContact: () => null,
    getAppearancePhase: () => '',
    getActiveLights: () => [],
    conditionContext: () => ({}) as never,
    hasFieldGeometry: () => true,
    playSfxAt: () => {},
    log: () => {},
    onSurfacesChanged: (regions, defaults) => { calls.push({ regions, defaults }); },
  });
  sys.init({ eventBus } as unknown as GameContext);
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const ready = async () => { eventBus.emit('scene:ready'); await flush(); };
  return { sys, calls, flush, ready };
}

describe('VfxSystem 表面材质', () => {
  it('进场景：区与全局缺省材质一起交给场景照明，同一份不重复通知', async () => {
    const h = harness();
    await h.ready();
    const last = h.calls[h.calls.length - 1];
    expect(last.regions.map((r) => r.id)).toEqual(['river', 'shoal']);
    expect(last.defaults).toEqual({ roughness: 0.3 });
    const n = h.calls.length;
    h.sys.applyPreviewPlacementLibrary(null);
    await h.flush();
    expect(h.calls.length).toBe(n);
  });

  it('落点判水面：最后一块盖着它的区说了算；区外 = 地面', async () => {
    const h = harness();
    await h.ready();
    expect(h.sys.surfaceKindAt(10, 10)).toBe('water');
    expect(h.sys.surfaceKindAt(50, 50)).toBe('ground');
    expect(h.sys.surfaceKindAt(500, 500)).toBe('ground');
  });

  it('工作台只推全局缺省材质：区照旧、缺省换成推来的；撤掉回到盘上那份', async () => {
    const h = harness();
    await h.ready();
    h.sys.applyPreviewPlacementLibrary({ scenes: {}, defaultSurface: { detail: 1.6 } });
    await h.flush();
    let last = h.calls[h.calls.length - 1];
    expect(last.defaults).toEqual({ detail: 1.6 });
    expect(last.regions.map((r) => r.id)).toEqual(['river', 'shoal']);
    h.sys.applyPreviewPlacementLibrary({ scenes: {} });
    await h.flush();
    last = h.calls[h.calls.length - 1];
    expect(last.defaults).toEqual({ roughness: 0.3 });
  });
});
