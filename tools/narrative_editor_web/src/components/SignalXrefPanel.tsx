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
  STATE_FILTERS,
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
  filterStates,
  readerFocusTarget,
  readerEffect,
  readerHeadline,
  splitEmitters,
  stateCountSummary,
  stateFocusTarget,
  stateHeadline,
  stateKey,
  stateWorstSeverity,
  worstSeverity,
  type StateFilterKind,
  type XrefFilterKind,
} from '../signalXref';
import type {
  NarrativeGraphsFileDef,
  SignalXrefCardDef,
  SignalXrefIndexDef,
  StateXrefCardDef,
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

/**
 * 宿主回的失败原因里，哪些是**整份文件都跳不了**（而不是"这一条改名/删了"）。
 * 只有前者才值得按文件记住并提前灰掉；后者按文件记会连坐同文件的所有行。
 * 判据对着 `main_window._navigate_to_search_hit_inner` 的兜底文案。
 */
const FILE_LEVEL_MISS = /没有对应的编辑页|不在编辑器管理范围内|无内嵌编辑页|跳转不可用|编辑页「.+」不可用/;

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
  /**
   * 这条信号**现在**还没登记吗——判的是实时 `data`，不是上次扫描的快照。
   * 按快照判的话，点完「补登记」卡片纹丝不动（徽章、⚠、按钮全在），人自然再点一次，
   * 第二次撞名抛异常、界面什么都不发生（2026-08-07 审查坐实）。
   */
  stillUnregistered: (signalId: string) => boolean;
  /** 看哪一面：信号（谁发谁听）/ 状态（怎么进来·去哪·谁在看着）。由外层持有，关掉再开还在原处 */
  mode: 'signal' | 'state';
  onModeChange: (mode: 'signal' | 'state') => void;
  /** 选中的信号由外层持有：从别处「看关系」点进来时直接换人，关掉再开还在原处 */
  selectedSignal: string;
  onSelectSignal: (signalId: string) => void;
  /** 选中的状态，形如 `图id.状态id` */
  selectedState: string;
  onSelectState: (stateKey: string) => void;
  /** 画布内容指纹（只算会影响关系的内容，忽略节点坐标）：不一致就说"画布改过了" */
  dataFingerprint: string;
  /**
   * 「去别的编辑页转了一圈」的计数（宿主 showEvent 时 +1）。
   * 与画布指纹**分开**：宿主无法知道那边改没改，只能保守提醒；但把这件事栽给画布
   * （"画布在这次扫描之后又改过了"）就是说谎——画布并没有改过。
   */
  externalEpoch: number;
}) {
  const [index, setIndex] = useState<SignalXrefIndexDef | null>(null);
  const [scanError, setScanError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scannedFingerprint, setScannedFingerprint] = useState('');
  const [scannedEpoch, setScannedEpoch] = useState(0);
  const [scannedAt, setScannedAt] = useState('');
  const [filter, setFilter] = useState<XrefFilterKind>('all');
  const [stateFilter, setStateFilter] = useState<StateFilterKind>('all');
  const [query, setQuery] = useState('');
  const [jumpNote, setJumpNote] = useState('');
  // 宿主明确说过「这个**文件**没有对应编辑页」的文件。**不预置名单**：路由表在宿主手里，
  // 前端抄一份必然漂；改成吃一次亏就记住。
  // ⚠ 只收**文件级**的失败：宿主对"条目改名/删除"也回 false（"在「Quest」页未找到 q_1"），
  // 那种按文件记会把整个 quests.json 的行一起灰掉，理由还是那句只针对 q_1 的话。
  // 重扫时清空：数据可能已经补上了。
  const [unroutable, setUnroutable] = useState<Record<string, string>>({});

  // 扫描按**调用那一刻**的 props.data 与指纹取值：props.data 每次渲染都是新引用，
  // 放进 effect 依赖会变成"每输一个字重扫一遍全工程"。扫描只发生在打开面板与手动刷新。
  const dataRef = useRef(props.data);
  dataRef.current = props.data;
  const fingerprintRef = useRef(props.dataFingerprint);
  fingerprintRef.current = props.dataFingerprint;
  const epochRef = useRef(props.externalEpoch);
  epochRef.current = props.externalEpoch;

  const rescan = useCallback(async () => {
    const fingerprint = fingerprintRef.current;
    const epoch = epochRef.current;
    setScanning(true);
    setScanError('');
    setUnroutable({});   // 重扫 = 数据可能补上了，别把上一轮的灰记一辈子
    const res = await scanSignalXrefRemote(dataRef.current);
    setScanning(false);
    if (res.ok && res.xref) {
      setIndex(res.xref);
      setScannedFingerprint(fingerprint);
      setScannedEpoch(epoch);
      setScannedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    } else {
      // 刻意**不清**上一份扫描：清了的话屏幕上会同时挂着红色错误和"它可能是刚加的"，
      // 两句话互相矛盾，而重扫只会再失败一次。留着旧结果 + 红字说明，人还能继续看。
      setScanError(res.reason ?? '扫描失败');
    }
  }, []);

  useEffect(() => {
    void rescan();
  }, [rescan]);

  const cards = index?.signals ?? [];
  const visible = useMemo(() => filterSignals(cards, filter, query), [cards, filter, query]);
  // 徽章必须与点进去之后看到的条数一致：不带 query 算的话，搜索框里有字时
  // 徽章说 12、列表只有 2 条，人会以为筛选坏了。
  const problemCount = useMemo(
    () => filterSignals(cards, 'problems', query).length, [cards, query],
  );
  const selected = useMemo(
    () => cards.find((c) => c.signal === props.selectedSignal) ?? null,
    [cards, props.selectedSignal],
  );
  const stateCards = index?.states ?? [];
  const visibleStates = useMemo(
    () => filterStates(stateCards, stateFilter, query), [stateCards, stateFilter, query]);
  const stateProblemCount = useMemo(
    () => filterStates(stateCards, 'problems', query).length, [stateCards, query]);
  const selectedStateCard = useMemo(
    () => stateCards.find((c) => stateKey(c) === props.selectedState) ?? null,
    [stateCards, props.selectedState],
  );
  const isState = props.mode === 'state';
  const canvasStale = index !== null && scannedFingerprint !== props.dataFingerprint;
  const externallyStale = index !== null && scannedEpoch !== props.externalEpoch;

  // 换信号就清掉上一次的跳转回执：留着会被当成刚才这次点击的结果。
  useEffect(() => { setJumpNote(''); }, [props.selectedSignal]);

  const reveal = async (row: RowRef, label: string) => {
    if (!canReveal(row) || unroutable[row.file]) {
      setJumpNote(`${label}：${revealBlockedReason(row) || unroutable[row.file]}`);
      return;
    }
    const res = await revealXrefRefRemote(refOf(row));
    if (!res.ok) {
      const why = res.reason || res.note || '未知原因';
      setJumpNote(`没跳成：${why}`);
      if (row.file && FILE_LEVEL_MISS.test(why)) {
        setUnroutable((prev) => ({ ...prev, [row.file]: why }));
      }
    }
    else if (res.exact) setJumpNote(res.note || `已定位到${label}`);
    else setJumpNote(`${res.note || '已打开对应编辑页'}（没能逐条定位）`);
  };

  const focus = (target: ValidationTargetDef, label: string) => {
    const ok = props.onFocusTarget(target);
    setJumpNote(ok
      ? `已在画布上选中${label}（面板挡住画布的话，用工具栏「关系−」收起来看）`
      : `${label} 在当前画布上找不到（可能刚被删或改名）——点「重新扫描」`);
  };

  return (
    <div className="signal-xref-panel">
      <div className="signal-xref-toolbar">
        <div className="signal-xref-filters signal-xref-modes" role="tablist" aria-label="看哪一面">
          <button
            type="button" role="tab" aria-selected={props.mode === 'signal'}
            className={props.mode === 'signal' ? 'active' : ''}
            title="一条信号：谁把它打出去、谁在等它"
            onClick={() => props.onModeChange('signal')}
          >
            信号
          </button>
          <button
            type="button" role="tab" aria-selected={props.mode === 'state'}
            className={props.mode === 'state' ? 'active' : ''}
            title="一拍：怎么进来、从这儿去哪、谁在看着它"
            onClick={() => props.onModeChange('state')}
          >
            状态
          </button>
        </div>
        <div className="signal-xref-filters" role="tablist" aria-label={isState ? '状态筛选' : '信号筛选'}>
          {(isState ? STATE_FILTERS : XREF_FILTERS).map((opt) => {
            const active = isState ? stateFilter === opt.id : filter === opt.id;
            const count = isState ? stateProblemCount : problemCount;
            return (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={active ? 'active' : ''}
                title={opt.hint}
                onClick={() => (isState
                  ? setStateFilter(opt.id as StateFilterKind)
                  : setFilter(opt.id as XrefFilterKind))}
              >
                {opt.label}
                {opt.id === 'problems' && count > 0 ? <span className="signal-kind-count">({count})</span> : null}
              </button>
            );
          })}
        </div>
        <input
          type="search"
          placeholder={isState ? '搜图名 / 拍名 / 谁在看着它' : '搜 id / 中文名 / 注释，也能搜「哪段戏发的」'}
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
      {canvasStale ? (
        <p className="signal-xref-stale">
          画布在这次扫描之后又改过了，下面的关系可能不是最新的——点「重新扫描」。
        </p>
      ) : null}
      {!canvasStale && externallyStale ? (
        <p className="signal-xref-stale">
          你去别的编辑页转了一圈，那边可能改过发射端（画布本身没动）——不放心就点「重新扫描」。
        </p>
      ) : null}
      {index ? (
        <p className="muted signal-xref-scope">
          这份关系是 {scannedAt} 扫的：{index.stats.dialogues} 张对话图 /
          {' '}{index.stats.assets} 份内容资产 / {index.stats.graphs} 张叙事图，
          共 {index.stats.signals} 条信号、{index.stats.states} 个状态。
          在别的编辑页（图对话、场景…）改过东西，要点「重新扫描」才看得见。
        </p>
      ) : null}

      <div className="signal-xref-body">
        <div className="signal-xref-list">
          {isState ? (
            <>
              {visibleStates.length === 0 ? (
                <p className="muted">{scanning ? '正在扫描…' : '没有匹配的状态'}</p>
              ) : null}
              {visibleStates.map((card) => {
                const sev = stateWorstSeverity(card);
                const key = stateKey(card);
                return (
                  <button
                    key={key}
                    type="button"
                    className={`signal-xref-row${key === props.selectedState ? ' active' : ''}`}
                    onClick={() => props.onSelectState(key)}
                  >
                    <span className="signal-xref-row-id">
                      {sev ? <span className={`signal-xref-mark sev-${sev}`}>{SEVERITY_MARK[sev]}</span> : null}
                      {stateHeadline(card)}
                    </span>
                    <span className="signal-xref-row-meta">{stateCountSummary(card)}</span>
                  </button>
                );
              })}
            </>
          ) : (
            <>
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
            </>
          )}
        </div>

        <div className="signal-xref-detail">
          {isState ? (
            selectedStateCard ? (
              <StateXrefDetail
                card={selectedStateCard}
                onReveal={reveal}
                onFocus={focus}
                onInspectSignal={(signalId) => { props.onModeChange('signal'); props.onSelectSignal(signalId); }}
              />
            ) : props.selectedState && scanning ? (
              <p className="muted">正在扫描全工程，马上就好…</p>
            ) : props.selectedState && scanError ? (
              <p className="muted">扫描没成功，暂时看不到「{props.selectedState}」的引用（原因见上面红字）。</p>
            ) : props.selectedState ? (
              <p className="muted">「{props.selectedState}」不在上次扫描的结果里——它可能是刚加的。点「重新扫描」再看。</p>
            ) : (
              <p className="muted">左边挑一拍，这里显示它怎么进来、从这儿去哪、谁在看着它。</p>
            )
          ) : selected ? (
            <SignalXrefDetail
              card={selected}
              onReveal={reveal}
              onFocus={focus}
              onRequestRefactor={props.onRequestRefactor}
              onRegisterSignal={props.onRegisterSignal}
              stillUnregistered={props.stillUnregistered}
            />
          ) : props.selectedSignal && scanning ? (
            <p className="muted">正在扫描全工程，马上就好…</p>
          ) : props.selectedSignal && scanError ? (
            <p className="muted">扫描没成功，暂时看不到「{props.selectedSignal}」的关系（原因见上面红字）。</p>
          ) : props.selectedSignal ? (
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
  stillUnregistered: (signalId: string) => boolean;
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
              ? ` · 来自「${card.sourceGraphLabel || card.sourceGraphId}」的状态「${card.sourceStateLabel || card.sourceStateId}」`
              : ''}
          </div>
        </div>
        <div className="signal-xref-head-actions">
          {props.stillUnregistered(card.signal) && props.onRegisterSignal ? (
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

      {card.reactiveRefs.length ? (
        <XrefSection
          title="反应式转移填了它"
          count={card.reactiveRefs.length}
          empty=""
          hint="反应式转移靠条件自动走，运行时根本不看 signal 字段——名字写在那儿，但它不算接收方"
        >
          {card.reactiveRefs.map((l) => {
            const target = listenerFocusTarget(l);
            return (
              <div key={`react:${l.graphId}:${l.transitionId}`} className="signal-xref-item">
                <div className="signal-xref-item-head">
                  <span className="signal-xref-item-title">{listenerHeadline(l)}</span>
                  <button
                    type="button"
                    className="signal-xref-goto"
                    disabled={!target}
                    onClick={() => target && props.onFocus(target as ValidationTargetDef, `转移「${l.transitionId}」`)}
                  >
                    画布定位
                  </button>
                </div>
                <div className="signal-xref-item-where">{listenerSubline(l)}</div>
              </div>
            );
          })}
        </XrefSection>
      ) : null}

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

/**
 * 一拍的全貌：怎么进来 → 从这儿去哪 → 进出会发什么 → **谁在看着**。
 *
 * 最后那栏是这个视图存在的理由：读状态的引用绝大多数是转移以外的消费者
 * （对话分支、场景实体显隐、章节包、任务、地图节点、档案），它们在因果图上一条线都没有，
 * 改一拍最容易漏的就是它们。
 */
function StateXrefDetail(props: {
  card: StateXrefCardDef;
  onReveal: (row: RowRef, label: string) => void;
  onFocus: (target: ValidationTargetDef, label: string) => void;
  onInspectSignal: (signalId: string) => void;
}) {
  const { card } = props;
  const badges = [
    card.isInitial ? '初始拍' : '',
    card.broadcasts ? '进入时广播' : '',
    card.runGraph ? '活计图' : '',
    card.exists ? '' : '图里没有这个状态',
  ].filter(Boolean);
  const selfTarget = stateFocusTarget(card);
  return (
    <>
      <div className="signal-xref-head">
        <div className="signal-xref-head-text">
          <div className="signal-xref-title">{stateHeadline(card)}</div>
          <div className="muted">
            {card.compositionLabel ? `${card.compositionLabel} · ` : ''}{stateKey(card)}
            {badges.length ? ` · ${badges.join(' · ')}` : ''}
          </div>
        </div>
        <div className="signal-xref-head-actions">
          <button
            type="button"
            className="secondary"
            disabled={!selfTarget}
            title={selfTarget ? '在画布上选中这一拍' : '这一拍在当前画布上不存在，定位不了'}
            onClick={() => selfTarget && props.onFocus(selfTarget, `这一拍「${card.stateLabel}」`)}
          >
            画布定位
          </button>
        </div>
      </div>

      {card.diagnostics.map((d) => (
        <p key={d.code + d.message} className={`signal-xref-diag sev-${d.severity}`}>
          {SEVERITY_MARK[d.severity]} {d.message}
        </p>
      ))}

      <XrefSection
        title="怎么进来"
        count={card.waysIn.length}
        empty={card.isInitial ? '这是图的初始拍——一开局就停在这儿' : '没有任何路能进到这一拍'}
      >
        {card.waysIn.map((e) => {
          const target = focusTargetOfEmitter(e);
          return (
            <div key={`in:${e.file}#${e.pointer}#${e.where}`} className="signal-xref-item">
              <div className="signal-xref-item-head">
                <span className="signal-xref-item-title">
                  {emitterHeadline(e)}{e.wired ? '' : '（这条路还没接线）'}
                </span>
                <button
                  type="button"
                  className="signal-xref-goto"
                  disabled={!target && !canReveal(e)}
                  onClick={() => (target
                    ? props.onFocus(target, emitterHeadline(e))
                    : props.onReveal(e, emitterHeadline(e)))}
                >
                  {target ? '画布定位' : '去看看'}
                </button>
              </div>
              <div className="signal-xref-item-where">{e.where}</div>
              {e.context ? <div className="signal-xref-item-context">{e.context}</div> : null}
            </div>
          );
        })}
      </XrefSection>

      <XrefSection title="从这儿去哪" count={card.waysOut.length} empty="没有出口——末态是正常的，中间拍就是断了">
        {card.waysOut.map((l) => {
          const target = listenerFocusTarget(l);
          return (
            <div key={`out:${l.graphId}:${l.transitionId}`} className="signal-xref-item">
              <div className="signal-xref-item-head">
                <span className="signal-xref-item-title">→ {l.toLabel || l.to}</span>
                <button
                  type="button"
                  className="signal-xref-goto"
                  disabled={!target}
                  onClick={() => target && props.onFocus(target as ValidationTargetDef, `转移「${l.transitionId}」`)}
                >
                  画布定位
                </button>
              </div>
              <div className="signal-xref-item-where">{listenerSubline(l)}</div>
              <div className="signal-xref-item-context">
                {l.signal && !l.trigger && l.how.includes('收到信号') ? (
                  <>
                    收到{' '}
                    <button type="button" className="signal-xref-link" onClick={() => props.onInspectSignal(l.signal)}>
                      「{l.signal}」
                    </button>
                    {' '}时走
                  </>
                ) : l.how}
              </div>
            </div>
          );
        })}
      </XrefSection>

      {card.emits.length ? (
        <XrefSection title="进出这一拍会发什么信号" count={card.emits.length} empty="">
          {card.emits.map((e) => (
            <div key={`emit:${e.file}#${e.pointer}#${e.signal}`} className="signal-xref-item">
              <div className="signal-xref-item-head">
                <span className="signal-xref-item-title">
                  <button type="button" className="signal-xref-link" onClick={() => props.onInspectSignal(e.signal)}>
                    {e.signal}
                  </button>
                </span>
              </div>
              <div className="signal-xref-item-where">{e.where}{e.context ? ` · ${e.context}` : ''}</div>
            </div>
          ))}
        </XrefSection>
      ) : null}

      <XrefSection
        title="谁在看着这一拍"
        count={card.readers.length}
        empty="没人读它——改这一拍不牵连别的地方"
        hint="条件、对话分支、场景实体显隐、章节包、任务、地图节点…这些在因果图上一条线都没有，改一拍最容易漏的就是它们"
      >
        {card.readers.map((r) => {
          const target = readerFocusTarget(r);
          return (
            <div key={`read:${r.file}#${r.pointer}`} className="signal-xref-item">
              <div className="signal-xref-item-head">
                <span className="signal-xref-item-title">{readerHeadline(r)}</span>
                <button
                  type="button"
                  className="signal-xref-goto"
                  disabled={!target && !canReveal(r)}
                  title={target ? '在画布上定位' : (canReveal(r) ? '切到那个编辑页' : revealBlockedReason(r))}
                  onClick={() => (target
                    ? props.onFocus(target, readerHeadline(r))
                    : props.onReveal(r, readerHeadline(r)))}
                >
                  {target ? '画布定位' : '去看看'}
                </button>
              </div>
              <div className="signal-xref-item-context">{readerEffect(r)}</div>
              {r.where ? <div className="signal-xref-item-where">{r.where}</div> : null}
            </div>
          );
        })}
      </XrefSection>
    </>
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
