/**
 * 脚底偏移（`states[*].footOffset`，制作人 2026-09-24 定：素材像素不动，运行时按每个状态的参数把悬空拉回来）。
 *
 * 钉的是「挪的是画，不是接地点」：
 * - 画面锚点 = 逻辑锚点 × (1 − 偏移)，换状态跟着换；
 * - 接地点（阴影落点 / 排序 / 透视采样）缺省锚点时恒在原点；
 * - 挂点、授权头顶锚跟着画一起挪（它们量的是图上的位置）；
 * - 投影剪影裁掉脚底线以下那截空白，底边就是脚。
 */
import { describe, expect, it } from 'vitest';
import { Sprite, Texture, TextureSource } from '../engine2d';

import { SpriteEntity, footOffsetOfState, FOOT_OFFSET_MAX } from './SpriteEntity';
import type { AnimationSetDef, SocketFramePose } from '../data/types';
import type { ResolvedSockets } from '../data/animationSockets';

const CELL_W = 32;
const CELL_H = 48;
const WORLD_H = 150;

function animDef(): AnimationSetDef {
  return {
    spritesheet: 'x.png',
    cols: 2,
    rows: 1,
    cellWidth: CELL_W,
    cellHeight: CELL_H,
    worldWidth: 100,
    worldHeight: WORLD_H,
    states: {
      idle: { frames: [0], frameRate: 8, loop: true, footOffset: 0.125, bubbleAnchor: 0.95 },
      run: { frames: [1], frameRate: 8, loop: true },
    },
  };
}

function sockets(pose: SocketFramePose): ResolvedSockets {
  return {
    stale: false,
    set: {
      schemaVersion: 1,
      atlas: { cols: 2, rows: 1, slotCount: 2 },
      sockets: { hand: { poses: { '0': pose, '1': pose } } },
      contactSlots: [],
      igniteSlots: [],
    },
  };
}

function make(pose: SocketFramePose = { x: 0.5, y: 0.875 }): { e: SpriteEntity; body: Sprite } {
  const e = new SpriteEntity();
  const tex = new Texture({ source: new TextureSource({ width: CELL_W * 2, height: CELL_H }) });
  e.loadFromDef(tex, animDef(), sockets(pose));
  e.playAnimation('idle');
  return { e, body: (e as unknown as { sprite: Sprite }).sprite };
}

describe('脚底偏移：挪画不挪接地点', () => {
  it('画面锚点按当前状态的偏移上移，换状态跟着换', () => {
    const { e, body } = make();
    expect(body.anchor.y).toBeCloseTo(0.875, 10);
    expect(e.getFootOffset()).toBe(0.125);
    e.playAnimation('run');
    expect(body.anchor.y).toBe(1);
    expect(e.getFootOffset()).toBe(0);
    e.playAnimation('idle');
    expect(body.anchor.y).toBeCloseTo(0.875, 10);
  });

  it('缺省锚点：接地点恒在原点（阴影 / 排序 / 透视都不动）', () => {
    const { e } = make();
    expect(e.getGroundContactOffset()).toEqual({ x: 0, y: 0 });
  });

  it('自定义锚点量的是「格顶 → 脚底线」那一段，接地点落在脚底线上', () => {
    const { e, body } = make();
    e.setSpriteAnchor(0.5, 0.5);
    expect(body.anchor.y).toBeCloseTo(0.5 * 0.875, 10);
    // 脚底线在画面锚点下方 (0.875 − 0.4375) 格高
    expect(e.getGroundContactOffset().y).toBeCloseTo(0.4375 * WORLD_H, 6);
  });

  it('挂点跟着画一起挪：标在脚底线上的点落在原点', () => {
    const { e } = make({ x: 0.5, y: 0.875 });
    expect(e.getSocketPose('hand')!.y).toBeCloseTo(0, 6);
    e.playAnimation('run');
    // 没偏移的状态：脚底线就是格底，同一个标注点在原点上方 0.125 格高
    expect(e.getSocketPose('hand')!.y).toBeCloseTo(-0.125 * WORLD_H, 6);
  });

  it('授权头顶锚仍从格底量起：画挪了，气泡跟着挪', () => {
    const { e } = make();
    // 格底在原点下方 0.125 格高，锚在格底上方 0.95 格高
    expect(e.getAuthoredBubbleAnchorLocalY()).toBeCloseTo((0.125 - 0.95) * WORLD_H, 6);
  });

  it('投影剪影裁掉脚底线以下那截（同一帧只建一次）；没偏移的状态原样给', () => {
    const { e } = make();
    const t = e.getDisplayTexture()!;
    expect(t.frame.height).toBeCloseTo(CELL_H * 0.875, 6);
    expect(t.frame.y).toBe(0);
    expect(e.getDisplayTexture()).toBe(t);
    e.playAnimation('run');
    expect(e.getDisplayTexture()!.frame.height).toBe(CELL_H);
  });

  it('非法值按 0、超上限夹住', () => {
    expect(footOffsetOfState({ frames: [0], frameRate: 8, loop: true })).toBe(0);
    expect(footOffsetOfState({ frames: [0], frameRate: 8, loop: true, footOffset: -0.2 })).toBe(0);
    expect(footOffsetOfState({ frames: [0], frameRate: 8, loop: true, footOffset: Number.NaN })).toBe(0);
    expect(footOffsetOfState({ frames: [0], frameRate: 8, loop: true, footOffset: 0.9 })).toBe(FOOT_OFFSET_MAX);
  });
});
