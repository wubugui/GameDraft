/** Authoring -> runtime boundary. All historical defaults are resolved here.
 * No asset mutation, random draws, simulation state, or UI dependencies.
 */
import type { VfxEmitterDef, VfxSimulationDef } from '../../data/types';
import contract from '../../data/vfxSimulationContract.json';

export type VfxEmitterProgram = Readonly<VfxSimulationDef>;

/** The effective old behavior, including previously inactive authored fields.
 * Materializing this plan is a lossless authoring operation, not an upgrade of physics.
 */
export function resolveEmitterProgram(def: VfxEmitterDef): VfxEmitterProgram {
  if (def.simulation) return { initialVelocity: 'configured', ...structuredClone(def.simulation) };
  const solver = def.behavior ? 'flock' : def.plate ? 'plate' : 'particle';
  return {
    solver,
    spawnPlacement: solver === 'plate' && def.spawn.shape?.kind === 'area' ? 'surface' : 'shape',
    initialVelocity: solver === 'plate' && def.spawn.shape?.kind === 'area' ? 'rest' : 'configured',
    influences: {
      sceneWind: solver !== 'flock', wind: solver === 'particle', airflow: false,
      stimulus: solver !== 'plate',
    },
    recycle: { mode: solver === 'plate' && def.plate?.replenish !== false ? 'airborne' : 'none' },
  };
}

/** New emitters opt into the public input contract; existing emitters use resolve above. */
export function newEmitterProgram(solver: VfxSimulationDef['solver']): VfxSimulationDef {
  return structuredClone(contract.newPrograms[solver]) as VfxSimulationDef;
}

/** Model switches reset known execution options but preserve unknown authored data. */
export function switchEmitterProgram(def: VfxEmitterDef, solver: VfxSimulationDef['solver']): VfxSimulationDef {
  const previous = resolveEmitterProgram(def), next = newEmitterProgram(solver);
  return { ...previous, ...next, influences: { ...previous.influences, ...next.influences }, recycle: { ...previous.recycle, ...next.recycle } };
}

/** Shared by runtime construction and the workbench. Invalid combinations cannot silently fall through. */
export function emitterProgramErrors(def: VfxEmitterDef): string[] {
  if (def.simulation === undefined) return []; // Existing documents retain their exact interpretation.
  if (!def.simulation || typeof def.simulation !== 'object' || Array.isArray(def.simulation)) return ['simulation 必须为对象'];
  const p = def.simulation, errors: string[] = [];
  if (!contract.solvers.includes(p.solver)) errors.push('simulation.solver 无效');
  if (!contract.spawnPlacements.includes(p.spawnPlacement)) errors.push('simulation.spawnPlacement 无效');
  if (p.surfaceRadius !== undefined && (!Number.isFinite(p.surfaceRadius) || p.surfaceRadius <= 0)) errors.push('simulation.surfaceRadius 必须为正数');
  if (p.initialVelocity !== undefined && !contract.initialVelocities.includes(p.initialVelocity)) errors.push('simulation.initialVelocity 无效');
  for (const k of contract.influenceKeys as (keyof VfxSimulationDef['influences'])[]) {
    if (typeof p.influences?.[k] !== 'boolean') errors.push(`simulation.influences.${k} 必须为布尔`);
  }
  for (const k of contract.optionalInfluenceKeys as (keyof VfxSimulationDef['influences'])[]) {
    if (p.influences?.[k] !== undefined && typeof p.influences[k] !== 'boolean') errors.push(`simulation.influences.${k} 必须为布尔`);
  }
  if (!contract.recycleModes.includes(p.recycle?.mode)) errors.push('simulation.recycle.mode 无效');
  for (const k of ['height', 'upwind'] as const) {
    const v = p.recycle?.[k];
    if (v !== undefined && (!Array.isArray(v) || v.length !== 2 || !v.every(n => Number.isFinite(n) && n >= 0) || v[0] > v[1])) {
      errors.push(`simulation.recycle.${k} 必须为非负递增区间`);
    }
  }
  if (p.solver === 'plate' && (!def.plate || typeof def.plate !== 'object' || Array.isArray(def.plate))) errors.push('薄片求解器缺少 plate 参数');
  if (p.solver === 'flock' && (!def.behavior || typeof def.behavior !== 'object' || Array.isArray(def.behavior))) errors.push('群体求解器缺少 behavior 参数');
  if (p.solver === 'flock' && (def.subOnly || p.spawnPlacement !== 'shape' || p.recycle?.mode !== 'none')) {
    errors.push('群体由巢管理出生与返回，不能作为子发射器或使用表面铺撒 / 补回');
  }
  if (p.solver === 'flock' && (p.influences?.sceneWind || p.influences?.wind || p.influences?.airflow)) {
    errors.push('群体运动模型不支持物理风输入；使用群体刺激响应');
  }
  if (p.solver === 'flock' && p.influences?.contact) errors.push('群体运动模型不支持接触冲量；使用群体刺激响应');
  return errors;
}

/** Effective capabilities for authoring. Inactive source fields stay in the document. */
export function emitterCapabilities(def: VfxEmitterDef) {
  const p = resolveEmitterProgram(def);
  return {
    ...p,
    initialVelocity: p.initialVelocity !== 'rest' && p.solver !== 'flock',
    genericMotion: p.solver === 'particle',
    turbulence: p.solver !== 'flock',
    collision: p.solver === 'particle',
    plate: p.solver === 'plate', flock: p.solver === 'flock',
    errors: emitterProgramErrors(def),
  };
}
