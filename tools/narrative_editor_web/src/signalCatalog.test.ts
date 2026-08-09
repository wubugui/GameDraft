import { describe, expect, it } from 'vitest';
import {
  buildSignalCatalog,
  collectKnownSignals,
  collectPrivateSignalIds,
  createAuthorSignal,
  isPrivateAuthorSignal,
  isUnregisteredAuthorSignal,
  renameAuthorSignal,
  setAuthorSignalNotes,
  setAuthorSignalScope,
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

describe('catalog registered 标记（影子条目可辨认 + 可一键补登记）', () => {
  const dataWithGhost = (): NarrativeGraphsFileDef => ({
    schemaVersion: 3,
    signals: [{ id: 'real' }],
    compositions: [{
      id: 'comp',
      mainGraph: {
        id: 'flow',
        ownerType: 'flow',
        initialState: 'a',
        states: { a: { id: 'a' }, b: { id: 'b', broadcastOnEnter: true } },
        transitions: [
          { id: 't1', from: 'a', to: 'b', signal: 'real' },
          { id: 't2', from: 'b', to: 'a', signal: 'ghost' },
          { id: 't3', from: 'a', to: 'b', signal: 'state:flow:b' },
        ],
      },
      elements: [],
    }],
  } as unknown as NarrativeGraphsFileDef);

  it('有注册行 → registered:true；只被监听 → registered:false', () => {
    const catalog = buildSignalCatalog(dataWithGhost());
    expect(catalog.find((e) => e.id === 'real')?.registered).toBe(true);
    expect(catalog.find((e) => e.id === 'ghost')?.registered).toBe(false);
  });

  it('派生广播与草稿占位不算未登记（它们本就没有注册行）', () => {
    const catalog = buildSignalCatalog(dataWithGhost());
    expect(catalog.find((e) => e.id === 'state:flow:b')?.registered).toBe(true);
    expect(catalog.find((e) => e.kind === 'draft')?.registered).toBe(true);
  });

  it('对影子条目调 createAuthorSignal 即可补登记，之后 registered 翻真', () => {
    const data = dataWithGhost();
    createAuthorSignal(data, 'ghost');
    expect(data.signals).toEqual([{ id: 'real' }, { id: 'ghost' }]);
    expect(buildSignalCatalog(data).find((e) => e.id === 'ghost')?.registered).toBe(true);
  });

  it('未登记判据在弹窗与检查器之间是同一个函数（blackbox 声明也必须能补登记）', () => {
    const data = {
      schemaVersion: 3,
      signals: [{ id: 'real' }],
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow', ownerType: 'flow', initialState: 'a',
          states: { a: { id: 'a' }, b: { id: 'b', broadcastOnEnter: true } },
          transitions: [{ id: 't', from: 'a', to: 'b', signal: 'ghost' }],
        },
        elements: [{ id: 'bb', kind: 'blackbox', label: '黑盒', meta: { emits: ['declared_only'] } }],
      }],
    } as unknown as NarrativeGraphsFileDef;
    // blackbox 声明来的条目 editable:false（没有可改名/删除的行），但**补登记必须能点**——
    // 否则检查器报警告、弹窗里却修不了（历史 bug：按钮曾用 editable gate）。
    expect(buildSignalCatalog(data).find((e) => e.id === 'declared_only')?.editable).toBe(false);
    expect(isUnregisteredAuthorSignal(data, 'declared_only')).toBe(true);
    expect(isUnregisteredAuthorSignal(data, 'ghost')).toBe(true);
    expect(isUnregisteredAuthorSignal(data, 'real')).toBe(false);
    // 派生 / 草稿 / 空 id 本就不该有注册行
    expect(isUnregisteredAuthorSignal(data, 'state:flow:b')).toBe(false);
    expect(isUnregisteredAuthorSignal(data, '__draft__')).toBe(false);
    expect(isUnregisteredAuthorSignal(data, '   ')).toBe(false);
  });

  it('blackbox 只声明未注册的 emits 同样标为未登记', () => {
    const data = {
      schemaVersion: 3,
      signals: [],
      compositions: [{
        id: 'comp',
        mainGraph: { id: 'flow', ownerType: 'flow', initialState: 'a', states: { a: { id: 'a' } }, transitions: [] },
        elements: [{ id: 'bb', kind: 'blackbox', label: '黑盒', meta: { emits: ['declared_only'] } }],
      }],
    } as unknown as NarrativeGraphsFileDef;
    expect(buildSignalCatalog(data).find((e) => e.id === 'declared_only')?.registered).toBe(false);
  });
});

describe('私有信号 scope', () => {
  const baseData = (): NarrativeGraphsFileDef => ({
    schemaVersion: 3,
    signals: [{ id: 'box_open' }, { id: 'main_go' }],
    compositions: [{
      id: 'comp',
      mainGraph: {
        id: 'flow', ownerType: 'flow', initialState: 'a',
        states: { a: { id: 'a' } }, transitions: [],
      },
      elements: [],
    }],
  } as unknown as NarrativeGraphsFileDef);

  it('勾私有写 scope:private；取消勾选**删键**而不是写 global', () => {
    const data = baseData();
    setAuthorSignalScope(data, 'box_open', true);
    expect(data.signals![0]).toEqual({ id: 'box_open', scope: 'private' });

    setAuthorSignalScope(data, 'box_open', false);
    // 关键：不是 scope:'global'。默认值塞进 JSON = 噪声 + 让没动过的行在 diff 里变脏
    expect(Object.prototype.hasOwnProperty.call(data.signals![0]!, 'scope')).toBe(false);
    expect(data.signals![0]).toEqual({ id: 'box_open' });
  });

  it('取消勾选后与从未勾过的行逐字节同形（往返幂等的最小单元）', () => {
    const pristine = JSON.stringify(baseData());
    const data = baseData();
    setAuthorSignalScope(data, 'box_open', true);
    setAuthorSignalScope(data, 'box_open', false);
    expect(JSON.stringify(data)).toBe(pristine);
  });

  it('新建信号：不勾私有不写 scope 键，勾了才写', () => {
    const plain = { schemaVersion: 3, signals: [], compositions: [] } as unknown as NarrativeGraphsFileDef;
    createAuthorSignal(plain, 'a');
    createAuthorSignal(plain, 'b', '乙', '备注', 'private');
    expect(plain.signals![0]).toEqual({ id: 'a' });
    expect(plain.signals![1]).toEqual({ id: 'b', label: '乙', notes: '备注', scope: 'private' });
  });

  it('勾私有即注册：只被引用、还没注册行的信号会顺手补一条', () => {
    const data = { schemaVersion: 3, signals: [], compositions: [] } as unknown as NarrativeGraphsFileDef;
    setAuthorSignalScope(data, 'ghost', true);
    expect(data.signals).toEqual([{ id: 'ghost', scope: 'private' }]);
    // 反过来：不存在的行取消勾选不该凭空造一行空注册
    const empty = { schemaVersion: 3, signals: [], compositions: [] } as unknown as NarrativeGraphsFileDef;
    setAuthorSignalScope(empty, 'ghost', false);
    expect(empty.signals).toEqual([]);
  });

  it('派生 / 草稿信号不接受 scope（它们由状态自动产生，没有注册行）', () => {
    const data = { schemaVersion: 3, signals: [], compositions: [] } as unknown as NarrativeGraphsFileDef;
    setAuthorSignalScope(data, 'state:flow:a', true);
    setAuthorSignalScope(data, '__draft__', true);
    setAuthorSignalScope(data, '   ', true);
    expect(data.signals).toEqual([]);
  });

  it('目录条目只在真是 private 时带 scope；全局行不带这个字段', () => {
    const data = baseData();
    setAuthorSignalScope(data, 'box_open', true);
    const catalog = buildSignalCatalog(data);
    expect(catalog.find((e) => e.id === 'box_open')?.scope).toBe('private');
    const global = catalog.find((e) => e.id === 'main_go')!;
    expect(Object.prototype.hasOwnProperty.call(global, 'scope')).toBe(false);
  });

  it('改名保留 scope（改个名字不该把私有悄悄变回全局）', () => {
    const data = baseData();
    setAuthorSignalScope(data, 'box_open', true);
    renameAuthorSignal(data, 'box_open', 'crate_open');
    expect(data.signals![0]).toEqual({ id: 'crate_open', scope: 'private' });
    expect(isPrivateAuthorSignal(data, 'crate_open')).toBe(true);
    expect(isPrivateAuthorSignal(data, 'box_open')).toBe(false);
  });

  it('collectPrivateSignalIds 只收注册行写了 private 的（空 id / 全局行不进集合）', () => {
    const data = {
      schemaVersion: 3,
      signals: [
        { id: 'p1', scope: 'private' },
        { id: 'g1' },
        { id: 'g2', scope: 'global' },
        { id: '  ', scope: 'private' },
      ],
      compositions: [],
    } as unknown as NarrativeGraphsFileDef;
    expect([...collectPrivateSignalIds(data)]).toEqual(['p1']);
  });
});
