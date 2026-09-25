import { describe, expect, it } from 'vitest';
import { calculateProjection as pixiCalcProj, Matrix as PixiMatrix } from 'pixi.js';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { BufferImageSource } from '../../../../src/engine2d/textures/TextureSource';
import { AlphaFilter } from '../../../../src/engine2d/filters/defaults/alpha/AlphaFilter';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

const f = Math.fround;
// Pixi roundPixelsBit (identical in GLSL/WGSL), evaluated in f32
const roundPix = (p: number, T: number) => f(f(f(Math.floor(f(f(f(f(p * 0.5) + 0.5) * T) + 0.5)) / T) * 2) - 1);

function capture(y: number, h: number) {
  const rhi = new NullRhiDevice();
  const canvas = { width: 1280, height: 720, style: {} } as unknown as HTMLCanvasElement;
  const r = new WebGPURenderer({ rhi, canvas, width: 1280, height: 720, resolution: 1 });
  const stage = new Container();
  const tex = new Texture({ source: new BufferImageSource({ resource: new Uint8Array(h * h * 4), width: h, height: h }) });
  const s = new Sprite(tex);
  s.anchor.set(0.5, 1);
  s.roundPixels = true;
  s.position.set(200, y);
  s.filters = [new AlphaFilter({ alpha: 1 })];
  stage.addChild(s);
  r.render({ container: stage });
  const st = (r as any).states[0];
  const cmds = st.builder.commands as any[];
  const pi = cmds.findIndex((c) => c.t === 'pass' && c.target !== 'canvas');
  const draw = cmds[pi + 1];
  expect(draw.t).toBe('draw');
  const a = st.builder.arena.f32 as Float32Array;
  const o = draw.bindings.globalUniforms.arena / 4;
  // mat3x3 in UBO: column stride 4
  const P = { a: a[o], d: a[o + 5], tx: a[o + 8], ty: a[o + 9] };
  const W = { d: a[o + 12 + 5], ty: a[o + 12 + 9] };
  const T = a[o + 29];
  const vb = st.batcher.f32 as Float32Array;
  const ys = [0, 1, 2, 3].map((i) => vb[i * 6 + 1]);
  const vh = cmds[pi].viewport[3];
  r.destroy();
  return { P, W, T, ys, vh };
}

describe('roundPixels tie in filter RT', () => {
  it('branch vs master(Pixi calculateProjection with flipY=!isRoot=true)', () => {
    for (const [y, h] of [[300.5, 63], [300.5, 31], [300.25, 63], [300, 64]] as const) {
      const c = capture(y, h);
      // master: Pixi RenderTargetSystem.bind -> calculateProjection(pm,0,0,vw/res,vh/res, !isRoot)
      const pm = pixiCalcProj(new PixiMatrix(), 0, 0, 1, c.vh, true);
      const rowsB: number[] = [];
      const rowsM: number[] = [];
      for (const vy of c.ys) {
        const wy = f(f(c.W.d * vy) + c.W.ty); // world->RT-local (offset already folded in ty)
        const cyB = roundPix(f(f(c.P.d * wy) + c.P.ty), c.T);
        const cyM = roundPix(f(f(f(pm.d) * wy) + f(pm.ty)), c.T);
        rowsB.push((1 - cyB) * 0.5 * c.vh); // WebGPU: clip +1 = row 0 (content top)
        rowsM.push((cyM + 1) * 0.5 * c.vh); // GL flipped RT: clip -1 = row 0 (content top)
      }
      console.log(JSON.stringify({ y, h, P: c.P, pmd: pm.d, pmty: pm.ty, T: c.T, vh: c.vh, vertsY: c.ys, W: c.W,
        branch: [Math.min(...rowsB), Math.max(...rowsB)], master: [Math.min(...rowsM), Math.max(...rowsM)] }));
    }
  });
});
