import { useMemo, useState } from 'react';
import { buildSignalCatalog, createAuthorSignal, setAuthorSignalNotes } from '../signalCatalog';
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
  /** 信号重构入口（改 id / 删除走全项目级联重构）。仅 Qt 宿主内可用；未传则不显示重构按钮。 */
  onRequestRefactor?: (mode: 'rename' | 'delete', signalId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<SignalKindFilter>('all');
  const [newId, setNewId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [error, setError] = useState('');
  const [editingNotesId, setEditingNotesId] = useState('');
  const [notesDraft, setNotesDraft] = useState('');

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
      return e.id.toLowerCase().includes(q)
        || (e.label ?? '').toLowerCase().includes(q)
        || (e.notes ?? '').toLowerCase().includes(q);
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
        createAuthorSignal(data, newId, newLabel, newNotes);
      });
      props.onSelect(newId.trim());
      setNewId('');
      setNewLabel('');
      setNewNotes('');
      setError('');
      props.onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  const startEditNotes = (entry: SignalCatalogEntryDef) => {
    setEditingNotesId(entry.id);
    setNotesDraft(entry.notes ?? '');
  };
  const cancelEditNotes = () => {
    setEditingNotesId('');
    setNotesDraft('');
  };
  const saveNotes = (id: string) => {
    props.onDataChange((data) => {
      setAuthorSignalNotes(data, id, notesDraft);
    });
    cancelEditNotes();
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
            placeholder={kindFilter === 'derived' ? '搜索派生信号（state:图:状态）' : kindFilter === 'author' ? '搜索作者信号 / 注释' : '搜索 id / 名称 / 注释'}
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
            <div key={entry.id} className={`signal-row-wrap${entry.id === props.currentSignal ? ' active' : ''}`}>
              <div className="signal-row-line">
                <button
                  type="button"
                  className="signal-row"
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
                  {entry.notes ? <span className="signal-row-notes">📝 {entry.notes}</span> : null}
                </button>
                {entry.editable ? (
                  <button
                    type="button"
                    className="signal-row-note-edit"
                    title={entry.notes ? '编辑注释' : '添加注释'}
                    onClick={() => startEditNotes(entry)}
                  >
                    {entry.notes ? '✎' : '+注释'}
                  </button>
                ) : null}
                {entry.editable && entry.kind === 'author' && props.onRequestRefactor ? (
                  <>
                    <button
                      type="button"
                      className="signal-row-note-edit"
                      title="重构改名：全项目级联更新监听/发射/注册表/画布声明（含对话图与场景），可撤销，不落盘"
                      onClick={() => {
                        props.onRequestRefactor!('rename', entry.id);
                        props.onClose();
                      }}
                    >
                      改名
                    </button>
                    <button
                      type="button"
                      className="signal-row-note-edit"
                      title="重构删除：先列出全部使用点；有引用需确认强制清理（监听置草稿、发射动作移除），可撤销，不落盘"
                      onClick={() => {
                        props.onRequestRefactor!('delete', entry.id);
                        props.onClose();
                      }}
                    >
                      删除
                    </button>
                  </>
                ) : null}
              </div>
              {editingNotesId === entry.id ? (
                <div className="signal-notes-editor">
                  <textarea
                    autoFocus
                    value={notesDraft}
                    placeholder="这个信号是干嘛的？什么时候发出、谁监听、驱动哪一步——写清楚让别人看得懂。"
                    onChange={(e) => setNotesDraft(e.target.value)}
                  />
                  <div className="signal-notes-editor-actions">
                    <button type="button" onClick={() => saveNotes(entry.id)}>保存注释</button>
                    <button type="button" className="secondary" onClick={cancelEditNotes}>取消</button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <footer className="signal-modal-footer">
          {kindFilter !== 'derived' ? (
            <div className="signal-create-row">
              <div className="signal-create-fields">
                <input placeholder="新建作者信号 id" value={newId} onChange={(e) => setNewId(e.target.value)} />
                <input placeholder="显示名（可选）" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
                <textarea
                  className="signal-create-notes"
                  placeholder="注释（可选）：这个信号是干嘛的、何时发出、谁监听……"
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                />
              </div>
              <button type="button" onClick={createAndPick} disabled={!newId.trim()}>新建并选用</button>
            </div>
          ) : (
            <p className="muted">派生信号由状态自动生成，不可新建；其含义看对应状态。</p>
          )}
          {error ? <p className="signal-modal-error">{error}</p> : null}
          <p className="muted">当前：{props.currentSignal || DEFAULT_DRAFT_SIGNAL}</p>
        </footer>
      </div>
    </div>
  );
}
