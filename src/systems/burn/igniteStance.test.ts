/**
 * 点火站位：纯数据版（燃烧工作台用）与游戏里实体版（`SpriteEntity.predictAttachmentPointOffset`）逐位相同；
 * 解出的站位让接触帧火头落在着火点上（残差 ≈ 0，含透视系数随脚点变）；点火表演的拒绝 / 中止路径把状态还回来。
 */
import { describe, expect, it } from 'vitest';
import { Sprite, Texture, TextureSource } from 'pixi.js';
import { SpriteEntity } from '../../rendering/SpriteEntity';
import { GameState, type AnimationSetDef, type SocketFramePose } from '../../data/types';
import { igniteContactOf, igniteStancesFor, igniteTipOffset, type IgniteStanceData } from './igniteStance';
import { IgnitePerformer, solveIgniteStance, type IgnitePerformerDeps } from './ignitePerformer';

const CELL_W = 32;
const CELL_H = 48;

function anim(): AnimationSetDef {
  return {
    spritesheet: 'x.png', cols: 3, rows: 1, cellWidth: CELL_W, cellHeight: CELL_H,
    worldWidth: 148, worldHeight: 150,
    states: { idle: { frames: [0, 1], frameRate: 8, loop: true }, light: { frames: [0, 2, 1], frameRate: 8, loop: false } },
  };
}

const poses: Record<string, SocketFramePose> = {
  '0': { x: 0.6, y: 0.5, angle: 80 },
  '1': { x: 0.62, y: 0.52, angle: 85 },
  '2': { x: 0.8, y: 0.45, angle: 30 },
};

const attach = { scale: 0.26, anchorX: 0.5, anchorY: 0.85, rotationOffsetDeg: -35, texW: 60, texH: 240 };

function data(): IgniteStanceData {
  return {
    anim: { worldWidth: 148, worldHeight: 150, states: anim().states },
    stateMap: { ignite: 'light' },
    sockets: { sockets: { right_hand: { poses } }, igniteSlots: [2] },
    socket: 'right_hand', logical: 'ignite', attach, u: 0.455, v: 0.04,
  };
}

function entity(): SpriteEntity {
  const e = new SpriteEntity();
  const tex = new Texture({ source: new TextureSource({ width: CELL_W * 3, height: CELL_H }) });
  e.loadFromDef(tex, anim(), {
    stale: false,
    set: { schemaVersion: 1, atlas: { cols: 3, rows: 1, slotCount: 3 }, sockets: { right_hand: { poses } }, contactSlots: [], igniteSlots: [2] },
  });
  e.setLogicalStateMap({ ignite: 'light' });
  e.playAnimation('idle');
  const view = new Sprite(new Texture({ source: new TextureSource({ width: attach.texW, height: attach.texH }) }));
  e.attachToSocket('right_hand', { view, scale: attach.scale, anchorX: attach.anchorX, anchorY: attach.anchorY, rotationOffsetDeg: attach.rotationOffsetDeg });
  return e;
}

describe('点火站位', () => {
  it('接触帧：igniteSlots 标的那一格在片段里第几帧（经 stateMap）', () => {
    expect(igniteContactOf(data())).toEqual({ clip: 'light', frame: 1, slot: 2, marked: true });
    expect(entity().igniteContactFrame('ignite')).toEqual({ frame: 1, marked: true, frameCount: 3 });
  });

  it('纯数据版火头偏移 == 实体版（两个朝向、三档透视系数）', () => {
    const d = data();
    const contact = igniteContactOf(d)!;
    const e = entity();
    for (const facing of [1, -1] as const) {
      for (const depth of [1, 0.7, 1.3]) {
        const a = igniteTipOffset(d, contact, facing, depth)!;
        const b = e.predictAttachmentPointOffset('right_hand', d.u, d.v, { logicalState: 'ignite', frameIndex: contact.frame, facing, depthScale: depth })!;
        expect(a.x).toBeCloseTo(b.x, 10);
        expect(a.y).toBeCloseTo(b.y, 10);
      }
    }
  });

  it('解出的站位：接触帧火头正落在着火点上（透视系数随脚点变也收敛）', () => {
    const d = data();
    const target = { x: 500, y: 300 };
    const persp = (_x: number, y: number) => 0.5 + y / 1000;
    const { right, left } = igniteStancesFor(d, target, persp);
    for (const s of [right!, left!]) {
      const tip = igniteTipOffset(d, igniteContactOf(d)!, s.facing, persp(s.x, s.y))!;
      expect(Math.hypot(s.x + tip.x - target.x, s.y + tip.y - target.y)).toBeLessThan(1e-6);
      expect(s.residual).toBeLessThan(1e-6);
    }
    // 朝右点时人在着火点左边，朝左点时在右边
    expect(right!.x).toBeLessThan(target.x);
    expect(left!.x).toBeGreaterThan(target.x);
  });

  it('这一帧没标挂点 ⇒ 解不出（null）', () => {
    const d = data();
    delete d.sockets.sockets.right_hand.poses['2'];
    expect(solveIgniteStance({ x: 0, y: 0 }, { x: 0, y: 0 }, 1, {
      tipOffset: (f, depth) => igniteTipOffset(d, igniteContactOf(d)!, f, depth), depthScaleAt: () => 1,
    })).toBeNull();
  });
});

describe('点火表演（拒绝 / 中止路径）', () => {
  function harness(over: Partial<IgnitePerformerDeps> = {}) {
    let state = GameState.Exploring;
    let frame = 0;
    let playing = '';
    const ignited: string[] = [];
    let moveResolve: (() => void) | null = null;
    let cancelled = 0;
    const deps: IgnitePerformerDeps = {
      getState: () => state,
      setState: (s) => { state = s; },
      switching: () => false,
      player: {
        pos: () => ({ x: 100, y: 100 }),
        facing: () => 1,
        setFacing: () => {},
        moveTo: () => new Promise<void>((r) => { moveResolve = r; }),
        cancelMotion: () => { cancelled++; moveResolve?.(); },
        walkSpeed: () => 100,
        hasLogicalState: () => true,
        playOnce: (logical) => { playing = logical; frame = 0; },
        currentFrame: () => ({ state: playing, frame, frameCount: 3, clipSeconds: 0.4 }),
        resolveClip: (l) => l,
        igniteContactFrame: () => ({ frame: 1, marked: true, frameCount: 3 }),
        predictTip: () => ({ x: 20, y: -80 }),
      },
      perspectiveAt: () => 1,
      isWalkable: () => true,
      igniter: () => ({ socket: 'right_hand', u: 0.5, v: 0.1 }),
      burn: {
        canPlayerIgnite: () => true,
        playerIgniteTarget: () => ({ scene: { x: 300, y: 50 }, target: 'all' }),
        igniteAt: (id) => { ignited.push(id); return true; },
      },
      config: () => ({ animation: 'ignite' }),
      log: () => {},
      ...over,
    };
    const p = new IgnitePerformer(deps);
    return {
      p, deps, ignited, get state() { return state; }, set state(s: GameState) { state = s; },
      setFrame: (f: number) => { frame = f; }, arrive: async () => { moveResolve?.(); await Promise.resolve(); await Promise.resolve(); },
      get cancelled() { return cancelled; },
    };
  }

  it('正常：切 ActionSequence → 走到站位 → 接触帧点着 → 播完回探索', async () => {
    const h = harness();
    expect(h.p.start('hs')).toBe(true);
    expect(h.state).toBe(GameState.ActionSequence);
    await h.arrive();
    h.p.update(0.05);
    expect(h.ignited).toEqual([]);
    h.setFrame(1);
    h.p.update(0.05);
    expect(h.ignited).toEqual(['hs']);
    h.setFrame(2);
    h.p.update(0.05);
    expect(h.state).toBe(GameState.Exploring);
    expect(h.p.busy).toBe(false);
  });

  it('手上没火 / 这个点不了 / 不在探索：不开演、什么都不动', () => {
    expect(harness({ igniter: () => null }).p.start('hs')).toBe(false);
    const h2 = harness({ burn: { canPlayerIgnite: () => false, playerIgniteTarget: () => null, igniteAt: () => false } });
    expect(h2.p.start('hs')).toBe(false);
    expect(h2.state).toBe(GameState.Exploring);
    const h3 = harness();
    h3.state = GameState.Dialogue;
    expect(h3.p.start('hs')).toBe(false);
    expect(h3.state).toBe(GameState.Dialogue);
  });

  it('走的途中被对话抢了状态：收掉、不点、不改那个状态', async () => {
    const h = harness();
    h.p.start('hs');
    h.state = GameState.Dialogue;
    h.p.update(0.05);
    expect(h.p.busy).toBe(false);
    expect(h.cancelled).toBe(1);
    expect(h.state).toBe(GameState.Dialogue);
    await h.arrive();
    h.p.update(0.05);
    expect(h.ignited).toEqual([]);
  });

  it('接触帧那一刻火已经灭了：不点，照样播完回探索', async () => {
    let lit = true;
    const h = harness({ igniter: () => (lit ? { socket: 'right_hand', u: 0.5, v: 0.1 } : null) });
    h.p.start('hs');
    await h.arrive();
    lit = false;
    h.setFrame(1);
    h.p.update(0.05);
    h.setFrame(2);
    h.p.update(0.05);
    expect(h.ignited).toEqual([]);
    expect(h.state).toBe(GameState.Exploring);
  });

  it('走位一直到不了（位移被抢 / 步长被压到 0）：走位超时后原地开始点火动作，照常点着、收尾', async () => {
    const h = harness({ player: { ...harness().deps.player, moveTo: () => new Promise<void>(() => {}), cancelMotion: () => {} } });
    expect(h.p.start('hs')).toBe(true);
    expect(h.p.debugState.phase).toBe('walking');
    for (let i = 0; i < 40; i++) h.p.update(0.5);
    expect(h.ignited).toEqual(['hs']);
    expect(h.p.busy).toBe(false);
    expect(h.state).toBe(GameState.Exploring);
  });

  it('abort（切场景）：还回探索；片段播不出来时靠超时收尾不卡死', async () => {
    const h = harness();
    h.p.start('hs');
    h.p.abort();
    expect(h.state).toBe(GameState.Exploring);
    const h2 = harness();
    h2.p.start('hs');
    await h2.arrive();
    // 片段卡在第 0 帧不动（装扮里播不出来 / 被别的东西定格）⇒ 靠超时（片段时长 + 1 s）先点、再收尾
    for (let i = 0; i < 5; i++) h2.p.update(0.5);
    expect(h2.ignited).toEqual(['hs']);
    expect(h2.p.busy).toBe(false);
    expect(h2.state).toBe(GameState.Exploring);
  });
});
