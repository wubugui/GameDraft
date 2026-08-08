import { describe, expect, it } from 'vitest';
import {
  createElement,
  normalizeFile,
  compileGraphs,
  isSubgraphElement,
  validateNarrativeData,
  buildSignalCatalog,
  collectKnownSignals,
  renameAuthorSignal,
} from './editorModel';
import {
  coerceLocalVarValue,
  declaredLocalEmits,
  duplicateLocalVarKeys,
  isLocalMachineGraphDef,
  localMachineGraphIds,
  localVarKeys,
  nextLocalVarKey,
  setLocalSignalList,
  setLocalVars,
  validateLocalMachines,
} from './localMachine';
import type { NarrativeGraphsFileDef } from './types';

/** 一份「主图 + 一台局部机原型」的最小可校验文件。 */
function fileWithMachine(overrides?: {
  local?: Record<string, unknown>;
  states?: Record<string, unknown>;
  transitions?: unknown[];
  graph?: Record<string, unknown>;
}): NarrativeGraphsFileDef {
  return normalizeFile({
    schemaVersion: 3,
    signals: [{ id: '第三章开始' }, { id: '箱子_已取' }],
    compositions: [
      {
        id: 'comp_1',
        mainGraph: {
          id: 'flow_1',
          ownerType: 'flow',
          initialState: 'initial',
          states: { initial: { id: 'initial', meta: {} } },
          transitions: [],
        },
        elements: [
          {
            id: 'machine_1',
            kind: 'localMachine',
            label: '可拾取物',
            ownerType: 'system',
            x: 0,
            y: 0,
            meta: { emits: [], reads: [], commands: [] },
            graph: {
              id: 'lm_可拾取物',
              ownerType: 'system',
              local: overrides?.local ?? { vars: [{ key: 'peeked', type: 'bool', default: false }] },
              initialState: 'inactive',
              states: overrides?.states ?? {
                inactive: { id: 'inactive', meta: {} },
                active: { id: 'active', meta: {} },
              },
              transitions: overrides?.transitions ?? [],
              ...(overrides?.graph ?? {}),
            },
          },
        ],
      },
    ],
  }) as NarrativeGraphsFileDef;
}

function codes(file: NarrativeGraphsFileDef): string[] {
  return validateLocalMachines(file).map((i) => i.code);
}

describe('局部机原型 · 模型层', () => {
  it('createElement 造出的局部机是「有 local 声明的 system 图」，且不写 refId/ownerId', () => {
    const data = normalizeFile({ schemaVersion: 3, signals: [], compositions: [] }) as NarrativeGraphsFileDef;
    const comp = (data.compositions ??= []).length
      ? data.compositions[0]
      : (data.compositions.push({
        id: 'c', mainGraph: { id: 'g', ownerType: 'flow', initialState: 's', states: { s: { id: 's' } }, transitions: [] }, elements: [],
      }), data.compositions[0]);
    const el = createElement(comp, 'localMachine', data);
    expect(el.kind).toBe('localMachine');
    expect(el.ownerType).toBe('system');
    expect(el.refId).toBeUndefined();
    expect(el.ownerId).toBeUndefined();
    expect(isLocalMachineGraphDef(el.graph)).toBe(true);
    expect(el.graph?.ownerType).toBe('system');
    // 空 local 只写判据本身，不注入 vars/listens/emits 默认键
    expect(Object.keys(el.graph?.local ?? {})).toEqual([]);
    expect(el.graph && Object.keys(el.graph.states)).toEqual(['inactive']);
  });

  it('局部机的内嵌图进 compileGraphs / isSubgraphElement（否则改名与校验看不见它）', () => {
    const data = fileWithMachine();
    expect(compileGraphs(data).map(({ graph }) => graph.id)).toContain('lm_可拾取物');
    expect(isSubgraphElement(data.compositions![0].elements![0])).toBe(true);
    expect([...localMachineGraphIds(data)]).toEqual(['lm_可拾取物']);
  });

  it('setLocalVars / setLocalSignalList 空即删键（不往 JSON 塞空数组噪音）', () => {
    const graph = { id: 'lm', ownerType: 'system', local: {}, initialState: 's', states: {}, transitions: [] } as never as import('./types').NarrativeGraphDef;
    setLocalVars(graph, [{ key: 'k', type: 'float', default: 0 }]);
    expect(graph.local?.vars).toHaveLength(1);
    setLocalVars(graph, []);
    expect('vars' in (graph.local ?? {})).toBe(false);
    setLocalSignalList(graph, 'listens', [' 第三章开始 ', '']);
    expect(graph.local?.listens).toEqual(['第三章开始']);
    setLocalSignalList(graph, 'listens', []);
    expect('listens' in (graph.local ?? {})).toBe(false);
  });

  it('变量小工具：重复键 / 建议键 / 值转型', () => {
    const vars = [{ key: 'a', type: 'bool' as const }, { key: 'a', type: 'bool' as const }, { key: '', type: 'bool' as const }];
    expect([...duplicateLocalVarKeys(vars)]).toEqual(['a']);
    expect(nextLocalVarKey([{ key: 'var_1', type: 'bool' }])).toBe('var_2');
    expect(coerceLocalVarValue('true', 'bool')).toBe(true);
    expect(coerceLocalVarValue('3.5', 'float')).toBe(3.5);
    expect(coerceLocalVarValue('abc', 'float')).toBe(0);
    expect(coerceLocalVarValue('abc', 'string')).toBe('abc');
    expect(localVarKeys({ local: { vars } } as never)).toEqual(['a', 'a']);
  });
});

describe('局部机原型 · 校验（设计稿 §6）', () => {
  it('干净的局部机零问题', () => {
    const data = fileWithMachine({
      local: { vars: [{ key: 'peeked', type: 'bool', default: false }], listens: ['第三章开始'] },
      transitions: [{ id: 't1', from: 'inactive', to: 'active', signal: '第三章开始' }],
    });
    expect(validateLocalMachines(data)).toEqual([]);
  });

  it('reactive 触发在局部机上是 error', () => {
    const data = fileWithMachine({
      local: { listens: ['第三章开始'] },
      transitions: [{ id: 't1', from: 'inactive', to: 'active', signal: '第三章开始', trigger: 'reactiveAll', conditions: [] }],
    });
    expect(codes(data)).toContain('local.transition.reactive.forbidden');
  });

  it('broadcastOnEnter / activePlane / ownerId 在局部机上都是 error（私有性三条边界）', () => {
    const data = fileWithMachine({
      states: {
        inactive: { id: 'inactive', meta: {} },
        active: { id: 'active', broadcastOnEnter: true, activePlane: 'dream', meta: {} },
      },
      graph: { ownerId: 'npc_x' },
    });
    const found = codes(data);
    expect(found).toContain('local.state.broadcast.forbidden');
    expect(found).toContain('local.state.plane.forbidden');
    expect(found).toContain('local.ownerId.forbidden');
  });

  it('local 与 run 互斥', () => {
    const data = fileWithMachine({ graph: { run: { repeatable: true } } });
    expect(codes(data)).toContain('local.run.conflict');
  });

  it('变量表：重复键 / 非法类型 / 默认值类型对不上', () => {
    const data = fileWithMachine({
      local: {
        vars: [
          { key: 'a', type: 'bool', default: false },
          { key: 'a', type: 'float', default: 0 },
          { key: 'b', type: 'int', default: 0 },
          { key: 'c', type: 'float', default: 'x' },
          { key: '', type: 'bool' },
        ],
      },
    });
    const found = codes(data);
    expect(found).toContain('local.var.key.duplicate');
    expect(found).toContain('local.var.type.invalid');
    expect(found).toContain('local.var.default.mismatch');
    expect(found).toContain('local.var.key.empty');
  });

  it('localVar 叶：未声明的 key 报错；局部机之外出现直接是 error', () => {
    const data = fileWithMachine({
      local: { vars: [{ key: 'kicks', type: 'float', default: 0 }], listens: ['第三章开始'] },
      transitions: [
        { id: 't1', from: 'inactive', to: 'active', signal: '第三章开始', conditions: [{ localVar: 'kicks', op: '>=', value: 3 }] },
        { id: 't2', from: 'inactive', to: 'active', signal: '第三章开始', conditions: [{ localVar: 'nope', op: '==', value: 1 }] },
      ],
    });
    expect(codes(data)).toContain('local.var.leaf.undeclared');

    const outside = fileWithMachine();
    outside.compositions![0].mainGraph.transitions.push({
      id: 't_out', from: 'initial', to: 'initial', signal: '第三章开始', conditions: [{ localVar: 'kicks', op: '==', value: 1 }],
    });
    expect(codes(outside)).toContain('local.var.leaf.outside');
  });

  it('narrative 条件叶不接受局部机 id（实例状态对外不可寻址）', () => {
    const data = fileWithMachine();
    data.compositions![0].mainGraph.transitions.push({
      id: 't_read', from: 'initial', to: 'initial', signal: '第三章开始',
      conditions: [{ narrative: 'lm_可拾取物', state: 'active' }],
    });
    expect(codes(data)).toContain('local.narrative.ref.forbidden');
  });

  it('声明漂移只报 warning（不拦保存）', () => {
    const data = fileWithMachine({
      local: { listens: ['第三章开始'], emits: ['箱子_已取'] },
      transitions: [],
    });
    const issues = validateLocalMachines(data);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(issues.map((i) => i.code)).toContain('local.listens.drift');
    expect(issues.map((i) => i.code)).toContain('local.emits.drift');
  });

  it('validateNarrativeData 叠加局部机校验，并剔除权威侧对局部机的 blackbox.ref.empty 误报', () => {
    const data = fileWithMachine({
      local: { listens: ['第三章开始'] },
      transitions: [{ id: 't1', from: 'inactive', to: 'active', signal: '第三章开始', trigger: 'reactive', conditions: [] }],
    });
    const issues = validateNarrativeData(data);
    expect(issues.some((i) => i.code === 'local.transition.reactive.forbidden' && i.severity === 'error')).toBe(true);
    expect(issues.some((i) => i.code === 'blackbox.ref.empty')).toBe(false);
  });
});

describe('局部机原型 · 信号面', () => {
  it('local.emits / local.listens 进信号目录（否则整整一类容器的信号漏掉）', () => {
    const data = fileWithMachine({ local: { listens: ['未注册监听'], emits: ['未注册导出'] } });
    const catalog = buildSignalCatalog(data);
    const emitEntry = catalog.find((e) => e.id === '未注册导出');
    const listenEntry = catalog.find((e) => e.id === '未注册监听');
    expect(emitEntry?.label).toContain('局部机');
    expect(emitEntry?.editable).toBe(false);
    expect(listenEntry?.label).toContain('局部机');
    expect(collectKnownSignals(data)).toEqual(expect.arrayContaining(['未注册导出', '未注册监听']));
  });

  it('declaredLocalEmits 收全文件的导出声明（TaskBus 悬空豁免用）', () => {
    const data = fileWithMachine({ local: { emits: ['箱子_已取', ' '] } });
    expect(declaredLocalEmits(data)).toEqual(['箱子_已取']);
  });

  it('信号改名级联到 local.listens / local.emits', () => {
    const data = fileWithMachine({ local: { listens: ['第三章开始'], emits: ['箱子_已取'] } });
    renameAuthorSignal(data, '第三章开始', '第三章_开幕');
    expect(data.compositions![0].elements![0].graph!.local!.listens).toEqual(['第三章_开幕']);
    renameAuthorSignal(data, '箱子_已取', '箱子_取走了');
    expect(data.compositions![0].elements![0].graph!.local!.emits).toEqual(['箱子_取走了']);
  });
});
