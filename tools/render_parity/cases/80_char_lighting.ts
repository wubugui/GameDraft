/**
 * 角色受光两个程序的像素对照(「角色受光 /」):
 *   - CharacterLitSprite 的 sprite 网格程序(`createLitShader` + `LitSpriteQuad`,即
 *     `CharacterLightingSystem.createEntityLitShader` 建出来的那个):probe 底光 + 实体灯 + 显示变换 + 全部调试档;
 *   - CharacterShadingFilter(烘焙着色滤镜,`createForEntity` + 运行时逐帧驱动的那一串 setter):
 *     深度遮挡 + probe / RT 底光 + 太阳 + AO + 全部调试档。
 *
 * 全部驱动真实的运行时类与 uniform 组工厂(`createSceneLitUniforms` / `createFrameLitUniforms` /
 * `createCharLightUniforms` + `applyCharLights(packLights(..))` + `applyCharDisplay`),输入是固定种子的合成场景:
 *   - 场景 400×300 wu,载荷 work 200×150(ppu 100,俯角 40°);q → M-world 的 R(det +1)与实验室 M(det −1)
 *     差第三行反号,与运行时两个 M 的关系相同;
 *   - probe 图集(rgba16float)四种模式都备真数据:L1(4 列)、'l2' 槽 9 / 25 列、八面体 8×8 / 16×16;
 *     valid(r8)最左两层整片失效(那一片走 ambIrr 兜底)、其余随机 25% 失效;
 *   - 体素卷(RT 档)、skyao 矩、行走面 ground_d(RG16 打包进 rgba8)、角色图集与逐 texel 对齐的法线图集
 *     (两帧并排,第二帧镜像 / 放大 / 旋转着用);
 *   - 灯按作者面写 LightDef 再过真实的 packLights(点 / 聚 / 单双面面光 / 线 / 平行 / 强度 0 / 关着的灯;
 *     24 盏满载随机),显示变换走 applyCharDisplay(恒等 / reinhard / filmic 全套参数)。
 * 网格路径一次画 4 个角色(有 / 无法线图集、镜像、换帧、tint / alpha、屏幕放大、世界旋转),调试档可逐角色
 * 各挂一份 frameShade(同一个工厂建的组),一个用例看四个档。滤镜路径同样 4 个实体,各自一只滤镜。
 *
 * 几何避开两后端光栅化填充规则相反的那条缝(配方卡):四边都落在整像素上;纹理坐标落在 texel 中心,
 * 行走面 / 深度图的最近邻采样点都不压 texel 边界。每侧回读后先查「不空」(角色像素数、颜色种数),
 * 防两侧都什么也没画出来的假一致。
 *
 * 实测(无头 SwiftShader,2026-09-25):21 个用例 8 位目标**逐字节相同**(最大差 0);GL 一侧的输出与移植前
 * 源码(HEAD 版两个宿主文件)逐用例 SHA-256 相同。变异自检当场变红:probe 查表改用世界 n(0.059)、
 * 去掉网格镜像翻 n.x(0.145)、AO 纵向梯度反号(0.110)、滤镜去掉镜像翻 local u(0.157)、去掉反深度(0.431)、
 * ShadeUniforms / EntityShade 两个成员对调(0.031 / 0.322,Node 单测 charLightingWgsl.test.ts 同样变红)。
 * 容差 2/255 是 8 位目标的起步值;以后出现非零差先查翻译,不许放宽。
 */
import { Container, Rectangle, RenderTexture, Sprite, Texture, type TextureSource, UniformGroup } from 'pixi.js';
import type { ParityCase, ParityEnv } from '../harness';
import {
  applyCharDisplay, applyCharLights, createCharLightUniforms, createFrameLitUniforms, createLitShader,
  createSceneLitUniforms, LitSpriteQuad, type LitSceneStatics,
} from '@src/rendering/CharacterLitSprite';
import {
  CharacterShadingFilter, type CharShadingParams, type CharShadingSceneResources,
} from '@src/rendering/CharacterShadingFilter';
import { MAX_STATIC_LIGHTS, packLights } from '@src/rendering/lighting/lightPacking';
import type { DisplayTransformDef, LightDef, SceneDepthConfig, SceneLightingDef } from '@src/data/types';

// ───────────────────────────── 合成场景(两条路径共用)

const SW = 400;
const SH = 300;
const WORK_W = 200;
const W2W = WORK_W / SW;          // 场景 wu → work px(两轴同值)
const PPU = 100;
const CX = 100;
const CY = 75;
const THETA_DEG = 40;
const THETA = (THETA_DEG * Math.PI) / 180;
const WU_PER_Q = 150;
/** depthConfig.M.R(q → M-world,det +1):着色、skyao 用 */
const R_ROWS = rotXRows(THETA_DEG);
/** lighting.json world.M(det −1):只给 probe / 体素查表 */
const LAB_ROWS = [R_ROWS[0], R_ROWS[1], R_ROWS[2].map((v) => -v)];

const PN: [number, number, number] = [6, 5, 4];
const PROBE_COUNT = PN[0] * PN[1] * PN[2];
const PROBE_T = 8;
const PROBE_ROWS = Math.ceil(PROBE_COUNT / PROBE_T);
const W_MIN: [number, number, number] = [-1.6, -1.8, -1.8];
const W_EXT: [number, number, number] = [3.2, 3.6, 3.6];
const VOL_N: [number, number, number] = [8, 6, 5];
const VOL_TILES: [number, number] = [3, 2];
const Q_MIN: [number, number, number] = [-1.3, -1, -1.6];
const Q_MAX: [number, number, number] = [1.3, 1.2, 1.6];
const SKY_N: [number, number, number] = [5, 4, 6];
const SKY_TILES: [number, number] = [3, 2];
const G_MIN = -1.1;
const G_MAX = 1.2;
/** 行走面纹理尺寸(texel = 8 × 7.5 wu) */
const GW = 50;
const GH = 40;
/** 角色图集:两帧并排 */
const FRAME_W = 24;
const FRAME_H = 40;

function rotXRows(deg: number): [number[], number[], number[]] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}

/** 行主 → Pixi mat3x3 的列主 Float32Array */
function colMajor(rows: number[][]): Float32Array {
  return new Float32Array([rows[0][0], rows[1][0], rows[2][0], rows[0][1], rows[1][1], rows[2][1], rows[0][2], rows[1][2], rows[2][2]]);
}

/** 行走面深度(q.z):纵深随场景 y 变 + 一点起伏 */
function groundT(wx: number, wy: number): number {
  return 0.62 - 0.22 * (wy / SH) + 0.04 * Math.sin(wx * 0.05);
}
function groundDepth(wx: number, wy: number): number {
  return G_MIN + groundT(wx, wy) * (G_MAX - G_MIN);
}

function rg16(t: number): [number, number] {
  const v = Math.round(Math.max(0, Math.min(1, t)) * 65535);
  return [v >> 8, v & 255];
}

// ───────────────────────────── 输入纹理

interface SceneTextures {
  ground: Texture;
  pl1: Texture;
  pl2: Texture;
  pbin: Texture;
  valid: Texture;
  volRad: Texture;
  volEmit: Texture;
  skyao: Texture;
  color: Texture;
  nrm: Texture;
  frames: [Texture, Texture];
}

function sceneTextures(env: ParityEnv, shK: number, binOb: number): SceneTextures {
  const probe = (x: number, y: number, ncol: number) => ({ flat: y * PROBE_T + Math.floor(x / ncol), col: x % ncol });
  // 行走面:texel 中心处的场,RG16 打包(与 CharacterLightingSystem.decodeGroundPayload 同格式)
  const ground = env.dataTexture({
    width: GW, height: GH, seed: 101,
    fill: (x, y, c) => (c >= 2 ? (c === 3 ? 1 : 0) : rg16(groundT(((x + 0.5) * SW) / GW, ((y + 0.5) * SH) / GH))[c] / 255),
  });
  const pl1 = env.dataTexture({
    width: PROBE_T * 4, height: PROBE_ROWS, seed: 102, format: 'rgba16float',
    fill: (x, y, c, rng) => (c === 3 ? 1 : probe(x, y, 4).col === 0 ? 0.5 + rng() * 2 : (rng() - 0.5) * 1.6),
  });
  const pl2 = env.dataTexture({
    width: PROBE_T * shK, height: PROBE_ROWS, seed: 103 + shK, format: 'rgba16float',
    fill: (x, y, c, rng) => (c === 3 ? 1 : probe(x, y, shK).col === 0 ? 1.2 + rng() * 2.5 : (rng() - 0.5) * 1.1),
  });
  const pbin = env.dataTexture({
    width: PROBE_T * binOb * binOb, height: PROBE_ROWS, seed: 104 + binOb, format: 'rgba16float',
    fill: (_x, _y, c, rng) => (c === 3 ? 1 : 0.15 + rng() * 1.8),
  });
  // 最左两层整片失效 ⇒ 那一片的查询 8 个角全无效,走 ambIrr;其余随机 25% 失效
  const valid = env.dataTexture({
    width: PROBE_T, height: PROBE_ROWS, seed: 105, format: 'r8unorm',
    fill: (x, y, _c, rng) => {
      const flat = y * PROBE_T + x;
      if (flat >= PROBE_COUNT) return 0;
      return Math.floor(flat / (PN[1] * PN[2])) <= 1 || rng() < 0.25 ? 0 : 1;
    },
  });
  const volRad = env.dataTexture({
    width: VOL_TILES[0] * VOL_N[0], height: VOL_TILES[1] * VOL_N[1], seed: 106, format: 'rgba16float',
    fill: (_x, _y, c, rng) => (c === 3 ? (rng() < 0.3 ? 1 : 0) : rng() * 2),
  });
  const volEmit = env.dataTexture({
    width: VOL_TILES[0] * VOL_N[0], height: VOL_TILES[1] * VOL_N[1], seed: 107, format: 'rgba16float',
    fill: (_x, _y, c, rng) => (c === 3 ? 0 : rng()),
  });
  const skyao = env.dataTexture({
    width: SKY_TILES[0] * SKY_N[0], height: SKY_TILES[1] * SKY_N[1], seed: 108, format: 'rgba16float',
    // a0 取得偏低:V 落满 0..1,色带档五种颜色都出得来
    fill: (_x, _y, c, rng) => (c === 0 ? 0.05 + rng() * 0.6 : (rng() - 0.5) * 0.5),
  });
  // 角色图集(预乘):椭圆身形 + 半透明边 + 一块 alpha≈0.02 的洞(discard)+ 一块半透明衣摆
  const color = env.dataTexture({
    width: FRAME_W * 2, height: FRAME_H, seed: 109, scaleMode: 'linear', alphaMode: 'premultiplied-alpha',
    fill: (x, y, c, rng) => {
      const lx = x % FRAME_W, f = Math.floor(x / FRAME_W);
      const e = Math.hypot((lx + 0.5 - 12) / 11.2, (y + 0.5 - 20.5) / 19.6);
      let a = e < 0.82 ? 1 : e < 1 ? 0.3 + 0.6 * rng() : 0;
      if (Math.hypot(lx - 8 - f * 6, y - 14) < 2.2) a = 0.02;
      if (y > 30 && lx > 13 && e < 1) a = Math.min(a, 0.55);
      if (c === 3) return a;
      const base = [[0.86, 0.62, 0.44], [0.45, 0.62, 0.88]][f][c];
      return base * (0.55 + 0.45 * rng()) * a;
    },
  });
  // 法线图集:与颜色逐 texel 对齐(同一套 UV);a = 鼓包量
  const nrm = env.dataTexture({
    width: FRAME_W * 2, height: FRAME_H, seed: 110, scaleMode: 'linear',
    fill: (x, y, c, rng) => {
      const lx = x % FRAME_W, f = Math.floor(x / FRAME_W);
      if (c === 0) return 0.5 + 0.34 * Math.sin(0.43 * lx + 1.3 * f) + 0.08 * (rng() - 0.5);
      if (c === 1) return 0.5 + 0.3 * Math.cos(0.21 * y + f) + 0.08 * (rng() - 0.5);
      if (c === 2) return 0.3 + 0.65 * rng();
      return 0.15 + 0.85 * rng();
    },
  });
  const frames: [Texture, Texture] = [
    new Texture({ source: color.source, frame: new Rectangle(0, 0, FRAME_W, FRAME_H) }),
    new Texture({ source: color.source, frame: new Rectangle(FRAME_W, 0, FRAME_W, FRAME_H) }),
  ];
  return { ground, pl1, pl2, pbin, valid, volRad, volEmit, skyao, color, nrm, frames };
}

/** 载荷里除纹理外的那一份(网格路径的 LitSceneStatics 与滤镜的 CharShadingSceneResources 同源同值) */
function payloadStatics(env: ParityEnv, shK: number, binOb: number, lightCount: number) {
  const rng = env.rng(111);
  const ambSH = new Float32Array(27);
  for (let i = 0; i < 27; i++) ambSH[i] = i < 3 ? 0.7 + rng() * 0.5 : (rng() - 0.35) * 0.6;
  const lightsQ = new Float32Array(192), lightsE = new Float32Array(192);
  for (let i = 0; i < 48; i++) {
    lightsQ.set([(rng() - 0.5) * 2.2, (rng() - 0.5) * 1.8, (rng() - 0.5) * 2.6, 0.01 + rng() * 0.05], i * 4);
    lightsE.set([rng() * 6, rng() * 6, rng() * 6, 0], i * 4);
  }
  return {
    worldToWorkX: W2W, worldToWorkY: W2W,
    cal: { ppu: PPU, cx: CX, cy: CY, theta: THETA },
    vol: { nx: VOL_N[0], ny: VOL_N[1], nz: VOL_N[2], tilesX: VOL_TILES[0], tilesY: VOL_TILES[1], qMin: Q_MIN, qMax: Q_MAX },
    mCol: colMajor(LAB_ROWS),
    wMin: W_MIN,
    wScale: [(PN[0] - 1) / W_EXT[0], (PN[1] - 1) / W_EXT[1], (PN[2] - 1) / W_EXT[2]] as [number, number, number],
    pn: PN,
    probeT: PROBE_T,
    shK,
    binOb,
    ambSH,
    lightsQ,
    lightsE,
    lightCount,
    workW: WORK_W,
    workH: WORK_W * (SH / SW),
  };
}

function skyaoPayload(tex: Texture) {
  return {
    tex: tex.source,
    n: SKY_N,
    tiles: SKY_TILES,
    wMin: [-1.8, -1.8, -1.8] as [number, number, number],
    wScale: [1 / 3.6, 1 / 3.6, 1 / 3.6] as [number, number, number],
    // skyao 是 det=+1 那套(depthConfig.M.R)烘的,不是 probe 的 M
    mCol: colMajor(R_ROWS),
  };
}

// ───────────────────────────── 灯 / 显示变换(作者面,走真实的 packLights / applyCharDisplay)

/** 世界 wu,M-world;角色的 P 大致在 |x| ≤ 150、|y| ≤ 170、|z| ≤ 160,正面朝 −Z */
const MIXED_LIGHTS: LightDef[] = [
  { id: 'p1', kind: 'point', pos: [-120, 80, -180], color: [1, 0.78, 0.55], intensity: 1.1, range: 520, softeningRadius: 25 },
  { id: 's1', kind: 'spot', pos: [140, 160, -170], dir: [-0.45, -0.55, 0.7], innerAngleDeg: 18, outerAngleDeg: 42, kelvin: 3400, intensity: 2.2, range: 600 },
  { id: 'a1', kind: 'area', pos: [0, 40, -260], orientation: [0, 0, 1], size: [220, 140], rollDeg: 25, color: [0.7, 0.85, 1], intensity: 6 },
  { id: 'a2', kind: 'area', pos: [230, 0, -60], orientation: [-1, 0.1, -0.3], size: [120, 180], twoSided: true, color: [1, 0.5, 0.4], intensity: 5 },
  { id: 'l1', kind: 'line', pos: [-220, 220, -120], to: [-90, -60, -160], color: [0.8, 0.85, 1], intensity: 0.6, range: 650 },
  { id: 'd1', kind: 'directional', elevationDeg: 30, azimuthDeg: 200, color: [0.55, 0.65, 1], intensity: 0.35 },
  // 强度 0:灯循环里直接跳过;关着的灯:packLights 不打进包
  { id: 'z0', kind: 'point', pos: [0, 0, -100], intensity: 0 },
  { id: 'off', kind: 'point', pos: [0, 0, -100], intensity: 50, enabled: false },
];

function randomLights(env: ParityEnv, n: number): LightDef[] {
  const rng = env.rng(121);
  const kinds = ['point', 'spot', 'area', 'directional', 'line'] as const;
  const out: LightDef[] = [];
  for (let i = 0; i < n; i++) {
    const kind = kinds[Math.floor(rng() * kinds.length)];
    const pos: [number, number, number] = [(rng() - 0.5) * 500, (rng() - 0.3) * 400, -60 - rng() * 300];
    const color: [number, number, number] = [0.4 + rng() * 0.6, 0.4 + rng() * 0.6, 0.4 + rng() * 0.6];
    const l: LightDef = { id: `r${i}`, kind, pos, color, intensity: 0.05 + rng() * 0.25, range: 250 + rng() * 400 };
    if (kind === 'spot') {
      Object.assign(l, { dir: [-pos[0] / 300, -pos[1] / 300, 1], innerAngleDeg: 10 + rng() * 20, outerAngleDeg: 35 + rng() * 20 });
    } else if (kind === 'area') {
      Object.assign(l, { orientation: [(rng() - 0.5) * 0.6, (rng() - 0.5) * 0.6, 1], size: [60 + rng() * 150, 60 + rng() * 150],
        rollDeg: rng() * 90, twoSided: rng() < 0.5, intensity: 0.4 + rng() * 1.5 });
    } else if (kind === 'directional') {
      Object.assign(l, { elevationDeg: 10 + rng() * 60, azimuthDeg: 120 + rng() * 120, intensity: 0.03 + rng() * 0.08 });
    } else if (kind === 'line') {
      Object.assign(l, { to: [pos[0] + (rng() - 0.5) * 300, pos[1] - 100 - rng() * 200, pos[2] + (rng() - 0.5) * 100] });
    }
    out.push(l);
  }
  return out;
}

const DISPLAY_REINHARD: DisplayTransformDef = {
  ev: 0.8, tonemap: 'reinhard', whiteKelvin: 5200, saturation: 0.7, contrast: 1.2, lift: 0.4, liftKelvin: 9000,
};
const DISPLAY_FILMIC: DisplayTransformDef = {
  ev: 1.6, tonemap: 'filmic', whiteKelvin: 7500, saturation: 1.3, contrast: 0.85, lift: 0.1, liftKelvin: 3000,
};

function lightGroup(lights: LightDef[] | null, display: DisplayTransformDef | null): UniformGroup {
  const g = createCharLightUniforms();
  // 与 SceneLightingPass 同一次打包的结果(这里直接打一次);没有灯 = 关组
  const packed = lights ? packLights({ lights } as unknown as SceneLightingDef, WU_PER_Q) : null;
  if (packed && packed.count > MAX_STATIC_LIGHTS) throw new Error('灯数超上限');
  applyCharLights(g, packed, lights ? R_ROWS : null, WU_PER_Q);
  applyCharDisplay(g, display);
  return g;
}

// ───────────────────────────── uniform 组小工具

type UVal = number | readonly number[];

function setUniforms(g: UniformGroup, vals: Record<string, UVal>): void {
  const u = g.uniforms as Record<string, unknown>;
  for (const [k, v] of Object.entries(vals)) {
    if (!(k in u)) throw new Error(`uniform 组里没有 ${k}`);
    if (typeof v === 'number') u[k] = v;
    else (u[k] as Float32Array).set(v);
  }
  g.update();
}

/** frameShade 的「正常受光」基准值(CharacterLightingSystem.syncFrame 写的那一套,取非缺省值) */
const FRAME_BASE: Record<string, UVal> = {
  uWCPos: [3, -2], uWCScale: 1.1,
  uSpp: 8, uMSteps: 40, uFold: 1, uMissMode: 0, uNEE: 0, uStep: 0.9,
  uBeta: 1.6, uIndirectFactor: 0.9, uDirectFactor: 1.15, uTotalFactor: 0.8, uAmbStrength: 0.8,
  uBulge: 0.22, uFlatten: 0.15, uShowN: 0, uEOnly: 0, uGiStrength: 1.2, uFixedNQ: 0, uEChecker: 0,
  uSunOn: 0, uSunDirQ: [0.31, 0.8, -0.51], uSunColor: [0.9, 0.8, 0.6], uEChroma: 0.6,
  uAOContact: 0.4, uAOForm: 0.25, uSkyaoBlend: 0.8,
};

// ───────────────────────────── 回读 + 不空检查

const TOL8 = 2 / 255;
const GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];

async function renderAndRead(env: ParityEnv, root: Container, w: number, h: number, minPixels: number, minColors: number,
  label: string): Promise<Float32Array> {
  const rt = RenderTexture.create({ width: w, height: h, format: 'rgba8unorm', resolution: 1, antialias: false });
  try {
    env.renderer.render({ container: root, target: rt, clear: true, clearColor: GREY });
    const data = await env.readTexture(rt, 'rgba8unorm');
    // 不空:画出来的角色像素够多、颜色够杂(纹理没绑上 / 分支没进 / 管线没画都会塌成一两种颜色)
    const colors = new Set<number>();
    let drawn = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = Math.round(data[i] * 255), g = Math.round(data[i + 1] * 255), b = Math.round(data[i + 2] * 255);
      if (r === 128 && g === 128 && b === 128) continue;
      drawn++;
      colors.add((r << 16) | (g << 8) | b);
    }
    if (drawn < minPixels || colors.size < minColors) {
      throw new Error(`${label}:画面近乎空白(角色像素 ${drawn} < ${minPixels} 或颜色 ${colors.size} 种 < ${minColors})`);
    }
    return data;
  } finally {
    root.destroy({ children: true });
    rt.destroy(true);
  }
}

// ───────────────────────────── A. sprite 网格程序(LitSpriteQuad + createLitShader)

const L_W = 176;
const L_H = 100;

interface QuadSpec {
  frame: 0 | 1;
  /** 脚点在对照目标上的像素位置(锚点 = 底中) */
  screen: [number, number];
  screenScale?: number;
  mirror?: boolean;
  /** 世界脚点(场景 wu) */
  foot: [number, number];
  /** 每帧像素多少 wu */
  worldScale: number;
  rot?: number;
  normals?: boolean;
  tint?: number;
  alpha?: number;
  /** 这个角色单独一份 frameShade(基准 + 用例覆盖 + 这里的覆盖) */
  frame2?: Record<string, UVal>;
}

/**
 * 缺省四个角色:A 贴着场景左缘(一部分落进整片失效的 probe 层)、B 镜像 + 换帧 + tint、
 * C 没有法线图集(平面法线)+ alpha、D 换帧 + 屏幕放大 1.25 + 世界旋转。
 * 世界脚点的行走面采样点都不压 texel 边界(x·50/400、y·40/300 都不是整数)。
 */
const QUADS: QuadSpec[] = [
  { frame: 0, screen: [22, 92], foot: [18, 251], worldScale: 1.8 },
  { frame: 1, screen: [66, 92], mirror: true, foot: [151, 187], worldScale: 1.8, tint: 0xffe8d0 },
  { frame: 0, screen: [110, 92], foot: [252, 143], worldScale: 1.6, normals: false, alpha: 0.85 },
  { frame: 1, screen: [154, 92], screenScale: 1.25, foot: [337, 229], worldScale: 2.2, rot: 0.12 },
];

interface LitCfg {
  mode: 0 | 1 | 2 | 3;
  shK?: 9 | 25;
  binOb?: 8 | 16;
  skyao?: boolean;
  /** 烘焙期反解的光源 surfel 数(只 RT 档的 NEE 用) */
  rtLights?: number;
  frame?: Record<string, UVal>;
  lights?: LightDef[] | ((env: ParityEnv) => LightDef[]) | null;
  display?: DisplayTransformDef | null;
  quads?: QuadSpec[];
  /** 逐角色覆盖(与 quads 下标对应) */
  perQuad?: (Record<string, UVal> | undefined)[];
  maxBadPixels?: number;
}

function litCase(name: string, cfg: LitCfg): ParityCase {
  return {
    name: `角色受光 / 网格 · ${name}`,
    width: L_W,
    height: L_H,
    tolerance: TOL8,
    maxBadPixels: cfg.maxBadPixels ?? 0,
    build: () => { throw new Error('本文件的用例走 produce()'); },
    async produce(env) {
      const shK = cfg.shK ?? 9, binOb = cfg.binOb ?? 8;
      const tex = sceneTextures(env, shK, binOb);
      const statics: LitSceneStatics = {
        ...payloadStatics(env, shK, binOb, cfg.rtLights ?? 0),
        groundMin: G_MIN, groundMax: G_MAX, sceneWorldW: SW, sceneWorldH: SH,
        skyao: cfg.skyao === false ? null : skyaoPayload(tex.skyao),
      };
      const scene = createSceneLitUniforms(statics);
      const frameValues = { ...FRAME_BASE, uMode: cfg.mode, ...(cfg.frame ?? {}) };
      const frame = createFrameLitUniforms();
      setUniforms(frame, frameValues);
      const lights = typeof cfg.lights === 'function' ? cfg.lights(env) : cfg.lights ?? null;
      const lg = lightGroup(lights, cfg.display ?? null);
      const root = new Container();
      const quads = cfg.quads ?? QUADS;
      quads.forEach((q, i) => {
        const own = q.frame2 ?? cfg.perQuad?.[i];
        let fg = frame;
        if (own) {
          fg = createFrameLitUniforms();
          setUniforms(fg, { ...frameValues, ...own });
        }
        const sh = createLitShader(scene, fg, lg, {
          colorTex: tex.color.source,
          nrm: q.normals === false ? null : tex.nrm.source,
          ground: tex.ground.source,
          atlasL1: tex.pl1.source, atlasL2: tex.pl2.source, atlasBin: tex.pbin.source,
          valid: tex.valid.source, volRad: tex.volRad.source, volEmit: tex.volEmit.source,
          skyao: cfg.skyao === false ? null : tex.skyao.source,
        });
        const quad = new LitSpriteQuad(sh);
        quad.sync(tex.frames[q.frame], FRAME_W, FRAME_H, 0.5, 1);
        const ws = q.worldScale;
        quad.setWorldTransform(q.foot[0], q.foot[1], 1, 1, 0, 0, q.mirror ? -ws : ws, ws, q.rot ?? 0);
        const s = q.screenScale ?? 1;
        quad.mesh.position.set(q.screen[0], q.screen[1]);
        quad.mesh.scale.set(q.mirror ? -s : s, s);
        if (q.tint !== undefined) quad.mesh.tint = q.tint;
        if (q.alpha !== undefined) quad.mesh.alpha = q.alpha;
        root.addChild(quad.mesh);
      });
      return renderAndRead(env, root, L_W, L_H, 2500, 60, this.name);
    },
  };
}

const litCases: ParityCase[] = [
  litCase('L2(9 系数)· 折叠 · skyao · 混合灯(点 / 聚 / 单双面面光 / 线 / 平行 / 强度 0 / 关灯)· 显示恒等', {
    mode: 2, shK: 9, lights: MIXED_LIGHTS,
  }),
  litCase('L1 Geomerics · 不折叠 · 无 skyao 载荷 · 无灯 · reinhard 显示链(曝光 / 白平衡 / 饱和 / 对比 / 暗部提升)', {
    mode: 1, skyao: false, lights: null, display: DISPLAY_REINHARD, frame: { uFold: 0 },
  }),
  litCase('L4(25 系数)· 24 盏满载随机灯 · filmic 显示链 · skyao 半 blend', {
    mode: 2, shK: 25, lights: (env) => randomLights(env, MAX_STATIC_LIGHTS), display: DISPLAY_FILMIC,
    frame: { uSkyaoBlend: 0.45 },
  }),
  litCase('八面体 8×8 · 测试太阳 · eChroma 1 · 压平 0.5 · 三项倍率', {
    mode: 3, binOb: 8, lights: MIXED_LIGHTS.slice(0, 3),
    frame: { uSunOn: 1, uEChroma: 1, uFlatten: 0.5, uIndirectFactor: 0.6, uDirectFactor: 1.6, uTotalFactor: 0.7 },
  }),
  litCase('八面体 16×16 · 不折叠 · 大鼓包 · AO 关 · eChroma 0', {
    mode: 3, binOb: 16, lights: MIXED_LIGHTS.slice(3), display: DISPLAY_REINHARD,
    frame: { uFold: 0, uBulge: 1.4, uAOContact: 0, uAOForm: 0, uEChroma: 0 },
  }),
  litCase('RT gather · miss 记环境 · NEE 关 · 混合灯', {
    mode: 0, lights: MIXED_LIGHTS, frame: { uSpp: 8, uMSteps: 40, uMissMode: 0, uNEE: 0 },
  }),
  litCase('RT gather · miss 归一 · NEE 6 盏 · 不折叠', {
    mode: 0, rtLights: 6, lights: null, frame: { uSpp: 6, uMSteps: 32, uMissMode: 1, uNEE: 1, uFold: 0, uStep: 1.2 },
  }),
  litCase('调试档:法线 / skyao V(过显示链)/ skyao 查表盒 / skyao 原始矩', {
    mode: 2, lights: MIXED_LIGHTS, display: DISPLAY_REINHARD,
    perQuad: [{ uShowN: 1 }, { uShowN: 2 }, { uShowN: 3 }, { uShowN: 4 }],
  }),
  litCase('调试档:skyao 色带 / 纯 E / 纯 E + probe 棋盘 / 定法线·世界向上', {
    mode: 3, binOb: 16, lights: MIXED_LIGHTS, display: DISPLAY_FILMIC,
    // 纯 E 档压低 β:别让显示链饱和成一片白(棋盘 0.45 倍的那一半要看得出来)
    perQuad: [{ uShowN: 5 }, { uEOnly: 1, uBeta: 0.12 }, { uEOnly: 1, uEChecker: 1, uBeta: 0.12 }, { uFixedNQ: 2 }],
  }),
  litCase('取证子档:raw probeE / probe 网格坐标 / valid 角数 / 脚点 q', {
    mode: 1, lights: MIXED_LIGHTS,
    perQuad: [{ uEOnly: 2 }, { uEOnly: 3 }, { uEOnly: 4 }, { uEOnly: 5 }],
  }),
  litCase('取证子档:脚点世界 uv / 定法线·朝相机 / 无 skyao 载荷时的查表盒与色带(品红)', {
    mode: 2, shK: 25, skyao: false, lights: MIXED_LIGHTS,
    perQuad: [{ uEOnly: 6 }, { uFixedNQ: 1 }, { uShowN: 3 }, { uShowN: 5 }],
  }),
];

// ───────────────────────────── B. 烘焙着色滤镜(CharacterShadingFilter)

const F_W = 176;
const F_H = 110;
/** 世界容器(相机):位移 + 投影缩放;精灵在世界里每帧像素 2.5 wu ⇒ 屏幕上 1:1 */
const F_WC: [number, number] = [4, 2];
const F_S = 0.4;
const F_SPRITE = 2.5;
/** 场景深度图 80×60(texel = 5 wu),RG16:sceneDepth = raw·scale + offset(invert 时 raw 先取反) */
const DW = 80;
const DH = 60;
const D_SCALE = 2.6;
const D_OFFSET = -1.3;

interface Occluder { x0: number; x1: number; y0: number; y1: number; depth: number }

/** E1 左下角前面立一块(比它的脚点近 0.25 q) */
const F_OCCLUDERS: Occluder[] = [{ x0: 20, x1: 45, y0: 215, y1: 262, depth: groundDepth(45, 250) - 0.25 }];

function depthTexture(env: ParityEnv, invert: boolean): Texture {
  return env.dataTexture({
    width: DW, height: DH, seed: 131,
    fill: (x, y, c) => {
      if (c >= 2) return c === 3 ? 1 : 0;
      const wx = ((x + 0.5) * SW) / DW, wy = ((y + 0.5) * SH) / DH;
      let d = groundDepth(wx, wy);
      for (const o of F_OCCLUDERS) if (wx >= o.x0 && wx < o.x1 && wy >= o.y0 && wy < o.y1) d = o.depth;
      let raw = (d - D_OFFSET) / D_SCALE;
      if (invert) raw = 1 - raw;
      return rg16(raw)[c] / 255;
    },
  });
}

function depthCfg(invert: boolean, explicitGradient: number | null, floorOffset: number): SceneDepthConfig {
  return {
    depth_map: 'raw_depth_rg.png',
    collision_map: 'collision.png',
    M: { R: R_ROWS, ppu: PPU, cx: CX, cy: CY },
    depth_mapping: { invert, scale: D_SCALE, offset: D_OFFSET },
    // 旧数据缺 shader.depth_per_sy 时滤镜从 M 现推 tanθ/ppu(类型上是必填,运行时按缺省兜)
    shader: (explicitGradient !== null ? { depth_per_sy: explicitGradient } : undefined) as SceneDepthConfig['shader'],
    depth_tolerance: 0.05,
    floor_offset: floorOffset,
  };
}

/** F2「全量可调」参数(applyParams 的输入),正常受光的一组非缺省值 */
const F_PARAMS: CharShadingParams = {
  indirectFactor: 0.9, directFactor: 1.2, totalFactor: 0.75,
  mode: 2, spp: 8, step: 0.9, msteps: 40, fold: true, missMode: false, nee: false,
  beta: 0.6, giStrength: 1.1, ambStrength: 0.8, bulge: 0.3, flatten: 0.1, heightScale: 1,
  showNormals: false, sunEnabled: false, sunAzimuthDeg: 30, sunElevationDeg: 50, sunIntensity: 0.8, sunColor: [1, 0.9, 0.75],
};

interface FilterEntity {
  foot: [number, number];
  frame: 0 | 1;
  flip?: boolean;
  normals?: boolean;
  /** false = 本帧没拿到脚点深度(整段遮挡跳过) */
  footDepth?: boolean;
  blend?: number;
  floorOffsetExtra?: number;
  debug?: boolean;
  /** applyDebugState(showN, eOnly, eChecker, skyaoBlend, fixedNQ) */
  debugState?: [number, number, number, number, number];
  eChroma?: number;
  ao?: [number, number];
  params?: Partial<CharShadingParams>;
}

/**
 * 屏幕脚点 = F_WC + foot·F_S,都落在整像素上(foot 取 2.5 的倍数);E1 左下角被 F_OCCLUDERS 挡住。
 * 深度图最近邻采样点 (sx+0.5−4)/0.4 永远不是 5 的倍数 ⇒ 不压 texel 边界。
 */
const F_FEET: [number, number][] = [[45, 250], [160, 200], [275, 245], [370, 180]];

interface FilterCfg {
  mode: 0 | 1 | 2 | 3;
  shK?: 9 | 25;
  binOb?: 8 | 16;
  skyao?: boolean;
  rtLights?: number;
  depth: 'none' | 'normal' | 'invert';
  /** null = 从 depthConfig.M 现推深度梯度 */
  gradient?: number | null;
  floorOffset?: number;
  params?: Partial<CharShadingParams>;
  entities: FilterEntity[];
  maxBadPixels?: number;
}

function filterCase(name: string, cfg: FilterCfg): ParityCase {
  return {
    name: `角色受光 / 滤镜 · ${name}`,
    width: F_W,
    height: F_H,
    tolerance: TOL8,
    maxBadPixels: cfg.maxBadPixels ?? 0,
    build: () => { throw new Error('本文件的用例走 produce()'); },
    async produce(env) {
      const shK = cfg.shK ?? 9, binOb = cfg.binOb ?? 8;
      const tex = sceneTextures(env, shK, binOb);
      const scene: CharShadingSceneResources = {
        ...payloadStatics(env, shK, binOb, cfg.rtLights ?? 0),
        atlasL1: tex.pl1.source, atlasL2: tex.pl2.source, atlasBin: tex.pbin.source,
        valid: tex.valid.source, volRad: tex.volRad.source, volEmit: tex.volEmit.source,
        skyao: cfg.skyao === false ? null : skyaoPayload(tex.skyao),
      };
      const depthOn = cfg.depth !== 'none';
      const invert = cfg.depth === 'invert';
      const dtex = depthOn ? depthTexture(env, invert) : null;
      const dcfg = depthOn ? depthCfg(invert, cfg.gradient === undefined ? Math.tan(THETA) / PPU * 1.07 : cfg.gradient, cfg.floorOffset ?? 0) : null;
      const root = new Container();
      const world = new Container();
      world.position.set(F_WC[0], F_WC[1]);
      world.scale.set(F_S);
      root.addChild(world);
      cfg.entities.forEach((e) => {
        const [fx, fy] = e.foot;
        const f = CharacterShadingFilter.createForEntity({ depthTexture: dtex, cfg: dcfg, scene });
        // SceneDepthSystem.createBakedFilterForEntity + 逐帧驱动(updatePerFrame)那一串
        f.setSceneSize(SW, SH);
        f.setWorldToPixel(W2W, W2W);
        f.setProjectionScale(F_S);
        f.setWorldContainerPos(F_WC[0], F_WC[1]);
        f.setEntityFootX(fx);
        f.setEntityFootY(fy);
        f.setOcclusionBlendFactor(e.blend ?? 0.3);
        f.setFootBias(0.045);
        if (e.floorOffsetExtra !== undefined) f.setFloorOffsetExtra(e.floorOffsetExtra);
        const d = groundDepth(fx, fy);
        f.setFootDepthQ(e.footDepth === false ? null : d);
        if (e.debug) f.setDebug(true);
        f.setAO(...(e.ao ?? [0.4, 0.25]));
        // CharacterLightingSystem.driveFilter 那一串
        const wWorld = FRAME_W * F_SPRITE, hWorld = FRAME_H * F_SPRITE;
        const params = { ...F_PARAMS, mode: cfg.mode, ...(cfg.params ?? {}), ...(e.params ?? {}) };
        f.setFootQ((fx * W2W - CX) / PPU, (CY - fy * W2W) / PPU, d);
        f.setCharSize((wWorld * W2W) / PPU, ((hWorld * W2W) / Math.max(Math.cos(THETA) * PPU, 1e-6)) * params.heightScale);
        const hasNrm = e.normals !== false;
        f.setNormalFrame(hasNrm ? [e.frame * 0.5, 0, 0.5, 1] : null, !!e.flip);
        f.setSpriteWorldRect(fx - wWorld / 2, fy - hWorld, wWorld, hWorld);
        f.setNormalTexture(hasNrm ? tex.nrm.source : null);
        f.applyParams(params);
        const ds = e.debugState ?? [0, 0, 0, 0.8, 0];
        f.applyDebugState(...ds);
        f.setEChroma(e.eChroma ?? 0.6);

        const entity = new Container();
        const sprite = new Sprite(tex.frames[e.frame]);
        sprite.anchor.set(0.5, 1);
        sprite.scale.set(e.flip ? -F_SPRITE : F_SPRITE, F_SPRITE);
        entity.addChild(sprite);
        entity.position.set(fx, fy);
        entity.filters = [f];
        world.addChild(entity);
      });
      return renderAndRead(env, root, F_W, F_H, 1800, 50, this.name);
    },
  };
}

const ents = (over: (Partial<FilterEntity> | undefined)[]): FilterEntity[] =>
  F_FEET.map((foot, i) => ({ foot, frame: (i % 2) as 0 | 1, ...(over[i] ?? {}) }));

const filterCases: ParityCase[] = [
  filterCase('L2 · 深度遮挡 blend 0.3(E1 左下角)· 法线图集 · 镜像 · AO', {
    mode: 2, depth: 'normal',
    entities: ents([{}, { flip: true }, { ao: [0.7, 0.1] }, { flip: true, blend: 0.6 }]),
  }),
  filterCase('八面体 16×16 · 无深度 · 测试太阳 · eChroma 1 · skyao 半 blend · 三项倍率', {
    mode: 3, binOb: 16, depth: 'none',
    params: { sunEnabled: true, sunAzimuthDeg: 250, sunElevationDeg: 35, indirectFactor: 0.6, directFactor: 1.8, totalFactor: 0.6 },
    entities: ents([{ eChroma: 1, debugState: [0, 0, 0, 0.45, 0] }, { flip: true, eChroma: 1 }, { eChroma: 0 }, { debugState: [0, 0, 0, 0, 0] }]),
  }),
  filterCase('L1 · 反深度 · blend 0 → discard · 无法线图集(平面)· 深度梯度从 M 现推 · floor 偏移', {
    mode: 1, depth: 'invert', gradient: null, floorOffset: 0.02,
    params: { fold: false, flatten: 0.4, bulge: 0.6 },
    entities: ents([{ blend: 0, normals: false }, { normals: false, floorOffsetExtra: 0.01 }, { flip: true }, { normals: false, flip: true }]),
  }),
  filterCase('L4(25 系数)· 没有脚点深度 → 整段不遮挡 · 无 skyao 载荷 · 放大曝光', {
    mode: 2, shK: 25, depth: 'normal', skyao: false,
    params: { beta: 1.4, totalFactor: undefined, giStrength: 0.8 },
    entities: ents([{ footDepth: false }, { footDepth: false, flip: true }, {}, {}]),
  }),
  filterCase('RT gather · miss 归一 · NEE 6 盏 · 不折叠', {
    mode: 0, rtLights: 6, depth: 'normal',
    params: { spp: 6, msteps: 32, missMode: true, nee: true, fold: false, step: 1.1 },
    entities: ents([{}, { flip: true }, {}, {}]),
  }),
  filterCase('RT gather · miss 记环境 · NEE 关', {
    mode: 0, depth: 'none',
    params: { spp: 8, msteps: 40, missMode: false, nee: false },
    entities: ents([{}, {}, { flip: true }, {}]),
  }),
  filterCase('调试色(遮挡红 / 不遮挡蓝)', {
    mode: 2, depth: 'normal',
    entities: ents([{ debug: true }, { debug: true }, {}, { debug: true, footDepth: false }]),
  }),
  filterCase('调试档:法线 / skyao 灰度 / skyao 查表盒 / skyao 原始矩', {
    mode: 3, depth: 'normal',
    entities: ents([
      { debugState: [1, 0, 0, 0.8, 0], flip: true }, { debugState: [2, 0, 0, 0.8, 0] },
      { debugState: [3, 0, 0, 0.8, 0] }, { debugState: [4, 0, 0, 0.8, 0] },
    ]),
  }),
  filterCase('调试档:skyao 色带 / 纯 E / 纯 E + probe 棋盘 / 定法线(朝相机、世界向上)', {
    mode: 2, depth: 'normal',
    entities: ents([
      // 纯 E 档压低 β(uBeta = 2^β):别让 lin2srgb 饱和成一片白
      { debugState: [5, 0, 0, 0.8, 0] }, { debugState: [0, 1, 0, 0.8, 0], params: { beta: -1.8 } },
      { debugState: [0, 1, 1, 0.8, 1], params: { beta: -1.8 } }, { debugState: [0, 0, 0, 0.8, 2] },
    ]),
  }),
  filterCase('无 skyao 载荷时的调试档(品红)+ applyParams 的法线档', {
    mode: 1, depth: 'none', skyao: false,
    entities: ents([
      { debugState: [3, 0, 0, 0.8, 0] }, { debugState: [5, 0, 0, 0.8, 0] },
      { debugState: [4, 0, 0, 0.8, 0] }, { params: { showNormals: true }, debugState: [1, 0, 0, 0.8, 0] },
    ]),
  }),
];

export const cases: ParityCase[] = [...litCases, ...filterCases];
