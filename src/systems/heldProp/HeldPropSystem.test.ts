import { describe, expect, it } from 'vitest';

import type { ActionDef, LightDef } from '../../data/types';
import { packLights } from '../../rendering/lighting/lightPacking';
import { defaultSceneLighting } from '../../data/sceneLightingDefault';
import { parsePropPresets, type PropEffectDef, type PropFlickerDef, type PropPresetDef } from '../../data/propPresets';
import {
  HeldPropSystem,
  MAX_TRANSITIONS_PER_FRAME,
  pickHintAngle,
  type HeldFlameViewParams,
  type HeldFireHint,
  type HeldPropDeps,
} from './HeldPropSystem';
import { BURN_SIZE_EXPONENT, PhysicalFlicker, burnSizeScale } from './heldPropSignal';
import {
  FLAME_HEIGHT_TAU_S,
  FLAME_MAX_TILT_RAD,
  FLAME_TELEPORT_WU_PER_S,
  FLAME_WU_PER_M,
  flameBillboardPose,
  flameFrameIndex,
  flameTiltAngle,
  relativeHorizontalAirflow,
  screenRightHorizontal,
  smoothAirflow,
  smoothScalar,
} from './heldPropFlame';
import { groundWorldAt, socketLightWorld, worldToQ, worldToScene, type SceneSpaceGeometry } from '../../utils/sceneSpace';

type Vec3 = [number, number, number];

const TORCH: PropPresetDef = {
  image: 'torch.png',
  light: { intensity: 2, range: 500 },
  particles: [{ effect: 'flame', point: null }],
};

function harness(space: { light: Vec3 | null; vfx: Vec3 | null }) {
  const pushed: LightDef[][] = [];
  const played: { effect: string; at: Vec3; host?: { targetId: string; socket: string }; oneShot?: boolean }[] = [];
  const moved: Vec3[] = [];
  /** 效果实例 id → 最近一次推的三个倍率 */
  const scales = new Map<string, { rate?: number; size?: number; wind?: number; distance?: number }>();
  const scaleOf = (id: string) => { let v = scales.get(id); if (!v) { v = {}; scales.set(id, v); } return v; };
  const flames: (HeldFlameViewParams | null)[] = [];
  const hints: (HeldFireHint | null)[] = [];
  const changed = { n: 0 };
  const ran: ActionDef[][] = [];
  const pointQueries: [number, number][] = [];
  const socketQueries: string[] = [];
  /** 玩家按键（测试直接改这个对象；null = 不受理输入） */
  let input: { togglePressed: boolean; guardHeld: boolean } | null = { togglePressed: false, guardHeld: false };
  const deps: HeldPropDeps = {
    getPropPointLocalPose: (_t, _s, point) => {
      pointQueries.push(point);
      return { x: 12, y: -130, front: true, clearanceWu: 6, bodyWidthWu: 100 };
    },
    windVectorAt: () => [0, 0, 0],
    setFireHint: (h) => { hints.push(h); },
    onHeldChanged: () => { changed.n++; },
    // 测试用的"画面"：x 就是世界 x，y 是负的世界 y 加上 45° 俯视吃进来的 z
    worldToScene: (w) => ({ x: w[0], y: -w[1] + w[2] * Math.SQRT1_2 }),
    setFlameView: (_t, _s, p) => { flames.push(p); },
    setVfxSizeScale: (id, k) => { scaleOf(id).size = k; },
    setVfxWindScale: (id, k) => { scaleOf(id).wind = k; },
    setVfxDistanceScale: (id, k) => { scaleOf(id).distance = k; },
    runStateActions: async (actions) => { ran.push(actions); },
    readPlayerPropInput: () => input,
    getPreset: (id) => (id === 'torch' ? TORCH : undefined),
    getSocketLocalPose: (_t, socket) => {
      socketQueries.push(socket);
      return { x: 10, y: -90, front: true, clearanceWu: 6, bodyWidthWu: 100 };
    },
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
    playVfx: (effect, at, host, oneShot) => { played.push({ effect, at, host, oneShot }); return `v${played.length}`; },
    moveVfx: (_id, at) => { moved.push(at); return true; },
    stopVfx: () => {},
    softStopVfx: () => {},
    setVfxRate: (id, k) => { scaleOf(id).rate = k; },
    log: () => {},
  };
  const setInput = (v: typeof input) => { input = v; };
  return { sys: new HeldPropSystem(deps), deps, pushed, played, moved, scales, flames, ran, pointQueries, socketQueries, setInput, hints, changed };
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

describe('燃烧物：起火点、燃烧强度 → 粒子倍率、护火、进入动作', () => {
  const table = parsePropPresets({
    fire: {
      image: 'stick.png',
      firePoint: [0.5, 0.05],
      light: { intensity: 1, flicker: { amp: 0.2, hz: 7 } },
      particles: [{ effect: 'torch_flame' }],
      states: {
        lit: { burn: 1, onEnterActions: [{ type: 'playSfx', params: { id: 'ignite' } }] },
        guarding: { burn: 0.75, windShelter: 0.8 },
        out: { burn: 0, light: null, onEnterActions: [{ type: 'playSfx', params: { id: 'puff' } }] },
        loopA: { onEnterActions: [{ type: 'setPropState', params: { state: 'loopB' } }] },
        loopB: { onEnterActions: [{ type: 'setPropState', params: { state: 'loopA' } }] },
      },
    },
    lamp: { image: 'lantern.png', light: { intensity: 0.15 }, states: { lit: {} } },
  });
  const withTable = (h: ReturnType<typeof harness>) => { h.deps.getPreset = (id) => table[id]; return h; };
  const last = (h: ReturnType<typeof harness>) => h.scales.get(`v${h.played.length}`)!;

  it('燃烧强度 → 新生粒子大小：Heskestad 2/5 次方；0 ⇒ 0；越界夹到 1', () => {
    expect(BURN_SIZE_EXPONENT).toBe(0.4);
    expect(burnSizeScale(0.75)).toBeCloseTo(Math.pow(0.75, 0.4), 12);
    expect(burnSizeScale(0)).toBe(0);
    expect(burnSizeScale(-1)).toBe(0);
    expect(burnSizeScale(3)).toBe(1);
  });

  it('有起火点：灯位与粒子锚点都从起火点求；没有起火点也没有粒子（灯笼）：仍从挂点本身求，一个粒子倍率都不推', async () => {
    const h = withTable(harness({ light: [1, 2, 3], vfx: [1, 2, 3] }));
    await h.sys.attach('player', 'right_hand', 'fire');
    h.sys.update(1 / 60);
    expect(h.pointQueries[0]).toEqual([0.5, 0.05]);
    expect(h.socketQueries).toEqual([]);

    const l = withTable(harness({ light: [1, 2, 3], vfx: [1, 2, 3] }));
    await l.sys.attach('player', 'right_hand', 'lamp');
    l.sys.update(1 / 60);
    expect(l.pointQueries).toEqual([]);
    expect(l.socketQueries).toEqual(['right_hand']);
    expect(l.scales.size).toBe(0);
  });

  it('灯显式点了挂点（light.socket）就用那个挂点，压过起火点', async () => {
    const h = withTable(harness({ light: [1, 2, 3], vfx: null }));
    h.deps.getPreset = () => ({ ...table.fire, light: { intensity: 1, socket: 'torch_tip' } });
    await h.sys.attach('player', 'right_hand', 'fire');
    h.sys.update(1 / 60);
    expect(h.socketQueries).toContain('torch_tip');
    expect(h.pointQueries).toEqual([]);
  });

  it('粒子实例一开出来就套上倍率（不等下一帧）：发射率 = 燃烧强度、大小 = 燃烧强度^0.4、吃风 = 1 − 挡风', async () => {
    const h = withTable(harness({ light: [1, 2, 3], vfx: [1, 2, 3] }));
    await h.sys.attach('player', 'right_hand', 'fire', 'guarding');
    const first = last(h);
    expect(first.size).toBeCloseTo(Math.pow(0.75, 0.4), 12);
    expect(first.wind).toBeCloseTo(0.2, 12);
    expect(first.rate).toBe(0.75);
    h.sys.update(1 / 60);
    const s1 = last(h);
    expect(s1.wind).toBeCloseTo(0.2, 12);
    expect(s1.rate).toBe(0.75);
  });

  it('闪烁不进发射率（风里幅度大时发射量涨落会让举着走的火舌断成珠子），只让新生大小一胀一缩：大小 = 燃烧强度^0.4 × L^0.4 低通', async () => {
    const h = withTable(harness({ light: [1, 2, 3], vfx: [1, 2, 3] }));
    h.deps.windSpeedAt = () => 600;
    h.deps.getPreset = () => ({ ...table.fire, light: { intensity: 1, flicker: { amp: 0.2, hz: 7, windAmp: 0.8 } } });
    await h.sys.attach('player', 'right_hand', 'fire', 'lit');
    const rates = new Set<number>();
    const sizes: number[] = [];
    const lamps: number[] = [];
    for (let i = 0; i < 120; i++) {
      h.sys.update(1 / 60);
      rates.add(last(h).rate!);
      sizes.push(last(h).size!);
      const push = h.pushed[h.pushed.length - 1];
      if (push?.[0]) lamps.push(push[0].intensity);
    }
    expect([...rates]).toEqual([1]);
    const lo = Math.min(...sizes), hi = Math.max(...sizes);
    const llo = Math.min(...lamps), lhi = Math.max(...lamps);
    // 灯确实在大幅闪；大小的涨落 ≤ 灯强度涨落的 2/5 次方（低通只会更小）
    expect(lhi / llo).toBeGreaterThan(1.5);
    expect(hi / lo).toBeGreaterThan(1.05);
    expect(hi / lo).toBeLessThanOrEqual(Math.pow(lhi / llo, 0.4) * 1.3);
  });

  it('在飞的粒子带"锚点相对宿主的位移"（转身 / 换姿势 / 换帧），不带宿主平移（走路留拖尾）', async () => {
    const h = withTable(harness({ light: [1, 2, 3], vfx: [1, 2, 3] }));
    const carries: (Vec3 | null)[] = [];
    h.deps.moveVfx = (_id, _at, carry) => { carries.push(carry); return true; };
    let hostX = 0;
    let rel = 40;
    h.deps.getEntityContact = () => ({ x: hostX, y: 600 });
    // 宿主接地点的世界位置 = 画面 x；锚点 = 宿主 + 相对偏移
    h.deps.sceneToLightWorld = (x) => [x, 0, 0];
    h.deps.getPropPointLocalPose = () => ({ x: rel, y: -130, front: rel > 0, clearanceWu: 6, bodyWidthWu: 100 });
    h.deps.socketToLightWorld = (c, pose) => [c.x + pose.x, 130, 0];
    await h.sys.attach('player', 'right_hand', 'fire', 'lit');
    h.sys.update(1 / 60);              // 第一次挪：没有上一帧 ⇒ 不带
    hostX = 5; h.sys.update(1 / 60);   // 只有人在走 ⇒ 不带
    rel = -40; h.sys.update(1 / 60);   // 转身：相对偏移 +40 → −40 ⇒ 带 −80
    hostX = 8; rel = -31; h.sys.update(1 / 60);   // 边走边换帧：锚点 +12，其中人走 +3 ⇒ 带 +9
    h.sys.update(1 / 60);              // 都没动 ⇒ 不带
    expect(carries).toEqual([null, null, [-80, 0, 0], [9, 0, 0], null]);
  });

  it('切到灭：燃烧强度随 fadeMs 连续降，发射率与新生大小一路连续降到 0（在飞的粒子自己烧完，不是一下清空）', async () => {
    const h = withTable(harness({ light: [1, 2, 3], vfx: [1, 2, 3] }));
    h.deps.getPreset = () => ({ ...table.fire, states: { ...table.fire.states, out: { burn: 0, light: null, particles: [{ effect: 'torch_flame', point: null }] } } });
    await h.sys.attach('player', 'right_hand', 'fire', 'lit');
    h.sys.setState('player', 'right_hand', 'out', 1000);
    const rates: number[] = [];
    const sizes: number[] = [];
    for (let i = 0; i < 70; i++) { h.sys.update(1 / 60); rates.push(last(h).rate!); sizes.push(last(h).size!); }
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeLessThanOrEqual(rates[i - 1] + 1e-12);
    expect(rates[29]).toBeCloseTo(0.5, 1);
    // 大小 = 燃烧强度^0.4 × 热（闪烁 ±20% 的 0.4 次方以内）
    for (let i = 0; i < sizes.length; i++) {
      expect(sizes[i]).toBeLessThanOrEqual(Math.pow(rates[i], 0.4) * Math.pow(1.25, 0.4) + 1e-12);
      expect(sizes[i]).toBeGreaterThanOrEqual(Math.pow(rates[i], 0.4) * Math.pow(0.75, 0.4) - 1e-12);
    }
    expect(last(h).rate).toBe(0);
    expect(last(h).size).toBe(0);
  });

  it('护火只动粒子吃风，不动灯：挡风 0.8 与挡风 0 推出去的灯逐位相同', async () => {
    const lights = async (shelter: number) => {
      const h = withTable(harness({ light: [0, 100, 0], vfx: [0, 100, 0] }));
      h.deps.windSpeedAt = () => 300;
      h.deps.getPreset = () => ({ ...table.fire, windShelter: shelter });
      await h.sys.attach('player', 'right_hand', 'fire', 'lit');
      for (let i = 0; i < 40; i++) h.sys.update(1 / 60);
      return { lights: h.pushed, wind: last(h).wind };
    };
    const open = await lights(0);
    const guard = await lights(0.8);
    expect(guard.lights).toEqual(open.lights);
    expect(open.wind).toBe(1);
    expect(guard.wind).toBeCloseTo(0.2, 12);
  });

  it('物理闪烁：灯读火把处的相对气流（同一股风）——大风里暗、护火挡风亮回来；正弦闪烁的灯不受挡风影响', async () => {
    const pushedMean = async (flicker: PropFlickerDef, shelter: number) => {
      const h = withTable(harness({ light: [0, 100, 0], vfx: [0, 100, 0] }));
      h.deps.windSpeedAt = () => 880;
      h.deps.windVectorAt = () => [880, 0, 0];            // 10 m/s 横风
      h.deps.getPreset = () => ({ ...table.fire, windShelter: shelter, light: { intensity: 1, flicker } });
      await h.sys.attach('player', 'right_hand', 'fire', 'lit');
      for (let i = 0; i < 120; i++) h.sys.update(1 / 60);
      const xs = h.pushed.slice(-20).map((l) => l[0]?.intensity ?? 0);
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    const physOpen = await pushedMean({ kind: 'flame', diameter: 0.1 }, 0);
    const physGuard = await pushedMean({ kind: 'flame', diameter: 0.1 }, 0.8);
    expect(physOpen).toBeGreaterThan(0.58);
    expect(physOpen).toBeLessThan(0.66);
    expect(physGuard).toBeGreaterThan(physOpen + 0.15);
    const sineOpen = await pushedMean({ amp: 0.2, hz: 7, windAmp: 0.8 }, 0);
    const sineGuard = await pushedMean({ amp: 0.2, hz: 7, windAmp: 0.8 }, 0.8);
    expect(sineGuard).toBe(sineOpen);
  });

  it('物理闪烁走路时（位置在动、每帧都推）推的是按推送率低通过的亮度，不是逐帧的湍流原值', async () => {
    const space = { light: [0, 100, 0] as Vec3, vfx: [0, 100, 0] as Vec3 };
    const h = withTable(harness(space));
    h.deps.windVectorAt = () => [880, 0, 0];
    h.deps.getPreset = () => ({ ...table.fire, light: { intensity: 1, flicker: { kind: 'flame', diameter: 0.1 } } });
    await h.sys.attach('player', 'right_hand', 'fire', 'lit');
    const pushedL: number[] = [];
    for (let i = 0; i < 600; i++) {
      space.light = [space.light[0] + 3, 100, 0];     // 每帧挪 3 wu ⇒ 每帧都推
      h.sys.update(1 / 60);
      pushedL.push(h.pushed[h.pushed.length - 1]![0]!.intensity);
    }
    expect(h.pushed.length).toBeGreaterThan(590);
    const rel = (xs: number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      let d = 0;
      for (let i = 1; i < xs.length; i++) d += (xs[i]! - xs[i - 1]!) ** 2;
      return Math.sqrt(d / (xs.length - 1)) / m;
    };
    // 同一个种子、同一串气流的原始逐帧值（相邻帧跳 ≈ 均方根 0.25 × √(2(1−a))）
    const raw = new PhysicalFlicker('flame', 0.1, 0.1, (h.sys as unknown as { entries: Map<string, { seed: number }> }).entries.values().next().value!.seed);
    const rawL = Array.from({ length: 600 }, () => raw.step(1 / 60, 10));
    expect(rel(rawL)).toBeGreaterThan(0.2);
    expect(rel(pushedL)).toBeLessThan(rel(rawL) * 0.5);
  });

  it('进入动作：动作入口挂上执行初始状态的；读档 / 切场景那种重挂不执行；原地切同一状态不执行', async () => {
    const h = withTable(harness({ light: [1, 2, 3], vfx: null }));
    await h.sys.attach('player', 'right_hand', 'fire', 'lit', {}, { enterActions: true });
    expect(h.ran).toEqual([[{ type: 'playSfx', params: { id: 'ignite' } }]]);

    h.sys.deserialize({ held: [{ target: 'player', socket: 'right_hand', prop: 'fire', state: 'lit' }] });
    await Promise.resolve();
    expect(h.ran).toHaveLength(1);

    expect(await h.sys.setStateAwait('player', 'right_hand', 'lit')).toBe(true);
    expect(h.ran).toHaveLength(1);
    expect(await h.sys.setStateAwait('player', 'right_hand', 'out', 300)).toBe(true);
    expect(h.ran[1]).toEqual([{ type: 'playSfx', params: { id: 'puff' } }]);
  });

  it('状态的进入动作互相切来切去：同一帧最多切 MAX 次，之后拒绝并报', async () => {
    const h = withTable(harness({ light: [1, 2, 3], vfx: null }));
    const logs: string[] = [];
    h.deps.log = (m) => { logs.push(m); };
    h.deps.runStateActions = async (actions) => {
      const next = String(actions[0]?.params.state ?? '');
      if (next) h.sys.setState('player', 'right_hand', next);
    };
    await h.sys.attach('player', 'right_hand', 'fire', 'lit');
    h.sys.setState('player', 'right_hand', 'loopA');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(logs.some((m) => m.includes(`一帧内已切 ${MAX_TRANSITIONS_PER_FRAME} 次`))).toBe(true);
    h.sys.update(1 / 60); // 下一帧计数清零，又能切了
    expect(h.sys.setState('player', 'right_hand', 'lit')).toBe(true);
  });
});

describe('粒子挂载：每个效果挂在贴图上自己的点', () => {
  const table = parsePropPresets({
    stick: {
      image: 'stick.png',
      firePoint: [0.5, 0.05],
      light: { intensity: 1 },
      particles: [{ effect: 'flame' }, { effect: 'smoke', point: [0.5, 0.5] }],
      states: {
        lit: {},
        out: { particles: [] },
        ember: { particles: [{ effect: 'coals', point: [0.4, 0.1] }] },
      },
    },
  });
  const mk = () => {
    const h = harness({ light: [1, 2, 3], vfx: [9, 9, 9] });
    h.deps.getPreset = (id) => table[id];
    // 按点给不同的偏移，好认出哪条挂载用了哪个点
    h.deps.getPropPointLocalPose = (_t, _s, point) => {
      h.pointQueries.push(point);
      return { x: point[0] * 100, y: -point[1] * 100, front: true, clearanceWu: 6, bodyWidthWu: 100 };
    };
    h.deps.socketToLightWorld = (_c, pose) => [pose.x, -pose.y, 0];
    return h;
  };

  it('没写点的挂载落到起火点（与灯同一个锚），写了点的落到贴图上那一点；每条一个效果实例', async () => {
    const h = mk();
    await h.sys.attach('player', 'right_hand', 'stick', 'lit');
    expect(h.played.map((x) => x.effect)).toEqual(['flame', 'smoke']);
    expect(h.played.map((x) => x.host)).toEqual([
      { targetId: 'player', socket: 'right_hand' }, { targetId: 'player', socket: 'right_hand' },
    ]);
    expect(h.played[0].at).toEqual([50, 5, 0]);
    expect(h.played[1].at).toEqual([50, 50, 0]);
    h.sys.update(1 / 60);
    // 逐帧各挪到各自的点
    expect(h.moved.slice(-2)).toEqual([[50, 5, 0], [50, 50, 0]]);
  });

  it('状态整体替换挂载列表：空数组 = 没有粒子；另一串 = 换成那一串（旧的软停）', async () => {
    const h = mk();
    let soft: string[] = [];
    h.deps.softStopVfx = (id) => { soft.push(id); };
    await h.sys.attach('player', 'right_hand', 'stick', 'lit');
    expect(h.played).toHaveLength(2);
    h.sys.setState('player', 'right_hand', 'out');
    expect(soft).toEqual(['v1', 'v2']);
    expect(h.played).toHaveLength(2);
    soft = [];
    h.sys.setState('player', 'right_hand', 'ember');
    expect(h.played.map((x) => x.effect)).toEqual(['flame', 'smoke', 'coals']);
    expect(h.played[2].at).toEqual([40, 10, 0]);
  });

  it('新旧两串里同一效果挂同一点的沿用原实例（点着 → 护火火舌不断）；换了点就算另一条', async () => {
    const tb = parsePropPresets({
      s: {
        image: 'stick.png',
        firePoint: [0.5, 0.05],
        particles: [{ effect: 'flame' }, { effect: 'smoke', point: [0.5, 0.5] }],
        states: {
          lit: {},
          guard: { particles: [{ effect: 'sparks', point: [0.5, 0.3] }, { effect: 'flame' }] },
          moved: { particles: [{ effect: 'sparks', point: [0.5, 0.4] }, { effect: 'flame' }] },
        },
      },
    });
    const h = mk();
    h.deps.getPreset = (id) => tb[id];
    const soft: string[] = [];
    h.deps.softStopVfx = (id) => { soft.push(id); };
    await h.sys.attach('player', 'right_hand', 's', 'lit');
    h.sys.setState('player', 'right_hand', 'guard');
    expect(soft).toEqual(['v2']);
    expect(h.played.map((x) => x.effect)).toEqual(['flame', 'smoke', 'sparks']);
    h.scales.clear();
    h.sys.setState('player', 'right_hand', 'moved');
    expect(soft).toEqual(['v2', 'v3']);
    expect(h.played.map((x) => x.effect)).toEqual(['flame', 'smoke', 'sparks', 'sparks']);
    // 沿用的那条也立刻按新状态套倍率
    expect(h.scales.get('v1')?.rate).toBeDefined();
    h.moved.length = 0;
    h.sys.update(1 / 60);
    expect(h.moved).toEqual([[50, 40, 0], [50, 5, 0]]);
  });

  it('锚点当时解不出来的那条先不开，解出来的那一帧补开并立刻套倍率；另一条不受影响', async () => {
    const h = mk();
    let ready = false;
    const base = h.deps.getPropPointLocalPose;
    h.deps.getPropPointLocalPose = (t, sk, point) => (point[1] === 0.5 && !ready ? null : base(t, sk, point));
    await h.sys.attach('player', 'right_hand', 'stick', 'lit');
    expect(h.played.map((x) => x.effect)).toEqual(['flame']);
    ready = true;
    h.sys.update(1 / 60);
    expect(h.played.map((x) => x.effect)).toEqual(['flame', 'smoke']);
    expect(h.scales.get('v2')?.rate).toBeDefined();
  });

  it('挂点这一帧没了（蹲下）：挂载与一次性效果当场硬停，不留在原地烧；挂点回来挂载从新位置重开，一次性的不重开', async () => {
    const h = mk();
    const stopped: string[] = [];
    h.deps.stopVfx = (id) => { stopped.push(id); };
    let crouch = false;
    const base = h.deps.getPropPointLocalPose;
    h.deps.getPropPointLocalPose = (t, sk, point) => (crouch ? null : base(t, sk, point));
    await h.sys.attach('player', 'right_hand', 'stick', 'lit');
    h.sys.playOneShot('player', 'right_hand', 'smoke_once', null);
    expect(h.played.map((x) => x.effect)).toEqual(['flame', 'smoke', 'smoke_once']);
    h.sys.update(1 / 60);
    crouch = true;
    h.moved.length = 0;
    h.sys.update(1 / 60);
    expect(stopped.sort()).toEqual(['v1', 'v2', 'v3']);
    expect(h.moved).toEqual([]);
    h.sys.update(1 / 60);
    expect(stopped).toHaveLength(3);
    crouch = false;
    h.sys.update(1 / 60);
    expect(h.played.map((x) => x.effect)).toEqual(['flame', 'smoke', 'smoke_once', 'flame', 'smoke']);
  });

  it('实例被散掉（moveVfx 返回 false）就重开，火把不会从此没有火', async () => {
    const h = mk();
    await h.sys.attach('player', 'right_hand', 'stick', 'lit');
    h.deps.moveVfx = (id) => id !== 'v1';
    h.sys.update(1 / 60);
    expect(h.played.map((x) => x.effect)).toEqual(['flame', 'smoke', 'flame']);
  });
});

describe('挂件上的一次性效果（playPropVfx）', () => {
  const table = parsePropPresets({
    t: {
      image: 'stick.png',
      firePoint: [0.5, 0.05],
      light: { intensity: 1 },
      particles: [{ effect: 'flame' }],
      states: {
        lit: {},
        out: {
          light: null,
          particles: [],
          onEnterActions: [
            { type: 'playPropVfx', params: { effect: 'snuff_smoke' } },
            { type: 'playPropVfx', params: { effect: 'x', target: 'npc_a', socket: 'left_hand' } },
            { type: 'runActions', params: { actions: [{ type: 'playPropVfx', params: { effect: 'nested' } }] } },
          ],
        },
      },
    },
  });
  const mk = () => {
    const h = harness({ light: [1, 2, 3], vfx: [1, 2, 3] });
    h.deps.getPreset = (id) => table[id];
    h.deps.getPropPointLocalPose = (_t, _s, point) => ({ x: point[0] * 100, y: -point[1] * 100, front: true, clearanceWu: 6, bodyWidthWu: 100 });
    h.deps.socketToLightWorld = (_c, pose) => [pose.x, -pose.y, 0];
    return h;
  };

  it('状态进入动作里顶层的 playPropVfx 没写 target / socket ⇒ 注入这件挂件；写了的原样；嵌套的不注入', async () => {
    const h = mk();
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    await h.sys.setStateAwait('player', 'right_hand', 'out');
    const acts = h.ran[h.ran.length - 1]!;
    expect(acts[0]).toEqual({ type: 'playPropVfx', params: { effect: 'snuff_smoke', target: 'player', socket: 'right_hand' } });
    expect(acts[1]!.params).toEqual({ effect: 'x', target: 'npc_a', socket: 'left_hand' });
    expect((acts[2]!.params as { actions: ActionDef[] }).actions[0]!.params).toEqual({ effect: 'nested' });
    // 数据本身一个字节不动
    expect(table.t.states!.out.onEnterActions![0]!.params).toEqual({ effect: 'snuff_smoke' });
  });

  it('播在起火点（或写的点）上、带宿主、标一次性；逐帧跟着挂件走；实例没了就摘掉且不重开；切状态不停、卸下当场散', async () => {
    const h = mk();
    const stopped: string[] = [];
    h.deps.stopVfx = (id) => { stopped.push(id); };
    const alive = new Set<string>();
    h.deps.moveVfx = (id, at) => { h.moved.push(at); return alive.has(id); };
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    alive.add('v1');
    expect(h.sys.playOneShot('player', 'right_hand', 'snuff_smoke', null)).toBe(true);
    expect(h.sys.playOneShot('player', 'right_hand', 'drip', [0.5, 0.5])).toBe(true);
    expect(h.sys.playOneShot('npc_x', 'right_hand', 'snuff_smoke', null)).toBe(false);
    expect(h.played.slice(1).map((p) => [p.effect, p.at, p.oneShot, p.host])).toEqual([
      ['snuff_smoke', [50, 5, 0], true, { targetId: 'player', socket: 'right_hand' }],
      ['drip', [50, 50, 0], true, { targetId: 'player', socket: 'right_hand' }],
    ]);
    expect(h.played[0]!.oneShot).toBe(false);
    alive.add('v2'); alive.add('v3');
    h.sys.update(1 / 60);
    const before = h.played.length;
    alive.delete('v2');           // 烟放完被收了
    h.sys.update(1 / 60);
    h.sys.update(1 / 60);
    expect(h.played.length).toBe(before);   // 不重开
    h.sys.setState('player', 'right_hand', 'out');
    expect(stopped).toEqual([]);
    h.sys.detach('player', 'right_hand');
    expect(stopped).toContain('v3');
    expect(stopped).not.toContain('v2');
  });
});

describe('风吹灭火：火势、越线、锁、点火', () => {
  const blow = { windSpeed: 5, drainSeconds: 2, recoverSeconds: 4, emberBelow: 0.4, fadeMs: 0 };
  const table = parsePropPresets({
    t: {
      image: 'stick.png',
      firePoint: [0.5, 0.05],
      light: { intensity: 1 },
      particles: [{ effect: 'flame' }],
      blowout: { ...blow, onEmberActions: [{ type: 'emitNarrativeSignal', params: { signal: 'torch_failing' } }],
        onOutActions: [{ type: 'emitNarrativeSignal', params: { signal: 'torch_out' } }] },
      states: {
        lit: {},
        guarding: { windShelter: 0.8 },
        ember: { light: { intensity: 0.2 } },
        out: { light: null, particles: [] },
        inside: { blowout: null },
      },
    },
    manual: {
      image: 'stick.png',
      light: { intensity: 1 },
      blowout: { ...blow, auto: false, onOutActions: [{ type: 'emitNarrativeSignal', params: { signal: 'torch_out' } }] },
      states: { lit: {}, ember: {}, out: {} },
    },
    lamp: { image: 'lantern.png', light: { intensity: 0.15 }, states: { lit: {} } },
  });
  const mk = (windMps: number) => {
    const h = harness({ light: [0, 100, 0], vfx: [0, 100, 0] });
    h.deps.getPreset = (id) => table[id];
    const wind = { u: windMps };
    h.deps.windVectorAt = () => [wind.u * 88, 0, 0];
    return { h, wind };
  };
  const snap = (h: ReturnType<typeof harness>) => h.sys.debugSnapshot()[0]!;
  const signals = (h: ReturnType<typeof harness>) => h.ran.flat().filter((a) => a.type === 'emitNarrativeSignal').map((a) => a.params!.signal);
  const run = (h: ReturnType<typeof harness>, seconds: number) => { for (let i = 0; i < Math.round(seconds * 60); i++) h.sys.update(1 / 60); };

  it('气流 = 吹熄风速两倍时 drainSeconds 秒从满到底：先切残炭（发 failing）、再切灭（发 out）；灭了就不再算', async () => {
    const { h } = mk(10);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    run(h, 0.5);
    expect(snap(h).vitality).toBeGreaterThan(0.7);
    expect(snap(h).vitality).toBeLessThan(0.8);
    run(h, 0.8);
    expect(snap(h).state).toBe('ember');
    expect(signals(h)).toEqual(['torch_failing']);
    run(h, 1);
    expect(snap(h).state).toBe('out');
    expect(snap(h).vitality).toBe(0);
    expect(signals(h)).toEqual(['torch_failing', 'torch_out']);
    run(h, 2);
    expect(signals(h)).toEqual(['torch_failing', 'torch_out']);
  });

  it('火势乘在灯与燃烧强度上："眼看火要灭"看得见', async () => {
    const { h } = mk(10);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    run(h, 0.6);
    const v = snap(h).vitality;
    expect(v).toBeLessThan(0.75);
    const last = h.pushed[h.pushed.length - 1]![0]!;
    expect(last.intensity).toBeCloseTo(v, 1);
    const sc = h.scales.get('v1')!;
    expect(sc.rate).toBeCloseTo(v, 1);
  });

  it('风低于吹熄风速火势就回；护火挡风（气流 ×0.2）让火势回升而不掉', async () => {
    const { h, wind } = mk(10);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    run(h, 0.6);
    const low = snap(h).vitality;
    h.sys.setState('player', 'right_hand', 'guarding');
    run(h, 1);
    expect(snap(h).vitality).toBeGreaterThan(low);
    wind.u = 0;
    run(h, 4);
    expect(snap(h).vitality).toBe(1);
  });

  it('锁定不灭（lit）：风压不掉火势（只回不掉），解锁照常；锁进存档、读档带回来', async () => {
    const { h } = mk(10);
    h.deps.getPreset = (id) => (id === 't' ? { ...table.t, persistent: true } : table[id]);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    expect(h.sys.setLock('player', 'right_hand', 'lit')).toBe(true);
    expect(h.sys.setLock('npc', 'right_hand', 'lit')).toBe(false);
    run(h, 3);
    expect(snap(h).vitality).toBe(1);
    expect(snap(h).state).toBe('lit');
    const saved = h.sys.serialize() as { held: { lock?: string }[] };
    expect(saved.held[0]!.lock).toBe('lit');
    h.sys.deserialize(saved);
    await Promise.resolve();
    expect(snap(h).lock).toBe('lit');
    h.sys.setLock('player', 'right_hand', 'none');
    expect((h.sys.serialize() as { held: { lock?: string }[] }).held[0]!.lock).toBeUndefined();
    run(h, 0.5);
    expect(snap(h).vitality).toBeLessThan(1);
  });

  it('状态写 blowout: null ⇒ 这个状态吹不灭；动作永远优先：锁着也能 setPropState 切', async () => {
    const { h } = mk(30);
    await h.sys.attach('player', 'right_hand', 't', 'inside');
    run(h, 3);
    expect(snap(h).vitality).toBe(1);
    expect(snap(h).state).toBe('inside');
    h.sys.setLock('player', 'right_hand', 'lit');
    h.sys.setState('player', 'right_hand', 'out');
    expect(snap(h).state).toBe('out');
  });

  it('auto: false ⇒ 越线只执行动作、不切状态（切不切交给叙事状态机）；火势在线附近抖不连发', async () => {
    const { h, wind } = mk(10);
    await h.sys.attach('player', 'right_hand', 'manual', 'lit');
    run(h, 2.2);
    expect(snap(h).state).toBe('lit');
    expect(snap(h).vitality).toBe(0);
    expect(signals(h)).toEqual(['torch_out']);
    wind.u = 4.9;                 // 刚好低于吹熄风速：回得极慢，仍在重新武装线下
    run(h, 1);
    wind.u = 10;
    run(h, 1);
    expect(signals(h)).toEqual(['torch_out']);
  });

  it('物理不点火；动作把火从灭里点着 = 火势回满、越线重新武装', async () => {
    const { h, wind } = mk(10);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    run(h, 2.5);
    expect(snap(h).state).toBe('out');
    wind.u = 0;
    run(h, 5);
    expect(snap(h).state).toBe('out');
    h.sys.setState('player', 'right_hand', 'lit');
    expect(snap(h).vitality).toBe(1);
    wind.u = 10;
    run(h, 2.5);
    expect(signals(h)).toEqual(['torch_failing', 'torch_out', 'torch_failing', 'torch_out']);
  });

  it('残炭挡住风就复燃：风停 / 残炭里按住护火（不切状态、按护火状态挡风）⇒ 火势回到残炭线上方一截切回点着；火势不回满、不发越线动作', async () => {
    const { h, wind } = mk(10);
    h.deps.getPreset = (id) => (id === 't' ? { ...table.t, playerControl: {} } : table[id]);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    for (let k = 0; k < 600 && snap(h).state !== 'ember'; k++) h.sys.update(1 / 60);
    expect(snap(h).state).toBe('ember');
    // 不挡：一路掉到灭
    // 按住护火：挡风 0.8 ⇒ 气流 2 m/s < 5，火势往上回
    h.setInput({ togglePressed: false, guardHeld: true });
    let back = -1;
    for (let k = 0; k < 600; k++) {
      h.sys.update(1 / 60);
      if (snap(h).state !== 'ember') { back = k; break; }
    }
    expect(back).toBeGreaterThan(0);
    // 回来那一帧切回点着，下一帧按住护火键 ⇒ 护火
    expect(snap(h).state).toBe('lit');
    expect(snap(h).vitality).toBeGreaterThanOrEqual(0.5);
    expect(snap(h).vitality).toBeLessThan(0.6);
    h.sys.update(1 / 60);
    expect(snap(h).state).toBe('guarding');
    expect(signals(h)).toEqual(['torch_failing']);
    // 残炭里松开：风照吹，照样灭
    const { h: h2 } = mk(10);
    await h2.sys.attach('player', 'right_hand', 't', 'lit');
    run(h2, 2.5);
    expect(snap(h2).state).toBe('out');
    // 风停也能复燃（不按键）
    const { h: h3, wind: w3 } = mk(10);
    await h3.sys.attach('player', 'right_hand', 't', 'lit');
    for (let k = 0; k < 600 && snap(h3).state !== 'ember'; k++) h3.sys.update(1 / 60);
    w3.u = 0;
    run(h3, 1);
    expect(snap(h3).state).toBe('lit');
    void wind;
  });

  it('没写 blowout 的挂件（灯笼）：火势恒 1、大风里不变', async () => {
    const { h } = mk(40);
    await h.sys.attach('player', 'right_hand', 'lamp', 'lit');
    run(h, 3);
    expect(snap(h).vitality).toBe(1);
    expect(snap(h).state).toBe('lit');
  });
});

describe('物理闪烁灯的连续性：切状态不窜、点火不闪、残炭按残炭线归一、挂点回来跟着火苗亮起', () => {
  const table = parsePropPresets({
    t: {
      image: 'stick.png',
      light: { intensity: 0.1, flicker: { kind: 'flame', diameter: 0.1 } },
      particles: [{ effect: 'flame' }],
      blowout: { windSpeed: 8, drainSeconds: 4, recoverSeconds: 3, emberBelow: 0.35, fadeMs: 500 },
      states: {
        lit: {},
        ember: { light: { intensity: 0.008, flicker: { kind: 'ember', diameter: 0.1 } }, particles: [{ effect: 'coals' }] },
        out: { light: null, particles: [] },
      },
    },
  });
  const mk = (windMps: number) => {
    const space = { light: [0, 100, 0] as Vec3, vfx: [0, 100, 0] as Vec3 };
    const h = harness(space);
    h.deps.getPreset = (id) => table[id];
    const wind = { u: windMps };
    h.deps.windVectorAt = () => [wind.u * 88, 0, 0];
    return { h, wind, space };
  };
  const snap = (h: ReturnType<typeof harness>) => h.sys.debugSnapshot()[0]!;
  const lastPush = (h: ReturnType<typeof harness>) => h.pushed[h.pushed.length - 1]?.[0]?.intensity ?? 0;

  it('大风里被吹进残炭：推给灯的亮度在切换那一刻不跳（不是残炭倍率 × 还没降下来的点着强度），之后按渐变平滑过去', async () => {
    const { h } = mk(25);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    const series: { state: string; i: number }[] = [];
    for (let k = 0; k < 600 && snap(h).state !== 'out'; k++) {
      h.sys.update(1 / 60);
      series.push({ state: snap(h).state, i: lastPush(h) });
    }
    const at = series.findIndex((x) => x.state === 'ember');
    expect(at).toBeGreaterThan(0);
    const before = series[at - 1]!.i;
    expect(series[at]!.i).toBeLessThan(before * 1.3 + 1e-6);
    const window = series.slice(at - 1, at + 30).map((x) => x.i);
    for (let k = 1; k < window.length; k++) expect(Math.abs(window[k]! - window[k - 1]!)).toBeLessThan(0.012);
  });

  it('从灭里点火：灯从 0 往上走，不会一下亮成点着的好几倍', async () => {
    const { h, wind } = mk(25);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    for (let k = 0; k < 600 && snap(h).state !== 'out'; k++) h.sys.update(1 / 60);
    expect(snap(h).state).toBe('out');
    h.sys.update(1 / 60);
    wind.u = 2;
    h.sys.setState('player', 'right_hand', 'lit', 250);
    const xs: number[] = [];
    for (let k = 0; k < 30; k++) { h.sys.update(1 / 60); xs.push(lastPush(h)); }
    expect(xs[0]!).toBeLessThan(0.1 * 0.3);
    expect(Math.max(...xs)).toBeLessThan(0.1 * 1.4);
  });

  it('残炭状态：燃烧强度 / 灯按残炭线归一——刚进残炭时炭火是满的，火势掉到 0 时没了', async () => {
    const { h } = mk(25);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    for (let k = 0; k < 600 && snap(h).state !== 'ember'; k++) h.sys.update(1 / 60);
    h.sys.update(1 / 60);
    const coals = [...h.scales.entries()].find(([id]) => h.played[Number(id.slice(1)) - 1]?.effect === 'coals');
    expect(coals).toBeDefined();
    expect(coals![1].rate!).toBeGreaterThan(0.8);
  });

  it('火要灭时时断时续：火势低时灯一阵阵暗到两成、火苗发射量跟着掉；火势高或锁定不灭时不断', async () => {
    const measure = async (lock: 'none' | 'lit') => {
      const { h } = mk(16);                        // 吹熄风速两倍：4 s 从满掉到底，中间经过不断 / 时断时续两段
      await h.sys.attach('player', 'right_hand', 't', 'lit');
      if (lock === 'lit') {
        for (let k = 0; k < 600 && snap(h).vitality > 0.5; k++) h.sys.update(1 / 60);
        h.sys.setLock('player', 'right_hand', 'lit');
      }
      const lights: number[] = [], rates: number[] = [], vit: number[] = [];
      for (let k = 0; k < 240 && snap(h).state === 'lit'; k++) {
        h.sys.update(1 / 60);
        lights.push(lastPush(h));
        rates.push(h.scales.get('v1')?.rate ?? 1);
        vit.push(snap(h).vitality);
      }
      return { lights, rates, vit };
    };
    const open = await measure('none');
    // 火势 > 0.75 那段不断：发射量就是火势
    const hi = open.vit.map((v, i) => [v, open.rates[i]!] as const).filter(([v]) => v > 0.8);
    expect(hi.length).toBeGreaterThan(10);
    for (const [v, r] of hi) expect(r).toBeCloseTo(v, 6);
    // 火势 < 0.6 那段：有断着的帧（发射量掉到火势的 5%）
    const lo = open.vit.map((v, i) => [v, open.rates[i]!] as const).filter(([v]) => v < 0.6);
    expect(lo.length).toBeGreaterThan(10);
    expect(lo.some(([v, r]) => r < v * 0.1)).toBe(true);
    const locked = await measure('lit');
    expect(locked.rates.length).toBeGreaterThan(60);
    for (let i = 0; i < locked.rates.length; i++) expect(locked.rates[i]).toBeCloseTo(locked.vit[i]!, 6);
  });

  it('火焰长度倍率：满火无风 = 1；风越大越短（Thomas u^−0.21）；燃烧强度低 / 断着那一下也短', async () => {
    const len = async (windMps: number) => {
      const { h } = mk(windMps);
      h.deps.getPreset = (id) => (id === 't' ? { ...table.t, blowout: undefined } : table[id]);
      await h.sys.attach('player', 'right_hand', 't', 'lit');
      for (let k = 0; k < 60; k++) h.sys.update(1 / 60);
      return h.scales.get('v1')!.distance!;
    };
    expect(await len(0)).toBeCloseTo(1, 6);
    const w10 = await len(10), w25 = await len(25);
    expect(w10).toBeGreaterThan(0.55);
    expect(w10).toBeLessThan(0.7);
    expect(w25).toBeLessThan(w10);
  });

  it('挂点没了又回来（蹲下→站起）：灯从 0 跟着火苗一茬寿命亮回来，不是一回来就满亮', async () => {
    const { h } = mk(0);
    let crouch = false;
    const basePoint = h.deps.getPropPointLocalPose;
    const baseSocket = h.deps.getSocketLocalPose;
    h.deps.getPropPointLocalPose = (t, sk, point) => (crouch ? null : basePoint(t, sk, point));
    h.deps.getSocketLocalPose = (t, sk) => (crouch ? null : baseSocket(t, sk));
    h.deps.socketToLightWorld = () => [0, 100, 0];
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    for (let k = 0; k < 60; k++) h.sys.update(1 / 60);
    const full = lastPush(h);
    crouch = true;
    for (let k = 0; k < 30; k++) h.sys.update(1 / 60);
    crouch = false;
    h.sys.update(1 / 60);
    expect(lastPush(h)).toBeLessThan(full * 0.2);
    for (let k = 0; k < 30; k++) h.sys.update(1 / 60);
    expect(lastPush(h)).toBeGreaterThan(full * 0.6);
  });
});

describe('玩家按键：T 点火 / 熄灭、按住 Q 护火；锁拦按键不拦动作', () => {
  const table = parsePropPresets({
    t: {
      image: 'stick.png',
      light: { intensity: 1 },
      playerControl: {},
      states: {
        lit: { onEnterActions: [{ type: 'playSfx', params: { id: 'ignite' } }] },
        guarding: { windShelter: 0.8 },
        ember: {},
        out: { light: null, onEnterActions: [{ type: 'playPropVfx', params: { effect: 'snuff' } }] },
      },
    },
    custom: {
      image: 'stick.png',
      playerControl: { litState: 'burning', guardState: 'cupped', outState: 'dead' },
      states: { burning: {}, cupped: {}, dead: {} },
    },
    noControl: { image: 'stick.png', states: { lit: {}, out: {} } },
  });
  const mk = () => {
    const h = harness({ light: [0, 100, 0], vfx: [0, 100, 0] });
    h.deps.getPreset = (id) => table[id];
    return h;
  };
  const snap = (h: ReturnType<typeof harness>) => h.sys.debugSnapshot()[0]!;
  const press = (h: ReturnType<typeof harness>) => {
    h.setInput({ togglePressed: true, guardHeld: false });
    h.sys.update(1 / 60);
    h.setInput({ togglePressed: false, guardHeld: false });
    h.sys.update(1 / 60);
  };

  it('T：点着 → 灭（灭的进入动作照跑：冒烟）→ 再按 → 点着；残炭还算燃着，按 T 是捂灭', async () => {
    const h = mk();
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    press(h);
    expect(snap(h).state).toBe('out');
    expect(h.ran.flat().some((a) => a.type === 'playPropVfx')).toBe(true);
    press(h);
    expect(snap(h).state).toBe('lit');
    h.sys.setState('player', 'right_hand', 'ember');
    press(h);
    expect(snap(h).state).toBe('out');
  });

  it('按住 Q：点着时护火，松开回点着；灭着的时候按 Q 不护；别的来源切的护火松键不管', async () => {
    const h = mk();
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    h.setInput({ togglePressed: false, guardHeld: true });
    h.sys.update(1 / 60);
    expect(snap(h).state).toBe('guarding');
    h.sys.update(1 / 60);
    expect(snap(h).state).toBe('guarding');
    h.setInput({ togglePressed: false, guardHeld: false });
    h.sys.update(1 / 60);
    expect(snap(h).state).toBe('lit');
    // 护火中按 T：熄灭，松开 Q 不会把它切回点着
    h.setInput({ togglePressed: false, guardHeld: true });
    h.sys.update(1 / 60);
    h.setInput({ togglePressed: true, guardHeld: true });
    h.sys.update(1 / 60);
    h.setInput({ togglePressed: false, guardHeld: false });
    h.sys.update(1 / 60);
    expect(snap(h).state).toBe('out');
    h.setInput({ togglePressed: false, guardHeld: true });
    h.sys.update(1 / 60);
    expect(snap(h).state).toBe('out');
    // 动作切的护火：松键不动它
    h.sys.setState('player', 'right_hand', 'guarding');
    h.setInput({ togglePressed: false, guardHeld: false });
    h.sys.update(1 / 60);
    expect(snap(h).state).toBe('guarding');
  });

  it('锁：lit 熄不了、unlit 点不着；setPropState 照样切；不受理输入（null）时按键无效、护火照常松开', async () => {
    const h = mk();
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    h.sys.setLock('player', 'right_hand', 'lit');
    press(h);
    expect(snap(h).state).toBe('lit');
    h.sys.setLock('player', 'right_hand', 'unlit');
    press(h);
    expect(snap(h).state).toBe('out');
    press(h);
    expect(snap(h).state).toBe('out');
    h.sys.setState('player', 'right_hand', 'lit');
    expect(snap(h).state).toBe('lit');
    h.sys.setLock('player', 'right_hand', 'none');
    h.setInput({ togglePressed: false, guardHeld: true });
    h.sys.update(1 / 60);
    expect(snap(h).state).toBe('guarding');
    h.setInput(null);
    h.sys.update(1 / 60);
    expect(snap(h).state).toBe('lit');
    h.setInput({ togglePressed: true, guardHeld: false });
    h.setInput(null);
    h.sys.update(1 / 60);
    expect(snap(h).state).toBe('lit');
  });

  it('状态名按 playerControl 配的走；没配 playerControl 的挂件、NPC 身上的挂件按键不管', async () => {
    const h = mk();
    await h.sys.attach('player', 'right_hand', 'custom', 'burning');
    h.setInput({ togglePressed: false, guardHeld: true });
    h.sys.update(1 / 60);
    expect(snap(h).state).toBe('cupped');
    h.setInput({ togglePressed: true, guardHeld: true });
    h.sys.update(1 / 60);
    expect(snap(h).state).toBe('dead');
    expect(h.sys.hasPlayerControl()).toBe(true);

    const n = mk();
    await n.sys.attach('player', 'right_hand', 'noControl', 'lit');
    await n.sys.attach('npc_a', 'right_hand', 't', 'lit');
    expect(n.sys.hasPlayerControl()).toBe(false);
    n.setInput({ togglePressed: true, guardHeld: true });
    n.sys.update(1 / 60);
    expect(n.sys.debugSnapshot().map((e) => e.state)).toEqual(['lit', 'lit']);
  });
});

describe('快灭提示符号、全局玩法事实（statusOf / 变更通知 / 火势入档）', () => {
  const table = parsePropPresets({
    t: {
      image: 'stick.png',
      firePoint: [0.5, 0.05],
      light: { intensity: 1 },
      playerControl: {},
      blowout: { windSpeed: 5, drainSeconds: 2, recoverSeconds: 4, emberBelow: 0.4, fadeMs: 0 },
      states: {
        lit: {},
        guarding: { windShelter: 0.8 },
        ember: { light: { intensity: 0.2 } },
        out: { light: null },
      },
      persistent: true,
    },
    quiet: {
      image: 'stick.png',
      light: { intensity: 1 },
      playerControl: { hintBelow: 0 },
      blowout: { windSpeed: 5, drainSeconds: 2, recoverSeconds: 4 },
      states: { lit: {}, out: { light: null } },
    },
    knife: { image: 'knife.png', states: { held: {} } },
    stay: {
      image: 'stick.png',
      firePoint: [0.5, 0.05],
      light: { intensity: 1 },
      playerControl: {},
      blowout: { windSpeed: 5, drainSeconds: 60, recoverSeconds: 4, emberBelow: 0.4, auto: false },
      states: { lit: {}, ember: { light: { intensity: 0.2 } }, out: { light: null } },
    },
  });
  const mk = (windMps: number) => {
    const h = harness({ light: [0, 100, 0], vfx: [0, 100, 0] });
    h.deps.getPreset = (id) => table[id];
    const wind = { u: windMps };
    h.deps.windVectorAt = () => [wind.u * 88, 0, 0];
    return { h, wind };
  };
  const snap = (h: ReturnType<typeof harness>) => h.sys.debugSnapshot()[0]!;
  const lastHint = (h: ReturnType<typeof harness>) => h.hints[h.hints.length - 1] ?? null;
  const run = (h: ReturnType<typeof harness>, seconds: number) => { for (let i = 0; i < Math.round(seconds * 60); i++) h.sys.update(1 / 60); };

  it('火势掉过提示线才出；出在起火点、外侧；往下掉时 falling、越见底越急；挡住风往回长时不 falling；满过线就收', async () => {
    const { h, wind } = mk(10);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    h.sys.update(1 / 60);
    expect(lastHint(h)).toBeNull();
    run(h, 0.3);                                     // 0.85 左右
    expect(lastHint(h)).toBeNull();
    run(h, 0.2);                                     // 掉过 0.8
    const a = lastHint(h)!;
    expect(a).not.toBeNull();
    expect(a.sceneX).toBe(412);
    expect(a.sceneY).toBe(470);
    expect(Math.hypot(a.dirX, a.dirY)).toBeCloseTo(1, 6);
    expect(a.falling).toBe(true);
    expect(a.ember).toBe(false);
    expect(a.fill).toBeCloseTo(snap(h).vitality, 6);
    run(h, 0.4);
    expect(lastHint(h)!.danger).toBeGreaterThan(a.danger);
    wind.u = 0;
    run(h, 0.3);
    expect(lastHint(h)!.falling).toBe(false);
    run(h, 2);
    expect(lastHint(h)).toBeNull();
  });

  it('残炭：一直出（ember、最急）；灭了、锁定不灭、不受理输入（演出 / 对话）、hintBelow 0 都不出', async () => {
    const { h, wind } = mk(10);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    for (let k = 0; k < 600 && snap(h).state !== 'ember'; k++) h.sys.update(1 / 60);
    h.sys.update(1 / 60);
    expect(lastHint(h)!.ember).toBe(true);
    expect(lastHint(h)!.danger).toBe(1);
    h.setInput(null);
    h.sys.update(1 / 60);
    expect(lastHint(h)).toBeNull();
    h.setInput({ togglePressed: false, guardHeld: false });
    run(h, 2);
    expect(snap(h).state).toBe('out');
    expect(lastHint(h)).toBeNull();
    h.sys.setState('player', 'right_hand', 'lit');
    h.sys.setLock('player', 'right_hand', 'lit');
    wind.u = 10;
    for (let k = 0; k < 60; k++) h.sys.update(1 / 60);
    h.sys.setLock('player', 'right_hand', 'none');
    run(h, 0.8);
    expect(lastHint(h)).not.toBeNull();
    h.sys.setLock('player', 'right_hand', 'lit');
    h.sys.update(1 / 60);
    expect(lastHint(h)).toBeNull();

    const { h: q } = mk(10);
    await q.sys.attach('player', 'right_hand', 'quiet', 'lit');
    run(q, 1.5);
    expect(q.sys.debugSnapshot()[0]!.vitality).toBeLessThan(0.5);
    expect(q.hints.every((x) => x === null)).toBe(true);
  });

  it('符号躲开火舌、杆子、身体那一侧：真跑测过的几种握法 × 风向都有余量；风一抖不跳', async () => {
    const deg = (a: number) => (a * 180) / Math.PI;
    const gap = (a: number, b: number) => Math.abs(deg(Math.atan2(Math.sin(a - b), Math.cos(a - b))));
    const run1 = async (fire: [number, number], hand: [number, number], windU: number) => {
      const { h, wind } = mk(windU);
      h.deps.getPropPointLocalPose = () => ({ x: fire[0], y: fire[1], front: true, clearanceWu: 6, bodyWidthWu: 100 });
      h.deps.getSocketLocalPose = () => ({ x: hand[0], y: hand[1], front: true, clearanceWu: 6, bodyWidthWu: 100 });
      await h.sys.attach('player', 'right_hand', 'stay', 'lit');
      h.sys.setState('player', 'right_hand', 'ember');   // 残炭一直出提示、auto 关着不会自己复燃
      run(h, 0.4);
      void wind;
      const d = lastHint(h)!;
      const a = Math.atan2(d.dirY, d.dirX);
      const lean = Math.atan(windU);                   // 测试画面 x = 世界 x
      const flame = Math.atan2(-Math.cos(lean), Math.sin(lean));
      const stick = Math.atan2(hand[1] - fire[1], hand[0] - fire[0]);
      const body = fire[0] > 0 ? Math.PI : 0;
      return { a, flame: gap(a, flame), stick: gap(a, stick), body: gap(a, body) };
    };
    // 朝右举（起火点在右前上，手在身侧下）× 无风 / 顺风 / 逆风（走路的相对气流）；朝左举 × 两个风向
    for (const [fire, hand] of [[[60, -130], [15, -95]], [[-60, -130], [-15, -95]]] as [[number, number], [number, number]][]) {
      for (const u of [0, 10, -10, 2, -2]) {
        const r = await run1(fire, hand, u);
        expect(r.flame).toBeGreaterThan(25 + 20);
        expect(r.stick).toBeGreaterThan(10 + 20);
        expect(r.body).toBeGreaterThan(55 + 20);
      }
    }
    // 走路（火舌往身后拖）时摆到前方水平附近，不在火把头正下方（另一只手的小臂伸在那里）
    const walk = await run1([60, -130], [15, -95], -3);
    expect(Math.abs(deg(walk.a))).toBeLessThan(40);
  });

  it('pickHintAngle：取最宽空隙的中线；上一次的方向还有余量就不动', () => {
    const obs = [{ angle: Math.PI, half: 0.5 }, { angle: -Math.PI / 2, half: 0.3 }];
    const a = pickHintAngle(obs, null);
    // 最宽空隙 (−π/2+0.3 .. π−0.5)，中线 ≈ 0.685（72 个方向取样，差不到 5°）
    expect(a).toBeGreaterThan(0.6);
    expect(a).toBeLessThan(0.78);
    expect(pickHintAngle(obs, a + 0.2)).toBeCloseTo(a + 0.2, 9);          // 离最好的不远：不动
    expect(pickHintAngle(obs, Math.PI - 0.55)).toBeCloseTo(a, 9);         // 快贴着障碍了：换
  });

  it('卸下：补推一次 null（符号马上收）', async () => {
    const { h } = mk(10);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    run(h, 0.8);
    expect(lastHint(h)).not.toBeNull();
    h.sys.detach('player', 'right_hand');
    h.sys.update(1 / 60);
    expect(lastHint(h)).toBeNull();
  });

  it('statusOf：挂件、状态、燃着没有（当前状态有灯）、火势、锁；别人身上的不混进来', async () => {
    const { h } = mk(10);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    await h.sys.attach('player', 'belt', 'knife', 'held');
    await h.sys.attach('npc_a', 'right_hand', 't', 'lit');
    run(h, 0.5);
    const mine = h.sys.statusOf('player');
    expect(mine.map((s) => s.prop).sort()).toEqual(['knife', 't']);
    const torch = mine.find((s) => s.prop === 't')!;
    expect(torch).toMatchObject({ socket: 'right_hand', state: 'lit', burning: true, lock: 'none' });
    expect(torch.vitality).toBeLessThan(1);
    expect(mine.find((s) => s.prop === 'knife')!.burning).toBe(false);
    h.sys.setState('player', 'right_hand', 'ember');
    expect(h.sys.statusOf('player').find((s) => s.prop === 't')!.burning).toBe(true);
    h.sys.setState('player', 'right_hand', 'out');
    expect(h.sys.statusOf('player').find((s) => s.prop === 't')!.burning).toBe(false);
    expect(h.sys.statusOf('nobody')).toEqual([]);
  });

  it('变更通知：挂上 / 切状态 / 锁 / 卸下各一次；火势每跨一档一次（不是每帧）；锁没变不通知', async () => {
    const { h } = mk(10);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    expect(h.changed.n).toBe(1);
    h.sys.setState('player', 'right_hand', 'guarding');
    expect(h.changed.n).toBe(2);
    h.sys.setLock('player', 'right_hand', 'unlit');
    h.sys.setLock('player', 'right_hand', 'unlit');
    expect(h.changed.n).toBe(3);
    h.sys.setState('player', 'right_hand', 'lit');
    const before = h.changed.n;
    run(h, 1);                                        // 火势 1 → 0.5：跨 10 档
    const n = h.changed.n - before;
    expect(n).toBeGreaterThanOrEqual(9);
    expect(n).toBeLessThanOrEqual(12);
    const mid = h.changed.n;
    h.sys.detach('player', 'right_hand');
    expect(h.changed.n).toBe(mid + 1);
  });

  it('火势是玩法事实：切场景重挂、存档读档都带着（快灭的火回来还是快灭的）；满的不写进档', async () => {
    const { h } = mk(10);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    const full = h.sys.serialize() as { held: { vitality?: number }[] };
    expect(full.held[0]!.vitality).toBeUndefined();
    run(h, 0.5);
    const v = snap(h).vitality;
    h.sys.onSceneChanged([]);
    await Promise.resolve();
    expect(snap(h).vitality).toBeCloseTo(v, 6);
    const saved = h.sys.serialize() as { held: { vitality?: number }[] };
    expect(saved.held[0]!.vitality).toBeCloseTo(v, 3);
    h.sys.deserialize(saved);
    await Promise.resolve();
    expect(snap(h).vitality).toBeCloseTo(v, 3);
  });
});

describe('用火种点火：T 开始点、点满点着；风大 / 人动 / 停手 / 被打断都没点着且已用掉；引火', () => {
  const table = parsePropPresets({
    t: {
      image: 'stick.png',
      firePoint: [0.5, 0.05],
      light: { intensity: 1 },
      playerControl: {},
      blowout: { windSpeed: 8, drainSeconds: 4, recoverSeconds: 3, emberBelow: 0.35 },
      states: {
        lit: {},
        guarding: { windShelter: 0.8 },
        ember: { light: { intensity: 0.1 } },
        out: { light: null },
        unlit: { light: null, blowout: null },
      },
    },
  });
  type Spec = { name: string; seconds: number; windLimit: number };
  const mk = (windMps: number, stock: { spec: Spec; available: number } | null = { spec: { name: '洋火', seconds: 0.4, windLimit: 10 }, available: 3 }) => {
    const h = harness({ light: [0, 100, 0], vfx: [0, 100, 0] });
    h.deps.getPreset = (id) => table[id];
    const wind = { u: windMps };
    h.deps.windVectorAt = () => [wind.u * 88, 0, 0];
    const contact = { x: 400, y: 600 };
    h.deps.getEntityContact = () => ({ ...contact });
    const results: string[] = [];
    let consumed = 0;
    const inv = { stock };
    h.deps.igniterStatus = () => (inv.stock ? { ...inv.stock.spec, available: inv.stock.available } : null);
    h.deps.consumeIgniterUse = () => {
      if (!inv.stock || inv.stock.available <= 0) return null;
      inv.stock.available--;
      consumed++;
      return { ...inv.stock.spec };
    };
    h.deps.onIgniteResult = (r) => { results.push(r); };
    return { h, wind, contact, results, inv, consumed: () => consumed };
  };
  const snap = (h: ReturnType<typeof harness>) => h.sys.debugSnapshot()[0]!;
  const lastHint = (h: ReturnType<typeof harness>) => h.hints[h.hints.length - 1] ?? null;
  const press = (h: ReturnType<typeof harness>) => {
    h.setInput({ togglePressed: true, guardHeld: false });
    h.sys.update(1 / 60);
    h.setInput({ togglePressed: false, guardHeld: false });
  };
  const run = (h: ReturnType<typeof harness>, s: number) => { for (let i = 0; i < Math.round(s * 60); i++) h.sys.update(1 / 60); };

  it('没点的火把（unlit）风里不掉火势、不切残炭；T ⇒ 扣一次开始点，符号装进度，点满切点着、火势满', async () => {
    const { h, results, consumed } = mk(20);
    await h.sys.attach('player', 'right_hand', 't', 'unlit');
    run(h, 1);
    expect(snap(h).state).toBe('unlit');
    const { h: h2, results: r2, consumed: c2 } = mk(2);
    await h2.sys.attach('player', 'right_hand', 't', 'unlit');
    run(h2, 0.2);
    press(h2);
    expect(c2()).toBe(1);
    expect(r2).toEqual(['started']);
    run(h2, 0.2);
    const mid = lastHint(h2)!;
    expect(mid.mode).toBe('igniting');
    expect(mid.fill).toBeGreaterThan(0.3);
    expect(mid.fill).toBeLessThan(0.9);
    expect(snap(h2).state).toBe('unlit');
    run(h2, 0.3);
    expect(snap(h2).state).toBe('lit');
    expect(snap(h2).vitality).toBe(1);
    expect(r2).toEqual(['started', 'success']);
    void results; void consumed;
  });

  it('风超过这种火种能扛的 ⇒ 没点着、已用掉、符号红一下；按住 Q 挡风就点得着', async () => {
    const slow = { name: '火镰火绒', seconds: 1, windLimit: 3 };
    const { h, results, consumed } = mk(6, { spec: slow, available: 5 });
    await h.sys.attach('player', 'right_hand', 't', 'out');
    run(h, 0.3);
    press(h);
    run(h, 0.2);
    expect(results).toEqual(['started', 'failWind']);
    expect(consumed()).toBe(1);
    expect(snap(h).state).toBe('out');
    expect(lastHint(h)!.mode).toBe('failed');
    run(h, 1);
    expect(lastHint(h)).toBeNull();
    // 先按住 Q 拢住手（6 m/s × 0.2 = 1.2 < 3），再按 T
    h.setInput({ togglePressed: false, guardHeld: true });
    run(h, 0.3);
    h.setInput({ togglePressed: true, guardHeld: true });
    h.sys.update(1 / 60);
    h.setInput({ togglePressed: false, guardHeld: true });
    run(h, 1.2);
    expect(results.slice(2)).toEqual(['started', 'success']);
    expect(snap(h).state).toBe('guarding');
  });

  it('同一帧按 Q 与 T 也先挡风，再判定点火，不白耗火种', async () => {
    const { h, results, consumed } = mk(6, { spec: { name: '火镰火绒', seconds: 1, windLimit: 3 }, available: 2 });
    await h.sys.attach('player', 'right_hand', 't', 'out');
    run(h, .3);
    h.setInput({ togglePressed: true, guardHeld: true });
    h.sys.update(1 / 60);
    h.setInput({ togglePressed: false, guardHeld: true });
    run(h, 1.2);
    expect(results).toEqual(['started', 'success']);
    expect(consumed()).toBe(1);
    expect(snap(h).state).toBe('guarding');
  });

  it('人走动 ⇒ 没点着；边走边按 T ⇒ 不开始、不扣；再按 T ⇒ 停手、已用掉；进对话（不受理输入）⇒ 没点着、已用掉', async () => {
    const { h, results, contact, consumed } = mk(0);
    await h.sys.attach('player', 'right_hand', 't', 'out');
    run(h, 0.2);
    press(h);
    for (let i = 0; i < 12; i++) { contact.x += 3; h.sys.update(1 / 60); }   // 3 wu/帧 ≈ 2 m/s
    expect(results).toEqual(['started', 'failMove']);
    expect(consumed()).toBe(1);
    // 还在走的时候按
    h.setInput({ togglePressed: true, guardHeld: false });
    contact.x += 3;
    h.sys.update(1 / 60);
    h.setInput({ togglePressed: false, guardHeld: false });
    expect(results[results.length - 1]).toBe('moving');
    expect(consumed()).toBe(1);
    run(h, 0.5);
    press(h);
    press(h);
    expect(results.slice(-2)).toEqual(['started', 'failCancel']);
    expect(consumed()).toBe(2);
    run(h, 0.6);
    press(h);
    h.setInput(null);
    h.sys.update(1 / 60);
    expect(results[results.length - 1]).toBe('failInterrupted');
    expect(consumed()).toBe(3);
    expect(snap(h).state).toBe('out');
  });

  it('没设火种 / 用完了 ⇒ 不开始；锁点不燃 ⇒ 不开始、不扣', async () => {
    const none = mk(0, null);
    await none.h.sys.attach('player', 'right_hand', 't', 'out');
    press(none.h);
    expect(none.results).toEqual(['noneSet']);
    const empty = mk(0, { spec: { name: '洋火', seconds: 0.4, windLimit: 10 }, available: 0 });
    await empty.h.sys.attach('player', 'right_hand', 't', 'out');
    press(empty.h);
    expect(empty.results).toEqual(['empty']);
    const locked = mk(0);
    await locked.h.sys.attach('player', 'right_hand', 't', 'out');
    locked.h.sys.setLock('player', 'right_hand', 'unlit');
    press(locked.h);
    expect(locked.results).toEqual(['locked']);
    expect(locked.consumed()).toBe(0);
    expect(snap(locked.h).state).toBe('out');
  });

  it('没接火种的宿主（旧行为）：T 直接点着', async () => {
    const h = harness({ light: [0, 100, 0], vfx: [0, 100, 0] });
    h.deps.getPreset = (id) => table[id];
    await h.sys.attach('player', 'right_hand', 't', 'out');
    press(h);
    expect(snap(h).state).toBe('lit');
  });

  it('引火：灭着 / 没点、没锁点不燃才给火头；燃着（点着 / 护火 / 残炭）不给；引着 = 切点着、不扣火种', async () => {
    const { h, consumed } = mk(0);
    await h.sys.attach('player', 'right_hand', 't', 'unlit');
    expect(h.sys.relightTipOf('player')).toEqual({ socket: 'right_hand', u: 0.5, v: 0.05 });
    expect(h.sys.relightTipOf('npc_a')).toBeNull();
    h.sys.setLock('player', 'right_hand', 'unlit');
    expect(h.sys.relightTipOf('player')).toBeNull();
    expect(h.sys.relightPlayerTorch()).toBe(false);
    h.sys.setLock('player', 'right_hand', 'none');
    expect(h.sys.relightPlayerTorch()).toBe(true);
    expect(snap(h).state).toBe('lit');
    expect(consumed()).toBe(0);
    expect(h.sys.relightTipOf('player')).toBeNull();
    h.sys.setState('player', 'right_hand', 'ember');
    expect(h.sys.relightTipOf('player')).toBeNull();
  });
});

describe('耐久（燃料）：只有燃着时在烧、风大烧得快、残炭慢烧、烧完切灭并跑动作、入档', () => {
  const table = parsePropPresets({
    t: {
      image: 'stick.png',
      firePoint: [0.5, 0.05],
      light: { intensity: 1 },
      playerControl: {},
      particles: [{ effect: 'flame' }],
      fuel: { seconds: 10, windFactor: 0.1, onSpentActions: [{ type: 'removeItem', params: { id: 'songming' } }] },
      blowout: { windSpeed: 8, drainSeconds: 40, recoverSeconds: 3, emberBelow: 0.35, fadeMs: 0 },
      states: {
        lit: {},
        guarding: { windShelter: 0.8 },
        ember: { light: { intensity: 0.2 } },
        out: { light: null },
        unlit: { light: null, blowout: null },
      },
      persistent: true,
    },
    forever: {
      image: 'stick.png',
      light: { intensity: 1 },
      playerControl: {},
      states: { lit: {}, out: { light: null } },
    },
    keep: {
      image: 'stick.png',
      firePoint: [0.5, 0.05],
      light: { intensity: 1 },
      playerControl: {},
      particles: [{ effect: 'flame' }],
      // 烧完留在手上（烧焦的杆子还在手里）：测"烧完的点不着"要有个留得住的 entry
      fuel: { seconds: 10, windFactor: 0, keepInHandWhenSpent: true },
      states: { lit: {}, guarding: { windShelter: 0.8 }, out: { light: null }, unlit: { light: null } },
    },
  });
  const mk = (windMps: number) => {
    const h = harness({ light: [0, 100, 0], vfx: [0, 100, 0] });
    h.deps.getPreset = (id) => table[id];
    const wind = { u: windMps };
    h.deps.windVectorAt = () => [wind.u * 88, 0, 0];
    return { h, wind };
  };
  const snap = (h: ReturnType<typeof harness>) => h.sys.debugSnapshot()[0]!;
  const lastHint = (h: ReturnType<typeof harness>) => h.hints[h.hints.length - 1] ?? null;
  const run = (h: ReturnType<typeof harness>, s: number) => { for (let i = 0; i < Math.round(s * 60); i++) h.sys.update(1 / 60); };
  /** 烧完那一下的动作（进入动作 + 烧完动作）是异步跑的，转几圈微任务再看"从手上拿掉" */
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

  it('没写耐久的挂件恒满、烧不完；写了的点着才烧，灭着 / 没点不烧', async () => {
    const { h } = mk(0);
    await h.sys.attach('player', 'right_hand', 'forever', 'lit');
    run(h, 5);
    expect(snap(h).fuel).toBe(1);
    const { h: b } = mk(0);
    await b.sys.attach('player', 'right_hand', 't', 'unlit');
    run(b, 3);
    expect(snap(b).fuel).toBe(1);
    b.sys.setState('player', 'right_hand', 'lit');
    run(b, 2);
    expect(snap(b).fuel).toBeCloseTo(0.8, 2);
    b.sys.setState('player', 'right_hand', 'out');
    run(b, 2);
    expect(snap(b).fuel).toBeCloseTo(0.8, 2);
  });

  it('风大烧得快（挡过风的那一份）：无风 1 倍、10 m/s 2 倍；护火挡掉八成风就省下来', async () => {
    const { h: calm } = mk(0);
    await calm.sys.attach('player', 'right_hand', 't', 'lit');
    run(calm, 2);
    expect(snap(calm).fuel).toBeCloseTo(0.8, 2);
    const { h: windy } = mk(10);
    await windy.sys.attach('player', 'right_hand', 't', 'lit');
    run(windy, 2);
    expect(snap(windy).fuel).toBeLessThan(0.65);
    expect(snap(windy).fuel).toBeGreaterThan(0.55);
    const { h: guard } = mk(10);
    await guard.sys.attach('player', 'right_hand', 't', 'guarding');
    run(guard, 2);
    expect(snap(guard).fuel).toBeGreaterThan(snap(windy).fuel);
  });

  it('残炭慢烧（三成）', async () => {
    const { h } = mk(0);
    // auto 关掉：否则无风的残炭会按"挡住风就复燃"切回点着，测不到炭的烧法
    h.deps.getPreset = (id) => (id === 't'
      ? { ...table.t, blowout: { ...table.t.blowout!, auto: false } }
      : table[id]);
    await h.sys.attach('player', 'right_hand', 't', 'ember');
    run(h, 2);
    expect(snap(h).fuel).toBeCloseTo(0.94, 2);
  });

  it('最后两成：火苗与灯按比例变小变暗；火边的符号装的是剩下的燃料', async () => {
    const { h } = mk(0);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    run(h, 7);
    expect(lastHint(h)).toBeNull();                       // 还剩三成，没到线
    const litRate = h.scales.get('v1')?.rate ?? 1;
    expect(litRate).toBeCloseTo(1, 3);
    run(h, 2);                                            // 剩一成
    const hint = lastHint(h)!;
    expect(hint).not.toBeNull();
    expect(hint.fill).toBeCloseTo(0.1, 1);
    expect(hint.falling).toBe(true);
    expect(h.scales.get('v1')!.rate!).toBeLessThan(0.6);
    expect(h.pushed[h.pushed.length - 1]![0]!.intensity).toBeLessThan(0.6);
  });

  it('烧完：切到灭的状态（那口烟照放）、跑烧完的动作、烟散完自己从手上拿掉、之后不再烧', async () => {
    const { h } = mk(0);
    h.deps.getPreset = (id) => (id === 't'
      // 「灭」的进入动作里播熄灭烟：烧完这一下不许把它掐掉
      ? { ...table.t, states: { ...table.t.states, out: { light: null, onEnterActions: [{ type: 'playPropVfx', params: { effect: 'snuff' } }] } } }
      : table[id]);
    // 把 playPropVfx 接回系统（游戏里是 ActionRegistry 干的）：不接的话这条测试测不到那口烟
    h.deps.runStateActions = async (actions) => {
      h.ran.push(actions);
      for (const a of actions) {
        if (a.type !== 'playPropVfx') continue;
        const p = a.params ?? {};
        h.sys.playOneShot(String(p.target), String(p.socket), String(p.effect), null);
      }
    };
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    for (let i = 0; i < Math.round(10.2 * 60); i++) h.sys.update(1 / 60);
    // 烟还在放：人手上还拿着那根（这一帧不许卸）
    expect(snap(h).state).toBe('out');
    expect(snap(h).fuel).toBe(0);
    expect(h.ran.flat().filter((a) => a.type === 'removeItem')).toHaveLength(1);
    // 进入动作是异步跑的：等它把一次性效果开起来
    await settle();
    h.sys.update(1 / 60);
    expect(h.played.some((v) => v.effect === 'snuff' && v.oneShot)).toBe(true);
    expect(h.sys.debugSnapshot()).toHaveLength(1);
    // 烟放完（效果实例没了）⇒ 下一帧自己从手上拿掉
    h.deps.moveVfx = () => false;
    await settle();
    h.sys.update(1 / 60);
    h.sys.update(1 / 60);
    expect(h.sys.debugSnapshot()).toHaveLength(0);
    expect(h.ran.flat().filter((a) => a.type === 'removeItem')).toHaveLength(1);
  });

  it('烧完没有烟要放的：下一帧就从手上拿掉；写了"烧完留在手上"的不拿', async () => {
    const { h } = mk(0);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    run(h, 10.2);
    await settle();
    h.sys.update(1 / 60);
    expect(h.sys.debugSnapshot()).toHaveLength(0);
    const { h: k } = mk(0);
    await k.sys.attach('player', 'right_hand', 'keep', 'lit');
    run(k, 10.5);
    await settle();
    expect(k.sys.debugSnapshot()).toHaveLength(1);
    expect(k.sys.debugSnapshot()[0]!.state).toBe('out');
  });

  it('剩多少燃料入档、切场景带着；没有耐久的不写进档', async () => {
    const { h } = mk(0);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    run(h, 3);
    const left = snap(h).fuel;
    h.sys.onSceneChanged([]);
    await Promise.resolve();
    expect(snap(h).fuel).toBeCloseTo(left, 3);
    const saved = h.sys.serialize() as { held: { fuel?: number }[] };
    expect(saved.held[0]!.fuel).toBeCloseTo(7, 1);
    h.sys.deserialize(saved);
    await Promise.resolve();
    expect(snap(h).fuel).toBeCloseTo(left, 2);
    const { h: f } = mk(0);
    f.deps.getPreset = (id) => (id === 'forever' ? { ...table.forever, persistent: true } : table[id]);
    await f.sys.attach('player', 'right_hand', 'forever', 'lit');
    expect((f.sys.serialize() as { held: { fuel?: number }[] }).held[0]!.fuel).toBeUndefined();
  });

  it('烧完的火把点不着也引不着（火种不耗）；换一根新的照样点得着', async () => {
    const { h } = mk(0);
    h.deps.getPreset = (id) => table[id];
    const results: string[] = [];
    let consumed = 0;
    h.deps.igniterStatus = () => ({ name: '洋火', seconds: 0.1, windLimit: 10, available: 5 });
    h.deps.consumeIgniterUse = () => { consumed++; return { name: '洋火', seconds: 0.1, windLimit: 10 }; };
    h.deps.onIgniteResult = (r) => { results.push(r); };
    await h.sys.attach('player', 'right_hand', 'keep', 'lit');
    run(h, 10.2);
    expect(snap(h).state).toBe('out');
    h.setInput({ togglePressed: true, guardHeld: false });
    h.sys.update(1 / 60);
    h.setInput({ togglePressed: false, guardHeld: false });
    expect(results).toEqual(['spent']);
    expect(consumed).toBe(0);
    expect(snap(h).state).toBe('out');
    expect(h.sys.relightTipOf('player')).toBeNull();
    expect(h.sys.relightPlayerTorch()).toBe(false);
    // 换一根（包里下一根是满的）
    h.sys.detach('player', 'right_hand');
    await h.sys.attach('player', 'right_hand', 'keep', 'unlit');
    expect(snap(h).fuel).toBe(1);
    expect(h.sys.relightTipOf('player')).not.toBeNull();
  });

  it('收进包里再拿出来接着烧那一根（不是白送新的）；烧完忘掉，下一根是满的；收着的那几根也入档', async () => {
    const { h } = mk(0);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    run(h, 4);
    const left = snap(h).fuel;
    expect(left).toBeCloseTo(0.6, 2);
    h.sys.detach('player', 'right_hand');
    const saved = JSON.parse(JSON.stringify(h.sys.serialize())) as { fuels?: Record<string, number> };
    expect(saved.fuels!.t).toBeCloseTo(6, 1);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    expect(snap(h).fuel).toBeCloseTo(left, 2);
    // 烧完：忘掉，下一根满的（烧完系统自己把它从手上拿掉）
    run(h, 7);
    await settle();
    h.sys.update(1 / 60);
    expect(h.sys.debugSnapshot()).toHaveLength(0);
    expect((h.sys.serialize() as { fuels?: Record<string, number> }).fuels).toBeUndefined();
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    expect(snap(h).fuel).toBe(1);
    // 读档：收着的那几根接着烧
    const { h: b } = mk(0);
    b.sys.deserialize({ fuels: { t: 3 } });
    await b.sys.attach('player', 'right_hand', 't', 'lit');
    expect(snap(b).fuel).toBeCloseTo(0.3, 2);
  });

  it('护火时只能走不能跑；松开 / 灭了就不拦', async () => {
    const { h } = mk(0);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    expect(h.sys.playerGuardBlocksRun()).toBe(false);
    h.setInput({ togglePressed: false, guardHeld: true });
    h.sys.update(1 / 60);
    expect(snap(h).state).toBe('guarding');
    expect(h.sys.playerGuardBlocksRun()).toBe(true);
    h.setInput({ togglePressed: false, guardHeld: false });
    h.sys.update(1 / 60);
    expect(h.sys.playerGuardBlocksRun()).toBe(false);
    const { h: off } = mk(0);
    off.deps.getPreset = (id) => (id === 't'
      ? { ...table.t, playerControl: { ...table.t.playerControl, guardBlocksRun: false } }
      : table[id]);
    await off.sys.attach('player', 'right_hand', 't', 'guarding');
    expect(off.sys.playerGuardBlocksRun()).toBe(false);
  });
});

describe('效果块：数值相乘、行为并集、至多两块；燃着才放场', () => {
  const effects: Record<string, PropEffectDef> = {
    hot: {
      id: 'hot', label: '旺',
      light: { intensity: 1.5, range: 1.2 }, burn: 1.4, fuelRate: 1.5,
      wind: { windSpeed: 0.8, drainSeconds: 0.5 }, igniterFlame: 2,
      fields: [{ kind: 'attract', tag: 'torch:招', radius: 600, strength: 1.2 }],
      tags: ['招东西'],
    },
    damp: {
      id: 'damp', label: '潮',
      light: { intensity: 0.5 }, wind: { windSpeed: 2 }, fuelRate: 0.5,
      fields: [{ kind: 'fear', tag: 'torch:驱虫', radius: 300, strength: 2 }],
      tags: ['驱虫'],
    },
    third: { id: 'third', label: '第三块', burn: 10 },
  };
  const table = parsePropPresets({
    t: {
      image: 'stick.png',
      firePoint: [0.5, 0.05],
      light: { intensity: 1, range: 400 },
      igniter: { flameLength: 20 },
      particles: [{ effect: 'flame' }],
      fuel: { seconds: 10, windFactor: 0 },
      blowout: { windSpeed: 8, drainSeconds: 4, recoverSeconds: 3, emberBelow: 0.4, fadeMs: 0 },
      effects: ['hot', 'damp'],
      states: { lit: {}, out: { light: null, particles: [] } },
    },
  });
  const mk = (ids?: string[], known = effects) => {
    const h = harness({ light: [0, 100, 0], vfx: [0, 100, 0] });
    const preset = ids ? { ...table.t, effects: ids } : table.t;
    h.deps.getPreset = (id) => (id === 't' ? preset : undefined);
    h.deps.getEffect = (id) => known[id];
    const fields: { handle: string; field: unknown; world: unknown }[] = [];
    h.deps.setPropField = (handle, field, world) => { fields.push({ handle, field, world }); };
    return { h, fields };
  };
  const snap = (h: ReturnType<typeof harness>) => h.sys.debugSnapshot()[0]!;
  const live = (fields: { handle: string; field: unknown }[]) => {
    const m = new Map<string, unknown>();
    for (const f of fields) { if (f.field) m.set(f.handle, f.field); else m.delete(f.handle); }
    return m;
  };
  const run = (h: ReturnType<typeof harness>, s: number) => { for (let i = 0; i < Math.round(s * 60); i++) h.sys.update(1 / 60); };

  it('数值相乘：灯、燃烧强度、抗风、火头长度、燃料速率', async () => {
    const { h } = mk();
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    h.sys.update(1 / 60);
    // 亮度 1 × 1.5 × 0.5 = 0.75；范围 400 × 1.2 = 480
    expect(snap(h).lightIntensity).toBeCloseTo(0.75, 6);
    const light = h.pushed[h.pushed.length - 1]![0]!;
    expect(light.range).toBeCloseTo(480, 6);
    // 火头 20 × 2 = 40 cm
    expect(h.sys.igniterOf('player')!.flameLengthCm).toBeCloseTo(40, 6);
    // 燃料 1.5 × 0.5 = 0.75 倍：10 秒的燃料烧 2 秒只掉 1.5 秒
    run(h, 2);
    expect(snap(h).fuel).toBeCloseTo(0.85, 2);
  });

  it('抗风相乘：吹熄风速 8 × 0.8 × 2 = 12.8，掉得快一倍（drainSeconds × 0.5）', async () => {
    const { h } = mk();
    // 12 m/s：没有效果块时早该掉火势，有了这两块还在阈值内
    h.deps.windVectorAt = () => [12 * 88, 0, 0];
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    run(h, 1);
    expect(snap(h).vitality).toBe(1);
    const plain = mk([]);
    plain.h.deps.windVectorAt = () => [12 * 88, 0, 0];
    await plain.h.sys.attach('player', 'right_hand', 't', 'lit');
    run(plain.h, 1);
    expect(snap(plain.h).vitality).toBeLessThan(1);
  });

  it('行为并集：燃着时两块的场都放在火头上；灭了 / 卸下撤掉', async () => {
    const { h, fields } = mk();
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    h.sys.update(1 / 60);
    const on = live(fields);
    expect([...on.keys()].sort()).toEqual([
      'heldProp:player:right_hand:damp:0', 'heldProp:player:right_hand:hot:0',
    ]);
    expect(on.get('heldProp:player:right_hand:hot:0')).toMatchObject({ kind: 'attract', tag: 'torch:招', radius: 600 });
    expect(fields[fields.length - 1]!.world).toEqual([0, 100, 0]);
    h.sys.setState('player', 'right_hand', 'out');
    h.sys.update(1 / 60);
    expect(live(fields).size).toBe(0);
    h.sys.setState('player', 'right_hand', 'lit');
    h.sys.update(1 / 60);
    expect(live(fields).size).toBe(2);
    h.sys.detach('player', 'right_hand');
    expect(live(fields).size).toBe(0);
  });

  it('标签与 id 都进玩法事实（条件叶查得到）', async () => {
    const { h } = mk();
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    expect(h.sys.statusOf('player')[0]!.effects.sort()).toEqual(['damp', 'hot', '招东西', '驱虫']);
  });

  it('最多两块（多写的不算）；库里查不到的跳过、不影响别的', async () => {
    const { h } = mk(['hot', 'damp', 'third']);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    h.sys.update(1 / 60);
    expect(snap(h).lightIntensity).toBeCloseTo(0.75, 6);     // 第三块的 burn ×10 没算进来
    const miss = mk(['nope', 'damp']);
    await miss.h.sys.attach('player', 'right_hand', 't', 'lit');
    miss.h.sys.update(1 / 60);
    expect(snap(miss.h).lightIntensity).toBeCloseTo(0.5, 6);
    expect(miss.h.sys.statusOf('player')[0]!.effects.sort()).toEqual(['damp', '驱虫']);
  });

  it('没接效果库的宿主（旧测试）：预设写了 effects 也当没有', async () => {
    const h = harness({ light: [0, 100, 0], vfx: [0, 100, 0] });
    h.deps.getPreset = (id) => (id === 't' ? table.t : undefined);
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    h.sys.update(1 / 60);
    expect(h.sys.debugSnapshot()[0]!.lightIntensity).toBeCloseTo(1, 6);
    expect(h.sys.statusOf('player')[0]!.effects).toEqual([]);
  });
});

describe('升级：等级换外观 + 叠效果块，按挂件 id 记、入档，收在包里也算数', () => {
  const effects: Record<string, PropEffectDef> = {
    oiled: { id: 'oiled', label: '浸了桐油', light: { intensity: 1.2 }, wind: { windSpeed: 1.25 }, tags: ['耐风'] },
    ironband: { id: 'ironband', label: '铁箍', wind: { drainSeconds: 2 } },
  };
  const table = parsePropPresets({
    t: {
      image: '/img/l1.png',
      light: { intensity: 1 },
      blowout: { windSpeed: 8, drainSeconds: 4, recoverSeconds: 3, emberBelow: 0.4, fadeMs: 0 },
      levels: [
        { label: '旧纤藤' },
        { label: '裹布浸桐油', image: '/img/l2.png', effects: ['oiled'] },
        { label: '铁箍加固', image: '/img/l3.png', effects: ['oiled', 'ironband'] },
      ],
      persistent: true,
      states: { lit: {}, out: { light: null } },
    },
    plain: { image: '/img/p.png', light: { intensity: 1 }, states: { lit: {} } },
  });
  const mk = () => {
    const h = harness({ light: [0, 100, 0], vfx: [0, 100, 0] });
    h.deps.getPreset = (id) => table[id];
    h.deps.getEffect = (id) => effects[id];
    const views: string[][] = [];
    h.deps.attachView = async (_t, _s, resolved) => { views.push(resolved.images); };
    return { h, views };
  };
  const snap = (h: ReturnType<typeof harness>) => h.sys.debugSnapshot()[0]!;

  it('缺省第 1 级；升级换图、叠效果块（灯 ×1.2、吹熄风速 ×1.25）；手上那根当场变', async () => {
    const { h, views } = mk();
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    expect(h.sys.getPropLevel('t')).toBe(1);
    expect(views[views.length - 1]).toEqual(['/img/l1.png']);
    expect(snap(h).lightIntensity).toBeCloseTo(1, 6);
    expect(h.sys.setPropLevel('t', 2)).toBe(true);
    await Promise.resolve();
    expect(h.sys.getPropLevel('t')).toBe(2);
    expect(views[views.length - 1]).toEqual(['/img/l2.png']);
    expect(snap(h).lightIntensity).toBeCloseTo(1.2, 6);
    expect(h.sys.statusOf('player')[0]!.level).toBe(2);
    expect(h.sys.statusOf('player')[0]!.effects).toContain('耐风');
    h.sys.setPropLevel('t', 3);
    await Promise.resolve();
    expect(views[views.length - 1]).toEqual(['/img/l3.png']);
    expect(snap(h).lightIntensity).toBeCloseTo(1.2, 6);
  });

  it('没有等级表 / 超范围 ⇒ 不动、返回 false', async () => {
    const { h } = mk();
    await h.sys.attach('player', 'right_hand', 'plain', 'lit');
    expect(h.sys.setPropLevel('plain', 2)).toBe(false);
    expect(h.sys.getPropLevel('plain')).toBe(1);
    expect(h.sys.setPropLevel('t', 0)).toBe(false);
    expect(h.sys.setPropLevel('t', 4)).toBe(false);
    expect(h.sys.setPropLevel('nope', 2)).toBe(false);
    expect(h.sys.getPropLevel('t')).toBe(1);
  });

  it('等级入档、读档回来还在；卸下（收进包里）也还在；切场景重挂按等级解外观', async () => {
    const { h, views } = mk();
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    h.sys.setPropLevel('t', 3);
    await Promise.resolve();
    h.sys.detach('player', 'right_hand');
    expect(h.sys.getPropLevel('t')).toBe(3);
    const saved = JSON.parse(JSON.stringify(h.sys.serialize())) as { levels?: Record<string, number> };
    expect(saved.levels).toEqual({ t: 3 });
    const { h: b, views: bv } = mk();
    b.sys.deserialize(saved);
    await Promise.resolve();
    expect(b.sys.getPropLevel('t')).toBe(3);
    await b.sys.attach('player', 'right_hand', 't', 'lit');
    expect(bv[bv.length - 1]).toEqual(['/img/l3.png']);
    b.sys.onSceneChanged([]);
    await Promise.resolve();
    expect(bv[bv.length - 1]).toEqual(['/img/l3.png']);
    void views;
  });

  it('第 1 级不写进档（存档里只记升过的）', async () => {
    const { h } = mk();
    await h.sys.attach('player', 'right_hand', 't', 'lit');
    expect((h.sys.serialize() as { levels?: unknown }).levels).toBeUndefined();
  });
});

describe('帧动画火苗（保留的能力）：数学', () => {
  it('Froude 倾角：10 cm 火苗在 1 m/s 横风里 tanθ = u²/(gH) ≈ 1.02；无风 / 无火为 0；强风封顶', () => {
    const h = 0.1 * FLAME_WU_PER_M;
    expect(Math.tan(flameTiltAngle(1 * FLAME_WU_PER_M, h))).toBeCloseTo(1 / (9.81 * 0.1), 10);
    expect(flameTiltAngle(0, h)).toBe(0);
    expect(flameTiltAngle(FLAME_WU_PER_M, 0)).toBe(0);
    expect(flameTiltAngle(40 * FLAME_WU_PER_M, h)).toBe(FLAME_MAX_TILT_RAD);
  });

  it('气流低通按 dt 精确离散：一帧 60 Hz 与两帧 120 Hz 走到同一点', () => {
    const target: Vec3 = [100, 0, -50];
    const one = smoothAirflow([0, 0, 0], target, 1 / 60);
    const half = smoothAirflow(smoothAirflow([0, 0, 0], target, 1 / 120), target, 1 / 120);
    one.forEach((v, i) => expect(v).toBeCloseTo(half[i], 10));
    expect(smoothAirflow(null, target, 1 / 60)).toEqual(target);
    const s1 = smoothScalar(0, 1, 1 / 60, FLAME_HEIGHT_TAU_S);
    const s2 = smoothScalar(smoothScalar(0, 1, 1 / 120, FLAME_HEIGHT_TAU_S), 1, 1 / 120, FLAME_HEIGHT_TAU_S);
    expect(s1).toBeCloseTo(s2, 12);
  });

  it('相对气流 = 风 − 宿主速度，只留水平；瞬移那一帧的位移不算风', () => {
    expect(relativeHorizontalAirflow([30, 5, 0], [100, 40, -20])).toEqual([-70, 0, 20]);
    expect(relativeHorizontalAirflow([30, 5, 0], [FLAME_TELEPORT_WU_PER_S + 1, 0, 0])).toEqual([30, 0, 0]);
    expect(relativeHorizontalAirflow([30, 5, 0], null)).toEqual([30, 0, 0]);
  });

  it('相机右：取让画面 y 不动的水平组合、按画面 x 为正定号', () => {
    const c = Math.SQRT1_2;
    expect(screenRightHorizontal({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 * c })).toEqual([1, 0, 0]);
    const r = screenRightHorizontal({ x: 0, y: 0 }, { x: 0, y: -100 * c }, { x: 100, y: 0 });
    expect(r[0]).toBeCloseTo(0, 12);
    expect(r[2]).toBeCloseTo(1, 12);
    expect(screenRightHorizontal({ x: 0, y: 0 }, { x: -100, y: 0 }, { x: 0, y: 0 })).toEqual([-1, 0, 0]);
  });

  it('直立面上的火苗：面内分量画成倾斜、面外分量只变短；往镜头方向的强风下也绝不耷拉过水平线', () => {
    const h = 0.1 * FLAME_WU_PER_M;
    const right: Vec3 = [1, 0, 0];
    const side = flameBillboardPose([FLAME_WU_PER_M, 0, 0], h, right);
    expect(side.angleRad).toBeCloseTo(flameTiltAngle(FLAME_WU_PER_M, h), 12);
    expect(side.lengthRatio).toBeCloseTo(1, 12);
    const toward = flameBillboardPose([0, 0, 40 * FLAME_WU_PER_M], h, right);
    expect(toward.angleRad).toBeCloseTo(0, 12);
    expect(toward.lengthRatio).toBeCloseTo(Math.cos(FLAME_MAX_TILT_RAD), 12);
    const storm = flameBillboardPose([-30 * FLAME_WU_PER_M, 0, 30 * FLAME_WU_PER_M], h, right);
    expect(Math.abs(storm.angleRad)).toBeLessThan(Math.PI / 2);
    expect(storm.angleRad).toBeLessThan(0);
  });

  it('帧号：按帧率走、取模、种子只错开起始相位', () => {
    expect(flameFrameIndex(0, 24, 64, 0)).toBe(0);
    expect(flameFrameIndex(1, 24, 64, 0)).toBe(24);
    expect(flameFrameIndex(3, 24, 64, 0)).toBe(72 % 64);
    expect(flameFrameIndex(0, 24, 64, 5)).toBe(5);
  });
});

describe('帧动画火苗（保留的能力）：系统', () => {
  const table = parsePropPresets({
    sheet: {
      image: 'stick.png',
      firePoint: [0.5, 0.05],
      flame: { image: 'sheet.png', cols: 12, frames: 64, height: 30 },
      light: { intensity: 1, flicker: { amp: 0.2, hz: 7 } },
      states: { lit: { burn: 1 }, guarding: { burn: 0.75, windShelter: 0.8 }, out: { burn: 0, light: null } },
    },
    lamp: { image: 'lantern.png', light: { intensity: 0.15 }, states: { lit: {} } },
  });
  const withTable = (h: ReturnType<typeof harness>) => { h.deps.getPreset = (id) => table[id]; return h; };

  it('没有 flame 块（灯笼、粒子火把）：一次都不推火苗视图', async () => {
    const l = withTable(harness({ light: [1, 2, 3], vfx: null }));
    await l.sys.attach('player', 'right_hand', 'lamp');
    for (let i = 0; i < 5; i++) l.sys.update(1 / 60);
    expect(l.flames).toEqual([]);
  });

  it('火苗高度 = 满火高度 × 燃烧强度 × 闪烁（2/5 次方）；切到 out 按 fadeMs 连续缩小到不画', async () => {
    const h = withTable(harness({ light: [1, 2, 3], vfx: null }));
    await h.sys.attach('player', 'right_hand', 'sheet', 'lit');
    h.sys.update(1 / 60);
    const first = h.flames[h.flames.length - 1]!;
    expect(first.visible).toBe(true);
    expect(first.heightWu).toBeGreaterThan(30 * 0.85);
    expect(first.heightWu).toBeLessThan(30 * 1.15);
    expect(first.angleRad).toBe(0);
    h.sys.setState('player', 'right_hand', 'out', 1000);
    const heights: number[] = [];
    for (let i = 0; i < 30; i++) { h.sys.update(1 / 60); heights.push(h.flames[h.flames.length - 1]!.heightWu); }
    expect(heights[29]).toBeGreaterThan(30 * 0.5 * 0.8);
    expect(heights[29]).toBeLessThan(30 * 0.5 * 1.2);
    for (let i = 0; i < 40; i++) h.sys.update(1 / 60);
    expect(h.flames[h.flames.length - 1]!.visible).toBe(false);
  });

  it('横风把火苗往顺风一侧吹歪；举着往迎风方向跑得够快，火苗往身后拖；护火挡风后立起来', async () => {
    const tilt = async (state: string, run = 0) => {
      const space = { light: [0, 100, 0] as Vec3, vfx: null };
      const h = withTable(harness(space));
      h.deps.windVectorAt = () => [FLAME_WU_PER_M * 1.5, 0, 0];
      await h.sys.attach('player', 'right_hand', 'sheet', state);
      for (let i = 0; i < 30; i++) {
        space.light = [space.light[0] + (FLAME_WU_PER_M * run) / 60, 100, 0];
        h.sys.update(1 / 60);
      }
      return h.flames[h.flames.length - 1]!.angleRad;
    };
    const open = await tilt('lit');
    const guarded = await tilt('guarding');
    const running = await tilt('lit', 5);
    expect(open).toBeGreaterThan(0.05);
    expect(guarded).toBeGreaterThan(0);
    expect(guarded).toBeLessThan(open);
    expect(running).toBeLessThan(-0.05);
  });
});

describe('🔴 能点火 = 此刻真的有火（制作人 2026-09-16：「要检测的是火，不是火头」）', () => {
  const table = parsePropPresets({
    torch: {
      image: 'stick.png',
      firePoint: [0.5, 0.05],
      igniter: { flameLength: 20 },
      light: { intensity: 1, flicker: { kind: 'flame', diameter: 0.1 } },
      playerControl: {},
      blowout: { windSpeed: 5, drainSeconds: 2, recoverSeconds: 4, emberBelow: 0.4, fadeMs: 0 },
      states: {
        lit: {},
        // 残炭：有微光，但明写点不了火
        ember: { light: { intensity: 0.2 }, igniter: null },
        out: { light: null },
        // 没灭、但这个状态不供燃料了
        starved: { burn: 0 },
      },
      persistent: true,
    },
    // 没有残炭线的火把：火势再低也不切状态，用来单看"时断时续"那一帧
    wick: {
      image: 'stick.png',
      firePoint: [0.5, 0.05],
      igniter: { flameLength: 20 },
      light: { intensity: 1, flicker: { kind: 'flame', diameter: 0.1 } },
      blowout: { windSpeed: 5, drainSeconds: 2, recoverSeconds: 600, emberBelow: 0, auto: false },
      states: { lit: {}, out: { light: null } },
      persistent: true,
    },
  });

  function h() {
    const x = harness({ light: [1, 2, 3], vfx: [1, 2, 3] });
    x.deps.getPreset = (id: string) => table[id];
    return x;
  }

  const segs = (x: ReturnType<typeof h>) => { const o: { len: number }[] = []; x.sys.igniterFireSegments(o as never); return o.length; };

  it('灭了的火把：点不了火，也不该有火焰段（不然纸钱会被一支灭火把点着）', async () => {
    const x = h();
    await x.sys.attach('player', 'right_hand', 'torch', 'out');
    x.sys.update(1 / 60);
    expect(x.sys.igniterOf('player')).toBeNull();
    expect(segs(x)).toBe(0);
    expect(x.sys.statusOf('player')[0].burning).toBe(false);
  });

  it('燃着的火把：点得了火、有火焰段', async () => {
    const x = h();
    await x.sys.attach('player', 'right_hand', 'torch', 'lit');
    x.sys.update(1 / 60);
    expect(x.sys.igniterOf('player')).not.toBeNull();
    expect(segs(x)).toBe(1);
    expect(x.sys.statusOf('player')[0].burning).toBe(true);
  });

  it('残炭（写了 igniter: null）点不了火', async () => {
    const x = h();
    // 火势留在残炭线（0.4）以下，否则挡住风就自己复燃回 lit
    await x.sys.attach('player', 'right_hand', 'torch', 'ember', {}, { vitality: 0.2 });
    x.sys.update(1 / 60);
    expect(x.sys.igniterOf('player')).toBeNull();
  });

  it('灯还亮着但这个状态不供燃料（燃烧强度 0）：不算有火', async () => {
    const x = h();
    await x.sys.attach('player', 'right_hand', 'torch', 'starved');
    x.sys.update(1 / 60);
    expect(x.sys.igniterOf('player')).toBeNull();
    expect(segs(x)).toBe(0);
  });

  it('火势被吹到 0：这一刻就点不了（不等状态切过去）', async () => {
    const x = h();
    await x.sys.attach('player', 'right_hand', 'torch', 'lit', {}, { vitality: 0 });
    x.sys.update(1 / 60);
    expect(x.sys.igniterOf('player')).toBeNull();
    expect(segs(x)).toBe(0);
  });

  it('快灭时时断时续：断着的那一帧火把看着没火，就点不着（燃着的帧照常能点）', async () => {
    const x = h();
    await x.sys.attach('player', 'right_hand', 'wick', 'lit', {}, { vitality: 0.05 });
    const e = [...(x.sys as unknown as { entries: Map<string, { gutterOn: boolean }> }).entries.values()][0];
    x.sys.update(1 / 60);
    e.gutterOn = false;
    expect(x.sys.igniterOf('player')).toBeNull();
    expect(segs(x)).toBe(0);
    e.gutterOn = true;
    expect(x.sys.igniterOf('player')).not.toBeNull();
  });
});
