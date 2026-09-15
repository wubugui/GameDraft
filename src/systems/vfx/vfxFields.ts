/** Spatial inputs shared by motion solvers. Velocity and acceleration remain distinct. */
import type { VfxFieldDef } from '../../data/types';
import type { Vec3 } from '../../utils/sceneSpace';

export const VFX_PULSE_MIN_SECONDS = 0.12;
export interface VfxFieldRuntime {
  def: VfxFieldDef;
  pos: Vec3;
  remaining: number;
  dir: Vec3 | null;
  handle?: string;
}
export interface VfxStimulusResponse {
  fear: Record<string, number> | null;
  attract: Record<string, number> | null;
  accel: number;
}
export function fieldFalloff(f: VfxFieldRuntime, x: number, y: number, z: number): number {
  const dx = x - f.pos[0], dy = y - f.pos[1], dz = z - f.pos[2];
  const r = Math.hypot(dx, dy, dz);
  if (r >= f.def.radius) return 0;
  const t = 1 - r / f.def.radius;
  return f.def.strength * t * t;
}
export function createFieldRuntime(def: VfxFieldDef, at: Vec3, handle?: string): VfxFieldRuntime {
  const dur = def.duration && def.duration > 0 ? def.duration : VFX_PULSE_MIN_SECONDS;
  let dir: Vec3 | null = null;
  if ((def.kind === 'wind' || def.kind === 'airflow') && def.direction) {
    const l = Math.hypot(def.direction[0], def.direction[1], def.direction[2]) || 1;
    dir = [def.direction[0] / l, def.direction[1] / l, def.direction[2] / l];
  }
  return { def, pos: [at[0], at[1], at[2]], remaining: handle ? Infinity : dur, dir, handle };
}

/** Adds to an existing double-precision acceleration accumulator, preserving field order.
 * In particular, do not sum separately then add once: that changes existing float rounding.
 */
export function accumulateFieldAcceleration(
  fields: readonly VfxFieldRuntime[], wind: boolean, stimulus: VfxStimulusResponse | null,
  x: number, y: number, z: number, seed: number, out: Vec3,
): void {
  if (wind) for (const f of fields) {
    if (f.def.kind !== 'wind' || !f.dir) continue;
    const s = fieldFalloff(f, x, y, z);
    if (s <= 0) continue;
    out[0] += f.dir[0] * s; out[1] += f.dir[1] * s; out[2] += f.dir[2] * s;
  }
  if (stimulus) for (const f of fields) {
    let w = 0;
    if (f.def.kind === 'fear') w = stimulus.fear?.[f.def.tag] ?? 0;
    else if (f.def.kind === 'attract') w = -(stimulus.attract?.[f.def.tag] ?? 0);
    if (w === 0) continue;
    const s = fieldFalloff(f, x, y, z);
    if (s <= 0) continue;
    let dx = x - f.pos[0], dy = y - f.pos[1], dz = z - f.pos[2];
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-4) { dx = Math.cos(seed * 6.2831853); dy = 0; dz = Math.sin(seed * 6.2831853); }
    else { dx /= d; dy /= d; dz /= d; }
    const a = w * s * stimulus.accel;
    out[0] += dx * a; out[1] += dy * a; out[2] += dz * a;
  }
}

/** Adds local air velocity in wu/s, for the solver's aerodynamic model. */
export function accumulateAirflow(fields: readonly VfxFieldRuntime[], x: number, y: number, z: number, out: Vec3): void {
  for (const f of fields) {
    if (f.def.kind !== 'airflow' || !f.dir) continue;
    const s = fieldFalloff(f, x, y, z);
    if (s <= 0) continue;
    out[0] += f.dir[0] * s; out[1] += f.dir[1] * s; out[2] += f.dir[2] * s;
  }
}
