import { describe, expect, it } from 'vitest';

import type { ActionDef } from '../../data/types';
import { parsePropPresets } from '../../data/propPresets';
import { HeldPropSystem, type HeldPropDeps } from './HeldPropSystem';

/**
 * master 0faee8d：`setStateAwait(..., onlyIfBurning)`——"风把火吹灭"只动此刻燃着（点着 / 护火 / 残炭）的挂件；
 * 没燃着 / 挂点上没挂件 ⇒ 什么都不做、当成功（不报"没切到"）。缺省 false = 原行为。
 * engine2d 分支对 HeldPropSystem 没有语义改动，这里守的是逻辑本身。
 */
type Vec3 = [number, number, number];

const table = parsePropPresets({
  t: {
    image: 'stick.png',
    light: { intensity: 1 },
    states: {
      lit: { onEnterActions: [{ type: 'playSfx', params: { id: 'ignite' } }] },
      guarding: { windShelter: 0.8 },
      ember: {},
      out: { light: null, onEnterActions: [{ type: 'playSfx', params: { id: 'puff' } }] },
    },
  },
});

function harness() {
  const ran: ActionDef[][] = [];
  const deps: HeldPropDeps = {
    getPropPointLocalPose: () => ({ x: 12, y: -130, front: true, clearanceWu: 6, bodyWidthWu: 100 }),
    windVectorAt: () => [0, 0, 0],
    setFireHint: () => {},
    onHeldChanged: () => {},
    worldToScene: (w) => ({ x: w[0], y: -w[1] + w[2] * Math.SQRT1_2 }),
    setFlameView: () => {},
    setVfxSizeScale: () => {},
    setVfxWindScale: () => {},
    setVfxDistanceScale: () => {},
    runStateActions: async (actions) => { ran.push(actions); },
    readPlayerPropInput: () => null,
    getPreset: (id) => table[id],
    getSocketLocalPose: () => ({ x: 10, y: -90, front: true, clearanceWu: 6, bodyWidthWu: 100 }),
    getEntityContact: () => ({ x: 400, y: 600 }),
    listSockets: () => ['right_hand'],
    sceneToLightWorld: () => [0, 100, 0] as Vec3,
    socketToLightWorld: () => [0, 100, 0] as Vec3,
    sceneToVfxWorld: () => [0, 100, 0] as Vec3,
    windSpeedAt: () => 0,
    attachView: async () => {},
    detachView: () => {},
    setDynamicLights: () => {},
    setLightIntensityScales: () => {},
    playVfx: () => 'v',
    moveVfx: () => true,
    stopVfx: () => {},
    softStopVfx: () => {},
    setVfxRate: () => {},
    log: () => {},
  };
  const sys = new HeldPropSystem(deps);
  const state = () => sys.debugSnapshot()[0]?.state;
  return { sys, ran, state };
}

describe('setStateAwait onlyIfBurning（风吹灭火）', () => {
  it('燃着（点着）：照常切到灭，进入动作照跑', async () => {
    const h = harness();
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    h.sys.update(1 / 60);
    expect(await h.sys.setStateAwait('player', 'right_hand', 'out', 0, true)).toBe(true);
    expect(h.state()).toBe('out');
    expect(h.ran.flat().some((a) => a.params.id === 'puff')).toBe(true);
  });

  it('残炭也算燃着：照常切', async () => {
    const h = harness();
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    h.sys.update(1 / 60);
    await h.sys.setStateAwait('player', 'right_hand', 'ember');
    h.sys.update(1 / 60);
    expect(await h.sys.setStateAwait('player', 'right_hand', 'out', 0, true)).toBe(true);
    expect(h.state()).toBe('out');
  });

  it('没燃着（灭着）：什么都不做、当成功——状态不变、进入动作不跑', async () => {
    const h = harness();
    await h.sys.attach('player', 'right_hand', 't', 'out');
    h.sys.update(1 / 60);
    const before = h.ran.length;
    expect(await h.sys.setStateAwait('player', 'right_hand', 'ember', 0, true)).toBe(true);
    expect(h.state()).toBe('out');
    expect(h.ran.length).toBe(before);
    // 不带 onlyIfBurning：原行为，照切
    expect(await h.sys.setStateAwait('player', 'right_hand', 'ember')).toBe(true);
    expect(h.state()).toBe('ember');
  });

  it('挂点上没挂件：onlyIfBurning ⇒ true（不报警）；不带 ⇒ false（原行为）', async () => {
    const h = harness();
    expect(await h.sys.setStateAwait('player', 'right_hand', 'out', 0, true)).toBe(true);
    expect(await h.sys.setStateAwait('player', 'right_hand', 'out')).toBe(false);
  });
});
