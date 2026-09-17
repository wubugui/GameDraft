/**
 * 光柱（体积光）的几何与信号——纯函数，零 Pixi、零挂钟（粒子工作台打包进页面用同一份）。
 *
 * ## 模型（制作人 2026-09-16 定：美术可控，不是物理积分）
 *
 * - **3D 模式**：M-world 里从 `from` 到 `to` 的一根**棱台**。截面是凸多边形（矩形 / 正 3–8 边形），
 *   源截面 + 张角沿轴线性张开。棱台 = (边数 + 2) 个半空间的交（侧面 + 两端），
 *   片元里视线与它求交是闭式的（逐平面解一次线性不等式），不步进。
 * - **2D 模式**：画面坐标里的一条梯形光带（起点 / 终点 + 首尾全宽）。
 *
 * 片元侧（`rendering/vfx/vfxBeamShaders.ts`）只拿这里算好的**帧**（原点 / 轴 / 截面基 / 半空间），
 * 不自己重建几何——帧只有这一份实现。CPU 侧（尘埃出生、尘埃被光柱照亮）直接调这里的局部坐标函数。
 *
 * ## 坐标
 *
 * 3D 一律 M-world、wu（铁律 0：视线与光柱求交在世界空间做）。画面点 + q 深度 → 世界点走
 * {@link sceneQAffine}：正交投影下"世界 ↔ (画面 x, 画面 y, q.z)"是可逆仿射，从 `VfxSpace` 的
 * `toScene` / `toQ` 探出来，field 与 planar 两种空间同一套。
 */
import type {
  VfxBeam2dDef, VfxBeam3dDef, VfxBeamBlend, VfxBeamDef, VfxBeamPulseDef, VfxBeamSort,
} from '../../data/types';
import contract from '../../data/vfxBeamContract.json';
import type { Vec3 } from '../../utils/sceneSpace';
import { sampleCurve } from './vfxCurve';
import type { VfxSpace } from './vfxSpace';

export const VFX_BEAM_CONTRACT = contract;
export const VFX_BEAM_MIN_SIDES = contract.polygonSides[0];
export const VFX_BEAM_MAX_SIDES = contract.polygonSides[1];
/** 半空间上限：侧面（≤ 8）+ 两端 */
export const VFX_BEAM_MAX_PLANES = VFX_BEAM_MAX_SIDES + 2;
/** 画面包络顶点上限：两圈截面顶点 */
export const VFX_BEAM_MAX_HULL = VFX_BEAM_MAX_SIDES * 2;
export const VFX_BEAM_MAX_CURVE_KEYS = contract.maxCurveKeys;
/** 光柱最短长度（wu / 画面 wu）：短于它当作退化，不画 */
export const VFX_BEAM_MIN_LENGTH = 1;

const D = contract.defaults;
const L = contract.limits;

// ------------------------------------------------------------------ 形状闸门

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, r: readonly number[]): boolean => isNum(v) && v >= r[0] && v <= r[1];
const isVec = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(isNum);

function colorErrors(v: unknown, key: string, out: string[]): void {
  if (!isVec(v, 3) || !v.every((c) => c >= 0 && c <= 1)) out.push(`${key} 必须为三个 0..1 的数`);
}

/**
 * 一根光柱的形状问题（空 = 合法）。运行时构造、工作台保存闸门、构建期校验器**同一套判据**
 * （Python 镜像 `tools/editor/shared/vfx_beam.py`，parity 测试钉着）。
 */
export function beamDefErrors(def: unknown): string[] {
  const out: string[] = [];
  if (!isObj(def)) return ['光柱必须为对象'];
  if (typeof def.id !== 'string' || !def.id) out.push('光柱 id 必须为非空字符串');
  if (!contract.modes.includes(def.mode as string)) out.push('mode 必须为 3d / 2d');
  if (def.mode === '3d') shape3dErrors(def.shape3d, out);
  if (def.mode === '2d') shape2dErrors(def.shape2d, out);
  colorErrors(def.color, 'color', out);
  if (def.colorEnd !== undefined) colorErrors(def.colorEnd, 'colorEnd', out);
  if (!inRange(def.intensity, L.intensity)) out.push(`intensity 必须在 ${L.intensity[0]}..${L.intensity[1]}`);
  if (def.alongCurve !== undefined) {
    const c = def.alongCurve;
    if (!Array.isArray(c) || c.length === 0 || c.length > VFX_BEAM_MAX_CURVE_KEYS
      || !c.every((k, i) => isVec(k, 2) && k[0] >= 0 && k[0] <= 1 && inRange(k[1], L.alongValue)
        && (i === 0 || k[0] >= (c[i - 1] as number[])[0]))) {
      out.push(`alongCurve 必须为 1..${VFX_BEAM_MAX_CURVE_KEYS} 个 [t(0..1 递增), 倍率(${L.alongValue[0]}..${L.alongValue[1]})]`);
    }
  }
  for (const k of ['edgeSoftness', 'thickness', 'contactSoftWu'] as const) {
    if (def[k] !== undefined && !inRange(def[k], L[k])) out.push(`${k} 必须在 ${L[k][0]}..${L[k][1]}`);
  }
  if (def.blend !== undefined && !contract.blends.includes(def.blend as string)) out.push('blend 必须为 add / screen / normal');
  if (def.sort !== undefined && !contract.sorts.includes(def.sort as string)) out.push('sort 必须为 depth / background / foreground');
  for (const k of ['fadeIn', 'fadeOut'] as const) {
    if (def[k] !== undefined && !inRange(def[k], L.fadeSeconds)) out.push(`${k} 必须在 ${L.fadeSeconds[0]}..${L.fadeSeconds[1]} 秒`);
  }
  if (def.noise !== undefined) {
    const n = def.noise;
    if (!isObj(n)) out.push('noise 必须为对象');
    else {
      if (!inRange(n.strength, L.noiseStrength)) out.push('noise.strength 必须在 0..1');
      if (!isNum(n.scaleWu) || n.scaleWu <= 0) out.push('noise.scaleWu 必须为正数');
      if (n.velocity !== undefined && !isVec(n.velocity, 3)) out.push('noise.velocity 必须为三个数');
    }
  }
  if (def.cookie !== undefined) {
    const c = def.cookie;
    if (!isObj(c)) out.push('cookie 必须为对象');
    else {
      if (typeof c.image !== 'string' || !c.image) out.push('cookie.image 必须为图片路径');
      if (c.strength !== undefined && !inRange(c.strength, L.cookieStrength)) out.push('cookie.strength 必须在 0..1');
      if (c.scale !== undefined && !(isVec(c.scale, 2) && c.scale.every((s) => s > 0))) out.push('cookie.scale 必须为两个正数');
      if (c.offset !== undefined && !isVec(c.offset, 2)) out.push('cookie.offset 必须为两个数');
      if (c.rotationDeg !== undefined && !isNum(c.rotationDeg)) out.push('cookie.rotationDeg 必须为数');
    }
  }
  if (def.pulse !== undefined) {
    const p = def.pulse;
    if (!isObj(p)) out.push('pulse 必须为对象');
    else {
      if (!contract.pulseKinds.includes(p.kind as string)) out.push('pulse.kind 必须为 flicker / breathe');
      if (!inRange(p.hz, L.pulseHz)) out.push(`pulse.hz 必须在 ${L.pulseHz[0]}..${L.pulseHz[1]}`);
      if (!inRange(p.amount, L.pulseAmount)) out.push('pulse.amount 必须在 0..1');
    }
  }
  return out;
}

/**
 * 发射器对光柱的引用问题（出生形状「光柱体积」/ 外观「被光柱照亮」）。`beamIds` = 本效果里合法的光柱 id，
 * `solver` = 发射器的有效求解器（`resolveEmitterProgram(def).solver`）。
 */
export function emitterBeamRefErrors(em: unknown, beamIds: ReadonlySet<string>, solver: string): string[] {
  const out: string[] = [];
  if (!isObj(em)) return out;
  const shape = isObj(em.spawn) ? em.spawn.shape : undefined;
  if (isObj(shape) && shape.kind === 'beam') {
    if (typeof shape.beam !== 'string' || !shape.beam) out.push('出生形状「光柱体积」没有指定光柱');
    else if (!beamIds.has(shape.beam)) out.push(`出生形状引用的光柱「${shape.beam}」不存在`);
    if (solver !== 'particle') out.push('「光柱体积」出生形状只对普通粒子求解器生效');
    if (shape.along !== undefined && !(isVec(shape.along, 2) && shape.along[0] >= 0 && shape.along[1] <= 1
      && shape.along[0] <= shape.along[1])) {
      out.push('spawn.shape.along 必须为 0..1 的递增区间');
    }
  }
  const lit = isObj(em.appearance) ? em.appearance.beamLit : undefined;
  if (lit !== undefined) {
    if (!isObj(lit)) out.push('appearance.beamLit 必须为对象');
    else {
      if (typeof lit.beam !== 'string' || !lit.beam) out.push('「被光柱照亮」没有指定光柱');
      else if (!beamIds.has(lit.beam)) out.push(`「被光柱照亮」引用的光柱「${lit.beam}」不存在`);
      if (lit.gain !== undefined && !inRange(lit.gain, L.beamLitGain)) {
        out.push(`appearance.beamLit.gain 必须在 ${L.beamLitGain[0]}..${L.beamLitGain[1]}`);
      }
    }
  }
  return out;
}

/**
 * 整份效果里与光柱有关的全部问题（空 = 合法）：每根光柱的形状、光柱 id 重复、发射器对光柱的引用。
 * 运行时构造（`VfxInstanceSim`）遇到就抛；工作台保存闸门与校验器（Python 镜像 `vfx_beam.effect_beam_errors`）拒存。
 * `solverOf` 给发射器的有效求解器（运行时传 `resolveEmitterProgram`，免得本模块反向依赖程序解析）。
 */
export function effectBeamErrors(effect: unknown, solverOf: (em: Record<string, unknown>) => string): string[] {
  const out: string[] = [];
  if (!isObj(effect)) return out;
  const beams = effect.beams;
  const ids = new Set<string>();
  if (beams !== undefined) {
    if (!Array.isArray(beams)) out.push('beams 必须为数组');
    else {
      beams.forEach((b, i) => {
        const id = isObj(b) && typeof b.id === 'string' && b.id ? b.id : `#${i}`;
        for (const e of beamDefErrors(b)) out.push(`光柱「${id}」: ${e}`);
        if (isObj(b) && typeof b.id === 'string' && b.id) {
          if (ids.has(b.id)) out.push(`光柱 id「${b.id}」重复`);
          ids.add(b.id);
        }
      });
    }
  }
  if (Array.isArray(effect.emitters)) {
    effect.emitters.forEach((em, i) => {
      if (!isObj(em)) return;
      const id = typeof em.id === 'string' && em.id ? em.id : `#${i}`;
      for (const e of emitterBeamRefErrors(em, ids, solverOf(em))) out.push(`发射器「${id}」: ${e}`);
    });
  }
  return out;
}

function shape3dErrors(s: unknown, out: string[]): void {
  if (!isObj(s)) { out.push('3D 光柱缺少 shape3d'); return; }
  if (!isVec(s.to, 3)) out.push('shape3d.to 必须为三个数');
  if (s.from !== undefined && !isVec(s.from, 3)) out.push('shape3d.from 必须为三个数');
  if (isVec(s.to, 3) && (s.from === undefined || isVec(s.from, 3))) {
    const f = (s.from as number[] | undefined) ?? [0, 0, 0];
    const t = s.to as number[];
    if (Math.hypot(t[0] - f[0], t[1] - f[1], t[2] - f[2]) < VFX_BEAM_MIN_LENGTH) out.push('shape3d 起点与终点重合');
  }
  const sec = s.section;
  if (!isObj(sec) || !contract.sectionKinds.includes(sec.kind as string)) out.push('shape3d.section.kind 必须为 rect / polygon');
  else if (sec.kind === 'rect') {
    if (!isNum(sec.width) || sec.width <= 0 || !isNum(sec.height) || sec.height <= 0) out.push('矩形截面的 width / height 必须为正数');
  } else if (!Number.isInteger(sec.sides) || (sec.sides as number) < VFX_BEAM_MIN_SIDES || (sec.sides as number) > VFX_BEAM_MAX_SIDES
    || !isNum(sec.radius) || sec.radius <= 0) {
    out.push(`正多边形截面的 sides 必须为 ${VFX_BEAM_MIN_SIDES}..${VFX_BEAM_MAX_SIDES} 的整数、radius 必须为正数`);
  }
  if (s.spreadDeg !== undefined && !(isVec(s.spreadDeg, 2) && s.spreadDeg.every((a) => inRange(a, L.spreadDeg)))) {
    out.push(`shape3d.spreadDeg 必须为两个 ${L.spreadDeg[0]}..${L.spreadDeg[1]} 的角度`);
  }
  if (s.rollDeg !== undefined && !isNum(s.rollDeg)) out.push('shape3d.rollDeg 必须为数');
}

function shape2dErrors(s: unknown, out: string[]): void {
  if (!isObj(s)) { out.push('2D 光柱缺少 shape2d'); return; }
  if (!isVec(s.to, 2)) out.push('shape2d.to 必须为两个数');
  if (s.from !== undefined && !isVec(s.from, 2)) out.push('shape2d.from 必须为两个数');
  if (isVec(s.to, 2) && (s.from === undefined || isVec(s.from, 2))) {
    const f = (s.from as number[] | undefined) ?? [0, 0];
    const t = s.to as number[];
    if (Math.hypot(t[0] - f[0], t[1] - f[1]) < VFX_BEAM_MIN_LENGTH) out.push('shape2d 起点与终点重合');
  }
  if (!(isVec(s.width, 2) && s.width.every((w) => w >= 0) && Math.max(s.width[0], s.width[1]) > 0)) {
    out.push('shape2d.width 必须为两个非负数且不全为 0');
  }
  if (s.occludeByDepth !== undefined && typeof s.occludeByDepth !== 'boolean') out.push('shape2d.occludeByDepth 必须为布尔');
}

// ------------------------------------------------------------------ 缺省解析

/** 渲染 / 尘埃要用的数值（缺省已套上）。形状闸门过了才调，不再做范围判断。 */
export interface VfxBeamLook {
  color: readonly [number, number, number];
  colorEnd: readonly [number, number, number];
  intensity: number;
  edgeSoftness: number;
  thickness: number;
  contactSoftWu: number;
  blend: VfxBeamBlend;
  sort: VfxBeamSort;
  fadeIn: number;
  fadeOut: number;
}

export function resolveBeamLook(def: VfxBeamDef): VfxBeamLook {
  return {
    color: def.color,
    colorEnd: def.colorEnd ?? def.color,
    intensity: def.intensity,
    edgeSoftness: def.edgeSoftness ?? D.edgeSoftness,
    thickness: def.thickness ?? D.thickness,
    contactSoftWu: def.contactSoftWu ?? D.contactSoftWu,
    blend: def.blend ?? (D.blend as VfxBeamBlend),
    sort: def.sort ?? (D.sort as VfxBeamSort),
    fadeIn: def.fadeIn ?? D.fadeIn,
    fadeOut: def.fadeOut ?? D.fadeOut,
  };
}

// ------------------------------------------------------------------ 3D 帧

export interface VfxBeam3dFrame {
  readonly kind: '3d';
  /** 源截面中心（M-world wu） */
  origin: Vec3;
  /** 轴（单位向量，起点 → 终点） */
  axis: Vec3;
  /** 截面基：宽方向 / 高方向（单位向量，已含 rollDeg） */
  right: Vec3;
  up: Vec3;
  length: number;
  polygon: boolean;
  /** 截面边数（矩形 4） */
  sides: number;
  /** 矩形：源半宽 / 半高、每 wu 轴长张开多少 */
  halfW0: number;
  halfH0: number;
  tanW: number;
  tanH: number;
  /** 正多边形：源外接圆半径、每 wu 轴长张开多少 */
  radius0: number;
  tanR: number;
  /** 半空间 `(n.x, n.y, n.z, c)`：体内 ⇔ n·P + c ≤ 0；前 `sides` 个是侧面，后两个是起点 / 终点端面 */
  planes: Float32Array;
  planeCount: number;
  /** 两圈截面顶点（源一圈 + 终点一圈，各 `sides` 个，xyz 连排）——画面包络用 */
  corners: Float32Array;
}

const DEG = Math.PI / 180;

function norm3(v: Vec3): number {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l > 0) { v[0] /= l; v[1] /= l; v[2] /= l; }
  return l;
}

/** 正多边形第 k 条边的外法线角（截面基里；k = 0 朝 +up，平边在上） */
function polygonNormalAngle(k: number, sides: number): number {
  return Math.PI / 2 + (2 * Math.PI * k) / sides;
}

/** 3D 帧。长度退化返回 null（不画、不出生）。 */
export function resolveBeam3dFrame(shape: VfxBeam3dDef, anchor: Readonly<Vec3>): VfxBeam3dFrame | null {
  const f = shape.from ?? [0, 0, 0];
  const origin: Vec3 = [anchor[0] + f[0], anchor[1] + f[1], anchor[2] + f[2]];
  const axis: Vec3 = [shape.to[0] - f[0], shape.to[1] - f[1], shape.to[2] - f[2]];
  const length = norm3(axis);
  if (!(length >= VFX_BEAM_MIN_LENGTH)) return null;
  // 宽方向缺省水平：right = Y × axis；光柱竖直（与 Y 平行）时退到世界 +X
  let right: Vec3 = [axis[2], 0, -axis[0]];
  if (norm3(right) < 1e-6) right = [1, 0, 0];
  const up: Vec3 = [
    axis[1] * right[2] - axis[2] * right[1],
    axis[2] * right[0] - axis[0] * right[2],
    axis[0] * right[1] - axis[1] * right[0],
  ];
  norm3(up);
  const roll = (shape.rollDeg ?? 0) * DEG;
  if (roll !== 0) {
    const c = Math.cos(roll), s = Math.sin(roll);
    const r0 = right, u0 = up;
    right = [r0[0] * c + u0[0] * s, r0[1] * c + u0[1] * s, r0[2] * c + u0[2] * s];
    const u1: Vec3 = [-r0[0] * s + u0[0] * c, -r0[1] * s + u0[1] * c, -r0[2] * s + u0[2] * c];
    up[0] = u1[0]; up[1] = u1[1]; up[2] = u1[2];
  }
  const spread = shape.spreadDeg ?? [0, 0];
  const sec = shape.section;
  const polygon = sec.kind === 'polygon';
  const sides = polygon ? sec.sides : 4;
  const halfW0 = polygon ? 0 : sec.width / 2;
  const halfH0 = polygon ? 0 : sec.height / 2;
  const tanW = Math.tan((spread[0] * DEG) / 2);
  const tanH = polygon ? 0 : Math.tan((spread[1] * DEG) / 2);
  const radius0 = polygon ? sec.radius : 0;
  const tanR = polygon ? tanW : 0;
  const planeCount = sides + 2;
  const planes = new Float32Array(planeCount * 4);
  const setPlane = (i: number, nx: number, ny: number, nz: number, offset: number) => {
    // n·(P − origin) − offset ≤ 0  ⇒  c = −n·origin − offset
    planes[i * 4] = nx; planes[i * 4 + 1] = ny; planes[i * 4 + 2] = nz;
    planes[i * 4 + 3] = -(nx * origin[0] + ny * origin[1] + nz * origin[2]) - offset;
  };
  if (!polygon) {
    // 右 / 左 / 上 / 下：±right·x − t·tan − half ≤ 0
    setPlane(0, right[0] - axis[0] * tanW, right[1] - axis[1] * tanW, right[2] - axis[2] * tanW, halfW0);
    setPlane(1, -right[0] - axis[0] * tanW, -right[1] - axis[1] * tanW, -right[2] - axis[2] * tanW, halfW0);
    setPlane(2, up[0] - axis[0] * tanH, up[1] - axis[1] * tanH, up[2] - axis[2] * tanH, halfH0);
    setPlane(3, -up[0] - axis[0] * tanH, -up[1] - axis[1] * tanH, -up[2] - axis[2] * tanH, halfH0);
  } else {
    const ca = Math.cos(Math.PI / sides);
    for (let k = 0; k < sides; k++) {
      const phi = polygonNormalAngle(k, sides);
      const cx = Math.cos(phi), cy = Math.sin(phi);
      const kt = ca * tanR;
      setPlane(k,
        right[0] * cx + up[0] * cy - axis[0] * kt,
        right[1] * cx + up[1] * cy - axis[1] * kt,
        right[2] * cx + up[2] * cy - axis[2] * kt,
        ca * radius0);
    }
  }
  setPlane(sides, -axis[0], -axis[1], -axis[2], 0);
  setPlane(sides + 1, axis[0], axis[1], axis[2], length);
  const corners = new Float32Array(sides * 2 * 3);
  for (let ring = 0; ring < 2; ring++) {
    const t = ring === 0 ? 0 : length;
    const cxw = origin[0] + axis[0] * t, cyw = origin[1] + axis[1] * t, czw = origin[2] + axis[2] * t;
    for (let k = 0; k < sides; k++) {
      let lx: number, ly: number;
      if (!polygon) {
        const hw = halfW0 + t * tanW, hh = halfH0 + t * tanH;
        lx = (k === 0 || k === 3) ? hw : -hw;
        ly = k < 2 ? hh : -hh;
      } else {
        const r = radius0 + t * tanR;
        const th = polygonNormalAngle(k, sides) + Math.PI / sides;
        lx = r * Math.cos(th); ly = r * Math.sin(th);
      }
      const o = (ring * sides + k) * 3;
      corners[o] = cxw + right[0] * lx + up[0] * ly;
      corners[o + 1] = cyw + right[1] * lx + up[1] * ly;
      corners[o + 2] = czw + right[2] * lx + up[2] * ly;
    }
  }
  return {
    kind: '3d', origin, axis, right, up, length, polygon, sides,
    halfW0, halfH0, tanW, tanH, radius0, tanR, planes, planeCount, corners,
  };
}

/** 光柱内一点的局部量：沿长度 t01、截面归一化坐标 (u, v)、离边远近 edge（0 = 在边上，1 = 中心） */
export interface VfxBeamLocal {
  t01: number;
  u: number;
  v: number;
  edge: number;
}

/** 世界点在 3D 光柱里的局部量；在体外返回 false（`out` 照样写，edge 可能为负）。 */
export function beam3dLocal(f: VfxBeam3dFrame, x: number, y: number, z: number, out: VfxBeamLocal): boolean {
  const dx = x - f.origin[0], dy = y - f.origin[1], dz = z - f.origin[2];
  const t = dx * f.axis[0] + dy * f.axis[1] + dz * f.axis[2];
  const lx = dx * f.right[0] + dy * f.right[1] + dz * f.right[2];
  const ly = dx * f.up[0] + dy * f.up[1] + dz * f.up[2];
  out.t01 = t / f.length;
  if (!f.polygon) {
    const hw = Math.max(1e-6, f.halfW0 + t * f.tanW), hh = Math.max(1e-6, f.halfH0 + t * f.tanH);
    out.u = lx / hw; out.v = ly / hh;
    out.edge = Math.min(1 - Math.abs(out.u), 1 - Math.abs(out.v));
  } else {
    const r = Math.max(1e-6, f.radius0 + t * f.tanR);
    const a = r * Math.cos(Math.PI / f.sides);
    let e = Infinity;
    for (let k = 0; k < f.sides; k++) {
      const phi = polygonNormalAngle(k, f.sides);
      e = Math.min(e, (a - (lx * Math.cos(phi) + ly * Math.sin(phi))) / a);
    }
    out.u = lx / r; out.v = ly / r;
    out.edge = e;
  }
  return t >= 0 && t <= f.length && out.edge >= 0;
}

/**
 * 在 3D 光柱体积里均匀取一点（光柱尘埃出生）。`along` = 沿长度 0..1 的一段。
 * 截面随 t 张开 ⇒ 按截面积拒绝采样 t；截面内矩形直接均匀、正多边形在外接圆里拒绝。取不到（极端退化）返回 false。
 */
export function sampleBeam3dPoint(
  f: VfxBeam3dFrame, next: () => number, along: readonly [number, number], out: Vec3,
): boolean {
  const a0 = Math.max(0, Math.min(1, along[0])), a1 = Math.max(a0, Math.min(1, along[1]));
  const areaAt = (t: number) => f.polygon
    ? (f.radius0 + t * f.tanR) ** 2
    : (f.halfW0 + t * f.tanW) * (f.halfH0 + t * f.tanH);
  const aMax = Math.max(areaAt(a0 * f.length), areaAt(a1 * f.length), 1e-9);
  for (let tries = 0; tries < 32; tries++) {
    const t = (a0 + (a1 - a0) * next()) * f.length;
    if (next() * aMax > areaAt(t)) continue;
    let lx: number, ly: number;
    if (!f.polygon) {
      lx = (next() * 2 - 1) * (f.halfW0 + t * f.tanW);
      ly = (next() * 2 - 1) * (f.halfH0 + t * f.tanH);
    } else {
      const r = f.radius0 + t * f.tanR;
      lx = (next() * 2 - 1) * r; ly = (next() * 2 - 1) * r;
      const ap = r * Math.cos(Math.PI / f.sides);
      let inside = true;
      for (let k = 0; k < f.sides && inside; k++) {
        const phi = polygonNormalAngle(k, f.sides);
        if (lx * Math.cos(phi) + ly * Math.sin(phi) > ap) inside = false;
      }
      if (!inside) continue;
    }
    out[0] = f.origin[0] + f.axis[0] * t + f.right[0] * lx + f.up[0] * ly;
    out[1] = f.origin[1] + f.axis[1] * t + f.right[1] * lx + f.up[1] * ly;
    out[2] = f.origin[2] + f.axis[2] * t + f.right[2] * lx + f.up[2] * ly;
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ 2D 帧

export interface VfxBeam2dFrame {
  readonly kind: '2d';
  /** 起点（画面 wu） */
  ox: number;
  oy: number;
  /** 沿长度的单位方向 / 横向单位法线（画面） */
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  length: number;
  halfW0: number;
  halfW1: number;
  /** 四角（起点左右、终点右左；画面 xy 连排） */
  corners: Float32Array;
}

/** 2D 帧（`anchorScene` = 实例锚点投到画面上那一点）。长度退化返回 null。 */
export function resolveBeam2dFrame(shape: VfxBeam2dDef, anchorScene: { x: number; y: number }): VfxBeam2dFrame | null {
  const f = shape.from ?? [0, 0];
  const ox = anchorScene.x + f[0], oy = anchorScene.y + f[1];
  const ex = anchorScene.x + shape.to[0], ey = anchorScene.y + shape.to[1];
  const length = Math.hypot(ex - ox, ey - oy);
  if (!(length >= VFX_BEAM_MIN_LENGTH)) return null;
  const dx = (ex - ox) / length, dy = (ey - oy) / length;
  const nx = -dy, ny = dx;
  const halfW0 = shape.width[0] / 2, halfW1 = shape.width[1] / 2;
  const corners = new Float32Array([
    ox + nx * halfW0, oy + ny * halfW0,
    ox - nx * halfW0, oy - ny * halfW0,
    ex - nx * halfW1, ey - ny * halfW1,
    ex + nx * halfW1, ey + ny * halfW1,
  ]);
  return { kind: '2d', ox, oy, dx, dy, nx, ny, length, halfW0, halfW1, corners };
}

/** 画面点在 2D 光带里的局部量（u = 横向归一化、v = 沿长度 = t01）；在带外返回 false。 */
export function beam2dLocal(f: VfxBeam2dFrame, sx: number, sy: number, out: VfxBeamLocal): boolean {
  const px = sx - f.ox, py = sy - f.oy;
  const t01 = (px * f.dx + py * f.dy) / f.length;
  const hw = f.halfW0 + (f.halfW1 - f.halfW0) * Math.max(0, Math.min(1, t01));
  const lat = px * f.nx + py * f.ny;
  out.t01 = t01;
  out.v = t01;
  out.u = hw > 1e-6 ? lat / hw : (Math.abs(lat) < 1e-6 ? 0 : Infinity);
  out.edge = 1 - Math.abs(out.u);
  return t01 >= 0 && t01 <= 1 && out.edge >= 0;
}

/** 在 2D 光带里均匀取一个画面点（写进 out.x / out.y）。 */
export function sampleBeam2dPoint(
  f: VfxBeam2dFrame, next: () => number, along: readonly [number, number], out: { x: number; y: number },
): boolean {
  const a0 = Math.max(0, Math.min(1, along[0])), a1 = Math.max(a0, Math.min(1, along[1]));
  const wAt = (v: number) => f.halfW0 + (f.halfW1 - f.halfW0) * v;
  const wMax = Math.max(wAt(a0), wAt(a1), 1e-9);
  for (let tries = 0; tries < 32; tries++) {
    const v = a0 + (a1 - a0) * next();
    const w = wAt(v);
    if (next() * wMax > w) continue;
    const lat = (next() * 2 - 1) * w;
    out.x = f.ox + f.dx * v * f.length + f.nx * lat;
    out.y = f.oy + f.dy * v * f.length + f.ny * lat;
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ 亮度

function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** 边缘遮罩：离边 `edge`（0..1）过软度 smoothstep。GLSL 同式（`bmEdgeMask`）。 */
export function beamEdgeMask(edge: number, softness: number): number {
  if (edge < 0) return 0;
  return softness > 1e-4 ? smoothstep(0, softness, edge) : 1;
}

/** 整数哈希 → [0,1)（亮度起伏的随机值；确定性） */
function hash01(n: number): number {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * 亮度起伏倍率（1 = 不动）。`breathe`：正弦慢呼吸；`flicker`：按频率取随机值、之间平滑插值。
 * 只吃模拟钟 `time` 与光柱种子（不读挂钟）⇒ 同种子同 dt 串逐位可复现。
 */
export function beamPulseFactor(p: VfxBeamPulseDef | undefined, time: number, seed: number): number {
  if (!p || !(p.amount > 0) || !(p.hz > 0)) return 1;
  const a = Math.min(1, p.amount);
  if (p.kind === 'breathe') return 1 - a * (0.5 - 0.5 * Math.cos(2 * Math.PI * (p.hz * time + seed)));
  const x = p.hz * time + seed * 1000;
  const i = Math.floor(x), fr = x - i;
  const u = fr * fr * (3 - 2 * fr);
  const salt = Math.floor(seed * 65536);
  const n = hash01(i + salt * 7919) * (1 - u) + hash01(i + 1 + salt * 7919) * u;
  return 1 - a * n;
}

/** 沿长度的颜色（sRGB，起止线性插值）；GLSL 同式。 */
export function beamColorAt(look: VfxBeamLook, t01: number, out: [number, number, number]): [number, number, number] {
  const k = Math.max(0, Math.min(1, t01));
  for (let c = 0; c < 3; c++) out[c] = look.color[c] + (look.colorEnd[c] - look.color[c]) * k;
  return out;
}

/**
 * 光柱在某点给尘埃的亮度倍率：强度 × 边缘遮罩 × 沿长度曲线 × 亮度起伏 × 淡入淡出。
 * （噪声 / 图案 / 厚度只在光柱片元里——尘埃自己一闪一闪，叠不叠那层看不出来。）
 */
export function beamGainAt(def: VfxBeamDef, look: VfxBeamLook, local: VfxBeamLocal, pulse: number, fade: number): number {
  return look.intensity * beamEdgeMask(local.edge, look.edgeSoftness)
    * sampleCurve(def.alongCurve, local.t01) * pulse * fade;
}

// ------------------------------------------------------------------ 画面 ↔ 世界

/**
 * 正交投影下 世界 ↔ (画面 x, 画面 y, q.z) 的可逆仿射（`fwd` / `inv` 各 12 个数，按行 `[a b c d]` = a·x + b·y + c·z + d）。
 * 从空间的 `toScene` / `toQ` 探出来（field / planar 同一套）。退化（不可逆）返回 null。
 */
export interface VfxSceneQAffine {
  fwd: Float64Array;
  inv: Float64Array;
}

export function sceneQAffine(space: VfxSpace): VfxSceneQAffine | null {
  const s = { x: 0, y: 0 };
  const q: Vec3 = [0, 0, 0];
  const w: Vec3 = [0, 0, 0];
  space.toScene(w, s); space.toQ(w, q);
  const sx0 = s.x, sy0 = s.y, qz0 = q[2];
  const fwd = new Float64Array(12);
  for (let a = 0; a < 3; a++) {
    w[0] = a === 0 ? 1 : 0; w[1] = a === 1 ? 1 : 0; w[2] = a === 2 ? 1 : 0;
    space.toScene(w, s); space.toQ(w, q);
    fwd[a] = s.x - sx0; fwd[4 + a] = s.y - sy0; fwd[8 + a] = q[2] - qz0;
  }
  fwd[3] = sx0; fwd[7] = sy0; fwd[11] = qz0;
  const m = [fwd[0], fwd[1], fwd[2], fwd[4], fwd[5], fwd[6], fwd[8], fwd[9], fwd[10]];
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (!(Math.abs(det) > 1e-12)) return null;
  const id = 1 / det;
  const i3 = [
    (m[4] * m[8] - m[5] * m[7]) * id, (m[2] * m[7] - m[1] * m[8]) * id, (m[1] * m[5] - m[2] * m[4]) * id,
    (m[5] * m[6] - m[3] * m[8]) * id, (m[0] * m[8] - m[2] * m[6]) * id, (m[2] * m[3] - m[0] * m[5]) * id,
    (m[3] * m[7] - m[4] * m[6]) * id, (m[1] * m[6] - m[0] * m[7]) * id, (m[0] * m[4] - m[1] * m[3]) * id,
  ];
  const inv = new Float64Array(12);
  for (let r = 0; r < 3; r++) {
    inv[r * 4] = i3[r * 3]; inv[r * 4 + 1] = i3[r * 3 + 1]; inv[r * 4 + 2] = i3[r * 3 + 2];
    inv[r * 4 + 3] = -(i3[r * 3] * fwd[3] + i3[r * 3 + 1] * fwd[7] + i3[r * 3 + 2] * fwd[11]);
  }
  return { fwd, inv };
}

/**
 * 画面凸包（Andrew 单调链），输入 `pts` 为 xy 连排的 `n` 个点，逆时针写进 `out`，返回点数。
 * 3D 光柱正交投影到画面的轮廓 = 两圈截面顶点的凸包（凸多面体的投影是它顶点投影的凸包）。
 */
export function convexHull2d(pts: Float32Array | number[], n: number, out: Float32Array): number {
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  idx.sort((a, b) => (pts[a * 2] - pts[b * 2]) || (pts[a * 2 + 1] - pts[b * 2 + 1]));
  const cross = (o: number, a: number, b: number) =>
    (pts[a * 2] - pts[o * 2]) * (pts[b * 2 + 1] - pts[o * 2 + 1]) - (pts[a * 2 + 1] - pts[o * 2 + 1]) * (pts[b * 2] - pts[o * 2]);
  const hull: number[] = [];
  for (const i of idx) {
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], i) <= 0) hull.pop();
    hull.push(i);
  }
  const lower = hull.length + 1;
  for (let k = idx.length - 2; k >= 0; k--) {
    const i = idx[k];
    while (hull.length >= lower && cross(hull[hull.length - 2], hull[hull.length - 1], i) <= 0) hull.pop();
    hull.push(i);
  }
  hull.pop();
  const m = Math.min(hull.length, out.length / 2);
  for (let k = 0; k < m; k++) { out[k * 2] = pts[hull[k] * 2]; out[k * 2 + 1] = pts[hull[k] * 2 + 1]; }
  return m;
}
