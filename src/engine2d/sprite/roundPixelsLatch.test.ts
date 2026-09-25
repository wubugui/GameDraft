/**
 * D4 合批元素的 roundPixels 与 Pixi 8.17 对照:各 pipe 只在建 BatchableXxx 时取一次
 * `renderer._roundPixels | view._roundPixels`(SpritePipe._initGPUSprite / MeshPipe._initBatchableMesh /
 * NineSliceSpritePipe.initGPUSprite / CanvasTextPipe.initGpuText / HTMLTextPipe.initGpuText),之后改 roundPixels
 * 不生效,直到 unload / destroy 丢掉 GPU 侧数据。渲染器级 roundPixels 也或进去。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../scene/Container';
import { Sprite } from './Sprite';
import { NineSliceSprite } from './NineSliceSprite';
import { MeshPlane } from '../mesh/Mesh';
import { Text } from '../text/Text';
import { HTMLText } from '../text/html/HTMLText';
import { makeFakeAdapter } from '../text/_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from '../text/adapter';
import { Texture } from '../textures/Texture';
import { WebGPURenderer } from '../gpu/WebGPURenderer';
import type { BatchableElement, RenderCollector } from '../core/contracts';

beforeAll(() => {
  const adapter = makeFakeAdapter();
  setTextDOMAdapter(adapter as unknown as TextDOMAdapter);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Pixi:照指令构建的顺序驱动 SpritePipe.addRenderable,再用 DefaultBatcher 打包,读 textureIdAndRound 的低 16 位 */
function pixiSpriteRoundBits(frames: boolean[], rendererRound = 0): number[] {
  const captured: PIXI.BatchableSprite[] = [];
  const renderer = { uid: 3, _roundPixels: rendererRound, renderPipes: { batch: { addToBatch: (e: PIXI.BatchableSprite) => captured.push(e) } } };
  const pipe = new PIXI.SpritePipe(renderer as never);
  const spr = new PIXI.Sprite(PIXI.Texture.WHITE);
  const batcher = Object.create(PIXI.DefaultBatcher.prototype) as PIXI.DefaultBatcher;
  const out: number[] = [];
  for (const rp of frames) {
    spr.roundPixels = rp;
    spr.didViewUpdate = true; // 连 _updateBatchableSprite 也走一遍
    pipe.addRenderable(spr, {} as never);
    const el = captured[captured.length - 1];
    const f32 = new Float32Array(24);
    const u32 = new Uint32Array(f32.buffer);
    batcher.packQuadAttributes(el as never, f32, u32, 0, 0);
    out.push(u32[5] & 0xffff);
  }
  return out;
}

/** engine2d:整帧 render(空后端),从上传的顶点数据读 textureIdAndRound 的低 16 位 */
function engine2dSpriteRoundBits(frames: Array<boolean | 'unload'>, rendererRound = false): number[] {
  const rhi = new NullRhiDevice();
  const canvas = { width: 8, height: 8, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8, roundPixels: rendererRound });
  const writes: Uint32Array[] = [];
  const origWrite = rhi.writeBuffer.bind(rhi);
  vi.spyOn(rhi, 'writeBuffer').mockImplementation((b, data, off) => {
    if (/vert/i.test(String((b as { label?: string }).label))) {
      const v = data as ArrayBufferView;
      writes.push(new Uint32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    }
    return origWrite(b, data, off);
  });
  const root = new Container();
  const spr = new Sprite(Texture.WHITE);
  root.addChild(spr);
  const out: number[] = [];
  for (const rp of frames) {
    if (rp === 'unload') {
      spr.unload();
      continue;
    }
    spr.roundPixels = rp;
    const n = writes.length;
    renderer.render({ container: root });
    const w = writes.slice(n).find((a) => a.length >= 24);
    out.push(w ? w[5] & 0xffff : -1);
  }
  renderer.destroy();
  return out;
}

class FakeCollector implements RenderCollector {
  items: BatchableElement[] = [];
  constructor(public roundPixels = 0, public resolution = 1) {}
  addBatchable(e: BatchableElement): void {
    this.items.push({ ...e });
  }
  addCustom(): void {}
  addUnbatched(): void {}
  pushFilter(): void {}
  popFilter(): void {}
  pushMask(): void {}
  popMask(): void {}
}

/** 按序收集,每次收集前把 roundPixels 设成给定值;返回每次交出的合批元素的 roundPixels */
function latchSequence(
  view: { roundPixels: boolean; collectRenderables(c: RenderCollector): void; unload(): void },
  frames: Array<boolean | 'unload'>,
  rendererRound = 0,
): number[] {
  const out: number[] = [];
  for (const rp of frames) {
    if (rp === 'unload') {
      view.unload();
      continue;
    }
    view.roundPixels = rp;
    const c = new FakeCollector(rendererRound);
    view.collectRenderables(c);
    out.push(c.items.length ? c.items[c.items.length - 1].roundPixels : -1);
  }
  return out;
}

describe('D4 Sprite:roundPixels 首次渲染时锁定', () => {
  it('先 false 后 true:Pixi 一直是 0,engine2d 同', () => {
    const seq = [false, true, true];
    expect(pixiSpriteRoundBits(seq)).toEqual([0, 0, 0]);
    expect(engine2dSpriteRoundBits(seq)).toEqual([0, 0, 0]);
  });

  it('先 true 后 false:Pixi 保持 1,engine2d 同', () => {
    const seq = [true, false];
    expect(pixiSpriteRoundBits(seq)).toEqual([1, 1]);
    expect(engine2dSpriteRoundBits(seq)).toEqual([1, 1]);
  });

  it('渲染器级 roundPixels 或进去(Pixi `renderer._roundPixels | sprite._roundPixels`)', () => {
    expect(pixiSpriteRoundBits([false], 1)).toEqual([1]);
    expect(engine2dSpriteRoundBits([false], true)).toEqual([1]);
  });

  it('unload 丢掉 GPU 侧数据后重新取值', () => {
    expect(engine2dSpriteRoundBits([false, true, 'unload', true])).toEqual([0, 0, 1]);
  });
});

describe('D4 其它合批节点同样锁定', () => {
  it('合批 Mesh(照 MeshPipe._initBatchableMesh)', () => {
    // Pixi 侧:MeshPipe 的 batchableMesh 只建一次
    const captured: Array<{ roundPixels: number }> = [];
    const renderer = { uid: 5, _roundPixels: 0, renderPipes: { batch: { addToBatch: (e: { roundPixels: number }) => captured.push({ roundPixels: e.roundPixels }) } } };
    const pipe = new PIXI.MeshPipe(renderer as never, { init() {} } as never);
    const pm = new PIXI.MeshPlane({ texture: PIXI.Texture.WHITE, verticesX: 2, verticesY: 2 });
    for (const rp of [false, true]) {
      pm.roundPixels = rp;
      pipe.addRenderable(pm, {} as never);
    }
    expect(captured.map((c) => c.roundPixels)).toEqual([0, 0]);

    const mesh = new MeshPlane({ texture: Texture.WHITE, verticesX: 2, verticesY: 2 });
    expect(mesh.batched).toBe(true);
    expect(latchSequence(mesh, [false, true, true])).toEqual([0, 0, 0]);
    expect(latchSequence(new MeshPlane({ texture: Texture.WHITE, verticesX: 2, verticesY: 2 }), [false], 1)).toEqual([1]);
  });

  it('NineSliceSprite(照 NineSliceSpritePipe.initGPUSprite)', () => {
    const s = new NineSliceSprite({ texture: Texture.WHITE, leftWidth: 2, rightWidth: 2, topHeight: 2, bottomHeight: 2, width: 20, height: 20 });
    expect(latchSequence(s, [false, true, 'unload', true])).toEqual([0, 0, 1]);
    const s2 = new NineSliceSprite({ texture: Texture.WHITE, width: 20, height: 20 });
    expect(latchSequence(s2, [false], 1)).toEqual([1]);
  });

  it('Text(照 CanvasTextPipe.initGpuText)', () => {
    const t = new Text({ text: 'abc' });
    expect(latchSequence(t, [false, true, 'unload', true])).toEqual([0, 0, 1]);
    expect(latchSequence(new Text({ text: 'x' }), [true, false], 1)).toEqual([1, 1]);
    t.destroy();
  });

  it('HTMLText(照 HTMLTextPipe.initGpuText:纹理还没出来的那几次收集也算首次)', () => {
    const t = new HTMLText({ text: 'abc' });
    // 不跑真的 SVG 出图:首次收集时纹理还是 EMPTY(不交元素),之后手动给一张纹理
    (t as unknown as { _updateGpuText: () => Promise<void> })._updateGpuText = async () => {};
    const c0 = new FakeCollector(0);
    t.roundPixels = false;
    t.collectRenderables(c0);
    expect(c0.items).toHaveLength(0);
    (t as unknown as { _gpuText: { texture: Texture } })._gpuText.texture = Texture.WHITE;
    expect(latchSequence(t, [true, true])).toEqual([0, 0]);
  });
});
