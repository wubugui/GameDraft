/** A reusable kinematic air source. Runtime actors and the workbench use the same sampler.
 * Movement supplies direction and air speed; lifting/rotation comes from the receiver's
 * aerodynamics. The first sample, a stationary source, and teleportation supply no airflow.
 */
import type { Vec3 } from '../../utils/sceneSpace';
import { createFieldRuntime, type VfxFieldRuntime } from './vfxFields';

export class VfxMotionAirflow {
  readonly field: VfxFieldRuntime;
  private previous: Vec3 | null = null;
  constructor(tag: string, private readonly options = { radius: 100, height: 12, gain: 1, maxSpeed: 1200 }) {
    this.field = createFieldRuntime({ kind: 'airflow', tag, radius: options.radius, strength: 0, direction: [1, 0, 0] }, [0, 0, 0], `airflow:${tag}`);
  }
  reset(): void { this.previous = null; this.field.def.strength = 0; }
  sample(foot: Vec3 | null, dt: number, metric = 1): VfxFieldRuntime {
    const f = this.field, p = this.previous;
    f.def.strength = 0;
    if (!foot) { this.previous = null; return f; }
    const scale = Number.isFinite(metric) && metric > 0 ? metric : 1;
    f.pos[0] = foot[0]; f.pos[1] = foot[1] + this.options.height * scale; f.pos[2] = foot[2];
    f.def.radius = this.options.radius * scale;
    if (p && Number.isFinite(dt) && dt > 0) {
      const dx = foot[0] - p[0], dy = foot[1] - p[1], dz = foot[2] - p[2];
      const distance = Math.hypot(dx, dy, dz), speed = distance / (dt * scale);
      if (distance > 0 && speed <= this.options.maxSpeed) {
        f.dir![0] = dx / distance; f.dir![1] = dy / distance; f.dir![2] = dz / distance;
        // Public field velocity is M-world wu/s. Only size and teleport detection use metric.
        f.def.strength = distance / dt * this.options.gain;
      }
    }
    if (!this.previous) this.previous = [...foot];
    else { this.previous[0] = foot[0]; this.previous[1] = foot[1]; this.previous[2] = foot[2]; }
    return f;
  }
}
