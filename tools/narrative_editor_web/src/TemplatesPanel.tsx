import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  extractTemplateRemote,
  getQuestRemote,
  saveTemplatesRemote,
  stampTemplateRemote,
} from './bridge';
import type {
  AuthoringCatalogDef,
  NarrativeCompositionDef,
  NarrativeGraphsFileDef,
  NarrativeTemplateDef,
  ReferenceCatalogEntryDef,
  StampResponseDef,
  StampSummaryDef,
  TemplateParamDef,
  TemplateParamType,
} from './types';
import { ReferencePickerField } from './components/ReferencePickerModal';
import {
  countOccurrences,
  discoverParamCandidates,
  effectiveOverMatches,
  type ParamCandidate,
} from './templateParamDiscovery';

/** 危险操作两步确认按钮：第一次点变成红色「确认xx?」，再点才执行；失焦/超时自动复原。 */
function ConfirmButton(props: { label: string; confirmLabel: string; className?: string; disabled?: boolean; title?: string; onConfirm: () => void }) {
  const [arming, setArming] = useState(false);
  useEffect(() => {
    if (!arming) return;
    const t = setTimeout(() => setArming(false), 4000);
    return () => clearTimeout(t);
  }, [arming]);
  return (
    <button
      type="button"
      className={`${props.className ?? 'link-btn'}${arming ? ' danger confirm-arming' : ''}`}
      disabled={props.disabled}
      title={props.title}
      onBlur={() => setArming(false)}
      onClick={() => {
        if (!arming) { setArming(true); return; }
        setArming(false);
        props.onConfirm();
      }}
    >
      {arming ? props.confirmLabel : props.label}
    </button>
  );
}

const PARAM_TYPE_LABELS: Record<TemplateParamType, string> = {
  identifier: '自由标识符',
  text: '自由文案',
  number: '数字',
  boolean: '布尔',
  planeRef: '位面引用',
  dialogueRef: '对话图引用',
  minigameRef: '小游戏引用',
  sceneRef: '场景引用',
  npcRef: 'NPC 引用',
  hotspotRef: '热点引用',
  zoneRef: 'Zone 引用',
  questRef: '任务引用',
  cutsceneRef: '过场引用',
  scenarioRef: 'Scenario 引用',
};

const PARAM_TYPES = Object.keys(PARAM_TYPE_LABELS) as TemplateParamType[];

const REFERENCE_PARAM_KINDS: Partial<Record<TemplateParamType, string>> = {
  planeRef: 'plane',
  dialogueRef: 'dialogue',
  minigameRef: 'minigame',
  sceneRef: 'scene',
  npcRef: 'npc',
  hotspotRef: 'hotspot',
  zoneRef: 'zone',
  questRef: 'quest',
  cutsceneRef: 'cutscene',
  scenarioRef: 'scenario',
};

/** 批量盖章来源绑定兜底候选：老 Python host 的 catalog 没有 paramSources 时用
 * （权威 = tools/editor/shared/narrative_templates.PARAM_SOURCES，经 catalog 喂给网页）。 */
const FALLBACK_PARAM_SOURCES: Array<{ id: string; label: string }> = [
  { id: 'entity.id', label: '实体自身 id' },
  { id: 'entity.kind', label: '实体类型（npc / hotspot / zone）' },
  { id: 'entity.label', label: '实体显示名' },
  { id: 'scene.id', label: '实体所在场景 id' },
];

const PARAM_SOURCE_SHORT: Record<string, string> = {
  'entity.id': '实体id',
  'entity.kind': '实体类型',
  'entity.label': '实体名',
  'scene.id': '场景id',
};

/** 自动采用候选时给参数配的中文标签（盖章表单上显示的就是它）。 */
const CANDIDATE_LABELS: Record<string, string> = {
  'entity.id': '宿主实体 id',
  'entity.kind': '宿主实体类型',
  'entity.label': '显示名',
  'scene.id': '所在场景',
};

/** 参数的批量盖章来源绑定下拉：选实体推导后该参数不进盖章表单、由被盖实体逐个现推。 */
function ParamSourceSelect(props: {
  value?: string;
  catalog: AuthoringCatalogDef;
  onChange: (next?: string) => void;
}) {
  const { value, catalog, onChange } = props;
  const options = catalog.paramSources?.length ? catalog.paramSources : FALLBACK_PARAM_SOURCES;
  const known = options.find((o) => o.id === value);
  return (
    <select
      className="template-param-source"
      value={value ?? ''}
      title={known
        ? `批量盖章时由被盖实体现推：${known.label}`
        : value
          ? `未知来源「${value}」（校验器会报；不改选则原样保留）`
          : '批量盖章时的取值来源：手填 = 进表单；实体推导 = 场景编辑器多选盖章时逐实体自动填'}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">手填</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>推导:{PARAM_SOURCE_SHORT[o.id] ?? o.id}</option>
      ))}
      {value && !known ? <option value={value}>推导:{value}（未知）</option> : null}
    </select>
  );
}

function catalogOptionsFor(type: TemplateParamType, catalog: AuthoringCatalogDef): string[] {
  switch (type) {
    case 'planeRef': return catalog.planeIds ?? [];
    case 'dialogueRef': return catalog.dialogueGraphIds ?? [];
    case 'minigameRef': return catalog.minigameIds ?? [];
    case 'sceneRef': return catalog.sceneIds ?? [];
    case 'npcRef': return catalog.sceneNpcRefs ?? [];
    case 'hotspotRef': return catalog.sceneHotspotRefs ?? [];
    case 'zoneRef': return catalog.zoneRefs ?? [];
    case 'questRef': return catalog.questIds ?? [];
    case 'cutsceneRef': return catalog.cutsceneIds ?? [];
    case 'scenarioRef': return catalog.scenarioIds ?? [];
    default: return [];
  }
}

/** Popup rows preserve every exact legacy catalog value (qualified and bare
 * entity ids can both be meaningful template samples) while borrowing richer
 * labels from the host catalog when available. */
export function templateReferenceEntries(
  type: TemplateParamType,
  catalog: AuthoringCatalogDef,
): ReferenceCatalogEntryDef[] {
  const kind = REFERENCE_PARAM_KINDS[type];
  if (!kind) return [];
  const rich = (catalog.referenceEntries ?? []).filter((entry) => entry.kind === kind);
  const seen = new Set<string>();
  const rows: ReferenceCatalogEntryDef[] = [];
  for (const raw of catalogOptionsFor(type, catalog)) {
    const value = String(raw ?? '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const match = rich.find((entry) => (
      entry.id === value
      || entry.qualifiedId === value
      || (entry.aliases ?? []).includes(value)
    ));
    rows.push({
      kind,
      id: value,
      qualifiedId: value,
      label: match?.label || value,
      aliases: match?.aliases,
    });
  }
  return rows;
}

export function dialogueStubIdError(value: string): string {
  const id = value.trim();
  if (!id) return '请输入新对话图 id';
  if (id.startsWith('.') || id.includes('..') || /[\\/]/.test(id)) {
    return 'id 不能含 /、\\、..，也不能以 . 开头';
  }
  return '';
}

function defaultValueFor(param: TemplateParamDef): unknown {
  if (param.default !== undefined && param.default !== null && param.default !== '') return param.default;
  if (param.type === 'boolean') return false;
  if (param.type === 'number') return 0;
  return '';
}

/** 一个盖章输入控件：按参数类型渲染带类型的选择器 / 输入框（禁裸手打引用）。 */
export function ParamField(props: {
  param: TemplateParamDef;
  value: unknown;
  catalog: AuthoringCatalogDef;
  onChange: (v: unknown) => void;
}) {
  const { param, value, catalog, onChange } = props;
  const label = param.label || param.name;
  const [creatingDialogueStub, setCreatingDialogueStub] = useState(false);
  const [newDialogueId, setNewDialogueId] = useState('');
  const dialogueIdError = dialogueStubIdError(newDialogueId);

  if (REFERENCE_PARAM_KINDS[param.type]) {
    const entries = templateReferenceEntries(param.type, catalog);
    return (
      <div className="template-reference-param">
        <ReferencePickerField
          label={`${label}${param.required ? ' *' : ''} · ${PARAM_TYPE_LABELS[param.type]}`}
          value={String(value ?? '')}
          entries={entries}
          onChange={onChange}
        />
        {param.type === 'dialogueRef' ? (
          <div className="template-dialogue-stub-flow">
            {!creatingDialogueStub ? (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setNewDialogueId('');
                  setCreatingDialogueStub(true);
                }}
              >
                + 新建对话桩引用…
              </button>
            ) : (
              <div className="template-dialogue-stub-create" role="group" aria-label="新建对话桩引用">
                <input
                  autoFocus
                  value={newDialogueId}
                  onChange={(event) => setNewDialogueId(event.target.value)}
                  placeholder="新对话图 id（定义新资源）"
                />
                <button
                  type="button"
                  disabled={Boolean(dialogueIdError)}
                  onClick={() => {
                    onChange(newDialogueId.trim());
                    setCreatingDialogueStub(false);
                  }}
                >
                  使用此新 ID
                </button>
                <button type="button" className="secondary" onClick={() => setCreatingDialogueStub(false)}>取消</button>
                {dialogueIdError && newDialogueId ? <span className="template-preview-error">{dialogueIdError}</span> : null}
              </div>
            )}
            <span className="muted">这里只定义新资源 id；盖章时勾选“生成空白桩”才会一并暂存。</span>
          </div>
        ) : null}
        {param.note && <div className="muted template-param-note">{param.note}</div>}
      </div>
    );
  }

  let control: ReactNode;
  if (param.type === 'boolean') {
    control = (
      <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
    );
  } else if (param.type === 'number') {
    control = (
      <input
        type="number"
        value={value === '' || value === undefined ? '' : Number(value)}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    );
  } else {
    control = (
      <input value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={param.type === 'identifier' ? '字母/数字/下划线/中文，首字符非数字' : ''} />
    );
  }

  return (
    <div className="field template-param-field">
      <label title={param.note}>
        {label}
        {param.required && <span className="template-req"> *</span>}
        <span className="template-param-type">{PARAM_TYPE_LABELS[param.type]}</span>
      </label>
      {control}
      {param.note && <div className="muted template-param-note">{param.note}</div>}
    </div>
  );
}

/** 盖章表单：为选中模板填参数，实时 dryRun 预览生成结果，确认后落地。 */
function StampForm(props: {
  template: NarrativeTemplateDef;
  catalog: AuthoringCatalogDef;
  currentNarrative: NarrativeGraphsFileDef;
  onStamped: (narrative: NarrativeGraphsFileDef, summary: StampSummaryDef) => void;
  onBack: () => void;
}) {
  const { template, catalog, currentNarrative, onStamped, onBack } = props;
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const p of template.params) init[p.name] = defaultValueFor(p);
    return init;
  });
  const [genStubs, setGenStubs] = useState(true);
  const [preview, setPreview] = useState<StampResponseDef | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 带 from 绑定的参数在场景编辑器批量盖章时由实体现推；单张盖章这里也别让人手抄——
  // 选一次宿主实体，把 ownerId / 类型 / 显示名一次填满（推导语义的权威在
  // shared/narrative_template_batch.entity_derived_values，令牌名由 catalog.paramSources 对账）。
  const boundParams = template.params.filter((p) => p.from);
  const [entityRef, setEntityRef] = useState('');
  const entityEntries = useMemo(
    () => (catalog.referenceEntries ?? []).filter(
      (entry) => entry.kind === 'npc' || entry.kind === 'hotspot' || entry.kind === 'zone',
    ),
    [catalog.referenceEntries],
  );
  const applyEntity = (picked: string) => {
    setEntityRef(picked);
    const entry = entityEntries.find((e) => e.id === picked || e.qualifiedId === picked);
    if (!entry) return;
    const qualified = String(entry.qualifiedId ?? '');
    const derived: Record<string, string> = {
      'entity.id': entry.id,
      'entity.kind': entry.kind,
      'entity.label': entry.label || entry.id,
      'scene.id': qualified.includes(':') ? qualified.slice(0, qualified.indexOf(':')) : '',
    };
    setValues((prev) => {
      const next = { ...prev };
      for (const p of template.params) {
        if (p.from && derived[p.from] !== undefined) next[p.name] = derived[p.from];
      }
      return next;
    });
  };

  const runPreview = useCallback(async () => {
    setPreviewing(true);
    const res = await stampTemplateRemote({
      templateId: template.id,
      values,
      currentNarrative,
      generateDialogueStubs: genStubs,
      dryRun: true,
    });
    setPreview(res);
    setPreviewing(false);
  }, [template.id, values, genStubs, currentNarrative]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runPreview(), 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [runPreview]);

  const canStamp = Boolean(preview?.ok) && !busy;

  const doStamp = async () => {
    setBusy(true);
    setStatus('盖章中…');
    const res = await stampTemplateRemote({
      templateId: template.id,
      values,
      currentNarrative,
      generateDialogueStubs: genStubs,
      dryRun: false,
    });
    setBusy(false);
    if (!res.ok || !res.narrative || !res.summary) {
      setStatus(`失败：${res.reason ?? '未知错误'}`);
      return;
    }
    onStamped(res.narrative, res.summary);
    setStatus(`已生成作曲「${res.summary.compositionId}」`);
  };

  const p = preview?.preview;

  return (
    <div className="template-stamp">
      <div className="template-stamp-head">
        <button type="button" className="link-btn" onClick={onBack}>← 返回模板列表</button>
        <b>盖章：{template.label || template.id}</b>
      </div>
      {template.description && <div className="muted template-desc">{template.description}</div>}

      {boundParams.length > 0 && (
        <div className="template-entity-bind">
          <ReferencePickerField
            label="宿主实体（选一次，下面的推导参数一起填好）"
            value={entityRef}
            entries={entityEntries}
            onChange={(v) => applyEntity(String(v ?? ''))}
          />
          <div className="muted">
            由它推导：{boundParams.map((p) => p.label || p.name).join('、')}
            {entityEntries.length === 0 ? '（当前目录没有可选实体，仍可在下方手填）' : ''}
          </div>
        </div>
      )}

      <div className="template-params">
        {template.params.map((param) => (
          <ParamField
            key={param.name}
            param={param.from
              ? { ...param, note: `由宿主实体推导（${PARAM_SOURCE_SHORT[param.from] ?? param.from}）；也可手改` }
              : param}
            value={values[param.name]}
            catalog={catalog}
            onChange={(v) => setValues((prev) => ({ ...prev, [param.name]: v }))}
          />
        ))}
      </div>

      <label className="toggle compact-toggle">
        <input type="checkbox" checked={genStubs} onChange={(e) => setGenStubs(e.target.checked)} />
        为缺失的对话图生成空白桩（烘进对应 emit 动作）
      </label>

      <div className={`template-preview ${preview && !preview.ok ? 'has-error' : ''}`}>
        <div className="template-preview-head">
          预览 {previewing && <span className="muted">（计算中…）</span>}
        </div>
        {!preview ? (
          <div className="muted">填写参数后自动预览。</div>
        ) : !preview.ok ? (
          <div className="template-preview-error">⛔ {preview.reason}</div>
        ) : p ? (
          <div className="template-preview-body">
            <div className="template-preview-row"><span>新作曲</span><code>{p.compositionId}</code></div>
            {p.questId && <div className="template-preview-row"><span>镜像任务</span><code>{p.questId}</code></div>}
            <div className="template-preview-row"><span>信号</span><span>{p.signals.map((s) => <code key={s} className="template-sig">{s}</code>)}</span></div>
            {p.dialogueStubs.length > 0 && (
              <div className="template-preview-row">
                <span>对话图</span>
                <span>
                  {p.dialogueStubs.map((st) => (
                    <span key={st.id} className={`template-stub ${st.exists ? 'exists' : 'new'}`} title={`emit ${st.emitSignal}`}>
                      {st.exists ? '已有 ' : (genStubs ? '新建 ' : '缺失 ')}{st.id}
                    </span>
                  ))}
                </span>
              </div>
            )}
            {p.warnings.length > 0 && (
              <details className="template-preview-warnings">
                <summary>⚠️ 提示 {p.warnings.length}</summary>
                {p.warnings.map((w, i) => <div key={i} className="muted">· {w.message}</div>)}
              </details>
            )}
            {p.requiredEntities.length > 0 && (
              <details className="template-preview-required">
                <summary>还需在场景里手动放置 {p.requiredEntities.length} 项</summary>
                {p.requiredEntities.map((r, i) => (
                  <div key={i} className="muted">· {r.kind ? `[${r.kind}] ` : ''}{r.note}</div>
                ))}
              </details>
            )}
          </div>
        ) : null}
      </div>

      <div className="template-stamp-actions">
        <button type="button" className="primary-btn" disabled={!canStamp} onClick={() => void doStamp()}>
          生成任务
        </button>
        {status && <span className="muted">{status}</span>}
      </div>
      <div className="muted template-fine">
        全有全无：确认后作曲+信号、镜像任务、对话桩<b>一并暂存</b>（此刻不写盘），主编辑器 <b>Save All</b> 一次性落盘全部；放弃/关闭不保存则三样都不存在。
      </div>
    </div>
  );
}

/** 单个模板的元数据 + 参数编辑（增删改），以及「用当前作曲重建骨架」。 */
function TemplateEditor(props: {
  template: NarrativeTemplateDef;
  catalog: AuthoringCatalogDef;
  currentComposition?: NarrativeCompositionDef;
  onChange: (next: NarrativeTemplateDef) => void;
  onDelete: () => void;
  onRebuildFromComposition: () => void;
}) {
  const { template, catalog, currentComposition, onChange, onDelete, onRebuildFromComposition } = props;

  const setParam = (i: number, patch: Partial<TemplateParamDef>) => {
    const params = template.params.map((p, idx) => (idx === i ? { ...p, ...patch } : p));
    onChange({ ...template, params });
  };
  const moveParam = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= template.params.length) return;
    const params = [...template.params];
    [params[i], params[j]] = [params[j], params[i]];
    onChange({ ...template, params });
  };
  const addParam = () => {
    onChange({ ...template, params: [...template.params, { name: `param${template.params.length + 1}`, type: 'text' }] });
  };
  const delParam = (i: number) => {
    onChange({ ...template, params: template.params.filter((_, idx) => idx !== i) });
  };

  return (
    <div className="template-editor">
      <div className="field">
        <label>显示名</label>
        <input value={template.label ?? ''} onChange={(e) => onChange({ ...template, label: e.target.value })} />
      </div>
      <div className="field">
        <label>说明</label>
        <textarea rows={2} value={template.description ?? ''} onChange={(e) => onChange({ ...template, description: e.target.value })} />
      </div>

      <div className="template-params-editor">
        <div className="template-params-editor-head">
          <span>参数（{template.params.length}）</span>
          <button type="button" className="link-btn" onClick={addParam}>+ 参数</button>
        </div>
        {template.params.map((param, i) => (
          <div key={i} className="template-param-row">
            <input className="template-param-name" value={param.name} placeholder="参数名（中文/字母/数字/下划线）" onChange={(e) => setParam(i, { name: e.target.value })} />
            <select value={param.type} onChange={(e) => setParam(i, { type: e.target.value as TemplateParamType })}>
              {PARAM_TYPES.map((t) => <option key={t} value={t}>{PARAM_TYPE_LABELS[t]}</option>)}
            </select>
            <input className="template-param-label" value={param.label ?? ''} placeholder="标签" onChange={(e) => setParam(i, { label: e.target.value })} />
            {param.type === 'boolean' ? (
              <label className="toggle compact-toggle" title="默认值">
                <input type="checkbox" checked={Boolean(param.default)} onChange={(e) => setParam(i, { default: e.target.checked })} />默
              </label>
            ) : param.type === 'number' ? (
              <input
                className="template-param-default"
                type="number"
                value={param.default === undefined || param.default === '' ? '' : Number(param.default)}
                placeholder="默认"
                onChange={(e) => setParam(i, { default: e.target.value === '' ? undefined : Number(e.target.value) })}
              />
            ) : REFERENCE_PARAM_KINDS[param.type] ? (
              <ParamField
                param={{ ...param, label: '默认引用', required: false, note: undefined }}
                value={param.default ?? ''}
                catalog={catalog}
                onChange={(value) => setParam(i, { default: value === '' ? undefined : value })}
              />
            ) : (
              <input className="template-param-default" value={param.default === undefined ? '' : String(param.default)} placeholder="默认" onChange={(e) => setParam(i, { default: e.target.value })} />
            )}
            <ParamSourceSelect value={param.from} catalog={catalog} onChange={(next) => setParam(i, { from: next })} />
            <label className="toggle compact-toggle" title="必填">
              <input type="checkbox" checked={Boolean(param.required)} onChange={(e) => setParam(i, { required: e.target.checked })} />必
            </label>
            <button type="button" className="icon-btn" title="上移" onClick={() => moveParam(i, -1)}>↑</button>
            <button type="button" className="icon-btn" title="下移" onClick={() => moveParam(i, 1)}>↓</button>
            <button type="button" className="icon-btn danger" title="删除" onClick={() => delParam(i)}>✕</button>
          </div>
        ))}
      </div>

      <details className="template-skeleton">
        <summary>骨架 JSON（只读预览）</summary>
        <pre className="template-skeleton-json">{JSON.stringify(template.composition, null, 2)}</pre>
      </details>

      <div className="template-editor-actions">
        <ConfirmButton
          label="用当前作曲重建骨架"
          confirmLabel="⚠️ 确认覆盖骨架？（{{洞}}会被真值覆盖，不可撤销）"
          disabled={!currentComposition}
          title={currentComposition ? '把当前打开的作曲原样写入骨架——注意：不做参数化，原骨架的 {{洞}} 会全部被真值覆盖' : '先在画布选中一张作曲'}
          onConfirm={onRebuildFromComposition}
        />
        <ConfirmButton label="删除模板" confirmLabel="⚠️ 确认删除？（不可撤销）" className="link-btn danger" onConfirm={onDelete} />
      </div>
    </div>
  );
}

/** 从当前打开的作曲反抽出一个新模板：为每个参数指定「样值」→ 抽取时替换成 {{name}}。 */
function CreateFromCompositionForm(props: {
  composition: NarrativeCompositionDef;
  signals: NarrativeGraphsFileDef['signals'];
  catalog: AuthoringCatalogDef;
  /** 已有模板 id 集：新建撞名直接禁止（创建永不覆盖）。 */
  existingIds: string[];
  onCreated: (tpl: NarrativeTemplateDef) => void;
  onCancel: () => void;
}) {
  const { composition, signals, catalog, existingIds, onCreated, onCancel } = props;
  const [templateId, setTemplateId] = useState(`${composition.id}_archetype`);
  const idTaken = existingIds.includes(templateId.trim());
  const [label, setLabel] = useState(composition.label ?? '');
  const [description, setDescription] = useState('');
  // 自动发现：整值引用按出处定类型，命名串公共 token 即实例 id——样值全部预填，不必手抄。
  const candidates = useMemo(
    () => discoverParamCandidates(composition, catalog, signals),
    [composition, catalog, signals],
  );
  const blob = useMemo(() => JSON.stringify(composition), [composition]);
  const [params, setParams] = useState<TemplateParamDef[]>(() => {
    // 默认采用**全部实体推导候选**（ownerId + ownerType + 显示名），不是只有第一条：
    // 少采 ownerType 就会把字面 'hotspot' 焊进产物，盖到 npc/zone 上是运行时死机器
    // （ok=True 零提示，策划验收 B-4）。
    // entity.id 例外:**永远采用,哪怕会误伤**——它是模板唯一必需的洞,漏掉它整张模板会
    // 静默退化成「每个实体盖出同一份」(比误伤更坏且更难发现)。误伤由下方红条挡住创建,
    // 让人去改名或换样值。其余绑定(类型/显示名)是锦上添花,会误伤就不自动采。
    // **同一个来源只采一个**：两条都绑 entity.id 时批量盖章会把它们填成同一个实体，
    // 一个实体身上挂出两张 wrapper（owner 索引歧义），ok=True 零提示。
    const bySource = new Map<string, ParamCandidate>();
    for (const cand of candidates) {
      const src = cand.suggestedFrom;
      if (!src || bySource.has(src)) continue;
      bySource.set(src, cand);
    }
    // 误伤判定要拿**这一组样值**一起算：更长的样值先替换、会把它罩住的 id 提前挖成洞，
    // 只看单条候选自带的名单会把「藏钱 之于 主线s1藏钱点A」这种假阳性当真，
    // 于是显示名参数被白白跳过（N 个实例在画布上仍然全同名）。
    const tentativeSamples = [...bySource.values()].map((c) => c.sample);
    const auto = [...bySource.values()].filter((cand) => {
      // entity.id 恒采用：它是模板唯一必需的洞，漏了整张模板静默退化成「每个实体盖出同一份」。
      if (cand.suggestedFrom === 'entity.id') return true;
      return effectiveOverMatches(cand.sample, cand.overMatches ?? [], tentativeSamples).length === 0;
    });
    const fallbackToken = candidates.find((c) => c.kind === 'token' && !c.suggestedFrom);
    const picked = auto.length ? auto : (fallbackToken ? [fallbackToken] : []);
    if (!picked.length) {
      return [{ name: 'taskId', type: 'identifier', label: '任务ID', required: true, sample: '' }];
    }
    return picked.map((cand) => ({
      name: cand.suggestedName,
      type: cand.type,
      label: CANDIDATE_LABELS[cand.suggestedFrom ?? ''] ?? '任务ID',
      // 实体推导参数一律必填：允许空值 = 盖出 ownerType 为空的图，运行时那张图**不进 owner 索引**
      // （NarrativeStateManager.ownerKey 空串直接 return），私有信号一条都投不进来。
      required: cand.kind === 'token' || Boolean(cand.suggestedFrom),
      sample: cand.sample,
      ...(cand.suggestedFrom ? { from: cand.suggestedFrom } : {}),
    }));
  });
  const unusedCandidates = candidates.filter(
    (cand) => !params.some((p) => (p.sample ?? '').trim() === cand.sample),
  );
  const adoptCandidate = (cand: ParamCandidate) => {
    setParams((prev) => {
      const used = new Set(prev.map((p) => p.name));
      let name = cand.suggestedName;
      for (let i = 2; used.has(name); i += 1) name = `${cand.suggestedName}${i}`;
      return [...prev, {
        name,
        type: cand.type,
        label: CANDIDATE_LABELS[cand.suggestedFrom ?? ''],
        required: cand.kind === 'token' || Boolean(cand.suggestedFrom),
        sample: cand.sample,
        ...(cand.suggestedFrom ? { from: cand.suggestedFrom } : {}),
      }];
    });
  };
  // 样值会连带改坏别的已登记 id（箱子1 之于 箱子11）——抽取是整树子串替换，静默且不可见。
  // 按**当前这组参数**重算：更长的样值先替换，会把它罩住的那些 id 提前挖成洞（假阳性剔除）。
  const allSamples = params.map((p) => (p.sample ?? '').trim()).filter(Boolean);
  const overMatchRows = params
    .map((p) => {
      const sampleText = (p.sample ?? '').trim();
      const raw = candidates.find((c) => c.sample === sampleText)?.overMatches ?? [];
      return { param: p, hits: effectiveOverMatches(sampleText, raw, allSamples) };
    })
    .filter((row) => row.hits.length > 0);
  // 零洞参数 = 样值在图里一处都命不中，抽出来必是死参数（「藏钱事件」事故的形状）——挡在创建前。
  const deadParams = params.filter((p) => {
    const sampleText = (p.sample ?? '').trim();
    return !sampleText || countOccurrences(blob, sampleText) === 0;
  });
  const [includeQuestId, setIncludeQuestId] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const setParam = (i: number, patch: Partial<TemplateParamDef>) => {
    setParams((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  };

  const doExtract = async () => {
    setBusy(true);
    setStatus('抽取中…');
    // 从作曲的 dialogueBlackbox 元件自动派生对话桩规格（emit = 元件 meta.emits[0]）。
    const stubs: { id: string; title: string; emitSignal: string }[] = [];
    for (const el of composition.elements ?? []) {
      if (el.kind === 'dialogueBlackbox' && el.refId) {
        const emit = Array.isArray(el.meta?.emits) ? String(el.meta?.emits?.[0] ?? '') : '';
        stubs.push({ id: el.refId, title: el.label ?? el.refId, emitSignal: emit });
      }
    }
    // 只带上作曲实际监听/发出的信号。
    const usedSignals = new Set<string>();
    for (const tr of composition.mainGraph?.transitions ?? []) if (tr.signal) usedSignals.add(tr.signal);
    for (const el of composition.elements ?? []) for (const s of el.meta?.emits ?? []) usedSignals.add(String(s));
    const compSignals = (signals ?? []).filter((s) => usedSignals.has(s.id));

    let quest: Record<string, unknown> | undefined;
    if (includeQuestId.trim()) {
      const qr = await getQuestRemote(includeQuestId.trim());
      if (qr.ok && qr.quest) quest = qr.quest;
      else { setBusy(false); setStatus(`任务读取失败：${qr.reason}`); return; }
    }

    const res = await extractTemplateRemote({
      composition,
      params,
      templateId: templateId.trim(),
      label,
      description,
      signals: compSignals,
      quest,
      dialogueStubs: stubs.length ? stubs : undefined,
    });
    setBusy(false);
    if (!res.ok || !res.template) { setStatus(`失败：${res.reason}`); return; }
    // 引擎校验有话说（如长短样值互相吞洞导致 param.unused）就不创建——带病模板存下去只会在盖章时炸。
    if (res.issues && res.issues.length > 0) {
      setStatus(`未创建——引擎校验：${res.issues.map((issue) => issue.message).join('；')}`);
      return;
    }
    onCreated(res.template);
  };

  return (
    <div className="template-create">
      <div className="template-stamp-head">
        <button type="button" className="link-btn" onClick={onCancel}>← 取消</button>
        <b>从作曲「{composition.label || composition.id}」创建模板</b>
      </div>
      <div className="muted">给每个参数填「样值」——它在这张作曲里出现的真值；抽取时会被换成 {'{{name}}'} 洞。</div>
      <div className="field">
        <label>模板 id（新建，不可与已有模板重名）</label>
        <input value={templateId} onChange={(e) => setTemplateId(e.target.value)} />
        {idTaken && <div className="template-preview-error">⛔ 模板「{templateId.trim()}」已存在——创建不允许覆盖，请换个 id（要改它请回列表点「编辑」）</div>}
      </div>
      <div className="field"><label>显示名</label><input value={label} onChange={(e) => setLabel(e.target.value)} /></div>
      <div className="field"><label>说明</label><input value={description} onChange={(e) => setDescription(e.target.value)} /></div>

      <div className="template-params-editor">
        <div className="template-params-editor-head">
          <span>参数 + 样值（{params.length}）</span>
          <button type="button" className="link-btn" onClick={() => setParams((p) => [...p, { name: `param${p.length + 1}`, type: 'text', sample: '' }])}>+ 参数</button>
        </div>
        {params.map((param, i) => {
          const sampleText = (param.sample ?? '').trim();
          const holes = sampleText ? countOccurrences(blob, sampleText) : 0;
          return (
          <div key={i} className="template-param-row">
            <input className="template-param-name" value={param.name} placeholder="参数名（中文/字母/数字/下划线）" onChange={(e) => setParam(i, { name: e.target.value })} />
            <select value={param.type} onChange={(e) => setParam(i, { type: e.target.value as TemplateParamType })}>
              {PARAM_TYPES.map((t) => <option key={t} value={t}>{PARAM_TYPE_LABELS[t]}</option>)}
            </select>
            {REFERENCE_PARAM_KINDS[param.type] ? (
              <ParamField
                param={{ ...param, label: '样值（作曲里的真值）', required: false, note: undefined }}
                value={param.sample ?? ''}
                catalog={catalog}
                onChange={(value) => setParam(i, { sample: String(value ?? '') })}
              />
            ) : (
              <input className="template-param-sample" value={param.sample ?? ''} placeholder="样值（作曲里的真值）" onChange={(e) => setParam(i, { sample: e.target.value })} />
            )}
            <span
              className={`template-hole-count${holes > 0 ? '' : ' zero'}`}
              title={holes > 0
                ? `样值在图里命中 ${holes} 处 = 抽取挖 ${holes} 个洞`
                : '样值在图里一处都没命中——抽出来是死参数（零洞）；修样值或删掉本参数'}
            >
              {sampleText ? `${holes}处` : '缺样值'}
            </span>
            <ParamSourceSelect value={param.from} catalog={catalog} onChange={(next) => setParam(i, { from: next })} />
            <label className="toggle compact-toggle" title="必填"><input type="checkbox" checked={Boolean(param.required)} onChange={(e) => setParam(i, { required: e.target.checked })} />必</label>
            <button type="button" className="icon-btn danger" title="删除" onClick={() => setParams((p) => p.filter((_, idx) => idx !== i))}>✕</button>
          </div>
          );
        })}
      </div>

      {unusedCandidates.length > 0 && (
        <div className="template-candidates">
          <div className="template-candidates-head">从图里检测到的候选参数（样值已填好，点「采用」即入参）</div>
          {unusedCandidates.map((cand) => {
            // 没被自动采用的原因要写在脸上：否则策划只看到「少了个显示名参数」，
            // 不知道是工具替他躲开了一次静默改坏（藏钱 会把信号 藏钱_取走 一起挖了）。
            const risky = effectiveOverMatches(cand.sample, cand.overMatches ?? [], allSamples);
            return (
              <div key={`${cand.kind}:${cand.sample}`} className="template-candidate-row" title={`出处：${cand.provenance}`}>
                <button type="button" className="link-btn" onClick={() => adoptCandidate(cand)}>+ 采用</button>
                <code className="template-candidate-sample">{cand.sample}</code>
                <span className="muted">
                  {PARAM_TYPE_LABELS[cand.type]} · {cand.occurrences} 处
                  {cand.kind === 'token' ? ' · 实例id形状' : ''}
                  {cand.suggestedFrom ? ` · 建议绑定 ${PARAM_SOURCE_SHORT[cand.suggestedFrom] ?? cand.suggestedFrom}` : ''}
                </span>
                {risky.length > 0 && (
                  <span className="template-candidate-risk">
                    ⚠ 没自动采用：会把 {risky.join('、')} 一起挖成洞（盖章时被改名）
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="field">
        <ReferencePickerField
          label="一并参数化的镜像任务（可选）"
          value={includeQuestId}
          entries={templateReferenceEntries('questRef', catalog)}
          onChange={setIncludeQuestId}
        />
      </div>

      {deadParams.length > 0 && (
        <div className="template-preview-error">
          ⛔ 参数 {deadParams.map((p) => `「${p.name}」`).join('')} 的样值在图里挖不到洞——修样值或删掉再创建
        </div>
      )}
      {overMatchRows.map(({ param, hits }) => (
        <div key={`om:${param.name}`} className="template-preview-error">
          ⛔ 参数「{param.name}」的样值 <code>{param.sample}</code> 嵌在这些 id 里：{hits.join('、')}
          ——抽取是整串替换，这些 id 会被一起挖成洞、盖章时替换成别的实体名（引用就断了，而且不报错）。
          去场景里把撞名的实体改成不互相包含的 id，或删掉本参数改用别的样值。
        </div>
      ))}
      <div className="template-stamp-actions">
        <button
          type="button"
          className="primary-btn"
          disabled={busy || !templateId.trim() || idTaken || deadParams.length > 0 || overMatchRows.length > 0}
          title={
            deadParams.length > 0 ? '有零洞参数（见上方红条）'
              : overMatchRows.length > 0 ? '有样值会连带改坏别的 id（见上方红条）'
                : undefined
          }
          onClick={() => void doExtract()}
        >创建模板</button>
        {status && <span className="muted">{status}</span>}
      </div>
    </div>
  );
}

export function TemplatesPanel(props: {
  templates: NarrativeTemplateDef[];
  catalog: AuthoringCatalogDef;
  currentComposition?: NarrativeCompositionDef;
  currentNarrative: NarrativeGraphsFileDef;
  onTemplatesChange: (templates: NarrativeTemplateDef[]) => void;
  onStamped: (narrative: NarrativeGraphsFileDef, summary: StampSummaryDef) => void;
  onClose: () => void;
}) {
  const { templates, catalog, currentComposition, currentNarrative, onTemplatesChange, onStamped } = props;
  const [mode, setMode] = useState<'list' | 'stamp' | 'edit' | 'create'>('list');
  const [activeId, setActiveId] = useState('');
  const [saveStatus, setSaveStatus] = useState('');

  const active = useMemo(() => templates.find((t) => t.id === activeId), [templates, activeId]);

  // 站在母图上抽模板 = 把兄弟 wrapper 一起打包（它们各绑各的实体，盖章却会被填成同一个）。
  // lift 只救「你正站在子图里」这一种，剩下这种得当场说清楚，别让人盖出错数据。
  const mainGraphWithEntitySubgraphs = useMemo(() => {
    const entityKinds = new Set(['npc', 'hotspot', 'zone']);
    const owned = (currentComposition?.elements ?? []).filter(
      (el) => el.graph && entityKinds.has(String(el.ownerType ?? el.graph?.ownerType ?? '')),
    );
    return owned.length > 0 ? owned.length : 0;
  }, [currentComposition]);

  const persist = useCallback(async (next: NarrativeTemplateDef[]) => {
    // 先存宿主、成功了才改本地：反过来的话保存一失败，React 里就留着那份坏模板，
    // 之后**每一次**保存都带着它整表提交、次次失败，连「只改个显示名」都存不进去，
    // 出口只剩删模板或重开页面。
    const res = await saveTemplatesRemote({ schemaVersion: 1, templates: next });
    if (res.ok) onTemplatesChange(next);
    if (!res.ok) {
      setSaveStatus(`未保存（本地也已回退，可继续改）：${res.reason ?? ''}`);
    } else if (res.warnings?.length) {
      // 存下了但有隐患（如参数没挖到洞）：必须当场说，否则要等盖章才炸。
      setSaveStatus(`已保存模板，但有 ${res.warnings.length} 条提醒：${res.warnings.map((w) => w.message).join('；')}`);
    } else {
      setSaveStatus('已保存模板');
    }
  }, [onTemplatesChange]);

  const upsertTemplate = useCallback((tpl: NarrativeTemplateDef) => {
    const exists = templates.some((t) => t.id === tpl.id);
    const next = exists ? templates.map((t) => (t.id === tpl.id ? tpl : t)) : [...templates, tpl];
    void persist(next);
  }, [templates, persist]);

  const deleteTemplate = useCallback((id: string) => {
    void persist(templates.filter((t) => t.id !== id));
    if (activeId === id) { setActiveId(''); setMode('list'); }
  }, [templates, persist, activeId]);

  if (mode === 'stamp' && active) {
    return (
      <div className="entity-view">
        <StampForm
          template={active}
          catalog={catalog}
          currentNarrative={currentNarrative}
          onStamped={props.onStamped}
          onBack={() => setMode('list')}
        />
      </div>
    );
  }

  if (mode === 'create' && currentComposition) {
    return (
      <div className="entity-view">
        <CreateFromCompositionForm
          composition={currentComposition}
          signals={currentNarrative.signals}
          catalog={catalog}
          existingIds={templates.map((t) => t.id)}
          onCreated={(tpl) => { upsertTemplate(tpl); setActiveId(tpl.id); setMode('edit'); }}
          onCancel={() => setMode('list')}
        />
      </div>
    );
  }

  if (mode === 'edit' && active) {
    return (
      <div className="entity-view">
        <div className="template-stamp-head">
          <button type="button" className="link-btn" onClick={() => setMode('list')}>← 返回列表</button>
          <b>编辑模板：{active.id}</b>
        </div>
        <TemplateEditor
          template={active}
          catalog={catalog}
          currentComposition={currentComposition}
          onChange={upsertTemplate}
          onDelete={() => deleteTemplate(active.id)}
          onRebuildFromComposition={() => {
            if (!currentComposition) return;
            upsertTemplate({ ...active, composition: currentComposition });
          }}
        />
        {saveStatus && <div className="muted template-save-status">{saveStatus}</div>}
      </div>
    );
  }

  // 列表
  return (
    <div className="entity-view">
      <div className="property-summary">
        <b>叙事状态机模板</b>
        <div className="muted">填 taskId 一键派生新任务（作曲 + 镜像任务 + 信号 + 可选对话桩），信号天然不撞名。</div>
      </div>
      <div className="template-list-actions">
        <button
          type="button"
          className="link-btn"
          disabled={!currentComposition}
          title={currentComposition ? '从画布当前作曲反抽模板' : '先在画布选中一张作曲'}
          onClick={() => setMode('create')}
        >
          + 从当前作曲创建模板
        </button>
      </div>
      {mainGraphWithEntitySubgraphs && (
        <div className="muted template-scope-hint">
          ⚠ 你现在在母图上。这里抽出来的模板会把{mainGraphWithEntitySubgraphs} 个绑实体的子图**一起**打包进去，
          盖章时它们会被填成同一个实体。要做「一实体一台机器」的模板，请先双击进入那张子图再来抽。
        </div>
      )}
      {saveStatus && <div className="muted template-save-status">{saveStatus}</div>}
      <div className="entity-wrapper-list">
        {templates.length === 0 ? (
          <div className="muted">还没有模板。选中一张作曲后「从当前作曲创建模板」。</div>
        ) : (
          templates.map((tpl) => (
            <div key={tpl.id} className="template-card">
              <div className="template-card-head">
                <div className="template-card-title">
                  <b>{tpl.label || tpl.id}</b>
                  <code className="template-card-id">{tpl.id}</code>
                </div>
                <div className="template-card-meta muted">{tpl.params.length} 参数{tpl.quest ? ' · 带任务' : ''}{tpl.dialogueStubs?.length ? ` · ${tpl.dialogueStubs.length} 对话桩` : ''}</div>
              </div>
              {tpl.description && <div className="muted template-card-desc">{tpl.description}</div>}
              <div className="template-card-actions">
                <button type="button" className="primary-btn" onClick={() => { setActiveId(tpl.id); setMode('stamp'); }}>🔨 盖章生成</button>
                <button type="button" className="link-btn" onClick={() => { setActiveId(tpl.id); setMode('edit'); }}>编辑</button>
                <ConfirmButton label="删除" confirmLabel="⚠️ 确认删除？" className="link-btn danger" onConfirm={() => deleteTemplate(tpl.id)} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
