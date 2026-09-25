/**
 * 粒子渲染(VFX)的像素对照(「粒子 /」):真实的 `VfxRenderer` 驱动真实的批网格 / 着色器画进离屏目标。
 *
 * 被测的五个程序:无光(含 tone 色调融入)、受光 billboard、受光薄片、雷、光柱。输入全部固定种子:
 *   - 世界:一个合成的 field 空间(45° 俯角、1 q = 40 wu、work 48×36、场景 192×144 wu = 对照目标 1 px / wu),
 *     行走面深度场带一点起伏;模拟对象是真的 `VfxInstanceSim`(按效果定义建发射器 / 光柱 / 雷形),
 *     粒子池、薄片状态、燃烧进度直接按种子写入(不跑模拟步进,位置可控、两侧逐字节相同);
 *   - 遮挡:RG16 打包的原画深度(与运行时同口径),两根「柱子」比身后的地面近,可反深度;
 *   - 受光:真的 `CharacterLightingSystem.createCustomLitShader`(场景静态组、粒子那组 frameShade、角色灯组都是
 *     真的工厂建的),probe 图集(L1 / L2 / 八面体)、valid、skyao 是种子数据纹理;实体灯按 lightPacking 的 A/B/C/D 布局
 *     手排(点 / 聚 / 面 / 线 / 平行各种,含 24 盏满载),显示变换有恒等与非恒等两组;
 *   - 多帧:每个用例画 3 帧,帧间挪粒子、改存活数(先多后少,专门走「上一帧用过、这一帧没用的槽位缩成零面积」)、
 *     推寿命 / 燃烧进度 / 光柱钟,最后一帧的结果对照——动态顶点缓冲逐帧更新的路径两侧都跑一遍。
 *
 * ## add 混合的 alpha(Pixi 两个后端的混合表不同,不是着色器差异)
 *
 * Pixi-WebGL 的 `add` = blendFunc(ONE, ONE)(颜色与 alpha 都相加);原版 Pixi-WebGPU 的 `add` 颜色同为 one/one,
 * **alpha 却是 src-alpha / one-minus-src-alpha**。`installPixiWebGpuPatches` 已把它对齐到 WebGL(= master),
 * 所以左半 = 真实混合、RGBA 全比(顺带钉住这条补丁);右半 = 同一帧把这些网格临时改成 normal 混合再画,
 * RGBA 全比——着色器输出的 alpha 在这里单独钉住(add 下 alpha 会被目标里已有的值叠掉一部分信息)。
 * 光柱的 add / screen 输出 alpha 恒 0,两张混合表结果相同,不需要这一步。
 *
 * 容差 2/255(8 位目标)。GL 侧与移植前逐字节相同的核对见提交说明(对移植前 / 后的源码各跑一遍,哈希参考侧输出)。
 */
import { Container, Mesh, RenderTexture, Texture, type UniformGroup } from 'pixi.js';
import type { ParityCase, ParityEnv } from '../harness';
import { CharacterLightingSystem } from '@src/core/CharacterLightingSystem';
import { applyCharDisplay, createCharLightUniforms, createSceneLitUniforms } from '@src/rendering/CharacterLitSprite';
import { MAX_STATIC_LIGHTS, type PackedLights } from '@src/rendering/lighting/lightPacking';
import { VfxRenderer, type VfxRenderDeps, type VfxSpriteSheet } from '@src/rendering/vfx/VfxRenderer';
import { createPlateBurnState, type PlateBurnParams } from '@src/systems/vfx/vfxPlateBurn';
import { VfxInstanceSim, type VfxEmitterRuntime } from '@src/systems/vfx/vfxSim';
import { createFieldVfxSpace, type VfxSpace } from '@src/systems/vfx/vfxSpace';
import { viewDirWorld, type SceneSpaceGeometry, type Vec3 } from '@src/utils/sceneSpace';
import type {
  DisplayTransformDef, SceneDepthConfig, VfxBeamDef, VfxBoltDef, VfxEffectDef, VfxEmitterDef,
} from '@src/data/types';

// ───────────────────────────── 合成世界

const W = 192;
const H = 144;
const WORK_W = 48;
const WORK_H = 36;
const PPU = 12;
const CX = 24;
const CY = 18;
const WU_PER_Q = 40;
const C45 = Math.SQRT1_2;
/** q → M-world 行主序(det = +1,45° 俯角) */
const R_ROWS = [1, 0, 0, 0, C45, -C45, 0, C45, C45];

/** work 像素处的行走面深度(q.z):45° 平地 d = q.y,再叠一点起伏 */
function groundD(px: number, py: number): number {
  return (CY - py) / PPU + 0.05 * Math.sin(px * 0.31) + 0.03 * Math.cos(py * 0.23);
}

function makeSpace(): VfxSpace {
  const data = new Float32Array(WORK_W * WORK_H);
  for (let y = 0; y < WORK_H; y++) for (let x = 0; x < WORK_W; x++) data[y * WORK_W + x] = groundD(x + 0.5, y + 0.5);
  const geo: SceneSpaceGeometry = {
    work: { w: WORK_W, h: WORK_H }, cal: { ppu: PPU, cx: CX, cy: CY },
    sceneWorld: { w: W, h: H }, basisRows: R_ROWS, wuPerQUnit: WU_PER_Q,
    ground: { w: WORK_W, h: WORK_H, data },
  };
  return createFieldVfxSpace({ geo, shell: null, viewDir: viewDirWorld(geo) });
}

/** 0..1 → RG16 两个字节 */
function rg16(t: number): [number, number] {
  const v = Math.round(Math.max(0, Math.min(1, t)) * 65535);
  return [v >> 8, v & 255];
}

/** 画面上立着的遮挡物:x 范围 + 顶 + 底边(贴地处);整面取底边那一行的地面深度 */
interface Occluder { x0: number; x1: number; top: number; base: number }

const PILLARS: Occluder[] = [
  { x0: 52, x1: 70, top: 10, base: 104 },
  { x0: 128, x1: 150, top: 30, base: 122 },
];

const D_SCALE = 4;
const D_OFFSET = -2;
const D_W = 96;
const D_H = 72;

function sceneDepthAt(sx: number, sy: number, occ: readonly Occluder[]): number {
  for (const o of occ) {
    if (sx >= o.x0 && sx < o.x1 && sy >= o.top && sy < o.base) return groundD((o.x0 + o.x1) / 8, o.base / 4);
  }
  return groundD(sx / 4, sy / 4);
}

function depthTexture(env: ParityEnv, invert: boolean): Texture {
  return env.dataTexture({
    width: D_W, height: D_H, seed: 91,
    fill: (x, y, c) => {
      if (c >= 2) return c === 3 ? 1 : 0;
      let raw = (sceneDepthAt((x + 0.5) * (W / D_W), (y + 0.5) * (H / D_H), PILLARS) - D_OFFSET) / D_SCALE;
      if (invert) raw = 1 - raw;
      return rg16(raw)[c] / 255;
    },
  });
}

/** 与种子无关的像素哈希(同一像素的四个通道要用同一个值) */
function hash2(x: number, y: number, k: number): number {
  let h = Math.imul(x * 374761393 + y * 668265263 + k * 2246822519, 1274126177) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 2×2 帧的粒子图集(预乘,线性采样):每帧一团不同颜色、不同轮廓的软斑 */
function puffAtlas(env: ParityEnv): Texture {
  const cols = [[1, 0.72, 0.38], [0.55, 0.78, 1], [0.92, 0.9, 0.86], [0.45, 1, 0.55]];
  return env.dataTexture({
    width: 64, height: 64, seed: 92, scaleMode: 'linear', alphaMode: 'premultiplied-alpha',
    fill: (x, y, c) => {
      const f = (x >= 32 ? 1 : 0) + (y >= 32 ? 2 : 0);
      const dx = ((x % 32) + 0.5 - 16) / 14;
      const dy = ((y % 32) + 0.5 - 16) / (f === 2 ? 9 : 14);
      const r2 = dx * dx + dy * dy;
      const a = Math.max(0, Math.min(1, (1 - r2) * (f === 1 ? 1.6 : 1.1) * (0.75 + 0.25 * hash2(x, y, 1))));
      if (c === 3) return a;
      const g = 0.7 + 0.3 * ((x % 32) / 31);
      return cols[f][c] * g * a;
    },
  });
}

/** 纸钱图集(预乘):两帧并排,带一道边框与纹理 */
function paperAtlas(env: ParityEnv): Texture {
  return env.dataTexture({
    width: 64, height: 32, seed: 93, scaleMode: 'linear', alphaMode: 'premultiplied-alpha',
    fill: (x, y, c) => {
      const fx = x % 32;
      const border = fx < 2 || fx > 29 || y < 2 || y > 29;
      const a = border ? 0.55 : 1;
      if (c === 3) return a;
      const base = x >= 32 ? [0.95, 0.82, 0.55] : [0.9, 0.88, 0.84];
      const n = 0.8 + 0.2 * hash2(x, y, 2);
      return base[c] * (border ? 0.6 : n) * a;
    },
  });
}

const PUFF_FRAMES = [
  { u0: 0, v0: 0, u1: 0.5, v1: 0.5 }, { u0: 0.5, v0: 0, u1: 1, v1: 0.5 },
  { u0: 0, v0: 0.5, u1: 0.5, v1: 1 }, { u0: 0.5, v0: 0.5, u1: 1, v1: 1 },
];
const PAPER_FRAMES = [{ u0: 0, v0: 0, u1: 0.5, v1: 1 }, { u0: 0.5, v0: 0, u1: 1, v1: 1 }];

// ───────────────────────────── 受光载荷(probe / skyao / 实体灯)

const PN: [number, number, number] = [5, 4, 5];
/**
 * 每行几颗 probe。⚠ 必须是 4 的倍数(与运行时 `CharacterLightingSystem.probeTiling` 同一条约束):valid 是 r8unorm,
 * Pixi-WebGL 上传缓冲纹理不改 UNPACK_ALIGNMENT(缺省 4),行字节数不 4 对齐时 GL 侧读歪、WebGPU 侧照常——
 * 两侧差的是输入不是着色器(本用例最初取 10 就踩到了:受光全体偏差 10% 上下)。
 */
const PROBE_T = 12;
const PROBE_COUNT = PN[0] * PN[1] * PN[2];
const PROBE_ROWS = Math.ceil(PROBE_COUNT / PROBE_T);
const SKY_N: [number, number, number] = [4, 4, 4];
const SKY_TILES: [number, number] = [2, 2];

interface LightingCfg {
  /** 粒子那组 frameShade 的 uMode:1 = L1、2 = L2(uShK 系数)、3 = 八面体(uBinOb) */
  mode: 1 | 2 | 3;
  shK?: 9 | 25;
  binOb?: 8 | 16;
  fold?: 0 | 1;
  skyao: boolean;
  skyaoBlend?: number;
  eChroma?: number;
  amb?: number;
  lights: LightRow[];
  lightCount?: number;
}

type LightRow = { a: number[]; b: number[]; c: number[]; d: number[] };

/** 实体灯(M-world wu;A = 位置 + 种类,B = 颜色 + 强度,C = 距离参数,D = 方向 + 标志位) */
const FEW_LIGHTS: LightRow[] = [
  { a: [30, 45, -40, 0], b: [1, 0.78, 0.5, 5200], c: [220, 60, 0, 0], d: [0, 0, 0, 0] },
  { a: [-55, 30, -20, 0], b: [0.45, 0.6, 1, 3800], c: [180, 40, 0, 0], d: [0, 0, 0, 0] },
  { a: [0, 120, -60, 1], b: [1, 1, 0.85, 14000], c: [300, 80, 0.97, 0.85], d: [0, -0.8, 0.45, 0] },
];

const MIXED_LIGHTS: LightRow[] = [
  ...FEW_LIGHTS,
  // 面光(双面 / 单面),C = [range, roll, halfW, halfH],D.xyz = 法线
  { a: [60, 20, -50, 2], b: [0.9, 0.7, 1, 2.2], c: [260, 0.4, 25, 12], d: [-0.3, 0.2, 0.9, 2] },
  { a: [-70, 40, 30, 2], b: [1, 0.5, 0.3, 1.8], c: [240, -0.7, 18, 30], d: [0.6, -0.4, -0.5, 0] },
  // 线光(雷身):A = 起点,D.xyz = 段
  { a: [-20, 150, -10, 4], b: [0.75, 0.82, 1, 1200], c: [320, 20, 0, 0], d: [10, -140, -5, 0] },
  // 平行光:D.xyz = 朝光
  { a: [0, 0, 0, 3], b: [0.3, 0.32, 0.4, 0.6], c: [0, 0, 0, 0], d: [0.3, 0.8, -0.5, 0] },
  // 强度 0 的灯:整段跳过
  { a: [0, 30, 0, 0], b: [1, 1, 1, 0], c: [200, 10, 0, 0], d: [0, 0, 0, 0] },
  // 下标 8 不在 count 里:强度大到一旦被算进来就一眼可见
  { a: [0, 30, -20, 0], b: [1, 1, 1, 9e5], c: [400, 10, 0, 0], d: [0, 0, 0, 0] },
];

function randomLights(rng: () => number, count: number): LightRow[] {
  const out: LightRow[] = [];
  for (let i = 0; i < count; i++) {
    const kind = Math.floor(rng() * 5);
    const p = [(rng() - 0.5) * 200, rng() * 120, (rng() - 0.5) * 200];
    const col = [0.3 + rng() * 0.7, 0.3 + rng() * 0.7, 0.3 + rng() * 0.7];
    const dir = [rng() - 0.5, rng() - 0.5, rng() - 0.5];
    const inten = kind === 2 ? 0.5 + rng() * 2 : kind === 3 ? 0.1 + rng() * 0.4 : kind === 4 ? 200 + rng() * 800 : 800 + rng() * 3000;
    const c = kind === 1 ? [150 + rng() * 200, 20 + rng() * 60, 0.9 + rng() * 0.09, 0.6 + rng() * 0.25]
      : kind === 2 ? [150 + rng() * 200, (rng() - 0.5) * 3, 5 + rng() * 25, 5 + rng() * 25]
        : [150 + rng() * 200, 20 + rng() * 60, 0, 0];
    const d = kind === 4 ? [(rng() - 0.5) * 80, (rng() - 0.5) * 80, (rng() - 0.5) * 80] : dir;
    out.push({ a: [...p, kind], b: [...col, inten], c, d: [...d, rng() < 0.5 ? 2 : 0] });
  }
  return out;
}

function packRows(rows: LightRow[], count: number): PackedLights {
  const n = MAX_STATIC_LIGHTS * 4;
  const packed = {
    sunColor: [0, 0, 0], sunIntensity: 0, sunDir: [0, 1, 0], shadow: [0, 0, 0, 0],
    a: new Float32Array(n), b: new Float32Array(n), c: new Float32Array(n), d: new Float32Array(n),
    count, dropped: 0,
  } as PackedLights;
  rows.slice(0, MAX_STATIC_LIGHTS).forEach((l, i) => {
    packed.a.set(l.a, i * 4); packed.b.set(l.b, i * 4); packed.c.set(l.c, i * 4); packed.d.set(l.d, i * 4);
  });
  return packed;
}

/**
 * 真的照明系统,载荷由用例注入(私有字段按运行时 loadScene 同名同形写入;场景静态组用真的工厂建)。
 * 返回的系统 `createCustomLitShader` / `displayUniforms` 与游戏里同一段代码。
 */
function makeLighting(env: ParityEnv, cfg: LightingCfg, display: DisplayTransformDef | null): CharacterLightingSystem {
  const shK = cfg.shK ?? 9;
  const binOb = cfg.binOb ?? 8;
  const B = binOb * binOb;
  const col = (x: number, ncol: number) => x % ncol;
  const pl1 = env.dataTexture({
    width: PROBE_T * 4, height: PROBE_ROWS, seed: 101, format: 'rgba16float',
    fill: (x, _y, c, rng) => (c === 3 ? 1 : col(x, 4) === 0 ? 0.25 + rng() * 0.9 : (rng() - 0.5) * 0.6),
  });
  const pl2 = env.dataTexture({
    width: PROBE_T * shK, height: PROBE_ROWS, seed: 102, format: 'rgba16float',
    fill: (x, _y, c, rng) => (c === 3 ? 1 : col(x, shK) === 0 ? 0.3 + rng() * 0.8 : (rng() - 0.5) * 0.4),
  });
  const pbin = env.dataTexture({
    width: PROBE_T * B, height: PROBE_ROWS, seed: 103, format: 'rgba16float',
    fill: (_x, _y, c, rng) => (c === 3 ? 1 : 0.05 + rng() * 0.7),
  });
  // x 格 0 那一层整片失效 ⇒ 落在那里的查询走 ambIrr 兜底;其余随机 15% 失效
  const valid = env.dataTexture({
    width: PROBE_T, height: PROBE_ROWS, seed: 104, format: 'r8unorm',
    fill: (x, y, _c, rng) => {
      const flat = y * PROBE_T + x;
      if (flat >= PROBE_COUNT) return 0;
      return Math.floor(flat / (PN[1] * PN[2])) === 0 || rng() < 0.15 ? 0 : 1;
    },
  });
  const skyTex = env.dataTexture({
    width: SKY_TILES[0] * SKY_N[0], height: SKY_TILES[1] * SKY_N[1], seed: 105, format: 'rgba16float',
    fill: (_x, _y, c, rng) => (c === 0 ? 0.25 + rng() * 0.75 : (rng() - 0.5) * 0.7),
  });
  const vol = env.dataTexture({ width: 4, height: 4, seed: 106, format: 'rgba16float' });
  const ground = env.dataTexture({ width: 8, height: 6, seed: 107 });
  const ambSH = new Float32Array(27);
  const rng = env.rng(108);
  for (let i = 0; i < 27; i++) ambSH[i] = i < 3 ? 0.35 + rng() * 0.3 : (rng() - 0.5) * 0.25;
  // probe 世界:uM = diag(1, 1, -1)(det = −1,列主序),网格盖住粒子的 q 范围
  const mCol = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, -1]);
  const wMin: [number, number, number] = [-2.5, -2, -2.5];
  const wScale: [number, number, number] = [(PN[0] - 1) / 5, (PN[1] - 1) / 4, (PN[2] - 1) / 5];
  const skyao = cfg.skyao
    ? {
        tex: skyTex.source, n: SKY_N, tiles: SKY_TILES,
        wMin: [-2.5, -2, -2.5] as [number, number, number], wScale: [1 / 5, 1 / 4, 1 / 5] as [number, number, number],
        mCol: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      }
    : null;
  const sys = new CharacterLightingSystem();
  const priv = sys as unknown as Record<string, unknown>;
  priv.resources = {
    atlasL1: pl1.source, atlasL2: pl2.source, atlasBin: pbin.source, valid: valid.source,
    volRad: vol.source, volEmit: vol.source, skyao,
  };
  priv.groundTex = ground.source;
  priv.sceneLit = createSceneLitUniforms({
    worldToWorkX: WORK_W / W, worldToWorkY: WORK_H / H,
    cal: { ppu: PPU, cx: CX, cy: CY, theta: 0.3 },
    vol: { nx: 2, ny: 2, nz: 4, tilesX: 2, tilesY: 2, qMin: [-2, -2, -2], qMax: [2, 2, 2] },
    mCol, wMin, wScale, pn: PN, probeT: PROBE_T, shK, binOb, ambSH,
    lightsQ: new Float32Array(192), lightsE: new Float32Array(192), lightCount: 0,
    groundMin: -2, groundMax: 2, sceneWorldW: W, sceneWorldH: H, workW: WORK_W, workH: WORK_H,
    skyao: skyao ?? undefined,
  });
  const frame = priv.vfxFrameLit as UniformGroup;
  Object.assign(frame.uniforms, {
    uMode: cfg.mode, uFold: cfg.fold ?? 1, uAmbStrength: cfg.amb ?? 1,
    uEChroma: cfg.eChroma ?? 0, uSkyaoBlend: cfg.skyaoBlend ?? 1,
  });
  frame.update();
  sys.setShadowBasis(R_ROWS);
  sys.applyLights(packRows(cfg.lights, cfg.lightCount ?? cfg.lights.length), WU_PER_Q);
  sys.applyDisplay(display);
  return sys;
}

// ───────────────────────────── 效果与种子数据

type Ap = Record<string, unknown>;

function puffEmitter(id: string, ap: Ap, max = 40): VfxEmitterDef {
  return { id, appearance: { image: 'x', sizeWu: 24, ...ap }, spawn: { max, shape: { kind: 'point' } } } as unknown as VfxEmitterDef;
}

function plateEmitter(id: string, ap: Ap, max = 24): VfxEmitterDef {
  return {
    id, appearance: { image: 'x', sizeWu: 16, tint: [0.86, 0.85, 0.83], ...ap },
    spawn: { max, shape: { kind: 'point' } },
    plate: { size: [20, 13], segments: 3, bend: { freq: 7 } },
  } as unknown as VfxEmitterDef;
}

function boltEmitter(id: string, bolt: string, layer: Ap, ap: Ap = {}): VfxEmitterDef {
  return {
    id,
    appearance: {
      sizeWu: 1, blend: 'add', lit: false, tint: [1, 0.98, 1],
      alphaOverLife: [[0, 1], [0.3, 0.9], [0.6, 0.5], [1, 0]],
      bolt: { bolt, part: 'all', coreColor: [1, 1, 1], glowColor: [0.72, 0.78, 1], ...layer },
      ...ap,
    },
    spawn: { max: 1, shape: { kind: 'point' } },
    life: { seconds: [0.5, 0.5] },
  } as unknown as VfxEmitterDef;
}

const SKY_BOLT: VfxBoltDef = {
  id: 'sky', kind: 'sky', seed: 7,
  sky: {
    tiltDeg: [0, 10], bendDeg: 10, bendLenWu: 90, stepWu: [18, 36], kinkDeg: [6, 16], zigzag: 0.6, roughness: 0.3,
    detailWu: 1.5, branchPerKWu: 40, branchFromWu: 20, branchMinWu: 4, branchMaxWu: 140,
    branchAngleDeg: [25, 70], branchIntensity: [0.3, 0.65], branchWidth: 0.4, forkPerKWu: 20, forkDepth: 2,
    lowBoostGain: 1.15, lowBoostWu: 30, cloudWu: 30000,
  },
} as VfxBoltDef;

const ARC_BOLT: VfxBoltDef = {
  id: 'arcs', kind: 'surface', seed: 8,
  surface: { count: [8, 12], lenWu: [20, 55], kinkDeg: [10, 35], roughness: 0.25, detailWu: 2, forkPerKWu: 20, intensity: [0.4, 0.9] },
} as VfxBoltDef;

/** 一只:画面点 + 离地高 + 速度 + 尺寸 …… 全按种子 */
function seedPuffs(space: VfxSpace, e: VfxEmitterRuntime, rng: () => number): void {
  const p = e.p;
  for (let i = 0; i < p.cap; i++) {
    const sx = 10 + rng() * (W - 20);
    const sy = 26 + rng() * (H - 34);
    const g = space.groundWorldAtScene(sx, sy);
    p.x[i] = g[0]; p.y[i] = g[1] + rng() * 34; p.z[i] = g[2];
    p.vx[i] = (rng() - 0.5) * 90; p.vy[i] = (rng() - 0.5) * 60; p.vz[i] = (rng() - 0.5) * 90;
    p.size[i] = 12 + rng() * 26;
    p.rot[i] = rng() * Math.PI * 2;
    p.life[i] = 2;
    p.age[i] = rng() * 1.6;
    p.seed[i] = rng();
    p.fade[i] = 0.55 + rng() * 0.45;
    p.mode[i] = 0;
  }
}

/** 薄片:朝向 / 切线 / 弯曲 / 接触 / 贴死 / 风 / 燃烧进度 */
function seedPlates(space: VfxSpace, e: VfxEmitterRuntime, rng: () => number, burning: boolean): void {
  seedPuffs(space, e, rng);
  const A = e.plate!.arr;
  const p = e.p;
  for (let i = 0; i < p.cap; i++) {
    p.size[i] = 16 * (0.75 + rng() * 0.5);
    let nx = (rng() - 0.5) * 1.6, ny = 0.3 + rng(), nz = (rng() - 0.5) * 1.6;
    const nl = Math.hypot(nx, ny, nz);
    nx /= nl; ny /= nl; nz /= nl;
    // 切线 ⊥ 法线
    const ax = Math.abs(ny) < 0.9 ? 0 : 1, ay = Math.abs(ny) < 0.9 ? 1 : 0;
    let tx = ay * nz, ty = -ax * nz, tz = ax * ny - ay * nx;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    A.nx[i] = nx; A.ny[i] = ny; A.nz[i] = nz; A.tx[i] = tx; A.ty[i] = ty; A.tz[i] = tz;
    A.bend[i] = (rng() - 0.5) * 1.1;
    A.restBend[i] = 0.35;
    const k = rng();
    A.contact[i] = k < 0.5 ? 0 : 1;
    A.hold[i] = k > 0.85 ? Infinity : 0;
    A.wind[i] = rng() * 260;
    A.metric[i] = 0;
  }
  if (burning) {
    const P = { charColor: [0.09, 0.07, 0.05], glow: [1, 0.48, 0.14], glowStrength: 1.3 } as unknown as PlateBurnParams;
    const S = createPlateBurnState(p.cap, P);
    for (let i = 0; i < p.cap; i++) {
      if (i % 3 === 0) { S.burnT[i] = rng() * 0.9; S.dur[i] = 1; S.dir[i] = rng() < 0.5 ? -1 : 1; }
    }
    e.burn = S;
  }
}

/** 雷的落点:一颗粒子,年龄按帧推 */
function seedBolt(e: VfxEmitterRuntime, at: Vec3, age: number): void {
  const p = e.p;
  p.alive[0] = 1;
  p.x[0] = at[0]; p.y[0] = at[1]; p.z[0] = at[2];
  p.size[0] = 1; p.life[0] = 0.5; p.age[0] = age; p.fade[0] = 1;
}

// ───────────────────────────── 用例框架

interface EmitterSpec {
  def: VfxEmitterDef;
  kind: 'puff' | 'plate' | 'bolt';
  /** 三帧各活多少只(先多后少:缩回去的槽位走零面积) */
  alive?: [number, number, number];
  burning?: boolean;
  /** 雷:落点画面坐标 */
  at?: [number, number];
}

interface VfxCaseCfg {
  seed: number;
  emitters: EmitterSpec[];
  beams?: VfxBeamDef[];
  bolts?: VfxBoltDef[];
  lighting?: LightingCfg | null;
  /** 没有照明载荷时 NPC 那套色调融入(要受光的粒子走 tone) */
  tone?: boolean;
  depth?: { invert: boolean } | null;
  display?: DisplayTransformDef | null;
  /** 实体层里放一个实体,粒子按纵深分两桶(两张网格) */
  entitySplit?: boolean;
  /** 场景三项倍率(lit 路逐帧同步;tone 路乘在 lightGain 上) */
  factors?: { indirectFactor: number; directFactor: number; totalFactor: number };
  /** 整团退场倍率(网格 alpha) */
  instanceAlpha?: number;
  /** 光柱图案遮罩 */
  cookie?: boolean;
  /** 有 add 混合的粒子 / 雷:左右两遍(见文件头) */
  addAlpha?: boolean;
}

const FRAMES = 3;
const DT = 1 / 30;

const DISPLAY_B: DisplayTransformDef = {
  ev: 0.4, tonemap: 'reinhard', whiteKelvin: 5200, contrast: 1.15, saturation: 0.8, lift: 0.5, liftKelvin: 9000,
};
const DISPLAY_C: DisplayTransformDef = {
  ev: -0.3, tonemap: 'filmic', whiteKelvin: 7200, contrast: 0.9, saturation: 1.25, lift: 0, liftKelvin: 6500,
};

/**
 * 防「两边都没画」的假一致:有 NaN、或画上东西的像素不到 2%,都算这一侧出错。
 * (光柱的 add / screen 输出 alpha 恒 0,所以按 RGBA 任一通道计数。)
 */
function assertNonVacuous(out: Float32Array, label: string): void {
  let lit = 0;
  for (let i = 0; i < out.length; i += 4) {
    const m = Math.max(out[i], out[i + 1], out[i + 2], out[i + 3]);
    if (Number.isNaN(m)) throw new Error(`${label}:结果里有 NaN`);
    if (m > 2 / 255) lit++;
  }
  if (lit < (out.length / 4) * 0.02) throw new Error(`${label}:只有 ${lit} 个像素画上了东西(不到 2%)`);
}

async function runCase(env: ParityEnv, cfg: VfxCaseCfg): Promise<Float32Array> {
  const space = makeSpace();
  const rng = env.rng(cfg.seed);
  const anchor = space.groundWorldAtScene(96, 104);
  const effect: VfxEffectDef = {
    id: 'parity', emitters: cfg.emitters.map((s) => s.def), beams: cfg.beams, bolts: cfg.bolts,
  };
  const inst = new VfxInstanceSim('inst', effect, anchor, 20260925, space);
  for (const b of inst.beams) b.fade = 1;
  cfg.emitters.forEach((s, i) => {
    const e = inst.emitters[i];
    if (s.kind === 'puff') seedPuffs(space, e, rng);
    else if (s.kind === 'plate') seedPlates(space, e, rng, !!s.burning);
    else seedBolt(e, space.groundWorldAtScene(s.at![0], s.at![1]), 0.05);
  });

  const puffTex = puffAtlas(env);
  const paperTex = paperAtlas(env);
  const sheets = new Map<string, VfxSpriteSheet>();
  cfg.emitters.forEach((s) => {
    sheets.set(`inst/${s.def.id}`, s.kind === 'plate'
      ? { texture: paperTex, frames: PAPER_FRAMES, aspect: 0.65, frameRate: 0 }
      : { texture: puffTex, frames: PUFF_FRAMES, aspect: 1, frameRate: 0 });
  });
  const beamTextures = new Map<string, Texture>();
  if (cfg.cookie) {
    const cookie = env.dataTexture({
      width: 32, height: 32, seed: 94, scaleMode: 'linear', addressMode: 'repeat',
      fill: (x, y, c) => (c === 3 ? 1 : 0.5 + 0.5 * Math.sin(x * 0.55) * Math.cos(y * 0.35 + x * 0.1)),
    });
    for (const b of cfg.beams ?? []) if (b.cookie) beamTextures.set(`inst/${b.id}`, cookie);
  }

  const lighting = cfg.lighting ? makeLighting(env, cfg.lighting, cfg.display ?? null) : null;
  let display: UniformGroup;
  if (lighting) {
    display = lighting.displayUniforms;
  } else {
    display = createCharLightUniforms();
    applyCharDisplay(display, cfg.display ?? null);
  }
  const toneProbe = env.dataTexture({
    width: 24, height: 18, seed: 95, scaleMode: 'linear',
    fill: (x, y, c) => (c === 3 ? 1 : [0.35 + x / 30, 0.4 + y / 30, 0.7 - x / 60][c]),
  });
  const depthTex = cfg.depth ? depthTexture(env, cfg.depth.invert) : null;
  const depthCfg = {
    depth_mapping: { invert: !!cfg.depth?.invert, scale: D_SCALE, offset: D_OFFSET },
    depth_tolerance: 0.05,
  } as unknown as SceneDepthConfig;

  const root = new Container();
  if (cfg.entitySplit) {
    const ent = new Container();
    ent.position.set(100, 84);
    root.addChild(ent);
  }
  const deps: VfxRenderDeps = {
    entityLayer: root,
    createLitShader: (programs, colorTex, extra) => lighting?.createCustomLitShader(programs, colorTex, extra) ?? null,
    releaseLitShader: (sh) => lighting?.releaseEntityLitShader(sh),
    canLight: () => !!lighting?.canCreateCustomLitShader,
    getLightFactors: () => cfg.factors ?? { indirectFactor: 1, directFactor: 1, totalFactor: 1 },
    displayUniforms: display,
    getToneEnv: () => (cfg.tone
      ? {
          probe: toneProbe.source, strength: 0.85,
          key: { color: [1, 0.82, 0.62], intensity: 1.3 }, ambient: { color: [0.55, 0.65, 0.9], intensity: 0.9 },
        }
      : null),
    getDepth: () => (depthTex ? { tex: depthTex, cfg: depthCfg } : null),
    getSceneSize: () => ({ w: W, h: H }),
    perspective: (_x, y) => 0.8 + (y / H) * 0.4,
    getScreen: () => ({ w: W, h: H }),
  };
  const renderer = new VfxRenderer(deps);
  const alphas = new Map([['inst', cfg.instanceAlpha ?? 1]]);

  const rt = RenderTexture.create({ width: W, height: H, format: 'rgba8unorm', resolution: 1, antialias: false });
  try {
    for (let f = 0; f < FRAMES; f++) {
      // 帧间推进:挪粒子、改存活数、推寿命 / 燃烧 / 光柱钟
      cfg.emitters.forEach((s, i) => {
        const p = inst.emitters[i].p;
        if (s.kind === 'bolt') { p.age[0] = 0.05 + f * 0.12; return; }
        const n = s.alive?.[f] ?? p.cap;
        for (let k = 0; k < p.cap; k++) {
          p.alive[k] = k < n ? 1 : 0;
          if (f > 0) {
            p.x[k] += p.vx[k] * DT; p.y[k] += p.vy[k] * DT; p.z[k] += p.vz[k] * DT;
            p.age[k] = Math.min(p.life[k] * 0.999, p.age[k] + DT * 3);
            p.rot[k] += 0.2;
          }
        }
        const plate = inst.emitters[i].plate;
        if (plate && f > 0) for (let k = 0; k < p.cap; k++) plate.arr.bend[k] *= 0.8;
        const burn = inst.emitters[i].burn;
        if (burn && f > 0) for (let k = 0; k < p.cap; k++) if (burn.burnT[k] >= 0) burn.burnT[k] = Math.min(1, burn.burnT[k] + 0.08);
      });
      inst.time = 1.3 + f * 0.25;
      renderer.render([inst], sheets, undefined, beamTextures, alphas);
      env.renderer.render({ container: root, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
    }
    const out = await env.readTexture(rt, 'rgba8unorm');
    assertNonVacuous(out, '真实混合');
    if (!cfg.addAlpha) return out;
    // 左:真实混合;右:同一帧改 normal 混合再画;两半都 RGBA 全比(见文件头)
    for (const m of root.children) if (m instanceof Mesh && m.blendMode === 'add') m.blendMode = 'normal';
    env.renderer.render({ container: root, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
    const second = await env.readTexture(rt, 'rgba8unorm');
    assertNonVacuous(second, 'normal 混合重画');
    const both = new Float32Array(W * 2 * H * 4);
    for (let y = 0; y < H; y++) {
      both.set(out.subarray(y * W * 4, (y + 1) * W * 4), y * W * 8);
      both.set(second.subarray(y * W * 4, (y + 1) * W * 4), y * W * 8 + W * 4);
    }
    return both;
  } finally {
    renderer.clear();
    root.destroy({ children: true });
    rt.destroy(true);
  }
}

/** 给了 `produce` 框架就不调 `build`;类型上它是必填,占个位 */
function produceOnly(): never {
  throw new Error('本文件的用例走 produce()');
}

function vfxCase(name: string, cfg: VfxCaseCfg): ParityCase {
  return {
    name: `粒子 / ${name}`,
    width: cfg.addAlpha ? W * 2 : W,
    height: H,
    tolerance: 2 / 255,
    build: produceOnly,
    produce: (env) => runCase(env, cfg),
  };
}

// ───────────────────────────── 用例

const ALIVE: [number, number, number] = [26, 40, 18];

const LIT_BASE: LightingCfg = { mode: 2, skyao: true, lights: FEW_LIGHTS };

export const cases: ParityCase[] = [
  vfxCase('无光 · normal · 无深度 · 显示恒等', {
    seed: 1,
    emitters: [{ kind: 'puff', alive: ALIVE, def: puffEmitter('dust', { lit: false, tint: [1, 0.9, 0.8], alphaOverLife: [[0, 0.2], [0.4, 1], [1, 0.4]] }) }],
  }),
  vfxCase('无光 · add · 遮挡 + 软边 · 拉伸 / 镜像 · 两桶 · reinhard 显示', {
    seed: 2, depth: { invert: false }, display: DISPLAY_B, entitySplit: true, addAlpha: true,
    emitters: [{
      kind: 'puff', alive: ALIVE,
      def: puffEmitter('sparks', {
        lit: false, blend: 'add', tint: [1, 0.8, 0.55], softEdgeWu: 14, stretchByVelocity: 0.35, faceVelocity: true,
        sizeOverLife: [[0, 0.6], [1, 1.4]], tintOverLife: [[0, 1, 1, 1], [1, 0.8, 0.5, 0.3]],
      }),
    }],
  }),
  vfxCase('无光 · 反深度遮挡 · 整团退场 alpha', {
    seed: 3, depth: { invert: true }, instanceAlpha: 0.6,
    emitters: [{ kind: 'puff', alive: ALIVE, def: puffEmitter('mist', { lit: false, tint: [0.8, 0.85, 0.9], softEdgeWu: 30 }) }],
  }),
  vfxCase('tone 色调融入 · 受光强度 1.6 · filmic 显示', {
    seed: 4, tone: true, display: DISPLAY_C, depth: { invert: false },
    emitters: [{ kind: 'puff', alive: ALIVE, def: puffEmitter('smoke', { tint: [0.7, 0.68, 0.66], lightGain: 1.6 }) }],
  }),
  vfxCase('要受光没色调(uLightGain ≠ 1 那一支)· 场景倍率', {
    seed: 5, factors: { indirectFactor: 0.7, directFactor: 1, totalFactor: 0.9 },
    emitters: [{ kind: 'puff', alive: ALIVE, def: puffEmitter('smoke2', { tint: [0.9, 0.8, 0.7], lightGain: 0.8 }) }],
  }),
  vfxCase('受光 · L2 · skyao · 三盏灯 · 遮挡', {
    seed: 6, depth: { invert: false }, lighting: LIT_BASE,
    emitters: [{ kind: 'puff', alive: ALIVE, def: puffEmitter('lit', { tint: [0.85, 0.8, 0.75] }) }],
  }),
  vfxCase('受光 · L1 · 不折叠 · 无 skyao · 混合灯(点 / 聚 / 面 / 线 / 平行 / 0 强度 / count 截断)· reinhard', {
    seed: 7, display: DISPLAY_B,
    lighting: { mode: 1, fold: 0, skyao: false, eChroma: 0.6, lights: MIXED_LIGHTS, lightCount: 8 },
    emitters: [{ kind: 'puff', alive: ALIVE, def: puffEmitter('lit1', { tint: [0.9, 0.9, 0.9], emissive: 0.25, lightGain: 1.4 }) }],
  }),
  vfxCase('受光 · 八面体 8×8 · 24 盏满载 · 场景倍率 · 软边遮挡', {
    seed: 8, depth: { invert: false }, factors: { indirectFactor: 1.3, directFactor: 0.6, totalFactor: 1.1 },
    lighting: { mode: 3, binOb: 8, skyao: true, skyaoBlend: 0.6, eChroma: 1, lights: randomLights(mulberry(81), MAX_STATIC_LIGHTS) },
    emitters: [{ kind: 'puff', alive: ALIVE, def: puffEmitter('lit3', { tint: [0.8, 0.75, 0.7], softEdgeWu: 18 }) }],
  }),
  vfxCase('受光 · add(球面 0)+ normal 同批 · L4 · 八面体外的两个发射器 · filmic', {
    seed: 9, display: DISPLAY_C, addAlpha: true,
    lighting: { mode: 2, shK: 25, skyao: true, lights: FEW_LIGHTS, amb: 1.4 },
    emitters: [
      { kind: 'puff', alive: ALIVE, def: puffEmitter('embers', { blend: 'add', tint: [1, 0.6, 0.3], emissive: 0.6 }) },
      { kind: 'puff', alive: [14, 20, 10], def: puffEmitter('drops', { tint: [0.7, 0.8, 1], emissive: 0.5, stretchByVelocity: 0.2 }, 24) },
    ],
  }),
  vfxCase('受光薄片 · 燃烧(逐顶点自发光)· 混合灯 · 遮挡 · 两桶', {
    seed: 10, depth: { invert: false }, entitySplit: true,
    lighting: { mode: 2, skyao: true, lights: MIXED_LIGHTS, lightCount: 8 },
    emitters: [{ kind: 'plate', alive: [16, 24, 12], burning: true, def: plateEmitter('paper', {}) }],
  }),
  vfxCase('受光薄片 · 八面体 16×16 · 无灯 · reinhard', {
    seed: 11, display: DISPLAY_B,
    lighting: { mode: 3, binOb: 16, skyao: false, lights: [], lightCount: 0 },
    emitters: [{ kind: 'plate', alive: [16, 24, 12], def: plateEmitter('paper2', { emissive: 0.15 }) }],
  }),
  vfxCase('无光薄片(薄片网格配无光程序)· 燃烧', {
    seed: 12, depth: { invert: false },
    emitters: [{ kind: 'plate', alive: [16, 24, 12], burning: true, def: plateEmitter('paper3', { lit: false }) }],
  }),
  vfxCase('雷 · 天雷 + 地面电弧 · 遮挡', {
    seed: 13, depth: { invert: false }, bolts: [SKY_BOLT, ARC_BOLT], addAlpha: true,
    emitters: [
      { kind: 'bolt', at: [96, 118], def: boltEmitter('bolt', 'sky', { coreWu: 2.5, coreMinPx: 6, glowWu: 7, glowMinPx: 16, haloWu: 26, haloMinPx: 40, coreGain: 3, glowGain: 1, haloGain: 0.15 }) },
      { kind: 'bolt', at: [60, 110], def: boltEmitter('arcs', 'arcs', { coreWu: 1.5, coreMinPx: 4, glowWu: 5, glowMinPx: 10, coreGain: 2.2, glowGain: 0.7 }) },
    ],
  }),
  vfxCase('雷 · 只画主干 · 无深度 · 寿命色', {
    seed: 14, bolts: [SKY_BOLT], addAlpha: true,
    emitters: [{
      kind: 'bolt', at: [120, 130],
      def: boltEmitter('stroke', 'sky', { part: 'main', coreWu: 3, coreMinPx: 8, glowWu: 8, glowMinPx: 18, coreGain: 1.6, glowGain: 0.4 },
        { tintOverLife: [[0, 1, 1, 1], [1, 0.72, 0.62, 1]] }),
    }],
  }),
  vfxCase('光柱 · 3D 矩形 · add · 噪声 + 沿长度曲线 · 深度截断 + 贴地软收尾', {
    seed: 15, depth: { invert: false },
    emitters: [],
    beams: [{
      id: 'shaft', mode: '3d', blend: 'add',
      shape3d: { from: [-60, 110, 40], to: [25, 0, -15], section: { kind: 'rect', width: 34, height: 18 }, spreadDeg: [10, 6], rollDeg: 15 },
      color: [1, 0.92, 0.78], colorEnd: [1, 0.75, 0.5], intensity: 1.2,
      alongCurve: [[0, 0], [0.35, 0.6], [0.75, 1], [1, 0.9]],
      edgeSoftness: 0.5, contactSoftWu: 40, noise: { strength: 0.45, scaleWu: 30, velocity: [5, -2, 3] },
    } as VfxBeamDef],
  }),
  vfxCase('光柱 · 3D 正六边形 · screen · 图案遮罩 · 起伏 · reinhard', {
    seed: 16, depth: { invert: false }, display: DISPLAY_B, cookie: true,
    emitters: [],
    beams: [{
      id: 'hex', mode: '3d', blend: 'screen',
      shape3d: { from: [50, 120, 20], to: [-20, 0, 0], section: { kind: 'polygon', sides: 6, radius: 18 }, spreadDeg: [12, 12] },
      color: [0.8, 0.9, 1], intensity: 1.6, edgeSoftness: 0.3, thickness: 0.6, contactSoftWu: 0,
      cookie: { image: 'x', strength: 0.8, scale: [1.5, 2], offset: [0.1, 0.3], rotationDeg: 25 },
      pulse: { kind: 'breathe', hz: 0.5, amount: 0.3 },
    } as VfxBeamDef],
  }),
  vfxCase('光柱 · 2D 光带 · normal · 按深度遮挡 · 整团退场 alpha · filmic', {
    seed: 17, depth: { invert: false }, display: DISPLAY_C, instanceAlpha: 0.7,
    emitters: [],
    beams: [
      {
        id: 'band', mode: '2d', blend: 'normal',
        shape2d: { from: [-50, -90], to: [20, 10], width: [16, 44], occludeByDepth: true },
        color: [1, 0.85, 0.6], colorEnd: [0.9, 0.6, 0.4], intensity: 2.4, edgeSoftness: 0.6, contactSoftWu: 30,
        alongCurve: [[0, 0.3], [1, 1]],
      } as VfxBeamDef,
      {
        id: 'tri', mode: '3d', blend: 'add',
        shape3d: { from: [70, 90, -30], to: [40, 0, 10], section: { kind: 'polygon', sides: 3, radius: 14 }, spreadDeg: [4, 4] },
        color: [0.7, 1, 0.8], intensity: 0.9, edgeSoftness: 0, thickness: 1, contactSoftWu: 20,
      } as VfxBeamDef,
    ],
  }),
  vfxCase('光柱 + 尘埃 · 被光柱照亮的无光粒子 · 光柱与粒子同一实例', {
    seed: 18, depth: { invert: false },
    emitters: [{ kind: 'puff', alive: [30, 40, 34], def: puffEmitter('motes', { lit: false, blend: 'add', tint: [1, 0.8, 0.55], beamLit: { beam: 'lit', gain: 4 }, sizeWu: 8 }) }],
    addAlpha: true,
    beams: [{
      id: 'lit', mode: '3d', blend: 'screen',
      shape3d: { from: [-30, 120, 20], to: [10, 0, -10], section: { kind: 'rect', width: 60, height: 40 }, spreadDeg: [8, 8] },
      color: [1, 0.92, 0.78], intensity: 0.8, edgeSoftness: 0.55, contactSoftWu: 30,
    } as VfxBeamDef],
  }),
];

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
