import type { GameContext, IGameSystem, ScenarioCatalogEntry, ScenarioCatalogFile } from '../data/types';
import type { FlagStore } from './FlagStore';

/** 与主编辑器 `SCENARIO_PHASE_STATUSES` 一致；非法值仅在 dev 下警告 */
const SCENARIO_STATUS_SUGGESTED = new Set(['pending', 'active', 'done', 'locked']);

/** 单 phase 在存档中的形状（与叙事文档一致） */
export interface ScenarioPhasePersisted {
  status: string;
  outcome?: string | number | boolean | null;
}

/**
 * 按 scenarioId 分桶的叙事局部状态；不参与 FlagStore。
 * 持久化经 IGameSystem.serialize 进入存档。
 */
export class ScenarioStateManager implements IGameSystem {
  /** scenarioId -> phaseKey -> 状态 */
  private byScenario: Map<string, Map<string, ScenarioPhasePersisted>> = new Map();
  private flagStore: FlagStore | null = null;
  private catalog: ScenarioCatalogEntry[] = [];

  /** 运行时配置：用于 exposes 写入全局 flag */
  configureRuntime(flagStore: FlagStore, catalog: ScenarioCatalogFile | null): void {
    this.flagStore = flagStore;
    this.catalog = catalog?.scenarios && Array.isArray(catalog.scenarios) ? catalog.scenarios : [];
  }

  init(_ctx: GameContext): void {}

  update(_dt: number): void {}

  destroy(): void {
    this.byScenario.clear();
  }

  /**
   * 清单中该 phase 的 `requires`（同 scenario 内须先 done 的 phase 名）。
   */
  getCatalogPhaseRequires(scenarioId: string, phase: string): string[] {
    const sid = scenarioId.trim();
    const ph = phase.trim();
    const entry = this.catalog.find((c) => c.id === sid);
    const raw = entry?.phases?.[ph]?.requires;
    if (!Array.isArray(raw)) return [];
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }

  setScenarioPhase(
    scenarioId: string,
    phase: string,
    payload: { status: string; outcome?: string | number | boolean | null },
  ): void {
    const sid = scenarioId.trim();
    const ph = phase.trim();
    if (!sid || !ph) return;

    if (import.meta.env.DEV) {
      const entry = this.catalog.find((c) => c.id === sid);
      if (entry?.phases && !(ph in entry.phases)) {
        console.warn(
          `[ScenarioStateManager] setScenarioPhase: phase "${ph}" 未出现在 scenario "${sid}" 的 scenarios.json 清单中`,
        );
      }
      const st0 = payload.status.trim();
      if (st0 && !SCENARIO_STATUS_SUGGESTED.has(st0)) {
        console.warn(
          `[ScenarioStateManager] setScenarioPhase: 非建议 status "${st0}"（建议 pending|active|done|locked）`,
        );
      }
      const req = this.getCatalogPhaseRequires(sid, ph);
      const advancing = st0 === 'done' || st0 === 'active';
      if (advancing && req.length > 0 && !this.checkPrerequisites(sid, req)) {
        console.warn(
          `[ScenarioStateManager] setScenarioPhase: "${sid}"·"${ph}" 的清单 requires 未全部 done`,
          req,
        );
      }
    }

    let m = this.byScenario.get(sid);
    if (!m) {
      m = new Map();
      this.byScenario.set(sid, m);
    }
    const cur = m.get(ph) ?? { status: 'pending' };
    m.set(ph, {
      status: payload.status,
      outcome: payload.outcome !== undefined ? payload.outcome : cur.outcome,
    });
    this.tryApplyExposes(sid, ph, payload.status);
  }

  private tryApplyExposes(scenarioId: string, phase: string, status: string): void {
    if (status !== 'done' || !this.flagStore) return;
    const entry = this.catalog.find((c) => c.id === scenarioId);
    if (!entry?.exposes) return;
    const trigger = (entry.exposeAfterPhase ?? '').trim();
    if (!trigger || trigger !== phase) return;
    for (const [key, on] of Object.entries(entry.exposes)) {
      if (on) this.flagStore.set(key, true);
    }
  }

  getScenarioPhase(scenarioId: string, phase: string): ScenarioPhasePersisted | undefined {
    const sid = scenarioId.trim();
    const ph = phase.trim();
    if (!sid || !ph) return undefined;
    return this.byScenario.get(sid)?.get(ph);
  }

  /** 条件叶子：当前 phase 的 status 是否与期望值一致（字符串比较） */
  phaseStatusEquals(scenarioId: string, phase: string, wantStatus: string): boolean {
    const st = this.getScenarioPhase(scenarioId, phase)?.status;
    if (st === undefined) return wantStatus === 'pending';
    return st === wantStatus;
  }

  /**
   * 每个 requiredPhase 均已存在且 status === 'done'（用于 requires 清单的默认语义）。
   */
  checkPrerequisites(scenarioId: string, requiredPhases: string[]): boolean {
    for (const p of requiredPhases) {
      if (!this.phaseStatusEquals(scenarioId, p.trim(), 'done')) return false;
    }
    return true;
  }

  serialize(): object {
    const out: Record<string, Record<string, ScenarioPhasePersisted>> = {};
    for (const [sid, pmap] of this.byScenario) {
      out[sid] = {};
      for (const [ph, val] of pmap) {
        out[sid]![ph] = { ...val };
      }
    }
    return { scenarios: out };
  }

  deserialize(data: object): void {
    this.byScenario.clear();
    const raw = data as { scenarios?: Record<string, Record<string, ScenarioPhasePersisted>> };
    const sc = raw?.scenarios;
    if (!sc || typeof sc !== 'object') return;
    for (const [sid, phases] of Object.entries(sc)) {
      if (!phases || typeof phases !== 'object') continue;
      const m = new Map<string, ScenarioPhasePersisted>();
      for (const [ph, val] of Object.entries(phases)) {
        if (val && typeof val === 'object' && typeof val.status === 'string') {
          m.set(ph, {
            status: val.status,
            outcome: val.outcome,
          });
        }
      }
      if (m.size > 0) this.byScenario.set(sid, m);
    }
  }
}
