import {
  DEFAULT_DRAFT_SIGNAL,
  isDerivedStateSignal,
  isReservedAuthorSignalId,
  stateBroadcastOnEnter,
  stateEnteredSignalKey,
} from './signalConstants';
import type {
  NarrativeAuthorSignalDef,
  NarrativeGraphsFileDef,
  SignalCatalogEntryDef,
  SignalEmitterRefDef,
  SignalListenerRefDef,
} from './types';

function collectGraphs(data: NarrativeGraphsFileDef) {
  const graphs: Array<{ graph: import('./types').NarrativeGraphDef; compositionId: string }> = [];
  for (const comp of data.compositions ?? []) {
    if (comp.mainGraph?.id) graphs.push({ graph: comp.mainGraph, compositionId: comp.id });
    for (const el of comp.elements ?? []) {
      if (el.graph?.id) graphs.push({ graph: el.graph, compositionId: comp.id });
    }
  }
  return graphs;
}

export function collectListenerRefs(data: NarrativeGraphsFileDef): Map<string, SignalListenerRefDef[]> {
  const map = new Map<string, SignalListenerRefDef[]>();
  for (const { graph, compositionId } of collectGraphs(data)) {
    for (const t of graph.transitions ?? []) {
      const sig = String(t.signal ?? '').trim();
      if (!sig) continue;
      const list = map.get(sig) ?? [];
      list.push({
        compositionId,
        graphId: graph.id,
        transitionId: t.id,
        from: String(t.from),
        to: String(t.to),
      });
      map.set(sig, list);
    }
  }
  return map;
}

export function buildSignalCatalog(
  data: NarrativeGraphsFileDef,
  emitterRefsById?: Map<string, SignalEmitterRefDef[]>,
): SignalCatalogEntryDef[] {
  const listeners = collectListenerRefs(data);
  const entries = new Map<string, SignalCatalogEntryDef>();

  for (const s of data.signals ?? []) {
    const id = String(s.id ?? '').trim();
    if (!id) continue;
    entries.set(id, {
      id,
      kind: 'author',
      label: s.label,
      notes: s.notes,
      listeners: listeners.get(id)?.length ?? 0,
      emitters: emitterRefsById?.get(id)?.length ?? 0,
      editable: true,
      registered: true,
    });
  }

  for (const { graph } of collectGraphs(data)) {
    for (const [stateId, state] of Object.entries(graph.states ?? {})) {
      if (!stateBroadcastOnEnter(state)) continue;
      const id = stateEnteredSignalKey(graph.id, stateId);
      if (entries.has(id)) continue;
      entries.set(id, {
        id,
        kind: 'derived',
        label: `${graph.id}.${stateId}`,
        graphId: graph.id,
        stateId,
        listeners: listeners.get(id)?.length ?? 0,
        emitters: 0,
        editable: false,
        registered: true, // 派生广播由状态自动产生，本就不需要注册行
      });
    }
  }

  // blackbox 声明的 emits：element 只在 meta.emits 里"声明"它会发出某信号（真正发出发生在其
  // 引用的对话/资产内容里，目录构建阶段读不到）。目录必须收录这些声明，否则该信号既进不了信号选择
  // 弹窗、监听它的 transition 又会被判成悬空断链。未被注册为作者信号时补一条 editable:false 的条目
  // （无 data.signals 行可改名/删除）。放在监听推断之前，让"仅声明"的信号带上明确 label。
  for (const comp of data.compositions ?? []) {
    for (const el of comp.elements ?? []) {
      const emits = el.meta?.emits;
      if (!Array.isArray(emits)) continue;
      for (const raw of emits) {
        const id = String(raw ?? '').trim();
        if (!id || entries.has(id)) continue;
        const label = String(el.label ?? el.id ?? '').trim();
        entries.set(id, {
          id,
          kind: isDerivedStateSignal(id) ? 'derived' : 'author',
          label: label ? `来自 blackbox ${label} 声明` : '来自 blackbox 声明',
          listeners: listeners.get(id)?.length ?? 0,
          emitters: emitterRefsById?.get(id)?.length ?? 0,
          editable: false,
          registered: isDerivedStateSignal(id),
        });
      }
    }
  }

  // 局部机原型的 local.listens / local.emits：这是**唯一一类**信号面不在转移/动作树里的容器
  // ——局部机对外只经全局信号进出，声明面就是 local 里这两行。不收它 = "谁在发谁在听"漏掉
  // 整整一类容器：导出信号既进不了信号弹窗候选，监听它的转移还会被判成悬空断链。
  // 与 blackbox meta.emits 同待遇：补影子条目、editable:false（没有 signals 注册行可改）。
  for (const { graph } of collectGraphs(data)) {
    if (!graph.local) continue;
    const label = String(graph.label ?? '').trim() || graph.id;
    for (const [field, note] of [['emits', '导出'], ['listens', '监听']] as const) {
      for (const raw of graph.local[field] ?? []) {
        const id = String(raw ?? '').trim();
        if (!id || entries.has(id)) continue;
        entries.set(id, {
          id,
          kind: isDerivedStateSignal(id) ? 'derived' : 'author',
          label: `来自局部机「${label}」${note}声明`,
          listeners: listeners.get(id)?.length ?? 0,
          emitters: emitterRefsById?.get(id)?.length ?? 0,
          editable: false,
          registered: isDerivedStateSignal(id),
        });
      }
    }
  }

  for (const [id, refs] of listeners) {
    if (entries.has(id)) continue;
    entries.set(id, {
      id,
      kind: isDerivedStateSignal(id) ? 'derived' : 'author',
      listeners: refs.length,
      emitters: emitterRefsById?.get(id)?.length ?? 0,
      editable: !isDerivedStateSignal(id) && !isReservedAuthorSignalId(id),
      // 只被监听、没有注册行 = 影子条目。派生形态的 state:… 若指向已删状态则不算"作者未登记"，
      // 由 state.broadcast.missing 另行报，故这里按派生放行不标未登记。
      registered: isDerivedStateSignal(id),
    });
  }

  entries.set(DEFAULT_DRAFT_SIGNAL, {
    id: DEFAULT_DRAFT_SIGNAL,
    kind: 'draft',
    label: '未分配（草稿）',
    listeners: listeners.get(DEFAULT_DRAFT_SIGNAL)?.length ?? 0,
    emitters: 0,
    editable: false,
    registered: true, // 保留占位符，不需要也不允许注册行
  });

  return [...entries.values()].sort((a, b) => {
    const order = { draft: 0, author: 1, derived: 2 };
    const ka = order[a.kind] ?? 9;
    const kb = order[b.kind] ?? 9;
    if (ka !== kb) return ka - kb;
    return a.id.localeCompare(b.id);
  });
}

export function collectKnownSignals(data: NarrativeGraphsFileDef): string[] {
  return buildSignalCatalog(data)
    .filter((e) => e.kind !== 'draft')
    .map((e) => e.id);
}

/**
 * 「这条信号缺一行 signals 注册行、而且补得上」——目录弹窗的「补登记」按钮与迁移检查器的
 * 未登记提示**共用这一个判据**，别各写各的（两处镜像迟早漂移：曾经弹窗用 `entry.editable`
 * gate，于是 blackbox 声明来的信号在检查器里报警告、在弹窗里却没有补登记按钮）。
 *
 * 派生 `state:…`、草稿 `__draft__`、空 id 本来就不该有注册行，一律 false。
 */
export function isUnregisteredAuthorSignal(data: NarrativeGraphsFileDef, id: string): boolean {
  const target = String(id ?? '').trim();
  if (!target || isReservedAuthorSignalId(target)) return false;
  return !(data.signals ?? []).some((s) => s.id === target);
}

export function createAuthorSignal(data: NarrativeGraphsFileDef, id: string, label?: string, notes?: string): void {
  const trimmed = String(id ?? '').trim();
  if (isReservedAuthorSignalId(trimmed)) throw new Error(`Invalid signal id: ${trimmed}`);
  data.signals ??= [];
  if (data.signals.some((s) => s.id === trimmed)) throw new Error(`Signal already exists: ${trimmed}`);
  const entry: NarrativeAuthorSignalDef = { id: trimmed };
  if (label?.trim()) entry.label = label.trim();
  if (notes?.trim()) entry.notes = notes.trim();
  data.signals.push(entry);
}

/**
 * 给作者信号写/改注释。注释就是「注册那个地方」——若该信号已被引用但还没进 data.signals，
 * 写注释时顺手把它注册进去（注释即注册）。派生/保留信号不接受作者注释（它们由状态自动生成）。
 * 清空注释 = 删 notes 键；对本来就不存在、又被清空的信号不无谓创建空行。
 */
export function setAuthorSignalNotes(data: NarrativeGraphsFileDef, id: string, notes: string): void {
  const target = String(id ?? '').trim();
  if (!target || isReservedAuthorSignalId(target) || isDerivedStateSignal(target)) return;
  data.signals ??= [];
  const row = data.signals.find((s) => s.id === target);
  const trimmed = String(notes ?? '').trim();
  if (row) {
    if (trimmed) row.notes = trimmed;
    else delete row.notes;
  } else if (trimmed) {
    data.signals.push({ id: target, notes: trimmed });
  }
}

/** 递归更新 emitNarrativeSignal 动作里 params.signal 的引用（动作可嵌套，故递归）。 */
function replaceEmitSignalInActions(value: unknown, from: string, to: string): void {
  if (Array.isArray(value)) {
    for (const item of value) replaceEmitSignalInActions(item, from, to);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  if (obj.type === 'emitNarrativeSignal' && obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params)) {
    const params = obj.params as Record<string, unknown>;
    if (String(params.signal ?? '').trim() === from) params.signal = to;
  }
  for (const v of Object.values(obj)) replaceEmitSignalInActions(v, from, to);
}

export function renameAuthorSignal(data: NarrativeGraphsFileDef, oldId: string, newId: string): void {
  const from = String(oldId ?? '').trim();
  const to = String(newId ?? '').trim();
  if (!from || !to || from === to) return;
  if (isReservedAuthorSignalId(to)) throw new Error(`Invalid signal id: ${to}`);
  data.signals ??= [];
  const row = data.signals.find((s) => s.id === from);
  if (!row) throw new Error(`Unknown author signal: ${from}`);
  if (data.signals.some((s) => s.id === to)) throw new Error(`Signal already exists: ${to}`);
  row.id = to;
  for (const { graph } of collectGraphs(data)) {
    for (const t of graph.transitions ?? []) {
      if (t.signal === from) t.signal = to;
    }
    // 信号改名必须级联到 emitNarrativeSignal 动作参数，否则发射端仍用旧名 → 运行时永不触发
    // 该迁移（与 renameStateInGraph 级联条件/命令/信号引用同理，之前只漏了这一处）。
    for (const state of Object.values(graph.states ?? {})) {
      replaceEmitSignalInActions(state.onEnterActions, from, to);
      replaceEmitSignalInActions(state.onExitActions, from, to);
    }
    // 局部机的 local.listens / local.emits 是声明面（信号索引与漂移校验按它算），
    // 不跟着改名就会留下指向旧名的声明：既报"声明了没人发"，又让索引漏投。
    if (graph.local) {
      for (const field of ['listens', 'emits'] as const) {
        const list = graph.local[field];
        if (Array.isArray(list)) graph.local[field] = list.map((s) => (String(s) === from ? to : s));
      }
    }
  }
  for (const comp of data.compositions ?? []) {
    for (const el of comp.elements ?? []) {
      if (!Array.isArray(el.meta?.emits)) continue;
      el.meta.emits = el.meta.emits.map((s) => (String(s) === from ? to : s));
    }
  }
}

export function deleteAuthorSignal(data: NarrativeGraphsFileDef, id: string): void {
  const target = String(id ?? '').trim();
  data.signals = (data.signals ?? []).filter((s) => s.id !== target);
}
