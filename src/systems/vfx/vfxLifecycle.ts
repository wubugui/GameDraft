/** Lifetime / replacement controller. Solvers report leaving bounds; only this owner
 * selects a new spawn location. Callbacks initialize solver-specific physical state.
 */
import type { VfxSimulationDef } from '../../data/types';
import { sampleSceneWind, type SceneWindParams } from '../../utils/sceneWind';
import type { Vec3 } from '../../utils/sceneSpace';
import {
  CONFINE_EXIT_FADE_S, CONFINE_FADE_IN_S, distanceToPolygonEdge, pointInPolygon, type ConfineField,
} from './vfxConfine';
import { footWeight, pickAreaSurface, type PlateArea } from './vfxSurface';
import type { VfxRng } from './vfxRandom';
import type { VfxSpace } from './vfxSpace';
import type { VfxViewRect } from './vfxSim';

type Surface = NonNullable<ReturnType<typeof pickAreaSurface>>;
interface Body { alive: Uint8Array; fade: Float32Array; fadeRate: Float32Array }
export interface VfxLifecycleInput {
  space: VfxSpace;
  area: PlateArea;
  body: Body;
  rng: VfxRng;
  policy: VfxSimulationDef['recycle'];
  /** Older plate effects detect leaving bounds even when replacement is disabled. */
  detectLoss: boolean;
  clampDeadFade: boolean;
  fallSpeed: number;
  place(i: number, surface: Surface): void;
  launch(i: number, at: Vec3, velocity: Vec3): void;
  /**
   * 回收之前问一句：这一颗是不是"不能以新的样子回来"（燃着的纸被挪走 = 这一格作废，见 `vfxPlateBurn`）。
   * 返回 true ⇒ 直接收掉、不补回。缺省没有 = 一律可补回（与改动前逐位相同）。
   */
  consume?(i: number): boolean;
  /**
   * 这一颗此刻是不是贴在物件（外壳：石头、崖面…）上（薄片：接触态 Shell）。贴在物件上的按它**自己**落在画面上的
   * 位置判在不在那片地上——物件正下方的地面投到画面上常在那片地外面，按地面点判会把钉在那片地里石头上的纸
   * 算成"离开了"（2026-09-26 实测：280 张被这样误判，补回把池子补空、那片地堆了一倍的纸）。
   * 缺省没有 / 不在物件上 = 按正下方地面点（飞得高不算离开）。
   */
  onObject?(i: number): boolean;
}
const REPLENISH_HEIGHT: [number, number] = [140, 340];
const REPLENISH_UPWIND: [number, number] = [0, 260];
const LOST_DROP_WU = 320;
const CONFINE_REPLENISH_PER_SUBSTEP = 4;
/**
 * surface 补回的多边形发射区域：正下方地面点离开多边形超过这么远（画面 wu）才算吹离了这片地。
 * 不用包围盒放宽——细长斜带的包围盒放宽后几乎是整张图，吹出带子的纸永远不算出界、永远不回来。
 */
const SURFACE_LOST_MARGIN = 80;
/** 判"出了画面"时画面四边往外让的量（画面 wu）：纸本身有大小，压线时还看得见一半 */
const VIEW_MARGIN = 40;

export class VfxParticleLifecycle {
  killed = 0;
  private budget = 0;
  wind: SceneWindParams | null = null;
  windTime = 0;
  /** 镜头此刻看得见的矩形（场景坐标，每子步由模拟写入）；null = 没有镜头，吹离的纸就地淡出 */
  view: VfxViewRect | null = null;
  /**
   * 按密度补的地面区域（见 `VfxInstanceSim.refillPatch`）：那片地上该有几张 / 最近数到几张。
   * 够数时吹走的纸不回那片地、收回备用。null = 不按密度补（其余一切逐位同前）
   */
  patchTarget: number | null = null;
  patchCount = 0;
  /** 最近一次清点时这张在不在那片地上（清点之间离开 / 补回时就地增减 patchCount，不等下次清点） */
  patchFlags: Uint8Array | null = null;
  private readonly projected = { x: 0, y: 0 };
  constructor(readonly input: VfxLifecycleInput) {}
  beginStep(): void { this.killed = 0; this.budget = CONFINE_REPLENISH_PER_SUBSTEP; }
  private kill(i: number): void { this.input.body.alive[i] = 0; this.killed++; }
  /** true means this particle has no physical update this substep. */
  beforeParticle(i: number, h: number): boolean {
    const { body: b, policy } = this.input;
    // 淡入淡出只有两处会开：限定区域（边带 / 出框），与 surface 补回的多边形发射区域（吹离淡出、补回淡入）。
    // 其余粒子 fadeRate 恒 0，逐位同改动前。
    if (b.fadeRate[i] === 0) return false;
    b.fade[i] -= b.fadeRate[i] * h;
    if (b.fade[i] <= 0) {
      if (this.input.clampDeadFade || policy.mode !== 'none') b.fade[i] = 0;
      this.leavePatch(i);
      if (policy.mode === 'none' || this.input.consume?.(i) || this.patchFull()) { this.kill(i); return true; }
      // Failed sampling keeps the invisible slot for a later attempt; never leak population.
      if (this.budget > 0) { this.budget--; this.replace(i); }
      return true;
    }
    if (b.fade[i] >= 1) { b.fade[i] = 1; b.fadeRate[i] = 0; }
    return false;
  }
  afterMotion(i: number, x: number, y: number, z: number): boolean {
    const { area: a, space: sp, policy, detectLoss, body: b } = this.input;
    if (!detectLoss) return false;
    let lost = y < a.floorY - LOST_DROP_WU;
    if (!lost && !a.confine) {
      // Surface replenishment bounds the patch of ground, not its screen-space
      // silhouette: lifting a particle must not be mistaken for leaving the patch.
      // 贴在物件上的按自己的位置：它就在那儿，正下方的地面可能投到别处
      const own = policy.mode !== 'surface' || this.input.onObject?.(i) === true;
      sp.toScene([x, own ? y : sp.groundY(x, z), z], this.projected);
      const px = this.projected.x, py = this.projected.y;
      if (policy.mode === 'surface' && a.poly) {
        if (pointInPolygon(a.poly, px, py) || distanceToPolygonEdge(a.poly, px, py) <= SURFACE_LOST_MARGIN) return false;
        // 吹离了铺纸的那片地
        if (!this.view) {
          // 没有镜头（工作台 / 测试）：边飞边淡出，淡完由 beforeParticle 在这片地上补回并淡入
          if (b.fadeRate[i] <= 0) b.fadeRate[i] = 1 / CONFINE_EXIT_FADE_S;
          return false;
        }
        lost = true;
      } else {
        const mx = (a.maxX - a.minX) * 0.35 + 60, my = (a.maxY - a.minY) * 0.35 + 60;
        lost = px < a.minX - mx || px > a.maxX + mx || py < a.minY - my || py > a.maxY + my;
      }
    }
    if (!lost) return false;
    // 有镜头时，要拿走的粒子只要还在画面里就不动它（出界、掉下崖都一样，不论补回 / 收掉）：
    // 玩家眼前的东西不凭空消失、不在一条看不见的线上被拿走（制作人 2026-09-26）。出了画面才处理
    if (!a.confine && this.onScreen(x, y, z)) return false;
    this.leavePatch(i);
    if (policy.mode === 'none' || this.input.consume?.(i)) { this.kill(i); return true; }
    // 那片地已经够数（按密度补的地面区域）：吹走的这张不回那片地，收回备用
    if (this.patchFull()) { this.kill(i); return true; }
    // 挑不到落点不许回收（回收 = 总数一张张漏光）：隐身留着，下个子步由 beforeParticle 再试
    if (!this.replace(i)) { b.fade[i] = 0; b.fadeRate[i] = 1 / CONFINE_EXIT_FADE_S; }
    return true;
  }
  /** 粒子此刻在不在画面里（按粒子自己的位置，四边各让 VIEW_MARGIN）；没有镜头 = 不在 */
  private onScreen(x: number, y: number, z: number): boolean {
    const v = this.view;
    if (!v) return false;
    this.input.space.toScene([x, y, z], this.projected);
    const qx = this.projected.x, qy = this.projected.y;
    return qx > v.minX - VIEW_MARGIN && qx < v.maxX + VIEW_MARGIN && qy > v.minY - VIEW_MARGIN && qy < v.maxY + VIEW_MARGIN;
  }
  /** 这一颗此刻算不算在那片地上（与 afterMotion 同一判据；按密度补清点用） */
  onPatch(i: number, x: number, y: number, z: number): boolean {
    const { area: a, space: sp } = this.input;
    if (!a.poly) return false;
    sp.toScene([x, this.input.onObject?.(i) === true ? y : sp.groundY(x, z), z], this.projected);
    return pointInPolygon(a.poly, this.projected.x, this.projected.y);
  }
  private patchFull(): boolean {
    return this.patchTarget !== null && this.patchCount >= this.patchTarget;
  }
  private leavePatch(i: number): void {
    const f = this.patchFlags;
    if (f && f[i]) { f[i] = 0; this.patchCount--; }
  }
  /**
   * 睡着没醒的纸（求解器跳过了 afterMotion）：surface 补回的多边形区域、且有镜头时，也按 afterMotion 同一判据查——
   * 吹到那片地外面躺下 / 挂在物件上的纸，镜头一走开就收回补上（不然附着顶住的纸永远不醒、永远不回来）。
   */
  settled(i: number, x: number, y: number, z: number): void {
    const { area: a, policy } = this.input;
    if (policy.mode !== 'surface' || !a.poly || a.confine || !this.view) return;
    this.afterMotion(i, x, y, z);
  }
  replace(i: number): boolean {
    const { space, area, rng, policy, fallSpeed, body: b } = this.input;
    if (policy.mode === 'none') return false;
    const surf = pickAreaSurface(space, area, rng);
    if (!surf) return false;
    if (policy.mode === 'surface') {
      this.input.place(i, surf);
      if (this.patchFlags && !this.patchFlags[i]) { this.patchFlags[i] = 1; this.patchCount++; }
    } else {
      const s = space.metricAt(surf.p[0], surf.p[2]);
      const cf = area.confine;
      let hReal: number;
      if (policy.height) hReal = rng.pair(policy.height, 200);
      else if (cf) hReal = rng.range(0.25 * fallSpeed, fallSpeed);
      else hReal = rng.pair(REPLENISH_HEIGHT, 200);
      if (cf?.ceiling !== null && cf?.ceiling !== undefined) hReal = Math.min(hReal, Math.max(0, cf.ceiling - cf.ceilingBand));
      const at: Vec3 = [surf.p[0], space.groundY(surf.p[0], surf.p[2]) + hReal * s, surf.p[2]];
      const vel: Vec3 = [0, 0, 0];
      const wind = this.wind;
      if (wind) {
        let up = rng.pair(policy.upwind ?? REPLENISH_UPWIND, 0) * s;
        if (cf) up = confinedUpwind(space, cf, at, wind, up, rng);
        at[0] -= wind.dirX * up; at[2] -= wind.dirZ * up;
        sampleSceneWind(wind, this.windTime, at[0], at[2], hReal, vel);
        const g = wind.gainVfx * (cf ? footWeight(space, cf, at[0], at[2]) : 1);
        vel[0] *= g; vel[2] *= g;
      }
      this.input.launch(i, at, vel);
    }
    // 限定区域、以及 surface 补回（纸在地上凭空冒出来最扎眼）都淡入；空中补回的照旧当场出现
    if (area.confine || policy.mode === 'surface') { b.fade[i] = 0; b.fadeRate[i] = -1 / CONFINE_FADE_IN_S; }
    else { b.fade[i] = 1; b.fadeRate[i] = 0; }
    return true;
  }
}

function confinedUpwind(space: VfxSpace, cf: ConfineField, at: Vec3, wind: SceneWindParams, up: number, rng: VfxRng): number {
  for (let k = 0; k < 3 && up > 1; k++, up *= 0.5) {
    if (rng.next() < footWeight(space, cf, at[0] - wind.dirX * up, at[2] - wind.dirZ * up)) return up;
  }
  return 0;
}
