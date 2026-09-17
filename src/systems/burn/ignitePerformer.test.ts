import { describe, expect, it } from 'vitest';
import { GameState } from '../../data/types';
import { IgnitePerformer, type IgnitePerformerDeps } from './ignitePerformer';

/** 点火表演的两个方向：手上的火点它（ignite）/ 从它身上引火点着手上的火把（relight） */
function rig(opts: { lit: boolean; unlitTorch: boolean; canIgnite: boolean; canRelight: boolean }) {
  let state = GameState.Exploring;
  const calls: string[] = [];
  const world = { ...opts, frame: 0 };
  const deps: IgnitePerformerDeps = {
    getState: () => state,
    setState: (s) => { state = s; },
    switching: () => false,
    player: {
      pos: () => ({ x: 100, y: 100 }),
      facing: () => 1,
      setFacing: () => {},
      moveTo: async () => {},
      cancelMotion: () => {},
      walkSpeed: () => 100,
      hasLogicalState: () => true,
      playOnce: () => { world.frame = 0; },
      currentFrame: () => ({ state: 'ignite', frame: world.frame, frameCount: 6, clipSeconds: 0.5 }),
      resolveClip: () => 'ignite',
      igniteContactFrame: () => ({ frame: 2, marked: true, frameCount: 6 }),
      predictTip: () => ({ x: 20, y: -60 }),
    },
    perspectiveAt: () => 1,
    isWalkable: () => true,
    igniter: () => (world.lit ? { socket: 'right_hand', u: 0.5, v: 0.05 } : null),
    relightTip: () => (world.unlitTorch ? { socket: 'right_hand', u: 0.5, v: 0.05 } : null),
    relight: () => { calls.push('relight'); world.unlitTorch = false; world.lit = true; return true; },
    burn: {
      canPlayerIgnite: () => world.canIgnite,
      playerIgniteTarget: () => ({ scene: { x: 120, y: 40 }, target: 'all' }),
      igniteAt: () => { calls.push('igniteAt'); return true; },
      canRelightFrom: () => world.canRelight,
      relightTarget: () => ({ x: 120, y: 40 }),
    },
    config: () => ({ animation: 'ignite' }),
    log: () => {},
  };
  const p = new IgnitePerformer(deps);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const play = async () => {
    await flush();
    for (let f = 0; f < 8; f++) { world.frame = f; p.update(1 / 60); }
  };
  return { p, calls, world, play, state: () => state };
}

describe('IgnitePerformer：点它 / 从它身上引火', () => {
  it('modeFor：手上燃着且能点它 ⇒ ignite；手上灭着且它在烧 ⇒ relight；都不行 ⇒ null', () => {
    expect(rig({ lit: true, unlitTorch: false, canIgnite: true, canRelight: false }).p.modeFor('x')).toBe('ignite');
    expect(rig({ lit: false, unlitTorch: true, canIgnite: false, canRelight: true }).p.modeFor('x')).toBe('relight');
    expect(rig({ lit: false, unlitTorch: true, canIgnite: true, canRelight: false }).p.modeFor('x')).toBeNull();
    expect(rig({ lit: true, unlitTorch: false, canIgnite: false, canRelight: true }).p.modeFor('x')).toBeNull();
  });

  it('引火：切表演态 → 接触帧那一刻火把点着（不点那个可燃物）→ 播完回探索', async () => {
    const r = rig({ lit: false, unlitTorch: true, canIgnite: false, canRelight: true });
    expect(r.p.start('candle')).toBe(true);
    expect(r.state()).toBe(GameState.ActionSequence);
    await r.play();
    expect(r.calls).toEqual(['relight']);
    expect(r.state()).toBe(GameState.Exploring);
    expect(r.p.busy).toBe(false);
  });

  it('引火途中那团火灭了 ⇒ 接触帧不点着，照样收掉回探索', async () => {
    const r = rig({ lit: false, unlitTorch: true, canIgnite: false, canRelight: true });
    expect(r.p.start('candle')).toBe(true);
    r.world.canRelight = false;
    await r.play();
    expect(r.calls).toEqual([]);
    expect(r.state()).toBe(GameState.Exploring);
  });

  it('点它（原来的方向）照旧：接触帧 igniteAt', async () => {
    const r = rig({ lit: true, unlitTorch: false, canIgnite: true, canRelight: false });
    expect(r.p.start('paper')).toBe(true);
    await r.play();
    expect(r.calls).toEqual(['igniteAt']);
  });
});
