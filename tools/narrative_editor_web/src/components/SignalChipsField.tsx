import { useMemo, useState } from 'react';

type SignalChipsFieldProps = {
  label: string;
  value: string[];
  /** 弹出添加时的候选清单；只读展示可不传 */
  options?: string[];
  /** 不传 onChange = 只读展示（自动推导值） */
  onChange?: (value: string[]) => void;
  /** 面板上的一句话说明（写人话，一看就懂） */
  note?: string;
  emptyText?: string;
};

const PICKER_PAGE = 40;

/**
 * 信号/引用清单字段。只渲染**已选中**的条目；编辑态通过「＋添加…」搜索候选加入。
 * 不再把全项目候选目录平铺成可点按钮（那是误触面 + 视觉轰炸，见 2026-07-11
 * 「下拉 vs 弹窗选择器边界」拍板）。
 */
export function SignalChipsField({ label, value, options = [], onChange, note, emptyText }: SignalChipsFieldProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  // 逐行编辑的本地草稿（P3）：受控 textarea 若直接用「过滤空行后的 value」回显，按 Enter
  // 产生的尾部空行会被立刻吞掉、光标弹回行尾——永远开不出新行。编辑期间以本地文本为准
  // （空行保留），每次击键仍把解析后的清单上抛；失焦再回落到规范化显示。
  const [linesDraft, setLinesDraft] = useState<string | null>(null);
  const readOnly = !onChange;

  const candidates = useMemo(() => {
    const selected = new Set(value);
    const q = query.trim().toLowerCase();
    return options.filter((opt) => !selected.has(opt) && (!q || opt.toLowerCase().includes(q)));
  }, [options, value, query]);

  return (
    <div className="field signal-chips-field">
      <label>{label}</label>
      {note ? <div className="signal-chips-note muted">{note}</div> : null}
      <div className="signal-chips">
        {value.length === 0 ? (
          <span className="muted">{emptyText ?? '（无）'}</span>
        ) : value.map((sig) => (
          readOnly ? (
            <span key={sig} className="signal-chip active readonly">{sig}</span>
          ) : (
            <button
              key={sig}
              type="button"
              className="signal-chip active"
              title="点击移除"
              onClick={() => onChange(value.filter((item) => item !== sig))}
            >
              {sig} ✕
            </button>
          )
        ))}
        {!readOnly && (
          <button type="button" className="signal-chip add" onClick={() => setPickerOpen((open) => !open)}>
            {pickerOpen ? '收起' : '＋ 添加…'}
          </button>
        )}
      </div>
      {!readOnly && pickerOpen && (
        <div className="signal-chips-picker">
          <input
            placeholder="搜索候选…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="signal-chips-picker-list">
            {candidates.length === 0 ? (
              <span className="muted">无匹配候选</span>
            ) : candidates.slice(0, PICKER_PAGE).map((sig) => (
              <button key={sig} type="button" className="signal-chip" onClick={() => onChange([...value, sig])}>
                {sig}
              </button>
            ))}
            {candidates.length > PICKER_PAGE ? (
              <span className="muted">…还有 {candidates.length - PICKER_PAGE} 个，请搜索缩小范围</span>
            ) : null}
          </div>
        </div>
      )}
      {!readOnly && (
        <details className="signal-chips-advanced">
          <summary>逐行编辑</summary>
          <textarea
            className="small-textarea"
            value={linesDraft ?? value.join('\n')}
            onChange={(e) => {
              setLinesDraft(e.target.value);
              onChange(e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
            }}
            onBlur={() => setLinesDraft(null)}
          />
        </details>
      )}
    </div>
  );
}
