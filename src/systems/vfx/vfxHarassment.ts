import type { VfxEmitterRuntime } from './vfxSim';
import type { Vec3 } from '../../utils/sceneSpace';

/** 读模拟的真实个体；不以巢/发射器原点代替接触，不把视觉数量当攻击倍率。 */
export function flockHarassmentRate(emitter: VfxEmitterRuntime, player: Vec3): number {
  const h = emitter.def.behavior?.harassment;
  if (!h || !emitter.active || emitter.flock?.state !== 'airborne') return 0;
  if (![h.radius, h.height, h.attackPerSecond].every(Number.isFinite)
    || h.radius <= 0 || h.height < 0 || h.attackPerSecond <= 0) return 0;
  const p = emitter.p;
  for (let i = 0; i < p.cap; i++) {
    if (!p.alive[i]) continue;
    const dx = p.x[i] - player[0], dy = p.y[i] - player[1] - h.height, dz = p.z[i] - player[2];
    if (dx * dx + dy * dy + dz * dz <= h.radius * h.radius) return h.attackPerSecond;
  }
  return 0;
}
