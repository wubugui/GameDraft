/**
 * 实体受光三件的像素对照:
 *   - EntityShadow 的两个网格程序:planar 投影剪影(cast)、胶囊接触 AO(contact);
 *   - DepthOcclusionFilter(深度遮挡滤镜);
 *   - EntityLightingFilter(实体光照滤镜:遮挡 + probe 色调 + sprite 空间 AO)。
 *
 * 全部驱动真实的运行时类(`PlanarEntityShadow.update` / 滤镜的 setter),输入是固定种子的合成场景:
 *   - 剪影图集:画布(footprintOf 要在 CPU 上读像素),两帧并排,第二帧整块不透明——剪影采样越出帧框就会被抓到;
 *   - 场景深度 / 行走面深度:按运行时口径 RG16 打包进 rgba8(d = min + (r·256 + g)/65535 · (max − min)),nearest;
 *   - 碰撞格:世界 XZ 网格,r > 0.5 为墙;
 *   - 相机:45° 俯角(与茶馆同一个 R),ppu 100。
 * 对照目标 1 px = 1 场景 wu(阴影网格),滤镜那几条再套一层「世界容器」平移 + 缩放,与游戏里同构。
 */
import { CanvasSource, Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { ParityCase, ParityEnv } from '../harness';
import { PlanarEntityShadow } from '@src/rendering/EntityShadow';
import type { ContactAoParams, ShadowSceneContext, ShadowShapeParams, ShadowSource } from '@src/rendering/entityShadowTypes';
import type { ResolvedLightEnv } from '@src/rendering/lightEnv';
import { resolveContactAo } from '@src/rendering/contactAo';
import { clampAoElevation, type ContactAoSource } from '@src/rendering/contactAoSources';
import { DepthOcclusionFilter } from '@src/rendering/DepthOcclusionFilter';
import { EntityLightingFilter } from '@src/rendering/EntityLightingFilter';
import type { SceneDepthConfig } from '@src/data/types';

// ───────────────────────────── 合成场景

const SCENE_W = 160;
const SCENE_H = 120;
/** 场景 wu → native px */
const W2P = 2;
const PPU = 100;
const CX = 160;
const CY = 120;
const C45 = Math.SQRT1_2;
/** q → M-world(行主序),45° 俯角 */
const R = [
  [1, 0, 0],
  [0, C45, -C45],
  [0, C45, C45],
];
const G_MIN = -1.3;
const G_MAX = 1.3;
/** 行走面场 work 尺寸:1 纹素 = 4 场景 wu */
const WORK_W = 40;
const WORK_H = 30;
/** 场景深度图尺寸:1 纹素 = 2 场景 wu */
const DEPTH_W = 80;
const DEPTH_H = 60;
const D_SCALE = 2.6;
const D_OFFSET = -1.3;
/** 碰撞网格(世界 XZ) */
const COL_X_MIN = -1.6;
const COL_Z_MIN = -1.8;
const COL_CELL = 0.1;
const COL_W = 32;
const COL_H = 36;
/** 1 q = 多少 wu(角色高约 150 wu 的量级) */
const WU_PER_Q = 110;

interface Rect { x0: number; x1: number; y0: number; y1: number }

/** 场景 (wx, wy) 处行走面的深度 q.z:45° 平地 d = py,再叠一点起伏(不是纯平面,双线性 / 最近取样才分得出来) */
function groundDepth(wx: number, wy: number): number {
  const py = (CY - wy * W2P) / PPU;
  return py + 0.03 * Math.sin(wx * 0.15) + 0.02 * Math.cos(wy * 0.21);
}

/** 0..1 → RG16 的两个字节 */
function rg16(t: number): [number, number] {
  const v = Math.round(Math.max(0, Math.min(1, t)) * 65535);
  return [v >> 8, v & 255];
}

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
}

/** 立在地上的遮挡物:x 范围 + 底边 y(贴地处)+ 顶;整面取底边那一行的地面深度(比身后的地面近) */
interface Occluder { x0: number; x1: number; top: number; base: number }

function sceneDepthAt(wx: number, wy: number, occluders: readonly Occluder[]): number {
  for (const o of occluders) {
    if (wx >= o.x0 && wx < o.x1 && wy >= o.top && wy < o.base) return groundDepth((o.x0 + o.x1) * 0.5, o.base);
  }
  return groundDepth(wx, wy);
}

/** RG16 打包的场景深度图(与运行时 raw_depth_rg 同口径:sceneDepth = raw·scale + offset,invert 时 raw 先取反) */
function depthTexture(env: ParityEnv, occluders: readonly Occluder[], invert: boolean, w = DEPTH_W, h = DEPTH_H, sw = SCENE_W, sh = SCENE_H): Texture {
  return env.dataTexture({
    width: w, height: h, seed: 11,
    fill: (x, y, c) => {
      if (c >= 2) return c === 3 ? 1 : 0;
      const d = sceneDepthAt(((x + 0.5) * sw) / w, ((y + 0.5) * sh) / h, occluders);
      let raw = (d - D_OFFSET) / D_SCALE;
      if (invert) raw = 1 - raw;
      return rg16(raw)[c] / 255;
    },
  });
}

/** RG16 打包的行走面深度场(与 CharacterLightingSystem.decodeGroundPayload 同格式:rgba8、nearest、不预乘) */
function groundTexture(env: ParityEnv): Texture {
  return env.dataTexture({
    width: WORK_W, height: WORK_H, seed: 12,
    fill: (x, y, c) => {
      if (c >= 2) return c === 3 ? 1 : 0;
      const d = groundDepth((x + 0.5) * (SCENE_W / WORK_W), (y + 0.5) * (SCENE_H / WORK_H));
      return rg16((d - G_MIN) / (G_MAX - G_MIN))[c] / 255;
    },
  });
}

/** 碰撞格:格心(世界 XZ)按平地反投回场景 wu,落在给定矩形里就是墙 */
function collisionTexture(env: ParityEnv, walls: readonly Rect[]): Texture {
  return env.dataTexture({
    width: COL_W, height: COL_H, seed: 13,
    fill: (gx, gz, c) => {
      if (c === 3) return 1;
      if (c !== 0) return 0;
      const cwx = COL_X_MIN + (gx + 0.5) * COL_CELL;
      const cwz = COL_Z_MIN + (gz + 0.5) * COL_CELL;
      const py = cwz / (2 * C45);
      const wx = (cwx * PPU + CX) / W2P;
      const wy = (CY - py * PPU) / W2P;
      return walls.some((r) => inRect(r, wx, wy)) ? 1 : 0;
    },
  });
}

interface CtxOptions {
  occluders?: Occluder[];
  walls?: Rect[] | null;
  invert?: boolean;
  noGround?: boolean;
  tolerance?: number;
  floorOffset?: number;
  occlusionBlendFactor?: number;
}

function sceneContext(env: ParityEnv, o: CtxOptions = {}): ShadowSceneContext {
  const invert = !!o.invert;
  return {
    depthTexture: depthTexture(env, o.occluders ?? [], invert),
    collisionTexture: o.walls ? collisionTexture(env, o.walls) : null,
    sceneW: SCENE_W,
    sceneH: SCENE_H,
    worldToPixelX: W2P,
    worldToPixelY: W2P,
    invert: invert ? 1 : 0,
    scale: D_SCALE,
    offset: D_OFFSET,
    floorOffset: o.floorOffset ?? 0,
    groundTexture: o.noGround ? null : groundTexture(env).source,
    groundMin: G_MIN,
    groundMax: G_MAX,
    tolerance: o.tolerance ?? 0.05,
    occlusionBlendFactor: o.occlusionBlendFactor ?? 0.28,
    ppu: PPU,
    cx: CX,
    cy: CY,
    r00: R[0][0], r01: R[0][1], r02: R[0][2],
    r10: R[1][0], r11: R[1][1], r12: R[1][2],
    r20: R[2][0], r21: R[2][1], r22: R[2][2],
    colXMin: COL_X_MIN,
    colZMin: COL_Z_MIN,
    colCellSize: COL_CELL,
    colGridW: COL_W,
    colGridH: COL_H,
  };
}

// ───────────────────────────── 剪影图集

const FRAME_W = 24;
const FRAME_H = 40;

/** 帧 0 的剪影 alpha(0..255):头、躯干、两腿,左脚往外伸(不对称,朝向镜像才看得出);边缘带种子噪声的半透明 */
function silhouetteAlpha(x: number, y: number, rng: () => number): number {
  const cx = x + 0.5;
  const cy = y + 0.5;
  const head = Math.hypot(cx - 12, cy - 7) - 5;
  const box = (x0: number, x1: number, y0: number, y1: number) =>
    Math.max(x0 - cx, cx - x1, y0 - cy, cy - y1);
  const d = Math.min(head, box(6, 18, 12, 27), box(7, 11, 26, 39), box(13, 17, 26, 38), box(3, 11, 36, 39));
  const n = rng();
  if (d < -1) return 255;
  if (d > 1) return 0;
  return Math.round(Math.max(0, Math.min(255, (1 - (d + 1) / 2) * 255 * (0.7 + 0.3 * n))));
}

/**
 * 两帧并排的图集(画布源):帧 0 = 剪影,帧 1 = 整块不透明。返回帧 0 的纹理。
 * 画布是 footprintOf 能读的「可绘制图像」;两侧各画一遍,同一浏览器里逐字节相同。
 */
function atlasFrame(seed: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = FRAME_W * 2;
  canvas.height = FRAME_H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(FRAME_W * 2, FRAME_H);
  let s = seed >>> 0;
  const rng = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W * 2; x++) {
      const i = (y * FRAME_W * 2 + x) * 4;
      const a = x < FRAME_W ? silhouetteAlpha(x, y, rng) : 255;
      img.data[i] = 180;
      img.data[i + 1] = 120;
      img.data[i + 2] = 90;
      img.data[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  const source = new CanvasSource({ resource: canvas, resolution: 1, scaleMode: 'linear' });
  return new Texture({ source, frame: new Rectangle(0, 0, FRAME_W, FRAME_H) });
}

// ───────────────────────────── 光环境 / 阴影输入

interface EnvOptions {
  az: number;
  length?: number;
  darkness?: number;
  softness?: number;
  contact?: number;
  contactSize?: number;
}

function lightEnv(o: EnvOptions): ResolvedLightEnv {
  return {
    key: { azimuthDeg: o.az, elevationDeg: 45, color: [1, 0.95, 0.85], intensity: 1 },
    ambient: { color: [0.5, 0.55, 0.7], intensity: 1 },
    shadow: {
      mode: 'planar',
      enabled: true,
      darkness: o.darkness ?? 0.6,
      softness: o.softness ?? 0,
      length: o.length ?? 0.9,
      contact: o.contact ?? 0,
      contactSize: o.contactSize ?? 1,
      softSamples: 1,
      softRadius: 0,
      billboard: 'light',
    },
    toneStrength: 0.45,
    toneEnabled: true,
    ao: { contact: 0.45, form: 0.25 },
  };
}

function shadowSource(tex: Texture, fx: number, fy: number, facing: 1 | -1, w = 24, h = 40): ShadowSource {
  return {
    getFootX: () => fx,
    getFootY: () => fy,
    getWorldWidth: () => w,
    getWorldHeight: () => h,
    getTexture: () => tex,
    getFacing: () => facing,
    isVisible: () => true,
  };
}

/** 脚点的地面 M-world 坐标(wu),与 CONTACT_FRAG 的 groundWorldWu 同式(用解析地面,灯位只需大致对) */
function groundWorld(wx: number, wy: number): [number, number, number] {
  const px = (wx * W2P - CX) / PPU;
  const py = (CY - wy * W2P) / PPU;
  const d = groundDepth(wx, wy);
  return [0, 1, 2].map((i) => (R[i][0] * px + R[i][1] * py + R[i][2] * d) * WU_PER_Q) as [number, number, number];
}

/** 方向型一路:x/y/z = 指向光的单位向量 */
function dirSource(v: [number, number, number], weight: number): ContactAoSource {
  const n = Math.hypot(...v);
  const u: [number, number, number] = [v[0] / n, v[1] / n, v[2] / n];
  return { point: false, x: u[0], y: u[1], z: u[2], footDir: clampAoElevation(u) ?? [0, 1, 0], weight };
}

/** 灯位型一路:x/y/z = 灯位(M-world wu),逐像素朝它 */
function pointSource(foot: [number, number, number], off: [number, number, number], weight: number): ContactAoSource {
  const p: [number, number, number] = [foot[0] + off[0], foot[1] + off[1], foot[2] + off[2]];
  return { point: true, x: p[0], y: p[1], z: p[2], footDir: clampAoElevation(off) ?? [0, 1, 0], weight };
}

interface ShadowDraw {
  fx: number;
  fy: number;
  facing?: 1 | -1;
  env: EnvOptions;
  shape?: ShadowShapeParams;
  contactAo?: (fx: number, fy: number, env: ResolvedLightEnv) => ContactAoParams;
  color?: [number, number, number];
  depthParams?: [number, number, number];
}

/** 一个阴影层:每条 draw 一个 PlanarEntityShadow(真实类),用同一张剪影图集 */
function shadowScene(env: ParityEnv, ctx: ShadowSceneContext | null, draws: ShadowDraw[]): Container {
  const root = new Container();
  const tex = atlasFrame(97);
  for (const d of draws) {
    const shadow = new PlanarEntityShadow(root, ctx);
    const le = lightEnv(d.env);
    if (d.color) shadow.setShadowColor(d.color);
    if (d.depthParams) shadow.setDepthParams(...d.depthParams);
    shadow.update(shadowSource(tex, d.fx, d.fy, d.facing ?? 1), le, null, d.shape ?? null, d.contactAo?.(d.fx, d.fy, le) ?? null);
  }
  return root;
}

const GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
const TOL8 = 2 / 255;

/**
 * 遮挡物 / 墙,摆在主影子(脚点 72, 84.3,朝右上)的路径上:遮挡物盖住影子头端左半(前景 blend),
 * 碰撞墙挡住射向头端右半的射线(其后整段裁掉)。
 */
const OCCLUDERS: Occluder[] = [
  { x0: 72, x1: 86, top: 36, base: 62 },
  { x0: 30, x1: 44, top: 60, base: 96 },
];
const WALLS: Rect[] = [{ x0: 89, x1: 96, y0: 63, y1: 70 }];
/**
 * 脚点 y 取 84.3 而不是整数:头端那条水平边若落在像素中心 1/32 px 以内,SwiftShader 按 1/16 px 吸附后正好压在
 * 像素中心上,而 Pixi-WebGL 画 RT 时翻了投影,填充规则的「上边」在两侧是图上相反的两条边——那一行一侧画一侧不画
 * (光栅化约定之差,不是着色器翻译之差;2026-09-25 实测 fy=84 时头端整行差 11/255)。
 */
const MAIN_FY = 84.3;

// ───────────────────────────── 投影剪影(cast)

const castCases: ParityCase[] = [
  {
    name: '实体 / cast 剪影:无场景上下文(anim_preview 路径),右上投影',
    width: SCENE_W, height: SCENE_H, tolerance: TOL8, clearColor: GREY,
    build: (env) => shadowScene(env, null, [{ fx: 72, fy: MAIN_FY, env: { az: 125, length: 0.9, darkness: 0.7 } }]),
  },
  {
    name: '实体 / cast 剪影:前景遮挡 blend + 碰撞方向阻挡',
    width: SCENE_W, height: SCENE_H, tolerance: TOL8, clearColor: GREY,
    build: (env) => shadowScene(env, sceneContext(env, { occluders: OCCLUDERS, walls: WALLS }), [
      { fx: 72, fy: MAIN_FY, env: { az: 125, length: 0.9, darkness: 0.7 } },
    ]),
  },
  {
    name: '实体 / cast 剪影:只遮挡(无碰撞图)、反深度、点光梯形、朝左镜像',
    width: SCENE_W, height: SCENE_H, tolerance: TOL8, clearColor: GREY,
    build: (env) => shadowScene(env, sceneContext(env, { occluders: OCCLUDERS, invert: true, floorOffset: 0.02 }), [
      { fx: 70, fy: 70, facing: -1, env: { az: 200, length: 1.3, darkness: 0.8 }, shape: { spread: 1.7, widthScale: 0.55 } },
    ]),
  },
  {
    name: '实体 / cast 剪影:四个方向(含水平影 offY≈0)+ 阴影色 + 深度调参广播',
    width: SCENE_W, height: SCENE_H, tolerance: TOL8, clearColor: GREY,
    build: (env) => shadowScene(env, sceneContext(env, { occluders: OCCLUDERS, walls: WALLS }), [
      { fx: 40, fy: 40, env: { az: 0, length: 0.8, darkness: 0.9 }, color: [0.25, 0.1, 0.45] },
      { fx: 120, fy: 36, env: { az: 270, length: 0.6, darkness: 0.6 }, color: [0.1, 0.3, 0.2], depthParams: [0.02, 0.01, 0.5] },
      { fx: 60, fy: 104, env: { az: 90, length: 1.2, darkness: 0.75 }, shape: { spread: 0.6, widthScale: 1.2 } },
      { fx: 130, fy: 100, env: { az: 330, length: 1.0, darkness: 0.5 }, facing: -1, color: [0.6, 0.2, 0.1] },
    ]),
  },
  {
    name: '实体 / cast 剪影:软化(BlurFilter)+ 接触 AO 同画',
    width: SCENE_W, height: SCENE_H, tolerance: TOL8, clearColor: GREY,
    build: (env) => shadowScene(env, sceneContext(env, { occluders: OCCLUDERS, walls: WALLS }), [
      { fx: 72, fy: MAIN_FY, env: { az: 125, length: 0.9, darkness: 0.7, softness: 0.6, contact: 0.75 } },
    ]),
  },
];

// ───────────────────────────── 接触 AO(contact)

/** 作者参数 + 几路光 → ContactAoParams(与 Game.contactAoParams 同形) */
function contactParams(def: Parameters<typeof resolveContactAo>[0], sources: (foot: [number, number, number]) => ContactAoSource[]) {
  return (fx: number, fy: number, le: ResolvedLightEnv): ContactAoParams => {
    const ao = resolveContactAo(def, le.shadow);
    return { ao, sources: ao.directional ? sources(groundWorld(fx, fy)) : [], wuPerQUnit: WU_PER_Q };
  };
}

const contactCases: ParityCase[] = [
  {
    name: '实体 / contact 接触 AO:简单 AO(无方向)',
    width: SCENE_W, height: SCENE_H, tolerance: TOL8, clearColor: GREY,
    build: (env) => shadowScene(env, sceneContext(env, { occluders: OCCLUDERS }), [
      { fx: 72, fy: 84, env: { az: 125, darkness: 0, contact: 0.75 }, contactAo: contactParams({ directional: false }, () => []) },
      { fx: 36, fy: 100, facing: -1, env: { az: 125, darkness: 0, contact: 0.9, contactSize: 1.6 }, color: [0.2, 0.1, 0.3],
        contactAo: contactParams({ directional: false, spread: 0.6 }, () => []) },
    ]),
  },
  {
    name: '实体 / contact 接触 AO:方向 AO,两路平行光 + 锥角 / 拖尾调参',
    width: SCENE_W, height: SCENE_H, tolerance: TOL8, clearColor: GREY,
    build: (env) => shadowScene(env, sceneContext(env, { occluders: OCCLUDERS }), [
      { fx: 72, fy: 84, env: { az: 125, darkness: 0, contact: 0.8 },
        contactAo: contactParams({ dirConeDeg: 20, dirLength: 1.2, dirStrength: 1 }, () => [
          dirSource([1, 0.8, 0.3], 0.55),
          dirSource([-0.6, 0.5, -0.8], 0.3),
        ]) },
      { fx: 120, fy: 60, env: { az: 125, darkness: 0, contact: 0.7 },
        contactAo: contactParams({ dirConeDeg: 45 }, () => [dirSource([0.2, 3, 0.1], 1)]) },
    ]),
  },
  {
    name: '实体 / contact 接触 AO:灯位型逐像素朝灯(四路,含近顶光)+ 墙前地面判据淡出',
    width: SCENE_W, height: SCENE_H, tolerance: TOL8, clearColor: GREY,
    build: (env) => shadowScene(env, sceneContext(env, { occluders: OCCLUDERS, tolerance: 0.03 }), [
      { fx: 96, fy: 64, env: { az: 125, darkness: 0, contact: 0.85, contactSize: 1.2 },
        contactAo: contactParams({ dirLength: 0.9 }, (foot) => [
          pointSource(foot, [60, 110, -40], 0.35),
          pointSource(foot, [-80, 60, 30], 0.25),
          pointSource(foot, [2, 200, 1], 0.2),
          dirSource([0.3, 0.9, 0.9], 0.15),
        ]) },
    ]),
  },
  {
    name: '实体 / contact 接触 AO:无行走面场(平地解深度)+ cast 同画',
    width: SCENE_W, height: SCENE_H, tolerance: TOL8, clearColor: GREY,
    build: (env) => shadowScene(env, sceneContext(env, { noGround: true, walls: WALLS }), [
      { fx: 72, fy: 84, env: { az: 250, length: 0.7, darkness: 0.5, contact: 0.75 },
        contactAo: contactParams({}, () => [dirSource([0.8, 1, -0.2], 0.6)]) },
    ]),
  },
];

// ───────────────────────────── 滤镜:世界容器 + 实体精灵

const F_SCENE_W = 120;
const F_SCENE_H = 90;
/** 世界容器(相机):位移 + 投影缩放 S,与游戏里 worldContainer 同构 */
const WC_X = 6;
const WC_Y = 3;
const S = 1.25;

/** 预乘的实体精灵(rgb ≤ a);带透明边与半透明像素 */
function entitySprite(env: ParityEnv, seed: number): Texture {
  return env.dataTexture({
    width: FRAME_W, height: FRAME_H, seed, scaleMode: 'linear',
    fill: (x, y, c, rng) => {
      const inside = Math.hypot((x + 0.5 - 12) / 11, (y + 0.5 - 20) / 19.5);
      const a = inside < 0.85 ? 1 : inside < 1 ? 0.35 + 0.5 * rng() : 0;
      if (c === 3) return a;
      const base = [0.9, 0.7, 0.5][c] * (0.4 + 0.6 * rng());
      return base * a;
    },
  });
}

/** 世界容器里站一个实体精灵(脚点 = 底边中点),滤镜挂在实体上 */
function filterScene(env: ParityEnv, fx: number, fy: number, filter: DepthOcclusionFilter | EntityLightingFilter, scale = 1): Container {
  const root = new Container();
  const world = new Container();
  world.position.set(WC_X, WC_Y);
  world.scale.set(S);
  root.addChild(world);
  const entity = new Container();
  const sprite = new Sprite(entitySprite(env, 31));
  sprite.anchor.set(0.5, 1);
  sprite.scale.set(scale);
  entity.addChild(sprite);
  entity.position.set(fx, fy);
  entity.filters = [filter];
  world.addChild(entity);
  return root;
}

/** 滤镜场景的深度(场景 120×90 wu,60×45 纹素)与遮挡物:底边比脚点更靠镜头(y 更大),挡住实体左下一角 */
const F_OCCLUDERS: Occluder[] = [{ x0: 30, x1: 50, top: 20, base: 100 }];

function filterDepth(env: ParityEnv, invert: boolean): Texture {
  return depthTexture(env, F_OCCLUDERS, invert, 60, 45, F_SCENE_W, F_SCENE_H);
}

function depthCfg(invert: boolean, tolerance = 0.05, floorOffset = 0): SceneDepthConfig {
  return {
    depth_map: 'raw_depth_rg.png',
    collision_map: 'collision.png',
    M: { R, ppu: PPU, cx: CX, cy: CY },
    depth_mapping: { invert, scale: D_SCALE, offset: D_OFFSET },
    shader: { depth_per_sy: 1 / PPU },
    depth_tolerance: tolerance,
    floor_offset: floorOffset,
  };
}

interface DriveOptions {
  fx: number;
  fy: number;
  footDepth: number | null;
  blend: number;
  floorOffsetExtra?: number;
  footBias?: number;
  debug?: boolean;
}

/** 与 SceneDepthSystem / anim_preview 逐帧驱动同一组 setter */
function driveCommon(f: DepthOcclusionFilter | EntityLightingFilter, o: DriveOptions): void {
  f.setSceneSize(F_SCENE_W, F_SCENE_H);
  f.setProjectionScale(S);
  f.setWorldContainerPos(WC_X, WC_Y);
  f.setWorldToPixel(W2P, W2P);
  f.setEntityFootY(o.fy);
  f.setOcclusionBlendFactor(o.blend);
  f.setFootDepthQ(o.footDepth);
  if (o.floorOffsetExtra !== undefined) f.setFloorOffsetExtra(o.floorOffsetExtra);
  if (o.footBias !== undefined) f.setFootBias(o.footBias);
  if (o.debug) f.setDebug(true);
}

function depthFilterCase(name: string, o: DriveOptions & { invert?: boolean; scale?: number; tolerance?: number }): ParityCase {
  return {
    name, width: 170, height: 120, tolerance: TOL8,
    build(env) {
      const invert = !!o.invert;
      const f = DepthOcclusionFilter.createForEntity(filterDepth(env, invert), depthCfg(invert, o.tolerance));
      driveCommon(f, o);
      return filterScene(env, o.fx, o.fy, f, o.scale);
    },
  };
}

const depthFilterCases: ParityCase[] = [
  depthFilterCase('实体 / 深度遮挡滤镜:左下角被墙挡(blend 0.28)', {
    fx: 50, fy: 78, footDepth: groundDepth(50, 78), blend: 0.28,
  }),
  depthFilterCase('实体 / 深度遮挡滤镜:blend 0 → discard、反深度、floor 附加偏移 / 脚偏置、放大 1.5', {
    fx: 48, fy: 80, footDepth: groundDepth(48, 80), blend: 0, invert: true, floorOffsetExtra: 0.03, footBias: 0.02, scale: 1.5,
  }),
  depthFilterCase('实体 / 深度遮挡滤镜:调试色', {
    fx: 50, fy: 78, footDepth: groundDepth(50, 78), blend: 0.28, debug: true,
  }),
  depthFilterCase('实体 / 深度遮挡滤镜:没有脚点深度 → 原样', {
    fx: 50, fy: 78, footDepth: null, blend: 0.28,
  }),
  depthFilterCase('实体 / 深度遮挡滤镜:站在场景右缘(一半出界)', {
    fx: 116, fy: 60, footDepth: groundDepth(116, 60), blend: 0.5,
  }),
];

interface LightOptions extends DriveOptions {
  depth: boolean;
  invert?: boolean;
  probeLinear?: boolean;
  tone?: number;
  ao?: [number, number];
  key?: [[number, number, number], number];
  ambient?: [[number, number, number], number];
  scale?: number;
}

function lightFilterCase(name: string, o: LightOptions): ParityCase {
  return {
    name, width: 170, height: 120, tolerance: TOL8,
    build(env) {
      const invert = !!o.invert;
      const probe = env.dataTexture({
        width: 12, height: 9, seed: 41, scaleMode: o.probeLinear ? 'linear' : 'nearest',
        fill: (_x, _y, c, rng) => (c === 3 ? 1 : 0.2 + 0.8 * rng()),
      });
      const le = lightEnv({ az: 125 });
      const f = EntityLightingFilter.createForEntity({
        depthTexture: o.depth ? filterDepth(env, invert) : null,
        cfg: o.depth ? depthCfg(invert) : null,
        probeSource: probe.source,
        lightEnv: le,
        sampleLiftWorld: 16,
      });
      driveCommon(f, o);
      f.setEntityFootX(o.fx);
      if (o.key) f.setKeyLight(o.key[0], o.key[1]);
      if (o.ambient) f.setAmbient(o.ambient[0], o.ambient[1]);
      if (o.tone !== undefined) f.setTone(o.tone);
      if (o.ao) f.setAO(o.ao[0], o.ao[1]);
      return filterScene(env, o.fx, o.fy, f, o.scale);
    },
  };
}

const lightFilterCases: ParityCase[] = [
  lightFilterCase('实体 / 光照滤镜:无深度(anim_preview 路径),probe 色调 + AO', {
    fx: 50, fy: 78, footDepth: null, blend: 0, depth: false,
    tone: 0.7, ao: [0.45, 0.25], key: [[1, 0.8, 0.6], 1.4], ambient: [[0.4, 0.5, 0.9], 0.9],
  }),
  lightFilterCase('实体 / 光照滤镜:遮挡 blend + 色调(probe 线性)+ AO', {
    fx: 50, fy: 78, footDepth: groundDepth(50, 78), blend: 0.28, depth: true, probeLinear: true,
    tone: 0.5, ao: [0.6, 0.3], ambient: [[0.9, 0.6, 0.3], 1.2],
  }),
  lightFilterCase('实体 / 光照滤镜:blend 0 → discard、反深度、色调关、放大 1.5', {
    fx: 48, fy: 80, footDepth: groundDepth(48, 80), blend: 0, depth: true, invert: true,
    tone: 0, ao: [0.2, 0.5], floorOffsetExtra: 0.03, footBias: 0.02, scale: 1.5,
  }),
  lightFilterCase('实体 / 光照滤镜:调试色', {
    fx: 50, fy: 78, footDepth: groundDepth(50, 78), blend: 0.28, depth: true, debug: true,
  }),
  lightFilterCase('实体 / 光照滤镜:AO 全关、强色调(白平衡钳位)', {
    fx: 100, fy: 50, footDepth: groundDepth(100, 50), blend: 0.28, depth: true,
    tone: 1, ao: [0, 0], key: [[0.1, 0.2, 1], 3], ambient: [[1, 0.1, 0.05], 2],
  }),
];

export const cases: ParityCase[] = [...castCases, ...contactCases, ...depthFilterCases, ...lightFilterCases];
