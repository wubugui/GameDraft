/**
 * 阴影线扫前缀(`ShadowPrefixPass`:初始化 + 扫描两个程序)与 GI 反弹(`GiBouncePass`)的像素对照。
 *
 * 两者都是多 pass 的离屏链,用 `produce()` 直接驱动真实的宿主类(`solve` / `render`),
 * 再用 `env.readTexture` 回读 rgba16float 结果。多组 slab 的用例把各组**竖着拼**成一张比。
 *
 * 覆盖面:
 * - 前缀:0 盏灯(整张哨兵、不扫描)、奇数趟(收尾拷贝回 slab)/ 偶数趟、满一组 4 盏、>4 盏两组、
 *   不投影灯(通道留哨兵)、一整组都不投影(只有初始化)、同一实例连解两次(ping-pong 复用)、
 *   灯正落在像素中心(k = 0)、灯在图外、反深度映射;哨兵 65504 与真实值在灯周圈被双线性混合。
 * - GI:16 方向满载、ndir 少于上限(提前 break)、ndir 超上限(截到 16 + 告警)、改增益与灯体阈值;
 *   命中图上下不对称,格子寻址的行序翻了就对不上。
 */
import { Texture, type Shader } from 'pixi.js';
import type { ParityCase, ParityEnv } from '../harness';
import {
  LIGHTS_PER_SLAB, PREFIX_SENTINEL, scanPassCount, ShadowPrefixPass, type PrefixLight,
} from '@src/rendering/lighting/shadowPrefix';
import { GI_MAX_DIRS, GiBouncePass } from '@src/rendering/lighting/GiBouncePass';

/**
 * 容差:结果是 rgba16float。前缀值域(非哨兵)在 ±1.5 以内,GI 反弹在 0..1.3 以内,按配方卡给 1e-3。
 * 哨兵 65504 两边必须逐位相同(任何差都远超容差)。
 * 实测(无头 SwiftShader,2026-09-25)全部用例两边**逐位相同**(最大差 0),含哨兵被双线性混出来的
 * 65376 这类值;以后若出现非零差,先查翻译,不要放宽容差。
 */
const TOL = 1e-3;

/** 给了 `produce` 框架就不调 `build`;类型上它是必填,占个位 */
function produceOnly(): never {
  throw new Error('本文件的用例走 produce()');
}

// ───────────────────────────── 阴影前缀

interface PrefixSolveStep {
  lights: PrefixLight[];
  biasQ: number;
}

interface PrefixSetup {
  w: number;
  h: number;
  seed: number;
  /** invert, scale, offset */
  depthMapping: [number, number, number];
  /** ppu, cx, cy */
  cal: [number, number, number];
  /** 依次解这几次(同一实例) */
  steps: PrefixSolveStep[];
  /** 回读前几组 slab(竖着拼) */
  readSlabs: number;
  /** 断言扫描趟数的奇偶,防止改尺寸后用例名与实际覆盖面对不上 */
  expectOddPasses?: boolean;
  /** 回读后在本侧自检(不变量不成立就抛,算该侧出错) */
  check?: (data: Float32Array) => void;
}

/**
 * 合成深度场(RG 两个 8 位通道拼 16 位,与 `raw_depth_rg.png` 同编码):
 * 斜坡地面 + 几块高出地面的遮挡体 + 噪声。遮挡体让前缀里真的出现「被挡」的剖面。
 */
function makeDepth(env: ParityEnv, w: number, h: number, seed: number): Texture {
  const rng = env.rng(seed);
  const raw = new Uint16Array(w * h);
  const boxes: [number, number, number, number, number][] = [];
  for (let i = 0; i < 4; i++) {
    const bw = 3 + Math.floor(rng() * w * 0.2);
    const bh = 3 + Math.floor(rng() * h * 0.3);
    boxes.push([Math.floor(rng() * (w - bw)), Math.floor(rng() * (h - bh)), bw, bh, 0.15 + rng() * 0.3]);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 0..1:下方近(大)上方远(小),再叠遮挡体与噪声
      let u = 0.25 + 0.5 * (y / h) + 0.05 * Math.sin(x * 0.37);
      for (const [bx, by, bw, bh, lift] of boxes) {
        if (x >= bx && x < bx + bw && y >= by && y < by + bh) u += lift;
      }
      u += (rng() - 0.5) * 0.01;
      raw[y * w + x] = Math.max(0, Math.min(65535, Math.round(u * 65535)));
    }
  }
  return env.dataTexture({
    width: w, height: h, seed,
    // 运行时深度图是 PNG,缺省线性过滤;尺寸与 depthSize 相同,采在像素中心
    scaleMode: 'linear',
    fill: (x, y, c) => {
      const v = raw[y * w + x];
      return c === 0 ? (v >>> 8) / 255 : c === 1 ? (v & 255) / 255 : c === 2 ? 0 : 1;
    },
  });
}

async function runPrefix(env: ParityEnv, s: PrefixSetup): Promise<Float32Array> {
  const passes = scanPassCount(s.w, s.h);
  if (s.expectOddPasses !== undefined && (passes % 2 === 1) !== s.expectOddPasses) {
    throw new Error(`用例尺寸 ${s.w}×${s.h} 扫描 ${passes} 趟,与用例声明的奇偶不符`);
  }
  const depth = makeDepth(env, s.w, s.h, s.seed);
  const pass = new ShadowPrefixPass({ depth, depthSize: [s.w, s.h], depthMapping: s.depthMapping, cal: s.cal });
  try {
    for (const step of s.steps) pass.solve(env.renderer, step.lights, step.biasQ);
    const n = s.w * s.h * 4;
    const out = new Float32Array(n * s.readSlabs);
    for (let i = 0; i < s.readSlabs; i++) {
      const slab = pass.slab(i);
      if (!slab) throw new Error(`slab(${i}) 为空`);
      out.set(await env.readTexture(slab, 'rgba16float'), i * n);
    }
    s.check?.(out);
    return out;
  } finally {
    pass.destroy();
    depth.destroy(true);
  }
}

/** 像素坐标 → q(反着 `solve` 里的 px = cx + q.x·ppu、py = cy − q.y·ppu) */
function lightAtPx(cal: [number, number, number], px: number, py: number, z: number, castShadow = true): PrefixLight {
  const [ppu, cx, cy] = cal;
  return { q: [(px - cx) / ppu, (cy - py) / ppu, z], castShadow };
}

function prefixCase(name: string, s: PrefixSetup): ParityCase {
  return {
    name,
    width: s.w,
    height: s.h * s.readSlabs,
    target: 'rgba16float',
    tolerance: TOL,
    build: produceOnly,
    produce: (env) => runPrefix(env, s),
  };
}

const CAL_A: [number, number, number] = [16, 24, 16];   // 48×32:6 趟(偶)
const CAL_B: [number, number, number] = [20, 32, 20];   // 64×40:7 趟(奇)

// ───────────────────────────── GI 反弹

interface GiSetup {
  grid: [number, number, number];
  ndir: number;
  seed: number;
  radianceSize: [number, number];
  /** 改 uniform 后再画一次(覆盖结构体里 uGain / uEmitReject 的偏移) */
  gain?: number;
  emitReject?: number;
}

async function runGi(env: ParityEnv, s: GiSetup): Promise<Float32Array> {
  const [nx, ny, nz] = s.grid;
  const [rw, rh] = s.radianceSize;
  // 辐射场:运行时是 rgba16float 线性过滤的 RT;alpha = 自发光占比,一部分超过阈值(灯体)
  const radiance = env.dataTexture({
    width: rw, height: rh, seed: s.seed, format: 'rgba16float', scaleMode: 'linear',
    fill: (_x, _y, c, rng) => (c === 3 ? (rng() < 0.25 ? 0.6 + rng() * 0.4 : rng() * 0.4) : rng()),
  });
  // 命中图:u, v, 命中标志, 255。上半部分格子的前几个方向故意全 miss,让上下不对称
  const hitmap = env.dataTexture({
    width: nx * nz, height: ny * s.ndir, seed: s.seed + 1,
    fill: (_x, y, c, rng) => {
      const dir = Math.floor(y / ny);
      const cellY = y % ny;
      if (c === 0 || c === 1) return rng();
      if (c === 2) return cellY < ny / 2 && dir < 3 ? 0 : rng() < 0.7 ? 1 : 0;
      return 1;
    },
  });
  const pass = new GiBouncePass(radiance.source, { hitmap: hitmap.source, gridN: [nx, ny, nz], ndir: s.ndir });
  try {
    pass.render(env.renderer);
    if (s.gain !== undefined || s.emitReject !== undefined) {
      const u = (pass as unknown as { shader: Shader }).shader.resources.giBounce.uniforms;
      if (s.gain !== undefined) u.uGain = s.gain;
      if (s.emitReject !== undefined) u.uEmitReject = s.emitReject;
      pass.render(env.renderer);
    }
    const bounce = pass.bounce;
    if (!bounce) throw new Error('GiBouncePass 没有产出');
    return await env.readTexture(new Texture({ source: bounce }), 'rgba16float');
  } finally {
    pass.destroy();
    radiance.destroy(true);
    hitmap.destroy(true);
  }
}

function giCase(name: string, s: GiSetup): ParityCase {
  const [nx, ny, nz] = s.grid;
  return {
    name,
    width: nx * nz,
    height: ny,
    target: 'rgba16float',
    tolerance: TOL,
    build: produceOnly,
    produce: (env) => runGi(env, s),
  };
}

// ───────────────────────────── 用例

export const cases: ParityCase[] = [
  prefixCase('阴影与GI / 阴影前缀 · 0 盏灯(整张哨兵,不扫描)', {
    w: 48, h: 32, seed: 101, depthMapping: [0, 2, -1], cal: CAL_A,
    steps: [{ lights: [], biasQ: 0.01 }],
    readSlabs: 1,
    check: (d) => {
      const bad = d.findIndex((v) => v !== PREFIX_SENTINEL);
      if (bad >= 0) throw new Error(`没灯时应整张是哨兵 ${PREFIX_SENTINEL},第 ${bad} 个分量是 ${d[bad]}`);
    },
  }),
  prefixCase('阴影与GI / 阴影前缀 · 1 盏灯(奇数趟,收尾拷贝回 slab)', {
    w: 64, h: 40, seed: 102, depthMapping: [0, 2, -1], cal: CAL_B,
    steps: [{ lights: [lightAtPx(CAL_B, 21.3, 13.7, -0.4)], biasQ: 0.02 }],
    readSlabs: 1,
    expectOddPasses: true,
  }),
  prefixCase('阴影与GI / 阴影前缀 · 4 盏满一组(偶数趟;灯在像素中心 / 图外 / 反深度映射)', {
    w: 48, h: 32, seed: 103, depthMapping: [1, 1.5, -0.5], cal: CAL_A,
    steps: [{
      lights: [
        lightAtPx(CAL_A, 12.5, 20.5, 0.3),     // 正落在像素中心:k = 0 那一格
        lightAtPx(CAL_A, 60.2, -9.4, -1.2),    // 图外右上
        lightAtPx(CAL_A, 33.8, 6.1, 0.8),
        lightAtPx(CAL_A, -4.0, 28.0, -0.2),    // 图外左侧
      ],
      biasQ: 0.015,
    }],
    readSlabs: 1,
    expectOddPasses: false,
  }),
  prefixCase('阴影与GI / 阴影前缀 · 7 盏两组(含不投影灯)', {
    w: 64, h: 40, seed: 104, depthMapping: [0, 2, -1], cal: CAL_B,
    steps: [{
      lights: [
        lightAtPx(CAL_B, 10.2, 30.9, -0.5),
        lightAtPx(CAL_B, 40.0, 10.0, 0.2, false),   // 不投影:通道留哨兵
        lightAtPx(CAL_B, 55.7, 35.3, 0.9),
        lightAtPx(CAL_B, 31.1, 19.6, -1.1),
        lightAtPx(CAL_B, 5.5, 5.5, 0.4),
        lightAtPx(CAL_B, 70.0, 20.0, 0.1, false),   // 不投影
        lightAtPx(CAL_B, 44.4, 38.8, -0.3),
      ],
      biasQ: 0.01,
    }],
    readSlabs: 2,
    expectOddPasses: true,
  }),
  prefixCase('阴影与GI / 阴影前缀 · 第二组全不投影(只有初始化哨兵)', {
    w: 48, h: 32, seed: 105, depthMapping: [0, 2, -1], cal: CAL_A,
    steps: [{
      lights: [
        lightAtPx(CAL_A, 8.3, 9.1, 0.2),
        lightAtPx(CAL_A, 40.6, 25.2, -0.6),
        lightAtPx(CAL_A, 24.0, 30.0, 0.0, false),
        lightAtPx(CAL_A, 17.7, 3.3, 1.0),
        lightAtPx(CAL_A, 30.0, 15.0, 0.3, false),
        lightAtPx(CAL_A, 2.0, 2.0, -0.3, false),
      ],
      biasQ: 0.0,
    }],
    readSlabs: 2,
    expectOddPasses: false,
  }),
  prefixCase('阴影与GI / 阴影前缀 · 同一实例连解两次(6 盏 → 3 盏,ping-pong 复用)', {
    w: 64, h: 40, seed: 106, depthMapping: [0, 2, -1], cal: CAL_B,
    steps: [
      {
        lights: [
          lightAtPx(CAL_B, 12.0, 12.0, 0.5), lightAtPx(CAL_B, 50.0, 30.0, -0.5),
          lightAtPx(CAL_B, 32.0, 2.0, 0.1), lightAtPx(CAL_B, 3.0, 37.0, -0.9),
          lightAtPx(CAL_B, 60.0, 5.0, 0.7), lightAtPx(CAL_B, 20.0, 25.0, 0.0),
        ],
        biasQ: 0.03,
      },
      {
        // 第二次只剩一组:slab 0 必须被完整重写;slab 1 保留第一次的结果(不被碰)
        lights: [
          lightAtPx(CAL_B, 45.3, 14.2, -0.2), lightAtPx(CAL_B, 9.9, 33.1, 0.6, false),
          lightAtPx(CAL_B, 27.4, 27.4, 1.3),
        ],
        biasQ: -0.01,
      },
    ],
    readSlabs: 2,
    expectOddPasses: true,
  }),

  giCase(`阴影与GI / GI 反弹 · ${GI_MAX_DIRS} 方向满载(命中图上下不对称,锁格子行序)`, {
    grid: [5, 6, 3], ndir: GI_MAX_DIRS, seed: 201, radianceSize: [24, 16],
  }),
  giCase('阴影与GI / GI 反弹 · ndir=5 提前 break + 改增益与灯体阈值', {
    grid: [4, 5, 4], ndir: 5, seed: 202, radianceSize: [20, 12], gain: 2.5, emitReject: 0.3,
  }),
  giCase(`阴影与GI / GI 反弹 · ndir=20 超上限(截到 ${GI_MAX_DIRS})`, {
    grid: [3, 4, 2], ndir: 20, seed: 203, radianceSize: [16, 16],
  }),
];

// 用例里的灯数与每组容量对得上(改 LIGHTS_PER_SLAB 时提醒这里的"两组"用例要跟着改)
if (LIGHTS_PER_SLAB !== 4) throw new Error(`LIGHTS_PER_SLAB = ${LIGHTS_PER_SLAB},本文件的分组用例按 4 写的`);
