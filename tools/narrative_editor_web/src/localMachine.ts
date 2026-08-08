/**
 * 局部机原型（实体绑定即实例化的私有状态机）的编辑器侧纯逻辑。
 *
 * 数据形状以运行时 `src/core/NarrativeStateManager.ts`（NarrativeLocalDef / NarrativeLocalVarDef /
 * isLocalMachineGraph）为权威，设计契约见
 * `artifact/Design/实体局部状态机-技术设计-2026-08-08.md`。
 *
 * 这里额外承担一段**临时**职责：`src/core/narrativeGraphValidation.ts`（TS 权威）目前只认
 * wrapperGraph / scenarioSubgraph，对 `kind: 'localMachine'` 的元素既不校验其内嵌图、又会误报
 * 一条 `blackbox.ref.empty`。在权威侧补上之前，本模块提供局部机专属校验（设计稿 §6）与
 * 那条误报的过滤（见 editorModel.validateNarrativeData）。**权威侧补齐后应整段删除，别留两份。**
 */
import type {
  CompositionElementDef,
  NarrativeGraphDef,
  NarrativeGraphsFileDef,
  NarrativeLocalVarDef,
  NarrativeStateNodeDef,
  ValidationIssueDef,
  ValidationTargetDef,
} from './types';

export const LOCAL_VAR_TYPES = ['bool', 'float', 'string'] as const;
export type LocalVarType = (typeof LOCAL_VAR_TYPES)[number];

/** 局部机原型 = 有 `local` 声明的图（与运行时 isLocalMachineGraph 同判据）。 */
export function isLocalMachineGraphDef(graph: NarrativeGraphDef | undefined | null): boolean {
  return Boolean(graph?.local);
}

export function isLocalMachineElement(el: CompositionElementDef | undefined | null): boolean {
  return el?.kind === 'localMachine';
}

export function localVarsOf(graph: NarrativeGraphDef | undefined | null): NarrativeLocalVarDef[] {
  const vars = graph?.local?.vars;
  return Array.isArray(vars) ? vars : [];
}

export function localVarKeys(graph: NarrativeGraphDef | undefined | null): string[] {
  return localVarsOf(graph).map((v) => String(v?.key ?? '').trim()).filter(Boolean);
}

/** 重复的变量键集合（即时校验用；空键不算重复，另有空键错误）。 */
export function duplicateLocalVarKeys(vars: readonly NarrativeLocalVarDef[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of vars) {
    const key = String(v?.key ?? '').trim();
    if (!key) continue;
    if (seen.has(key)) dup.add(key);
    else seen.add(key);
  }
  return dup;
}

export function defaultValueForLocalVarType(type: LocalVarType): boolean | number | string {
  if (type === 'bool') return false;
  if (type === 'float') return 0;
  return '';
}

/** 把输入框里的字符串按声明类型落成 JSON 值（float 非法输入回退 0，不写 NaN）。 */
export function coerceLocalVarValue(raw: string, type: LocalVarType): boolean | number | string {
  if (type === 'bool') return raw === 'true' || raw === '1';
  if (type === 'float') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return raw;
}

export function localVarValueMatchesType(value: unknown, type: LocalVarType): boolean {
  if (value === undefined) return true; // 缺省 = 用类型默认值，合法
  if (type === 'bool') return typeof value === 'boolean';
  if (type === 'float') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'string';
}

/** 新变量的建议键（key_1、key_2…，与既有键不撞）。 */
export function nextLocalVarKey(vars: readonly NarrativeLocalVarDef[]): string {
  const taken = new Set(vars.map((v) => String(v?.key ?? '').trim()));
  let i = 1;
  while (taken.has(`var_${i}`)) i += 1;
  return `var_${i}`;
}

/* ------------------------------------------------------------------ 写入侧
 * 一律「空即删键」：不往 JSON 里塞 `"vars": []` / `"listens": []` 这类默认键噪音
 * （与 broadcastOnEnter/priority 的既有口径一致）。`local` 本身是局部机的判据，恒保留。
 */

export function setLocalVars(graph: NarrativeGraphDef, next: NarrativeLocalVarDef[]): void {
  graph.local ??= {};
  if (next.length) graph.local.vars = next;
  else delete graph.local.vars;
}

export function setLocalSignalList(graph: NarrativeGraphDef, field: 'listens' | 'emits', values: string[]): void {
  graph.local ??= {};
  const cleaned = values.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (cleaned.length) graph.local[field] = cleaned;
  else delete graph.local[field];
}

/* ------------------------------------------------------------------ 条件叶
 * `{ localVar, op, value }`：只在局部机自己的 transition 条件里合法（设计稿 §3.2）。
 */

export type LocalVarLeaf = {
  localVar: string;
  op?: '==' | '!=' | '>' | '>=' | '<' | '<=';
  value: boolean | number | string;
};

export const LOCAL_VAR_OPS: Array<LocalVarLeaf['op']> = ['==', '!=', '>', '>=', '<', '<='];

export function isLocalVarLeaf(value: unknown): value is LocalVarLeaf {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as LocalVarLeaf).localVar === 'string',
  );
}

/* ------------------------------------------------------------------ 遍历工具 */

type GraphSlot = {
  graph: NarrativeGraphDef;
  compositionId: string;
  elementId?: string;
  element?: CompositionElementDef;
};

/** 文件里所有可编辑图（含局部机元素的内嵌图）。 */
function iterGraphSlots(data: NarrativeGraphsFileDef): GraphSlot[] {
  const out: GraphSlot[] = [];
  for (const comp of data.compositions ?? []) {
    if (comp.mainGraph?.id) out.push({ graph: comp.mainGraph, compositionId: comp.id });
    for (const el of comp.elements ?? []) {
      if (el.graph?.id) out.push({ graph: el.graph, compositionId: comp.id, elementId: el.id, element: el });
    }
  }
  return out;
}

function visitConditionLeaves(value: unknown, fn: (leaf: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitConditionLeaves(item, fn);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  fn(obj);
  for (const child of Object.values(obj)) visitConditionLeaves(child, fn);
}

function collectEmittedSignals(graph: NarrativeGraphDef): Set<string> {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    if (rec.type === 'emitNarrativeSignal') {
      const params = rec.params as Record<string, unknown> | undefined;
      const sig = typeof params?.signal === 'string' ? params.signal.trim() : '';
      if (sig) out.add(sig);
    }
    for (const child of Object.values(rec)) walk(child);
  };
  for (const state of Object.values(graph.states ?? {})) {
    walk((state as NarrativeStateNodeDef).onEnterActions);
    walk((state as NarrativeStateNodeDef).onExitActions);
  }
  return out;
}

function listenedSignals(graph: NarrativeGraphDef): Set<string> {
  const out = new Set<string>();
  for (const t of graph.transitions ?? []) {
    if (t.trigger && t.trigger !== 'signal') continue;
    const sig = String(t.signal ?? '').trim();
    if (sig && sig !== '__draft__') out.add(sig);
  }
  return out;
}

/** 全文件的局部机原型图 id 集（narrative 叶指向它 = error 的判据）。 */
export function localMachineGraphIds(data: NarrativeGraphsFileDef): Set<string> {
  const out = new Set<string>();
  for (const { graph } of iterGraphSlots(data)) {
    if (isLocalMachineGraphDef(graph)) out.add(graph.id);
  }
  return out;
}

/** 全文件局部机声明的导出信号（TaskBus 悬空检查与信号目录都要认它）。 */
export function declaredLocalEmits(data: NarrativeGraphsFileDef): string[] {
  const out: string[] = [];
  for (const { graph } of iterGraphSlots(data)) {
    if (!isLocalMachineGraphDef(graph)) continue;
    for (const raw of graph.local?.emits ?? []) {
      const sig = String(raw ?? '').trim();
      if (sig) out.push(sig);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 校验
 * 设计稿 §6 的三方校验里「TS 权威」那一份的局部机部分。Python 兜底不认这些码 =
 * 兜底更松，符合「兜底必须是权威的子集」不变量。
 */

function issue(
  severity: 'error' | 'warning',
  code: string,
  message: string,
  path: string,
  itemId?: string,
  target?: ValidationTargetDef,
): ValidationIssueDef {
  return { severity, code, message, path, itemId, target };
}

export function validateLocalMachines(data: NarrativeGraphsFileDef): ValidationIssueDef[] {
  const out: ValidationIssueDef[] = [];
  const machineIds = localMachineGraphIds(data);

  for (const [ci, comp] of (data.compositions ?? []).entries()) {
    const compositionId = comp.id;
    for (const [ei, el] of (comp.elements ?? []).entries()) {
      if (!isLocalMachineElement(el)) continue;
      const path = `compositions[${ci}].elements[${ei}]`;
      const elTarget: ValidationTargetDef = { kind: 'element', compositionId, elementId: el.id };
      if (!el.graph?.id) {
        out.push(issue('error', 'local.element.graph.missing',
          `${el.id}: 局部机元素必须自带内嵌图（原型定义就在这张图里）`, path, el.id, elTarget));
        continue;
      }
      const graph = el.graph;
      const graphPath = `${path}.graph`;
      const gTarget: ValidationTargetDef = { kind: 'graph', compositionId, graphId: graph.id, elementId: el.id };

      if (!isLocalMachineGraphDef(graph)) {
        out.push(issue('error', 'local.declaration.missing',
          `${graph.id}: 局部机元素的图缺少 local 声明（没有 local 就是普通全局图，绑定不会实例化）`,
          graphPath, el.id, gTarget));
      }
      if (graph.run) {
        out.push(issue('error', 'local.run.conflict',
          `${graph.id}: 局部机与活计图互斥——同一张图不能既是"可接单的委托"又是"绑定即实例化的原型"`,
          `${graphPath}.run`, el.id, gTarget));
      }
      if (String(graph.ownerType ?? '').trim() !== 'system') {
        out.push(issue('error', 'local.ownerType.invalid',
          `${graph.id}: 局部机不绑 owner，ownerType 恒为 system（当前 ${graph.ownerType || '空'}）`,
          `${graphPath}.ownerType`, el.id, { ...gTarget, field: 'ownerType' }));
      }
      if (String(graph.ownerId ?? '').trim()) {
        out.push(issue('error', 'local.ownerId.forbidden',
          `${graph.id}: 局部机不进 owner 索引（@owner/@scene 解析不到它），不能填 ownerId`,
          `${graphPath}.ownerId`, el.id, { ...gTarget, field: 'ownerId' }));
      }

      // --- 变量表（设计稿 §6.1）---
      const vars = localVarsOf(graph);
      const dupKeys = duplicateLocalVarKeys(vars);
      for (const [vi, v] of vars.entries()) {
        const varPath = `${graphPath}.local.vars[${vi}]`;
        const key = String(v?.key ?? '').trim();
        if (!key) {
          out.push(issue('error', 'local.var.key.empty', `${graph.id}: 第 ${vi + 1} 个局部变量没有 key`, varPath, el.id, gTarget));
          continue;
        }
        if (dupKeys.has(key)) {
          out.push(issue('error', 'local.var.key.duplicate', `${graph.id}: 局部变量 key 重复「${key}」`, varPath, el.id, gTarget));
        }
        if (!LOCAL_VAR_TYPES.includes(v.type as LocalVarType)) {
          out.push(issue('error', 'local.var.type.invalid',
            `${graph.id}.${key}: 变量类型必须是 bool / float / string（当前 ${String(v.type ?? '空')}）`, varPath, el.id, gTarget));
          continue;
        }
        if (!localVarValueMatchesType(v.default, v.type as LocalVarType)) {
          out.push(issue('error', 'local.var.default.mismatch',
            `${graph.id}.${key}: 默认值与声明类型 ${v.type} 对不上`, varPath, el.id, gTarget));
        }
      }
      const declaredKeys = new Set(localVarKeys(graph));

      // --- 私有边界：不广播、不点位面（设计稿 §1.2）---
      for (const [sid, state] of Object.entries(graph.states ?? {})) {
        const sTarget: ValidationTargetDef = { kind: 'state', compositionId, graphId: graph.id, stateId: sid, elementId: el.id };
        if (state?.broadcastOnEnter === true) {
          out.push(issue('error', 'local.state.broadcast.forbidden',
            `${graph.id}.${sid}: 局部机不发 state:<图>:<态> 派生广播（1000 个实例会撞成同一条信号）；要对外说话请用「导出信号」动作`,
            `${graphPath}.states.${sid}.broadcastOnEnter`, sid, { ...sTarget, field: 'broadcastOnEnter' }));
        }
        if (typeof state?.activePlane === 'string' && state.activePlane.trim()) {
          out.push(issue('error', 'local.state.plane.forbidden',
            `${graph.id}.${sid}: 局部机不点位面（位面是全局唯一的世界层，实例私有态不能驱动它）`,
            `${graphPath}.states.${sid}.activePlane`, sid, { ...sTarget, field: 'activePlane' }));
        }
      }
      if (!String(graph.initialState ?? '').trim()) {
        out.push(issue('error', 'local.initialState.missing', `${graph.id}: 局部机缺 initialState`, graphPath, el.id, gTarget));
      } else if (!graph.states?.[graph.initialState]) {
        out.push(issue('error', 'local.initialState.unknown',
          `${graph.id}: initialState 指向不存在的状态「${graph.initialState}」`, graphPath, el.id, gTarget));
      }

      // --- 转移：只允许 signal 触发（设计稿 §3）---
      const seenTransitionIds = new Set<string>();
      for (const [ti, t] of (graph.transitions ?? []).entries()) {
        const tPath = `${graphPath}.transitions[${ti}]`;
        const tTarget: ValidationTargetDef = { kind: 'transition', compositionId, graphId: graph.id, transitionId: t.id, elementId: el.id };
        if (seenTransitionIds.has(t.id)) {
          out.push(issue('error', 'local.transition.id.duplicate', `${graph.id}: 转移 id 重复「${t.id}」`, tPath, t.id, tTarget));
        }
        seenTransitionIds.add(t.id);
        if (t.trigger && t.trigger !== 'signal') {
          out.push(issue('error', 'local.transition.reactive.forbidden',
            `${graph.id}.${t.id}: 局部机的转移只能听全局信号——reactive 的存在理由是"条件何时满足不可预知"，`
            + `局部层作者对着整台机器写，要转移直接用 localGoto 动作点名目标态`,
            `${tPath}.trigger`, t.id, { ...tTarget, field: 'trigger' }));
        }
        for (const endpoint of ['from', 'to'] as const) {
          const sid = typeof t[endpoint] === 'string' ? String(t[endpoint]).trim() : '';
          if (sid && !graph.states?.[sid]) {
            out.push(issue('error', 'local.transition.endpoint.unknown',
              `${graph.id}.${t.id}: ${endpoint} 指向不存在的状态「${sid}」`, `${tPath}.${endpoint}`, t.id, tTarget));
          }
        }
        // localVar 叶的 key 必须在本机 vars 里声明过
        visitConditionLeaves(t.conditions, (leaf) => {
          if (typeof leaf.localVar !== 'string') return;
          const key = leaf.localVar.trim();
          if (!key) {
            out.push(issue('error', 'local.var.leaf.empty', `${graph.id}.${t.id}: localVar 条件没写变量名`, tPath, t.id, tTarget));
            return;
          }
          if (!declaredKeys.has(key)) {
            out.push(issue('error', 'local.var.leaf.undeclared',
              `${graph.id}.${t.id}: 条件读了未声明的局部变量「${key}」（请先在变量表里加）`, tPath, t.id, tTarget));
          }
        });
      }

      // --- 声明漂移（warning，不拦保存）---
      const actualListens = listenedSignals(graph);
      const actualEmits = collectEmittedSignals(graph);
      for (const raw of graph.local?.listens ?? []) {
        const sig = String(raw ?? '').trim();
        if (sig && !actualListens.has(sig)) {
          out.push(issue('warning', 'local.listens.drift',
            `${graph.id}: 声明监听「${sig}」，但图里没有任何转移在等它`, `${graphPath}.local.listens`, el.id, gTarget));
        }
      }
      for (const sig of actualListens) {
        const declared = (graph.local?.listens ?? []).map((s) => String(s ?? '').trim());
        if (!declared.includes(sig)) {
          out.push(issue('warning', 'local.listens.undeclared',
            `${graph.id}: 转移在等信号「${sig}」，但没写进 local.listens（信号索引按声明建，漏声明会漏投）`,
            `${graphPath}.local.listens`, el.id, gTarget));
        }
      }
      for (const raw of graph.local?.emits ?? []) {
        const sig = String(raw ?? '').trim();
        if (sig && !actualEmits.has(sig)) {
          out.push(issue('warning', 'local.emits.drift',
            `${graph.id}: 声明导出「${sig}」，但状态动作里没有对应的发射`, `${graphPath}.local.emits`, el.id, gTarget));
        }
      }
    }
  }

  // --- 跨图规则：localVar 叶只在局部机内合法；narrative 叶不接受局部机 id ---
  for (const { graph, compositionId, elementId, element } of iterGraphSlots(data)) {
    const isLocal = isLocalMachineGraphDef(graph) && isLocalMachineElement(element);
    for (const t of graph.transitions ?? []) {
      const tTarget: ValidationTargetDef = {
        kind: 'transition', compositionId, graphId: graph.id, transitionId: t.id,
        ...(elementId ? { elementId } : {}),
      };
      visitConditionLeaves(t.conditions, (leaf) => {
        if (!isLocal && typeof leaf.localVar === 'string') {
          out.push(issue('error', 'local.var.leaf.outside',
            `${graph.id}.${t.id}: localVar 条件只在局部机自己的转移里合法（实例变量在实例之外没有意义，运行时恒假）`,
            `${graph.id}.${t.id}.conditions`, t.id, tTarget));
        }
        for (const field of ['narrative', 'narrativeCount'] as const) {
          const ref = typeof leaf[field] === 'string' ? String(leaf[field]).trim() : '';
          if (ref && machineIds.has(ref)) {
            out.push(issue('error', 'local.narrative.ref.forbidden',
              `${graph.id}.${t.id}: ${field} 条件不能指向局部机「${ref}」——实例状态对外不可见、不可寻址（刻意的代价）`,
              `${graph.id}.${t.id}.conditions`, t.id, tTarget));
          }
        }
      });
    }
  }

  return out;
}

/**
 * TS 权威（src/core/narrativeGraphValidation.ts）尚未认识 `localMachine` 这个 kind，
 * 会把它当黑盒、对空 refId 报 `blackbox.ref.empty`。局部机根本没有 refId 这个概念
 * （原型定义就在内嵌图里），这条恒亮的警告是纯误报，在此按 target 精确剔除。
 * **权威侧补上 kind 之后删掉本函数与它的调用点。**
 */
export function dropLocalMachineFalsePositives(
  issues: ValidationIssueDef[],
  data: NarrativeGraphsFileDef,
): ValidationIssueDef[] {
  const localElementIds = new Set<string>();
  for (const comp of data.compositions ?? []) {
    for (const el of comp.elements ?? []) {
      if (isLocalMachineElement(el)) localElementIds.add(`${comp.id} ${el.id}`);
    }
  }
  if (localElementIds.size === 0) return issues;
  return issues.filter((it) => {
    if (it.code !== 'blackbox.ref.empty') return true;
    const target = it.target;
    const compositionId = target && 'compositionId' in target ? String(target.compositionId ?? '') : '';
    const elementId = target && target.kind === 'element' ? String(target.elementId ?? '') : '';
    if (!compositionId || !elementId) return true;
    return !localElementIds.has(`${compositionId} ${elementId}`);
  });
}
