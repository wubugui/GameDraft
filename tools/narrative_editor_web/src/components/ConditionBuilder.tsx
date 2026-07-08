import { useEffect, useMemo, useState } from 'react';
import { editConditionsNative } from '../bridge';

type NarrativeLeaf = { narrative: string; state: string };

function isNarrativeLeaf(value: unknown): value is NarrativeLeaf {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as NarrativeLeaf).narrative === 'string');
}

// 简易叶子编辑器只能无损表达「空 / 单个 narrative 叶子 / 全为 narrative 叶子的数组」。
// 一旦条件里含有非 narrative 叶子（flag/quest/scenario/scenarioLine）或 all/any/not 组合，
// 简易编辑写回时会把这些部分丢掉，因此这种情况强制走原始 JSON 编辑，杜绝静默丢数据。
function isSimpleEditable(value: unknown): boolean {
  if (value == null) return true;
  if (isNarrativeLeaf(value)) return true;
  if (Array.isArray(value)) return value.every(isNarrativeLeaf);
  return false;
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
  const simpleEditable = useMemo(() => isSimpleEditable(value), [value]);
  const [showJson, setShowJson] = useState(false);
  const [jsonDraft, setJsonDraft] = useState(() => JSON.stringify(value ?? [], null, 2));
  // 按「内容」而非「引用」重置草稿：value 常是每次渲染新建的 `?? []`，
  // 用序列化字符串当依赖才不会在 JSON 编辑过程中把用户输入冲掉。
  const valueJson = useMemo(() => JSON.stringify(value ?? []), [value]);
  useEffect(() => {
    setJsonDraft(JSON.stringify(value ?? [], null, 2));
  }, [valueJson]);
  const leaves = useMemo(() => extractNarrativeLeaves(value), [value]);

  const updateLeaves = (next: NarrativeLeaf[]) => {
    onApply(next.length === 1 ? next[0] : next);
  };

  const [nativeError, setNativeError] = useState('');
  // 打开主编辑器内置的原生 ConditionEditor（全 5 类叶子 + all/any/not + 各类选择器），
  // 让策划可视化编辑 flag/quest/scenario/scenarioLine，而不必手敲 JSON。
  // 护栏：原生编辑器对「空 phase 的 scenario / 已删除的 scenarioLine」等不完整条目会静默丢弃，
  // 因此回写前比对叶子；一旦发现丢失，放弃本次修改并提示改用 JSON，杜绝静默丢数据。
  const openNativeEditor = async () => {
    const current = Array.isArray(value) ? value : value ? [value] : [];
    const result = await editConditionsNative('迁移条件', current as unknown[]);
    if (result.ok && Array.isArray(result.conditions)) {
      const lost = droppedConditionLeaves(current, result.conditions);
      if (lost.length) {
        setNativeError(`条件编辑器无法完整表达以下条目（${lost.join('、')}），已放弃本次修改以免丢失。请用「编辑原始 JSON」修改。`);
        return;
      }
      setNativeError('');
      onApply(result.conditions);
      setShowJson(false);
      return;
    }
    if (result.reason && result.reason !== 'cancelled') setNativeError(result.reason);
  };

  // 复杂条件不再强制纯 JSON：优先引导用原生条件编辑器，JSON 仍作为兜底。
  const jsonMode = showJson || !simpleEditable;

  if (jsonMode) {
    return (
      <div className="field">
        <label>conditions（JSON）</label>
        {!simpleEditable && (
          <div className="property-line note">
            此条件含 flag / quest / scenario / scenarioLine 或 all / any / not 组合。推荐用「条件编辑器」可视化编辑；也可直接改 JSON。
          </div>
        )}
        <div className="inspector-actions">
          <button type="button" onClick={openNativeEditor}>用条件编辑器…</button>
        </div>
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
          {simpleEditable && (
            <button type="button" onClick={() => setShowJson(false)}>返回简易编辑</button>
          )}
        </div>
        {nativeError && <span className="field-error">{nativeError}</span>}
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
        <button type="button" onClick={openNativeEditor}>用条件编辑器…</button>
        <button type="button" onClick={() => { setJsonDraft(JSON.stringify(value ?? [], null, 2)); setShowJson(true); }}>
          编辑原始 JSON
        </button>
      </div>
      {nativeError && <span className="field-error">{nativeError}</span>}
    </div>
  );
}

function extractNarrativeLeaves(value: unknown): NarrativeLeaf[] {
  if (isNarrativeLeaf(value)) return [value];
  if (Array.isArray(value)) return value.filter(isNarrativeLeaf);
  return [];
}

// 收集条件树里所有叶子的「身份签名」（递归进 all/any/not），用于比对编辑前后是否丢条目。
// 只取标识字段，不取 op/value 等会被合法归一化（如默认 op:== 省略）的字段，避免误报。
function conditionLeafSignatures(value: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.all)) { o.all.forEach(visit); return; }
    if (Array.isArray(o.any)) { o.any.forEach(visit); return; }
    if (o.not && typeof o.not === 'object') { visit(o.not); return; }
    if (typeof o.narrative === 'string') out.push(`narrative:${o.narrative}.${String(o.state ?? '')}`);
    else if (typeof o.flag === 'string') out.push(`flag:${o.flag}`);
    else if (typeof o.quest === 'string') out.push(`quest:${o.quest}`);
    else if (typeof o.scenario === 'string') out.push(`scenario:${o.scenario}`);
    else if (typeof o.scenarioLine === 'string') out.push(`scenarioLine:${o.scenarioLine}`);
  };
  const arr = Array.isArray(value) ? value : value ? [value] : [];
  arr.forEach(visit);
  return out;
}

// 返回 before 里出现、after 里缺失的叶子签名（按重数比对）。空数组 = 无丢失。
function droppedConditionLeaves(before: unknown, after: unknown): string[] {
  const counts = new Map<string, number>();
  for (const s of conditionLeafSignatures(after)) counts.set(s, (counts.get(s) ?? 0) + 1);
  const lost: string[] = [];
  for (const s of conditionLeafSignatures(before)) {
    const c = counts.get(s) ?? 0;
    if (c <= 0) lost.push(s);
    else counts.set(s, c - 1);
  }
  return [...new Set(lost)];
}
