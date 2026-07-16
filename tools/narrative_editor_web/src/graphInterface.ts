import type { NarrativeGraphDef } from './types';

/** 子图的信号接口——全部从图内容自动推导，展示用，永不落盘。 */
export type DerivedGraphInterface = {
  /** 实际会发出的信号：状态动作里的 emitNarrativeSignal + broadcastOnEnter 派生广播 */
  emits: string[];
  /** 迁移在监听的信号（不含 __draft__ 占位） */
  listens: string[];
  /** 条件叶子读取的别的图状态，展示为 `图id.状态id` */
  readsStates: string[];
};

const DRAFT_SIGNAL = '__draft__';

function walkEmits(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) walkEmits(child, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;
  if (rec.type === 'emitNarrativeSignal') {
    const params = rec.params as Record<string, unknown> | undefined;
    const sig = typeof params?.signal === 'string' ? params.signal.trim() : '';
    if (sig) out.add(sig);
  }
  for (const value of Object.values(rec)) walkEmits(value, out);
}

function walkNarrativeLeaves(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) walkNarrativeLeaves(child, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;
  if (typeof rec.narrative === 'string' && typeof rec.state === 'string') {
    const gid = rec.narrative.trim();
    const sid = rec.state.trim();
    if (gid && sid) out.add(`${gid}.${sid}`);
  }
  for (const value of Object.values(rec)) walkNarrativeLeaves(value, out);
}

export function deriveGraphInterface(graph: NarrativeGraphDef | undefined): DerivedGraphInterface {
  if (!graph) return { emits: [], listens: [], readsStates: [] };
  const emits = new Set<string>();
  const listens = new Set<string>();
  const reads = new Set<string>();

  walkEmits(graph.states ?? {}, emits);
  for (const [stateId, state] of Object.entries(graph.states ?? {})) {
    if ((state as { broadcastOnEnter?: boolean } | undefined)?.broadcastOnEnter === true) {
      emits.add(`state:${graph.id}:${stateId}`);
    }
  }
  for (const transition of graph.transitions ?? []) {
    const sig = typeof transition.signal === 'string' ? transition.signal.trim() : '';
    if (sig && sig !== DRAFT_SIGNAL) listens.add(sig);
  }
  walkNarrativeLeaves(graph, reads);

  return {
    emits: [...emits].sort(),
    listens: [...listens].sort(),
    readsStates: [...reads].sort(),
  };
}
