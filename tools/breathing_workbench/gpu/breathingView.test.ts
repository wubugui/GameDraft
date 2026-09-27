/**
 * 呼吸工作台画面 == 游戏画面（无 GPU 那一半）：同一组输入（分层图 + 位移场 + 骨架常数 + 表演帧 + "屏"的尺寸 / 分辨率），
 *
 * - **工作台**：`BreathingStage`（页面 `viewer/app.js` 调的就是它：`setAsset` → `layout(屏)` → `applyFrame` → 渲染）；
 * - **游戏**：照游戏组装层现拼——`BreathingOverlaySystem.show` 的 prepare（`createBreathingFieldTextures`）→
 *   `CutsceneRenderer.showBreathingLayer(…, 50, 50, 100)`（`percentLayerRect` → `createBreathingOverlayMesh`）→
 *   `BreathingOverlaySystem.update` 的 `apply(breathingUniforms(…))` → 渲染。
 *
 * 两边各开一台空后端设备（`NullRhiDevice`），`traceRhi` 把决定像素的全部 GPU 输入（pass、视口、管线与 WGSL、uniform 字节、
 * 纹理内容、顶点 / 索引字节、draw）记成规范化的串，**必须逐行相同**。出片那条（离屏渲染纹理）对的是引擎自己的离屏画法
 * （`generateTexture`，即 extract 用的那条）。真 GPU 上的逐像素对照另有 `tools/breathing_workbench/tests/parity/run.mjs`（Chrome）。
 */
import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { BufferImageSource, Container, Texture, WebGPURenderer } from '../../../src/engine2d';
import type { BreathingOverlayRig } from '../../../src/data/breathingOverlays';
import { createBreathingFieldTextures, createBreathingOverlayMesh } from '../../../src/rendering/breathingOverlayMesh';
import { breathingUniforms, type BreathingUniformInput } from '../../../src/rendering/breathingUniforms';
import { percentLayerRect } from '../../../src/rendering/overlayPercentLayout';
import { BreathingPerformance } from '../../../src/systems/breathing/BreathingPerformance';
import { traceRhi } from '../../workbench_rhi/rhiTrace';
import { createOffscreenTarget } from '../../workbench_rhi/offscreenReadback';
import { BreathingStage, REST_UNIFORMS, type BreathingAssetInput } from './breathingView';

const SIZE: [number, number] = [96, 54];
const FW = 48;
const FH = 27;

const RIG: BreathingOverlayRig = {
  pxPerMm: 1.5, root: [50, 30], rootDisp: [0.05, -0.6], flapLengthPx: 14, flapNormal: [0.94, -0.35], lampDir: [0.985, 0.17], shade: 0.12,
  limits: { sheetMm: 15, ventMm: 24, cranMm: 12 },
};

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return (s & 0xffffff) / 0x1000000;
  };
}

/** 预乘的带 alpha 层（游戏装载口径：解码期已 ×alpha）：软边块 + 渐变 */
function layer(seed: number, box: [number, number, number, number] | null): Texture {
  const [w, h] = SIZE;
  const r = rng(seed);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 1;
      if (box) {
        const dx = Math.max(box[0] - x, 0, x - box[2]);
        const dy = Math.max(box[1] - y, 0, y - box[3]);
        a = Math.max(0, 1 - Math.hypot(dx, dy) / 3);
      }
      const i = (y * w + x) * 4;
      data[i] = Math.round(Math.min(1, 0.2 + 0.7 * x / w + 0.05 * r()) * a * 255);
      data[i + 1] = Math.round(Math.min(1, 0.25 + 0.5 * y / h + 0.05 * r()) * a * 255);
      data[i + 2] = Math.round((0.3 + 0.1 * seed % 3) * a * 255);
      data[i + 3] = Math.round(a * 255);
    }
  }
  return new Texture({ source: new BufferImageSource({ resource: data, width: w, height: h, alphaMode: 'premultiplied-alpha', scaleMode: 'linear' }) });
}

function half(x: number): number {
  const f = new Float32Array([x]);
  const u = new Uint32Array(f.buffer)[0];
  const sign = (u >>> 16) & 0x8000;
  const exp = ((u >>> 23) & 0xff) - 127 + 15;
  const mant = (u >>> 13) & 0x3ff;
  if (x === 0 || exp <= 0) return sign;
  return sign | (exp << 10) | mant;
}

/** 两张 RGBA16F 位移场背靠背（① 纸面鼓包法向 × 权重 ② 胸口朝上 / 朝头权重） */
function fieldBytes(): ArrayBuffer {
  const per = FW * FH * 4;
  const u16 = new Uint16Array(per * 2);
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const i = (y * FW + x) * 4;
      const dx = (x - 14) / 9;
      const dy = (y - 9) / 6;
      const wgt = Math.max(0, 1 - (dx * dx + dy * dy));
      u16[i] = half(0.1 * wgt);
      u16[i + 1] = half(-wgt);
      u16[i + 2] = half(wgt);
      const c = x > 20 && y > 16 ? 1 : 0;
      u16[per + i] = half(-c);
      u16[per + i + 1] = half(0.4 * c);
    }
  }
  return u16.buffer;
}

interface Textures {
  base: Texture;
  body: Texture;
  sheet: Texture;
  flap: Texture;
  bytes: ArrayBuffer;
}

function textures(): Textures {
  return {
    base: layer(1, null), body: layer(2, [40, 34, 95, 53]), sheet: layer(3, [8, 10, 40, 28]), flap: layer(4, [44, 24, 52, 38]),
    bytes: fieldBytes(),
  };
}

function setup(css: [number, number], resolution: number) {
  const pw = Math.round(css[0] * resolution);
  const ph = Math.round(css[1] * resolution);
  const rhi = new NullRhiDevice({ swapchainSize: [pw, ph] });
  const trace = traceRhi(rhi);
  const canvas = { width: pw, height: ph, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: css[0], height: css[1], resolution, background: 0x000000 });
  return { renderer, trace };
}

/** 确定性表演：不抖动、跳过第一口深叹（与出片同一个起点），推 steps × dt，gaspAt = 第几步猛抽一口气 */
function perfInput(steps: number, dt: number, gaspAt = -1): BreathingUniformInput {
  const p = new BreathingPerformance({ ti: 2.7, te: 3.75, lag: 0.3, inflate: 10, sink: 4, vent: 10, cran: 4 }, RIG.limits);
  p.setNoJitter(true);
  p.skipFirstSigh();
  for (let k = 0; k < steps; k++) {
    if (k === gaspAt) void p.gasp();
    p.step(dt);
  }
  return { frame: p.frame(), vent: p.p('vent'), cran: p.p('cran'), inflate: p.p('inflate'), sink: p.p('sink') };
}

function assetOf(t: Textures): BreathingAssetInput {
  return { size: SIZE, rig: RIG, fields: { width: FW, height: FH }, fieldBytes: t.bytes, base: t.base, body: t.body, sheet: t.sheet, flap: t.flap };
}

interface Case {
  css: [number, number];
  resolution: number;
  /** null = 按住看原图（每帧 uniform 全 0） */
  input: BreathingUniformInput | null;
}

/** 工作台：BreathingStage（页面交给它的就是这些） */
function drawWorkbench(c: Case, prelayout?: [number, number]): string[] {
  const { renderer, trace } = setup(c.css, c.resolution);
  const stage = new BreathingStage();
  stage.setAsset(assetOf(textures()));
  if (prelayout) stage.layout(prelayout[0], prelayout[1]);
  stage.layout(c.css[0], c.css[1]);
  if (c.input) stage.applyFrame(c.input);
  else stage.apply(REST_UNIFORMS);
  renderer.render(stage.root);
  return trace.lines;
}

/** 游戏：BreathingOverlaySystem.show 的 prepare → CutsceneRenderer.showBreathingLayer(50, 50, 100) → update 的 apply */
function drawLikeTheGame(c: Case, layersPremultiplied = true): string[] {
  const { renderer, trace } = setup(c.css, c.resolution);
  const t = textures();
  const fields = createBreathingFieldTextures(t.bytes, FW, FH);
  const r = percentLayerRect(c.css[0], c.css[1], SIZE[0], SIZE[1], 50, 50, 100);
  const m = createBreathingOverlayMesh({ base: t.base, body: t.body, sheet: t.sheet, flap: t.flap, ...fields }, RIG, SIZE, r.cx, r.cy, r.dispW, r.dispH,
    layersPremultiplied);
  m.apply(c.input ? breathingUniforms(c.input, RIG) : { uInfl: 0, uFlapAng: 0, uShade: 0, uVentPx: 0, uCranPx: 0 });
  const canvasStage = new Container();
  canvasStage.addChild(m.mesh);
  renderer.render(canvasStage);
  return trace.lines;
}

const INHALE: Case = { css: [320, 180], resolution: 1, input: perfInput(30, 1 / 30) };
const EXHALE_HIDPI: Case = { css: [333.5, 187.625], resolution: 1.5, input: perfInput(95, 1 / 30) };
const GASP: Case = { css: [640, 360], resolution: 1.25, input: perfInput(40, 1 / 30, 8) };
const REST: Case = { css: [480, 270], resolution: 1, input: null };

describe('呼吸工作台画面 == 游戏画面（空后端，逐条 GPU 命令与字节）', () => {
  it('吸气中：一张呼吸图 Mesh（breathingShade.wgsl）、层贴图预乘口径、percentLayerRect 摆放', () => {
    const wb = drawWorkbench(INHALE);
    // 呼吸图 1 次 + 引擎把画布中间纹理翻转上屏 1 次
    expect(wb.filter((l) => l.startsWith('  draw')).length).toBe(2);
    expect(wb).toEqual(drawLikeTheGame(INHALE));
  });

  it('呼气 + 非整数 CSS 尺寸 + 分辨率 1.5；猛抽一口气 + 分辨率 1.25；按住看原图（每帧 uniform 全 0）', () => {
    for (const c of [EXHALE_HIDPI, GASP, REST]) expect(drawWorkbench(c)).toEqual(drawLikeTheGame(c));
  });

  it('屏尺寸变了：按新尺寸重建的 mesh 与游戏在新屏上重新 show 一次相同（位移场与层贴图不动）', () => {
    expect(drawWorkbench(INHALE, [800, 450])).toEqual(drawLikeTheGame(INHALE));
  });

  it('出片（离屏渲染纹理，成品尺寸、分辨率 1）== 引擎自己的离屏画法（generateTexture）', () => {
    const input = perfInput(50, 1 / 15);
    const a = setup([200, 120], 1);
    const stage = new BreathingStage();
    stage.setAsset(assetOf(textures()));
    stage.layout(200, 120);
    const tgt = createOffscreenTarget(a.renderer, SIZE[0], SIZE[1]);
    a.trace.clear();
    stage.layout(SIZE[0], SIZE[1]);
    stage.applyFrame(input);
    tgt.render(stage.root);
    const wb = a.trace.lines.slice();

    const b = setup([200, 120], 1);
    const t = textures();
    const fields = createBreathingFieldTextures(t.bytes, FW, FH);
    const r = percentLayerRect(SIZE[0], SIZE[1], SIZE[0], SIZE[1], 50, 50, 100);
    const m = createBreathingOverlayMesh({ base: t.base, body: t.body, sheet: t.sheet, flap: t.flap, ...fields }, RIG, SIZE, r.cx, r.cy, r.dispW, r.dispH);
    m.apply(breathingUniforms(input, RIG));
    const root = new Container();
    root.addChild(m.mesh);
    b.trace.clear();
    b.renderer.generateTexture(root);
    // 渲染纹理建在 generateTexture 里：两边的纹理上传次序不同（工作台先建目标再画），比较 pass 之后的命令
    const fromPass = (lines: string[]) => lines.slice(lines.findIndex((l) => l.startsWith('pass')));
    expect(fromPass(wb).length).toBeGreaterThan(3);
    expect(fromPass(wb)).toEqual(fromPass(b.trace.lines));
    expect(wb.some((l) => l.startsWith('pass') && l.includes(`${SIZE[0]}x${SIZE[1]}`))).toBe(true);
  });

  it('记录器够灵敏：纸差 0.01 mm、层贴图不按预乘口径、屏差半个像素，串都不同', () => {
    const base = drawWorkbench(INHALE);
    const input = INHALE.input!;
    const nudged = { ...input, frame: { ...input.frame, paperMm: input.frame.paperMm + 0.01 } };
    expect(drawWorkbench({ ...INHALE, input: nudged })).not.toEqual(base);
    expect(drawLikeTheGame(INHALE, false)).not.toEqual(base);
    expect(drawWorkbench({ ...INHALE, css: [320.5, 180] })).not.toEqual(base);
  });

  it('换图 / 收掉：旧 mesh 与位移场先拆；没有图就什么都不画', () => {
    const stage = new BreathingStage();
    expect(stage.ready).toBe(false);
    stage.layout(320, 180);
    stage.setAsset(assetOf(textures()));
    expect(stage.ready).toBe(true);
    expect(stage.root.children.length).toBe(1);
    const first = stage.root.children[0];
    stage.setAsset(assetOf(textures()));
    expect(stage.root.children.length).toBe(1);
    expect(stage.root.children[0]).not.toBe(first);
    expect(first.destroyed).toBe(true);
    stage.setAsset(null);
    expect(stage.ready).toBe(false);
    expect(stage.root.children.length).toBe(0);
    stage.destroy();
  });
});
