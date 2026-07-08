import { describe, expect, it } from 'vitest';

import { applyDevRuntimeCommand } from './devRuntimeCommands';
import type { FlagValue } from './FlagStore';

function deps() {
  const calls: string[] = [];
  const flags = new Map<string, FlagValue>();
  const kinds = new Map<string, 'bool' | 'float' | 'string'>([
    ['flag_bool', 'bool'],
    ['flag_count', 'float'],
    ['flag_note', 'string'],
  ]);
  return {
    calls,
    flags,
    deps: {
      captureSnapshot: async (reason: string) => {
        calls.push(`snapshot:${reason}`);
      },
      clearNarrativeTrace: () => {
        calls.push('clearTrace');
      },
      emitNarrativeSignal: async (signal: { sourceType: string; sourceId: string; signal: string }) => {
        calls.push(`signal:${signal.sourceType}:${signal.sourceId}:${signal.signal}`);
      },
      debugSetNarrativeState: async (graphId: string, stateId: string) => {
        calls.push(`state:${graphId}:${stateId}`);
      },
      setFlag: (key: string, value: FlagValue) => {
        flags.set(key, value);
      },
      isFlagAllowed: (key: string) => kinds.has(key),
      getFlagValueKind: (key: string) => kinds.get(key) ?? 'bool',
      debugSetQuestStatus: (questId: string, status: number) => {
        calls.push(`quest:${questId}:${status}`);
      },
      debugSetScenarioPhase: (
        scenarioId: string,
        phase: string,
        payload: { status: string; outcome?: string | number | boolean | null },
      ) => {
        calls.push(`scenarioPhase:${scenarioId}:${phase}:${payload.status}`);
      },
      debugSetScenarioLineLifecycle: (scenarioId: string, state: 'inactive' | 'active' | 'completed') => {
        calls.push(`scenarioLifecycle:${scenarioId}:${state}`);
      },
      debugResetScenarioProgress: (scenarioId: string) => {
        calls.push(`scenarioReset:${scenarioId}`);
      },
      debugStartDialogueGraph: async (params: {
        graphId: string;
        entry?: string;
        npcName: string;
        npcId?: string;
        ownerType?: string;
        ownerId?: string;
      }) => {
        calls.push(`dialogueStart:${params.graphId}:${params.entry ?? ''}:${params.npcName}`);
      },
      debugAdvanceDialogue: async (maxSteps: number) => {
        calls.push(`dialogueAdvance:${maxSteps}`);
      },
      debugChooseDialogueOption: async (params: { index?: number; text?: string }) => {
        calls.push(`dialogueChoose:${params.index ?? ''}:${params.text ?? ''}`);
        return params.index === 0 || params.text === '帮忙';
      },
      debugSwitchScene: async (sceneId: string, spawnPoint?: string) => {
        calls.push(`scene:${sceneId}:${spawnPoint ?? ''}`);
      },
      debugTriggerHotspot: async (hotspotId: string) => {
        calls.push(`hotspot:${hotspotId}`);
        return hotspotId === 'poster';
      },
      debugInteractNpc: async (npcId: string) => {
        calls.push(`npc:${npcId}`);
        return npcId === 'npc_ringboy';
      },
      debugWait: async (durationMs: number) => {
        calls.push(`wait:${durationMs}`);
      },
      debugSetPlayerPosition: (x: number, y: number, snapCamera: boolean) => {
        calls.push(`playerSet:${x}:${y}:${snapCamera}`);
      },
      debugMovePlayerTo: async (x: number, y: number, speed: number, snapCamera: boolean) => {
        calls.push(`playerMove:${x}:${y}:${speed}:${snapCamera}`);
      },
      debugClick: async (x: number, y: number) => {
        calls.push(`click:${x}:${y}`);
      },
      debugDrag: async (fromX: number, fromY: number, toX: number, toY: number, durationMs: number) => {
        calls.push(`drag:${fromX}:${fromY}:${toX}:${toY}:${durationMs}`);
      },
      debugSaveGame: (slot: number) => {
        calls.push(`save:${slot}`);
      },
      debugLoadGame: async (slot: number) => {
        calls.push(`load:${slot}`);
        return slot === 2;
      },
      debugReloadScene: async (sceneId?: string) => {
        calls.push(`reloadScene:${sceneId ?? ''}`);
      },
      playerInteract: () => { calls.push('playerInteract'); },
      playerAdvance: () => { calls.push('playerAdvance'); },
      playerChoose: (index: number) => { calls.push(`playerChoose:${index}`); },
      playerMoveTo: (x: number, y: number) => { calls.push(`playerMoveTo:${x},${y}`); },
      playerTap: () => { calls.push('playerTap'); },
      setPlayerCollisions: (enabled: boolean) => { calls.push(`setPlayerCollisions:${enabled}`); },
      activatePlane: (planeId: string) => { calls.push(`activatePlane:${planeId}`); return true; },
      deactivatePlane: () => { calls.push('deactivatePlane'); },
    },
  };
}

describe('applyDevRuntimeCommand', () => {
  it('clears trace and captures a fresh snapshot', async () => {
    const ctx = deps();

    const result = await applyDevRuntimeCommand(
      { id: 'cmd-1', type: 'clearNarrativeTrace', reason: 'acceptance-start' },
      ctx.deps,
    );

    expect(result.ok).toBe(true);
    expect(ctx.calls).toEqual(['clearTrace', 'snapshot:acceptance-start']);
  });

  it('emits narrative signal through the runtime dependency', async () => {
    const ctx = deps();

    const result = await applyDevRuntimeCommand(
      {
        id: 'cmd-2',
        type: 'emitNarrativeSignal',
        sourceType: 'debug',
        sourceId: 'workbench',
        signal: 'ringboy.met',
      },
      ctx.deps,
    );

    expect(result.ok).toBe(true);
    expect(ctx.calls).toContain('signal:debug:workbench:ringboy.met');
    expect(ctx.calls).toContain('snapshot:runtime-command:emitNarrativeSignal');
  });

  it('coerces setFlag by registry value kind', async () => {
    const ctx = deps();

    expect((await applyDevRuntimeCommand({ type: 'setFlag', key: 'flag_bool', value: 'true' }, ctx.deps)).ok).toBe(true);
    expect((await applyDevRuntimeCommand({ type: 'setFlag', key: 'flag_count', value: '3.5' }, ctx.deps)).ok).toBe(true);
    expect((await applyDevRuntimeCommand({ type: 'setFlag', key: 'flag_note', value: 123 }, ctx.deps)).ok).toBe(true);

    expect(ctx.flags.get('flag_bool')).toBe(true);
    expect(ctx.flags.get('flag_count')).toBe(3.5);
    expect(ctx.flags.get('flag_note')).toBe('123');
  });

  it('rejects unregistered flags', async () => {
    const ctx = deps();

    const result = await applyDevRuntimeCommand({ type: 'setFlag', key: 'missing', value: true }, ctx.deps);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('not registered');
  });

  it('applies quest and scenario debug setup commands', async () => {
    const ctx = deps();

    expect((await applyDevRuntimeCommand(
      { type: 'debugSetQuestStatus', questId: 'bridge_find_source', status: 'active' },
      ctx.deps,
    )).ok).toBe(true);
    expect((await applyDevRuntimeCommand(
      { type: 'debugSetScenarioPhase', scenarioId: 'line_a', phase: 'intro', status: 'done' },
      ctx.deps,
    )).ok).toBe(true);
    expect((await applyDevRuntimeCommand(
      { type: 'debugSetScenarioLineLifecycle', scenarioId: 'line_a', state: 'completed' },
      ctx.deps,
    )).ok).toBe(true);
    expect((await applyDevRuntimeCommand(
      { type: 'debugResetScenarioProgress', scenarioId: 'line_b' },
      ctx.deps,
    )).ok).toBe(true);

    expect(ctx.calls).toContain('quest:bridge_find_source:1');
    expect(ctx.calls).toContain('scenarioPhase:line_a:intro:done');
    expect(ctx.calls).toContain('scenarioLifecycle:line_a:completed');
    expect(ctx.calls).toContain('scenarioReset:line_b');
  });

  it('applies dialogue route debug commands', async () => {
    const ctx = deps();

    expect((await applyDevRuntimeCommand(
      { type: 'debugStartDialogueGraph', graphId: 'ringboy', entry: 'root', npcName: '小孩' },
      ctx.deps,
    )).ok).toBe(true);
    expect((await applyDevRuntimeCommand(
      { type: 'debugAdvanceDialogue', maxSteps: '12' },
      ctx.deps,
    )).ok).toBe(true);
    expect((await applyDevRuntimeCommand(
      { type: 'debugChooseDialogueOption', text: '帮忙' },
      ctx.deps,
    )).ok).toBe(true);

    expect(ctx.calls).toContain('dialogueStart:ringboy:root:小孩');
    expect(ctx.calls).toContain('dialogueAdvance:12');
    expect(ctx.calls).toContain('dialogueChoose::帮忙');
  });

  it('applies scene and interaction debug commands', async () => {
    const ctx = deps();

    expect((await applyDevRuntimeCommand(
      { type: 'debugSwitchScene', sceneId: 'market', spawnPoint: 'gate' },
      ctx.deps,
    )).ok).toBe(true);
    expect((await applyDevRuntimeCommand(
      { type: 'debugTriggerHotspot', hotspotId: 'poster' },
      ctx.deps,
    )).ok).toBe(true);
    expect((await applyDevRuntimeCommand(
      { type: 'debugInteractNpc', npcId: 'npc_ringboy' },
      ctx.deps,
    )).ok).toBe(true);

    expect(ctx.calls).toContain('scene:market:gate');
    expect(ctx.calls).toContain('hotspot:poster');
    expect(ctx.calls).toContain('npc:npc_ringboy');
  });

  it('applies wait and player position debug commands', async () => {
    const ctx = deps();

    expect((await applyDevRuntimeCommand(
      { type: 'debugWait', durationMs: '750' },
      ctx.deps,
    )).ok).toBe(true);
    expect((await applyDevRuntimeCommand(
      { type: 'debugSetPlayerPosition', x: '120.5', y: 80, snapCamera: 'false' },
      ctx.deps,
    )).ok).toBe(true);
    expect((await applyDevRuntimeCommand(
      { type: 'debugMovePlayerTo', x: 300, y: '140', speed: '220', snapCamera: true },
      ctx.deps,
    )).ok).toBe(true);

    expect(ctx.calls).toContain('wait:750');
    expect(ctx.calls).toContain('playerSet:120.5:80:false');
    expect(ctx.calls).toContain('playerMove:300:140:220:true');
  });

  it('applies generic click and drag debug commands for minigame/free exploration smoke runs', async () => {
    const ctx = deps();

    expect((await applyDevRuntimeCommand(
      { type: 'debugClick', x: '120', y: 80 },
      ctx.deps,
    )).ok).toBe(true);
    expect((await applyDevRuntimeCommand(
      { type: 'debugDrag', fromX: 10, fromY: 20, toX: 30, toY: 40, durationMs: 250 },
      ctx.deps,
    )).ok).toBe(true);

    expect(ctx.calls).toContain('click:120:80');
    expect(ctx.calls).toContain('drag:10:20:30:40:250');
  });

  it('applies save/load/reload debug commands for acceptance smoke runs', async () => {
    const ctx = deps();

    expect((await applyDevRuntimeCommand(
      { type: 'debugSaveGame', slot: '2' },
      ctx.deps,
    )).ok).toBe(true);
    expect((await applyDevRuntimeCommand(
      { type: 'debugLoadGame', slot: 2 },
      ctx.deps,
    )).ok).toBe(true);
    expect((await applyDevRuntimeCommand(
      { type: 'debugReloadScene', sceneId: 'dock_board' },
      ctx.deps,
    )).ok).toBe(true);

    expect(ctx.calls).toContain('save:2');
    expect(ctx.calls).toContain('load:2');
    expect(ctx.calls).toContain('reloadScene:dock_board');
  });

  it('rejects missing save slots during debug load', async () => {
    const ctx = deps();

    const result = await applyDevRuntimeCommand({ type: 'debugLoadGame', slot: 0 }, ctx.deps);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('save slot not found');
  });
});
