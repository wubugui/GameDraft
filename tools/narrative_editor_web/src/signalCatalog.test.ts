import { describe, expect, it } from 'vitest';
import { buildSignalCatalog, collectKnownSignals, renameAuthorSignal } from './signalCatalog';
import type { NarrativeGraphsFileDef } from './types';

describe('renameAuthorSignal', () => {
  it('cascades to transition.signal, meta.emits, and emitNarrativeSignal action params', () => {
    const data = {
      schemaVersion: 3,
      signals: [{ id: 'go' }],
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow',
          ownerType: 'flow',
          initialState: 'a',
          states: {
            a: { id: 'a', onEnterActions: [{ type: 'emitNarrativeSignal', params: { signal: 'go' } }] },
            b: { id: 'b', onExitActions: [{ type: 'setFlag', params: { key: 'x', value: true } }] },
          },
          transitions: [{ id: 't', from: 'a', to: 'b', signal: 'go' }],
        },
        elements: [{
          id: 'el', kind: 'wrapperGraph', ownerType: 'npc', ownerId: 'n1',
          meta: { emits: ['go', 'other'] },
          graph: { id: 'wrap', ownerType: 'npc', initialState: 's', states: { s: { id: 's' } }, transitions: [] },
        }],
      }],
    } as unknown as NarrativeGraphsFileDef;

    renameAuthorSignal(data, 'go', 'launched');

    expect(data.signals?.[0]?.id).toBe('launched');
    const g = data.compositions[0]!.mainGraph;
    expect(g.transitions[0]!.signal).toBe('launched');
    const action = g.states.a!.onEnterActions![0] as unknown as { params: { signal: string } };
    expect(action.params.signal).toBe('launched');
    expect(data.compositions[0]!.elements![0]!.meta!.emits).toEqual(['launched', 'other']);
  });

  it('leaves unrelated signals untouched', () => {
    const data = {
      schemaVersion: 3,
      signals: [{ id: 'go' }, { id: 'stop' }],
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow', ownerType: 'flow', initialState: 'a',
          states: { a: { id: 'a', onEnterActions: [{ type: 'emitNarrativeSignal', params: { signal: 'stop' } }] } },
          transitions: [{ id: 't', from: 'a', to: 'a', signal: 'stop' }],
        },
        elements: [],
      }],
    } as unknown as NarrativeGraphsFileDef;

    renameAuthorSignal(data, 'go', 'launched');

    const g = data.compositions[0]!.mainGraph;
    expect(g.transitions[0]!.signal).toBe('stop');
    const action = g.states.a!.onEnterActions![0] as unknown as { params: { signal: string } };
    expect(action.params.signal).toBe('stop');
  });
});

describe('buildSignalCatalog blackbox meta.emits', () => {
  const dataWithDeclaredEmit = (): NarrativeGraphsFileDef =>
    ({
      schemaVersion: 3,
      signals: [{ id: 'registered' }],
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow', ownerType: 'flow', initialState: 'a',
          states: { a: { id: 'a' } }, transitions: [],
        },
        elements: [{
          id: 'dlg', kind: 'dialogueBlackbox', ownerType: 'npc', ownerId: 'n1',
          label: '对话A', refId: 'graph_a',
          meta: { emits: ['declared_only', 'registered'] },
        }],
      }],
    } as unknown as NarrativeGraphsFileDef);

  it('includes a signal that is only declared in a blackbox meta.emits', () => {
    const catalog = buildSignalCatalog(dataWithDeclaredEmit());
    const entry = catalog.find((e) => e.id === 'declared_only');
    expect(entry).toBeDefined();
    expect(entry!.editable).toBe(false);
    expect(entry!.label).toContain('对话A');
  });

  it('exposes declared-only emits via collectKnownSignals', () => {
    expect(collectKnownSignals(dataWithDeclaredEmit())).toContain('declared_only');
  });

  it('does not override an already-registered author signal declared in meta.emits', () => {
    const catalog = buildSignalCatalog(dataWithDeclaredEmit());
    const registered = catalog.filter((e) => e.id === 'registered');
    expect(registered).toHaveLength(1);
    // 已注册作者信号仍可编辑，不被 blackbox 声明段覆盖为 editable:false。
    expect(registered[0]!.editable).toBe(true);
    expect(registered[0]!.label).toBeUndefined();
  });
});
