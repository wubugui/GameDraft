import { useMemo, useState } from 'react';
import { buildSignalCatalog, createAuthorSignal } from '../signalCatalog';
import { DEFAULT_DRAFT_SIGNAL } from '../signalConstants';
import type { NarrativeGraphsFileDef, SignalCatalogEntryDef } from '../types';

type SignalKindFilter = 'all' | 'author' | 'derived';

const KIND_FILTER_OPTIONS: Array<{ id: SignalKindFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'author', label: '作者信号' },
  { id: 'derived', label: '派生信号' },
];

export function SignalPickerModal(props: {
  open: boolean;
  data: NarrativeGraphsFileDef;
  currentSignal: string;
  onClose: () => void;
  onSelect: (signalId: string) => void;
  onDataChange: (updater: (data: NarrativeGraphsFileDef) => void) => void;
}) {
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<SignalKindFilter>('all');
  const [newId, setNewId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [error, setError] = useState('');

  const catalog = useMemo(() => buildSignalCatalog(props.data), [props.data]);

  const counts = useMemo(() => ({
    all: catalog.filter((e) => e.kind !== 'draft').length,
    author: catalog.filter((e) => e.kind === 'author').length,
    derived: catalog.filter((e) => e.kind === 'derived').length,
  }), [catalog]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((e) => {
      if (e.kind === 'draft') return kindFilter === 'all' && !q;
      if (kindFilter === 'author' && e.kind !== 'author') return false;
      if (kindFilter === 'derived' && e.kind !== 'derived') return false;
      if (!q) return true;
      return e.id.toLowerCase().includes(q) || (e.label ?? '').toLowerCase().includes(q);
    });
  }, [catalog, query, kindFilter]);

  if (!props.open) return null;

  const pick = (entry: SignalCatalogEntryDef) => {
    props.onSelect(entry.id);
    props.onClose();
  };

  const createAndPick = () => {
    try {
      props.onDataChange((data) => {
        createAuthorSignal(data, newId, newLabel);
      });
      props.onSelect(newId.trim());
      setNewId('');
      setNewLabel('');
      setError('');
      props.onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="signal-modal-backdrop" role="presentation" onClick={props.onClose}>
      <div className="signal-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="signal-modal-header">
          <h3>选择叙事信号</h3>
          <button type="button" className="secondary" onClick={props.onClose}>关闭</button>
        </header>
        <div className="signal-modal-toolbar">
          <div className="signal-kind-filters" role="tablist" aria-label="信号类型筛选">
            {KIND_FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={kindFilter === opt.id}
                className={kindFilter === opt.id ? 'active' : ''}
                onClick={() => setKindFilter(opt.id)}
              >
                {opt.label}
                <span className="signal-kind-count">({counts[opt.id]})</span>
              </button>
            ))}
          </div>
          <input
            type="search"
            placeholder={kindFilter === 'derived' ? '搜索派生信号（state:图:状态）' : kindFilter === 'author' ? '搜索作者信号' : '搜索 id / 名称'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="signal-modal-list">
          {filtered.length === 0 ? (
            <p className="signal-modal-empty muted">
              {kindFilter === 'author' ? '没有匹配的作者信号' : kindFilter === 'derived' ? '没有匹配的派生信号' : '没有匹配的信号'}
            </p>
          ) : null}
          {filtered.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`signal-row${entry.id === props.currentSignal ? ' active' : ''}`}
              onClick={() => pick(entry)}
            >
              <span className="signal-row-id">{entry.id}</span>
              <span className="signal-row-meta">
                {entry.kind === 'author' ? '作者' : entry.kind === 'derived' ? '派生' : '草稿'}
                {entry.label ? ` · ${entry.label}` : ''}
                {/* 本弹窗按 props.data 构建目录、未传 emitterRefsById，故发射数恒为 0、会误导；
                    只展示准确的「监听」数（发射源跨对话/场景/运行时，无法在此可靠统计）。 */}
                {` · 监听 ${entry.listeners}`}
              </span>
            </button>
          ))}
        </div>
        <footer className="signal-modal-footer">
          {kindFilter !== 'derived' ? (
            <div className="signal-create-row">
              <input placeholder="新建作者信号 id" value={newId} onChange={(e) => setNewId(e.target.value)} />
              <input placeholder="显示名（可选）" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
              <button type="button" onClick={createAndPick} disabled={!newId.trim()}>新建并选用</button>
            </div>
          ) : (
            <p className="muted">派生信号由状态自动生成，不可新建。</p>
          )}
          {error ? <p className="signal-modal-error">{error}</p> : null}
          <p className="muted">当前：{props.currentSignal || DEFAULT_DRAFT_SIGNAL}</p>
        </footer>
      </div>
    </div>
  );
}
