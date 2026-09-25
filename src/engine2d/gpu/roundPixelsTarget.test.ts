/**
 * R2-6 离屏目标里的 roundPixels 平局方向与 master(Pixi 8.17 WebGL)一致(空后端,不需要 GPU):
 * master 对非根目标用翻转投影 calculateProjection(..., !isRoot),roundPixelsBit 取整的是「从内容顶边往下」的 y,
 * 平局 k + 0.5 落到 k + 1;engine2d 的离屏投影不翻,靠全局 uniform 尾字段 uRoundFlipY 让着色器翻 y 再取整。
 * 这里读录下来的全局 uniform 与合批顶点,按着色器(batchShader 的 ROUND_PIXELS_WGSL)逐步以 f32 求值,
 * 与拿 Pixi 自己的 calculateProjection(flipY = true) 算出的 master 行号比。像素级对照见
 * tools/engine2d_parity/cases/70_round_pixels.ts。
 */
import { describe, expect, it } from 'vitest';
import { calculateProjection as pixiCalculateProjection, Matrix as PixiMatrix } from 'pixi.js';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Texture } from '../textures/Texture';
import { BufferImageSource } from '../textures/TextureSource';
import { AlphaFilter } from '../filters/defaults/alpha/AlphaFilter';
import { BATCH_WGSL, GRAPHICS_WGSL, MESH_WGSL } from './batchShader';
import { WebGPURenderer } from './WebGPURenderer';

const f = Math.fround;
/** Pixi roundPixelsBit(GLSL / WGSL 同式),f32 求值 */
const roundPix = (p: number, T: number): number => f(f(f(Math.floor(f(f(f(f(p * 0.5) + 0.5) * T) + 0.5)) / T) * 2) - 1);
/** batchShader 的 roundPixelsTarget:flip 时 y 取反、取整、再取反 */
const roundPixTarget = (p: number, T: number, flip: number): number => (flip > 0.5 ? -roundPix(-p, T) : roundPix(p, T));

interface Captured {
  P: { d: number; ty: number };
  W: { d: number; ty: number };
  T: number;
  flip: number;
  ys: number[];
  vh: number;
  canvas: boolean;
}

function capture(y: number, h: number, filtered: boolean): Captured {
  const rhi = new NullRhiDevice();
  const canvas = { width: 1280, height: 720, style: {} } as unknown as HTMLCanvasElement;
  const r = new WebGPURenderer({ rhi, canvas, width: 1280, height: 720, resolution: 1 });
  const stage = new Container();
  const tex = new Texture({ source: new BufferImageSource({ resource: new Uint8Array(h * h * 4), width: h, height: h }) });
  const s = new Sprite(tex);
  s.anchor.set(0.5, 1);
  s.roundPixels = true;
  s.position.set(200, y);
  if (filtered) s.filters = [new AlphaFilter({ alpha: 1 })];
  stage.addChild(s);
  r.render({ container: stage });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const st = (r as any).states[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmds = st.builder.commands as any[];
  const pi = cmds.findIndex((c) => c.t === 'pass' && (filtered ? c.target !== 'canvas' : c.target === 'canvas'));
  const draw = cmds[pi + 1];
  expect(draw.t).toBe('draw');
  const a = st.builder.arena.f32 as Float32Array;
  const o = draw.bindings.globalUniforms.offset / 4;
  // UBO 里 mat3x3 列跨 4 个 float;uResolution 在 28,uRoundFlipY 在 30
  const out: Captured = {
    P: { d: a[o + 5], ty: a[o + 9] },
    W: { d: a[o + 12 + 5], ty: a[o + 12 + 9] },
    T: a[o + 29],
    flip: a[o + 30],
    ys: [0, 1, 2, 3].map((i) => (st.batcher.f32 as Float32Array)[i * 6 + 1]),
    vh: cmds[pi].viewport[3],
    canvas: cmds[pi].target === 'canvas',
  };
  r.destroy();
  return out;
}

/** 内容行号(自顶向下):分支按录下的投影 + roundPixelsTarget;master 按 Pixi calculateProjection(flipY = !isRoot) */
function rows(c: Captured): { branch: [number, number]; master: [number, number] } {
  const pm = pixiCalculateProjection(new PixiMatrix(), 0, 0, 1, c.vh, !c.canvas);
  const b: number[] = [];
  const m: number[] = [];
  for (const vy of c.ys) {
    const wy = f(f(c.W.d * vy) + c.W.ty);
    const cyB = roundPixTarget(f(f(c.P.d * wy) + c.P.ty), c.T, c.flip);
    const cyM = roundPix(f(f(f(pm.d) * wy) + f(pm.ty)), c.T);
    b.push((1 - cyB) * 0.5 * c.vh); // WebGPU:clip +1 = 第 0 行(内容顶)
    m.push(c.canvas ? (1 - cyM) * 0.5 * c.vh : (cyM + 1) * 0.5 * c.vh); // GL 翻转离屏:clip -1 = 第 0 行
  }
  return { branch: [Math.min(...b), Math.max(...b)], master: [Math.min(...m), Math.max(...m)] };
}

describe('R2-6 离屏目标 roundPixels 平局方向', () => {
  it('内置合批 / 图形 / 网格着色器的取整都走 roundPixelsTarget,GlobalUniforms 末尾带 uRoundFlipY', () => {
    for (const src of [BATCH_WGSL, GRAPHICS_WGSL, MESH_WGSL]) {
      expect(src).toMatch(/uResolution: vec2<f32>,\s*uRoundFlipY: f32,\s*\}/);
      expect(src).toContain('fn roundPixelsTarget(');
      expect(src).not.toMatch(/roundPixels\(vPosition/);
      expect(src).toContain('roundPixelsTarget(vPosition.xy)');
    }
  });

  it('滤镜输入纹理里平局落点与 master 一致(63 / 31 高、y = 300.5)', () => {
    for (const [y, h, rowsM] of [
      [300.5, 63, [1, 64]],
      [300.5, 31, [1, 32]],
    ] as const) {
      const c = capture(y, h, true);
      expect(c.canvas).toBe(false);
      expect(c.flip).toBe(1);
      const r = rows(c);
      expect(r.master).toEqual(rowsM);
      expect(r.branch).toEqual(r.master);
    }
  });

  it('非平局与画布不受影响', () => {
    for (const [y, h] of [
      [300.25, 63],
      [300, 64],
    ] as const) {
      const r = rows(capture(y, h, true));
      expect(r.branch).toEqual(r.master);
    }
    const c = capture(300.5, 63, false);
    expect(c.canvas).toBe(true);
    expect(c.flip).toBe(0);
    const r = rows(c);
    expect(r.branch).toEqual(r.master);
  });
});
