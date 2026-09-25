/**
 * 草木摆动(位移图 + 不打光合成面)/ 呼吸图 / 过场叠图淡入 —— WGSL 移植的像素对照。
 *
 * 全部走真实运行时类:`SwayBackground`(网格、振子、位移图渲染)、`createBreathingOverlayMesh` +
 * `createBreathingFieldTextures` + `BreathingPerformance` + `breathingUniforms`(表演模拟 → uniform)、
 * `createOverlayBlendMesh`。输入是带种子的合成数据,两侧逐字节相同。
 *
 * 容差:位移图是 rgba16float,按浮点比(值域 ±0.1 量级的 uv 差 + 0..1 的覆盖度);8 位目标按 0..1 归一。
 * 实测(SwiftShader):呼吸图 / 淡入两侧逐位相同;位移图最多差半浮点 1 ulp(覆盖度在零星几个像素上落在舍入边界,
 * 两侧插值差 f32 末位所致,不是翻译差异),经合成面放大后最多 1/255。容差按这个底噪给,别往上调。
 */
import { Container, RenderTexture, type Texture } from 'pixi.js';
import type { ParityCase, ParityEnv, ParityTarget } from '../harness';
import { SwayBackground, type BackgroundSwayInput, type SwayInstanceDef } from '@src/rendering/backgroundSway';
import { createBreathingFieldTextures, createBreathingOverlayMesh } from '@src/rendering/breathingOverlayMesh';
import { breathingUniforms } from '@src/rendering/breathingUniforms';
import { createOverlayBlendMesh } from '@src/rendering/overlayBlendShader';
import { BreathingPerformance } from '@src/systems/breathing/BreathingPerformance';
import type { BreathingOverlayRig } from '@src/data/breathingOverlays';
import type { SceneWindDef } from '@src/data/types';
import { resolveSceneWind } from '@src/utils/sceneWind';

const P = '摆动呼吸淡入 / ';

// ───────────────────────────── 小工具

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** float → IEEE 半精度位(与对照框架的上传链路同一算法:就近舍入) */
function toHalf(v: number): number {
  const f32 = new Float32Array([v]);
  const u32 = new Uint32Array(f32.buffer)[0];
  const sign = (u32 >>> 16) & 0x8000;
  let exp = ((u32 >>> 23) & 0xff) - 127 + 15;
  let mant = u32 & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >>> (1 - exp);
    return sign | ((mant + 0x1000) >>> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | ((mant + 0x1000) >>> 13);
}

/**
 * 结果不许是"两边都什么也没画"。至少 `minCount` 个像素在通道 `ch` 上超过 `eps`,否则抛错(用例记为出错而不是假通过)。
 */
function assertDrawn(data: Float32Array, ch: number, minCount: number, what: string, eps = 1e-3): void {
  let n = 0;
  for (let i = ch; i < data.length; i += 4) if (Math.abs(data[i]) > eps) n++;
  if (n < minCount) throw new Error(`${what}:只有 ${n} 个像素有内容(至少要 ${minCount}),用例没画出东西`);
}

/** 只走 produce() 的用例:build 是接口必填项,框架给了 produce 就不会调它 */
function produceOnly(): never {
  throw new Error('本用例只走 produce()');
}

async function renderTo(env: ParityEnv, root: Container, w: number, h: number, target: ParityTarget): Promise<Float32Array> {
  const rt = RenderTexture.create({ width: w, height: h, format: target, resolution: 1, antialias: false });
  try {
    env.renderer.render({ container: root, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
    return await env.readTexture(rt, target);
  } finally {
    rt.destroy(true);
  }
}

// ───────────────────────────── 草木摆动:合成拆层

/** 原画像素尺寸与场景尺寸不同(1.5 wu / 像素):位移图按原画尺寸开、顶点在场景坐标,缩放走 uUvMapSize / uSceneSize */
const SW = { nw: 160, nh: 112, W: 240, H: 168 };

/**
 * 三株:一棵树(id 300,测 id 高字节;整株刚转 + 两个锚点 ⇒ 细分格 / 扇形格)、一片草(id 7,逐顶点振子)、
 * 一丛"整体摆"的场(id 513,中间一根刚体竿 ⇒ 刚体交界细分)。
 */
const SWAY_INSTANCES: SwayInstanceDef[] = [
  { id: 300, kind: 'plant', root: [70, 152], height: 220, persp: 1, reach: 130, bbox: [28, 20, 112, 152], anchors: [[70, 152], [70, 96]] },
  { id: 7, kind: 'field', root: [178, 163], height: 70, persp: 0.9, reach: 60, bbox: [130, 100, 228, 164] },
  { id: 513, kind: 'field', root: [192, 78], height: 90, persp: 0.8, reach: 60, bbox: [156, 24, 228, 80], coherent: true },
];

interface SwayPixel { id: number; alpha: number; leaf: number; free: number; rigid: number }

/** 场景点上的拆层真值(alpha 带软边,叶度 / 自由度 / 刚体度按部位给) */
function swayPixel(sx: number, sy: number): SwayPixel {
  // 树:树干(刚体、不颤)+ 树冠(叶)
  if (Math.abs(sx - 70) < 4 && sy > 88 && sy < 152) return { id: 300, alpha: 1, leaf: 0, free: 1, rigid: 1 };
  const ec = Math.hypot((sx - 70) / 40, (sy - 58) / 36);
  if (ec < 1) return { id: 300, alpha: smooth(1, 0.82, ec), leaf: 1, free: 1, rigid: 0 };
  // 草:波浪形上沿、下沿钉住(自由度随离根高度长)
  if (sx > 132 && sx < 226 && sy < 163) {
    const top = 112 + 7 * Math.sin(sx * 0.35) + 4 * Math.sin(sx * 0.11);
    const a = smooth(top - 1, top + 3, sy);
    if (a > 0) return { id: 7, alpha: a, leaf: 0.8, free: clamp01((163 - sy) / 45), rigid: 0 };
  }
  // 整体摆的一丛,中间一根竿
  const eb = Math.hypot((sx - 192) / 34, (sy - 52) / 26);
  if (eb < 1) {
    const stick = Math.abs(sx - 190) < 2.5 && sy > 40;
    return { id: 513, alpha: smooth(1, 0.75, eb), leaf: stick ? 0 : 0.6, free: clamp01((78 - sy) / 40), rigid: stick ? 1 : 0 };
  }
  return { id: 0, alpha: 0, leaf: 0, free: 0, rigid: 0 };
}

interface SwayScene { inp: BackgroundSwayInput; painting: Texture }

function buildSwayScene(env: ParityEnv, seed: number): SwayScene {
  const { nw, nh, W, H } = SW;
  const px = (x: number, y: number) => swayPixel(((x + 0.5) / nw) * W, ((y + 0.5) / nh) * H);
  const cache: SwayPixel[] = [];
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) cache.push(px(x, y));
  const at = (x: number, y: number) => cache[y * nw + x];
  // 叶度带一点逐像素噪声(真原画的叶簇不是一整块)
  const leafNoise = env.rng(seed + 11);
  const leafMul = Float32Array.from({ length: nw * nh }, () => 0.65 + 0.35 * leafNoise());
  const matteTex = env.dataTexture({
    width: nw, height: nh, seed, scaleMode: 'linear',
    fill: (x, y, c) => {
      const p = at(x, y);
      return c === 0 ? p.alpha : c === 1 ? p.leaf * leafMul[y * nw + x] : c === 2 ? p.free : 1;
    },
  });
  const idsTex = env.dataTexture({
    width: nw, height: nh, seed, scaleMode: 'nearest',
    fill: (x, y, c) => {
      const p = at(x, y);
      const id = p.alpha > 0.02 ? p.id : 0;
      return c === 0 ? (id & 255) / 255 : c === 1 ? (id >> 8) / 255 : c === 2 ? 0 : 1;
    },
  });
  const plateTex = env.dataTexture({
    width: nw, height: nh, seed: seed + 1, scaleMode: 'linear',
    fill: (x, y, c, rng) => (c === 3 ? 1 : c === 0 ? 0.25 + 0.2 * (y / nh) + 0.1 * rng() : c === 1 ? 0.3 + 0.1 * rng() : 0.2 + 0.3 * (x / nw)),
  });
  const painting = env.dataTexture({
    width: nw, height: nh, seed: seed + 2, scaleMode: 'linear',
    fill: (x, y, c, rng) => {
      if (c === 3) return 1;
      const p = at(x, y);
      if (p.id === 300) return c === 1 ? 0.45 + 0.4 * rng() : 0.1 + 0.2 * rng();
      if (p.id) return c === 1 ? 0.6 + 0.3 * rng() : c === 0 ? 0.4 + 0.2 * rng() : 0.1;
      return 0.2 + 0.6 * rng();
    },
  });
  // CPU 副本:与运行时 readCpu 同口径(半分辨率 RGBA;id 最近邻取、matte 平滑取)
  const hw = nw / 2, hh = nh / 2;
  const ids = new Uint8ClampedArray(hw * hh * 4);
  const matte = new Uint8ClampedArray(hw * hh * 4);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      const o = (y * hw + x) * 4;
      const p = at(x * 2, y * 2);
      const id = p.alpha > 0.02 ? p.id : 0;
      ids[o] = id & 255; ids[o + 1] = id >> 8; ids[o + 3] = 255;
      let a = 0, l = 0, f = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const q = at(x * 2 + dx, y * 2 + dy);
        a += q.alpha; l += q.leaf; f += q.free;
      }
      matte[o] = Math.round(a * 63.75); matte[o + 1] = Math.round(l * 63.75); matte[o + 2] = Math.round(f * 63.75); matte[o + 3] = 255;
    }
  }
  const rigid = new Uint8Array(nw * nh);
  for (let i = 0; i < rigid.length; i++) rigid[i] = Math.round(cache[i].rigid * 255);
  const inp: BackgroundSwayInput = {
    urls: [],
    plateTex, matteTex, idsTex,
    meta: { version: 3, margin: 10, instances: SWAY_INSTANCES },
    sceneSize: [W, H],
    paintSize: [nw, nh],
    // 跑马梁那种相机:世界 +X 往屏幕右,+Y / +Z 往屏幕上
    jx: [1, 0], jy: [0, -0.707], jz: [0, -0.707],
    sceneToWorldXZ: null, scaleAt: null,
    ids: { data: ids, w: hw, h: hh },
    matte: { data: matte, w: hw, h: hh },
    rigid: { data: rigid, w: nw, h: nh },
    litPlate: null,
  };
  return { inp, painting };
}

interface SwayRun {
  wind: SceneWindDef | null;
  /** 从 t0 到 t1 按 60 fps 逐帧推进(振子有惯性,要真的一帧帧走) */
  t0: number;
  t1: number;
}

const WIND_MILD: SceneWindDef = {
  direction: [-1, 0, -0.25], speed: 400, gust: { amount: 0.8, period: 7 }, veer: 14,
  turbulence: { intensity: 0.35, scale: 140 }, roughness: 1, leaf: { size: 22, speed: 3.2 },
};
const WIND_STRONG: SceneWindDef = {
  direction: [0.6, 0, 0.8], speed: 900, gust: { amount: 1.2, period: 4 }, veer: 25,
  turbulence: { intensity: 0.6, scale: 90 }, roughness: 0.6, gain: { sway: 2.5 }, waveSize: 60, leaf: { size: 12, speed: 5.5 },
};

function driveSway(sway: SwayBackground, run: SwayRun): void {
  const w = run.wind ? resolveSceneWind(run.wind) : null;
  const n = Math.round((run.t1 - run.t0) * 60);
  for (let i = 0; i <= n; i++) sway.update(w, run.t0 + i / 60);
}

function swayUvCase(name: string, seed: number, run: SwayRun, tolerance: number): ParityCase {
  return {
    name: `${P}草木位移图 · ${name}`,
    width: SW.nw,
    height: SW.nh,
    target: 'rgba16float',
    tolerance,
    build: produceOnly,
    async produce(env) {
      const { inp, painting } = buildSwayScene(env, seed);
      const sway = new SwayBackground(painting, inp, { composite: false });
      try {
        driveSway(sway, run);
        sway.renderUv(env.renderer);
        const out = await env.readTexture(sway.uvMap, 'rgba16float');
        assertDrawn(out, 3, 400, '位移图覆盖度');
        return out;
      } finally {
        sway.destroy();
      }
    },
  };
}

function swayCompositeCase(name: string, seed: number, run: SwayRun, tolerance: number): ParityCase {
  return {
    name: `${P}草木合成面(不打光)· ${name}`,
    width: SW.W,
    height: SW.H,
    tolerance,
    build: produceOnly,
    async produce(env) {
      const { inp, painting } = buildSwayScene(env, seed);
      const sway = new SwayBackground(painting, inp, { composite: true });
      try {
        driveSway(sway, run);
        sway.renderUv(env.renderer);
        const out = await renderTo(env, sway.root, SW.W, SW.H, 'rgba8unorm');
        assertDrawn(out, 3, SW.W * SW.H - 1, '合成面(应整张不透明)', 0.5);
        return out;
      } finally {
        sway.destroy();
      }
    },
  };
}

// ───────────────────────────── 呼吸图:合成拆层 + 位移场

const BR = { w: 192, h: 128, fw: 96, fh: 64 };
const BR_RIG: BreathingOverlayRig = {
  pxPerMm: 1,
  root: [120, 60],
  rootDisp: [0.05, -0.6],
  flapLengthPx: 40,
  flapNormal: [0.94, -0.35],
  lampDir: [0.985, 0.17],
  shade: 0.12,
  limits: { sheetMm: 15, ventMm: 24, cranMm: 12 },
};
const BR_PARAMS = { ti: 2.7, te: 3.75, tp: 1.05, vent: 10, cran: 4, inflate: 3.5, sink: 4, swing: 4, back: 4.8, upLimit: 14, sinkLimit: 5, lag: 1.5 };

interface BreathingLayers { base: Texture; body: Texture | null; sheet: Texture | null; flap: Texture | null }

/**
 * 几层:底图不透明;胸口 / 纸 / 垂帘各一块软边 alpha 区域。`premul` = rgb 已 ×alpha(游戏装载的样子,uPremul = 1)。
 */
function breathingLayers(env: ParityEnv, seed: number, premul: boolean, all: boolean): BreathingLayers {
  const layer = (s: number, alphaAt: (x: number, y: number) => number, rgb: (c: number, rng: () => number) => number): Texture =>
    env.dataTexture({
      width: BR.w, height: BR.h, seed: s, scaleMode: 'linear',
      fill: (x, y, c, rng) => {
        const a = alphaAt(x + 0.5, y + 0.5);
        if (c === 3) return a;
        return clamp01(rgb(c, rng)) * (premul ? a : 1);
      },
    });
  const base = env.dataTexture({
    width: BR.w, height: BR.h, seed, scaleMode: 'linear',
    fill: (x, y, c, rng) => (c === 3 ? 1 : c === 0 ? 0.35 + 0.3 * (x / BR.w) + 0.1 * rng() : c === 1 ? 0.3 + 0.25 * (y / BR.h) + 0.1 * rng() : 0.4 + 0.1 * rng()),
  });
  const body = layer(seed + 1, (x, y) => smooth(1, 0.8, Math.hypot((x - 60) / 55, (y - 100) / 30)),
    (c, rng) => (c === 0 ? 0.55 : c === 1 ? 0.2 + 0.2 * rng() : 0.15));
  const sheet = layer(seed + 2, (x, y) => 0.92 * smooth(1, 0.85, Math.hypot((x - 105) / 48, (y - 48) / 30)),
    (_c, rng) => 0.88 + 0.1 * rng());
  const flap = layer(seed + 3, (x, y) => smooth(112, 115, x) * smooth(138, 135, x) * smooth(58, 62, y) * smooth(104, 100, y),
    (c, rng) => (c === 2 ? 0.72 : 0.83) + 0.05 * rng());
  return { base, body: all ? body : null, sheet, flap: all ? flap : null };
}

/**
 * 两张位移场(RGBA16F 背靠背,与 .bin 同格式),交给真的 `createBreathingFieldTextures`。
 * 坡度 × 位移压在 0.6 以下(反查不动点迭代要收敛):纸面权重铺 ~50 px、胸口权重铺 ~60 px。
 */
function breathingFieldBytes(): ArrayBuffer {
  const { fw, fh } = BR;
  const per = fw * fh * 4;
  const u16 = new Uint16Array(per * 2);
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const px = ((x + 0.5) / fw) * BR.w, py = ((y + 0.5) / fh) * BR.h;
      const o = (y * fw + x) * 4;
      // ① 纸面:单位方向 × 权重,贴脸那边(左侧)权重 0
      const w1 = (1 - smooth(0, 1, Math.hypot((px - 112) / 50, (py - 40) / 34))) * smooth(78, 100, px);
      const ang = 0.3 * Math.sin(px * 0.02) - 0.34;
      const dx = Math.sin(ang), dy = -Math.cos(ang);
      u16[o] = toHalf(dx * w1); u16[o + 1] = toHalf(dy * w1); u16[o + 2] = toHalf(w1); u16[o + 3] = toHalf(1);
      // ② 胸口:朝上权重 / 朝头权重
      const up = 1 - smooth(0, 1, Math.hypot((px - 60) / 80, (py - 100) / 60));
      const head = 0.6 * up * smooth(20, 90, px);
      u16[per + o] = toHalf(up); u16[per + o + 1] = toHalf(head); u16[per + o + 2] = toHalf(0); u16[per + o + 3] = toHalf(1);
    }
  }
  return u16.buffer;
}

interface BreathingRun {
  /** 先正常呼吸这么久(秒,60 fps) */
  sec: number;
  /** 然后:猛吸一口再走 `after` 秒 / 改参数(带渐变)再走 `after` 秒 */
  then?: { gasp?: boolean; params?: Record<string, number>; ramp?: number; after: number };
}

function driveBreathing(run: BreathingRun): Record<string, number> {
  const perf = new BreathingPerformance(BR_PARAMS, BR_RIG.limits, 7);
  const steps = (s: number) => { for (let i = 0; i < Math.round(s * 60); i++) perf.step(1 / 60); };
  steps(run.sec);
  if (run.then) {
    if (run.then.gasp) void perf.gasp();
    if (run.then.params) perf.setParams(run.then.params, run.then.ramp ?? 0);
    steps(run.then.after);
  }
  // 与 BreathingOverlaySystem.uniformsOf 同一条换算
  return breathingUniforms({ frame: perf.frame(), vent: perf.p('vent'), cran: perf.p('cran'), inflate: perf.p('inflate'), sink: perf.p('sink') }, BR_RIG);
}

interface BreathingOpts {
  run: BreathingRun;
  premul?: boolean;
  allLayers?: boolean;
  /** 画到多大的目标上(缺省 = 原图 1:1) */
  out?: [number, number];
  /** 手动覆盖几个 uniform(把某个分支推到头) */
  override?: Record<string, number>;
}

function breathingCase(name: string, seed: number, o: BreathingOpts, tolerance: number, maxBadPixels = 0): ParityCase {
  const [ow, oh] = o.out ?? [BR.w, BR.h];
  return {
    name: `${P}呼吸图 · ${name}`,
    width: ow,
    height: oh,
    tolerance,
    maxBadPixels,
    build: produceOnly,
    async produce(env) {
      const premul = o.premul ?? true;
      const L = breathingLayers(env, seed, premul, o.allLayers ?? true);
      const fields = createBreathingFieldTextures(breathingFieldBytes(), BR.fw, BR.fh);
      const m = createBreathingOverlayMesh({ ...L, ...fields }, BR_RIG, [BR.w, BR.h], ow / 2, oh / 2, ow, oh, premul);
      const root = new Container();
      root.addChild(m.mesh);
      try {
        m.apply({ ...driveBreathing(o.run), ...o.override });
        const out = await renderTo(env, root, ow, oh, 'rgba8unorm');
        assertDrawn(out, 3, ow * oh - 1, '呼吸图(应整张不透明)', 0.5);
        return out;
      } finally {
        root.destroy({ children: true });
        m.disposeGpu();
        fields.field1.destroy(true);
        fields.field2.destroy(true);
      }
    },
  };
}

// ───────────────────────────── 过场叠图淡入

function crossfadeCase(name: string, t: number, opts: { display?: [number, number]; offset?: [number, number]; scale?: number } = {}): ParityCase {
  const tw = 48, th = 32;
  const [dw, dh] = opts.display ?? [tw, th];
  const W = 80, H = 56;
  return {
    name: `${P}叠图淡入 · ${name}`,
    width: W,
    height: H,
    tolerance: 1 / 255,
    build(env) {
      // 两张都带 alpha;左上角一块特征,上下 / 左右翻了都抓得到
      const from = env.dataTexture({
        width: tw, height: th, seed: 101, scaleMode: 'linear',
        fill: (x, y, c, rng) => (x < 4 && y < 3 ? (c === 0 || c === 3 ? 1 : 0) : c === 3 ? 0.4 + 0.6 * rng() : rng()),
      });
      const to = env.dataTexture({
        width: tw, height: th, seed: 202, scaleMode: 'linear',
        fill: (x, y, c, rng) => (c === 3 ? 0.3 + 0.7 * (x / tw) : c === 2 ? y / th : rng()),
      });
      const h = createOverlayBlendMesh(from, to, dw / 2, dh / 2, dw, dh);
      h.setT(t);
      const holder = new Container();
      const [ox, oy] = opts.offset ?? [0, 0];
      holder.position.set(ox, oy);
      holder.scale.set(opts.scale ?? 1);
      holder.addChild(h.mesh);
      const root = new Container();
      root.addChild(holder);
      return root;
    },
  };
}

// ───────────────────────────── 用例

export const cases: ParityCase[] = [
  // 位移图:RG = (源 uv − 本像素 uv) × 覆盖度,B = A = 覆盖度(预乘混合叠)
  swayUvCase('静风(网格不动,只有覆盖度)', 3, { wind: null, t0: 0, t1: 0.5 }, 1e-3),
  swayUvCase('和风 · 左吹 · 3.2 s', 3, { wind: WIND_MILD, t0: 0, t1: 3.2 }, 1e-3),
  swayUvCase('强风 · 斜吹 · 增益 2.5 · 叶颤快 · 40~47.5 s', 5, { wind: WIND_STRONG, t0: 40, t1: 47.5 }, 1e-3),
  // 不打光的合成面:读位移图回原画取色,露出处是底板
  swayCompositeCase('静风', 3, { wind: null, t0: 0, t1: 0.5 }, 1 / 255),
  swayCompositeCase('和风 · 3.2 s', 3, { wind: WIND_MILD, t0: 0, t1: 3.2 }, 1 / 255),
  swayCompositeCase('强风 · 47.5 s', 5, { wind: WIND_STRONG, t0: 40, t1: 47.5 }, 1 / 255),

  // 呼吸图:不同表演相位(胸口 / 纸 / 垂帘各自的位移都走真表演模拟)
  breathingCase('开场静止(第一口之前)', 21, { run: { sec: 0 } }, 1 / 255),
  breathingCase('深叹·吸 2.5 s(纸被吸贴、垂帘内收)', 21, { run: { sec: 2.5 } }, 1 / 255),
  breathingCase('深叹·呼 5.5 s(纸飞起、垂帘外翻)', 21, { run: { sec: 5.5 } }, 1 / 255),
  breathingCase('猛吸 0.2 s(胸口 ~1.85)', 21, { run: { sec: 11, then: { gasp: true, after: 0.2 } } }, 1 / 255),
  breathingCase('猛吸后回弹 1.2 s', 21, { run: { sec: 11, then: { gasp: true, after: 1.2 } } }, 1 / 255),
  breathingCase('改参数渐变中(胸口 / 纸更大)', 22, { run: { sec: 9, then: { params: { vent: 18, cran: 7, inflate: 6, swing: 9 }, ramp: 0.8, after: 1.9 } } }, 1 / 255),
  breathingCase('层未预乘(工作台口径)+ 缺胸口 / 垂帘(空纹理)', 23, { run: { sec: 5.5 }, premul: false, allLayers: false }, 1 / 255),
  breathingCase('垂帘外翻推到头 + 纸满幅', 24, { run: { sec: 5.5 }, override: { uFlapAng: 0.9, uInfl: 14, uShade: 0.17 } }, 1 / 255),
  breathingCase('缩小显示(160×107,线性过滤)', 21, { run: { sec: 5.5 }, out: [160, 107] }, 1 / 255),
  breathingCase('放大显示(240×160)', 21, { run: { sec: 2.5 }, out: [240, 160] }, 1 / 255),

  // 叠图淡入:t 两端与中间,1:1 / 放大 / 容器变换
  crossfadeCase('t = 0(只见 from)', 0),
  crossfadeCase('t = 0.3', 0.3),
  crossfadeCase('t = 0.71 · 放大 72×48 · 平移', 0.71, { display: [72, 48], offset: [3, 4] }),
  crossfadeCase('t = 1(只见 to)', 1),
  crossfadeCase('t = 0.5 · 容器缩放 1.4', 0.5, { offset: [2, 1], scale: 1.4 }),
];
