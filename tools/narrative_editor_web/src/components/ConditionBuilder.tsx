import { useMemo, useState } from 'react';

type NarrativeLeaf = { narrative: string; state: string };

function isNarrativeLeaf(value: unknown): value is NarrativeLeaf {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as NarrativeLeaf).narrative === 'string');
}

export function ConditionBuilder({
  value,
  graphIds,
  graphLabels,
  statesByGraph,
  stateLabelsByGraph,
  onApply,
}: {
  value: unknown;
  graphIds: string[];
  graphLabels?: Record<string, string>;
  statesByGraph: Record<string, string[]>;
  stateLabelsByGraph?: Record<string, Record<string, string>>;
  onApply: (value: unknown) => void;
}) {
  const [showJson, setShowJson] = useState(false);
  const [jsonDraft, setJsonDraft] = useState(JSON.stringify(value ?? [], null, 2));
  const leaves = useMemo(() => extractNarrativeLeaves(value), [value]);

  const updateLeaves = (next: NarrativeLeaf[]) => {
    onApply(next.length === 1 ? next[0] : next);
  };

  if (showJson) {
    return (
      <div className="field">
        <label>conditions（JSON）</label>
        <textarea className="json-mini" value={jsonDraft} onChange={(e) => setJsonDraft(e.target.value)} />
        <div className="inspector-actions">
          <button type="button" onClick={() => {
            try {
              onApply(JSON.parse(jsonDraft));
              setShowJson(false);
            } catch {
              /* keep editing */
            }
          }}>应用 JSON</button>
          <button type="button" onClick={() => setShowJson(false)}>返回简易编辑</button>
        </div>
      </div>
    );
  }

  return (
    <div className="field">
      <label>conditions</label>
      <div className="condition-rows">
        {leaves.map((leaf, index) => (
          <div className="condition-row" key={`${index}-${leaf.narrative}`}>
            <select
              value={leaf.narrative}
              onChange={(e) => {
                const next = [...leaves];
                next[index] = { narrative: e.target.value, state: statesByGraph[e.target.value]?.[0] ?? '' };
                updateLeaves(next);
              }}
            >
              {graphIds.map((gid) => <option key={gid} value={gid}>{graphLabels?.[gid] ?? gid}</option>)}
            </select>
            <select
              value={leaf.state}
              onChange={(e) => {
                const next = [...leaves];
                next[index] = { ...leaf, state: e.target.value };
                updateLeaves(next);
              }}
            >
              {(statesByGraph[leaf.narrative] ?? []).map((sid) => (
                <option key={sid} value={sid}>{stateLabelsByGraph?.[leaf.narrative]?.[sid] ?? sid}</option>
              ))}
            </select>
            <button type="button" onClick={() => updateLeaves(leaves.filter((_, i) => i !== index))}>删</button>
          </div>
        ))}
      </div>
      <div className="inspector-actions">
        <button
          type="button"
          onClick={() => updateLeaves([...leaves, { narrative: graphIds[0] ?? '', state: statesByGraph[graphIds[0] ?? '']?.[0] ?? '' }])}
        >
          添加 narrative 条件
        </button>
        <button type="button" onClick={() => { setJsonDraft(JSON.stringify(value ?? [], null, 2)); setShowJson(true); }}>
          编辑原始 JSON
        </button>
      </div>
    </div>
  );
}

function extractNarrativeLeaves(value: unknown): NarrativeLeaf[] {
  if (isNarrativeLeaf(value)) return [value];
  if (Array.isArray(value)) return value.filter(isNarrativeLeaf);
  return [];
}
