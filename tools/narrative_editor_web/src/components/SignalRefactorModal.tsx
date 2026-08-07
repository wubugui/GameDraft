import { useEffect, useMemo, useState } from 'react';
import {
  applySignalRefactorRemote,
  scanGraphUsagesRemote,
  scanSignalUsagesRemote,
  scanStateUsagesRemote,
  type DialogueDanglingDef,
  type GraphUsagesDef,
  type SignalRefactorResultDef,
  type SignalUsagesDef,
  type StateUsagesDef,
} from '../bridge';
import type { NarrativeGraphsFileDef } from '../types';

/** 叙事重构请求：信号改名/删除、状态名改名、图 id 改名（后两者自动登记存档迁移映射）。 */
export type NarrativeRefactorRequest =
  | { kind: 'signal-rename'; signalId: string }
  | { kind: 'signal-delete'; signalId: string }
  | { kind: 'state-rename'; graphId: string; stateId: string }
  | { kind: 'graph-rename'; graphId: string };

function requestTitle(req: NarrativeRefactorRequest): string {
  switch (req.kind) {
    case 'signal-rename': return `重构改名信号：${req.signalId}`;
    case 'signal-delete': return `重构删除信号：${req.signalId}`;
    case 'state-rename': return `重构改名状态：${req.graphId}.${req.stateId}`;
    case 'graph-rename': return `重构改名图 id：${req.graphId}`;
  }
}

export type AnyUsages =
  | { kind: 'signal'; u: SignalUsagesDef }
  | { kind: 'state'; u: StateUsagesDef }
  | { kind: 'graph'; u: GraphUsagesDef };

/** 各 kind 的扫描覆盖面，写清楚"扫了哪些"——0 处时用它替代"可安全操作"的空头承诺。 */
const SCAN_COVERAGE: Record<AnyUsages['kind'], string> = {
  signal: '注册表 / 转移监听 / 叙事图与内容资产的发射动作 / 画布 meta.emits / 全部图对话',
  state: '图内迁移端点 / 派生信号监听 / 条件叶与设状态动作 / 图对话 ownerState·contextState 分支'
    + ' / 画布 meta / 场景与内容资产',
  graph: '派生信号监听 / 画布 meta.reads·commands / 条件叶与生命周期动作 / 图对话 ownerState·contextState'
    + ' / repeatable 任务 runArchetype / 场景与内容资产',
};

export function usageLinesFor(scan: AnyUsages): string[] {
  const lines: string[] = [];
  if (scan.kind === 'signal') {
    const u = scan.u;
    for (const l of u.listeners) lines.push(`监听：叙事图 ${l.graphId} · 转移 ${l.transitionId}`);
    if (u.actionEmits) lines.push(`叙事图内发射动作：${u.actionEmits} 处`);
    for (const m of u.metaEmits) lines.push(`画布声明（meta.emits）：${m.compositionId} · ${m.elementId}`);
    for (const d of u.dialogues) lines.push(`对话图 ${d.graphId}：发射 ${d.count} 处`);
    for (const a of u.assets) lines.push(`${a.bucket} · ${a.itemId}：发射 ${a.count} 处`);
  } else if (scan.kind === 'state') {
    const u = scan.u;
    if (u.internalEndpoints) lines.push(`图内迁移端点（from/to）：${u.internalEndpoints} 处`);
    for (const l of u.derivedListeners) lines.push(`派生信号监听（state:图:态）：${l.graphId} · ${l.transitionId}`);
    if (u.narrativeConditions) lines.push(`叙事图内条件/强制设状态引用：${u.narrativeConditions} 处`);
    if (u.metaCommands) lines.push(`画布声明（meta.commands）：${u.metaCommands} 处`);
    if (u.metaEmits) lines.push(`画布声明（meta.emits 派生信号）：${u.metaEmits} 处`);
    for (const e of u.external) lines.push(`${e.bucket} · ${e.itemId}：条件/设状态/对话分支引用 ${e.count} 处`);
  } else {
    const u = scan.u;
    if (u.derivedListeners) lines.push(`派生信号监听（state:图:*）：${u.derivedListeners} 处`);
    if (u.metaReads) lines.push(`画布声明（meta.reads）：${u.metaReads} 处`);
    if (u.narrativeConditions) lines.push(`叙事图内条件/强制设状态引用：${u.narrativeConditions} 处`);
    if (u.metaCommands) lines.push(`画布声明（meta.commands）：${u.metaCommands} 处`);
    if (u.metaEmits) lines.push(`画布声明（meta.emits 派生信号）：${u.metaEmits} 处`);
    if (u.runArchetypes) lines.push(`repeatable 任务绑定（runArchetype）：${u.runArchetypes} 处`);
    for (const e of u.external) lines.push(`${e.bucket} · ${e.itemId}：条件/设状态/对话分支引用 ${e.count} 处`);
  }
  for (const b of scan.u.readonlyBlockers ?? []) {
    lines.push(`⛔ 只读数据面 ${b.bucket} · ${b.itemId}：${b.count} 处（宿主不保存该域，重构会被拒绝）`);
  }
  return lines;
}

/**
 * 引擎真正级联改写了多少处（区别于执行前的扫描预览数）。
 *
 * 此前成功提示直接复用扫描 total，一旦扫描面与改写面对不上（历史上正是如此），
 * 用户看到的"N 处已级联"就是假数——必须以引擎返回的 summary 为准。
 */
export function appliedRefCount(op: string, summary: Record<string, unknown> | undefined): number | null {
  if (!summary) return null;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const sum = (v: unknown): number => (Array.isArray(v)
    ? v.reduce((acc: number, row) => acc + num((row as { count?: unknown })?.count), 0)
    : 0);
  if (op === 'delete') return num(summary.cleaned);
  if (op === 'rename') {
    const n = (summary.narrative ?? {}) as Record<string, unknown>;
    return num(n.transitions) + num(n.actionEmits) + num(n.metaEmits)
      + sum(summary.assets) + sum(summary.dialogues);
  }
  if (op === 'renameState') {
    return num(summary.internalEndpoints) + num(summary.derivedListeners)
      + num(summary.narrativeConditions) + sum(summary.external)
      + num(summary.metaCommands) + num(summary.metaEmits);
  }
  if (op === 'renameGraph') {
    return num(summary.derivedListeners) + num(summary.metaReads)
      + num(summary.narrativeConditions) + sum(summary.external)
      + num(summary.metaCommands) + num(summary.metaEmits) + num(summary.runArchetypes);
  }
  return null;
}

function danglingLine(d: DialogueDanglingDef): string {
  const what = d.reason === 'missingGraph'
    ? `图 ${d.graphId} 不存在`
    : `图 ${d.graphId} 没有状态 ${d.stateId}`;
  return `对话图 ${d.dialogueGraphId} · 节点 ${d.nodeId}（${d.nodeType}）：${what}`;
}

/**
 * 叙事重构对话框。打开即全项目扫描使用点 → 预览 → 执行。执行时把网页当前文档一并交给
 * 宿主（先过保存校验再暂存），共享引擎级联全部通道（叙事图 + 对话图 ownerState/contextState
 * + 场景/内容资产）；状态/图改名自动写入 narrative_graphs.migrations 保旧存档。全程零磁盘
 * 写入——落盘只在主编辑器 Save All；撤销经工具栏「撤销重构」（与 PyQt 信号管理器共用同一日志）。
 *
 * 执行后宿主会做一次收尾自检（postCheck.dangling）：图对话侧若仍有悬垂的
 * ownerState/contextState 引用，弹窗**不自动关闭**，直接把断链列出来——此前这类问题要等
 * Save All 之后跑 validate-data 才暴露（2026-08-05 全盘审查 P0-2 / P2-1）。
 */
export function SignalRefactorModal(props: {
  open: boolean;
  request: NarrativeRefactorRequest;
  data: NarrativeGraphsFileDef;
  onClose: () => void;
  onRefactored: (result: SignalRefactorResultDef, description: string) => void;
}) {
  const [scan, setScan] = useState<AnyUsages | null>(null);
  const [scanError, setScanError] = useState('');
  const [newId, setNewId] = useState('');
  const [forceClean, setForceClean] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [postDangling, setPostDangling] = useState<DialogueDanglingDef[] | null>(null);
  const req = props.request;

  useEffect(() => {
    if (!props.open) return;
    setScan(null);
    setScanError('');
    setNewId('');
    setForceClean(false);
    setError('');
    setPostDangling(null);
    const fail = (reason?: string) => setScanError(reason ?? '扫描失败');
    // 预览计数带上当前画布草稿（P3）：执行时宿主会先暂存画布 data 再级联，扫描若只看
    // 模型旧值，「预览 N 处」会与实际级联数对不上。
    if (req.kind === 'signal-rename' || req.kind === 'signal-delete') {
      void scanSignalUsagesRemote(req.signalId, props.data).then((res) => {
        if (res.ok && res.usages) setScan({ kind: 'signal', u: res.usages });
        else fail(res.reason);
      });
    } else if (req.kind === 'state-rename') {
      void scanStateUsagesRemote(req.graphId, req.stateId, props.data).then((res) => {
        if (res.ok && res.usages) setScan({ kind: 'state', u: res.usages });
        else fail(res.reason);
      });
    } else {
      void scanGraphUsagesRemote(req.graphId, props.data).then((res) => {
        if (res.ok && res.usages) setScan({ kind: 'graph', u: res.usages });
        else fail(res.reason);
      });
    }
    // req 是打开时的快照对象：依赖各字段而非对象引用，避免父组件重渲染反复重扫
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, req.kind, 'signalId' in req ? req.signalId : '', 'graphId' in req ? req.graphId : '', 'stateId' in req ? req.stateId : '']);

  const usageLines = useMemo(() => (scan ? usageLinesFor(scan) : []), [scan]);

  if (!props.open) return null;

  const isDelete = req.kind === 'signal-delete';
  const total = scan ? scan.u.totalRefs : 0;
  const blockers = scan?.u.readonlyBlockers ?? [];
  const suspects = scan?.kind === 'state' ? scan.u.relativeTokenSuspects : undefined;
  const done = postDangling !== null;
  const canExecute = !busy && !done && scan !== null && blockers.length === 0
    && (isDelete ? total === 0 || forceClean : Boolean(newId.trim()));

  const execute = async () => {
    setBusy(true);
    setError('');
    const payload =
      req.kind === 'signal-rename'
        ? { op: 'rename' as const, oldId: req.signalId, newId: newId.trim(), data: props.data }
        : req.kind === 'signal-delete'
          ? { op: 'delete' as const, signalId: req.signalId, force: forceClean, data: props.data }
          : req.kind === 'state-rename'
            ? { op: 'renameState' as const, graphId: req.graphId, oldStateId: req.stateId, newStateId: newId.trim(), data: props.data }
            : { op: 'renameGraph' as const, oldGraphId: req.graphId, newGraphId: newId.trim(), data: props.data };
    const result = await applySignalRefactorRemote(payload);
    setBusy(false);
    if (!result.ok) {
      setError(result.reason ?? '重构失败');
      return;
    }
    // 级联数以引擎 summary 为准；取不到时退回预览数并标注（不谎报精确值）
    const applied = appliedRefCount(payload.op, result.summary);
    const refs = applied === null ? `${total} 处引用（预览计数）` : `${applied} 处引用`;
    const description =
      req.kind === 'signal-rename'
        ? `已改名信号 ${req.signalId} → ${newId.trim()}（${refs}级联更新）`
        : req.kind === 'signal-delete'
          ? `已删除信号 ${req.signalId}（清理 ${refs}）`
          : req.kind === 'state-rename'
            ? `已改名状态 ${req.graphId}.${req.stateId} → ${newId.trim()}（${refs}级联更新，已登记存档迁移）`
            : `已改名图 ${req.graphId} → ${newId.trim()}（${refs}级联更新，已登记存档迁移）`;
    props.onRefactored(result, description);
    const dangling = result.postCheck?.dangling ?? [];
    if (dangling.length > 0) {
      setPostDangling(dangling);  // 有断链就留在弹窗里让人看见，绝不静默关闭
      return;
    }
    props.onClose();
  };

  // 重构执行中禁止任何关闭入口（P3）：宿主级联是异步落地的，背景一点「像取消了」
  // 但结果照样应用——执行期间只能等它结束。
  const emitSourceCount = scan?.kind === 'signal'
    ? scan.u.actionEmits
      + scan.u.metaEmits.length
      + scan.u.dialogues.reduce((sum, d) => sum + d.count, 0)
      + scan.u.assets.reduce((sum, a) => sum + a.count, 0)
    : null;

  return (
    <div className="signal-modal-backdrop" role="presentation" onClick={busy ? undefined : props.onClose}>
      <div className="signal-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="signal-modal-header">
          <h3>{requestTitle(req)}</h3>
          <button type="button" className="secondary" disabled={busy} onClick={props.onClose}>关闭</button>
        </header>
        <div className="signal-modal-list">
          {scan === null && !scanError ? <p className="muted">正在扫描全项目使用点…</p> : null}
          {scanError ? <p className="signal-modal-error">{scanError}</p> : null}
          {scan !== null ? (
            <>
              <p className="muted">共 {total} 处使用点（叙事图 / 对话图 / 场景与内容资产）：</p>
              {usageLines.length === 0 ? (
                // 绝不写"可安全操作"：这是静态扫描，只能陈述扫了什么、没扫到什么
                <p className="muted">
                  本次扫描未发现引用。扫描面：{SCAN_COVERAGE[scan.kind]}。
                  代码里写死的引用不在扫描面内，请自行确认。
                </p>
              ) : null}
              {usageLines.map((line) => (
                <div key={line} className="signal-row-wrap"><span className="signal-row-meta">{line}</span></div>
              ))}
              {suspects && suspects.total > 0 ? (
                <p className="muted">
                  ⚠ 另有 {suspects.total} 处同名状态疑点（条件叶写 @owner/@scene，或 ownerState
                  未指定 wrapperGraphId 靠对话 owner 解算）：归属哪张图静态判不出，
                  <b>不会自动改写</b>，改完请人工确认这些分支。
                </p>
              ) : null}
              {emitSourceCount === 0 ? (
                <p className="muted">
                  ⚠ 未发现数据侧发射源：该信号可能由代码逻辑直接发射（例如 HealthSystem 的
                  death_tether），本扫描只覆盖数据文件，改名/删除前请人工确认代码侧无引用。
                </p>
              ) : null}
            </>
          ) : null}
          {postDangling !== null ? (
            postDangling.length > 0 ? (
              <>
                <p className="signal-modal-error">
                  ⚠ 重构已完成，但图对话侧仍有 {postDangling.length} 处悬垂引用需要处理：
                </p>
                {postDangling.map((d) => (
                  <div key={`${d.dialogueGraphId}/${d.nodeId}/${d.stateId}`} className="signal-row-wrap">
                    <span className="signal-row-meta">{danglingLine(d)}</span>
                  </div>
                ))}
              </>
            ) : null
          ) : null}
        </div>
        <footer className="signal-modal-footer">
          {blockers.length > 0 ? (
            <p className="signal-modal-error">
              命中只读数据面（主编辑器只加载不保存），重构会被宿主拒绝——
              请先手工修改上面 ⛔ 标出的文件，或给该数据域补齐脏桶与保存分支。
            </p>
          ) : null}
          {done ? (
            <div className="signal-create-row">
              <button type="button" onClick={props.onClose}>知道了</button>
            </div>
          ) : isDelete ? (
            <div className="signal-create-row">
              {total > 0 ? (
                <label className="toggle compact-toggle">
                  <input type="checkbox" checked={forceClean} onChange={(e) => setForceClean(e.target.checked)} />
                  强制清理：监听转移置为草稿（__draft__）、发射动作从对话/场景/资产中移除
                </label>
              ) : null}
              <button type="button" className="danger" disabled={!canExecute} onClick={() => void execute()}>
                {busy ? '重构中…' : '执行删除重构'}
              </button>
            </div>
          ) : (
            <div className="signal-create-row">
              <div className="signal-create-fields">
                <input
                  autoFocus
                  placeholder={req.kind === 'state-rename' ? '新状态 id' : req.kind === 'graph-rename' ? '新图 id' : '新信号 id'}
                  value={newId}
                  onChange={(e) => setNewId(e.target.value)}
                />
              </div>
              <button type="button" disabled={!canExecute} onClick={() => void execute()}>
                {busy ? '重构中…' : '执行改名重构'}
              </button>
            </div>
          )}
          {error ? <p className="signal-modal-error">{error}</p> : null}
          <p className="muted">
            重构先把当前画布暂存进主编辑器（含保存校验），改动全部只进暂存、<b>不落盘</b>——
            主编辑器 Save All 才写文件；工具栏「撤销重构」可整体回退
            {req.kind === 'state-rename' || req.kind === 'graph-rename' ? '；改名自动登记存档迁移映射（migrations），旧存档读入时按新名对齐' : ''}。
          </p>
        </footer>
      </div>
    </div>
  );
}
