import { describe, expect, it } from 'vitest';
import { resolveBurnable, type ResolvedBurnable } from '../../data/burnables';
import { resolveSceneWind } from '../../utils/sceneWind';
import { createPlanarVfxSpace } from '../vfx/vfxSpace';
import {
  buildBurnWorldGrid, burnEntityPlacement, burnPlacementFrame, burnSceneToUv, burnUvToScene, burnSceneToUvAffine, type BurnFrame,
} from './burnGeometry';
import {
  BurnSceneSim,
  buildBurnGrid,
  burnEventFromJson,
  burnEventToJson,
  burnSnapshotFromJson,
  createBurnCellQuery,
  type BurnExternalEvent,
  type BurnImageData,
  type BurnItemInput,
} from './burnSim';

/** 实心矩形图（整张不透明） */
function solidImage(w: number, h: number): BurnImageData {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  return { w, h, data };
}

function burnable(over: Record<string, unknown> = {}): ResolvedBurnable {
  const b = resolveBurnable({ id: 'b', image: '/x.png', widthCm: 100, heightCm: 100, mode: 'spread', orientation: 'upright', gridCells: 32, ...over });
  if (!b) throw new Error('burnable');
  return b;
}

const space = createPlanarVfxSpace();

function frame(x: number, y: number, w = 100, h = 100): BurnFrame {
  return burnPlacementFrame({ x, y, width: w, height: h, scale: 1, rotation: 0, flipX: false });
}

function item(key: string, b: ResolvedBurnable, f: BurnFrame, events: BurnExternalEvent[] = []): BurnItemInput {
  const img = solidImage(64, 64);
  return {
    key,
    burnable: b,
    grid: buildBurnGrid(b, img, null, null),
    worlds: [buildBurnWorldGrid(f, b.orientation, space)],
    events,
  };
}

const noWind = { wind: null, windTimeAt: (t: number) => t };

describe('burnGeometry', () => {
  it('uv ↔ 场景往返（含镜像 / 缩放 / 旋转），仿射与函数一致', () => {
    const f = burnPlacementFrame({ x: 300, y: 500, width: 80, height: 120, scale: 1.3, rotation: 0.4, flipX: true });
    for (const [u, v] of [[0, 0], [0.25, 0.75], [1, 1], [0.5, 1]]) {
      const s = burnUvToScene(f, u, v);
      const back = burnSceneToUv(f, s.x, s.y);
      expect(back.u).toBeCloseTo(u, 9);
      expect(back.v).toBeCloseTo(v, 9);
      const [a, b, c, d, tx, ty] = burnSceneToUvAffine(f);
      expect(a * s.x + b * s.y + tx).toBeCloseTo(u, 9);
      expect(c * s.x + d * s.y + ty).toBeCloseTo(v, 9);
    }
    // 底边中点就是脚点
    const foot = burnUvToScene(f, 0.5, 1);
    expect(foot.x).toBeCloseTo(300, 9);
    expect(foot.y).toBeCloseTo(500, 9);
  });

  it('实体锚点不在底中：锚点落在实体坐标上，接地点 = 底边中点（旋转 / 镜像后）', () => {
    const p = burnEntityPlacement({ x: 50, y: 80, scale: 2, rotation: 30, anchor: { x: 0.5, y: 0.5 } }, { width: 40, height: 20 }, { depthScale: 1, flipX: true });
    const f = burnPlacementFrame(p);
    const a = burnUvToScene(f, 0.5, 0.5);
    expect(a.x).toBeCloseTo(50, 9);
    expect(a.y).toBeCloseTo(80, 9);
    const bottom = burnUvToScene(f, 0.5, 1);
    expect(f.footX).toBeCloseTo(bottom.x, 9);
    expect(f.footY).toBeCloseTo(bottom.y, 9);
    // 镜像：u=0 在锚点右边（旋转 0 时）
    const g = burnPlacementFrame(burnEntityPlacement({ x: 0, y: 0 }, { width: 40, height: 20 }, { depthScale: 1, flipX: true }));
    expect(burnUvToScene(g, 0, 1).x).toBeCloseTo(20, 9);
  });

  it('直立摆法的格点投回画面落在展示图对应位置', () => {
    const f = frame(400, 600);
    const g = buildBurnWorldGrid(f, 'upright', space);
    const out = { x: 0, y: 0 };
    // 左上角 (u=0,v=0)
    space.toScene([g.pts[0], g.pts[1], g.pts[2]], out);
    const s = burnUvToScene(f, 0, 0);
    expect(out.x).toBeCloseTo(s.x, 6);
    expect(out.y).toBeCloseTo(s.y, 6);
  });
});

describe('BurnSceneSim · 面燃烧', () => {
  it('立着的纸从底部点着：往上烧得比沿底边往两边快（浮力顺流），烧出 V 形', () => {
    const b = burnable({ spread: { speedOpposed: 0.5, speedConcurrent: 6 }, flameSeconds: 1000, emberSeconds: 0 });
    const sim = new BurnSceneSim([item('a', b, frame(0, 0), [{ t: 0, k: 'ignite', u: 0.5, v: 0.98 }])], noWind, 0);
    sim.advanceTo(8);
    const grid = sim.grid('a')!;
    const q = sim.query('a', 'flame', createBurnCellQuery());
    // 烧到的最高行；底边那一行烧开了多宽；最高那一段有多宽（V 形：越往上越宽）
    let minJ = grid.ny;
    let bottomMin = grid.nx, bottomMax = -1;
    for (let k = 0; k < q.count; k++) {
      const c = q.cells[k];
      const i = c % grid.nx;
      const j = (c - i) / grid.nx;
      minJ = Math.min(minJ, j);
      if (j === grid.ny - 1) { bottomMin = Math.min(bottomMin, i); bottomMax = Math.max(bottomMax, i); }
    }
    const up = grid.ny - 1 - minJ;
    const bottomHalf = (bottomMax - bottomMin) / 2;
    expect(up).toBeGreaterThan(bottomHalf * 4);
    let topMin = grid.nx, topMax = -1;
    for (let k = 0; k < q.count; k++) {
      const c = q.cells[k];
      const i = c % grid.nx;
      const j = (c - i) / grid.nx;
      if (j === minJ + 2) { topMin = Math.min(topMin, i); topMax = Math.max(topMax, i); }
    }
    expect(topMax - topMin).toBeGreaterThan(bottomMax - bottomMin);
  });

  it('确定性：逐帧推与一次推到头逐位相同（含风）', () => {
    const wind = resolveSceneWind({ direction: [1, 0, 0.3], speed: 300, gust: { amount: 0.6, period: 4 }, turbulence: { intensity: 0.3, scale: 120 } } as never);
    const env = { wind, windTimeAt: (t: number) => t + 2 };
    const b = burnable({ orientation: 'ground', flameSeconds: 2, emberSeconds: 1 });
    const mk = (): BurnSceneSim => new BurnSceneSim(
      [item('a', b, frame(0, 400), [{ t: 0.3, k: 'ignite', u: 0.2, v: 0.5 }])], env, 0);
    const a = mk();
    for (let k = 1; k <= 1200; k++) a.advanceTo(k / 60 * 0.97);
    const c = mk();
    c.advanceTo(1200 / 60 * 0.97);
    const ta = new Uint8Array(32 * 32 * 4);
    const tc = new Uint8Array(32 * 32 * 4);
    a.encodeTexture('a', ta);
    c.encodeTexture('a', tc);
    expect(Buffer.from(ta).equals(Buffer.from(tc))).toBe(true);
    expect(a.state('a')).toBe(c.state('a'));
  });

  it('状态：没点 → 在烧 → 烧完；熄灭 = 灭了（剩燃料），复原 = 没点', () => {
    const b = burnable({ gridCells: 16, spread: { speedOpposed: 10, speedConcurrent: 20 }, flameSeconds: 0.5, emberSeconds: 0.5 });
    const changes: string[] = [];
    const sim = new BurnSceneSim([item('a', b, frame(0, 0), [{ t: 1, k: 'igniteAll' }])], noWind, 0);
    sim.setListener((k, from, to) => changes.push(`${from}>${to}`));
    sim.advanceTo(0.5);
    expect(sim.state('a')).toBe('unburnt');
    sim.advanceTo(1.2);
    expect(sim.state('a')).toBe('burning');
    sim.advanceTo(5);
    expect(sim.state('a')).toBe('burnt');
    expect(changes).toEqual(['unburnt>burning', 'burning>burnt']);

    const s2 = new BurnSceneSim([item('a', burnable({ gridCells: 32, spread: { speedOpposed: 0.5, speedConcurrent: 1 } }), frame(0, 0), [
      { t: 0, k: 'ignite', u: 0.5, v: 0.5 },
      { t: 5, k: 'extinguish' },
    ])], noWind, 0);
    s2.advanceTo(20);
    expect(s2.state('a')).toBe('out');
    s2.addEvent('a', { t: 21, k: 'reset' });
    s2.advanceTo(22);
    expect(s2.state('a')).toBe('unburnt');
  });

  it('跨可燃物蔓延：挨着的两张会引燃，隔得远的不会', () => {
    const b = burnable({ gridCells: 16, spread: { speedOpposed: 20, speedConcurrent: 40 }, flameSeconds: 5, emberSeconds: 1, flameLength: 30, ignitionDelay: 0.3 });
    // a 与 b 同一纵深、左右挨着（100 wu 宽，间距 2 wu）；c 远在 1000 wu 外
    const sim = new BurnSceneSim([
      item('a', b, frame(0, 0)),
      item('b', b, frame(102, 0)),
      item('c', b, frame(1200, 0)),
    ], noWind, 0);
    sim.addEvent('a', { t: 0, k: 'igniteAll' });
    sim.advanceTo(3);
    expect(sim.state('a')).toBe('burning');
    expect(sim.state('b')).toBe('burning');
    expect(sim.state('c')).toBe('unburnt');
  });

  it('跨可燃物蔓延按体积算：画面上挨着、脚点纵深差一截（小于宽）的立着的两堆也会引燃；纵深差远了不会', () => {
    const b = burnable({ gridCells: 16, spread: { speedOpposed: 20, speedConcurrent: 40 }, flameSeconds: 5, emberSeconds: 1, flameLength: 30, ignitionDelay: 0.3 });
    // 平面近似下脚点 y 差 6 wu ⇒ 纵深差 6·√2 ≈ 8.5 wu（< 两堆的半厚之和 100 wu）；d 的纵深差 ≈ 280 wu
    const sim = new BurnSceneSim([
      item('a', b, frame(0, 0)),
      item('b', b, frame(102, 6)),
      item('d', b, frame(-102, 200)),
    ], noWind, 0);
    sim.addEvent('a', { t: 0, k: 'igniteAll' });
    sim.advanceTo(3);
    expect(sim.state('b')).toBe('burning');
    expect(sim.state('d')).toBe('unburnt');
    // 躺在地上的（纵深半厚 0）：纵深差同样 8.5 wu 就碰不到
    const g = burnable({ gridCells: 16, orientation: 'ground', spread: { speedOpposed: 20, speedConcurrent: 40 }, flameSeconds: 5, emberSeconds: 1, flameLength: 2, ignitionDelay: 0.3 });
    const flat = new BurnSceneSim([item('a', g, frame(0, 0)), item('b', g, frame(0, 140))], noWind, 0);
    flat.addEvent('a', { t: 0, k: 'igniteAll' });
    flat.advanceTo(3);
    expect(flat.state('b')).toBe('unburnt');
  });

  it('存档事件 JSON 往返', () => {
    const evs: BurnExternalEvent[] = [
      { t: 1.25, k: 'ignite', u: 0.1, v: 0.9 }, { t: 2, k: 'igniteAll' }, { t: 3, k: 'extinguish' }, { t: 4, k: 'reset' },
      { t: 5, k: 'move', w: 2 }, { t: 6, k: 'appear' }, { t: 7, k: 'vanish' },
    ];
    for (const e of evs) expect(burnEventFromJson(JSON.parse(JSON.stringify(burnEventToJson(e))))).toEqual(e);
    expect(burnEventFromJson([1, 'q'])).toBeNull();
  });

  it('世界映射没到：事件留着不处理，到了之后按时刻补上，结果与一开始就有映射相同', () => {
    const b = burnable({ gridCells: 24 });
    const withWorld = new BurnSceneSim([item('a', b, frame(0, 0), [{ t: 0.5, k: 'ignite', u: 0.5, v: 0.9 }])], noWind, 0);
    withWorld.advanceTo(6);
    const inp = item('a', b, frame(0, 0), [{ t: 0.5, k: 'ignite', u: 0.5, v: 0.9 }]);
    const world = inp.worlds[0];
    const late = new BurnSceneSim([{ ...inp, worlds: [] }], noWind, 0);
    late.advanceTo(3);
    expect(late.ready).toBe(false);
    expect(late.state('a')).toBe('unburnt');
    late.setWorld('a', world);
    late.advanceTo(6);
    const t1 = new Uint8Array(24 * 24 * 4);
    const t2 = new Uint8Array(24 * 24 * 4);
    withWorld.encodeTexture('a', t1);
    late.encodeTexture('a', t2);
    expect(Buffer.from(t1).equals(Buffer.from(t2))).toBe(true);
  });
});

describe('BurnSceneSim · 挪位 / 出现 / 收掉 / 快照', () => {
  const spreadB = (): ResolvedBurnable => burnable({ gridCells: 16, spread: { speedOpposed: 20, speedConcurrent: 40 }, flameSeconds: 5, emberSeconds: 1, flameLength: 30, ignitionDelay: 0.3 });

  it('挪位事件：挪到挨着烧着的那张旁边才被引燃；活跑（中途 addWorld + 记事件）与重放逐位相同', () => {
    const b = spreadB();
    const far = buildBurnWorldGrid(frame(1200, 0), b.orientation, space);
    const near = buildBurnWorldGrid(frame(102, 0), b.orientation, space);
    const src = item('a', b, frame(0, 0), [{ t: 0, k: 'igniteAll' }]);
    const mover: BurnItemInput = { ...item('m', b, frame(1200, 0)), worlds: [far] };
    const live = new BurnSceneSim([src, mover], noWind, 0);
    for (let k = 1; k <= 60; k++) live.advanceTo(k / 60);
    expect(live.state('m')).toBe('unburnt');
    const w = live.addWorld('m', near);
    const applied = live.addEvent('m', { t: 1, k: 'move', w })!;
    for (let k = 61; k <= 300; k++) live.advanceTo(k / 60);
    expect(live.state('m')).toBe('burning');
    const replay = new BurnSceneSim([src, { ...mover, worlds: [far, near], events: [applied] }], noWind, 0);
    replay.advanceTo(5);
    const t1 = new Uint8Array(16 * 16 * 4);
    const t2 = new Uint8Array(16 * 16 * 4);
    live.encodeTexture('m', t1);
    replay.encodeTexture('m', t2);
    expect(Buffer.from(t1).equals(Buffer.from(t2))).toBe(true);
  });

  it('出现之前 / 收掉之后不在世界里：不被点着；出现 = 新实例', () => {
    const b = spreadB();
    const sim = new BurnSceneSim([
      item('a', b, frame(0, 0), [{ t: 0, k: 'igniteAll' }]),
      item('s', b, frame(102, 0), [{ t: 10, k: 'appear' }]),
    ], noWind, 0);
    sim.advanceTo(3);
    expect(sim.isPresent('s')).toBe(false);
    expect(sim.state('s')).toBe('unburnt');
    sim.advanceTo(10.5);
    expect(sim.isPresent('s')).toBe(true);
    sim.advanceTo(20);
    expect(sim.state('s')).toBe('unburnt');
    sim.addEvent('s', { t: 21, k: 'vanish' });
    sim.addEvent('s', { t: 22, k: 'igniteAll' });
    sim.advanceTo(25);
    expect(sim.state('s')).toBe('unburnt');
  });

  it('快照：从快照接着推 == 不打断一直推（面燃烧 / 消耗燃烧），JSON 往返无损', () => {
    const cases: [ResolvedBurnable, BurnExternalEvent][] = [
      [burnable({ gridCells: 24, spread: { speedOpposed: 1, speedConcurrent: 5 }, flameSeconds: 2, emberSeconds: 1 }), { t: 0.2, k: 'ignite', u: 0.5, v: 0.9 }],
      [burnable({ mode: 'consume', gridCells: 16, consume: { seconds: 30 }, flameSeconds: 1 }), { t: 0.2, k: 'igniteAll' }],
    ];
    for (const [b, ev] of cases) {
      const whole = new BurnSceneSim([item('h', b, frame(0, 0), [ev])], noWind, 0);
      whole.advanceTo(9);
      const first = new BurnSceneSim([item('h', b, frame(0, 0), [ev])], noWind, 0);
      first.advanceTo(4);
      const snap = burnSnapshotFromJson(JSON.parse(JSON.stringify(first.exportSnapshot('h'))));
      expect(snap).not.toBeNull();
      const resumed = new BurnSceneSim([{ ...item('h', b, frame(0, 0)), snapshot: snap }], noWind, snap!.t);
      resumed.advanceTo(9);
      expect(resumed.state('h')).toBe(whole.state('h'));
      const n = b.gridCells * b.gridCells * 4;
      const t1 = new Uint8Array(n);
      const t2 = new Uint8Array(n);
      whole.encodeTexture('h', t1);
      resumed.encodeTexture('h', t2);
      expect(Buffer.from(t1).equals(Buffer.from(t2))).toBe(true);
      expect(resumed.shaderClock('h')).toEqual(whole.shaderClock('h'));
    }
  });
});

describe('BurnSceneSim · 消耗燃烧', () => {
  it('蜡烛从上往下烧，烧到头 = 烧完；火苗格往下走', () => {
    const b = burnable({ mode: 'consume', gridCells: 20, consume: { seconds: 40, from: 'top' }, flameSeconds: 2, emberSeconds: 0 });
    const sim = new BurnSceneSim([item('c', b, frame(0, 0, 20, 100), [{ t: 0, k: 'ignite', u: 0.5, v: 0 }])], noWind, 0);
    sim.advanceTo(1);
    const g = sim.grid('c')!;
    const c1 = sim.flameCell('c');
    sim.advanceTo(20);
    const c2 = sim.flameCell('c');
    const row = (c: number): number => Math.floor(c / g.nx);
    expect(row(c2)).toBeGreaterThan(row(c1));
    expect(sim.state('c')).toBe('burning');
    sim.advanceTo(50);
    expect(sim.state('c')).toBe('burnt');
  });

  it('吹熄：风大火势掉光自己灭，剩下的燃料记着；再点接着烧', () => {
    const wind = resolveSceneWind({ direction: [1, 0, 0], speed: 88 * 20, gust: { amount: 0 } } as never);
    const env = { wind, windTimeAt: (t: number) => t };
    const b = burnable({
      mode: 'consume', gridCells: 16, consume: { seconds: 100 }, flameSeconds: 1,
      blowout: { windSpeed: 1, drainSeconds: 0.5, recoverSeconds: 1 },
    });
    // 蜡烛高高立着（风的对数廓线在高处才有量）
    const f = frame(0, 0, 20, 400);
    const sim = new BurnSceneSim([item('c', b, f, [{ t: 0, k: 'igniteAll' }])], env, 0);
    sim.advanceTo(5);
    expect(sim.state('c')).toBe('out');
    const consumed = sim.debugItem('c')!.consumed;
    expect(consumed).toBeGreaterThan(0);
    expect(consumed).toBeLessThan(5);
  });
});
