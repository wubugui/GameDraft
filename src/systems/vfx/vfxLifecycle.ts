/** Lifetime / replacement controller. Solvers report leaving bounds; only this owner
 * selects a new spawn location. Callbacks initialize solver-specific physical state.
 */
import type { VfxSimulationDef } from '../../data/types';
import { sampleSceneWind, type SceneWindParams } from '../../utils/sceneWind';
import type { Vec3 } from '../../utils/sceneSpace';
import { CONFINE_FADE_IN_S, type ConfineField } from './vfxConfine';
import { footWeight, pickAreaSurface, type PlateArea } from './vfxSurface';
import type { VfxRng } from './vfxRandom';
import type { VfxSpace } from './vfxSpace';

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
}
const REPLENISH_HEIGHT: [number, number] = [140, 340];
const REPLENISH_UPWIND: [number, number] = [0, 260];
const LOST_DROP_WU = 320;
const CONFINE_REPLENISH_PER_SUBSTEP = 4;

export class VfxParticleLifecycle {
  killed = 0;
  private budget = 0;
  wind: SceneWindParams | null = null;
  windTime = 0;
  private readonly projected = { x: 0, y: 0 };
  constructor(readonly input: VfxLifecycleInput) {}
  beginStep(): void { this.killed = 0; this.budget = CONFINE_REPLENISH_PER_SUBSTEP; }
  private kill(i: number): void { this.input.body.alive[i] = 0; this.killed++; }
  /** true means this particle has no physical update this substep. */
  beforeParticle(i: number, h: number): boolean {
    const { area, body: b, policy } = this.input;
    if (!area.confine || b.fadeRate[i] === 0) return false;
    b.fade[i] -= b.fadeRate[i] * h;
    if (b.fade[i] <= 0) {
      if (this.input.clampDeadFade || policy.mode !== 'none') b.fade[i] = 0;
      if (policy.mode === 'none' || this.input.consume?.(i)) { this.kill(i); return true; }
      // Failed sampling keeps the invisible slot for a later attempt; never leak population.
      if (this.budget > 0) { this.budget--; this.replace(i); }
      return true;
    }
    if (b.fade[i] >= 1) { b.fade[i] = 1; b.fadeRate[i] = 0; }
    return false;
  }
  afterMotion(i: number, x: number, y: number, z: number): boolean {
    const { area: a, space: sp, policy, detectLoss } = this.input;
    if (!detectLoss) return false;
    let lost = y < a.floorY - LOST_DROP_WU;
    if (!lost && !a.confine) {
      // Surface replenishment bounds the patch of ground, not its screen-space
      // silhouette: lifting a particle must not be mistaken for leaving the patch.
      sp.toScene([x, policy.mode === 'surface' ? sp.groundY(x, z) : y, z], this.projected);
      const mx = (a.maxX - a.minX) * 0.35 + 60, my = (a.maxY - a.minY) * 0.35 + 60;
      lost = this.projected.x < a.minX - mx || this.projected.x > a.maxX + mx
        || this.projected.y < a.minY - my || this.projected.y > a.maxY + my;
    }
    if (!lost) return false;
    if (policy.mode === 'none' || this.input.consume?.(i) || !this.replace(i)) this.kill(i);
    return true;
  }
  replace(i: number): boolean {
    const { space, area, rng, policy, fallSpeed, body: b } = this.input;
    if (policy.mode === 'none') return false;
    const surf = pickAreaSurface(space, area, rng);
    if (!surf) return false;
    if (policy.mode === 'surface') {
      this.input.place(i, surf);
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
    if (area.confine) { b.fade[i] = 0; b.fadeRate[i] = -1 / CONFINE_FADE_IN_S; }
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
