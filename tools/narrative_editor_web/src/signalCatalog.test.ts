import { describe, expect, it } from 'vitest';
import {
  buildSignalCatalog,
  collectKnownSignals,
  createAuthorSignal,
  renameAuthorSignal,
  setAuthorSignalNotes,
} from './signalCatalog';
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
    const g = data.compositions![0]!.mainGraph;
    expect(g.transitions[0]!.signal).toBe('launched');
    const action = g.states.a!.onEnterActions![0] as unknown as { params: { signal: string } };
    expect(action.params.signal).toBe('launched');
    expect(data.compositions![0]!.elements![0]!.meta!.emits).toEqual(['launched', 'other']);
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

    const g = data.compositions![0]!.mainGraph;
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

describe('signal notes', () => {
  const emptyData = (): NarrativeGraphsFileDef =>
    ({ schemaVersion: 3, signals: [], compositions: [] } as unknown as NarrativeGraphsFileDef);

  it('createAuthorSignal stores trimmed notes and the catalog carries them', () => {
    const data = emptyData();
    createAuthorSignal(data, 'go', '出发', '  队伍集结完毕后发出，驱动主线进入第一单  ');
    expect(data.signals?.[0]).toMatchObject({ id: 'go', label: '出发', notes: '队伍集结完毕后发出，驱动主线进入第一单' });
    const entry = buildSignalCatalog(data).find((e) => e.id === 'go');
    expect(entry?.notes).toBe('队伍集结完毕后发出，驱动主线进入第一单');
  });

  it('setAuthorSignalNotes sets, updates, and clears notes on an existing signal', () => {
    const data = emptyData();
    createAuthorSignal(data, 'go');
    setAuthorSignalNotes(data, 'go', '第一版注释');
    expect(data.signals?.[0]?.notes).toBe('第一版注释');
    setAuthorSignalNotes(data, 'go', '改过的注释');
    expect(data.signals?.[0]?.notes).toBe('改过的注释');
    setAuthorSignalNotes(data, 'go', '   ');
    expect(data.signals?.[0]?.notes).toBeUndefined(); // 清空 = 删键
    expect(data.signals).toHaveLength(1); // 信号本身还在
  });

  it('setAuthorSignalNotes registers a referenced-but-unregistered author signal when annotated', () => {
    const data = emptyData();
    // 该信号只被引用、未注册进 data.signals
    setAuthorSignalNotes(data, 'used_only', '监听这条信号的迁移在别处');
    expect(data.signals).toEqual([{ id: 'used_only', notes: '监听这条信号的迁移在别处' }]);
  });

  it('setAuthorSignalNotes ignores derived/reserved ids and does not create empty rows', () => {
    const data = emptyData();
    setAuthorSignalNotes(data, 'state:flow:s0', '派生信号不接受作者注释');
    setAuthorSignalNotes(data, 'brand_new', '   '); // 空注释 + 未注册 → 不建空行
    expect(data.signals).toEqual([]);
  });
});
