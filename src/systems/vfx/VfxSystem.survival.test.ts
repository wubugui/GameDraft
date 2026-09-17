import { describe, expect, it } from 'vitest';
import { EventBus } from '../../core/EventBus';
import type { AssetManager } from '../../core/AssetManager';
import type { GameContext, SceneData, VfxEffectDef } from '../../data/types';
import { VfxSystem } from './VfxSystem';
import { createPlanarVfxSpace } from './vfxSpace';
import type { VfxInstanceSim } from './vfxSim';
import batAsset from '../../../public/assets/data/vfx/bat_cliff.json';
import paperAsset from '../../../public/assets/data/vfx/paper_money_pass.json';

const flight: VfxEffectDef = { id: 'flight', emitters: [{
  id: 'paper', appearance: { image: '/paper.png', sizeWu: 10 },
  spawn: { max: 12, burst: 12, shape: { kind: 'sphere', radius: 10 }, speed: [20, 40] },
  life: { seconds: [3, 5] },
}] };

async function harness(effect: VfxEffectDef, count = 1) {
  const eventBus = new EventBus();
  const sys = new VfxSystem({
    assetManager: { loadJson: async (url: string) => url.endsWith('vfx_placements.json')
      ? { scenes: { scene: { base: Array.from({ length: count }, (_, i) => ({ id: `placed${i}`, effect: effect.id, anchor: { x: 0, y: 0 }, seed: 119 })) } } }
      : effect, loadTexture: async () => { throw Error('No renderer needed'); } } as unknown as AssetManager,
    getSceneData: () => ({ id: 'scene' }) as SceneData,
    buildSpace: () => createPlanarVfxSpace(), getPlayerContact: () => ({ x: 0, y: 0 }),
    getAppearancePhase: () => '', getActiveLights: () => [], conditionContext: () => ({}) as never,
    hasFieldGeometry: () => false, playSfxAt: () => {}, log: () => {},
  });
  sys.init({ eventBus } as GameContext);
  eventBus.emit('scene:ready');
  for (let i = 0; i < 24; i++) await Promise.resolve();
  sys.update(0);
  const sim = (i = 0) => (sys as unknown as { instances: Map<string, { sim: VfxInstanceSim }> }).instances.get(`placed${i}`)!.sim;
  expect(sim()).toBeTruthy();
  return { sys, sim, eventBus };
}

describe('群体侵扰与确定性重播', () => {
  it('正式纸钱演出晚些重播，逐帧位置与粒龄仍与第一次完全相同', async () => {
    const h = await harness(paperAsset as unknown as VfxEffectDef);
    const run = () => {
      const frames: number[][] = [];
      for (let i = 0; i < 90; i++) {
        h.sys.update(1 / 60);
        const p = h.sim().emitters[0].p;
        frames.push([...p.x, ...p.y, ...p.z, ...p.age]);
      }
      return frames;
    };
    const first = run();
    h.sys.update(10);
    h.sys.playVfx({ instanceId: 'placed0', restart: true });
    h.sys.update(0);
    expect(run()).toEqual(first);
    h.sys.destroy();
  });
  it('一次真实近身就按整群速率扣，粒子数和重复布置不放大；惊飞、远离、停播立即不伤', async () => {
    const bat = structuredClone(batAsset) as unknown as VfxEffectDef;
    const def = bat.emitters.find(e => e.behavior)!;
    def.behavior!.harassment = { radius: 30, height: 90, attackPerSecond: 5 };
    const h = await harness(bat, 2);
    for (let i = 0; i < 2; i++) {
      const e = h.sim(i).emitters.find(e => e.flock)!;
      e.flock!.state = 'airborne';
      for (let k = 0; k < e.p.cap; k++) { e.p.alive[k] = 1; e.p.x[k] = 0; e.p.y[k] = 90; e.p.z[k] = 0; }
    }
    expect(h.sys.playerHarassment()).toEqual([{ sourceId: `vfx:${bat.id}:${def.id}`, attackPerSecond: 5 }]);
    for (let i = 0; i < 2; i++) h.sim(i).setFlockState('fleeing');
    expect(h.sys.playerHarassment()).toEqual([]);
    for (let i = 0; i < 2; i++) {
      const sim = h.sim(i); sim.setFlockState('airborne');
      sim.emitters[0].p.y.fill(500);
    }
    expect(h.sys.playerHarassment()).toEqual([]);
    h.sys.stopVfx('placed0'); h.sys.stopVfx('placed1');
    expect(h.sys.playerHarassment()).toEqual([]);
    h.sys.destroy();
  });

  it('restart 重建固定种子，重播逐粒坐标相同；换场清空侵扰', async () => {
    const h = await harness(flight);
    const sample = () => {
      for (let i = 0; i < 30; i++) h.sys.update(1 / 60);
      const p = h.sim().emitters[0].p;
      return [...p.x, ...p.y, ...p.z, ...p.life];
    };
    const first = sample();
    h.sys.playVfx({ instanceId: 'placed0', restart: true });
    h.sys.update(0);
    expect(sample()).toEqual(first);
    h.eventBus.emit('scene:beforeUnload');
    expect(h.sys.playerHarassment()).toEqual([]);
    h.sys.destroy();
  });
});
