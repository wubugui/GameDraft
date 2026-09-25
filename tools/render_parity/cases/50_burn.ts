/**
 * 燃烧着色(`src/rendering/burn/`)的像素对照:两道燃烧滤镜(`BurnMaterialFilter` / `BurnGlowFilter`)与
 * 图像空间的燃烧渲染(`BurnRenderer` 纹理宿主:颜色图 + 自发光图两个 mesh 程序画进 RT)。
 *
 * 输入全走运行时真类:燃烧场用 `BurnFieldTexture`(RGBA8、NEAREST,字节写进 `data` 后 `upload()` = `source.update()`),
 * 种子固定的合成燃烧场(RG = 点着时刻 16 位定点、B = 燃料、A = 熄灭定格;含没燃料的洞、不会点着的格、熄灭定格的格),
 * 精灵 / 模板图是预乘的带 alpha 数据纹理(有全透明区,走「覆盖度太小直接返回」那条)。
 * 燃烧进度五档:未烧 / 刚点着 / 蔓延中 / 焦黑余烬 / 烧完成灰;另有硬边(烤黄 0、成灰过渡 0、毛边 0)与逐帧推进。
 */
import { Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { ParityCase, ParityEnv } from '../harness';
import { BurnFieldTexture, BurnGlowFilter, BurnMaterialFilter } from '@src/rendering/burn/BurnFilters';
import { BurnRenderer, type BurnTextureHost } from '@src/rendering/burn/BurnRenderer';
import type { BurnShadeParams } from '@src/rendering/burn/burnShadeParams';

const GRID_W = 13;
const GRID_H = 9;
const TIME_STEP = 1 / 16;
const TOL = 2 / 255;

// ───────────────────────────── 输入

/** 合成燃烧场:火从 (2.5, 3) 附近一格点起、按距离往外排点着时刻;`variant` 换一种排法(逐帧上传用例) */
function encodeField(data: Uint8Array, env: ParityEnv, seed: number, variant: 0 | 1 = 0): void {
  const rng = env.rng(seed);
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const i = (y * GRID_W + x) * 4;
      const ox = variant === 0 ? 2.5 : 10;
      const oy = variant === 0 ? 3 : 6;
      const t = 1 + 0.75 * Math.hypot(x - ox, y - oy) + rng() * 0.4;
      const r = rng();
      let fuel = 0.35 + 0.65 * rng();
      if (r < 0.08) fuel = 0; // 洞:没燃料,权重 0
      else if (r < 0.1) fuel = 0.015; // 燃料低于 0.02 的门槛,也算没有
      const never = r >= 0.1 && r < 0.16;
      const extinguished = r > 0.9;
      const q = never ? 65535 : Math.min(65534, Math.round(t / TIME_STEP));
      data[i] = q >> 8;
      data[i + 1] = q & 255;
      data[i + 2] = Math.round(fuel * 255);
      data[i + 3] = extinguished ? 255 : 0;
    }
  }
}

function newField(env: ParityEnv, seed: number): BurnFieldTexture {
  const field = new BurnFieldTexture(GRID_W, GRID_H);
  encodeField(field.data, env, seed);
  field.upload();
  return field;
}

/** 预乘的带 alpha 图:椭圆软边 + 一块全透明的洞 + 半透明带;颜色是渐变加噪声 */
function colorTexture(env: ParityEnv, width: number, height: number, seed: number): Texture {
  const alphaAt = (x: number, y: number): number => {
    const u = (x + 0.5) / width - 0.5;
    const v = (y + 0.5) / height - 0.5;
    const d = Math.hypot(u / 0.48, v / 0.46);
    let a = Math.max(0, Math.min(1, (1 - d) * 6));
    if (Math.hypot(u - 0.12, v + 0.08) < 0.1) a = 0; // 洞
    if (y % 7 === 3) a *= 0.45; // 半透明带
    return a;
  };
  return env.dataTexture({
    width, height, seed,
    alphaMode: 'premultiplied-alpha',
    scaleMode: 'linear',
    fill: (x, y, c, rng) => {
      const a = alphaAt(x, y);
      if (c === 3) return a;
      const base = c === 0 ? 0.35 + 0.6 * x / width : c === 1 ? 0.3 + 0.5 * y / height : 0.25;
      return Math.min(1, base + 0.15 * rng()) * a;
    },
  });
}

function shade(now: number, over: Partial<BurnShadeParams> = {}): BurnShadeParams {
  return {
    gridW: GRID_W,
    gridH: GRID_H,
    now,
    timeStep: TIME_STEP,
    flameSeconds: 3,
    emberSeconds: 4,
    scorchSeconds: 1.5,
    ashFadeSeconds: 2,
    edgeNoise: 0.6,
    scorchColor: [0.86, 0.64, 0.38],
    charColor: [0.09, 0.07, 0.06],
    ashColor: [0.56, 0.54, 0.5],
    ashAlpha: 0.3,
    glow: [2.4, 1.0, 0.3],
    emberGlow: [1.2, 0.3, 0.06],
    ...over,
  };
}

const HARD_EDGE: Partial<BurnShadeParams> = { scorchSeconds: 0, ashFadeSeconds: 0, edgeNoise: 0 };

const STATES: Array<{ label: string; now: number }> = [
  { label: '未烧', now: -5 },
  { label: '刚点着', now: 1.8 },
  { label: '蔓延中', now: 5 },
  { label: '焦黑余烬', now: 10.5 },
  { label: '烧完成灰', now: 30 },
];

// ───────────────────────────── 滤镜宿主(热点展示图)

const SPRITE_W = 40;
const SPRITE_H = 30;
const SPRITE_X = 6;
const SPRITE_Y = 5;
/** 相机:世界容器在屏幕上的位置 + 投影缩放(不取 0 / 1,两个 uniform 都真参与) */
const CAM = { x: 2, y: -3, scale: 1.25 };

/**
 * 场景 → 图 uv 仿射:镜像 X + 一点斜切,且故意比精灵大一圈(边上一圈 uv 出 [0,1],走「出界不烧」那条)。
 * 片元场景坐标 w = (屏幕 − 相机位置) / 缩放。
 */
function uvAffine(): number[] {
  const sx0 = (SPRITE_X - CAM.x) / CAM.scale;
  const sy0 = (SPRITE_Y - CAM.y) / CAM.scale;
  const sw = SPRITE_W / CAM.scale;
  const sh = SPRITE_H / CAM.scale;
  const a = -1.1 / sw;
  const b = 0.004;
  const d = 1.1 / sh;
  return [a, b, 0, d, 1.05 - a * sx0 - b * sy0, -0.05 - d * sy0];
}

type FilterChain = 'material' | 'glow' | 'material+glow';

/** 逐帧用例在 beforeFrame 里要改燃烧场与着色参数:按 build 出来的根节点记下它们 */
const liveFilters = new WeakMap<Container, { field: BurnFieldTexture; filters: Array<BurnMaterialFilter | BurnGlowFilter> }>();

function filterCase(name: string, chain: FilterChain, params: BurnShadeParams, seed: number): ParityCase {
  return {
    name,
    width: 52,
    height: 40,
    tolerance: TOL,
    build(env) {
      const field = newField(env, seed);
      const sprite = new Sprite(colorTexture(env, SPRITE_W, SPRITE_H, seed + 1));
      sprite.position.set(SPRITE_X, SPRITE_Y);
      const material = new BurnMaterialFilter(field);
      const glow = new BurnGlowFilter(field);
      for (const f of [material, glow]) {
        f.setShade(params);
        f.setUvAffine(uvAffine());
        f.setCamera(CAM.x, CAM.y, CAM.scale);
      }
      sprite.filters = chain === 'material' ? [material] : chain === 'glow' ? [glow] : [material, glow];
      const root = new Container();
      root.addChild(sprite);
      return root;
    },
  };
}

// ───────────────────────────── 纹理宿主(NPC / 手上挂件:图像空间画颜色图 + 自发光图)

/** 模板图整张 36×28,宿主显示的是其中一块 frame(测 uBaseFrame);RT 与 frame 同尺寸 */
const BASE_W = 36;
const BASE_H = 28;
const FRAME = new Rectangle(3, 2, 30, 22);

/** 回读宿主拿到的 RT(`BurnRenderer` 的 RT 没指定格式 = Pixi 缺省 `bgra8unorm`;通道序由框架按存储格式换好) */
async function readRt(env: ParityEnv, tex: Texture): Promise<Float32Array> {
  return env.readTexture(tex, 'rgba8unorm');
}

/**
 * 真跑 `BurnRenderer`:挂纹理宿主 → 模拟那样把字节编码进 `fieldData` → `markDirty` 上传 → `setShade` → `update` 画 RT;
 * 回读宿主拿到的颜色图与自发光图,左右拼成一张(左 = 颜色图、右 = 自发光图)。
 * `steps` 逐帧推进(每帧可改燃烧场字节并重传),对照最后一帧。
 */
async function runImageSpace(
  env: ParityEnv,
  seed: number,
  steps: Array<{ params: BurnShadeParams; fieldVariant?: 0 | 1 }>,
): Promise<Float32Array> {
  const whole = colorTexture(env, BASE_W, BASE_H, seed + 1);
  const base = new Texture({ source: whole.source, frame: FRAME.clone() });
  let albedo: Texture | null = null;
  let emissive: Texture | null = null;
  const host: BurnTextureHost = {
    burnBaseTexture: () => base,
    setBurnTextures: (a, e) => { albedo = a; emissive = e; },
  };
  const br = new BurnRenderer();
  br.setPixiRenderer(() => env.renderer);
  try {
    br.attach('k', { kind: 'texture', host }, GRID_W, GRID_H);
    let nowMs = 0;
    let variant: 0 | 1 | null = null;
    for (const step of steps) {
      const v = step.fieldVariant ?? 0;
      if (v !== variant) {
        encodeField(br.fieldData('k')!, env, seed, v);
        br.markDirty('k', nowMs, variant === null);
        variant = v;
      }
      br.setShade('k', step.params, null);
      br.update(nowMs, { x: 0, y: 0, scale: 1 });
      nowMs += 100; // 超过上传限速间隔:待传的在下一帧 update 里补上
    }
    if (!albedo || !emissive) throw new Error('BurnRenderer 没把颜色图 / 自发光图交给宿主');
    const a = await readRt(env, albedo);
    const e = await readRt(env, emissive);
    const w = FRAME.width;
    const h = FRAME.height;
    const out = new Float32Array(w * 2 * h * 4);
    for (let y = 0; y < h; y++) {
      out.set(a.subarray(y * w * 4, (y + 1) * w * 4), y * w * 2 * 4);
      out.set(e.subarray(y * w * 4, (y + 1) * w * 4), (y * w * 2 + w) * 4);
    }
    return out;
  } finally {
    br.clear();
    base.destroy(false);
    whole.destroy(true);
  }
}

function imageCase(name: string, seed: number, steps: Array<{ params: BurnShadeParams; fieldVariant?: 0 | 1 }>): ParityCase {
  return {
    name,
    width: FRAME.width * 2,
    height: FRAME.height,
    tolerance: TOL,
    build() {
      throw new Error('走 produce');
    },
    produce: (env) => runImageSpace(env, seed, steps),
  };
}

// ───────────────────────────── 用例

export const cases: ParityCase[] = [
  // 滤镜:材质单挂(= 自发光关)五档
  ...STATES.map((s, i) => filterCase(`燃烧 / 滤镜 材质 · ${s.label}`, 'material', shade(s.now), 501 + i * 10)),
  // 滤镜:材质 → 自发光(= 自发光开;运行时链里两道之间还隔着受光,这里直连)
  ...STATES.map((s, i) => filterCase(`燃烧 / 滤镜 材质+自发光 · ${s.label}`, 'material+glow', shade(s.now), 501 + i * 10)),
  filterCase('燃烧 / 滤镜 自发光单挂 · 蔓延中', 'glow', shade(5), 601),
  filterCase('燃烧 / 滤镜 自发光单挂 · 焦黑余烬', 'glow', shade(10.5), 611),
  filterCase('燃烧 / 滤镜 材质+自发光 · 硬边(烤黄 0 / 成灰过渡 0 / 毛边 0)', 'material+glow', shade(6, HARD_EDGE), 621),
  filterCase('燃烧 / 滤镜 材质+自发光 · 发光强度 0', 'material+glow', shade(5, { glow: [0, 0, 0], emberGlow: [0, 0, 0] }), 631),
  {
    // 燃烧场第一帧画过之后改字节再 upload():候选侧没重传就还是第一份
    name: '燃烧 / 滤镜 材质+自发光 · 燃烧场逐帧重传(source.update)',
    width: 52,
    height: 40,
    tolerance: TOL,
    frames: 2,
    build(env) {
      const field = newField(env, 641);
      const sprite = new Sprite(colorTexture(env, SPRITE_W, SPRITE_H, 642));
      sprite.position.set(SPRITE_X, SPRITE_Y);
      const material = new BurnMaterialFilter(field);
      const glow = new BurnGlowFilter(field);
      for (const f of [material, glow]) {
        f.setShade(shade(4));
        f.setUvAffine(uvAffine());
        f.setCamera(CAM.x, CAM.y, CAM.scale);
      }
      sprite.filters = [material, glow];
      const root = new Container();
      root.addChild(sprite);
      liveFilters.set(root, { field, filters: [material, glow] });
      return root;
    },
    beforeFrame(env, root, frame) {
      if (frame !== 1) return;
      const live = liveFilters.get(root)!;
      encodeField(live.field.data, env, 641, 1);
      live.field.upload();
      for (const f of live.filters) f.setShade(shade(6.5));
    },
  },
  // 图像空间(纹理宿主):颜色图 + 自发光图,五档
  ...STATES.map((s, i) => imageCase(`燃烧 / 图像空间 颜色图|自发光图 · ${s.label}`, 701 + i * 10, [{ params: shade(s.now) }])),
  imageCase('燃烧 / 图像空间 颜色图|自发光图 · 硬边(烤黄 0 / 成灰过渡 0 / 毛边 0)', 751, [{ params: shade(6, HARD_EDGE) }]),
  imageCase('燃烧 / 图像空间 颜色图|自发光图 · 逐帧推进(uniform 与燃烧场重传)', 761, [
    { params: shade(2) },
    { params: shade(4.5) },
    { params: shade(7), fieldVariant: 1 },
    { params: shade(9.5), fieldVariant: 1 },
  ]),
];
