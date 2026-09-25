/**
 * 挂件前后随画面朝向互换（制作人 2026-09-14 定死）：**标注按图集朝向（朝右）标，朝左时前后互换。**
 *
 * 两种转身都要钉：
 * - Player：转身住在精灵自己的 `facingX`（`setDirection`）；
 * - Npc：转身住在**外层容器** `scale.x`，内层 `facingX` 恒 +1，精灵只能从
 *   `setLitParentTransform` 推进来的外层变换里知道自己朝哪边。漏了这层，NPC 朝左时
 *   前后不换、挂件灯落在身体另一侧，而且都不报错。
 *
 * 判据是容器里的**子节点顺序**（身前 = 排在身体后面画 = 下标更大），不是某个内部标志。
 */
import { describe, expect, it } from 'vitest';
import { Rectangle, Sprite, Texture, TextureSource } from '../engine2d';

import { SpriteEntity } from './SpriteEntity';
import type { AnimationSetDef, SocketFramePose } from '../data/types';
import type { ResolvedSockets } from '../data/animationSockets';

const CELL_W = 32;
const CELL_H = 48;

function animDef(): AnimationSetDef {
  return {
    spritesheet: 'x.png',
    cols: 2,
    rows: 1,
    cellWidth: CELL_W,
    cellHeight: CELL_H,
    worldWidth: 100,
    worldHeight: 150,
    states: { idle: { frames: [0], frameRate: 8, loop: true } },
  };
}

function sockets(pose: SocketFramePose): ResolvedSockets {
  return {
    stale: false,
    set: {
      schemaVersion: 1,
      atlas: { cols: 2, rows: 1, slotCount: 2 },
      sockets: { hand: { poses: { '0': pose } } },
      contactSlots: [],
      igniteSlots: [],
    },
  };
}

function make(pose: SocketFramePose): { e: SpriteEntity; body: Sprite; view: Sprite } {
  const e = new SpriteEntity();
  const tex = new Texture({ source: new TextureSource({ width: CELL_W * 2, height: CELL_H }) });
  e.loadFromDef(tex, animDef(), sockets(pose));
  e.playAnimation('idle');
  const body = (e as unknown as { sprite: Sprite }).sprite;
  const view = new Sprite();
  e.attachToSocket('hand', { view });
  return { e, body, view };
}

/** 挂件画在身体前面（子节点顺序上排在身体之后） */
function inFront(e: SpriteEntity, body: Sprite, view: Sprite): boolean {
  return e.container.getChildIndex(view) > e.container.getChildIndex(body);
}

describe('挂件前后随画面朝向互换', () => {
  it('Player：标身前（缺省）⇒ 朝右身前、朝左身后、转回来又身前', () => {
    const { e, body, view } = make({ x: 0.8, y: 0.5 });
    expect(inFront(e, body, view)).toBe(true);
    e.setDirection(-1, 0);
    expect(e.getSocketPose('hand')!.front).toBe(false);
    expect(inFront(e, body, view)).toBe(false);
    e.setDirection(1, 0);
    expect(inFront(e, body, view)).toBe(true);
  });

  it('Player：标身后 ⇒ 朝右身后、朝左身前', () => {
    const { e, body, view } = make({ x: 0.8, y: 0.5, front: false });
    expect(inFront(e, body, view)).toBe(false);
    e.setDirection(-1, 0);
    expect(inFront(e, body, view)).toBe(true);
  });

  it('Npc：转身只翻外层容器（内层 facingX 恒 +1），前后照样互换', () => {
    const { e, body, view } = make({ x: 0.8, y: 0.5 });
    // Npc.setFacing(-1)：外层 scale.x 取负、推 setLitParentTransform、内层 setDirection(1, 0)
    e.setLitParentTransform(300, 400, -1, 1, 0);
    e.setDirection(1, 0);
    expect(e.getSocketPose('hand')!.front).toBe(false);
    expect(inFront(e, body, view)).toBe(false);
    e.setLitParentTransform(300, 400, 1, 1, 0);
    expect(inFront(e, body, view)).toBe(true);
  });

  it('只动位置 / 缩放幅值不翻镜像时不重排（setLitParentTransform 每帧都会推）', () => {
    const { e, body, view } = make({ x: 0.8, y: 0.5 });
    e.setLitParentTransform(10, 20, 2, 2, 0);
    e.setLitParentTransform(11, 21, 2, 2, 0);
    expect(inFront(e, body, view)).toBe(true);
  });
});

describe('挂点相对接地点的偏移（挂件灯按它定位）', () => {
  // x=0.8 ⇒ 本容器局部 (0.8−0.5)×100 = 30；y=0.5 ⇒ (0.5−1)×150 = −75
  it('Player 朝左：跟着精灵自己的镜像翻到另一侧', () => {
    const { e } = make({ x: 0.8, y: 0.5 });
    const right = e.getSocketOffsetFromContact('hand')!;
    expect(right.x).toBeCloseTo(30, 10);
    expect(right.y).toBeCloseTo(-75, 10);
    expect(right.front).toBe(true);
    expect(right.clearanceWu).toBe(6);
    expect(right.bodyWidthWu).toBe(100);
    e.setDirection(-1, 0);
    expect(e.getSocketOffsetFromContact('hand')!.x).toBeCloseTo(-30, 10);
    expect(e.getSocketOffsetFromContact('hand')!.front).toBe(false);
  });

  it('Npc 朝左：外层镜像也要乘进去（本容器局部位姿此时仍是 +30）', () => {
    const { e } = make({ x: 0.8, y: 0.5 });
    e.setLitParentTransform(0, 0, -1, 1, 0);
    expect(e.getSocketPose('hand')!.x).toBeCloseTo(30, 10);
    const off = e.getSocketOffsetFromContact('hand')!;
    expect(off.x).toBeCloseTo(-30, 10);
    expect(off.y).toBeCloseTo(-75, 10);
    expect(off.front).toBe(false);
  });

  it('Npc 实例缩放与旋转：先缩放（含镜像）再旋转，与 Npc._contactOffset 同口径', () => {
    const { e } = make({ x: 0.8, y: 0.5 });
    const rot = 0.3;
    e.setLitParentTransform(0, 0, -2, 2, rot);
    const off = e.getSocketOffsetFromContact('hand')!;
    const vx = 30 * -2;
    const vy = -75 * 2;
    expect(off.x).toBeCloseTo(vx * Math.cos(rot) - vy * Math.sin(rot), 10);
    expect(off.y).toBeCloseTo(vx * Math.sin(rot) + vy * Math.cos(rot), 10);
  });

  it('没标注的挂点 ⇒ null（灯这一帧不发光）', () => {
    const { e } = make({ x: 0.8, y: 0.5 });
    expect(e.getSocketOffsetFromContact('nope')).toBeNull();
  });
});

describe('燃烧物：贴图上的起火点', () => {
  // 燃烧物贴图 20×100，支点 (0.5, 0.8) 握杆，缩放 0.5；起火点 (0.5, 0.05) 在杆头
  function withStick(pose: SocketFramePose, rotationOffsetDeg = 0) {
    const e = new SpriteEntity();
    const tex = new Texture({ source: new TextureSource({ width: CELL_W * 2, height: CELL_H }) });
    e.loadFromDef(tex, animDef(), sockets(pose));
    e.playAnimation('idle');
    const view = new Sprite(new Texture({ source: new TextureSource({ width: 20, height: 100 }) }));
    e.attachToSocket('hand', { view, scale: 0.5, anchorX: 0.5, anchorY: 0.8, rotationOffsetDeg });
    return { e, view };
  }

  it('起火点偏移 = 挂点偏移 + 贴图上 (起火点 − 支点) × 像素 × 缩放；贴图转 90° 时跟着转', () => {
    const { e } = withStick({ x: 0.8, y: 0.5 });
    const off = e.getAttachmentPointOffsetFromContact('hand', 0.5, 0.05)!;
    // 竖直：杆头在握点正上方 (0.05−0.8)×100×0.5 = −37.5
    expect(off.x).toBeCloseTo(30, 10);
    expect(off.y).toBeCloseTo(-75 - 37.5, 10);
    expect(off.front).toBe(true);
    const turned = withStick({ x: 0.8, y: 0.5 }, 90).e.getAttachmentPointOffsetFromContact('hand', 0.5, 0.05)!;
    // 顺时针 90°：(0, −37.5) → (37.5, 0)
    expect(turned.x).toBeCloseTo(30 + 37.5, 10);
    expect(turned.y).toBeCloseTo(-75, 10);
  });

  it('起火点就是支点 ⇒ 与挂点本身的偏移逐位相同（灯笼那种"不写起火点"的等价情形）', () => {
    const { e } = withStick({ x: 0.8, y: 0.5, angle: 37 } as SocketFramePose, 12);
    const a = e.getAttachmentPointOffsetFromContact('hand', 0.5, 0.8)!;
    const b = e.getSocketOffsetFromContact('hand')!;
    expect(a).toEqual(b);
  });

  it('NPC 转身翻外层容器：起火点跟着翻到另一侧（与挂点同一套外层换算）', () => {
    const { e } = withStick({ x: 0.8, y: 0.5 }, 90);
    e.setLitParentTransform(0, 0, -1, 1, 0);
    const off = e.getAttachmentPointOffsetFromContact('hand', 0.5, 0.05)!;
    expect(off.x).toBeCloseTo(-(30 + 37.5), 10);
    expect(off.front).toBe(false);
  });

  it('没挂东西 / 挂点没标注 ⇒ null', () => {
    const { e } = withStick({ x: 0.8, y: 0.5 });
    expect(e.getAttachmentPointOffsetFromContact('nope', 0.5, 0.5)).toBeNull();
    e.detachFromSocket('hand');
    expect(e.getAttachmentPointOffsetFromContact('hand', 0.5, 0.5)).toBeNull();
  });

  it('点火表演的预测：给定帧 / 朝向 / 透视系数算出的起火点偏移 == 真播到那一帧时的偏移（两个朝向、两档透视）', () => {
    for (const facing of [1, -1] as const) {
      for (const depth of [1, 0.62]) {
        const { e } = withStick({ x: 0.8, y: 0.5, angle: 23 } as SocketFramePose, 15);
        const predicted = e.predictAttachmentPointOffset('hand', 0.5, 0.05, { logicalState: 'idle', frameIndex: 0, facing, depthScale: depth })!;
        e.setDirection(facing, 0);
        e.setDepthScaleFactor(depth);
        const actual = e.getAttachmentPointOffsetFromContact('hand', 0.5, 0.05)!;
        expect(predicted.x).toBeCloseTo(actual.x, 9);
        expect(predicted.y).toBeCloseTo(actual.y, 9);
      }
    }
  });

  it('点火接触帧：帧序列里第一个落在 igniteSlots 的帧；一格没标 ⇒ 第 0 帧且 marked=false', () => {
    const e = new SpriteEntity();
    const tex = new Texture({ source: new TextureSource({ width: CELL_W * 2, height: CELL_H }) });
    const def = animDef();
    def.states.light = { frames: [0, 1, 1, 0], frameRate: 8, loop: false };
    const s = sockets({ x: 0.8, y: 0.5 });
    s.set!.igniteSlots = [1];
    e.loadFromDef(tex, def, s);
    expect(e.igniteContactFrame('light')).toEqual({ frame: 1, marked: true, frameCount: 4 });
    expect(e.slotOfLogicalFrame('light', 3)).toBe(0);
    expect(e.igniteContactFrame('nope')).toBeNull();
    const e2 = new SpriteEntity();
    e2.loadFromDef(tex, def, sockets({ x: 0.8, y: 0.5 }));
    expect(e2.igniteContactFrame('light')).toEqual({ frame: 0, marked: false, frameCount: 4 });
  });
});

describe('帧动画火苗（保留的能力）：摆位', () => {
  // 燃烧物同上：20×100、支点 (0.5, 0.8)、缩放 0.5；火苗帧 10×50 两帧
  function withFlame(pose: SocketFramePose, rotationOffsetDeg = 0) {
    const e = new SpriteEntity();
    const tex = new Texture({ source: new TextureSource({ width: CELL_W * 2, height: CELL_H }) });
    e.loadFromDef(tex, animDef(), sockets(pose));
    e.playAnimation('idle');
    const body = (e as unknown as { sprite: Sprite }).sprite;
    const view = new Sprite(new Texture({ source: new TextureSource({ width: 20, height: 100 }) }));
    const src = new TextureSource({ width: 20, height: 50 });
    const frames = [
      new Texture({ source: src, frame: new Rectangle(0, 0, 10, 50) }),
      new Texture({ source: src, frame: new Rectangle(10, 0, 10, 50) }),
    ];
    const fv = new Sprite(frames[0]);
    fv.anchor.set(0.5, 1);
    e.attachToSocket('hand', {
      view, scale: 0.5, anchorX: 0.5, anchorY: 0.8, rotationOffsetDeg,
      firePoint: [0.5, 0.05],
      flame: { view: fv, frames, params: null },
    });
    return { e, body, view, fv, frames };
  }
  const lit = { visible: true, frame: 1, heightWu: 25, angleRad: 0.2 };

  it('参数到之前不画；到了：底部钉在起火点、帧号取模、高度 = heightWu（透视系数 1）', () => {
    const { e, fv, frames } = withFlame({ x: 0.8, y: 0.5 });
    expect(fv.visible).toBe(false);
    e.setAttachmentFlame('hand', { ...lit, frame: 3 });
    expect(fv.visible).toBe(true);
    expect(fv.texture).toBe(frames[1]);
    expect(fv.position.x).toBeCloseTo(30, 10);
    expect(fv.position.y).toBeCloseTo(-75 - 37.5, 10);
    expect(fv.scale.y).toBeCloseTo(25 / 50, 10);
    expect(fv.rotation).toBeCloseTo(0.2, 10);
  });

  it('燃烧物转 90°：起火点跟着转，火苗角度不跟着转（仍是参数给的画面角）', () => {
    const { e, fv } = withFlame({ x: 0.8, y: 0.5 }, 90);
    e.setAttachmentFlame('hand', lit);
    expect(fv.position.x).toBeCloseTo(30 + 37.5, 10);
    expect(fv.position.y).toBeCloseTo(-75, 10);
    expect(fv.rotation).toBeCloseTo(0.2, 10);
  });

  it('NPC 转身翻外层容器：局部角取反，画面上仍往同一侧倒；外层旋转抵掉', () => {
    const { e, fv } = withFlame({ x: 0.8, y: 0.5 });
    e.setLitParentTransform(0, 0, -1, 1, 0);
    e.setAttachmentFlame('hand', lit);
    expect(fv.rotation).toBeCloseTo(-0.2, 10);
    e.setLitParentTransform(0, 0, 1, 1, 0.5);
    e.setAttachmentFlame('hand', lit);
    expect(fv.rotation).toBeCloseTo(0.2 - 0.5, 10);
  });

  it('不可见 / 高度 0 ⇒ 不画', () => {
    const { e, fv } = withFlame({ x: 0.8, y: 0.5 });
    e.setAttachmentFlame('hand', { ...lit, visible: false });
    expect(fv.visible).toBe(false);
    e.setAttachmentFlame('hand', { ...lit, heightWu: 0 });
    expect(fv.visible).toBe(false);
  });

  it('火苗跟着挂件组一起换前后，并且始终排在杆头之上；卸下时一并摘掉', () => {
    const { e, body, view, fv } = withFlame({ x: 0.8, y: 0.5 });
    const idx = (n: Sprite) => e.container.getChildIndex(n);
    expect(idx(fv)).toBeGreaterThan(idx(view));
    expect(idx(view)).toBeGreaterThan(idx(body));
    e.setDirection(-1, 0);
    expect(idx(fv)).toBeGreaterThan(idx(view));
    expect(idx(fv)).toBeLessThan(idx(body));
    e.setDirection(1, 0);
    expect(idx(fv)).toBeGreaterThan(idx(view));
    expect(idx(view)).toBeGreaterThan(idx(body));
    e.detachFromSocket('hand');
    expect(fv.parent).toBeNull();
  });
});
