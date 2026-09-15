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
import { Sprite, Texture, TextureSource } from 'pixi.js';

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
