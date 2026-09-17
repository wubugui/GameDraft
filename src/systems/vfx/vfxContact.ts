/** Kinematic contact input, separate from air velocity and continuous forces.
 * All source geometry and velocities are M-world wu. Receivers own their state.
 */
import type { Vec3 } from '../../utils/sceneSpace';

export interface VfxKinematicContact {
  from: Vec3;
  to: Vec3;
  velocity: Vec3;
  radius: number;
}

interface ContactBody {
  x: Float32Array; y: Float32Array; z: Float32Array;
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
}

/** Swept point/sphere contact. Removes inward relative velocity (inelastic impact).
 * The sweep is sliced per fixed substep; a fast foot cannot tunnel between frames.
 * No impulse for a stationary source, a separating receiver, or a distant particle.
 * velocityScale converts the thin-plate solver's physical velocity to M-world.
 */
export function resolveKinematicContacts(
  sources: readonly VfxKinematicContact[], b: ContactBody, i: number,
  h: number, start: number, end: number, velocityScale = 1,
): boolean {
  let hit = false;
  for (const c of sources) {
    const speed = Math.hypot(...c.velocity);
    if (!(speed > 0) || !(c.radius > 0)) continue;
    const sx = c.to[0] - c.from[0], sy = c.to[1] - c.from[1], sz = c.to[2] - c.from[2];
    const cx = c.from[0] + sx * start, cy = c.from[1] + sy * start, cz = c.from[2] + sz * start;
    let dx = b.x[i] - cx, dy = b.y[i] - cy, dz = b.z[i] - cz;
    const vx = b.vx[i] * velocityScale, vy = b.vy[i] * velocityScale, vz = b.vz[i] * velocityScale;
    const rx = vx * h - sx * (end - start), ry = vy * h - sy * (end - start), rz = vz * h - sz * (end - start);
    const dist2 = dx * dx + dy * dy + dz * dz, radius2 = c.radius * c.radius;
    if (dist2 > radius2) {
      const a = rx * rx + ry * ry + rz * rz;
      const halfB = dx * rx + dy * ry + dz * rz;
      const discriminant = halfB * halfB - a * (dist2 - radius2);
      if (a < 1e-12 || halfB >= 0 || discriminant < 0) continue;
      const t = (-halfB - Math.sqrt(discriminant)) / a;
      if (t < 0 || t > 1) continue;
      dx += rx * t; dy += ry * t; dz += rz * t;
    }
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) continue;
    const nx = dx / d, ny = dy / d, nz = dz / d;
    const approach = (vx - c.velocity[0]) * nx + (vy - c.velocity[1]) * ny + (vz - c.velocity[2]) * nz;
    if (approach >= 0) continue;
    const impulse = -approach / velocityScale;
    b.vx[i] += nx * impulse; b.vy[i] += ny * impulse; b.vz[i] += nz * impulse;
    // Resolve only existing overlap, not the entire swept endpoint (which would
    // move the particle twice when its owner integrates the substep).
    if (dist2 < radius2) {
      const push = c.radius - Math.sqrt(dist2);
      b.x[i] += nx * push; b.y[i] += ny * push; b.z[i] += nz * push;
    }
    hit = true;
  }
  return hit;
}

/** Rounded toe proxy: a spherical cap 12 wu high and about 44 wu across at ground.
 * The cap's contact normal supplies the small upward impulse; no added lift force.
 * No animation/audio dependency: muted footsteps and unmarked clips still collide.
 */
export class VfxMotionContact {
  private previous: Vec3 | null = null;
  private readonly contact: VfxKinematicContact = { from: [0, 0, 0], to: [0, 0, 0], velocity: [0, 0, 0], radius: 26 };
  constructor(private readonly options = { radius: 26, height: 12, maxSpeed: 1200 }) {}
  reset(): void { this.previous = null; }
  sample(foot: Vec3 | null, dt: number, metric = 1): VfxKinematicContact | null {
    const previous = this.previous;
    if (!foot) { this.reset(); return null; }
    this.previous = [...foot];
    if (!previous || !(dt > 0) || !Number.isFinite(dt)) return null;
    const s = Number.isFinite(metric) && metric > 0 ? metric : 1;
    const dx = foot[0] - previous[0], dy = foot[1] - previous[1], dz = foot[2] - previous[2];
    const speed = Math.hypot(dx, dy, dz) / (dt * s);
    if (!(speed > 0) || speed > this.options.maxSpeed) return null;
    const c = this.contact, offset = (this.options.height - this.options.radius) * s;
    c.from[0] = previous[0]; c.from[1] = previous[1] + offset; c.from[2] = previous[2];
    c.to[0] = foot[0]; c.to[1] = foot[1] + offset; c.to[2] = foot[2];
    c.velocity[0] = dx / dt; c.velocity[1] = dy / dt; c.velocity[2] = dz / dt;
    c.radius = this.options.radius * s;
    return c;
  }
}
