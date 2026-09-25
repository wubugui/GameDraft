/**
 * roundPixels inside render targets: master (Pixi WebGL) binds RTs with a flipped projection
 * (calculateProjection(..., !isRoot) => d = +2/h, ty = -1); engine2d (WebGPU) always uses d = -2/h, ty = +1.
 * roundPixels = floor((clip*0.5+0.5)*T + 0.5): master rounds u*T (u = y/vh from content top),
 * branch rounds (1-u)*T. Ties (u*T == k+0.5) go opposite ways; near-ties differ through f32 error.
 *
 * Here we drive the REAL engine2d renderer (NullRhiDevice) with game-shaped hotspot sprites
 * (anchor .5/1, roundPixels, own filter), pull the recorded global uniforms + batched vertices
 * of the draw into the filter RT, and emulate the vertex shader in f32 for both projections.
 */
import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { BufferImageSource } from '../../../../src/engine2d/textures/TextureSource';
import { AlphaFilter } from '../../../../src/engine2d/filters/defaults/alpha/AlphaFilter';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

const f = Math.fround;

function roundPix(p: number, T: number): number {
  // (floor(((position * 0.5 + 0.5) * targetSize) + 0.5) / targetSize) * 2.0 - 1.0  (f32)
  const a = f(f(f(f(p * 0.5) + 0.5) * T) + 0.5);
  return f(f(f(Math.floor(a) / T) * 2) - 1);
}

/** f32 3x3 mul (column-major arrays of 9) */
function mul(A: number[], B: number[]): number[] {
  const o = new Array(9).fill(0);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s = f(s + f(A[k * 3 + r] * B[c * 3 + k]));
    o[c * 3 + r] = s;
  }
  return o;
}

interface Row { top: number; bottom: number; left: number; right: number }

function emulate(P: number[], W: number[], verts: number[][], T: [number, number], vw: number, vh: number, glFlip: boolean): Row {
  const mvp = mul(P, W);
  const ys: number[] = [];
  const xs: number[] = [];
  for (const [x, y] of verts) {
    let cx = f(f(f(mvp[0] * x) + f(mvp[3] * y)) + mvp[6]);
    let cy = f(f(f(mvp[1] * x) + f(mvp[4] * y)) + mvp[7]);
    cx = roundPix(cx, T[0]);
    cy = roundPix(cy, T[1]);
    xs.push(Math.round((cx * 0.5 + 0.5) * vw * 256) / 256);
    // content row measured from the content top in both APIs
    ys.push(Math.round((glFlip ? (cy * 0.5 + 0.5) : (0.5 - cy * 0.5)) * vh * 256) / 256);
  }
  return { top: Math.min(...ys), bottom: Math.max(...ys), left: Math.min(...xs), right: Math.max(...xs) };
}

function mat(a: Float32Array, o: number): number[] {
  return [a[o], a[o + 1], a[o + 2], a[o + 4], a[o + 5], a[o + 6], a[o + 8], a[o + 9], a[o + 10]];
}

function texture(w: number, h: number): Texture {
  const src = new BufferImageSource({ resource: new Uint8Array(w * h * 4), width: w, height: h });
  return new Texture({ source: src });
}

interface Cfg { res: number; S: number; tx: number; ty: number; hx: number; hy: number; tw: number; th: number; ww: number; wh: number; pad: number }

function run(renderer: WebGPURenderer, cfg: Cfg, tex: Texture) {
  const stage = new Container();
  const world = new Container();
  world.scale.set(cfg.S, cfg.S);
  world.position.set(cfg.tx, cfg.ty);
  stage.addChild(world);
  const hs = new Container();
  hs.position.set(cfg.hx, cfg.hy);
  world.addChild(hs);
  const spr = new Sprite(tex);
  spr.anchor.set(0.5, 1);
  spr.width = cfg.ww;
  spr.height = cfg.wh;
  spr.roundPixels = true;
  const flt = new AlphaFilter({ alpha: 1 });
  flt.padding = cfg.pad;
  spr.filters = [flt];
  hs.addChild(spr);
  renderer.render({ container: stage });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const st = (renderer as any).states[0];
  const cmds = st.builder.commands as any[];
  // first pass after the canvas pass = filter input RT; its first draw is the sprite batch
  const pi = cmds.findIndex((c) => c.t === 'pass' && c.target !== 'canvas');
  const pass = cmds[pi];
  const draw = cmds[pi + 1];
  if (pi < 0 || !draw || draw.t !== 'draw') { stage.destroy({ children: true }); return null; }
  expect(draw.pipeline.program.name).toBe('engine2d-batch');
  const a = st.builder.arena.f32 as Float32Array;
  const o = draw.bindings.globalUniforms.arena / 4;
  const P = mat(a, o);
  const W = mat(a, o + 12);
  const T: [number, number] = [a[o + 28], a[o + 29]];
  const vb = st.batcher.f32 as Float32Array;
  const u32 = st.batcher.u32 as Uint32Array;
  const verts: number[][] = [];
  for (let i = 0; i < 4; i++) {
    verts.push([vb[i * 6], vb[i * 6 + 1]]);
    expect(u32[i * 6 + 5] & 0xffff).toBe(1); // round flag packed
  }
  const [, , vw, vh] = pass.viewport as number[];
  // master WebGL projection for the same viewport: calculateProjection(..., flipY = true)
  const Pm = [P[0], 0, 0, 0, -P[4], 0, P[6], -P[7], 1];
  const b = emulate(P, W, verts, T, vw, vh, false);
  const m = emulate(Pm, W, verts, T, vw, vh, true);
  stage.destroy({ children: true });
  return { b, m, P, T, vw, vh, verts };
}

function mkRenderer(res: number) {
  const rhi = new NullRhiDevice();
  const canvas = { width: Math.round(1280 * res), height: Math.round(720 * res), style: {} } as unknown as HTMLCanvasElement;
  return new WebGPURenderer({ rhi, canvas, width: 1280, height: 720, resolution: res });
}

describe('roundPixels in filter RTs: branch (WebGPU) vs master (WebGL flipped RT projection)', () => {
  it('sanity: branch RT projection is not flipped; uResolution = pooled RT pixel size', () => {
    const r = mkRenderer(1);
    const out = run(r, { res: 1, S: 1, tx: 0, ty: 0, hx: 200, hy: 300.5, tw: 64, th: 64, ww: 64, wh: 64, pad: 0 }, texture(64, 64));
    const o2 = out!; console.log('P', o2.P, 'T', out.T, 'viewport', out.vw, out.vh, 'verts', out.verts);
    expect(o2.P[4]).toBeLessThan(0);
    // tie: sprite top at y=236.5, bottom 300.5 → RT rel .5 / 64.5 with vh=T=65→? print
    console.log("branch", o2.b, "master", o2.m);
    r.destroy();
  });

  it('constructed tie (res 1, pow2-exact bounds): whole sprite 1px shift', () => {
    const r = mkRenderer(1);
    // sprite 63 px tall at y .5 → bounds ceil → 64 px RT, vh = T = 64, rel top .5, bottom 63.5
    const out = run(r, { res: 1, S: 1, tx: 0, ty: 0, hx: 200, hy: 300.5, tw: 63, th: 63, ww: 63, wh: 63, pad: 0 }, texture(63, 63));
    console.log("tie branch", out!.b, "master", out!.m, "vh", out!.vh, "T", out!.T);
    r.destroy();
  });

  it('random sweep with game-shaped params', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const report: Record<string, { n: number; wholeShift: number; edgeOnly: number; xDiff: number }> = {};
    const texes = new Map<string, Texture>();
    for (const res of [1, 1.25, 1.5, 2]) {
      const r = mkRenderer(res);
      for (const mode of ['continuous', 'snappedInt', 'gameLikeZoomCont', 'gameLikeS1', 'sceneZoom1.25', 'sceneZoom1.5']) {
        const key = `res=${res} ${mode}`;
        const acc = (report[key] = { n: 0, wholeShift: 0, edgeOnly: 0, xDiff: 0 });
        for (let i = 0; i < 1500; i++) {
          const S = mode === 'continuous' || mode === 'gameLikeZoomCont' ? 0.8 + rnd() * 0.8 : mode === 'gameLikeS1' ? 1 : mode === 'sceneZoom1.25' ? 1.25 : mode === 'sceneZoom1.5' ? 1.5 : [1, 1, 1.25, 1.5, 2][Math.floor(rnd() * 5)];
          const tw = 32 + Math.floor(rnd() * 400);
          const th = 32 + Math.floor(rnd() * 400);
          const k = `${tw}x${th}`;
          if (!texes.has(k)) texes.set(k, texture(tw, th));
          const cfg: Cfg = {
            res, S,
            tx: mode === 'continuous' ? rnd() * 1000 - 500 : Math.round(rnd() * 1000 - 500),
            ty: mode === 'continuous' ? rnd() * 600 - 300 : Math.round(rnd() * 600 - 300),
            hx: mode === 'continuous' ? 200 + rnd() * 600 : 200 + Math.round(rnd() * 600),
            hy: mode === 'continuous' ? 300 + rnd() * 300 : 300 + Math.round(rnd() * 300),
            tw, th,
            ww: mode === 'continuous' ? tw * (0.3 + rnd()) : Math.round(tw * (0.3 + rnd())),
            wh: mode === 'continuous' ? th * (0.3 + rnd()) : Math.round(th * (0.3 + rnd())),
            pad: [0, 0, 4, 8][Math.floor(rnd() * 4)],
          };
          const out = run(r, cfg, texes.get(k)!);
          if (!out) continue;
          const { b, m } = out;
          acc.n++;
          const dt = b.top - m.top;
          const db = b.bottom - m.bottom;
          if (b.left !== m.left || b.right !== m.right) acc.xDiff++;
          if (dt !== 0 && db !== 0 && dt === db) acc.wholeShift++;
          else if (dt !== 0 || db !== 0) acc.edgeOnly++;
        }
      }
      r.destroy();
    }
    console.table(report);
  }, 120_000);
});
