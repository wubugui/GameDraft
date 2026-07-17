import { useEffect, useMemo, useState } from 'react';
import {
  applySignalRefactorRemote,
  scanGraphUsagesRemote,
  scanSignalUsagesRemote,
  scanStateUsagesRemote,
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

type AnyUsages =
  | { kind: 'signal'; u: SignalUsagesDef }
  | { kind: 'state'; u: StateUsagesDef }
  | { kind: 'graph'; u: GraphUsagesDef };

function usageLinesFor(scan: AnyUsages): string[] {
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
    for (const e of u.external) lines.push(`${e.bucket} · ${e.itemId}：条件/设状态引用 ${e.count} 处`);
  } else {
    const u = scan.u;
    if (u.derivedListeners) lines.push(`派生信号监听（state:图:*）：${u.derivedListeners} 处`);
    if (u.metaReads) lines.push(`画布声明（meta.reads）：${u.metaReads} 处`);
    if (u.narrativeConditions) lines.push(`叙事图内条件/强制设状态引用：${u.narrativeConditions} 处`);
    if (u.runArchetypes) lines.push(`repeatable 任务绑定（runArchetype）：${u.runArchetypes} 处`);
    for (const e of u.external) lines.push(`${e.bucket} · ${e.itemId}：条件/设状态引用 ${e.count} 处`);
  }
  return lines;
}

/**
 * 叙事重构对话框。打开即全项目扫描使用点 → 预览 → 执行。执行时把网页当前文档一并交给
 * 宿主（先过保存校验再暂存），共享引擎级联全部通道（叙事图 + 对话图 + 场景/内容资产）；
 * 状态/图改名自动写入 narrative_graphs.migrations 保旧存档。全程零磁盘写入——落盘只在
 * 主编辑器 Save All；撤销经工具栏「撤销重构」（与 PyQt 信号管理器共用同一日志）。
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
  const req = props.request;

  useEffect(() => {
    if (!props.open) return;
    setScan(null);
    setScanError('');
    setNewId('');
    setForceClean(false);
    setError('');
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
  const canExecute = !busy && scan !== null
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
    const description =
      req.kind === 'signal-rename'
        ? `已改名信号 ${req.signalId} → ${newId.trim()}（${total} 处引用级联更新）`
        : req.kind === 'signal-delete'
          ? `已删除信号 ${req.signalId}（清理 ${total} 处引用）`
          : req.kind === 'state-rename'
            ? `已改名状态 ${req.graphId}.${req.stateId} → ${newId.trim()}（${total} 处引用级联更新，已登记存档迁移）`
            : `已改名图 ${req.graphId} → ${newId.trim()}（${total} 处引用级联更新，已登记存档迁移）`;
    props.onRefactored(result, description);
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
              {usageLines.length === 0 ? <p className="muted">无引用，可安全操作。</p> : null}
              {usageLines.map((line) => (
                <div key={line} className="signal-row-wrap"><span className="signal-row-meta">{line}</span></div>
              ))}
              {emitSourceCount === 0 ? (
                <p className="muted">
                  ⚠ 未发现数据侧发射源：该信号可能由代码逻辑直接发射（例如 HealthSystem 的
                  death_tether），本扫描只覆盖数据文件，改名/删除前请人工确认代码侧无引用。
                </p>
              ) : null}
            </>
          ) : null}
        </div>
        <footer className="signal-modal-footer">
          {isDelete ? (
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
