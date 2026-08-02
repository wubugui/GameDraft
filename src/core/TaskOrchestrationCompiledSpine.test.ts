/** Runtime contract for the native shape emitted by tools/task_orchestration_editor. */
import { describe, expect, it } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import {
  compileNarrativeGraphs,
  NarrativeStateManager,
  type NarrativeGraphsFile,
} from './NarrativeStateManager';

const compiledShape = {
  schemaVersion: 3,
  signals: [
    { id: 'prerequisite_open' },
    { id: 'target_ready' },
    { id: 'content_completed' },
    { id: 'target_skipped' },
  ],
  compositions: [
    {
      id: 'target_task',
      mainGraph: {
        id: 'flow_target',
        ownerType: 'flow',
        initialState: 'before',
        states: {
          before: { id: 'before' },
          ready: { id: 'ready' },
          done: { id: 'done' },
          skipped: { id: 'skipped' },
        },
        transitions: [
          { id: 'enter_ready', from: 'before', to: 'ready', signal: 'target_ready' },
          {
            id: 'finish_event',
            from: 'ready',
            to: 'done',
            signal: 'state:scenario_compiled_event:done',
          },
          { id: 'skip_event', from: 'ready', to: 'skipped', signal: 'target_skipped' },
        ],
      },
      elements: [
        {
          id: 'event_finish_event',
          kind: 'scenarioSubgraph',
          ownerType: 'scenario',
          ownerId: 'scenario_compiled_event',
          refId: 'scenario_compiled_event',
          graph: {
            id: 'scenario_compiled_event',
            ownerType: 'scenario',
            ownerId: 'scenario_compiled_event',
            initialState: 'locked',
            entryState: 'ready',
            exitStates: ['done', 'expired'],
            states: {
              locked: { id: 'locked' },
              ready: { id: 'ready' },
              done: { id: 'done', broadcastOnEnter: true },
              expired: { id: 'expired' },
            },
            transitions: [
              {
                id: 'unlock',
                from: 'locked',
                to: 'ready',
                trigger: 'reactiveAll',
                conditions: [
                  { narrative: 'flow_prerequisite', state: 'open' },
                  { narrative: 'flow_target', state: 'ready' },
                ],
                signal: '__draft__',
              },
              {
                id: 'expire',
                from: 'ready',
                to: 'expired',
                trigger: 'reactiveAny',
                conditions: [
                  { not: { narrative: 'flow_prerequisite', state: 'open' } },
                  { not: { narrative: 'flow_target', state: 'ready' } },
                ],
                signal: '__draft__',
              },
              {
                id: 'complete',
                from: 'ready',
                to: 'done',
                signal: 'content_completed',
              },
            ],
          },
        },
      ],
    },
    {
      id: 'prerequisite',
      mainGraph: {
        id: 'flow_prerequisite',
        ownerType: 'flow',
        initialState: 'closed',
        states: { closed: { id: 'closed' }, open: { id: 'open' } },
        transitions: [
          { id: 'open', from: 'closed', to: 'open', signal: 'prerequisite_open' },
        ],
      },
      elements: [],
    },
  ],
} as unknown as NarrativeGraphsFile;

function makeRuntime(): NarrativeStateManager {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const actionExecutor = new ActionExecutor(eventBus, flagStore);
  const narrative = new NarrativeStateManager(eventBus, flagStore, actionExecutor);
  narrative.setConditionEvalContextFactory(() => ({
    flagStore,
    questManager: { getStatus: () => 0 } as never,
    scenarioState: {} as never,
    narrativeState: narrative,
  }));
  narrative.registerGraphs(compileNarrativeGraphs(compiledShape));
  return narrative;
}

describe('task orchestration native scenario spine', () => {
  it('does not lose completion when prerequisite becomes true before target mainGraph reaches from', async () => {
    const narrative = makeRuntime();
    await narrative.emitNarrativeSignal({ signal: 'prerequisite_open' });
    expect(narrative.getActiveState('scenario_compiled_event')).toBe('locked');

    await narrative.emitNarrativeSignal({ signal: 'target_ready' });
    expect(narrative.getActiveState('scenario_compiled_event')).toBe('ready');

    await narrative.emitNarrativeSignal({ signal: 'content_completed' });
    expect(narrative.getActiveState('scenario_compiled_event')).toBe('done');
    expect(narrative.getActiveState('flow_target')).toBe('done');
  });

  it('expires the event if the target mainGraph leaves from before content completes', async () => {
    const narrative = makeRuntime();
    await narrative.emitNarrativeSignal({ signal: 'prerequisite_open' });
    await narrative.emitNarrativeSignal({ signal: 'target_ready' });
    expect(narrative.getActiveState('scenario_compiled_event')).toBe('ready');

    await narrative.emitNarrativeSignal({ signal: 'target_skipped' });
    expect(narrative.getActiveState('scenario_compiled_event')).toBe('expired');
    await narrative.emitNarrativeSignal({ signal: 'content_completed' });
    expect(narrative.getActiveState('flow_target')).toBe('skipped');
  });
});
