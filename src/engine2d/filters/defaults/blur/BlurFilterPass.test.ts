/**
 * 多 pass 模糊的中间 pass 与 master 对齐(A/B 实测:投影阴影模糊的下 / 右沿差出几级):master 跑 Pixi 的 WebGL 那条——
 * 中间 pass 不清屏(legacy 的第一 pass 除外)、关混合覆盖写,四边形外那圈临时纹理保留池里上一次的内容。
 * 这里拿 Pixi 真的 BlurFilterPass(renderer.type = WEBGL)与 engine2d 并排,逐 pass 比「清不清、混不混」。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';

// Pixi 建 GlProgram 时经 DOMAdapter 建测试画布探片元精度(node 里没有 document):换成拿不到上下文的替身,它退回缺省精度
const realAdapter = PIXI.DOMAdapter.get();
beforeAll(() => {
  PIXI.DOMAdapter.set({ ...realAdapter, createCanvas: () => ({ getContext: () => null }) as never });
});
afterAll(() => {
  PIXI.DOMAdapter.set(realAdapter);
});
import { BlurFilterPass } from './BlurFilterPass';
import { Texture } from '../../../textures/Texture';
import type { FilterSystemLike } from '../../Filter';

type Step = [clear: boolean, blend: boolean];

function pixiSteps(quality: number, legacy: boolean): Step[] {
  const steps: Step[] = [];
  const pass = new PIXI.BlurFilterPass({ horizontal: true, strength: 8, quality, legacy } as never);
  const fm = {
    renderer: { type: PIXI.RendererType.WEBGL, renderPipes: {} },
    applyFilter(f: { _state: { blend: boolean } }, _i: unknown, _o: unknown, clear: boolean) {
      steps.push([!!clear, f._state.blend]);
    },
  };
  pass.apply(fm as never, PIXI.Texture.WHITE as never, PIXI.Texture.WHITE as never, true);
  return steps;
}

function engineSteps(quality: number, legacy: boolean): Step[] {
  const steps: Step[] = [];
  const pass = new BlurFilterPass({ horizontal: true, strength: 8, quality, legacy });
  const fm = {
    applyFilter(f: BlurFilterPass, _i: unknown, _o: unknown, clear: boolean) {
      steps.push([!!clear, f.blendMode !== 'none']);
    },
  } as unknown as FilterSystemLike;
  pass.apply(fm, Texture.WHITE, Texture.WHITE as never, true);
  expect(pass.blendMode).toBe('normal'); // apply 之后还原
  return steps;
}

describe('BlurFilterPass 中间 pass 的清屏 / 混合与 master(Pixi WebGL)一致', () => {
  for (const legacy of [false, true]) {
    for (const quality of [1, 2, 3, 4]) {
      it(`${legacy ? 'legacy' : 'optimized'} · quality ${quality}`, () => {
        const want = pixiSteps(quality, legacy);
        expect(want.length).toBe(quality);
        expect(engineSteps(quality, legacy)).toEqual(want);
      });
    }
  }
});
