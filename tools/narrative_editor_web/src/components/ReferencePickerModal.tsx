import { useEffect, useMemo, useState } from 'react';
import type { ReferenceCatalogEntryDef } from '../types';

export function referenceEntryMatches(entry: ReferenceCatalogEntryDef, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    entry.kind,
    entry.id,
    entry.qualifiedId,
    entry.label,
    ...(entry.aliases ?? []),
  ].join('\n').toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterReferenceEntries(
  entries: ReferenceCatalogEntryDef[],
  query: string,
): ReferenceCatalogEntryDef[] {
  return entries.filter((entry) => referenceEntryMatches(entry, query));
}

export function findReferenceEntry(
  entries: ReferenceCatalogEntryDef[],
  value: string,
): ReferenceCatalogEntryDef | undefined {
  const current = value.trim();
  if (!current) return undefined;
  return entries.find((entry) => (
    entry.id === current
    || entry.qualifiedId === current
    || (entry.aliases ?? []).includes(current)
  ));
}

export function ReferencePickerModal(props: {
  open: boolean;
  title: string;
  entries: ReferenceCatalogEntryDef[];
  currentValue: string;
  allowCustom?: boolean;
  onClose: () => void;
  onSelect: (value: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [customId, setCustomId] = useState('');

  useEffect(() => {
    if (!props.open) return;
    setQuery('');
    setSelectedId(findReferenceEntry(props.entries, props.currentValue)?.id ?? '');
    setCustomId(props.currentValue);
  }, [props.open, props.currentValue, props.entries]);

  const filtered = useMemo(
    () => filterReferenceEntries(props.entries, query),
    [props.entries, query],
  );
  if (!props.open) return null;

  const choose = (value: string) => {
    props.onSelect(value);
    props.onClose();
  };

  return (
    <div className="reference-modal-backdrop" role="presentation" onClick={props.onClose}>
      <div
        className="reference-modal"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="reference-modal-header">
          <div>
            <h3>{props.title}</h3>
            <p className="muted">搜索后双击选用，或单击一行再确认。</p>
          </div>
          <button type="button" className="secondary" onClick={props.onClose}>关闭</button>
        </header>
        <div className="reference-modal-toolbar">
          <input
            autoFocus
            type="search"
            aria-label="筛选引用"
            placeholder="筛选类型 / 限定 id / 标签"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span>{filtered.length} / {props.entries.length}</span>
        </div>
        <div className="reference-modal-current">
          当前值：<code>{props.currentValue || '（空）'}</code>
          {props.currentValue && !findReferenceEntry(props.entries, props.currentValue)
            ? <span className="reference-unknown">⚠ 未登记旧值（关闭窗口会原样保留）</span>
            : null}
        </div>
        <div className="reference-modal-list" role="listbox" aria-label="引用候选">
          {filtered.length === 0 ? <p className="muted reference-modal-empty">没有匹配的引用</p> : null}
          {filtered.map((entry) => (
            <button
              key={`${entry.kind}:${entry.id}`}
              type="button"
              role="option"
              aria-selected={selectedId === entry.id}
              className={`reference-row${selectedId === entry.id ? ' active' : ''}`}
              onClick={() => setSelectedId(entry.id)}
              onDoubleClick={() => choose(entry.id)}
            >
              <span className="reference-row-kind">{entry.kind}</span>
              <code className="reference-row-id">{entry.qualifiedId}</code>
              <span className="reference-row-label">{entry.label || entry.qualifiedId}</span>
            </button>
          ))}
        </div>
        <footer className="reference-modal-footer">
          <button type="button" className="secondary" onClick={() => choose('')}>清空引用</button>
          {props.allowCustom ? (
            <div className="reference-modal-custom">
              <input
                aria-label="定义引用 ID"
                placeholder="定义开放命名空间 ID"
                value={customId}
                onChange={(event) => setCustomId(event.target.value)}
              />
              <button
                type="button"
                className="secondary"
                disabled={!customId.trim()}
                onClick={() => choose(customId.trim())}
              >定义并选用</button>
            </div>
          ) : null}
          <span className="reference-modal-selection">
            {selectedId ? `将选择：${selectedId}` : '尚未选择候选'}
          </span>
          <button type="button" disabled={!selectedId} onClick={() => choose(selectedId)}>选用</button>
        </footer>
      </div>
    </div>
  );
}

export function ReferencePickerField(props: {
  label: string;
  value: string;
  entries: ReferenceCatalogEntryDef[];
  allowCustom?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = findReferenceEntry(props.entries, props.value);
  const unknown = Boolean(props.value.trim()) && !current;
  return (
    <div className="field reference-picker-field">
      <label>
        {props.label}
        {unknown ? <span className="reference-unknown" title="候选目录中没有这个值；除非明确重选或清空，否则原值不会改变">⚠ 未知引用</span> : null}
      </label>
      <div className="reference-picker-field-row">
        <input
          readOnly
          value={props.value}
          title={unknown ? '未登记旧值；会原样保留' : current?.label}
          className={unknown ? 'unknown-reference' : ''}
          placeholder="（未选择）"
        />
        <button type="button" onClick={() => setOpen(true)}>选择…</button>
      </div>
      {current?.label && current.label !== props.value
        ? <span className="reference-picker-label">{current.label}</span>
        : null}
      <ReferencePickerModal
        open={open}
        title={`选择${props.label}`}
        entries={props.entries}
        currentValue={props.value}
        allowCustom={props.allowCustom}
        onClose={() => setOpen(false)}
        onSelect={props.onChange}
      />
    </div>
  );
}
