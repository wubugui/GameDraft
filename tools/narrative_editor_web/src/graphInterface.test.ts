import { describe, expect, it } from 'vitest';
import { deriveGraphInterface } from './graphInterface';
import type { NarrativeGraphDef } from './types';

const graph: NarrativeGraphDef = {
  id: 'wrap_张三',
  ownerType: 'npc',
  ownerId: 'npc_张三',
  initialState: 'idle',
  states: {
    idle: { id: 'idle' },
    greet: {
      id: 'greet',
      broadcastOnEnter: true,
      onEnterActions: [
        { type: 'emitNarrativeSignal', params: { signal: 'greeted' } },
        { type: 'runActions', params: {}, actions: [
          { type: 'emitNarrativeSignal', params: { signal: 'nested_sig' } },
        ] },
      ],
    },
  },
  transitions: [
    { id: 't1', from: 'idle', to: 'greet', signal: 'player_waved' },
    { id: 't2', from: 'greet', to: 'idle', signal: '__draft__',
      conditions: [{ narrative: 'flow_main', state: 's01', reached: true }] },
  ],
} as unknown as NarrativeGraphDef;

describe('deriveGraphInterface', () => {
  it('推导发出信号：状态动作 emit（含嵌套）+ broadcastOnEnter 派生广播', () => {
    const derived = deriveGraphInterface(graph);
    expect(derived.emits).toEqual(['greeted', 'nested_sig', 'state:wrap_张三:greet']);
  });

  it('推导监听信号：迁移 signal，排除 __draft__ 占位', () => {
    expect(deriveGraphInterface(graph).listens).toEqual(['player_waved']);
  });

  it('推导读取状态：条件叶子 {narrative, state} → 图.状态', () => {
    expect(deriveGraphInterface(graph).readsStates).toEqual(['flow_main.s01']);
  });

  it('无图（黑盒元素）返回空接口', () => {
    expect(deriveGraphInterface(undefined)).toEqual({ emits: [], listens: [], readsStates: [] });
  });
});
