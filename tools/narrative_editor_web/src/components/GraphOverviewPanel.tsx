/**
 * 「编排全貌」面板：一张图（或整个编排）与游戏里真实存在的东西之间的全部关联，四组，每行一下就跳。
 *
 * - 只读：不改数据、不标脏；扫描走宿主只读 slot（网页开发态走 vite 直连 python）。
 * - 只列**东西**：区域 / 热点 / NPC / 对话图 / 过场 / 物品 / 任务 / 地图节点 / 档案 / 位面…；
 *   信号名、状态名、标签都不单列（它们在「关系」面板里）。
 * - 长清单按「哪一拍」分段折叠、有类别筛选、有搜索、能只看画布上选中的那一拍——主图近百行
 *   平铺是验收实测的第一处卡点。
 * - 不谎报：跳转三态（精确 / 只开了页 / 没跳成）原样说；网页开发态不能切页就把去处说给人听。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  REF_GROUP_HINTS,
  REF_GROUP_LABELS,
  filterRows,
  groupRowsByState,
  kindCounts,
  overviewSummary,
  type GraphOverviewModel,
  type RefGroup,
  type RefRow,
} from '../graphOverview';
import type { ValidationTargetDef } from '../types';

const GROUPS: RefGroup[] = ['push', 'gate', 'call', 'next'];
/** 超过这么多行的组默认按拍折起来（只看一眼计数，要看再展开） */
const FOLD_THRESHOLD = 12;

export function GraphOverviewPanel(props: {
  model: GraphOverviewModel | null;
  /** 能挑的视图：整个编排 + 主图 + 各子图 */
  graphs: Array<{ id: string; label: string }>;
  selectedGraphId: string;
  onSelectGraph: (graphId: string) => void;
  scanning: boolean;
  error: string;
  stale: boolean;
  scannedAt: string;
  onRescan: () => void;
  onJump: (row: RefRow) => void;
  onFocus: (target: ValidationTargetDef, label: string) => void;
  jumpNote: string;
  /** 画布上选中的那一拍（图 id + 状态 id）：对应行高亮；勾「只看这一拍」时只列它与进入它的路 */
  highlight: { graphId: string; stateId: string; stateLabel: string } | null;
  /** 从小标「+N」进来时要落到的组（滚过去） */
  scrollToGroup: RefGroup | '';
  scrollToken: number;
}) {
  const [query, setQuery] = useState('');
  const [onlyHighlighted, setOnlyHighlighted] = useState(false);
  const [kinds, setKinds] = useState<ReadonlySet<string>>(new Set());
  const groupRefs = useRef<Record<string, HTMLElement | null>>({});
  const { model } = props;

  useEffect(() => {
    if (!props.scrollToGroup) return;
    const el = groupRefs.current[props.scrollToGroup];
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [props.scrollToGroup, props.scrollToken]);

  // 换图就清掉类别筛选：上一张图的类别在这张图上可能一个都没有，留着会把清单筛成空
  useEffect(() => { setKinds(new Set()); }, [model?.graphId]);

  const highlightUsable = Boolean(props.highlight?.stateId);
  const stateFilter = onlyHighlighted && props.highlight ? props.highlight : null;
  const filter = useMemo(() => ({
    query,
    stateId: stateFilter?.stateId ?? '',
    graphId: stateFilter?.graphId ?? '',
    kinds,
  }), [query, stateFilter, kinds]);
  const visible = useMemo(() => {
    if (!model) return null;
    return {
      push: filterRows(model.push, filter),
      gate: filterRows(model.gate, filter),
      call: filterRows(model.call, filter),
      next: filterRows(model.next, { query, kinds }),
    };
  }, [model, filter, query, kinds]);
  const kindRows = useMemo(() => (model ? kindCounts(model) : []), [model]);
  const filtering = Boolean(query.trim()) || Boolean(stateFilter) || kinds.size > 0;

  const toggleKind = (kind: string) => {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next;
    });
  };

  return (
    <div className="signal-xref-panel graph-overview-panel">
      <div className="signal-xref-toolbar">
        <select
          value={props.selectedGraphId}
          onChange={(e) => props.onSelectGraph(e.target.value)}
          title="看整个编排，还是本编排里的哪一张图"
          className="graph-overview-pick"
        >
          {props.graphs.map((g) => (
            <option key={g.id} value={g.id}>{g.label || g.id}</option>
          ))}
        </select>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜东西的名字：区域、NPC、过场、任务…"
        />
        <button type="button" className="secondary" onClick={props.onRescan} disabled={props.scanning} title="重新扫描全工程（在别的编辑页改过东西之后点这个）">
          {props.scanning ? '扫描中…' : '重新扫描'}
        </button>
      </div>
      {props.error ? <p className="signal-xref-diag sev-error">✗ {props.error}</p> : null}
      {props.stale && !props.scanning ? (
        <p className="signal-xref-stale">画布在这次扫描之后又改过了，下面的关联可能过期——点「重新扫描」。</p>
      ) : null}

      {!model ? (
        <p className="muted">{props.scanning ? '正在扫描全工程…' : '还没有扫描结果。'}</p>
      ) : !model.exists ? (
        <p className="signal-xref-diag sev-error">✗ 目录里没有图「{model.graphId}」（可能刚新建、还没扫描）</p>
      ) : (
        <>
          <div className="signal-xref-head">
            <div className="signal-xref-head-text">
              <div className="signal-xref-title">{model.graphLabel}</div>
              <div className="muted">
                {model.ownerLine ? `${model.ownerLine} · ` : ''}{model.wholeComposition ? '' : `${model.graphId} · `}
                {model.compositionLabel}
                {props.scannedAt ? ` · ${props.scannedAt} 扫的` : ''}
              </div>
              <div className="graph-overview-summary">{overviewSummary(model)}</div>
            </div>
          </div>
          <div className="graph-overview-filters">
            <label
              className={`toggle compact-toggle graph-overview-only${highlightUsable ? '' : ' disabled'}`}
              title={highlightUsable
                ? '只列挂在这一拍的东西，外加进入这一拍的路'
                : '先在画布上点一个状态节点，这里才有"这一拍"可看'}
            >
              <input
                type="checkbox"
                checked={onlyHighlighted && highlightUsable}
                disabled={!highlightUsable}
                onChange={(e) => setOnlyHighlighted(e.target.checked)}
              />
              只看画布上选中的这一拍{props.highlight?.stateLabel ? `：「${props.highlight.stateLabel}」` : '（先在画布上点一个状态）'}
            </label>
            {kindRows.length > 1 ? (
              <div className="graph-overview-kinds" role="group" aria-label="只看这些类别">
                <button
                  type="button"
                  className={`graph-overview-kind${kinds.size === 0 ? ' active' : ''}`}
                  onClick={() => setKinds(new Set())}
                  title="全部类别"
                >
                  全部
                </button>
                {kindRows.map(({ kind, count }) => (
                  <button
                    key={kind}
                    type="button"
                    className={`graph-overview-kind${kinds.has(kind) ? ' active' : ''}`}
                    onClick={() => toggleKind(kind)}
                    title={`只看「${kind}」（可多选）`}
                  >
                    {kind} <small>{count}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="signal-xref-detail graph-overview-groups">
            {GROUPS.map((group) => {
              const rows = visible![group];
              const total = model[group].length;
              if (group === 'next' && total === 0) return null;
              const foldable = group !== 'next' && total > FOLD_THRESHOLD;
              return (
                <section
                  key={group}
                  className="signal-xref-section"
                  ref={(el) => { groupRefs.current[group] = el; }}
                >
                  <div className="signal-xref-section-head">
                    <span className="signal-xref-section-title">{REF_GROUP_LABELS[group]}</span>
                    <span className="signal-xref-section-count">{rows.length === total ? total : `${rows.length} / ${total}`}</span>
                  </div>
                  <div className="muted signal-xref-section-hint">{REF_GROUP_HINTS[group]}</div>
                  {total === 0 ? (
                    <div className="signal-xref-empty">{EMPTY_TEXT[group]}</div>
                  ) : rows.length === 0 ? (
                    <div className="signal-xref-empty">没有命中搜索 / 筛选。</div>
                  ) : foldable ? (
                    <div className="graph-overview-rows">
                      {groupRowsByState(rows).map((bucket) => (
                        <details key={bucket.key} className="graph-overview-state" open={filtering || bucket.rows.length <= 3}>
                          <summary>
                            <span>{bucket.rows[0]!.graphLabel && model.wholeComposition ? `图「${bucket.rows[0]!.graphLabel}」 · ` : ''}{bucket.label}</span>
                            <small>{bucket.rows.length}</small>
                          </summary>
                          {bucket.rows.map((row) => (
                            <OverviewRow
                              key={row.key}
                              row={row}
                              active={Boolean(props.highlight) && row.stateId === props.highlight!.stateId && row.graphId === props.highlight!.graphId}
                              onJump={props.onJump}
                              onFocus={props.onFocus}
                            />
                          ))}
                        </details>
                      ))}
                    </div>
                  ) : (
                    <div className="graph-overview-rows">
                      {rows.map((row) => (
                        <OverviewRow
                          key={row.key}
                          row={row}
                          active={Boolean(props.highlight) && row.stateId === props.highlight!.stateId && row.graphId === props.highlight!.graphId}
                          onJump={props.onJump}
                          onFocus={props.onFocus}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
      {props.jumpNote ? <p className="signal-xref-jump-note">{props.jumpNote}</p> : null}
    </div>
  );
}

const EMPTY_TEXT: Record<RefGroup, string> = {
  push: '没有任何外部来源推它——它的转移要么是草稿，要么只靠本图自己发信号',
  gate: '没人读它的状态——改它不牵连别处',
  call: '它的状态动作不去动任何资产',
  next: '',
};

function OverviewRow(props: {
  row: RefRow;
  active: boolean;
  onJump: (row: RefRow) => void;
  onFocus: (target: ValidationTargetDef, label: string) => void;
}) {
  const { row } = props;
  const blocked = row.jump.kind === 'none';
  const jumpTitle = row.jump.kind === 'none'
    ? row.jump.reason
    : row.jump.kind === 'focus'
      ? '在画布上定位到它'
      : '跳到它的编辑页';
  return (
    <div className={`graph-overview-row${props.active ? ' active' : ''}${row.selfGraph ? ' self' : ''}`}>
      <button
        type="button"
        className="graph-overview-main"
        title={jumpTitle}
        onClick={() => props.onJump(row)}
        disabled={blocked}
      >
        <span className={`overview-kind ${row.group}`}>{row.kindLabel}</span>
        <span className="overview-text">
          <span className="overview-title">{row.title}</span>
          <span className="overview-sub">{row.subtitle}{row.detail ? ` · ${row.detail}` : ''}</span>
        </span>
        <span className="overview-arrow" aria-hidden>{blocked ? '—' : '↗'}</span>
      </button>
      {row.canvasFocus ? (
        <button
          type="button"
          className="graph-overview-locate"
          title="在本图画布上定位它挂着的那一拍 / 那条转移"
          onClick={() => props.onFocus(row.canvasFocus!, row.title)}
        >
          定位
        </button>
      ) : null}
    </div>
  );
}
