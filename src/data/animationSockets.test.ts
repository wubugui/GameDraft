import { describe, it, expect } from 'vitest';
import {
  socketPoseToLocal,
  fingerprintMatches,
  fingerprintOfAnim,
  parseSocketSet,
  resolveSockets,
  socketsJsonUrlForAnim,
} from './animationSockets';
import type { AnimationSetDef } from './types';

const ANIM: AnimationSetDef = {
  spritesheet: 'atlas.png',
  cols: 9,
  rows: 10,
  cellWidth: 219,
  cellHeight: 204,
  worldWidth: 148,
  worldHeight: 150,
  atlasFrames: Array.from({ length: 89 }, () => ({
    width: 219, height: 204, contentWidth: 47, contentHeight: 182,
  })),
  states: { idle: { frames: [0, 1], frameRate: 8, loop: true } },
};

function socketsJson(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    atlas: { cols: 9, rows: 10, slotCount: 89 },
    sockets: {
      right_hand: { label: '右手', poses: { '0': { x: 0.62, y: 0.55, angle: -12, front: true } } },
    },
    ...overrides,
  };
}

describe('sockets sidecar 寻址', () => {
  it('与 anim.json 同目录', () => {
    expect(socketsJsonUrlForAnim('/resources/runtime/animation/player_anim/anim.json'))
      .toBe('/resources/runtime/animation/player_anim/sockets.json');
  });

  it('给不出目录时返回空串（调用方据此跳过加载）', () => {
    expect(socketsJsonUrlForAnim('anim.json')).toBe('');
    expect(socketsJsonUrlForAnim('')).toBe('');
  });
});

describe('sockets 解析', () => {
  it('读出位姿的四个维度', () => {
    const set = parseSocketSet(socketsJson());
    const pose = set?.sockets.right_hand.poses['0'];
    expect(pose).toEqual({ x: 0.62, y: 0.55, angle: -12, front: true });
    expect(set?.sockets.right_hand.label).toBe('右手');
  });

  it('结构坏了当作没有挂点（表现层增益不许把角色弄挂）', () => {
    expect(parseSocketSet(null)).toBeNull();
    expect(parseSocketSet({ sockets: {} })).toBeNull();            // 缺 atlas 指纹
    expect(parseSocketSet({ atlas: { cols: 1 }, sockets: {} })).toBeNull();  // 指纹不全
  });

  it('单个坏 pose 只跳过它自己，同挂点其余帧照常', () => {
    const set = parseSocketSet(socketsJson({
      sockets: {
        h: { poses: { '0': { x: 0.5, y: 0.5 }, '1': { x: 'bad' }, '2': { y: 0.3 } } },
      },
    }));
    expect(Object.keys(set!.sockets.h.poses)).toEqual(['0']);
  });

  it('缺省值不落键（往返干净：angle=0 / front=false 不写）', () => {
    const set = parseSocketSet(socketsJson({
      sockets: { h: { poses: { '0': { x: 0.5, y: 0.5, angle: 0, front: false } } } },
    }));
    expect(set!.sockets.h.poses['0']).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe('落脚帧 contactSlots（与挂点同住 sidecar、同一份指纹）', () => {
  it('去重、升序、只收合法槽位；单个坏项跳过', () => {
    const set = parseSocketSet(socketsJson({ contactSlots: [20, 12, 12, -1, 2.5, '30', 999, 38] }));
    expect(set!.contactSlots).toEqual([12, 20, 38]);
  });

  it('没写 / 不是数组 ⇒ 空 = 这个包没有脚步（不按帧数猜）', () => {
    expect(parseSocketSet(socketsJson())!.contactSlots).toEqual([]);
    expect(parseSocketSet(socketsJson({ contactSlots: 'x' }))!.contactSlots).toEqual([]);
  });

  it('只标了落脚帧、一个挂点都没有的 sidecar 是合法的', () => {
    const set = parseSocketSet({ atlas: { cols: 9, rows: 10, slotCount: 89 }, contactSlots: [12] });
    expect(set).not.toBeNull();
    expect(set!.sockets).toEqual({});
    expect(set!.contactSlots).toEqual([12]);
  });

  it('指纹对不上时整份 stale——落脚帧跟挂点一起作废，宁可无声也不响在漂移后的格上', () => {
    const r = resolveSockets(socketsJson({ contactSlots: [12] }), { ...ANIM, cols: 10 });
    expect(r.stale).toBe(true);
  });
});

describe('图集指纹失效判定', () => {
  it('对得上时不 stale', () => {
    const r = resolveSockets(socketsJson(), ANIM);
    expect(r.stale).toBe(false);
    expect(r.set).not.toBeNull();
  });

  it('槽位数变了就 stale——重导出后槽位漂移，盲用会静默挂错位置', () => {
    const fewer: AnimationSetDef = { ...ANIM, atlasFrames: ANIM.atlasFrames!.slice(0, 80) };
    expect(resolveSockets(socketsJson(), fewer).stale).toBe(true);
  });

  it('格子像素尺寸变了**不** stale——换分辨率重导但网格没动，归一化坐标依然成立', () => {
    expect(resolveSockets(socketsJson(), { ...ANIM, cellWidth: 438 }).stale).toBe(false);
  });

  it('网格排布变了就 stale', () => {
    expect(resolveSockets(socketsJson(), { ...ANIM, cols: 10 }).stale).toBe(true);
  });

  it('没有 sidecar 不算 stale（绝大多数包就是没有挂点）', () => {
    expect(resolveSockets(null, ANIM)).toEqual({ set: null, stale: false });
  });

  it('指纹取自 anim 定义本身，两侧同源', () => {
    expect(fingerprintOfAnim(ANIM)).toEqual({ cols: 9, rows: 10, slotCount: 89 });
    expect(fingerprintMatches(fingerprintOfAnim(ANIM), fingerprintOfAnim(ANIM))).toBe(true);
    expect(fingerprintMatches(null, fingerprintOfAnim(ANIM))).toBe(false);
  });
});

describe('挂点位姿解算（运行时与编辑器共用这一处）', () => {
  const host = { worldWidth: 100, worldHeight: 200, depthScale: 1, facing: 1 as const, visualLiftY: 0 };

  it('格中心底边 = 脚点原点', () => {
    const p = socketPoseToLocal({ x: 0.5, y: 1 }, host);
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
  });

  it('格顶边 = 一个身高之上（向上为负）', () => {
    expect(socketPoseToLocal({ x: 0.5, y: 0 }, host).y).toBe(-200);
  });

  it('右半格 → 正 x；朝左时整体翻到另一侧', () => {
    expect(socketPoseToLocal({ x: 1, y: 1 }, host).x).toBe(50);
    expect(socketPoseToLocal({ x: 1, y: 1 }, { ...host, facing: -1 }).x).toBe(-50);
  });

  it('镜像时角度取反（顺时针变逆时针）', () => {
    expect(socketPoseToLocal({ x: 0.5, y: 0.5, angle: 30 }, host).angleDeg).toBe(30);
    expect(socketPoseToLocal({ x: 0.5, y: 0.5, angle: 30 }, { ...host, facing: -1 }).angleDeg).toBe(-30);
  });

  it('透视系数同时缩位置与挂件尺寸', () => {
    const p = socketPoseToLocal({ x: 1, y: 0 }, { ...host, depthScale: 0.5 });
    expect(p.x).toBe(25);
    expect(p.y).toBe(-100);
    expect(p.scale).toBe(0.5);
  });

  it('跳跃视觉抬升整体带着挂件走', () => {
    expect(socketPoseToLocal({ x: 0.5, y: 1 }, { ...host, visualLiftY: -40 }).y).toBe(-40);
  });

  it('非法透视系数回落 1，不把挂件缩成 0', () => {
    expect(socketPoseToLocal({ x: 1, y: 1 }, { ...host, depthScale: 0 }).x).toBe(50);
    expect(socketPoseToLocal({ x: 1, y: 1 }, { ...host, depthScale: NaN }).scale).toBe(1);
  });
});
