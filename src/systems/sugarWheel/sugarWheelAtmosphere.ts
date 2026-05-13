/**
 * 糖画转盘专属氛围脚本：阶段调度 + 转盘 opcode。
 * 与 ActionRegistry 解耦，只在转盘子系统内工作。
 */

import type {
  SugarWheelAtmosphereGroup,
  SugarWheelAtmosphereStep,
  SugarWheelAtmospherePhaseName,
  SugarWheelInstance,
} from './types';
import {
  type MinigameScriptContext,
  type MinigameScriptRunner,
  type OpcodeRegistry,
  coreOpcodes,
  createMinigameScriptRunner,
} from '../minigameScript';
import { sectorLayoutFromInstance } from './sugarWheelSpinPhysics';

// ---------------------------------------------------------------------------
// 宿主 API（Scene 注入，opcode 读取）
// ---------------------------------------------------------------------------

export interface SugarWheelAtmosphereHost {
  showSpeech(role: string, text: string, durationMs?: number): void;
  getWheelGeomAngleMod(): number;
  getSpinOmega(): number;
  getInstance(): SugarWheelInstance;
}

// ---------------------------------------------------------------------------
// 转盘专属 opcode
// ---------------------------------------------------------------------------

function sugarWheelOpcodes(host: SugarWheelAtmosphereHost): OpcodeRegistry<SugarWheelAtmosphereStep> {
  return {
    say(step, ctx) {
      const role = step.role ?? 'child_a';
      let text = step.text ?? '';
      if (!text && step.pool) {
        const arr = ctx.vars[step.pool];
        if (arr && arr.length > 0) {
          text = arr[Math.floor(ctx.rng() * arr.length)];
        }
      }
      if (!text) {
        const slot = step.slot ?? '_line';
        text = ctx.slots[slot] ?? '';
      }
      if (text) {
        host.showSpeech(role, text, step.durationMs);
      }
    },

    when_near_sector(step, ctx, runChildren) {
      const sid = step.sectorId ?? '';
      const buf = Math.max(0, step.degBuffer ?? 15);
      const inst = host.getInstance();
      const layout = sectorLayoutFromInstance(inst);
      const sectorIdx = inst.sectors.findIndex((s) => s.id === sid);
      if (sectorIdx < 0) return;

      const center = layout.left0 + (sectorIdx + 0.5) * layout.step;
      const phi = host.getWheelGeomAngleMod();
      let diff = phi - center;
      diff = diff - Math.round(diff / (Math.PI * 2)) * (Math.PI * 2);
      const inRange = Math.abs(diff) * (180 / Math.PI) <= buf;

      if (inRange && step.then?.length) {
        return runChildren(step.then);
      }
      if (!inRange && step.else?.length) {
        return runChildren(step.else);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 阶段调度器
// ---------------------------------------------------------------------------

/** 慢转判定阈值（rad/s），低于此值认为进入 slowing 阶段。 */
const SLOWING_OMEGA_THRESHOLD = 2.5;

export class SugarWheelAtmosphereScheduler {
  private group: SugarWheelAtmosphereGroup | null = null;
  private runner: MinigameScriptRunner<SugarWheelAtmosphereStep> | null = null;
  private ctx: MinigameScriptContext | null = null;
  private currentPhase: SugarWheelAtmospherePhaseName | null = null;
  private host: SugarWheelAtmosphereHost;

  constructor(host: SugarWheelAtmosphereHost) {
    this.host = host;
  }

  /** 每次 load 或新一轮旋转前调用；从 groups 里加权随机选一组。 */
  selectGroup(instance: SugarWheelInstance): void {
    this.cancel();
    const groups = instance.atmosphereGroups;
    if (!groups || groups.length === 0) {
      this.group = null;
      return;
    }
    this.group = weightedPick(groups, (g) => Math.max(0, g.weight ?? 1));
    this.ctx = {
      rng: Math.random,
      vars: { ...(this.group?.vars ?? {}) },
      slots: {},
    };
    const registry: OpcodeRegistry<SugarWheelAtmosphereStep> = {
      ...coreOpcodes<SugarWheelAtmosphereStep>(),
      ...sugarWheelOpcodes(this.host),
    };
    this.runner = createMinigameScriptRunner(registry, this.ctx);
    this.currentPhase = null;
  }

  /** 由 Scene 在 phase 变化或 update 中调用，传入当前 spin phase。 */
  notifyPhase(phase: SugarWheelAtmospherePhaseName): void {
    if (phase === this.currentPhase) return;
    this.currentPhase = phase;
    if (!this.group || !this.runner) return;
    const steps = this.group[phase];
    if (steps && steps.length > 0) {
      this.runner.runPhase(steps);
    }
  }

  tick(dt: number): void {
    this.runner?.tick(dt);
  }

  cancel(): void {
    this.runner?.cancel();
    this.currentPhase = null;
  }

  /** 根据 Scene 的 phase + omega 映射出四阶段名。 */
  static resolveAtmospherePhase(
    scenePhase: string,
    absOmega: number,
  ): SugarWheelAtmospherePhaseName | null {
    if (scenePhase !== 'spinning') return null;
    if (absOmega > SLOWING_OMEGA_THRESHOLD) return 'spinning';
    return 'slowing';
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function weightedPick<T>(items: T[], weightFn: (t: T) => number): T {
  let total = 0;
  for (const t of items) total += weightFn(t);
  if (total <= 0) return items[0];
  let r = Math.random() * total;
  for (const t of items) {
    r -= weightFn(t);
    if (r <= 0) return t;
  }
  return items[items.length - 1];
}
