/**
 * 燃烧系统（记录 / 模拟 / 存读档 / 离场照推 / 信号），可燃物 = 模板、宿主引用它 = 实例：
 * - 读档接着烧 == 一直没存读过（逐项相同），读档不重发已经发过的信号；
 * - 离场照推：状态与信号照常，读档后离场的场景后台重建、到点照样烧完；
 * - 推不出来（模板改了而场景里有过火）⇒ 整场有过去的收束成烧完，没点过的不动；
 * - 宿主挪了 = 挪位事件（有过去才记；读档重放逐位相同）；演出生成 / 收掉 = 出现 / 收掉事件；
 * - 手上的可燃挂件：初始起火、收起来熄灭并记成包里那根、重挂接着烧、切场景接着烧、存读档接着烧、当点火的火 / 引火；
 * - 复原不截断日志；场景 onEnter 期间（模板还在路上）来的动作排队不丢；纸钱记录读档期间不收。
 */
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../core/EventBus';
import { burnableJsonUrl } from '../../core/projectPaths';
import type { GameContext, SceneData } from '../../data/types';
import { createPlanarVfxSpace } from '../vfx/vfxSpace';
import type { ConditionEvalContext } from '../graphDialogue/evaluateGraphCondition';
import { BurnSystem, type BurnEntityHost, type BurnHeldHost, type BurnSystemDeps } from './BurnSystem';
import { burnEntityPlacement, burnPlacementFrame } from './burnGeometry';
import type { BurnImageData } from './burnSim';

const DT = 1 / 60;
const CM = 1 / 0.88;

function solid(w: number, h: number): BurnImageData {
  return { w, h, data: new Uint8ClampedArray(w * h * 4).fill(255) };
}

type HotspotLike = { id: string; x: number; y: number; burnable?: Record<string, unknown> };

interface World {
  burnables: Record<string, Record<string, unknown>>;
  scenes: Record<string, SceneData>;
}

function world(): World {
  const hs = (id: string, x: number, template: string, extra: Record<string, unknown> = {}): HotspotLike => ({
    id, x, y: 300, burnable: { template, ...extra },
  });
  return {
    burnables: {
      candle: {
        id: 'candle', image: '/img/candle.png', widthCm: 20 * CM, heightCm: 60 * CM,
        mode: 'consume', orientation: 'upright', gridCells: 16, consume: { seconds: 4 },
      },
      paper: {
        id: 'paper', image: '/img/paper.png', widthCm: 60 * CM, heightCm: 60 * CM, mode: 'spread', orientation: 'upright', gridCells: 16,
        flameSeconds: 0.6, emberSeconds: 0.6, spread: { speedOpposed: 20, speedConcurrent: 60 }, flameLength: 12, ignitionDelay: 0.2,
      },
      incense: {
        id: 'incense', image: '/img/candle.png', widthCm: 4, heightCm: 30, grip: { u: 0.5, v: 0.9 },
        mode: 'consume', orientation: 'upright', gridCells: 16, consume: { seconds: 20 }, flameSeconds: 1,
        ignitionPoints: [{ id: 'tip', u: 0.5, v: 0.05 }],
      },
    },
    scenes: {
      sA: {
        id: 'sA', worldWidth: 2000, worldHeight: 1000,
        hotspots: [
          hs('candle', 100, 'candle', { initial: 'burning', signals: { ignited: 'c_on', burntOut: 'c_out' } }),
          hs('paper', 600, 'paper', { signals: { ignited: 'p_on', burntOut: 'p_out' } }),
          // 与 paper 挨着：paper 烧起来会蔓延过来
          hs('paper2', 655, 'paper', { signals: { ignited: 'p2_on', burntOut: 'p2_out' } }),
        ],
      } as unknown as SceneData,
      sB: { id: 'sB', worldWidth: 1000, worldHeight: 1000, hotspots: [] } as unknown as SceneData,
    },
  };
}

function harness(w: World) {
  const bus = new EventBus();
  const signals: { signal: string; owner: string; clock: number }[] = [];
  const changes: { sceneId: string | null; target: string; socket?: string; to: string; clock: number }[] = [];
  let current: SceneData | null = null;
  const space = createPlanarVfxSpace();
  const hostCache = new Map<object, BurnEntityHost>();
  /** 演出生成的（不在场景 JSON 里） */
  const spawned: HotspotLike[] = [];
  const held: BurnHeldHost[] = [];
  const hostOf = (def: HotspotLike): BurnEntityHost => {
    let h = hostCache.get(def);
    if (!h) {
      h = {
        id: def.id, kind: 'hotspot',
        get burnable() { return def.burnable; },
        frame: (size) => burnPlacementFrame(burnEntityPlacement(def, size, { depthScale: 1, flipX: false })),
        active: true,
        render: { kind: 'filters', host: { setBurnFilters: () => {} } },
        container: {} as never,
      };
      hostCache.set(def, h);
    }
    return h;
  };
  const deps: BurnSystemDeps = {
    loadJson: async <T>(url: string) => {
      for (const [id, b] of Object.entries(w.burnables)) if (url === burnableJsonUrl(id)) return JSON.parse(JSON.stringify(b)) as T;
      throw new Error(`404 ${url}`);
    },
    dropJson: () => {},
    loadImageData: async (url) => (url === '/img/candle.png' ? solid(16, 48) : url === '/img/paper.png' ? solid(32, 32) : null),
    getSceneData: () => current,
    loadSceneData: async (id) => w.scenes[id] ?? null,
    sceneBurnables: (_sid, scene) => ((scene.hotspots ?? []) as unknown as HotspotLike[])
      .filter((x) => x.burnable).map((x) => ({ id: x.id, burnable: x.burnable })),
    liveEntities: () => {
      if (!current) return [];
      const defs = [...((current.hotspots ?? []) as unknown as HotspotLike[]), ...spawned];
      return defs.filter((x) => x.burnable).map(hostOf);
    },
    liveHeld: () => held,
    getSpace: () => space as unknown as ReturnType<BurnSystemDeps['getSpace']>,
    isSpaceFinal: () => true,
    windClock: () => 0,
    conditionContext: () => ({}) as ConditionEvalContext,
    vfx: {
      playVfx: () => null, stopVfxSoft: () => {}, moveInstanceAnchor: () => true, setInstanceSpawnPoints: () => {},
      setInstanceRateScale: () => {}, setInstanceSortHost: () => {}, setFireSources: () => {}, burningPlates: () => [],
      burningPlateSlots: () => [],
    },
    setDynamicLights: () => {},
    emitSignal: (signal, owner) => { signals.push({ signal, owner, clock: sys.debugStats.clock }); },
    log: () => {},
  };
  const sys = new BurnSystem(deps);
  sys.init({ eventBus: bus } as unknown as GameContext);
  bus.on('burn:changed', (p: { sceneId: string | null; target: string; socket?: string; to: string }) => {
    if (p.target) changes.push({ ...p, clock: sys.debugStats.clock });
  });
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };
  return {
    sys, bus, signals, changes, flush, spawned, held,
    /** 切场景：beforeUnload → 换数据 → scene:ready（不等异步） */
    enter(id: string) {
      if (current) bus.emit('scene:beforeUnload');
      current = w.scenes[id];
      bus.emit('scene:ready');
    },
    hotspot(id: string): HotspotLike {
      return ((current?.hotspots ?? []) as unknown as HotspotLike[]).find((x) => x.id === id)!;
    },
    /** 给 player 手上挂一件可燃挂件（摆在 (x, 300) 立着） */
    hold(prop: string, template: string, x = 900, extra: Record<string, unknown> = {}): BurnHeldHost {
      const host: BurnHeldHost = {
        target: 'player', socket: 'right_hand', prop, burnable: { template, ...extra },
        frame: () => burnPlacementFrame({ x, y: 300, width: 4 / CM, height: 30 / CM, scale: 1, rotation: 0, flipX: false }),
        render: { kind: 'texture', host: { burnBaseTexture: () => null, setBurnTextures: () => {} } },
        container: {} as never,
      };
      held.splice(0, held.length, host);
      return host;
    },
    unhold() { held.splice(0, held.length); },
    run(seconds: number) { const n = Math.round(seconds / DT); for (let i = 0; i < n; i++) sys.update(DT); },
    snapshot() {
      return sys.debugSnapshot().map((s) => ({ ...s }))
        .sort((a, b) => (`${a.kind}${a.sceneId}${a.target}` < `${b.kind}${b.sceneId}${b.target}` ? -1 : 1));
    },
  };
}

function roundtrip(sys: BurnSystem): Record<string, unknown> {
  return JSON.parse(JSON.stringify(sys.serialize())) as Record<string, unknown>;
}

describe('BurnSystem · 场景实例', () => {
  it('第一次进场：初始在烧的点着、发一次信号；蔓延到挨着的；烧完发烧完', async () => {
    const h = harness(world());
    h.enter('sA');
    await h.flush();
    h.run(0.1);
    expect(h.sys.statusOf('candle')).toBe('burning');
    expect(h.signals.map((s) => s.signal)).toEqual(['c_on']);
    expect(h.signals[0].owner).toBe('candle');
    expect(h.sys.igniteBurnable('paper')).toBe(true);
    h.run(3);
    expect(h.sys.statusOf('paper2')).not.toBe('unburnt');
    h.run(6);
    expect(h.sys.statusOf('candle')).toBe('burnt');
    expect(h.sys.statusOf('paper')).toBe('burnt');
    expect(h.sys.statusOf('paper2')).toBe('burnt');
    const names = h.signals.map((s) => s.signal);
    for (const s of ['c_on', 'c_out', 'p_on', 'p_out', 'p2_on', 'p2_out']) expect(names.filter((x) => x === s)).toHaveLength(1);
  });

  it('读档接着烧 == 一直没存读过；读档不重发信号', async () => {
    const w = world();
    const a = harness(w);
    a.enter('sA');
    await a.flush();
    a.run(0.5);
    a.sys.igniteBurnable('paper');
    a.run(0.8);
    const save = roundtrip(a.sys);
    const signalsAtSave = a.signals.length;

    const b = harness(w);
    b.sys.deserialize(save);
    b.enter('sA');
    await b.flush();
    a.run(2);
    b.run(2);
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(b.signals.map((s) => s.signal)).toEqual(a.signals.slice(signalsAtSave).map((s) => s.signal));
    expect(b.signals.map((s) => s.signal)).not.toContain('c_on');
    expect(b.signals.map((s) => s.signal)).not.toContain('p_on');
  });

  it('离场照推：离开后到点烧完、信号照发；读档后离场的场景后台重建，同一时刻烧完', async () => {
    const w = world();
    const a = harness(w);
    a.enter('sA');
    await a.flush();
    a.run(1);
    a.enter('sB');
    await a.flush();
    a.run(0.2);
    const save = roundtrip(a.sys);

    const b = harness(w);
    b.sys.deserialize(save);
    b.enter('sB');
    await b.flush();

    // 蜡烛总长 = seconds 4 + 火线带 flameSeconds 3
    a.run(7);
    b.run(7);
    expect(a.sys.statusOf('candle', 'sA')).toBe('burnt');
    expect(b.sys.statusOf('candle', 'sA')).toBe('burnt');
    const outA = a.changes.find((c) => c.target === 'candle' && c.to === 'burnt')!;
    const outB = b.changes.find((c) => c.target === 'candle' && c.to === 'burnt')!;
    expect(outB.clock).toBe(outA.clock);
    expect(a.signals.filter((s) => s.signal === 'c_out')).toHaveLength(1);
    expect(b.signals.map((s) => s.signal)).toEqual(['c_out']);
  });

  it('模板改了而场景里有过火 ⇒ 整场有过去的切烧完（被蔓延点着的也算），没点过的不动', async () => {
    const w = world();
    // 第三张纸离得远，从来没点过
    (w.scenes.sA.hotspots as unknown as HotspotLike[]).push({ id: 'paper3', x: 1500, y: 300, burnable: { template: 'paper' } });
    const a = harness(w);
    a.enter('sA');
    await a.flush();
    a.run(0.2);
    a.sys.igniteBurnable('paper');
    a.run(1.5);
    expect(a.sys.statusOf('paper2')).toBe('burning');
    const save = roundtrip(a.sys);
    const savedStates = Object.fromEntries(['candle', 'paper', 'paper2'].map((k) => [k, a.sys.statusOf(k)]));

    const w2 = JSON.parse(JSON.stringify(w)) as World;
    w2.scenes = w.scenes;
    (w2.burnables.candle.consume as Record<string, unknown>).seconds = 5;
    const b = harness(w2);
    b.sys.deserialize(save);
    b.enter('sA');
    await b.flush();
    b.run(DT);
    expect(b.sys.statusOf('candle')).toBe('burnt');
    expect(b.sys.statusOf('paper')).toBe('burnt');
    expect(b.sys.statusOf('paper2')).toBe('burnt');
    expect(b.sys.statusOf('paper3')).toBe('unburnt');
    const sig: Record<string, string> = { candle: 'c_out', paper: 'p_out', paper2: 'p2_out' };
    const want = Object.entries(savedStates).filter(([, st]) => st !== 'burnt').map(([k]) => sig[k]).sort();
    expect(want).toContain('c_out');
    expect(want).toContain('p2_out');
    expect(b.signals.map((s) => s.signal).sort()).toEqual(want);
    expect(b.sys.igniteBurnable('paper3')).toBe(true);
    b.run(0.5);
    expect(b.sys.statusOf('paper3')).toBe('burning');
  });

  it('复原不截断日志（它复原之前点着过别人，重放要用）', async () => {
    const h = harness(world());
    h.enter('sA');
    await h.flush();
    h.run(0.2);
    h.sys.igniteBurnable('paper');
    h.run(0.5);
    h.sys.resetBurnable('paper');
    h.run(0.1);
    expect(h.sys.statusOf('paper')).toBe('unburnt');
    const save = h.sys.serialize() as { scenes: Record<string, { items: Record<string, { ev: unknown[] }> }> };
    expect(save.scenes.sA.items.paper.ev).toHaveLength(2);
  });

  it('场景 onEnter（模板还在路上）来的动作排队、建好后生效；离场后不是这个场景的可燃实体：拒绝', async () => {
    const h = harness(world());
    h.enter('sA');
    expect(h.sys.igniteBurnable('paper')).toBe(true);
    await h.flush();
    h.run(0.3);
    expect(h.sys.statusOf('paper')).toBe('burning');
    h.enter('sB');
    await h.flush();
    expect(h.sys.igniteBurnable('paper')).toBe(false);
  });

  it('纸钱：烧没了的记下来（读档期间——旧场景收粒子那一刻报上来的——不收），读档后还在', async () => {
    const w = world();
    const h = harness(w);
    h.enter('sA');
    await h.flush();
    h.sys.onPlatesBurnt('inst', 0, [3, 5]);
    expect([...(h.sys.burntPlatesOf('inst') ?? new Map())]).toEqual([[0, [3, 5]]]);
    const save = roundtrip(h.sys);
    const b = harness(w);
    b.enter('sA');
    await b.flush();
    b.bus.emit('save:restoring');
    b.sys.deserialize(save);
    b.sys.onPlatesBurnt('inst', 0, [9]);
    b.enter('sA');
    await b.flush();
    expect([...(b.sys.burntPlatesOf('inst') ?? new Map())]).toEqual([[0, [3, 5]]]);
  });

  it('条件叶：场景建好之前按宿主配的初始状态回答；不是可燃实例 ⇒ null；别的场景没装过的，装好后回答', async () => {
    const h = harness(world());
    await h.flush();
    h.enter('sA');
    expect(h.sys.statusOf('candle', 'sA')).toBe('burning');
    expect(h.sys.statusOf('paper', 'sA')).toBe('unburnt');
    expect(h.sys.statusOf('nope', 'sA')).toBeNull();
    const fresh = harness(world());
    expect(fresh.sys.statusOf('candle', 'sA')).toBeNull();
    await fresh.flush();
    expect(fresh.sys.statusOf('candle', 'sA')).toBe('burning');
  });

  it('引火：只有正在烧、有明火的能引；瞄的是离火头最近的明火（在它的画面范围里）', async () => {
    const h = harness(world());
    h.enter('sA');
    await h.flush();
    h.run(0.3);
    expect(h.sys.canRelightFrom('candle')).toBe(true);
    expect(h.sys.canRelightFrom('paper')).toBe(false);
    expect(h.sys.relightTarget('paper', { x: 600, y: 250 })).toBeNull();
    const at = h.sys.relightTarget('candle', { x: 300, y: 250 })!;
    expect(at.x).toBeGreaterThanOrEqual(90);
    expect(at.x).toBeLessThanOrEqual(110);
    expect(at.y).toBeGreaterThanOrEqual(240);
    expect(at.y).toBeLessThanOrEqual(300);
    h.run(8);
    expect(h.sys.statusOf('candle')).toBe('burnt');
    expect(h.sys.canRelightFrom('candle')).toBe(false);
  });

  it('实例按模板真实尺寸摆：同一份模板摆两处，大小一样（不看宿主自己的展示图）', async () => {
    const h = harness(world());
    h.enter('sA');
    await h.flush();
    h.run(0.1);
    const a = h.sys.playerIgniteTarget('paper', { x: 600, y: 280 })!;
    const b = h.sys.playerIgniteTarget('paper2', { x: 655, y: 280 })!;
    // 没标着火点 ⇒ 燃料中间，模板 60 wu 高 ⇒ 中间在脚点上方 30 wu
    expect(a.scene.y).toBeCloseTo(270, 0);
    expect(b.scene.y).toBeCloseTo(a.scene.y, 6);
    expect(b.scene.x - a.scene.x).toBeCloseTo(55, 6);
  });
});

describe('BurnSystem · 挪位 / 生成 / 收掉', () => {
  it('场景没有任何过去时挪了不记事件；有过去之后挪了记挪位，读档重放逐位相同', async () => {
    const w = world();
    w.scenes.sA.hotspots = ((w.scenes.sA.hotspots ?? []) as unknown as HotspotLike[])
      .map((x) => (x.id === 'candle' ? { ...x, burnable: { template: 'candle' } } : x)) as never;
    const a = harness(w);
    a.enter('sA');
    await a.flush();
    a.run(0.2);
    a.hotspot('paper2').x = 1200;   // 挪远（场景里还谁都没烧过）
    a.run(0.2);
    let save = a.sys.serialize() as { scenes: Record<string, { items: Record<string, { ev: unknown[]; w: unknown[] }> }> };
    expect(save.scenes.sA.items.paper2.ev).toHaveLength(0);
    expect(save.scenes.sA.items.paper2.w).toHaveLength(1);
    a.sys.igniteBurnable('paper');   // 没标着火点 ⇒ 整张一起着，明火 0.6 s
    a.run(0.25);
    expect(a.sys.statusOf('paper')).toBe('burning');
    expect(a.sys.statusOf('paper2')).toBe('unburnt');
    a.hotspot('paper2').x = 655;    // 趁明火还在，挪回挨着正在烧的那张
    a.run(1);
    expect(a.sys.statusOf('paper2')).not.toBe('unburnt');
    save = a.sys.serialize() as typeof save;
    expect(save.scenes.sA.items.paper2.ev.some((e) => Array.isArray(e) && e[1] === 'm')).toBe(true);
    const mid = roundtrip(a.sys);

    const b = harness(w);
    b.sys.deserialize(mid);
    b.enter('sA');
    await b.flush();
    a.run(2);
    b.run(2);
    expect(b.snapshot()).toEqual(a.snapshot());
  });

  it('演出生成：出现之前不在；出现记事件、按 initial 起火；收掉之后条件叶为 null，读档后照样', async () => {
    const w = world();
    const h = harness(w);
    h.enter('sA');
    await h.flush();
    h.run(0.2);
    expect(h.sys.statusOf('coin')).toBeNull();
    h.spawned.push({ id: 'coin', x: 1400, y: 300, burnable: { template: 'paper', initial: 'burning' } });
    h.run(0.1);
    await h.flush();
    h.run(0.3);
    expect(h.sys.statusOf('coin')).toBe('burning');
    const save = h.sys.serialize() as { scenes: Record<string, { items: Record<string, { ev: unknown[] }> }> };
    expect((save.scenes.sA.items.coin.ev[0] as unknown[])[1]).toBe('+');
    h.spawned.splice(0, 1);
    h.run(0.1);
    expect(h.sys.statusOf('coin')).toBeNull();
    const back = harness(w);
    back.sys.deserialize(roundtrip(h.sys));
    back.enter('sA');
    await back.flush();
    back.run(0.1);
    expect(back.sys.statusOf('coin')).toBeNull();
  });
});

describe('BurnSystem · 手上的可燃挂件', () => {
  it('挂上：按 initial 起火、发信号（owner = 拿着它的人）；当点火的火；收起来 = 熄灭 + 记成包里那根，再拿出来接着烧', async () => {
    const h = harness(world());
    h.enter('sB');
    await h.flush();
    h.hold('xiang', 'incense', 900, { initial: 'burning', signals: { ignited: 'x_on', extinguished: 'x_off' } });
    h.run(0.1);
    await h.flush();
    h.run(2);
    expect(h.sys.statusOf('player', undefined, 'right_hand')).toBe('burning');
    expect(h.signals.find((s) => s.signal === 'x_on')?.owner).toBe('player');
    const ig = h.sys.heldIgniterOf('player');
    expect(ig?.socket).toBe('right_hand');
    expect(ig!.v).toBeLessThan(0.3);
    const consumedBefore = (h.snapshot().find((s) => s.kind === 'held')!.detail as { consumed: number }).consumed;
    h.sys.onHeldRemoved('player', 'right_hand', 'xiang');
    h.unhold();
    h.run(1);
    expect(h.sys.statusOf('player', undefined, 'right_hand')).toBeNull();
    expect(h.signals.some((s) => s.signal === 'x_off')).toBe(true);
    h.run(5);   // 包里不烧
    h.hold('xiang', 'incense', 900, { initial: 'burning' });
    h.run(0.1);
    await h.flush();
    h.run(0.1);
    expect(h.sys.statusOf('player', undefined, 'right_hand')).toBe('out');
    const again = (h.snapshot().find((s) => s.kind === 'held')!.detail as { consumed: number }).consumed;
    expect(again).toBeCloseTo(consumedBefore, 1);
    // 灭着的可燃挂件能引火；引火点着
    expect(h.sys.heldRelightTipOf('player')?.v).toBeCloseTo(0.05, 6);
    expect(h.sys.relightHeld('player')).toBe(true);
    h.run(0.2);
    expect(h.sys.statusOf('player', undefined, 'right_hand')).toBe('burning');
  });

  it('切场景整批卸下再重挂：接着烧（不熄灭）；存读档：接着烧', async () => {
    const w = world();
    const h = harness(w);
    h.enter('sB');
    await h.flush();
    h.hold('xiang', 'incense', 900, { initial: 'burning' });
    h.run(0.1);
    await h.flush();
    h.run(1);
    h.unhold();          // 切场景：挂件系统整批卸下（不走 onHeldRemoved）
    h.enter('sA');
    await h.flush();
    h.hold('xiang', 'incense', 900, { initial: 'burning' });
    h.run(0.1);
    await h.flush();
    h.run(0.5);
    expect(h.sys.statusOf('player', undefined, 'right_hand')).toBe('burning');
    const save = roundtrip(h.sys);
    const b = harness(w);
    b.sys.deserialize(save);
    b.enter('sA');
    await b.flush();
    b.hold('xiang', 'incense', 900, { initial: 'burning' });
    b.run(DT);
    await b.flush();
    const da = h.snapshot().find((s) => s.kind === 'held')!.detail as { consumed: number };
    b.run(0);
    const db = b.snapshot().find((s) => s.kind === 'held')!.detail as { consumed: number };
    expect(db.consumed).toBeGreaterThan(0);
    expect(Math.abs(db.consumed - da.consumed)).toBeLessThan(0.2);
    expect(b.sys.statusOf('player', undefined, 'right_hand')).toBe('burning');
  });

  it('手上的可燃挂件不会自己碰着场景里的可燃物', async () => {
    const h = harness(world());
    h.enter('sA');
    await h.flush();
    // 拿着燃着的香贴在纸堆上
    h.hold('xiang', 'incense', 600, { initial: 'burning' });
    h.run(0.1);
    await h.flush();
    h.run(3);
    expect(h.sys.statusOf('player', undefined, 'right_hand')).toBe('burning');
    expect(h.sys.statusOf('paper')).toBe('unburnt');
  });
});
