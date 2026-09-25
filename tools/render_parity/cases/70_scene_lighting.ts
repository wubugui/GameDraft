/**
 * 场景光照两级的 WGSL 移植 —— 像素对照(「场景光照 /」)。
 *
 * 被测的是真实宿主类:
 *   - 第一级 `SceneLightingPass`(脏时烘焙:原画 + albedo × Σ实体灯 + 镜面 + 灯体光晕 → rgba16float 线性 HDR),
 *     连同它内部的 `ShadowPrefixPass`(线扫前缀)与 `packLights` / `packEmissive` / `packShadowBias` 的真实打包;
 *   - 第二级 `LitBackground`(逐帧:采样缓存 → 草木摆动 → 高度雾 → 显示变换 → 8 位)。
 * 输入全是固定种子的合成数据(两侧逐字节相同):原画 / albedo / 法线 / RG16 深度场(斜坡 + 遮挡块 + 噪声)、
 * 表面材质遮罩、rgba16float 的 probe 图集与 skyao 图集、位移图与露出处两份缓存。
 * 灯按「q 单位」写(位置 / 半径 / 尺寸 × wuPerQUnit 才进作者面),同一套灯在不同 wu 尺度下照度不变,
 * 于是细节法线的像素足迹 fp(dFdx / dFdy 那条)可以靠换 wuPerQUnit 扫过各级淡出区间。
 *
 * 多拍用例(同一实例依次改参 / 切调试视图 / 推时钟)把每拍的输出**竖着拼**成一张比。
 * 每侧回读后先过本侧自检(NaN / Inf、该有的东西真的画出来了、开关真的改了画面),防「两边都没画」的假一致。
 *
 * 容差见 TOL_* 的注释(实测值写在那里)。出现非零差先查翻译,不许放宽。
 *
 * 变异自检(2026-09-25,各改一处 WGSL,全部当场变红):前缀 slab 选错张、细节法线取样平面换轴、
 * 像素足迹 fp 换常数 / 丢掉 y 导数、光晕强度不除回 wuPerQUnit²、双面面光位失效、GI 棋盘奇偶、
 * 位移图不除覆盖度、雾的相机侧高度符号、雨点涟漪相位不吃时钟(这一条最早没抓到:k 太大时涟漪整个淡没,
 * 见水面用例上方的注释)。GL 侧:移植前后两份源码各跑一遍全套对照,WebGL 输出逐字节相同(哈希比对)。
 */
import { RenderTexture, type Container, type Texture } from 'pixi.js';
import type { ParityCase, ParityEnv, ParityTarget } from '../harness';
import { SceneLightingPass, type SceneLightingGeometry } from '@src/rendering/lighting/SceneLightingPass';
import { LitBackground } from '@src/rendering/lighting/LitBackground';
import { MAX_STATIC_LIGHTS } from '@src/rendering/lighting/lightPacking';
import { LIGHTS_PER_SLAB } from '@src/rendering/lighting/shadowPrefix';
import { SURFACE_DEFAULTS } from '@src/rendering/lighting/surfaceMask';
import { defaultSceneLighting } from '@src/data/sceneLightingDefault';
import type { DisplayTransformDef, FogDef, LightDef, SceneLightingDef } from '@src/data/types';

const P = '场景光照 / ';

/**
 * 烘焙(rgba16float)的容差,按配方卡给 1e-3。值域:漫反射 + 光晕 0..~18,镜面到几。
 *
 * 实测(无头 SwiftShader,2026-09-25):12 个烘焙用例里 11 个两侧**逐位相同**;「表面遮罩 · 淡出区」那个
 * 只有 1 个分量差半浮点 1 ulp(0.597 处差 2^-11)。根因查到底了(临时把 RT 换成 rgba32float 逐项比):
 * 整个 pass 在 f32 下只有**共享片段 lcSpotLight 的灯锥**两侧差 1~4 ulp —— WGSL 内建 smoothstep 与 GLSL 的
 * 在过渡区不是同一串指令;把它换成两份规范共同的定义式 t·t·(3−2t) 后全部用例 f32 逐位相同。偶尔有一个
 * 分量正好压在半浮点舍入边界上,就翻成 1 ulp。本 pass 自己的 smoothstep(细节法线)已按定义式手写
 * (内建那个曾让镜面差到 50 ulp:GGX 近峰值 dd = nh²(a2−1)+1 相消放大);灯锥在共享片段里,不归本文件改。
 * ⚠ 于是 1e-3 只容得下值 < 2 处的 1 ulp 翻转。改了用例数据后若在更亮处出现 1 ulp,照上面的办法到 f32
 * 里确认是不是只有灯锥那几 ulp,再说;不要为它放宽容差。
 */
const TOL_BAKE = 1e-3;
/**
 * 显示(rgba8unorm,按 0..1 归一):最多 1 个 LSB(整链用例里的灯锥底噪理论上能翻一个 8 位舍入)。
 * 实测 5 个显示 / 整链用例两侧**逐位相同**。
 */
const TOL_DISPLAY = 1.5 / 255;

/** 给了 `produce` 框架就不调 `build`;类型上它是必填,占个位 */
function produceOnly(): never {
  throw new Error('本文件的用例走 produce()');
}

// ───────────────────────────── 小工具

type V3 = [number, number, number];

function rotXRows(deg: number): [V3, V3, V3] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}

/** 行主 → Pixi mat3x3 的列主 Float32Array */
function colMajor(rows: number[][]): Float32Array {
  return new Float32Array([rows[0][0], rows[1][0], rows[2][0], rows[0][1], rows[1][1], rows[2][1], rows[0][2], rows[1][2], rows[2][2]]);
}

function norm3(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function assertFinite(data: Float32Array, what: string): void {
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i])) throw new Error(`${what}:输出含 NaN/Inf(第 ${i >> 2} 个像素)`);
  }
}

/** 通道 ch 上超过 eps 的像素数 */
function countAbove(data: Float32Array, ch: number, eps: number): number {
  let n = 0;
  for (let i = ch; i < data.length; i += 4) if (Math.abs(data[i]) > eps) n++;
  return n;
}

/** 两份输出里 rgb 有差(> eps)的像素数 */
function countDiff(a: Float32Array, b: Float32Array, eps: number): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > eps || Math.abs(a[i + 1] - b[i + 1]) > eps || Math.abs(a[i + 2] - b[i + 2]) > eps) n++;
  }
  return n;
}

function need(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
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

// ───────────────────────────── 合成场景(几何件 + 原画)

interface SceneSetup {
  /** 深度图 = 烘焙 RT 尺寸(native px) */
  w: number;
  h: number;
  seed: number;
  /** ppu;cx / cy 缺省在图中心偏一点(不对称,上下 / 左右翻了都抓得到) */
  ppu: number;
  /** invert, scale, offset */
  depthMapping: V3;
  /** depthConfig.M.R = 绕 X 转这么多度(det = +1) */
  tiltDeg: number;
  wuPerQUnit: number;
}

interface SceneTextures {
  painting: Texture;
  geo: SceneLightingGeometry;
  /** 深度场(q 深度,供本侧自检 / 其他纹理对齐用) */
  depthAt: (x: number, y: number) => number;
  owned: Texture[];
}

/** RG16(与 raw_depth_rg.png 同编码):t ∈ [0,1] → 高字节 R、低字节 G */
function rg16Texture(env: ParityEnv, w: number, h: number, seed: number, field: (x: number, y: number) => number): Texture {
  return env.dataTexture({
    width: w, height: h, seed, format: 'rgba8unorm', scaleMode: 'linear',
    fill: (x, y, c) => {
      const u = Math.max(0, Math.min(65535, Math.round(field(x, y) * 65535)));
      return c === 0 ? (u >> 8) / 255 : c === 1 ? (u & 255) / 255 : c === 2 ? 0 : 1;
    },
  });
}

/** 斜坡 + 几块更近的遮挡体 + 噪声,t ∈ [0,1](存进 RG16 的原始值) */
function depthRaw(env: ParityEnv, w: number, h: number, seed: number): (x: number, y: number) => number {
  const rng = env.rng(seed);
  const boxes: [number, number, number, number, number][] = [];
  for (let i = 0; i < 4; i++) {
    const bw = 4 + Math.floor(rng() * w * 0.25);
    const bh = 4 + Math.floor(rng() * h * 0.35);
    boxes.push([Math.floor(rng() * (w - bw)), Math.floor(rng() * (h - bh)), bw, bh, 0.08 + rng() * 0.25]);
  }
  const noise = new Float32Array(w * h);
  for (let i = 0; i < noise.length; i++) noise[i] = (rng() - 0.5) * 0.006;
  return (x, y) => {
    let t = 0.22 + 0.5 * (y / h) + 0.06 * Math.sin(x * 0.29) + 0.03 * Math.cos(y * 0.41 + x * 0.07);
    for (const [bx, by, bw, bh, drop] of boxes) if (x >= bx && x < bx + bw && y >= by && y < by + bh) t -= drop;
    return Math.max(0, Math.min(1, t + noise[y * w + x]));
  };
}

function buildScene(env: ParityEnv, s: SceneSetup): SceneTextures {
  const { w, h, seed } = s;
  const raw = depthRaw(env, w, h, seed);
  const depth = rg16Texture(env, w, h, seed + 1, raw);
  const [inv, scale, offset] = s.depthMapping;
  const depthAt = (x: number, y: number) => (inv > 0.5 ? 1 - raw(x, y) : raw(x, y)) * scale + offset;
  // 世界法线:上段是朝相机的墙、下段是地面、遮挡块的左右两边是侧墙,叠一点起伏。编码 rg = xy*0.5+0.5,b = |z|
  const nrm = (x: number, y: number): V3 => {
    const t = raw(x, y), tl = raw(Math.max(0, x - 1), y), tr = raw(Math.min(w - 1, x + 1), y);
    const edge = tr - tl;
    let n: V3 = y < h * 0.4
      ? [0.2 * Math.sin(x * 0.23), 0.12, -1]
      : [0.15 * Math.sin(x * 0.31 + y * 0.1), 1, -0.3 - 0.2 * t];
    if (Math.abs(edge) > 0.05) n = [edge > 0 ? 0.9 : -0.9, 0.15, -0.45];
    return norm3(n);
  };
  const normal = env.dataTexture({
    width: w, height: h, seed: seed + 2, scaleMode: 'linear',
    fill: (x, y, c) => {
      const n = nrm(x, y);
      return c === 0 ? n[0] * 0.5 + 0.5 : c === 1 ? n[1] * 0.5 + 0.5 : c === 2 ? Math.abs(n[2]) : 1;
    },
  });
  // albedo(sRGB8,作者可手改的那张)与原画:原画比深度图大 1.5 倍(与运行时一样尺寸不同,线性过滤落在非 texel 中心)
  const albedo = env.dataTexture({
    width: w, height: h, seed: seed + 3, scaleMode: 'linear',
    fill: (x, y, c, rng) => (c === 3 ? 1 : 0.08 + 0.8 * (0.5 + 0.5 * Math.sin(x * 0.17 + c * 1.3 + y * 0.05)) * (0.6 + 0.4 * rng())),
  });
  const pw = Math.round(w * 1.5), ph = Math.round(h * 1.5);
  const painting = env.dataTexture({
    width: pw, height: ph, seed: seed + 4, scaleMode: 'linear',
    fill: (x, y, c, rng) => (c === 3 ? 1 : Math.min(1, 0.05 + 0.55 * (y / ph) + 0.25 * Math.abs(Math.sin(x * 0.11 + c)) + 0.1 * rng())),
  });
  const R = rotXRows(s.tiltDeg);
  const geo: SceneLightingGeometry = {
    normal, albedo, depth,
    depthSize: [w, h],
    cal: [s.ppu, w * 0.47, h * 0.53],
    wuPerQUnit: s.wuPerQUnit,
    depthMapping: s.depthMapping,
    mRows: R,
  };
  return { painting, geo, depthAt, owned: [depth, normal, albedo, painting] };
}

// ───────────────────────────── 灯(q 单位书写,× wuPerQUnit 进作者面)

/** q 单位的灯:位置 / to / 半径 / 软化 / 面光尺寸都 × k 才是 wu,其余原样 */
type QLight = Omit<LightDef, 'id'> & { id?: string };

function lightsWu(ls: QLight[], k: number): LightDef[] {
  return ls.map((l, i) => {
    const o: LightDef = { ...l, id: l.id ?? `l${i}` } as LightDef;
    const mul = (v?: V3) => (v ? ([v[0] * k, v[1] * k, v[2] * k] as V3) : undefined);
    if (l.pos) o.pos = mul(l.pos);
    if (l.to) o.to = mul(l.to);
    if (l.range !== undefined) o.range = l.range * k;
    if (l.softeningRadius !== undefined) o.softeningRadius = l.softeningRadius * k;
    if (l.size) o.size = [l.size[0] * k, l.size[1] * k];
    return o;
  });
}

interface DefOpts {
  lights: QLight[];
  emissive?: { gain: number; coreRadius: number; haloRadius: number; haloGain: number };
  display?: Partial<DisplayTransformDef>;
  fog?: FogDef;
}

function sceneDef(k: number, o: DefOpts): SceneLightingDef {
  const def = defaultSceneLighting();
  def.lights = lightsWu(o.lights, k);
  // 偏置 / 厚度窗是 wu:按 q 单位给(0.02 / 0.3)再 × k,不同尺度下阴影一样
  def.shadowBias = { bias: 0.02 * k, thickness: 0.3 * k };
  if (o.emissive) {
    def.emissive = {
      gain: o.emissive.gain,
      coreRadius: o.emissive.coreRadius * k,
      haloRadius: o.emissive.haloRadius * k,
      haloGain: o.emissive.haloGain,
    };
  } else {
    def.emissive = { gain: 0, coreRadius: 0.15 * k, haloRadius: 0.6 * k, haloGain: 0.2 };
  }
  if (o.display) def.display = { ...def.display, ...o.display };
  if (o.fog) def.fog = o.fog;
  return def;
}

/** 五种灯各一(外加双面面光、截断早退、强度 0、禁用),M-world 的 q 单位 */
function kindsLights(opts: { cast?: boolean; reflect?: boolean } = {}): QLight[] {
  const cast = opts.cast ?? false;
  const reflect = opts.reflect ?? false;
  return [
    { kind: 'point', pos: [-0.4, 0.6, -0.2], color: [1, 0.8, 0.55], intensity: 1.2, range: 1.6, softeningRadius: 0.3, castShadow: cast, reflect },
    {
      kind: 'spot', pos: [0.5, 0.9, 0.1], dir: [-0.3, -1, 0.2], innerAngleDeg: 22, outerAngleDeg: 44,
      color: [0.6, 0.8, 1], intensity: 2, range: 2.0, softeningRadius: 0.25, castShadow: cast, reflect,
    },
    {
      kind: 'area', pos: [0.1, 0.4, -0.6], orientation: [0, -0.3, 1], size: [0.6, 0.3], rollDeg: 25,
      color: [1, 0.95, 0.8], intensity: 1.5, range: 2.2, castShadow: cast, reflect,
    },
    {
      kind: 'area', pos: [-0.8, 0.2, -0.4], orientation: [1, 0.2, 0], size: [0.4, 0.5], rollDeg: -40, twoSided: true,
      color: [0.9, 0.6, 1], intensity: 1, range: 1.8, castShadow: cast, reflect,
    },
    { kind: 'directional', elevationDeg: 35, azimuthDeg: 120, color: [0.7, 0.75, 1], intensity: 0.4, castShadow: cast, reflect },
    {
      kind: 'line', pos: [-0.9, 1.0, 0], to: [0.8, 0.7, 0.3], color: [0.85, 0.9, 1], intensity: 0.8,
      range: 1.8, softeningRadius: 0.2, castShadow: cast, reflect,
    },
    // 作用半径很小:图上大半像素走「超出高斯截断」早退
    { kind: 'point', pos: [0.8, -0.3, -0.6], color: [1, 0.4, 0.3], intensity: 3, range: 0.25, softeningRadius: 0.1, castShadow: cast, reflect },
    // 强度 0:早退(打包照样占一格)
    { kind: 'point', pos: [0, 0, 0], color: [1, 1, 1], intensity: 0, range: 3 },
    // 禁用:不进打包
    { kind: 'point', pos: [0.1, 0.1, 0.1], color: [1, 1, 1], intensity: 50, range: 3, enabled: false },
  ];
}

/** 伪随机 n 盏(五种灯随机),位置在场景包围盒附近 */
function randomLights(env: ParityEnv, n: number, seed: number, cast: (i: number) => boolean): QLight[] {
  const rng = env.rng(seed);
  const kinds: LightDef['kind'][] = ['point', 'spot', 'area', 'directional', 'line'];
  const out: QLight[] = [];
  for (let i = 0; i < n; i++) {
    const kind = kinds[Math.floor(rng() * kinds.length)];
    const pos: V3 = [(rng() - 0.5) * 2.2, (rng() - 0.3) * 1.8, (rng() - 0.5) * 1.8];
    const color: V3 = [0.4 + rng() * 0.6, 0.4 + rng() * 0.6, 0.4 + rng() * 0.6];
    const base = { pos, color, range: 0.6 + rng() * 1.6, castShadow: cast(i) };
    if (kind === 'point') out.push({ ...base, kind, intensity: 0.2 + rng() * 0.8, softeningRadius: 0.2 + rng() * 0.2 });
    else if (kind === 'spot') {
      out.push({
        ...base, kind, intensity: 0.3 + rng(), softeningRadius: 0.2,
        dir: [rng() - 0.5, -0.5 - rng(), rng() - 0.5], innerAngleDeg: 10 + rng() * 20, outerAngleDeg: 35 + rng() * 25,
      });
    } else if (kind === 'area') {
      out.push({
        ...base, kind, intensity: 0.3 + rng(), size: [0.2 + rng() * 0.5, 0.2 + rng() * 0.5], rollDeg: (rng() - 0.5) * 180,
        orientation: [rng() - 0.5, rng() - 0.5, rng() - 0.5], twoSided: rng() < 0.4,
      });
    } else if (kind === 'directional') {
      out.push({ ...base, kind, intensity: 0.05 + rng() * 0.2, elevationDeg: 10 + rng() * 70, azimuthDeg: rng() * 360 });
    } else {
      out.push({ ...base, kind, intensity: 0.2 + rng() * 0.5, softeningRadius: 0.2, to: [pos[0] + (rng() - 0.5) * 1.5, pos[1] + (rng() - 0.5), pos[2] + (rng() - 0.5)] });
    }
  }
  return out;
}

// ───────────────────────────── 烘焙用例(SceneLightingPass)

interface BakeCtx {
  env: ParityEnv;
  scene: SceneTextures;
  k: number;
  /** 本用例自己建的纹理(pass 销毁之后再销毁) */
  own(t: Texture): Texture;
}

interface BakeSetup {
  scene: SceneSetup;
  /** 每一拍:对同一实例改参(applyParams / setDebug / setSurfaceMask …),然后标脏、重烘、回读 */
  steps: ((pass: SceneLightingPass, ctx: BakeCtx) => void)[];
  /** 本侧自检(不变量不成立就抛 = 该侧出错) */
  check?: (outs: Float32Array[]) => void;
}

async function runBake(env: ParityEnv, s: BakeSetup): Promise<Float32Array> {
  const scene = buildScene(env, s.scene);
  const extra: Texture[] = [];
  const ctx: BakeCtx = { env, scene, k: s.scene.wuPerQUnit, own: (t) => { extra.push(t); return t; } };
  const pass = new SceneLightingPass(scene.painting, scene.geo);
  try {
    const outs: Float32Array[] = [];
    for (const step of s.steps) {
      step(pass, ctx);
      pass.markDirty();
      need(pass.update(env.renderer), 'update() 没有重烘');
      const rt = pass.radiance;
      need(!!rt, '辐射场 RT 没建出来');
      const data = await env.readTexture(rt!, 'rgba16float');
      assertFinite(data, `第 ${outs.length} 拍`);
      outs.push(data);
    }
    s.check?.(outs);
    return concat(outs);
  } finally {
    // Pixi 坑②:先让 pass 解绑 / 销毁,再销毁它绑过的纹理
    pass.destroy();
    for (const t of [...extra, ...scene.owned]) t.destroy(true);
  }
}

function bakeCase(name: string, s: BakeSetup, tolerance = TOL_BAKE): ParityCase {
  return {
    name: P + name,
    width: s.scene.w,
    height: s.scene.h * s.steps.length,
    target: 'rgba16float',
    tolerance,
    build: produceOnly,
    produce: (env) => runBake(env, s),
  };
}

const SCENE_A: SceneSetup = { w: 72, h: 48, seed: 701, ppu: 32, depthMapping: [0, 2, -1], tiltDeg: 40, wuPerQUnit: 100 };

/** 表面材质遮罩(布置库 surfaces 画出来的那张;半分辨率):r 反光 g 粗糙度 b 水面 */
function surfaceMask(ctx: BakeCtx, roughWater: number): Texture {
  const [w, h] = ctx.scene.geo.depthSize;
  const mw = Math.max(8, Math.round(w / 2)), mh = Math.max(8, Math.round(h / 2));
  return ctx.own(ctx.env.dataTexture({
    width: mw, height: mh, seed: 777, scaleMode: 'linear',
    fill: (x, y, c) => {
      // 左下一块水(b=1)、右下一块湿石板(反光强、较光)、上半是没画区域的缺省材质(反光 1 粗糙 0.45)、右上一块不反光
      const water = x < mw * 0.45 && y > mh * 0.55;
      const wet = x >= mw * 0.55 && y > mh * 0.5;
      const dry = x > mw * 0.7 && y < mh * 0.3;
      if (c === 0) return dry ? 0 : wet ? 0.9 : 1;
      if (c === 1) return water ? roughWater : wet ? 0.3 : 0.45;
      if (c === 2) return water ? 1 : 0;
      return 1;
    },
  }));
}

// ───────────────────────────── probe / skyao(GI 体调试视图)

const PN: V3 = [6, 5, 4];
const PROBE_COUNT = PN[0] * PN[1] * PN[2];
const PROBE_T = 16;
const PROBE_ROWS = Math.ceil(PROBE_COUNT / PROBE_T);
const SKY_N: V3 = [5, 4, 6];
const SKY_TILES: [number, number] = [3, 2];

interface ProbeCfg { mode: number; shK: number; binOb: number; fold: number; skyao: boolean; beta: number }

function probeResources(ctx: BakeCtx, cfg: ProbeCfg): Parameters<SceneLightingPass['setProbeResources']>[0] {
  const env = ctx.env;
  const rng = env.rng(31);
  const probe = (x: number, y: number, ncol: number) => ({ flat: y * PROBE_T + Math.floor(x / ncol), col: x % ncol });
  const l1 = ctx.own(env.dataTexture({
    width: PROBE_T * 4, height: PROBE_ROWS, seed: 41, format: 'rgba16float',
    fill: (x, y, c, r) => (c === 3 ? 1 : probe(x, y, 4).col === 0 ? 0.5 + r() * 2 : (r() - 0.5) * 1.6),
  }));
  const l2 = ctx.own(env.dataTexture({
    width: PROBE_T * cfg.shK, height: PROBE_ROWS, seed: 42, format: 'rgba16float',
    fill: (x, y, c, r) => (c === 3 ? 1 : probe(x, y, cfg.shK).col === 0 ? 0.5 + r() * 1.5 : (r() - 0.5) * 1.2),
  }));
  const bin = ctx.own(env.dataTexture({
    width: PROBE_T * cfg.binOb * cfg.binOb, height: PROBE_ROWS, seed: 43, format: 'rgba16float',
    fill: (_x, _y, c, r) => (c === 3 ? 1 : r() * 2),
  }));
  // 前两层整片失效(落在那里的查询 8 角全无效 ⇒ 走 ambIrr 兜底 / 最近邻亮品红),其余随机 15% 失效
  const valid = ctx.own(env.dataTexture({
    width: PROBE_T, height: PROBE_ROWS, seed: 44, format: 'r8unorm',
    fill: (x, y, _c, r) => {
      const flat = y * PROBE_T + x;
      if (flat >= PROBE_COUNT) return 0;
      return Math.floor(flat / (PN[1] * PN[2])) <= 1 || r() < 0.15 ? 0 : 1;
    },
  }));
  const sky = ctx.own(env.dataTexture({
    width: SKY_TILES[0] * SKY_N[0], height: SKY_TILES[1] * SKY_N[1], seed: 47, format: 'rgba16float',
    fill: (_x, _y, c, r) => (c === 0 ? 0.2 + r() * 0.8 : (r() - 0.5) * 0.8),
  }));
  const ambSH = new Float32Array(27);
  for (let i = 0; i < 27; i++) ambSH[i] = i < 3 ? 0.6 + rng() * 0.4 : (rng() - 0.35) * 0.6;
  // probe 查表的 M 是实验室 lighting.json 那份(det = −1),skyao 走 depthConfig 的 R(det = +1):两个 M 不许混
  const labM = [[1, 0, 0], [0, Math.cos(0.61), Math.sin(0.61)], [0, Math.sin(0.61), -Math.cos(0.61)]];
  return {
    atlasL1: l1.source, atlasL2: l2.source, atlasBin: bin.source, valid: valid.source,
    mCol: colMajor(labM),
    wMin: [-1.3, -1.5, -1.5],
    wScale: [(PN[0] - 1) / 2.6, (PN[1] - 1) / 3, (PN[2] - 1) / 3],
    pn: PN,
    probeT: PROBE_T,
    shK: cfg.shK,
    binOb: cfg.binOb,
    skyao: cfg.skyao
      ? {
        tex: sky.source, n: SKY_N, tiles: SKY_TILES, wMin: [-1.5, -1.5, -1.5], wScale: [1 / 3, 1 / 3, 1 / 3],
        mCol: colMajor(ctx.scene.geo.mRows),
      }
      : null,
    ambSH,
    mode: cfg.mode,
    ambStrength: 0.7,
    beta: cfg.beta,
    fold: cfg.fold,
  };
}

function giSteps(cfg: ProbeCfg, views: { debug: number; fixedN?: number }[]): BakeSetup['steps'] {
  return views.map((v, i) => (pass, ctx) => {
    if (i === 0) {
      pass.applyParams(sceneDef(ctx.k, { lights: kindsLights() }));
      pass.setProbeResources(probeResources(ctx, cfg));
    }
    pass.setGiFixedN(v.fixedN ?? 0);
    pass.setDebug(v.debug);
  });
}

// ───────────────────────────── 显示用例(LitBackground)

interface DisplaySetup {
  scene: SceneSetup;
  /** 屏幕上的世界尺寸(= 对照目标尺寸;与缓存尺寸不同,采样落在非 texel 中心) */
  worldW: number;
  worldH: number;
  display: Partial<DisplayTransformDef>;
  fog?: FogDef;
  /** 缓存从哪来:合成的 rgba16float(缺省)或真跑一次烘焙(整链) */
  bake?: DefOpts & { surfaceMask?: boolean };
  sway?: 'on' | 'on-then-off';
}

async function runDisplay(env: ParityEnv, s: DisplaySetup): Promise<Float32Array> {
  const scene = buildScene(env, s.scene);
  const extra: Texture[] = [];
  const own = (t: Texture) => { extra.push(t); return t; };
  const { w, h } = s.scene;
  let pass: SceneLightingPass | null = null;
  let bg: LitBackground | null = null;
  try {
    let radiance: Texture;
    if (s.bake) {
      pass = new SceneLightingPass(scene.painting, scene.geo);
      const k = s.scene.wuPerQUnit;
      pass.applyParams(sceneDef(k, s.bake));
      if (s.bake.surfaceMask) {
        const ctx: BakeCtx = { env, scene, k, own };
        pass.setSurfaceMask(surfaceMask(ctx, 0.3));
      }
      pass.markDirty();
      need(pass.update(env.renderer), '整链:烘焙没跑');
      radiance = pass.radiance!;
    } else {
      // 线性 HDR 辐射场:0..~4,alpha = 灯体占比(显示端不读)
      radiance = own(env.dataTexture({
        width: w, height: h, seed: s.scene.seed + 50, format: 'rgba16float', scaleMode: 'linear',
        fill: (x, y, c, rng) => (c === 3 ? rng() : (0.02 + 3 * Math.pow((x / w) * 0.7 + (y / h) * 0.3, 2)) * (0.7 + 0.3 * Math.sin(x * 0.4 + c * 2 + y * 0.13)) + 0.05 * rng()),
      }));
    }
    const R = scene.geo.mRows;
    bg = new LitBackground(radiance, scene.geo, [R[1][0], R[1][1], R[1][2]], s.worldW, s.worldH);
    const def = defaultSceneLighting();
    def.display = { ...def.display, ...s.display };
    if (s.fog) def.fog = s.fog;
    bg.applyParams(def);

    const outs: Float32Array[] = [];
    if (s.sway) {
      // 草木位移图(原画尺寸;RG = (源 uv − 本像素 uv) × 覆盖度,A = 覆盖度)+ 扣掉植物那份光照缓存与深度
      const uw = Math.round(w * 1.25), uh = Math.round(h * 1.25);
      const uvMap = own(env.dataTexture({
        width: uw, height: uh, seed: 91, format: 'rgba16float', scaleMode: 'linear',
        fill: (x, y, c) => {
          const dx = (x - uw * 0.35) / (uw * 0.22), dy = (y - uh * 0.45) / (uh * 0.3);
          const r2 = dx * dx + dy * dy;
          const cover = r2 < 1 ? Math.min(1, (1 - r2) * 1.6) : 0;
          if (c === 3) return cover;
          const off = c === 0 ? 0.04 * Math.sin(y * 0.3) : c === 1 ? -0.03 * Math.cos(x * 0.25) : 0;
          return off * cover;
        },
      }));
      const radiancePlate = own(env.dataTexture({
        width: w, height: h, seed: 92, format: 'rgba16float', scaleMode: 'linear',
        fill: (x, y, c, rng) => (c === 3 ? 0 : 0.3 + 1.5 * (y / h) * (0.5 + 0.5 * Math.cos(x * 0.2 + c)) + 0.05 * rng()),
      }));
      const plateRaw = depthRaw(env, w, h, 93);
      const depthPlate = own(rg16Texture(env, w, h, 94, (x, y) => Math.min(1, plateRaw(x, y) + 0.1)));
      bg.setSway({ uvMap, radiancePlate, depthPlate });
      outs.push(await renderTo(env, bg.mesh, s.worldW, s.worldH, 'rgba8unorm'));
      if (s.sway === 'on-then-off') {
        bg.setSway(null);
        outs.push(await renderTo(env, bg.mesh, s.worldW, s.worldH, 'rgba8unorm'));
        need(countDiff(outs[0], outs[1], 1.5 / 255) > 50, '拆下草木之后画面没变 —— 位移图 / 露出处没真正起作用');
      }
    } else {
      outs.push(await renderTo(env, bg.mesh, s.worldW, s.worldH, 'rgba8unorm'));
    }
    for (const o of outs) {
      assertFinite(o, '显示');
      need(countAbove(o, 0, 2 / 255) > o.length / 16, '显示:画面几乎全黑 —— 没画出东西');
    }
    return concat(outs);
  } finally {
    bg?.destroy();
    pass?.destroy();
    for (const t of [...extra, ...scene.owned]) t.destroy(true);
  }
}

function displayCase(name: string, s: DisplaySetup, tolerance = TOL_DISPLAY): ParityCase {
  return {
    name: P + name,
    width: s.worldW,
    height: s.worldH * (s.sway === 'on-then-off' ? 2 : 1),
    target: 'rgba8unorm',
    tolerance,
    build: produceOnly,
    produce: (env) => runDisplay(env, s),
  };
}

// ───────────────────────────── 用例

export const cases: ParityCase[] = [
  bakeCase('烘焙 · 0 盏灯(恒等锚:surf = 线性化原画)+ 调试视图 1 法线 / 2 albedo / 3 灯照度 / 4 线性化原画', {
    scene: SCENE_A,
    steps: [0, 1, 2, 3, 4].map((dbg) => (pass, ctx) => {
      pass.applyParams(sceneDef(ctx.k, { lights: [] }));
      pass.setDebug(dbg);
    }),
    check: (o) => {
      // 没有灯 ⇒ surf 逐位等于线性化原画,alpha(灯体占比)恒 0;灯照度视图全 0
      for (let i = 0; i < o[0].length; i += 4) {
        if (o[0][i] !== o[4][i] || o[0][i + 1] !== o[4][i + 1] || o[0][i + 2] !== o[4][i + 2] || o[0][i + 3] !== 0) {
          throw new Error(`0 盏灯时 surf ≠ 线性化原画(第 ${i >> 2} 个像素)`);
        }
      }
      need(countAbove(o[3], 0, 0) === 0, '0 盏灯时灯照度视图不是全 0');
      need(countAbove(o[0], 0, 0.02) > o[0].length / 8, '原画没采上');
      need(countDiff(o[1], o[2], 0.01) > o[1].length / 8, '法线视图与 albedo 视图一样 —— 纹理没绑对');
    },
  }),

  bakeCase('烘焙 · 五种灯各一(点 / 聚 / 单面面光 / 双面面光 / 平行 / 线)· 不投影 · 截断早退 · 强度 0 · 禁用灯', {
    scene: SCENE_A,
    steps: [
      (pass, ctx) => { pass.applyParams(sceneDef(ctx.k, { lights: kindsLights() })); pass.setDebug(0); },
      (pass) => pass.setDebug(3),
    ],
    check: (o) => {
      need(countAbove(o[1], 0, 0.05) > o[1].length / 8, '灯照度视图几乎全黑 —— 灯没算出来');
      need(countAbove(o[0], 3, 0) === 0, '没开灯体自发光,alpha 应恒 0');
    },
  }),

  bakeCase('烘焙 · 带影灯 ≤ 4(一张 slab,第二张指回第一张)+ 灯体自发光 / 光晕', {
    scene: SCENE_A,
    steps: [
      (pass, ctx) => pass.applyParams(sceneDef(ctx.k, {
        lights: kindsLights({ cast: true }).filter((l) => l.kind !== 'area'),
        emissive: { gain: 0.6, coreRadius: 0.15, haloRadius: 0.6, haloGain: 0.3 },
      })),
      (pass, ctx) => pass.applyParams(sceneDef(ctx.k, {
        lights: kindsLights({ cast: false }).filter((l) => l.kind !== 'area'),
        emissive: { gain: 0.6, coreRadius: 0.15, haloRadius: 0.6, haloGain: 0.3 },
      })),
    ],
    check: (o) => {
      need(countDiff(o[0], o[1], 1e-3) > 30, '带影 / 不带影画面一样 —— 线扫前缀没起作用');
      need(countAbove(o[0], 3, 1e-3) > 30, '灯体自发光没画出来(alpha 全 0)');
    },
  }),

  bakeCase('烘焙 · 带影灯 10 盏(两张 slab,第 9、10 盏超出回落不投影)· 反深度映射 · 俯角 50°', {
    scene: { ...SCENE_A, seed: 711, depthMapping: [1, 1.8, -0.9], tiltDeg: 50, wuPerQUnit: 240 },
    steps: [
      (pass, ctx) => pass.applyParams(sceneDef(ctx.k, {
        lights: randomLights(ctx.env, 10, 712, () => true),
        emissive: { gain: 0.4, coreRadius: 0.1, haloRadius: 0.5, haloGain: 0.25 },
      })),
      (pass) => pass.setDebug(3),
    ],
    check: (o) => need(countAbove(o[1], 0, 0.02) > o[1].length / 8, '灯照度视图几乎全黑'),
  }),

  bakeCase(`烘焙 · 满载 ${MAX_STATIC_LIGHTS} 盏随机(再多 3 盏被丢弃并告警)· 一半带影`, {
    scene: { ...SCENE_A, seed: 721, w: 64, h: 40, ppu: 28 },
    steps: [
      (pass, ctx) => pass.applyParams(sceneDef(ctx.k, {
        lights: randomLights(ctx.env, MAX_STATIC_LIGHTS + 3, 722, (i) => i % 2 === 0),
        emissive: { gain: 0.3, coreRadius: 0.1, haloRadius: 0.4, haloGain: 0.3 },
      })),
    ],
  }),

  bakeCase('烘焙 · 反光位 · 缺省材质(无遮罩)· 五种灯 · 细节法线在 9 wu 那级的淡出区', {
    scene: { ...SCENE_A, seed: 731, wuPerQUnit: 64 },
    steps: [
      (pass, ctx) => {
        pass.setSurfaceDefaults({ reflect: 1, roughness: 0.45, detail: 1, ripple: 1 });
        pass.applyParams(sceneDef(ctx.k, { lights: kindsLights({ reflect: true }) }));
      },
      (pass, ctx) => pass.applyParams(sceneDef(ctx.k, { lights: kindsLights({ reflect: false }) })),
      // 细节起伏加强 + 更糙:同一套灯,换一组缺省材质
      (pass, ctx) => {
        pass.setSurfaceDefaults({ reflect: 0.7, roughness: 0.7, detail: 2.5, ripple: 1 });
        pass.applyParams(sceneDef(ctx.k, { lights: kindsLights({ reflect: true }) }));
      },
    ],
    check: (o) => need(countDiff(o[0], o[1], 1e-3) > o[0].length / 16, '打不打反光位画面一样 —— 镜面项没起作用'),
  }),

  // 像素足迹 fp ≈ 0.045 × wuPerQUnit(中位,本合成场景实测):k = 8 ⇒ fp ≈ 0.36,雨点涟漪(波长 1.6)与
  // 1.8 wu 那级起伏正在淡出区里;k = 4 ⇒ fp ≈ 0.18,全部级都全开。k 再大涟漪整个淡没,
  // 「推时钟水面变了」就只剩细浪在变 —— 那样雨纹写错也抓不到(变异自检踩过)。
  bakeCase('烘焙 · 反光位 · 表面遮罩(水面 / 湿石板 / 不反光)· 雨纹与 1.8 wu 级在淡出区 · 时钟推进', {
    scene: { ...SCENE_A, seed: 741, wuPerQUnit: 8 },
    steps: [
      (pass, ctx) => {
        pass.setSurfaceMask(surfaceMask(ctx, 0.35));
        pass.setSurfaceDefaults({ reflect: 1, roughness: 0.45, detail: 1, ripple: 1.5 });
        pass.setTime(0.37);
        pass.applyParams(sceneDef(ctx.k, { lights: kindsLights({ reflect: true }) }));
      },
      (pass) => pass.setTime(1.91),
      // 摘掉遮罩:回到整张缺省材质
      (pass) => pass.setSurfaceMask(null),
    ],
    check: (o) => {
      need(countDiff(o[0], o[1], 1e-3) > 20, '推时钟之后水面没变 —— 雨纹没起作用');
      need(countDiff(o[0], o[2], 1e-3) > 20, '摘掉遮罩之后画面没变 —— 遮罩没起作用');
    },
  }),
  bakeCase('烘焙 · 反光位 · 水面用运行时缺省粗糙度 0.08 · 雨纹全开 · 时钟推进', {
    scene: { ...SCENE_A, seed: 745, wuPerQUnit: 4 },
    steps: [
      (pass, ctx) => {
        pass.setSurfaceMask(surfaceMask(ctx, SURFACE_DEFAULTS.water.roughness));
        pass.setTime(12.5);
        pass.applyParams(sceneDef(ctx.k, { lights: kindsLights({ reflect: true }) }));
      },
      (pass) => pass.setTime(12.9),
    ],
    check: (o) => need(countDiff(o[0], o[1], 1e-3) > 20, '推时钟之后水面没变 —— 雨纹没起作用'),
  }),

  bakeCase('烘焙 · 时段过滤(night / day / 不过滤)+ 同一实例改参重烘(带影 6 → 2 盏,slab 复用)', {
    scene: { ...SCENE_A, seed: 751 },
    steps: (() => {
      const phased: QLight[] = kindsLights({ cast: true }).slice(0, 6).map((l, i) => ({ ...l, phases: i % 2 ? ['night'] : ['day'] }));
      const emissive = { gain: 0.5, coreRadius: 0.2, haloRadius: 0.5, haloGain: 0.4 };
      return [
        (pass: SceneLightingPass, ctx: BakeCtx) => pass.applyParams(sceneDef(ctx.k, { lights: phased, emissive }), 'night'),
        (pass: SceneLightingPass, ctx: BakeCtx) => pass.applyParams(sceneDef(ctx.k, { lights: phased, emissive }), 'day'),
        (pass: SceneLightingPass, ctx: BakeCtx) => pass.applyParams(sceneDef(ctx.k, { lights: phased, emissive }), ''),
        (pass: SceneLightingPass, ctx: BakeCtx) => pass.applyParams(sceneDef(ctx.k, { lights: phased.slice(0, 2) }), ''),
      ];
    })(),
    check: (o) => need(countDiff(o[0], o[1], 1e-3) > o[0].length / 16, 'night / day 两拍画面一样 —— 时段过滤没起作用'),
  }),

  bakeCase('GI 体调试视图 · L2 · 折叠 · skyao 开 · 5 GI体 / 6 纯E / 7 棋盘 / 8 最近邻 / 9 skyao', {
    scene: SCENE_A,
    steps: giSteps({ mode: 2, shK: 9, binOb: 8, fold: 1, skyao: true, beta: 0.5 },
      [{ debug: 5 }, { debug: 6 }, { debug: 7 }, { debug: 8 }, { debug: 9 }]),
    check: (o) => need(countDiff(o[1], o[2], 1e-3) > 30, '棋盘视图与纯 E 一样 —— probeGridT 没起作用'),
  }),
  bakeCase('GI 体调试视图 · L1 · 不折叠 · skyao 关 · 定法线 0 / 1 / 2', {
    scene: SCENE_A,
    steps: giSteps({ mode: 1, shK: 9, binOb: 8, fold: 0, skyao: false, beta: -0.3 },
      [{ debug: 5 }, { debug: 6, fixedN: 1 }, { debug: 6, fixedN: 2 }, { debug: 8, fixedN: 2 }, { debug: 9 }]),
    check: (o) => {
      need(countDiff(o[1], o[2], 1e-3) > 30, '定法线 1 / 2 两档一样');
      // skyao 关:skyaoAt 恒 1
      for (let i = 0; i < o[4].length; i++) if (o[4][i] !== 1) throw new Error('skyao 关时视图 9 应恒为 1');
    },
  }),
  bakeCase('GI 体调试视图 · L4(25 系数)与八面体 16×16 · RT 模式钳到 L1', {
    scene: { ...SCENE_A, seed: 761 },
    steps: [
      ...giSteps({ mode: 2, shK: 25, binOb: 8, fold: 1, skyao: true, beta: 0 }, [{ debug: 6 }, { debug: 7 }]),
      (pass, ctx) => { pass.setProbeResources(probeResources(ctx, { mode: 3, shK: 9, binOb: 16, fold: 0, skyao: true, beta: 0 })); pass.setDebug(6); },
      (pass) => pass.setDebug(8),
      (pass, ctx) => { pass.setProbeResources(probeResources(ctx, { mode: 0, shK: 9, binOb: 8, fold: 1, skyao: true, beta: 0 })); pass.setDebug(5); },
    ],
  }),

  displayCase('显示 · 无雾 · 显示恒等(tonemap none)· 缓存与屏幕尺寸不同', {
    scene: SCENE_A, worldW: 96, worldH: 64,
    display: { ev: 0, tonemap: 'none' },
  }),
  displayCase('显示 · 高度雾 + reinhard + 白平衡 / 饱和 / 对比 / 暗部提升', {
    scene: { ...SCENE_A, seed: 781 }, worldW: 90, worldH: 60,
    display: { ev: 0.4, tonemap: 'reinhard', whiteKelvin: 5200, saturation: 0.7, contrast: 1.25, lift: 0.6, liftKelvin: 9000 },
    fog: { sigma: 0.7, scaleHeight: 0.45, baseHeight: -0.2, kelvin: 7500, scatter: 0.35 },
  }),
  displayCase('显示 · filmic · 负曝光 · 草木摆动接上(位移图 + 露出处缓存 / 深度)+ 雾', {
    scene: { ...SCENE_A, seed: 791 }, worldW: 96, worldH: 64,
    display: { ev: -0.8, tonemap: 'filmic', whiteKelvin: 7000, saturation: 1.3, contrast: 0.85, lift: 0.2, liftKelvin: 4000 },
    fog: { sigma: 0.5, scaleHeight: 0.6, baseHeight: 0.1, color: [0.6, 0.65, 0.8], scatter: 0.5 },
    sway: 'on',
  }),
  displayCase('显示 · 草木接上又拆下(回占位)· 无雾', {
    scene: { ...SCENE_A, seed: 801 }, worldW: 80, worldH: 56,
    display: { ev: 0.2, tonemap: 'reinhard' },
    sway: 'on-then-off',
  }),
  displayCase('整链 · 烘焙(带影灯 + 反光 + 光晕)→ 显示(雾 + filmic)', {
    scene: { ...SCENE_A, seed: 811, wuPerQUnit: 64 }, worldW: 96, worldH: 64,
    display: { ev: -0.5, tonemap: 'filmic', saturation: 1.1, contrast: 1.1 },
    fog: { sigma: 0.4, scaleHeight: 0.5, baseHeight: 0, kelvin: 8000, scatter: 0.3 },
    bake: {
      lights: [...kindsLights({ cast: true }).slice(0, 4), ...kindsLights({ reflect: true }).slice(4, 6)],
      emissive: { gain: 0.6, coreRadius: 0.15, haloRadius: 0.6, haloGain: 0.3 },
      surfaceMask: true,
    },
  }),
];

// 分组用例按每组 4 盏写(改 LIGHTS_PER_SLAB 时提醒这里的「两张 slab」用例要跟着改)
if (LIGHTS_PER_SLAB !== 4) throw new Error(`LIGHTS_PER_SLAB = ${LIGHTS_PER_SLAB},本文件的 slab 用例按 4 写的`);
