import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrajectoryAsset } from '../data/types';
import type { PositionRefLookups } from './positionRef';
import { findTrajectorySlot, parsePositionRef, resolvePositionRef, trajectoryBinding, trajectoryOrigin } from './positionRef';

/**
 * 位置引用（数字 / 实体位置 / 曲线插槽）的解析与求值。
 * 这一层的失败模式全是**静默**的（warn + null，动作按"没给位置"走），所以每条路都要钉。
 */

const sceneAsset: TrajectoryAsset = {
  id: 'coin_drop', space: 'screen', binding: 'scene', keyframes: [{ atMs: 0, x: 0, y: 0 }],
  slots: [{ id: 'dropper', label: '掉钱的人', x: 975.1, y: 1491.9 }, { id: 'catcher', x: 1100, y: 1500 }],
  authoring: { sceneId: '雾津街头', origin: { x: 990, y: 1450 } },
};
const freeAsset: TrajectoryAsset = {
  id: 'toss', space: 'screen', binding: 'free', keyframes: [{ atMs: 0, x: 0, y: 0 }],
  slots: [{ id: 'a', x: 1, y: 2 }], authoring: {},
};
const legacyAsset: TrajectoryAsset = {
  id: 'old', space: 'screen', keyframes: [{ atMs: 0, x: 0, y: 0 }],
  authoring: { sceneId: '河边', anchor: { x: 10, y: 20 } },
};

const lookups = (entities: Record<string, { x: number; y: number }> = {}, scene = '雾津街头') => ({
  entityPosition: (id: string) => entities[id] ?? null,
  loadTrajectory: async (id: string) => ({ coin_drop: sceneAsset, toss: freeAsset, old: legacyAsset } as Record<string, TrajectoryAsset>)[id] ?? null,
  currentSceneId: () => scene,
});

describe('parsePositionRef', () => {
  it('三种形状 + 两种简写', () => {
    expect(parsePositionRef({ kind: 'point', x: 1, y: '2' })).toEqual({ kind: 'point', x: 1, y: 2 });
    expect(parsePositionRef({ x: 3, y: 4 })).toEqual({ kind: 'point', x: 3, y: 4 });
    expect(parsePositionRef({ kind: 'entity', id: ' npc_1 ' })).toEqual({ kind: 'entity', id: 'npc_1' });
    expect(parsePositionRef('player')).toEqual({ kind: 'entity', id: 'player' });
    expect(parsePositionRef({ kind: 'slot', trajectoryId: 'coin_drop', slotId: 'dropper' })).toEqual({ kind: 'slot', trajectoryId: 'coin_drop', slotId: 'dropper' });
  });
  it('形状不对一律 null（不抛）', () => {
    expect(parsePositionRef(null)).toBeNull();
    expect(parsePositionRef('')).toBeNull();
    expect(parsePositionRef(7)).toBeNull();
    expect(parsePositionRef({ kind: 'point', x: 'a', y: 1 })).toBeNull();
    expect(parsePositionRef({ kind: 'entity' })).toBeNull();
    expect(parsePositionRef({ kind: 'slot', trajectoryId: 'x' })).toBeNull();
    expect(parsePositionRef({ kind: 'teleport' })).toBeNull();
  });
});

describe('trajectoryBinding / trajectoryOrigin', () => {
  it('显式 binding 优先；老资产按 sceneId 推；origin 退到旧 anchor', () => {
    expect(trajectoryBinding(sceneAsset)).toBe('scene');
    expect(trajectoryBinding(freeAsset)).toBe('free');
    expect(trajectoryBinding(legacyAsset)).toBe('scene');
    expect(trajectoryBinding({ ...legacyAsset, authoring: {} })).toBe('free');
    expect(trajectoryOrigin(sceneAsset)).toEqual({ x: 990, y: 1450 });
    expect(trajectoryOrigin(legacyAsset)).toEqual({ x: 10, y: 20 });
    expect(trajectoryOrigin(freeAsset)).toBeNull();
  });
  it('findTrajectorySlot 按 id 找', () => {
    expect(findTrajectorySlot(sceneAsset, 'catcher')).toEqual({ id: 'catcher', x: 1100, y: 1500 });
    expect(findTrajectorySlot(sceneAsset, 'nope')).toBeNull();
    expect(findTrajectorySlot(legacyAsset, 'a')).toBeNull();
  });
});

describe('resolvePositionRef', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('point 原样；entity 查实体此刻位置；找不到 → null + warn', async () => {
    const lk = lookups({ player: { x: 5, y: 6 } });
    expect(await resolvePositionRef({ kind: 'point', x: 1, y: 2 }, lk)).toEqual({ x: 1, y: 2 });
    expect(await resolvePositionRef({ kind: 'entity', id: 'player' }, lk)).toEqual({ x: 5, y: 6 });
    expect(await resolvePositionRef({ kind: 'entity', id: 'ghost' }, lk)).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(await resolvePositionRef(null, lk)).toBeNull();
  });

  it('slot：场景曲线的插槽给作者场景坐标；缺插槽 / 缺资产 → null', async () => {
    const lk = lookups();
    expect(await resolvePositionRef({ kind: 'slot', trajectoryId: 'coin_drop', slotId: 'dropper' }, lk)).toEqual({ x: 975.1, y: 1491.9 });
    expect(await resolvePositionRef({ kind: 'slot', trajectoryId: 'coin_drop', slotId: 'nope' }, lk)).toBeNull();
    expect(await resolvePositionRef({ kind: 'slot', trajectoryId: 'missing', slotId: 'a' }, lk)).toBeNull();
  });

  it('相对曲线的插槽没有绝对位置：null + warn', async () => {
    expect(await resolvePositionRef({ kind: 'slot', trajectoryId: 'toss', slotId: 'a' }, lookups())).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('相对曲线'));
  });

  it('场景曲线拿到别的场景用：仍给坐标，但出声', async () => {
    const p = await resolvePositionRef({ kind: 'slot', trajectoryId: 'coin_drop', slotId: 'catcher' }, lookups({}, '河边'));
    expect(p).toEqual({ x: 1100, y: 1500 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('绑定的是'));
  });
});

describe('曲线上的点（curve）', () => {
  const frames = [
    { atMs: 0, x: 0, y: 0 },
    { atMs: 500, x: 50, y: -20 },
    { atMs: 1000, x: 120, y: 10 },
  ];
  const curveScene = {
    id: 't1', space: 'screen', binding: 'scene', keyframes: frames,
    authoring: { sceneId: 's1', origin: { x: 1000, y: 2000 } },
  } as unknown as TrajectoryAsset;
  const curveFree = {
    id: 't2', space: 'screen', binding: 'free', keyframes: frames, authoring: {},
  } as unknown as TrajectoryAsset;
  const lookups = (over: Partial<PositionRefLookups> = {}): PositionRefLookups => ({
    entityPosition: () => null,
    loadTrajectory: async (id) => (id === 't1' ? curveScene : id === 't2' ? curveFree : null),
    ...over,
  });

  it('解析：point 省略时按 atMs / progress 推，都没给按 end', () => {
    expect(parsePositionRef({ kind: 'curve', trajectoryId: 't1' })).toEqual({ kind: 'curve', trajectoryId: 't1', point: 'end' });
    expect(parsePositionRef({ kind: 'curve', trajectoryId: 't1', atMs: 250 })).toEqual({ kind: 'curve', trajectoryId: 't1', point: 'time', atMs: 250 });
    expect(parsePositionRef({ kind: 'curve', trajectoryId: 't1', progress: 0.5 })).toEqual({ kind: 'curve', trajectoryId: 't1', point: 'progress', progress: 0.5 });
    expect(parsePositionRef({ kind: 'curve' })).toBeNull();
  });

  it('没在播：场景曲线按作者摆的原点算（首帧不必是 (0,0)）', async () => {
    const at = (p: unknown) => resolvePositionRef(parsePositionRef(p), lookups());
    await expect(at({ kind: 'curve', trajectoryId: 't1' })).resolves.toEqual({ x: 1120, y: 2010 });
    await expect(at({ kind: 'curve', trajectoryId: 't1', point: 'start' })).resolves.toEqual({ x: 1000, y: 2000 });
    await expect(at({ kind: 'curve', trajectoryId: 't1', atMs: 500 })).resolves.toEqual({ x: 1050, y: 1980 });
    await expect(at({ kind: 'curve', trajectoryId: 't1', progress: 0.5 })).resolves.toEqual({ x: 1050, y: 1980 });
    // 越界时刻按采样器钳两端
    await expect(at({ kind: 'curve', trajectoryId: 't1', atMs: 99999 })).resolves.toEqual({ x: 1120, y: 2010 });
  });

  it('正在播：用这次播放的锚点与这次的帧（"实时点"）', async () => {
    const live = {
      keyframes: [{ atMs: 0, x: 0, y: 0 }, { atMs: 1000, x: -30, y: 5 }],
      anchor: { x: 10, y: 20 },
    };
    const p = await resolvePositionRef(
      parsePositionRef({ kind: 'curve', trajectoryId: 't1' }),
      lookups({ liveTrajectoryPlay: (id) => (id === 't1' ? live : null) }),
    );
    expect(p).toEqual({ x: -20, y: 25 });
  });

  it('相对曲线没在播 = 没有绝对位置；正在播就有', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(resolvePositionRef(parsePositionRef({ kind: 'curve', trajectoryId: 't2' }), lookups())).resolves.toBeNull();
    const live = { keyframes: frames, anchor: { x: 5, y: 5 } };
    await expect(resolvePositionRef(
      parsePositionRef({ kind: 'curve', trajectoryId: 't2' }),
      lookups({ liveTrajectoryPlay: () => live }),
    )).resolves.toEqual({ x: 125, y: 15 });
    warn.mockRestore();
  });

  it('装不上 / 没帧：null 且不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(resolvePositionRef(parsePositionRef({ kind: 'curve', trajectoryId: '没有这条' }), lookups())).resolves.toBeNull();
    const empty = { id: 't3', space: 'screen', binding: 'scene', keyframes: [], authoring: { sceneId: 's1', origin: { x: 1, y: 2 } } } as unknown as TrajectoryAsset;
    await expect(resolvePositionRef(
      parsePositionRef({ kind: 'curve', trajectoryId: 't3' }),
      lookups({ loadTrajectory: async () => empty }),
    )).resolves.toBeNull();
    warn.mockRestore();
  });
});
