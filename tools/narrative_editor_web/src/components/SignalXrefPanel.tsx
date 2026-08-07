/**
 * 「信号关系」面板（编辑期用法）：左边挑信号，右边看这条信号**谁发、谁听**。
 *
 * 与调试器那套的分工：
 * - 这里回答「**我改之前**要知道牵连谁」——静态、全工程、能点着跳到发射那一行。
 * - 调试器回答「**这一刻**谁在等、刚才那下谁发的」——运行时叠加。
 *
 * 四条硬规矩：
 * 1. **只读**。面板不改任何数据、不标脏；扫描走宿主只读 slot。（「补登记」是唯一例外，
 *    它是显式的一次用户动作，走与信号弹窗同一个函数，可 Ctrl+Z。）
 * 2. **发射与声明分列**。黑盒 `meta.emits` 是画布标注、运行时不执行，混进发射数
 *    就会让"声明了但没人真发"永久隐身。
 * 3. **不谎报**。跳转是三态（精确/只开了页/没跳成），原样说给人听；点不动的行提前灰掉
 *    并说明为什么，而不是让人白点一次。
 * 4. **叙事图内的行走画布定位，不走文件跳转**。narrative_graphs.json 的文件级跳转只认
 *    states/<id>，转移落不到点，会退化成"打开了叙事状态机页"——而你本来就在那一页。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { revealXrefRefRemote, scanSignalXrefRemote } from '../bridge';
import {
  XREF_FILTERS,
  canReveal,
  countSummary,
  declarationHeadline,
  emitterHeadline,
  filterSignals,
  focusTargetOfDeclaration,
  focusTargetOfEmitter,
  listenerFocusTarget,
  listenerHeadline,
  listenerSubline,
  noteWorthShowing,
  refOf,
  revealBlockedReason,
  rowLabel,
  signalDisplayName,
  splitEmitters,
  worstSeverity,
  type XrefFilterKind,
} from '../signalXref';
import type {
  NarrativeGraphsFileDef,
  SignalXrefCardDef,
  SignalXrefIndexDef,
  ValidationTargetDef,
  XrefDeclarationDef,
  XrefEmitterDef,
  XrefStateReadDef,
} from '../types';

const KIND_BADGE: Record<SignalXrefCardDef['kind'], string> = {
  author: '作者',
  derived: '派生',
  draft: '草稿',
  unknown: '未登记',
};

const SEVERITY_MARK: Record<string, string> = { error: '✗', warning: '⚠', info: '·' };

/** 一行的两种跳法：叙事图内 → 画布定位（不离页）；别的文件 → 交宿主跳转引擎 */
type RowRef = { file: string; pointer: string; anchors?: string[][]; readonly?: boolean };

export function SignalXrefPanel(props: {
  /** 当前画布文档：扫描要按"改成这样之后"的关系算，不是上次存盘的关系 */
  data: NarrativeGraphsFileDef;
  /** 聚焦到画布上的某个目标（复用校验面板那套定位）。返回 false = 没定位到。 */
  onFocusTarget: (target: ValidationTargetDef) => boolean;
  /** 改名/删除走既有重构弹窗；宿主外（纯网页调试）不给就不显示按钮 */
  onRequestRefactor?: (mode: 'rename' | 'delete', signalId: string) => void;
  /** 把只被引用、没有注册行的信号补进注册表（与信号弹窗共用同一个函数） */
  onRegisterSignal?: (signalId: string) => void;
  /** 选中的信号由外层持有：从别处「看关系」点进来时直接换人，关掉再开还在原处 */
  selectedSignal: string;
  onSelectSignal: (signalId: string) => void;
  /** 画布内容指纹：与扫描时的不一致就提示"清单可能过期了"（绝不假装还新鲜） */
  dataFingerprint: string;
}) {
  const [index, setIndex] = useState<SignalXrefIndexDef | null>(null);
  const [scanError, setScanError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scannedFingerprint, setScannedFingerprint] = useState('');
  const [scannedAt, setScannedAt] = useState('');
  const [filter, setFilter] = useState<XrefFilterKind>('all');
  const [query, setQuery] = useState('');
  const [jumpNote, setJumpNote] = useState('');

  // 扫描按**调用那一刻**的 props.data 与指纹取值：props.data 每次渲染都是新引用，
  // 放进 effect 依赖会变成"每输一个字重扫一遍全工程"。扫描只发生在打开面板与手动刷新。
  const dataRef = useRef(props.data);
  dataRef.current = props.data;
  const fingerprintRef = useRef(props.dataFingerprint);
  fingerprintRef.current = props.dataFingerprint;

  const rescan = useCallback(async () => {
    const fingerprint = fingerprintRef.current;
    setScanning(true);
    setScanError('');
    const res = await scanSignalXrefRemote(dataRef.current);
    setScanning(false);
    if (res.ok && res.xref) {
      setIndex(res.xref);
      setScannedFingerprint(fingerprint);
      setScannedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    } else {
      setIndex(null);
      setScanError(res.reason ?? '扫描失败');
    }
  }, []);

  useEffect(() => {
    void rescan();
  }, [rescan]);

  const cards = index?.signals ?? [];
  const visible = useMemo(() => filterSignals(cards, filter, query), [cards, filter, query]);
  const problemCount = useMemo(
    () => filterSignals(cards, 'problems', '').length, [cards],
  );
  const selected = useMemo(
    () => cards.find((c) => c.signal === props.selectedSignal) ?? null,
    [cards, props.selectedSignal],
  );
  const stale = index !== null && scannedFingerprint !== props.dataFingerprint;

  // 换信号就清掉上一次的跳转回执：留着会被当成刚才这次点击的结果。
  useEffect(() => { setJumpNote(''); }, [props.selectedSignal]);

  const reveal = async (row: RowRef, label: string) => {
    if (!canReveal(row)) {
      setJumpNote(`${label}：${revealBlockedReason(row)}`);
      return;
    }
    const res = await revealXrefRefRemote(refOf(row));
    if (!res.ok) setJumpNote(`没跳成：${res.reason || res.note || '未知原因'}`);
    else if (res.exact) setJumpNote(res.note || `已定位到${label}`);
    else setJumpNote(`${res.note || '已打开对应编辑页'}（没能逐条定位）`);
  };

  const focus = (target: ValidationTargetDef, label: string) => {
    const ok = props.onFocusTarget(target);
    setJumpNote(ok
      ? `已在画布上选中${label}（面板挡住画布的话，用工具栏「信号关系−」收起来看）`
      : `${label} 在当前画布上找不到（可能刚被删或改名）——点「重新扫描」`);
  };

  return (
    <div className="signal-xref-panel">
      <div className="signal-xref-toolbar">
        <div className="signal-xref-filters" role="tablist" aria-label="信号筛选">
          {XREF_FILTERS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="tab"
              aria-selected={filter === opt.id}
              className={filter === opt.id ? 'active' : ''}
              title={opt.hint}
              onClick={() => setFilter(opt.id)}
            >
              {opt.label}
              {opt.id === 'problems' && problemCount > 0 ? <span className="signal-kind-count">({problemCount})</span> : null}
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="搜 id / 中文名 / 注释，也能搜「哪段戏发的」"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="secondary"
          disabled={scanning}
          title="重新扫一遍全工程（改完画布、或者在图对话/场景那边改过之后点它）"
          onClick={() => void rescan()}
        >
          {scanning ? '扫描中…' : '重新扫描'}
        </button>
      </div>

      {scanError ? <p className="signal-modal-error">{scanError}</p> : null}
      {stale ? (
        <p className="signal-xref-stale">
          画布在这次扫描之后又改过了，下面的关系可能不是最新的——点「重新扫描」。
        </p>
      ) : null}
      {index ? (
        <p className="muted signal-xref-scope">
          这份关系是 {scannedAt} 扫的：{index.stats.dialogues} 张对话图 /
          {' '}{index.stats.assets} 份内容资产 / {index.stats.graphs} 张叙事图，共 {index.stats.signals} 条信号。
          在别的编辑页（图对话、场景…）改过东西，要点「重新扫描」才看得见。
        </p>
      ) : null}

      <div className="signal-xref-body">
        <div className="signal-xref-list">
          {visible.length === 0 ? (
            <p className="muted">{scanning ? '正在扫描…' : '没有匹配的信号'}</p>
          ) : null}
          {visible.map((card) => {
            const sev = worstSeverity(card);
            return (
              <button
                key={card.signal}
                type="button"
                className={`signal-xref-row${card.signal === props.selectedSignal ? ' active' : ''}`}
                onClick={() => props.onSelectSignal(card.signal)}
              >
                <span className="signal-xref-row-id">
                  {sev ? <span className={`signal-xref-mark sev-${sev}`}>{SEVERITY_MARK[sev]}</span> : null}
                  {rowLabel(card)}
                </span>
                <span className="signal-xref-row-meta">
                  {KIND_BADGE[card.kind]} · {countSummary(card)}
                </span>
              </button>
            );
          })}
        </div>

        <div className="signal-xref-detail">
          {selected ? (
            <SignalXrefDetail
              card={selected}
              onReveal={reveal}
              onFocus={focus}
              onRequestRefactor={props.onRequestRefactor}
              onRegisterSignal={props.onRegisterSignal}
            />
          ) : props.selectedSignal ? (
            // 从别处「看关系」点进来、但这条信号不在上次扫描里（多半是刚加的）。
            // 装作没人点过是最气人的反馈，必须明说。
            <p className="muted">
              「{props.selectedSignal}」不在上次扫描的结果里——它可能是刚加的。
              点上面的「重新扫描」再看。
            </p>
          ) : (
            <p className="muted">左边挑一条信号，这里显示谁发、谁听。</p>
          )}
        </div>
      </div>

      {jumpNote ? <p className="signal-xref-jump-note">{jumpNote}</p> : null}
    </div>
  );
}

function SignalXrefDetail(props: {
  card: SignalXrefCardDef;
  onReveal: (row: RowRef, label: string) => void;
  onFocus: (target: ValidationTargetDef, label: string) => void;
  onRequestRefactor?: (mode: 'rename' | 'delete', signalId: string) => void;
  onRegisterSignal?: (signalId: string) => void;
}) {
  const { card } = props;
  const { real, upstream } = splitEmitters(card);
  return (
    <>
      <div className="signal-xref-head">
        <div className="signal-xref-head-text">
          {/* 刻意不用 .section-title：它带 text-transform:uppercase，信号 id 大小写敏感，
              显示成全大写会让人照抄出一个不存在的 id。 */}
          <div className="signal-xref-title">{signalDisplayName(card)}</div>
          <div className="muted">
            {KIND_BADGE[card.kind]}
            {card.kind === 'derived' && card.sourceGraphId
              ? ` · 来自「${card.sourceGraphId}」的状态「${card.sourceStateLabel || card.sourceStateId}」`
              : ''}
          </div>
        </div>
        <div className="signal-xref-head-actions">
          {card.kind === 'unknown' && props.onRegisterSignal ? (
            <button
              type="button"
              className="secondary"
              title="把它补进信号注册表，之后就能写中文名和注释（可 Ctrl+Z 撤销）"
              onClick={() => props.onRegisterSignal!(card.signal)}
            >
              补登记
            </button>
          ) : null}
          {card.kind === 'author' && props.onRequestRefactor ? (
            <>
              <button
                type="button"
                className="secondary"
                title="全项目级联改这条信号的 id（监听/发射/注册表/画布声明，含对话图与场景），先预览再执行，可撤销"
                onClick={() => props.onRequestRefactor!('rename', card.signal)}
              >
                改名
              </button>
              <button
                type="button"
                className="secondary"
                title="删除这条信号：先列出全部使用点，有引用需确认强制清理，可撤销"
                onClick={() => props.onRequestRefactor!('delete', card.signal)}
              >
                删除
              </button>
            </>
          ) : null}
        </div>
      </div>

      {card.notes ? <p className="signal-xref-notes">📝 {card.notes}</p> : null}
      {card.diagnostics.map((d) => (
        <p key={d.code + d.message} className={`signal-xref-diag sev-${d.severity}`}>
          {SEVERITY_MARK[d.severity]} {d.message}
        </p>
      ))}

      <XrefSection title="谁发的" count={real.length} empty="没有任何地方发出它">
        {real.map((e) => (
          <EmitterRow key={`${e.file}#${e.pointer}`} emitter={e} onReveal={props.onReveal} onFocus={props.onFocus} />
        ))}
      </XrefSection>

      {card.kind === 'derived' ? (
        <XrefSection
          title="能让它发生的路"
          count={upstream.length}
          empty="没有任何路能走到这一拍（除非从存档直接读进来）"
          hint="派生信号 = 进入那一拍就自动广播；这里列的是能让那一拍发生的路"
        >
          {upstream.map((e) => (
            <EmitterRow
              key={`up:${e.file}#${e.pointer}#${e.where}`}
              emitter={e}
              onReveal={props.onReveal}
              onFocus={props.onFocus}
            />
          ))}
        </XrefSection>
      ) : null}

      <XrefSection
        title="谁在听"
        count={card.listeners.length}
        empty="没有任何转移在等它"
        hint="信号的接收方只有转移这一种；别的系统听的是「状态变了」，不是信号本身"
      >
        {card.listeners.map((l) => {
          const target = listenerFocusTarget(l);
          return (
            <div key={`${l.graphId}:${l.transitionId}`} className="signal-xref-item">
              <div className="signal-xref-item-head">
                <span className="signal-xref-item-title">{listenerHeadline(l)}</span>
                <button
                  type="button"
                  className="signal-xref-goto"
                  disabled={!target}
                  title={target ? '在画布上定位这条转移' : '这条转移缺编排信息，定位不了'}
                  onClick={() => target && props.onFocus(target as ValidationTargetDef, listenerHeadline(l))}
                >
                  画布定位
                </button>
              </div>
              <div className="signal-xref-item-where">{listenerSubline(l)}</div>
            </div>
          );
        })}
      </XrefSection>

      {card.declarations.length ? (
        <XrefSection
          title="画布上说会发它的盒子"
          count={card.declarations.length}
          empty=""
          hint="只是画布上的标注，运行时不执行——它不等于有人真的发"
        >
          {card.declarations.map((d) => (
            <DeclarationRow key={`${d.compositionId}:${d.elementId}:${d.pointer}`} row={d} onFocus={props.onFocus} />
          ))}
        </XrefSection>
      ) : null}

      {card.stateReads.length ? (
        <XrefSection
          title="谁在读这个状态"
          count={card.stateReads.length}
          empty=""
          hint="条件里读状态，不是信号接收——广播只被条件消费时「没人听」是正常的"
        >
          {card.stateReads.map((s) => (
            <StateReadRow key={`${s.file}#${s.pointer}`} row={s} onReveal={props.onReveal} />
          ))}
        </XrefSection>
      ) : null}
    </>
  );
}

function EmitterRow(props: {
  emitter: XrefEmitterDef;
  onReveal: (row: RowRef, label: string) => void;
  onFocus: (target: ValidationTargetDef, label: string) => void;
}) {
  const e = props.emitter;
  const label = emitterHeadline(e);
  const focusTarget = focusTargetOfEmitter(e);
  return (
    <div className="signal-xref-item">
      <div className="signal-xref-item-head">
        <span className="signal-xref-item-title">{label}</span>
        {focusTarget ? (
          <button
            type="button"
            className="signal-xref-goto"
            title="在画布上定位它（就在这一页，不切走）"
            onClick={() => props.onFocus(focusTarget, label)}
          >
            画布定位
          </button>
        ) : (
          <button
            type="button"
            className="signal-xref-goto"
            disabled={!canReveal(e)}
            title={canReveal(e) ? `跳到 ${e.file}${e.pointer}（会切到那个编辑页）` : revealBlockedReason(e)}
            onClick={() => props.onReveal(e, label)}
          >
            去看看
          </button>
        )}
      </div>
      {e.where ? <div className="signal-xref-item-where">{e.where}</div> : null}
      {e.context ? <div className="signal-xref-item-context">{e.context}</div> : null}
      {/* 留痕参数与容器一致时是纯噪声（每行都重复一遍容器名）；只有对不上时才值得说，
          那正是"这条发射登记错了源"的线索。 */}
      {noteWorthShowing(e) ? <div className="muted">{e.note}</div> : null}
    </div>
  );
}

function DeclarationRow(props: {
  row: XrefDeclarationDef;
  onFocus: (target: ValidationTargetDef, label: string) => void;
}) {
  const d = props.row;
  const target = focusTargetOfDeclaration(d);
  const label = declarationHeadline(d);
  return (
    <div className="signal-xref-item">
      <div className="signal-xref-item-head">
        <span className="signal-xref-item-title">{label}</span>
        <button
          type="button"
          className="signal-xref-goto"
          disabled={!target}
          title={target ? '在画布上定位这个盒子（声明写在它身上，改也在这儿改）' : '这条声明缺编排信息，定位不了'}
          onClick={() => target && props.onFocus(target, label)}
        >
          画布定位
        </button>
      </div>
      <div className="signal-xref-item-where">
        {d.elementKind}{d.refId ? ` · 指向「${d.refId}」` : ''}
      </div>
    </div>
  );
}

function StateReadRow(props: {
  row: XrefStateReadDef;
  onReveal: (row: RowRef, label: string) => void;
}) {
  const s = props.row;
  const label = `${s.kindLabel}${s.containerId ? `「${s.containerId}」` : ''}`;
  return (
    <div className="signal-xref-item">
      <div className="signal-xref-item-head">
        <span className="signal-xref-item-title">{label}</span>
        <button
          type="button"
          className="signal-xref-goto"
          disabled={!canReveal(s)}
          title={canReveal(s) ? `跳到 ${s.file}${s.pointer}（会切到那个编辑页）` : revealBlockedReason(s)}
          onClick={() => props.onReveal(s, label)}
        >
          去看看
        </button>
      </div>
      {s.where ? <div className="signal-xref-item-where">{s.where}</div> : null}
    </div>
  );
}

function XrefSection(props: {
  title: string;
  count: number;
  empty: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="signal-xref-section">
      <div className="signal-xref-section-head">
        <span className="signal-xref-section-title">{props.title}</span>
        <span className="signal-xref-section-count">{props.count}</span>
      </div>
      {props.hint ? <div className="muted signal-xref-section-hint">{props.hint}</div> : null}
      {props.count === 0 && props.empty ? <div className="signal-xref-empty">{props.empty}</div> : props.children}
    </section>
  );
}
