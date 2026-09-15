import { describe, expect, it } from 'vitest';

import type { LightDef } from '../../data/types';
import { packLights } from '../../rendering/lighting/lightPacking';
import { defaultSceneLighting } from '../../data/sceneLightingDefault';
import type { PropPresetDef } from '../../data/propPresets';
import { HeldPropSystem, type HeldPropDeps } from './HeldPropSystem';
import { groundWorldAt, socketLightWorld, worldToQ, worldToScene, type SceneSpaceGeometry } from '../../utils/sceneSpace';

type Vec3 = [number, number, number];

const TORCH: PropPresetDef = {
  image: 'torch.png',
  light: { intensity: 2, range: 500 },
  vfx: ['flame'],
};

function harness(space: { light: Vec3 | null; vfx: Vec3 | null }) {
  const pushed: LightDef[][] = [];
  const played: { effect: string; at: Vec3 }[] = [];
  const moved: Vec3[] = [];
  const deps: HeldPropDeps = {
    getPreset: (id) => (id === 'torch' ? TORCH : undefined),
    getSocketLocalPose: () => ({ x: 10, y: -90, front: true, clearanceWu: 6, bodyWidthWu: 100 }),
    getEntityContact: () => ({ x: 400, y: 600 }),
    listSockets: () => ['right_hand'],
    sceneToLightWorld: () => space.light,
    socketToLightWorld: () => space.light,
    sceneToVfxWorld: () => space.vfx,
    windSpeedAt: () => 0,
    attachView: async () => {},
    detachView: () => {},
    setDynamicLights: (l) => { pushed.push(l); },
    setLightIntensityScales: () => {},
    playVfx: (effect, at) => { played.push({ effect, at }); return `v${played.length}`; },
    moveVfx: (_id, at) => { moved.push(at); return true; },
    stopVfx: () => {},
    softStopVfx: () => {},
    setVfxRate: () => {},
    log: () => {},
  };
  return { sys: new HeldPropSystem(deps), deps, pushed, played, moved };
}

describe('HeldPropSystem 灯位与效果共享世界锚点', () => {
  it('实体不动、只有动画挂点移动不足 1 wu，也在当前帧推送灯位', async () => {
    const space = { light: [1, 2, 3] as Vec3, vfx: null };
    const h = harness(space);
    await h.sys.attach('player', 'right_hand', 'torch');
    h.sys.update(1 / 60);
    space.light = [1.15, 2.2, 3];
    h.sys.update(1 / 60); // 未到闪烁的 20 Hz 推送周期
    expect(h.pushed).toHaveLength(2);
    expect(h.pushed[1][0].pos).toEqual(space.light);
  });
  it.each([154, 220, 880])('场景尺 %s：同参数挂件灯和场景点光打包结果完全一致', async (k) => {
    const h = harness({ light: [1, 2, 3], vfx: null });
    h.deps.getPreset = () => ({ ...TORCH, light: { intensity: 1 } });
    await h.sys.attach('player', 'right_hand', 'torch');
    h.sys.update(1 / 60);
    const lamp = h.pushed[h.pushed.length - 1][0];
    expect(lamp.intensity).toBe(1);
    const base = defaultSceneLighting();
    const actual = packLights({ ...base, lights: [lamp] }, k);
    const expected = packLights({ ...base, lights: [{ id: 'ordinary', kind: 'point', pos: [1, 2, 3], intensity: 1, enabled: true }] }, k);
    expect(actual).toEqual(expected);
    h.sys.update(1);
    expect(h.pushed).toHaveLength(1);
  });
  it('真 3D 空间：灯和效果共享 M-world 坐标', async () => {
    const h = harness({ light: [1, 2, 3], vfx: [7, 8, 9] });
    await h.sys.attach('player', 'right_hand', 'torch');
    h.sys.update(1 / 60);
    const last = h.pushed[h.pushed.length - 1] ?? [];
    expect(last).toHaveLength(1);
    expect(last[0].pos).toEqual([1, 2, 3]);
    expect(h.played[0].at).toEqual([1, 2, 3]);
    expect(h.moved[h.moved.length - 1]).toEqual([1, 2, 3]);
  });

  it('粒子退到平面近似（灯位解不出）：不发光，而不是拿画面坐标当灯位；火焰照常跟着手', async () => {
    const h = harness({ light: null, vfx: [400, 90, -600] });
    await h.sys.attach('player', 'right_hand', 'torch');
    h.sys.update(1 / 60);
    expect(h.pushed.flat()).toEqual([]);
    expect(h.played).toHaveLength(1);
    expect(h.played[0].at).toEqual([400, 90, -600]);
  });
});

describe('挂件灯在人物对应一侧之外，世界位置投影仍对准挂点', () => {
  it.each([154, 220, 880])('场景尺 %s wu/q：转身换侧、保持投影、身前灯能照向人物', (k) => {
    const c = Math.SQRT1_2;
    const geo: SceneSpaceGeometry = {
      work: { w: 8, h: 8 }, cal: { ppu: 4, cx: 4, cy: 4 },
      sceneWorld: { w: k * 2, h: k * 2 }, wuPerQUnit: k,
      basisRows: [1, 0, 0, 0, c, -c, 0, c, c],
      // 故意放横向坡度：不能在挂点下重新采地面、把手从身体拖开。
      ground: { w: 8, h: 8, data: Float32Array.from({ length: 64 }, (_, i) => (i % 8) * 0.15) },
    };
    const contact = { x: k, y: k };
    for (const front of [true, false]) {
      const pose = { x: front ? 30 : -30, y: -75, front, clearanceWu: 6, bodyWidthWu: 100 };
      const lamp = socketLightWorld(geo, contact, pose, 0.22)!;
      const projected = worldToScene(geo, lamp);
      expect(projected.x).toBeCloseTo(contact.x + pose.x, 8);
      expect(projected.y).toBeCloseTo(contact.y + pose.y, 8);
      const foot = groundWorldAt(geo, contact.x, contact.y);
      const distanceZ = ((front ? 22 : 0) + 6) * c;
      expect(lamp[2] - foot[2]).toBeCloseTo(front ? -distanceZ : distanceZ, 8);
      // 包络最厚处 ne.a=1：身体朝向该侧的法线与来光点积必须为正。
      const outerSurfaceZ = foot[2] - (front ? 22 * c : 0);
      expect((lamp[2] - outerSurfaceZ) * (front ? -1 : 1)).toBeCloseTo(6 * c, 8);
      expect(worldToQ(geo, lamp).every(Number.isFinite)).toBe(true);
    }
    const common = { x: 0, y: -75, clearanceWu: 6, bodyWidthWu: 100 };
    const front = socketLightWorld(geo, contact, { ...common, front: true }, 0.22)!;
    const back = socketLightWorld(geo, contact, { ...common, front: false }, 0.22)!;
    // 翻面高度差受人物尺寸约束，不得被场景 k 放大成数百 wu。
    expect(front[1] - back[1]).toBeCloseTo(34 * c, 8);
  });
});
