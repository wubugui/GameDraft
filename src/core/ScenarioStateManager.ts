import type {
  GameContext,
  IGameSystem,
  ScenarioCatalogEntry,
  ScenarioCatalogFile,
} from '../data/types';
import type { EventBus } from './EventBus';
import type { FlagStore, FlagValue } from './FlagStore';

/** 与主编辑器 `SCENARIO_PHASE_STATUSES` 一致；非法值仅在 dev 下警告 */
const SCENARIO_STATUS_SUGGESTED = new Set(['pending', 'active', 'done', 'locked']);

/** 单 phase 在存档中的形状（与叙事文档一致） */
export interface ScenarioPhasePersisted {
  status: string;
  outcome?: string | number | boolean | null;
}

/** 首次写入本 scenario 桶时 scenario 级进线 `requires` 未满足。 */
export class ScenarioLineEntryRequiresError extends Error {
  readonly scenarioId: string;
  readonly requires: unknown;
  constructor(scenarioId: string, requires: unknown) {
    super(
      `Scenario 进线 requires 未满足: scenarioId=${JSON.stringify(scenarioId)} requires=${JSON.stringify(requires)}`,
    );
    this.name = 'ScenarioLineEntryRequiresError';
    this.scenarioId = scenarioId;
    this.requires = requires;
  }
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
  private eventBus: EventBus | null = null;

  /** 运行时配置：用于 exposes 写入全局 flag；eventBus 供 requires 违规时 UI 提示 */
  configureRuntime(
    flagStore: FlagStore,
    catalog: ScenarioCatalogFile | null,
    eventBus?: EventBus | null,
  ): void {
    this.flagStore = flagStore;
    this.catalog = catalog?.scenarios && Array.isArray(catalog.scenarios) ? catalog.scenarios : [];
    this.eventBus = eventBus ?? null;
  }

  init(_ctx: GameContext): void {}

  /**
   * 供 `startScenario` 动作用：在尚未有本线任意 phase 存档前校验进线 `requires`；
   * 未满足时抛出 `ScenarioLineEntryRequiresError`。
   * 若已有本 scenario 的状态桶则直接返回（与 `setScenarioPhase` 首次写入口径一致）。
   */
  assertScenarioLineEntryForAction(scenarioId: string): void {
    this.assertScenarioLineEntryMetOrThrow(scenarioId.trim());
  }

  update(_dt: number): void {}

  destroy(): void {
    this.byScenario.clear();
  }

  /**
   * 本 scenario 是否尚无任意 phase 的持久化条目（进线前 / 进线后）。
   */
  private isFirstWriteToScenario(scenarioId: string): boolean {
    const m = this.byScenario.get(scenarioId);
    return !m || m.size === 0;
  }

  /**
   * 进线门槛：第一次写入本 scenario 桶前须满足 `ScenarioCatalogEntry.requires`。
   * 不满足时 `console.error` 后抛出 `ScenarioLineEntryRequiresError`；非首次写入不校验。
   */
  private assertScenarioLineEntryMetOrThrow(scenarioId: string): void {
    if (!this.isFirstWriteToScenario(scenarioId)) return;
    const entry = this.catalog.find((c) => c.id === scenarioId);
    const raw = entry?.requires;
    if (raw === undefined || raw === null) return;
    if (this.evalCatalogRequiresMet(scenarioId, raw)) return;
    const logMsg = `[ScenarioStateManager] 进线 requires 未满足: scenario ${JSON.stringify(scenarioId)} requires=${JSON.stringify(raw)}`;
    console.error(logMsg);
    throw new ScenarioLineEntryRequiresError(scenarioId, raw);
  }

  /**
   * 清单 `requires`：数组视为逐项与；对象支持 `all` / `any` / `not`；叶子字符串表示该 phase 须 `done`。
   * 无法识别的结构视为不满足（并触发上层告警）。
   */
  private evalCatalogRequiresMet(scenarioId: string, raw: unknown): boolean {
    if (raw === null || raw === undefined) return true;
    if (Array.isArray(raw)) {
      for (const x of raw) {
        if (!this.evalCatalogRequiresMet(scenarioId, x)) return false;
      }
      return true;
    }
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (!s) return true;
      return this.phaseStatusEquals(scenarioId, s, 'done');
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      const allowed = new Set(['all', 'any', 'not']);
      for (const k of Object.keys(o)) {
        if (!allowed.has(k)) return false;
      }
      const opKeys = Object.keys(o).filter((k) => allowed.has(k));
      if (opKeys.length !== 1) return false;
      if ('all' in o && Array.isArray(o.all)) {
        for (const x of o.all) {
          if (!this.evalCatalogRequiresMet(scenarioId, x)) return false;
        }
        return true;
      }
      if ('any' in o && Array.isArray(o.any)) {
        if (o.any.length === 0) return false;
        for (const x of o.any) {
          if (this.evalCatalogRequiresMet(scenarioId, x)) return true;
        }
        return false;
      }
      if ('not' in o) {
        return !this.evalCatalogRequiresMet(scenarioId, o.not);
      }
    }
    return false;
  }

  setScenarioPhase(
    scenarioId: string,
    phase: string,
    payload: { status: string; outcome?: string | number | boolean | null },
  ): void {
    const sid = scenarioId.trim();
    const ph = phase.trim();
    if (!sid || !ph) return;

    const st0 = payload.status.trim();

    if (import.meta.env.DEV) {
      const entry = this.catalog.find((c) => c.id === sid);
      if (entry?.phases && !(ph in entry.phases)) {
        console.warn(
          `[ScenarioStateManager] setScenarioPhase: phase "${ph}" 未出现在 scenario "${sid}" 的 scenarios.json 清单中`,
        );
      }
      if (st0 && !SCENARIO_STATUS_SUGGESTED.has(st0)) {
        console.warn(
          `[ScenarioStateManager] setScenarioPhase: 非建议 status "${st0}"（建议 pending|active|done|locked）`,
        );
      }
    }

    const entry = this.catalog.find((c) => c.id === sid);
    this.assertScenarioLineEntryMetOrThrow(sid);

    const rawReq = entry?.phases?.[ph]?.requires;
    const advancing = st0 === 'done' || st0 === 'active';
    if (advancing && !this.evalCatalogRequiresMet(sid, rawReq)) {
      const detail =
        rawReq !== undefined && rawReq !== null
          ? ` requires=${JSON.stringify(rawReq)}`
          : '';
      const logMsg = `[ScenarioStateManager] setScenarioPhase: "${sid}"·"${ph}" 的清单 requires 未满足${detail}；已放弃写入`;
      console.error(logMsg);
      this.eventBus?.emit('notification:show', {
        text: `叙事阶段「${ph}」违反 requires 前置（详情见控制台日志）`,
        type: 'error',
      });
      return;
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

  /**
   * 将 scenarios.json 中的 exposes 值转为与登记表 valueType 一致的 FlagValue；无法解析时返回 undefined。
   */
  private coerceExposeValue(key: string, raw: unknown): FlagValue | undefined {
    const fs = this.flagStore;
    const vt = fs?.getRegistryValueType(key.trim()) ?? 'bool';
    if (raw === null || raw === undefined) return undefined;

    if (vt === 'bool') {
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw !== 0;
      if (typeof raw === 'string') {
        const s = raw.trim().toLowerCase();
        if (s === 'true' || s === '1') return true;
        if (s === 'false' || s === '0' || s === '') return false;
      }
      if (import.meta.env.DEV) {
        console.warn(
          `[ScenarioStateManager] exposes 布尔字段 ${JSON.stringify(key)} 的 JSON 值无法解析，已跳过`,
          raw,
        );
      }
      return undefined;
    }

    if (vt === 'float') {
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
      }
      if (import.meta.env.DEV) {
        console.warn(
          `[ScenarioStateManager] exposes 数值字段 ${JSON.stringify(key)} 的 JSON 值无法解析为数字，已跳过`,
          raw,
        );
      }
      return undefined;
    }

    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    if (typeof raw === 'boolean') return raw ? 'true' : 'false';
    if (import.meta.env.DEV) {
      console.warn(
        `[ScenarioStateManager] exposes 字符串字段 ${JSON.stringify(key)} 的 JSON 值无法转为字符串，已跳过`,
        raw,
      );
    }
    return undefined;
  }

  private tryApplyExposes(scenarioId: string, phase: string, status: string): void {
    if (status !== 'done' || !this.flagStore) return;
    const entry = this.catalog.find((c) => c.id === scenarioId);
    if (!entry?.exposes) return;
    const trigger = (entry.exposeAfterPhase ?? '').trim();
    if (!trigger || trigger !== phase) return;
    for (const [rawKey, rawVal] of Object.entries(entry.exposes)) {
      const k = rawKey.trim();
      if (!k) continue;
      if (!this.flagStore.isKeyAllowedByRegistry(k)) {
        console.error(
          `[ScenarioStateManager] exposes 跳过未登记 flag：scenario=${JSON.stringify(scenarioId)} phase=${JSON.stringify(phase)} key=${JSON.stringify(k)}`,
        );
        continue;
      }
      const value = this.coerceExposeValue(k, rawVal);
      if (value === undefined) {
        if (import.meta.env.DEV) {
          console.error(
            `[ScenarioStateManager] exposes 未写入：scenario=${JSON.stringify(scenarioId)} phase=${JSON.stringify(phase)} key=${JSON.stringify(k)}`,
          );
        }
        continue;
      }
      this.flagStore.set(k, value);
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
