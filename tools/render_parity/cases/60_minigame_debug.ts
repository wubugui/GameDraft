/**
 * 小游戏与调试滤镜的像素对照:
 *   - 捞水小游戏:水面滤镜 `WaterShaderFilter`(时段 × 天气 × 水底系数 × 法线扰动)、
 *     水下参数编码滤镜 `WaterParamEncodeFilter`(深度 / 发光写进参数 RT,透明处 discard);
 *   - F2 背景调试滤镜 `BackgroundDebugFilter`(透传 / 深度着色 / 碰撞 / UV 四个视图);
 *   - 物件检视接触 AO `ObjectExamineContactAoFilter`(离屏 mask 烘焙 → Pixi 模糊 → 合成,覆写了 `apply`)。
 *
 * 全部驱动真实类;输入是固定种子的合成纹理。纹理内容刻意做成**平滑的**(或按纹素中心对齐采样),
 * 这样两侧浮点运算的末位差不会被 nearest 采样 / 阈值放大成整像素的跳变 —— 容差里只剩真实的翻译差异。
 */
import { Container, Sprite, Texture, type Filter } from 'pixi.js';
import type { ParityCase, ParityEnv } from '../harness';
import { WaterShaderFilter } from '@src/systems/waterMinigame/WaterShaderFilter';
import { WaterParamEncodeFilter } from '@src/systems/waterMinigame/WaterParamEncodeFilter';
import { BackgroundDebugFilter } from '@src/rendering/BackgroundDebugFilter';
import { ObjectExamineContactAoFilter } from '@src/systems/objectExamine/contactAo';
import type { SceneDepthConfig } from '@src/data/types';

const PREFIX = '小游戏与调试 / ';
const TOL8 = 2 / 255;

// ───────────────────────────── 公用输入

/** 平滑彩色底图(已预乘);alphaHole=true 时左上角一块透明,用来测 uMinAlpha / 透明区 */
function smoothColor(env: ParityEnv, w: number, h: number, seed: number, alphaHole = false): Texture {
  return env.dataTexture({
    width: w,
    height: h,
    seed,
    scaleMode: 'linear',
    alphaMode: 'premultiplied-alpha',
    fill: (x, y, c) => {
      const a = alphaHole && x < w * 0.3 && y < h * 0.35 ? 0 : 1;
      if (c === 3) return a;
      const v =
        c === 0
          ? 0.5 + 0.4 * Math.sin(x * 0.21 + y * 0.13 + seed)
          : c === 1
            ? 0.5 + 0.4 * Math.cos(x * 0.17 - y * 0.19 + seed * 0.5)
            : 0.5 + 0.4 * Math.sin((x + y) * 0.11 - seed);
      return v * a;
    },
  });
}

function spriteRoot(tex: Texture, filters: Filter[]): Container {
  const root = new Container();
  const s = new Sprite(tex);
  s.filters = filters;
  root.addChild(s);
  return root;
}

// ───────────────────────────── 捞水:水面滤镜

/** 参数 RT 的模拟:左 1/3 是背景(b=0 走 suv.y 光程),右 2/3 是物体(b=1,r=相对深度、g=发光) */
function waterParams(env: ParityEnv, w: number, h: number): Texture {
  return env.dataTexture({
    width: w,
    height: h,
    seed: 41,
    scaleMode: 'linear',
    fill: (x, y, c) => {
      const obj = x >= w / 3;
      if (c === 0) return obj ? 0.15 + 0.8 * (y / (h - 1)) : 0;
      if (c === 1) return obj ? 0.5 + 0.5 * Math.sin(x * 0.2) : 0;
      if (c === 2) return obj ? 1 : 0;
      return obj ? (y < h * 0.5 ? 1 : 0.6) : 0;
    },
  });
}

/** 法线图:平滑 rgb,repeat 寻址(uv*2.5 会越出 0..1) */
function waterNormal(env: ParityEnv): Texture {
  return env.dataTexture({
    width: 32,
    height: 32,
    seed: 5,
    scaleMode: 'linear',
    addressMode: 'repeat',
    fill: (x, y, c) =>
      c === 3 ? 1 : c === 2 ? 1 : 0.5 + 0.45 * Math.sin(((c === 0 ? x : y) / 32) * Math.PI * 2 + c),
  });
}

interface WaterState {
  label: string;
  time: number;
  surface?: ['morning' | 'day' | 'night', 'clear' | 'rain' | 'fog'];
  bottomDepth?: number;
  normal?: boolean;
  params?: boolean;
  alphaHole?: boolean;
}

const WATER_STATES: WaterState[] = [
  { label: '构造缺省(无参数图、无法线)', time: 0 },
  { label: '清晨·晴 / 水底系数 1', time: 0.7, surface: ['morning', 'clear'], bottomDepth: 1, params: true },
  { label: '白天·雨 / 水底系数 2.5', time: 3.3, surface: ['day', 'rain'], bottomDepth: 2.5, params: true },
  { label: '夜·雾 / 水底系数 0 / 法线扰动', time: 11.9, surface: ['night', 'fog'], bottomDepth: 0, normal: true, params: true },
  { label: '白天·晴 / 透明区 uMinAlpha / 法线扰动', time: 6.1, surface: ['day', 'clear'], bottomDepth: 1.4, normal: true, params: true, alphaHole: true },
];

const waterSurfaceCases: ParityCase[] = WATER_STATES.map((st) => ({
  name: `${PREFIX}水面滤镜 ${st.label}`,
  width: 96,
  height: 64,
  tolerance: TOL8,
  build(env) {
    const f = new WaterShaderFilter();
    if (st.surface) f.applySurface(st.surface[0], st.surface[1]);
    if (st.bottomDepth !== undefined) f.setWaterBottomDepth(st.bottomDepth);
    if (st.params) f.setParamsTexture(waterParams(env, 96, 64));
    if (st.normal) f.setNormalTexture(waterNormal(env));
    f.setTime(st.time);
    return spriteRoot(smoothColor(env, 96, 64, 3, st.alphaHole), [f]);
  },
}));

// ───────────────────────────── 捞水:参数编码滤镜

/** 实体剪影:椭圆内 alpha 渐变,外圈 alpha < 0.004 走 discard */
function entityAlpha(env: ParityEnv, w: number, h: number): Texture {
  return env.dataTexture({
    width: w,
    height: h,
    seed: 17,
    scaleMode: 'linear',
    alphaMode: 'premultiplied-alpha',
    fill: (x, y, c) => {
      const dx = (x + 0.5 - w / 2) / (w * 0.42);
      const dy = (y + 0.5 - h / 2) / (h * 0.4);
      const r = Math.sqrt(dx * dx + dy * dy);
      const a = r < 1 ? Math.min(1, (1 - r) * 2.2) : r < 1.15 ? 0.002 : 0;
      return c === 3 ? a : 0.8 * a;
    },
  });
}

const paramEncodeCases: ParityCase[] = [
  { label: '深度 0.37 发光 0.8', depth: 0.37, glow: 0.8 },
  { label: '深度 1.7(8 位目标饱和) 发光 -1(夹到 0)', depth: 1.7, glow: -1 },
  { label: '深度 NaN(→0) 发光 2(夹到 1)', depth: Number.NaN, glow: 2 },
].map((p) => ({
  name: `${PREFIX}参数编码滤镜 ${p.label}`,
  width: 48,
  height: 40,
  tolerance: TOL8,
  build(env: ParityEnv) {
    const f = new WaterParamEncodeFilter();
    f.setDepthGlow(p.depth, p.glow);
    return spriteRoot(entityAlpha(env, 48, 40), [f]);
  },
}));

paramEncodeCases.push({
  name: `${PREFIX}参数编码滤镜 深度 1.7 不饱和(rgba16float 目标)`,
  width: 48,
  height: 40,
  target: 'rgba16float',
  tolerance: 2e-3,
  build(env) {
    const f = new WaterParamEncodeFilter();
    f.setDepthGlow(1.7, 0.45);
    return spriteRoot(entityAlpha(env, 48, 40), [f]);
  },
});

// ───────────────────────────── F2 背景调试滤镜

const DBG_W = 64;
const DBG_H = 48;
/** 深度图 16×12,场景在屏幕上 48×36(整 3 倍),世界容器偏移 (8,6):像素中心离纹素边界 ≥ 1/6 纹素 */
const DEPTH_W = 16;
const DEPTH_H = 12;

function depthCfg(invert: boolean, scale: number, offset: number): SceneDepthConfig {
  return {
    depth_map: 'depth.png',
    collision_map: 'collision.png',
    // 纹理像素 48×36(与屏幕上的场景同尺寸);R 的 0 / 2 行六个系数全非零,每一项都进碰撞网格坐标。
    // 取值让网格盖住画面大部分、左右两侧各留一条出界带(测 gx/gz 越界分支)
    M: { R: [[0.95, 0.12, 0.28], [0, 1, 0], [-0.25, 0.34, 0.9]], ppu: 2, cx: 24, cy: 30 },
    depth_mapping: { invert, scale, offset },
    shader: { depth_per_sy: 0.01 },
    collision: { x_min: -10, z_min: -2, cell_size: 1.5, grid_width: 14, grid_height: 8 },
    depth_tolerance: 0.1,
    floor_offset: 0,
  } as SceneDepthConfig;
}

/** RG 双字节编码的 16 位深度(r 高字节 g 低字节);按纹素取整数码值,nearest 采样 */
function rg16(env: ParityEnv, w: number, h: number, seed: number, f: (x: number, y: number) => number): Texture {
  return env.dataTexture({
    width: w,
    height: h,
    seed,
    fill: (x, y, c) => {
      const code = Math.round(Math.max(0, Math.min(1, f(x, y))) * 65535);
      if (c === 0) return (code >> 8) / 255;
      if (c === 1) return (code & 255) / 255;
      return c === 3 ? 1 : 0;
    },
  });
}

interface DbgState {
  label: string;
  mode: number;
  cfg?: SceneDepthConfig;
  ground?: 'none' | 'field';
  collision?: boolean;
}

// 碰撞 + 行走面场排第一:这是本滤镜在 WebGL 上第一次生成 uniform 同步函数的那一帧。
// 行走面三个 uniform 当初没在 uniform 组里声明,那时「先注入场、后首帧渲染」会让 WebGL 生成同步函数时抛错
// (见 BackgroundDebugFilter 构造处注释);放在首位,回归时参考侧会直接报错。
const DBG_STATES: DbgState[] = [
  { label: '2 碰撞 有行走面场', mode: 2, cfg: depthCfg(false, 1, 0), ground: 'field', collision: true },
  { label: '0 透传', mode: 0, cfg: depthCfg(false, 1, 0) },
  { label: '1 深度 正向 scale 3 offset -1', mode: 1, cfg: depthCfg(false, 3, -1) },
  { label: '1 深度 反向 scale 0.5 offset 2', mode: 1, cfg: depthCfg(true, 0.5, 2) },
  { label: '1 深度 退化区间(scale 0)', mode: 1, cfg: depthCfg(false, 0, 0.3) },
  { label: '2 碰撞 无行走面场(置灰)', mode: 2, cfg: depthCfg(false, 1, 0), ground: 'none', collision: true },
  { label: '2 碰撞 未注入过行走面场(缺省置灰)', mode: 2, cfg: depthCfg(false, 1, 0), collision: true },
  { label: '3 UV', mode: 3, cfg: depthCfg(false, 1, 0) },
];

const bgDebugCases: ParityCase[] = DBG_STATES.map((st) => ({
  name: `${PREFIX}背景调试滤镜 模式 ${st.label}`,
  width: DBG_W,
  height: DBG_H,
  tolerance: TOL8,
  build(env) {
    const f = new BackgroundDebugFilter();
    const depth = rg16(env, DEPTH_W, DEPTH_H, 23, (x, y) => 0.1 + 0.8 * ((x + 0.5) / DEPTH_W) * 0.6 + 0.3 * ((y + 0.5) / DEPTH_H));
    f.loadSceneData(depth, DEPTH_W * 3, DEPTH_H * 3, st.cfg!);
    f.setWorldContainerPos(8, 6);
    f.setSceneSize(DEPTH_W * 3, DEPTH_H * 3);
    if (st.ground === 'field') {
      const g = rg16(env, DEPTH_W, DEPTH_H, 29, (x, y) => 0.2 + 0.5 * ((y + 0.5) / DEPTH_H) + 0.1 * ((x + 0.5) / DEPTH_W));
      f.setGroundTexture({ tex: g.source, min: 0, max: 6 });
    } else if (st.ground === 'none') {
      f.setGroundTexture(null);
    }
    if (st.collision) {
      // 碰撞格:棋盘 + 一条竖墙,nearest
      const col = env.dataTexture({
        width: 14,
        height: 8,
        seed: 31,
        fill: (x, y, c) => (c === 3 ? 1 : c === 0 ? (((x >> 1) + (y >> 1)) % 2 === 0 || x === 9 ? 1 : 0) : 0),
      });
      f.setCollisionTexture(col);
    }
    f.setMode(st.mode);
    const root = new Container();
    const layer = new Container();
    layer.addChild(new Sprite(smoothColor(env, DBG_W, DBG_H, 9)));
    layer.filters = [f];
    root.addChild(layer);
    return root;
  },
}));

// ───────────────────────────── 物件检视接触 AO

type Shape = 'blob' | 'ring' | 'ell';

/** 物件剪影(已预乘):blob = 圆角团块;ring = 中间镂空的环(内圈透明区要吃到 AO);ell = L 形 */
function shapeTexture(env: ParityEnv, shape: Shape, w: number, h: number): Texture {
  return env.dataTexture({
    width: w,
    height: h,
    seed: 53,
    scaleMode: 'linear',
    alphaMode: 'premultiplied-alpha',
    fill: (x, y, c) => {
      const u = (x + 0.5) / w - 0.5;
      const v = (y + 0.5) / h - 0.5;
      let a = 0;
      if (shape === 'blob') {
        const r = Math.hypot(u / 0.42, v / 0.36);
        a = r < 1 ? Math.min(1, (1 - r) * 6) : 0;
      } else if (shape === 'ring') {
        const r = Math.hypot(u / 0.45, v / 0.42);
        a = r < 1 && r > 0.45 ? Math.min(1, (1 - r) * 8, (r - 0.45) * 8) : 0;
      } else {
        const inL = (u > -0.42 && u < -0.12 && v > -0.4 && v < 0.4) || (u > -0.42 && u < 0.4 && v > 0.12 && v < 0.4);
        a = inL ? 1 : 0;
      }
      if (c === 3) return a;
      const base = c === 0 ? 0.75 : c === 1 ? 0.62 + 0.2 * u : 0.45 + 0.2 * v;
      return base * a;
    },
  });
}

/** 爬虫剪影:小椭圆,不透明深色 */
function critterTexture(env: ParityEnv): Texture {
  return env.dataTexture({
    width: 8,
    height: 5,
    seed: 61,
    scaleMode: 'linear',
    alphaMode: 'premultiplied-alpha',
    fill: (x, y, c) => {
      const r = Math.hypot((x + 0.5 - 4) / 4, (y + 0.5 - 2.5) / 2.5);
      const a = r < 1 ? 1 : 0;
      return c === 3 ? a : 0.12 * a;
    },
  });
}

interface AoState {
  label: string;
  shape: Shape;
  pixelsPerCm: number;
  strength: number;
  radiusCm: number;
  critter?: [number, number];
  /** objectRoot 的位置 / 缩放 / 旋转 */
  pose: [number, number, number, number];
  bodyHidden?: boolean;
  /** 爬虫每帧挪动(测每帧清屏,不许拖影) */
  moving?: boolean;
  frames?: number;
  /** 不调 setPixelsPerCm / setCastArea:mask RT 从未建过,apply 走内置 AlphaFilter 透传 */
  noCastArea?: boolean;
}

const AO_W = 128;
const AO_H = 104;
const OBJ_W = 80;
const OBJ_H = 60;

const AO_STATES: AoState[] = [
  { label: '团块 只有物件影 半径 2cm', shape: 'blob', pixelsPerCm: 2, strength: 1, radiusCm: 2, pose: [24, 22, 1, 0] },
  { label: '环 物件影 + 爬虫影 半径 5cm', shape: 'ring', pixelsPerCm: 2, strength: 1.4, radiusCm: 5, critter: [1.2, 1.5], pose: [24, 22, 1, 0] },
  { label: 'L 形 缩放 1.2 旋转 0.2 强度上限 3', shape: 'ell', pixelsPerCm: 3, strength: 5, radiusCm: 3, critter: [0.8, 2], pose: [30, 14, 1.2, 0.2] },
  { label: '团块 只有爬虫影(物件强度 0)', shape: 'blob', pixelsPerCm: 1.5, strength: 0, radiusCm: 1, critter: [2, 2], pose: [24, 22, 1, 0] },
  { label: '环 半径 0(模糊下限)', shape: 'ring', pixelsPerCm: 2, strength: 2, radiusCm: 0, critter: [1, 0], pose: [24, 22, 1, 0] },
  { label: '团块 物件隐藏 爬虫逐帧移动(清屏不拖影)', shape: 'blob', pixelsPerCm: 2, strength: 1, radiusCm: 3, critter: [1.5, 1.5], pose: [24, 22, 1, 0], bodyHidden: true, moving: true, frames: 4 },
  { label: '环 爬虫逐帧移动 4 帧', shape: 'ring', pixelsPerCm: 2, strength: 1, radiusCm: 4, critter: [1.5, 1], pose: [24, 22, 1, 0], moving: true, frames: 4 },
  { label: '团块 未设 cast 区域(内置透传)', shape: 'blob', pixelsPerCm: 2, strength: 1, radiusCm: 0, pose: [24, 22, 1, 0], noCastArea: true },
  { label: '环 两路强度都为 0(滤镜关闭)', shape: 'ring', pixelsPerCm: 2, strength: 0, radiusCm: 3, critter: [0, 1], pose: [24, 22, 1, 0] },
];

interface AoRig {
  objectRoot: Container;
  filter: ObjectExamineContactAoFilter;
  critters: Container[];
}

const aoRigs = new WeakMap<Container, AoRig>();

const contactAoCases: ParityCase[] = AO_STATES.map((st) => ({
  name: `${PREFIX}接触 AO ${st.label}`,
  width: AO_W,
  height: AO_H,
  tolerance: TOL8,
  frames: st.frames ?? 2,
  build(env) {
    const root = new Container();
    // 背景板:不透明中灰,AO 在物件透明区写黑 alpha 把它压暗
    root.addChild(new Sprite(env.dataTexture({
      width: AO_W,
      height: AO_H,
      seed: 71,
      scaleMode: 'linear',
      fill: (x, y, c) => (c === 3 ? 1 : 0.55 + 0.15 * Math.sin(x * 0.05 + c) * Math.cos(y * 0.07)),
    })));
    const objectRoot = new Container();
    const [px, py, sc, rot] = st.pose;
    objectRoot.position.set(px, py);
    objectRoot.scale.set(sc);
    objectRoot.rotation = rot;
    const body = new Sprite(shapeTexture(env, st.shape, OBJ_W, OBJ_H));
    body.visible = !st.bodyHidden;
    objectRoot.addChild(body);
    const ground = new Container();
    const onBody = new Container();
    const ctex = critterTexture(env);
    const spots: Array<[Container, number, number, number]> = [
      [ground, -6, 30, 0.3],
      [ground, 70, 52, -0.6],
      [onBody, 36, 26, 1.1],
      [onBody, 20, 40, 0],
    ];
    for (const [layer, x, y, r] of spots) {
      const s = new Sprite(ctex);
      s.anchor.set(0.5);
      s.position.set(x, y);
      s.rotation = r;
      s.scale.set(1.3);
      layer.addChild(s);
    }
    objectRoot.addChild(ground, onBody);
    root.addChild(objectRoot);

    const filter = new ObjectExamineContactAoFilter();
    filter.setCasters(body, [ground, onBody]);
    if (!st.noCastArea) {
      filter.setPixelsPerCm(st.pixelsPerCm);
      filter.setCastArea(0, 0, OBJ_W, OBJ_H);
    }
    filter.setStrength(st.strength);
    filter.setRadiusCm(st.radiusCm);
    if (st.critter) filter.setCritterShadow(st.critter[0], st.critter[1]);
    objectRoot.filters = [filter];
    aoRigs.set(root, { objectRoot, filter, critters: [ground, onBody] });
    return root;
  },
  beforeFrame(env, root, frame) {
    const rig = aoRigs.get(root)!;
    if (st.moving) {
      rig.critters[0].position.set(frame * 5, frame * 2);
      rig.critters[1].position.set(-frame * 3, frame * 4);
    }
    // 与 ObjectExamineScene.update 同序:先烘 caster mask,再整帧渲染
    rig.filter.bake(env.renderer, rig.objectRoot);
  },
}));

export const cases: ParityCase[] = [
  ...waterSurfaceCases,
  ...paramEncodeCases,
  ...bgDebugCases,
  ...contactAoCases,
];
