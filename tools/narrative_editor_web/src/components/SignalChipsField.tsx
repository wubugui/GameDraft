type SignalChipsFieldProps = {
  label: string;
  value: string[];
  options: string[];
  onChange: (value: string[]) => void;
};

export function SignalChipsField({ label, value, options, onChange }: SignalChipsFieldProps) {
  const selected = new Set(value);
  const toggle = (sig: string) => {
    if (selected.has(sig)) onChange(value.filter((item) => item !== sig));
    else onChange([...value, sig]);
  };

  return (
    <div className="field signal-chips-field">
      <label>{label}</label>
      <div className="signal-chips">
        {options.length === 0 ? (
          <span className="muted">暂无已知 signal</span>
        ) : options.map((sig) => (
          <button
            key={sig}
            type="button"
            className={`signal-chip${selected.has(sig) ? ' active' : ''}`}
            onClick={() => toggle(sig)}
          >
            {sig}
          </button>
        ))}
      </div>
      <details className="signal-chips-advanced">
        <summary>高级：逐行编辑</summary>
        <textarea
          className="small-textarea"
          value={value.join('\n')}
          onChange={(e) => onChange(e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))}
        />
      </details>
    </div>
  );
}
