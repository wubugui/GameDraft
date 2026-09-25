/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FillGradient 对照测试:同样的选项分别建 Pixi 与 engine2d 的渐变,比较画布调用序列(注入的假画布)、
 * 色标字符串(按 Pixi Color 的 float32 量化)、纹理尺寸与寻址方式、transform 矩阵、styleKey 计数。
 */
import * as PIXI from 'pixi.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CanvasSource } from '../textures/TextureSource';
import { FillGradient, type GradientOptions } from './fill/FillGradient';

function makeFakeCanvasFactory(log: unknown[][]) {
  let n = 0;
  return (width = 1, height = 1): any => {
    const ctx = {
      set fillStyle(v: unknown) {
        log.push(['fillStyle', typeof v === 'string' ? v : (v as { id: string }).id]);
      },
      createLinearGradient: (...a: number[]) => {
        const id = `lin${n++}`;
        log.push(['createLinearGradient', ...a]);
        return { id, addColorStop: (o: number, c: string) => log.push(['addColorStop', id, o, c]) };
      },
      createRadialGradient: (...a: number[]) => {
        const id = `rad${n++}`;
        log.push(['createRadialGradient', ...a]);
        return { id, addColorStop: (o: number, c: string) => log.push(['addColorStop', id, o, c]) };
      },
      fillRect: (...a: number[]) => log.push(['fillRect', ...a]),
      translate: (...a: number[]) => log.push(['translate', ...a]),
      rotate: (...a: number[]) => log.push(['rotate', ...a]),
      scale: (...a: number[]) => log.push(['scale', ...a]),
    };
    log.push(['createCanvas', width, height]);
    return { width, height, getContext: () => ctx };
  };
}

const pixiLog: unknown[][] = [];
const e2dLog: unknown[][] = [];
const adapter0 = PIXI.DOMAdapter.get();
const createCanvas0 = FillGradient.createCanvas;

beforeAll(() => {
  PIXI.DOMAdapter.set({ ...adapter0, createCanvas: makeFakeCanvasFactory(pixiLog) });
  FillGradient.createCanvas = makeFakeCanvasFactory(e2dLog);
});
afterAll(() => {
  PIXI.DOMAdapter.set(adapter0);
  FillGradient.createCanvas = createCanvas0;
});

function describeGradient(g: any): unknown {
  const t = g.texture;
  const m = g.transform;
  return {
    type: g.type,
    textureSpace: g.textureSpace,
    colorStops: g.colorStops,
    tex: t ? [t.source.width, t.source.height, t.source.pixelWidth, t.source.pixelHeight, t.source.style.addressModeU, t.source.style.addressModeV, t.frame.width, t.frame.height, t.uvs.x1, t.uvs.y2] : null,
    transform: m ? [m.a, m.b, m.c, m.d, m.tx, m.ty] : null,
    tick: g._tick,
    start: g.start ?? null,
    end: g.end ?? null,
    center: g.center ?? null,
    outerCenter: g.outerCenter ?? null,
    innerRadius: g.innerRadius ?? null,
    outerRadius: g.outerRadius ?? null,
    scale: g.scale ?? null,
    rotation: g.rotation ?? null,
  };
}

const optionCases: Array<[string, GradientOptions]> = [
  ['UIDecor 线性 local', {
    type: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, textureSpace: 'local',
    colorStops: [
      { offset: 0, color: 'rgba(200,160,90,0)' }, { offset: 0.25, color: 'rgba(200,160,90,0.72)' },
      { offset: 0.75, color: 'rgba(200,160,90,0.72)' }, { offset: 1, color: 'rgba(200,160,90,0)' },
    ],
  }],
  ['PanelSkin 径向 local', {
    type: 'radial', center: { x: 0.5, y: 0.42 }, innerRadius: 0, outerCenter: { x: 0.5, y: 0.42 }, outerRadius: 0.72, textureSpace: 'local',
    colorStops: [{ offset: 0, color: 'rgba(0,0,0,0)' }, { offset: 0.5, color: 'rgba(0,0,0,0.048)' }, { offset: 1, color: 'rgba(0,0,0,0.160)' }],
  }],
  ['线性 缺省选项', {}],
  ['径向 缺省选项', { type: 'radial' }],
  ['线性 反向 + repeat + 小纹理', { type: 'linear', start: { x: 10, y: 50 }, end: { x: 0, y: 0 }, wrapMode: 'repeat', textureSize: 64, textureSpace: 'global', colorStops: [{ offset: 0, color: 0xff0000 }, { offset: 1, color: [0, 0, 1, 0.7] }] }],
  ['线性 反向 clamp(交换端点)', { type: 'linear', start: { x: 100, y: 80 }, end: { x: 0, y: 0 }, textureSpace: 'global', colorStops: [{ offset: 0, color: 'red' }, { offset: 1, color: 'blue' }] }],
  ['径向 偏心 + 缩放 + 旋转', { type: 'radial', center: { x: 30, y: 30 }, innerRadius: 5, outerCenter: { x: 40, y: 35 }, outerRadius: 50, scale: 0.5, rotation: 0.7, textureSpace: 'global', colorStops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#00000080' }] }],
];

describe('FillGradient 与 Pixi 对照', () => {
  for (const [name, options] of optionCases) {
    it(name, () => {
      pixiLog.length = 0;
      e2dLog.length = 0;
      const p = new PIXI.FillGradient(options as any);
      const e = new FillGradient(options);
      expect(describeGradient(e)).toEqual(describeGradient(p));
      p.buildGradient();
      e.buildGradient();
      expect(describeGradient(e)).toEqual(describeGradient(p));
      expect(e2dLog).toEqual(pixiLog);
      expect(e.texture.source).toBeInstanceOf(CanvasSource);
      // 再 build 不重画、不加 tick
      e.buildGradient();
      p.buildGradient();
      expect(describeGradient(e)).toEqual(describeGradient(p));
      expect(e.styleKey.replace(/-\d+-/, '-#-')).toBe(p.styleKey.replace(/-\d+-/, '-#-'));
    });
  }

  it('弃用的位置参数构造', () => {
    const p = new (PIXI.FillGradient as any)(0, 0, 100, 0, 'global', 128);
    const e = new (FillGradient as any)(0, 0, 100, 0, 'global', 128);
    p.addColorStop(0, 0xffffff).addColorStop(1, 'rgba(0,0,0,0.7)');
    e.addColorStop(0, 0xffffff).addColorStop(1, 'rgba(0,0,0,0.7)');
    pixiLog.length = 0;
    e2dLog.length = 0;
    p.buildGradient();
    e.buildGradient();
    expect(describeGradient(e)).toEqual(describeGradient(p));
    expect(e2dLog).toEqual(pixiLog);
  });

  it('destroy 连带纹理', () => {
    const e = new FillGradient({ type: 'linear' });
    e.buildGradient();
    const tex = e.texture;
    e.destroy();
    expect(tex.destroyed).toBe(true);
    expect(e.texture).toBeNull();
    expect(e.colorStops).toEqual([]);
  });
});
