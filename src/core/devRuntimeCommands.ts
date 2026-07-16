import type { FlagValue } from './FlagStore';
import type { ActionDef } from '../data/types';

export type RuntimeCommand =
  | { id?: unknown; type: 'captureSnapshot'; reason?: unknown }
  | { id?: unknown; type: 'debugClearEventTrace'; reason?: unknown }
  | { id?: unknown; type: 'debugExecuteAction'; action?: unknown; reason?: unknown }
  | { id?: unknown; type: 'debugSetFixedTickMode'; enabled?: unknown; reason?: unknown }
  | { id?: unknown; type: 'debugStepTicks'; ticks?: unknown; dtMs?: unknown; reason?: unknown }
  | { id?: unknown; type: 'clearNarrativeTrace'; reason?: unknown }
  | {
      id?: unknown;
      type: 'emitNarrativeSignal';
      sourceType?: unknown;
      sourceId?: unknown;
      signal?: unknown;
      reason?: unknown;
    }
  | { id?: unknown; type: 'debugSetNarrativeState'; graphId?: unknown; stateId?: unknown; reason?: unknown }
  | { id?: unknown; type: 'setFlag'; key?: unknown; value?: unknown; reason?: unknown }
  | { id?: unknown; type: 'debugSetQuestStatus'; questId?: unknown; status?: unknown; reason?: unknown }
  | {
      id?: unknown;
      type: 'debugSetScenarioPhase';
      scenarioId?: unknown;
      phase?: unknown;
      status?: unknown;
      outcome?: unknown;
      reason?: unknown;
    }
  | {
      id?: unknown;
      type: 'debugSetScenarioLineLifecycle';
      scenarioId?: unknown;
      state?: unknown;
      reason?: unknown;
    }
  | { id?: unknown; type: 'debugResetScenarioProgress'; scenarioId?: unknown; reason?: unknown }
  | {
      id?: unknown;
      type: 'debugStartDialogueGraph';
      graphId?: unknown;
      entry?: unknown;
      npcName?: unknown;
      npcId?: unknown;
      ownerType?: unknown;
      ownerId?: unknown;
      reason?: unknown;
    }
  | { id?: unknown; type: 'debugAdvanceDialogue'; maxSteps?: unknown; reason?: unknown }
  | { id?: unknown; type: 'debugChooseDialogueOption'; index?: unknown; text?: unknown; reason?: unknown }
  | { id?: unknown; type: 'debugSwitchScene'; sceneId?: unknown; spawnPoint?: unknown; reason?: unknown }
  | { id?: unknown; type: 'debugTriggerHotspot'; hotspotId?: unknown; reason?: unknown }
  | { id?: unknown; type: 'debugInteractNpc'; npcId?: unknown; reason?: unknown }
  | { id?: unknown; type: 'debugWait'; durationMs?: unknown; reason?: unknown }
  | { id?: unknown; type: 'debugSetPlayerPosition'; x?: unknown; y?: unknown; snapCamera?: unknown; reason?: unknown }
  | { id?: unknown; type: 'debugMovePlayerTo'; x?: unknown; y?: unknown; speed?: unknown; snapCamera?: unknown; reason?: unknown }
  | { id?: unknown; type: 'debugClick'; x?: unknown; y?: unknown; reason?: unknown }
  | {
      id?: unknown;
      type: 'debugDrag';
      fromX?: unknown;
      fromY?: unknown;
      toX?: unknown;
      toY?: unknown;
      durationMs?: unknown;
      reason?: unknown;
    }
  | { id?: unknown; type: 'debugSaveGame'; slot?: unknown; reason?: unknown }
  | { id?: unknown; type: 'debugLoadGame'; slot?: unknown; reason?: unknown }
  | { id?: unknown; type: 'debugReloadScene'; sceneId?: unknown; reason?: unknown }
  | { id?: unknown; type: 'playerInteract'; reason?: unknown }
  | { id?: unknown; type: 'playerAdvance'; reason?: unknown }
  | { id?: unknown; type: 'playerChoose'; index?: unknown; reason?: unknown }
  | { id?: unknown; type: 'playerMoveTo'; x?: unknown; y?: unknown; reason?: unknown }
  | { id?: unknown; type: 'playerTap'; reason?: unknown }
  | { id?: unknown; type: 'setPlayerCollisions'; enabled?: unknown; reason?: unknown }
  | { id?: unknown; type: 'activatePlane'; planeId?: unknown; reason?: unknown }
  | { id?: unknown; type: 'deactivatePlane'; reason?: unknown };

export type RuntimeCommandResult = {
  id: string;
  type: string;
  ok: boolean;
  message: string;
};

export type RuntimeCommandDeps = {
  captureSnapshot(reason: string): void | Promise<void>;
  clearEventTrace(): void;
  debugExecuteAction(action: ActionDef): Promise<void>;
  debugSetFixedTickMode(enabled: boolean): void;
  debugStepTicks(ticks: number, dtMs: number): void | Promise<void>;
  clearNarrativeTrace(): void;
  emitNarrativeSignal(signal: { sourceType: string; sourceId: string; signal: string }): Promise<void>;
  debugSetNarrativeState(graphId: string, stateId: string): Promise<void>;
  setFlag(key: string, value: FlagValue): void;
  isFlagAllowed(key: string): boolean;
  getFlagValueKind(key: string): 'bool' | 'float' | 'string';
  debugSetQuestStatus(questId: string, status: number): void;
  debugSetScenarioPhase(
    scenarioId: string,
    phase: string,
    payload: { status: string; outcome?: string | number | boolean | null },
  ): void;
  debugSetScenarioLineLifecycle(scenarioId: string, state: 'inactive' | 'active' | 'completed'): void;
  debugResetScenarioProgress(scenarioId: string): void;
  debugStartDialogueGraph(params: {
    graphId: string;
    entry?: string;
    npcName: string;
    npcId?: string;
    ownerType?: string;
    ownerId?: string;
  }): Promise<void>;
  debugAdvanceDialogue(maxSteps: number): Promise<void>;
  debugChooseDialogueOption(params: { index?: number; text?: string }): Promise<boolean>;
  debugSwitchScene(sceneId: string, spawnPoint?: string): Promise<void>;
  debugTriggerHotspot(hotspotId: string): Promise<boolean>;
  debugInteractNpc(npcId: string): Promise<boolean>;
  debugWait(durationMs: number): Promise<void>;
  debugSetPlayerPosition(x: number, y: number, snapCamera: boolean): void | Promise<void>;
  debugMovePlayerTo(x: number, y: number, speed: number, snapCamera: boolean): Promise<void>;
  debugClick(x: number, y: number): Promise<void>;
  debugDrag(fromX: number, fromY: number, toX: number, toY: number, durationMs: number): Promise<void>;
  debugSaveGame(slot: number): boolean;
  debugLoadGame(slot: number): Promise<boolean>;
  debugReloadScene(sceneId?: string): Promise<void>;
  // 玩家输入：同步注入到真实输入路径、即发即走（不 await 游戏逻辑，理论上不会卡死游戏）
  playerInteract(): void;
  playerAdvance(): void;
  playerChoose(index: number): void;
  playerMoveTo(x: number, y: number): void;
  playerTap(): void;
  // 测试用环境开关：关碰撞让玩家直线走到任意 NPC（不推任何叙事状态，非作弊）
  setPlayerCollisions(enabled: boolean): void;
  // 位面（PlaneReconciler）：手动覆盖激活位面 / 清覆盖回叙事点名（与同名 action 同语义）。
  // activatePlane 返回是否生效（false = id 空/未注册被拒），命令结果据此如实回报。
  activatePlane(planeId: string): boolean;
  deactivatePlane(): void;
};

export async function applyDevRuntimeCommand(
  rawCommand: unknown,
  deps: RuntimeCommandDeps,
): Promise<RuntimeCommandResult> {
  const command = normalizeRuntimeCommand(rawCommand);
  const id = command.id;
  const type = command.type;
  try {
    switch (type) {
      case 'captureSnapshot': {
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:captureSnapshot');
        return ok(id, type, 'snapshot captured');
      }
      case 'debugClearEventTrace': {
        deps.clearEventTrace();
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugClearEventTrace');
        return ok(id, type, 'event trace cleared');
      }
      case 'debugExecuteAction': {
        if (!command.action || typeof command.action !== 'object' || Array.isArray(command.action)) {
          throw new Error('runtime command action must be an object');
        }
        const action = command.action as Record<string, unknown>;
        if (typeof action.type !== 'string' || !action.type.trim()) {
          throw new Error('runtime command action missing type');
        }
        const params = action.params && typeof action.params === 'object' && !Array.isArray(action.params)
          ? action.params as Record<string, unknown>
          : {};
        await deps.debugExecuteAction({ type: action.type.trim(), params } as ActionDef);
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugExecuteAction');
        return ok(id, type, `action executed: ${action.type.trim()}`);
      }
      case 'debugSetFixedTickMode': {
        const enabled = coerceBool(command.enabled, true);
        deps.debugSetFixedTickMode(enabled);
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugSetFixedTickMode');
        return ok(id, type, `fixed tick mode ${enabled ? 'enabled' : 'disabled'}`);
      }
      case 'debugStepTicks': {
        const ticks = coercePositiveInt(command.ticks, 1);
        const dtMs = Math.min(100, coercePositiveNumber(command.dtMs, 1000 / 60));
        await deps.debugStepTicks(ticks, dtMs);
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugStepTicks');
        return ok(id, type, `stepped ${ticks} fixed tick(s) at ${dtMs}ms`);
      }
      case 'clearNarrativeTrace': {
        deps.clearNarrativeTrace();
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:clearNarrativeTrace');
        return ok(id, type, 'narrative trace cleared');
      }
      case 'emitNarrativeSignal': {
        await deps.emitNarrativeSignal({
          sourceType: requiredString(command.sourceType, 'sourceType'),
          sourceId: requiredString(command.sourceId, 'sourceId'),
          signal: requiredString(command.signal, 'signal'),
        });
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:emitNarrativeSignal');
        return ok(id, type, 'signal emitted');
      }
      case 'debugSetNarrativeState': {
        await deps.debugSetNarrativeState(
          requiredString(command.graphId, 'graphId'),
          requiredString(command.stateId, 'stateId'),
        );
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugSetNarrativeState');
        return ok(id, type, 'narrative state set for debug');
      }
      case 'setFlag': {
        const key = requiredString(command.key, 'key');
        if (!deps.isFlagAllowed(key)) {
          throw new Error(`flag is not registered: ${key}`);
        }
        deps.setFlag(key, coerceFlagValue(command.value, deps.getFlagValueKind(key)));
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:setFlag');
        return ok(id, type, 'flag set');
      }
      case 'debugSetQuestStatus': {
        deps.debugSetQuestStatus(
          requiredString(command.questId, 'questId'),
          coerceQuestStatus(command.status),
        );
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugSetQuestStatus');
        return ok(id, type, 'quest status set for debug');
      }
      case 'debugSetScenarioPhase': {
        deps.debugSetScenarioPhase(
          requiredString(command.scenarioId, 'scenarioId'),
          requiredString(command.phase, 'phase'),
          {
            status: requiredString(command.status, 'status'),
            outcome: coerceScenarioOutcome(command.outcome),
          },
        );
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugSetScenarioPhase');
        return ok(id, type, 'scenario phase set for debug');
      }
      case 'debugSetScenarioLineLifecycle': {
        deps.debugSetScenarioLineLifecycle(
          requiredString(command.scenarioId, 'scenarioId'),
          coerceScenarioLifecycle(command.state),
        );
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugSetScenarioLineLifecycle');
        return ok(id, type, 'scenario line lifecycle set for debug');
      }
      case 'debugResetScenarioProgress': {
        deps.debugResetScenarioProgress(requiredString(command.scenarioId, 'scenarioId'));
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugResetScenarioProgress');
        return ok(id, type, 'scenario progress reset for debug');
      }
      case 'debugStartDialogueGraph': {
        const graphId = requiredString(command.graphId, 'graphId');
        await deps.debugStartDialogueGraph({
          graphId,
          entry: optionalString(command.entry) || undefined,
          npcName: optionalString(command.npcName) || graphId,
          npcId: optionalString(command.npcId) || undefined,
          ownerType: optionalString(command.ownerType) || undefined,
          ownerId: optionalString(command.ownerId) || undefined,
        });
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugStartDialogueGraph');
        return ok(id, type, 'dialogue graph started for debug');
      }
      case 'debugAdvanceDialogue': {
        await deps.debugAdvanceDialogue(coercePositiveInt(command.maxSteps, 24));
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugAdvanceDialogue');
        return ok(id, type, 'dialogue advanced for debug');
      }
      case 'debugChooseDialogueOption': {
        const choice = {
          index: command.index === undefined ? undefined : coerceNonNegativeInt(command.index, 'index'),
          text: optionalString(command.text) || undefined,
        };
        if (choice.index === undefined && !choice.text) {
          throw new Error('runtime command missing index or text');
        }
        const chosen = await deps.debugChooseDialogueOption(choice);
        if (!chosen) {
          throw new Error('dialogue option did not match or is not enabled');
        }
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugChooseDialogueOption');
        return ok(id, type, 'dialogue option chosen for debug');
      }
      case 'debugSwitchScene': {
        await deps.debugSwitchScene(
          requiredString(command.sceneId, 'sceneId'),
          optionalString(command.spawnPoint) || undefined,
        );
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugSwitchScene');
        return ok(id, type, 'scene switched for debug');
      }
      case 'debugTriggerHotspot': {
        const hotspotId = requiredString(command.hotspotId, 'hotspotId');
        const triggered = await deps.debugTriggerHotspot(hotspotId);
        if (!triggered) {
          throw new Error(`hotspot not found or not triggerable: ${hotspotId}`);
        }
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugTriggerHotspot');
        return ok(id, type, 'hotspot triggered for debug');
      }
      case 'debugInteractNpc': {
        const npcId = requiredString(command.npcId, 'npcId');
        const interacted = await deps.debugInteractNpc(npcId);
        if (!interacted) {
          throw new Error(`npc not found or not interactable: ${npcId}`);
        }
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugInteractNpc');
        return ok(id, type, 'npc interacted for debug');
      }
      case 'debugWait': {
        await deps.debugWait(coerceDurationMs(command.durationMs, 500));
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugWait');
        return ok(id, type, 'waited for debug');
      }
      case 'debugSetPlayerPosition': {
        await deps.debugSetPlayerPosition(
          coerceFiniteNumber(command.x, 'x'),
          coerceFiniteNumber(command.y, 'y'),
          coerceBool(command.snapCamera, true),
        );
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugSetPlayerPosition');
        return ok(id, type, 'player position set for debug');
      }
      case 'debugMovePlayerTo': {
        await deps.debugMovePlayerTo(
          coerceFiniteNumber(command.x, 'x'),
          coerceFiniteNumber(command.y, 'y'),
          coercePositiveNumber(command.speed, 180),
          coerceBool(command.snapCamera, true),
        );
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugMovePlayerTo');
        return ok(id, type, 'player moved for debug');
      }
      case 'debugClick': {
        await deps.debugClick(
          coerceFiniteNumber(command.x, 'x'),
          coerceFiniteNumber(command.y, 'y'),
        );
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugClick');
        return ok(id, type, 'click dispatched for debug');
      }
      case 'debugDrag': {
        await deps.debugDrag(
          coerceFiniteNumber(command.fromX, 'fromX'),
          coerceFiniteNumber(command.fromY, 'fromY'),
          coerceFiniteNumber(command.toX, 'toX'),
          coerceFiniteNumber(command.toY, 'toY'),
          coerceDurationMs(command.durationMs, 350),
        );
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugDrag');
        return ok(id, type, 'drag dispatched for debug');
      }
      case 'debugSaveGame': {
        const slot = coerceSaveSlot(command.slot, 2);
        if (!deps.debugSaveGame(slot)) {
          throw new Error(`save slot failed to write: ${slot}`);
        }
        await deps.captureSnapshot(optionalString(command.reason) || `runtime-command:debugSaveGame:${slot}`);
        return ok(id, type, `game saved to slot ${slot}`);
      }
      case 'debugLoadGame': {
        const slot = coerceSaveSlot(command.slot, 2);
        const loaded = await deps.debugLoadGame(slot);
        if (!loaded) {
          throw new Error(`save slot not found or failed to load: ${slot}`);
        }
        await deps.captureSnapshot(optionalString(command.reason) || `runtime-command:debugLoadGame:${slot}`);
        return ok(id, type, `game loaded from slot ${slot}`);
      }
      case 'debugReloadScene': {
        await deps.debugReloadScene(optionalString(command.sceneId) || undefined);
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:debugReloadScene');
        return ok(id, type, 'scene reloaded for debug');
      }
      // ---- 玩家输入命令：同步注入真实输入路径、即发即走，不 await 游戏逻辑 ----
      case 'playerInteract': {
        deps.playerInteract();
        await deps.captureSnapshot('runtime-command:playerInteract');
        return ok(id, type, 'player interact (E) injected');
      }
      case 'playerAdvance': {
        deps.playerAdvance();
        await deps.captureSnapshot('runtime-command:playerAdvance');
        return ok(id, type, 'player advance injected');
      }
      case 'playerChoose': {
        const idx = Math.trunc(Number(command.index));
        if (!Number.isFinite(idx) || idx < 0) throw new Error('index must be a non-negative number');
        deps.playerChoose(idx);
        await deps.captureSnapshot('runtime-command:playerChoose');
        return ok(id, type, `player choose option ${idx} injected`);
      }
      case 'playerMoveTo': {
        const x = Number(command.x);
        const y = Number(command.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y must be numbers');
        deps.playerMoveTo(x, y);
        await deps.captureSnapshot('runtime-command:playerMoveTo');
        return ok(id, type, 'player move target set');
      }
      case 'playerTap': {
        deps.playerTap();
        await deps.captureSnapshot('runtime-command:playerTap');
        return ok(id, type, 'player tap (click/continue) injected');
      }
      case 'setPlayerCollisions': {
        const enabled = command.enabled !== false; // 默认开；显式 false 关碰撞（noclip，测试用）
        deps.setPlayerCollisions(enabled);
        await deps.captureSnapshot('runtime-command:setPlayerCollisions');
        return ok(id, type, `player collisions ${enabled ? 'enabled' : 'disabled (noclip)'}`);
      }
      case 'activatePlane': {
        const planeId = requiredString(command.planeId, 'planeId');
        const applied = deps.activatePlane(planeId);
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:activatePlane');
        if (!applied) {
          return { id, type, ok: false, message: `plane rejected（未注册/无效 id）: ${planeId}` };
        }
        return ok(id, type, `plane manual override set: ${planeId}`);
      }
      case 'deactivatePlane': {
        deps.deactivatePlane();
        await deps.captureSnapshot(optionalString(command.reason) || 'runtime-command:deactivatePlane');
        return ok(id, type, 'plane manual override cleared');
      }
      default:
        return {
          id,
          type,
          ok: false,
          message: `unsupported runtime command: ${type}`,
        };
    }
  } catch (error) {
    return {
      id,
      type,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function normalizeRuntimeCommand(rawCommand: unknown): { id: string; type: string; [key: string]: unknown } {
  if (!rawCommand || typeof rawCommand !== 'object' || Array.isArray(rawCommand)) {
    throw new Error('runtime command must be an object');
  }
  const record = rawCommand as Record<string, unknown>;
  const type = String(record.type ?? '').trim();
  if (!type) {
    throw new Error('runtime command missing type');
  }
  const id = String(record.id ?? `${type}:${Date.now()}`).trim();
  return { ...record, id, type };
}

function ok(id: string, type: string, message: string): RuntimeCommandResult {
  return { id, type, ok: true, message };
}

function requiredString(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new Error(`runtime command missing ${label}`);
  }
  return text;
}

function optionalString(value: unknown): string {
  return String(value ?? '').trim();
}

function coerceFlagValue(value: unknown, kind: 'bool' | 'float' | 'string'): FlagValue {
  if (kind === 'string') {
    return String(value ?? '');
  }
  if (kind === 'float') {
    const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
    if (!Number.isFinite(n)) {
      throw new Error(`flag value is not a finite number: ${String(value)}`);
    }
    return n;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  throw new Error(`flag value is not a boolean: ${String(value)}`);
}

function coerceQuestStatus(value: unknown): number {
  const text = String(value ?? '').trim().toLowerCase();
  if (value === 2 || text === '2' || ['completed', 'complete', 'done'].includes(text)) return 2;
  if (value === 1 || text === '1' || ['active', 'accepted', 'accept'].includes(text)) return 1;
  if (value === 0 || text === '0' || ['inactive', 'pending', 'none'].includes(text)) return 0;
  throw new Error(`quest status is not supported: ${String(value)}`);
}

function coerceScenarioLifecycle(value: unknown): 'inactive' | 'active' | 'completed' {
  const text = String(value ?? '').trim().toLowerCase();
  if (['inactive', 'pending', 'none'].includes(text)) return 'inactive';
  if (text === 'active') return 'active';
  if (['completed', 'complete', 'done'].includes(text)) return 'completed';
  throw new Error(`scenario lifecycle is not supported: ${String(value)}`);
}

function coerceScenarioOutcome(value: unknown): string | number | boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

function coercePositiveInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(n)));
}

function coerceNonNegativeInt(value: unknown, label: string): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`runtime command ${label} is not a non-negative integer: ${String(value)}`);
  }
  return Math.trunc(n);
}

function coerceFiniteNumber(value: unknown, label: string): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n)) {
    throw new Error(`runtime command ${label} is not a finite number: ${String(value)}`);
  }
  return n;
}

function coercePositiveNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(5000, n);
}

function coerceDurationMs(value: unknown, fallback: number): number {
  const n = coercePositiveNumber(value, fallback);
  return Math.max(1, Math.min(60_000, Math.trunc(n)));
}

function coerceSaveSlot(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0 || n > 2) {
    throw new Error(`save slot must be 0, 1, or 2: ${String(value)}`);
  }
  return Math.trunc(n);
}

function coerceBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  return fallback;
}
