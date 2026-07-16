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
  StampResponseDef,
  StampSummaryDef,
  TemplateParamDef,
  TemplateParamType,
} from './types';

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

// 强制走严格 <select>（引用他者必须存在）；dialogueRef 例外——允许输入新 id 以生成空白桩。
const STRICT_SELECT_TYPES = new Set<TemplateParamType>([
  'planeRef', 'minigameRef', 'sceneRef', 'npcRef', 'hotspotRef', 'zoneRef', 'questRef', 'cutsceneRef', 'scenarioRef',
]);

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

function defaultValueFor(param: TemplateParamDef): unknown {
  if (param.default !== undefined && param.default !== null && param.default !== '') return param.default;
  if (param.type === 'boolean') return false;
  if (param.type === 'number') return 0;
  return '';
}

/** 一个盖章输入控件：按参数类型渲染带类型的选择器 / 输入框（禁裸手打引用）。 */
function ParamField(props: {
  param: TemplateParamDef;
  value: unknown;
  catalog: AuthoringCatalogDef;
  onChange: (v: unknown) => void;
}) {
  const { param, value, catalog, onChange } = props;
  const listId = `tpl-opts-${param.name}`;
  const label = param.label || param.name;

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
  } else if (STRICT_SELECT_TYPES.has(param.type)) {
    const opts = catalogOptionsFor(param.type, catalog);
    control = (
      <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        <option value="">（未选择）</option>
        {opts.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  } else if (param.type === 'dialogueRef') {
    // combo：可挑现有对话图，也可键入新 id（缺失时可生成空白桩）。
    const opts = catalogOptionsFor(param.type, catalog);
    control = (
      <>
        <input list={listId} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder="选现有 / 键入新对话图 id" />
        <datalist id={listId}>
          {opts.map((o) => <option key={o} value={o} />)}
        </datalist>
      </>
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

      <div className="template-params">
        {template.params.map((param) => (
          <ParamField
            key={param.name}
            param={param}
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
  currentComposition?: NarrativeCompositionDef;
  onChange: (next: NarrativeTemplateDef) => void;
  onDelete: () => void;
  onRebuildFromComposition: () => void;
}) {
  const { template, currentComposition, onChange, onDelete, onRebuildFromComposition } = props;

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
            ) : (
              <input className="template-param-default" value={param.default === undefined ? '' : String(param.default)} placeholder="默认" onChange={(e) => setParam(i, { default: e.target.value })} />
            )}
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
  const [params, setParams] = useState<TemplateParamDef[]>([
    { name: 'taskId', type: 'identifier', label: '任务ID', required: true, sample: '' },
  ]);
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
        {params.map((param, i) => (
          <div key={i} className="template-param-row">
            <input className="template-param-name" value={param.name} placeholder="参数名（中文/字母/数字/下划线）" onChange={(e) => setParam(i, { name: e.target.value })} />
            <select value={param.type} onChange={(e) => setParam(i, { type: e.target.value as TemplateParamType })}>
              {PARAM_TYPES.map((t) => <option key={t} value={t}>{PARAM_TYPE_LABELS[t]}</option>)}
            </select>
            <input className="template-param-sample" value={param.sample ?? ''} placeholder="样值（作曲里的真值）" onChange={(e) => setParam(i, { sample: e.target.value })} />
            <label className="toggle compact-toggle" title="必填"><input type="checkbox" checked={Boolean(param.required)} onChange={(e) => setParam(i, { required: e.target.checked })} />必</label>
            <button type="button" className="icon-btn danger" title="删除" onClick={() => setParams((p) => p.filter((_, idx) => idx !== i))}>✕</button>
          </div>
        ))}
      </div>

      <div className="field">
        <label>一并参数化的镜像任务（可选）</label>
        <select value={includeQuestId} onChange={(e) => setIncludeQuestId(e.target.value)}>
          <option value="">（不带 quest）</option>
          {(catalog.questIds ?? []).map((q) => <option key={q} value={q}>{q}</option>)}
        </select>
      </div>

      <div className="template-stamp-actions">
        <button type="button" className="primary-btn" disabled={busy || !templateId.trim() || idTaken} onClick={() => void doExtract()}>创建模板</button>
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

  const persist = useCallback(async (next: NarrativeTemplateDef[]) => {
    onTemplatesChange(next);
    const res = await saveTemplatesRemote({ schemaVersion: 1, templates: next });
    setSaveStatus(res.ok ? '已保存模板' : `保存失败：${res.reason ?? ''}`);
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
