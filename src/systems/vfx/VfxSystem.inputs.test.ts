import { describe, expect, it } from 'vitest';
import type { AssetManager } from '../../core/AssetManager';
import { EventBus } from '../../core/EventBus';
import type { GameContext, SceneData, VfxEffectDef } from '../../data/types';
import { VfxSystem } from './VfxSystem';
import { newEmitterProgram } from './vfxProgram';
import { createPlanarVfxSpace } from './vfxSpace';

function effect(image = '/paper.png'): VfxEffectDef {
  return { id: 'fx', emitters: [{ id: 'p', appearance: { image, sizeWu: 8 },
    spawn: { max: 4, burst: 4 }, simulation: newEmitterProgram('particle') }] };
}
async function harness(loadTexture: (url: string) => Promise<unknown> = async url => ({ width: 16, height: 16, url })) {
  const eventBus = new EventBus(), logs: string[] = [];
  const sys = new VfxSystem({
    assetManager: { loadJson: async () => ({ scenes: {} }), loadTexture, dropJson: () => true } as unknown as AssetManager,
    getSceneData: () => ({ id: 's' } as SceneData), buildSpace: createPlanarVfxSpace,
    getPlayerContact: () => null, getAppearancePhase: () => '', getActiveLights: () => [],
    conditionContext: () => ({}) as never, hasFieldGeometry: () => false, playSfxAt: () => {}, log: s => logs.push(s),
  });
  sys.init({ eventBus } as unknown as GameContext);
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  eventBus.emit('scene:ready'); await flush();
  const internal = sys as unknown as { instances: Map<string, { effect: VfxEffectDef | null; sim: unknown }>; sheets: Map<string, { texture: unknown }> };
  return { sys, logs, flush, internal };
}
describe('VFX construction and asynchronous preview inputs', () => {
  it('invalid program does not escape update, logs once, and recovers after corrected preview', async () => {
    const h = await harness(), bad = effect(); bad.emitters[0].simulation!.solver = 'plate';
    h.sys.applyPreviewEffect('fx', bad);
    const id = h.sys.playVfx({ effect: 'fx', anchor: { x: 0, y: 0 } })!;
    await h.flush();
    for (let i = 0; i < 8; i++) expect(() => h.sys.update(.5)).not.toThrow();
    expect(h.internal.instances.get(id)!.sim).toBeNull();
    expect(h.logs.filter(x => x.includes('无法创建'))).toHaveLength(1);
    h.sys.applyPreviewEffect('fx', effect()); await h.flush(); h.sys.update(1/60);
    expect(h.internal.instances.get(id)!.sim).toBeTruthy();
    h.sys.destroy();
  });
  it('late texture from an earlier edit cannot overwrite a newer effect or survive scene teardown', async () => {
    let release!: (value: unknown) => void;
    const oldTexture = new Promise(resolve => { release = resolve; });
    const h = await harness(async url => url === '/old.png' ? oldTexture : { width: 16, height: 16, url });
    h.sys.applyPreviewEffect('fx', effect('/old.png'));
    const id = h.sys.playVfx({ effect: 'fx', anchor: { x: 0, y: 0 } })!;
    await h.flush();
    h.sys.applyPreviewEffect('fx', effect('/new.png')); await h.flush();
    const latest = h.internal.instances.get(id)!.effect;
    release({ width: 16, height: 16, url: '/old.png' }); await h.flush();
    expect(h.internal.instances.get(id)!.effect).toBe(latest);
    expect(h.internal.sheets.get(`${id}/p`)!.texture).toMatchObject({ url: '/new.png' });
    h.sys.destroy(); await h.flush();
    expect(h.internal.sheets.size).toBe(0); expect(h.internal.instances.size).toBe(0);
  });
});
