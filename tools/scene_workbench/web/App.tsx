import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, at, LightingLink, workspace as w, type Doc, type Mark, type Slot } from './state';
import { Viewport2D, Viewport3D } from './Viewport';
import { TrajectoryTransform, Timeline } from './TrajectoryTools';
import { AcousticPreview } from './AcousticPreview';

const layerNames: Record<string, string> = { scene: '场景', light: '灯光', trajectory: '轨迹', acoustic: '声学' };
function NumberField({ label, value, change, min, max, step = 1 }: { label: string; value: number; change: (n: number) => void; min?: number; max?: number; step?: number }) {
  const [text, setText] = useState(String(value ?? ''));
  const cancelled = useRef(false);
  useEffect(() => setText(String(value ?? '')), [value]);
  return <label className="field"><span>{label}</span><input type="number" aria-label={label} value={text} min={min} max={max} step={step} disabled={w.locked}
    onChange={e => setText(e.target.value)} onBlur={() => { if (cancelled.current) { cancelled.current = false; setText(String(value ?? '')); return; } const v = Number(text); if (text !== '' && Number.isFinite(v) && (min === undefined || v >= min) && (max === undefined || v <= max)) { if (v !== value) change(v); } else setText(String(value ?? '')); }}
    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); } }} /></label>;
}
function Toggle({ label, value, change }: { label: string; value: boolean; change: (b: boolean) => void }) {
  return <label className="check"><input type="checkbox" checked={value} onChange={e => change(e.target.checked)} disabled={w.locked}/>{label}</label>;
}
function Inspector() {
  const m = w.selection, slot = w.slots.get(m?.slot || w.active);
  if (!slot) return <div className="empty">选择画布中的对象</div>;
  const doc = slot.doc;
  const edit = (label: string, fn: (d: Doc) => void) => w.edit(m?.slot || w.active, label, fn);
  const object = m ? at(doc, m.path) : null;
  const number = (label: string, field: string, value = object?.[field], min?: number, max?: number, step = 1) =>
    <NumberField key={label} label={label} value={value} min={min} max={max} step={step} change={v => edit('修改 ' + label, d => { at(d, m!.path)[field] = v; })}/>;
  const coords = m ? (m.world && (['light', 'sound', 'reflector'].includes(m.type) || (['point', 'tip', 'landing', 'apex'].includes(m.type) && doc.space === 'world')) ? m.world : m.screen) : [];
  return <>
    <div className="inspector-title"><span className="eyebrow">{layerNames[m?.type === 'light' ? 'light' : slot.kind] || '对象'}</span><h2>{m?.label || slot.id}</h2><small>{slot.id}{w.dirty(slot) ? ' · 未保存' : ''}</small></div>
    {m && <section><h3>位置</h3>{coords.map((value, i) => <NumberField key={`${m.key}:${i}`} label={coords.length === 3 ? ['X · wu', 'Y · wu', 'Z · wu'][i] : ['画面 X', '画面 Y'][i]} value={Math.round(value * 100) / 100} step={1} change={v => {
      const p = [...coords]; p[i] = v; edit('修改位置', () => w.move(m, coords.length === 3 ? w.cal.worldToScene(...p) : p, coords.length === 3 ? p : undefined));
    }}/>)}</section>}
    {m?.type === 'entity' && m.path[0] === 'npcs' && <section><h3>实体</h3>{number('缩放', 'scale', object.scale ?? 1, 0.01, undefined, 0.01)}{number('旋转', 'rotation', object.rotation ?? 0)}</section>}
    {m?.type === 'light' && <>
      <section><h3>灯光</h3><label className="field"><span>类型</span><select value={object.kind} disabled={w.locked} onChange={e => { const kind = e.target.value; void w.run(async () => { const r = await api('/api/light/retype', { light: object, kind }); edit('切换灯类型', d => { d.lighting.lights[Number(m.path[2])] = r.light; }); }); }}>
        <option value="point">点光</option><option value="spot">聚光</option><option value="area">面光</option>
      </select></label>{number('强度', 'intensity', object.intensity, 0, undefined, 0.1)}{number('色温 K', 'kelvin', object.kelvin, 1000, 40000, 100)}{number('范围 wu', 'range', object.range, 0)}{number('光源半径', 'softeningRadius', object.softeningRadius, 0)}
      <Toggle label="启用" value={object.enabled !== false} change={v => edit('灯开关', d => { at(d, m.path).enabled = v; })}/><Toggle label="投射阴影" value={!!object.castShadow} change={v => edit('阴影开关', d => { at(d, m.path).castShadow = v; })}/>
      {object.kind === 'spot' && <>{number('内锥角', 'innerAngleDeg', object.innerAngleDeg, 0, 180)}{number('外锥角', 'outerAngleDeg', object.outerAngleDeg, 0, 180)}</>}
      </section><button className="danger" onClick={() => w.removeSelection()} disabled={w.locked}>删除这盏灯</button>
    </>}
    {slot.kind === 'trajectory' && <>
      <TrajectoryTransform slot={slot}/>
      <section><h3>轨迹段 <span>{doc.space === 'world' ? '世界坐标' : '画面坐标'}</span></h3>
        {(doc.source?.segments || []).map((seg: Doc, i: number) => <div className="segment" key={seg.id}>
          <b>{seg.id}</b><span className="tag">{seg.kind === 'manual' ? '手绘' : '物理'}</span>
          <label className="field"><span>起点</span><select value={window.Legacy.Edit.startMode(doc, seg)} onChange={e => edit('段起点', () => window.Legacy.Edit.setStartMode(w.host(slot), seg, e.target.value))}><option value="anchor">轨迹锚点</option>{i > 0 && <option value="previous">上一段末点</option>}<option value="explicit">自定起点</option></select></label>
          {seg.kind === 'manual' ? <><NumberField label="时长 ms" value={seg.timing?.durationMs ?? 1000} min={1} step={10} change={v => edit('修改时长', d => { const s = d.source.segments[i]; s.timing ||= {}; s.timing.durationMs = v; })}/>
          <Toggle label="平滑曲线" value={seg.path?.smooth !== false} change={v => edit('曲线平滑', () => window.Legacy.Edit.setSmooth(w.host(slot), seg, v))}/></> : <>
          <NumberField label="重力" value={seg.gravity} min={0} change={v => edit('重力', d => { d.source.segments[i].gravity = v; })}/>
          {Object.keys(seg.v0 || {}).map(axis => <NumberField key={axis} label={'初速 ' + axis.toUpperCase()} value={seg.v0[axis]} change={v => edit('初速', () => window.Legacy.Edit.setV0(w.host(slot), seg, { [axis]: v }))}/>)}
          </>}
          <div className="mini-row"><button disabled={w.locked || i === 0} onClick={() => edit('段上移', () => window.Legacy.Edit.moveSegment(w.host(slot), i, -1))}>上移</button><button disabled={w.locked || i === doc.source.segments.length - 1} onClick={() => edit('段下移', () => window.Legacy.Edit.moveSegment(w.host(slot), i, 1))}>下移</button><button disabled={w.locked} onClick={() => edit('删除段', () => window.Legacy.Edit.deleteSegment(w.host(slot), i))}>删除</button></div>
        </div>)}
        <div className="mini-row"><button disabled={w.locked} onClick={() => edit('新增手绘段', () => window.Legacy.Edit.addSegment(w.host(slot), 'manual'))}>＋手绘段</button><button disabled={w.locked} onClick={() => edit('新增物理段', () => window.Legacy.Edit.addSegment(w.host(slot), 'physics'))}>＋物理段</button></div>
      </section>
      <section><h3>烘焙预览</h3><p className="muted">{slot.bake?.keyframes?.length || 0} 帧 · {Math.round(slot.bake?.totalMs || 0)} ms</p>{slot.bake?.warnings?.map((s: string, i: number) => <p className="warning" key={i}>{s}</p>)}</section>
      {m?.type === 'point' && <button className="danger" disabled={w.locked} onClick={() => w.removeSelection()}>删除控制点</button>}
    </>}
    {slot.kind === 'acoustic' && <>
      <AcousticPreview slot={slot}/>
      <section><h3>声学空间</h3><NumberField label="距离倍率" value={doc.distanceScale ?? 1} min={0.001} step={0.1} change={v => edit('距离倍率', d => { d.distanceScale = v; })}/><NumberField label="耳高 wu" value={doc.earHeight ?? 141} min={0} change={v => edit('耳高', d => { d.earHeight = v; })}/>
      <label className="field"><span>听者跟随</span><select disabled={w.locked} value={doc.listenerBinding?.mode || 'player'} onChange={e => edit('听者跟随', d => { d.listenerBinding = { ...d.listenerBinding, mode: e.target.value }; })}><option value="player">玩家</option><option value="camera">镜头</option><option value="fixed">固定位置</option><option value="entity">指定实体</option></select></label>
      {doc.listenerBinding?.mode === 'entity' && <label className="field"><span>实体</span><select value={doc.listenerBinding.entityId || ''} onChange={e => edit('听者实体', d => { d.listenerBinding.entityId = e.target.value; })}><option value="">未指定</option>{[...new Set([doc.listenerBinding.entityId, ...(w.currentScene?.doc.npcs || []).map((n: Doc) => n.id)].filter(Boolean))].map((id: any) => <option key={id} value={id}>{id}</option>)}</select></label>}
      </section>
      {m?.type === 'reflector' && <section><h3>反射面</h3>{['height', 'y', 'absorb', 'rough'].map((field, i) => { const r = doc.reflectors[Number(m.path[1])]; return <NumberField key={field} label={['高度 wu', '底部 Y', '吸收率', '粗糙度'][i]} value={r[field] ?? 0} min={field === 'y' ? undefined : field === 'height' ? 0.1 : 0} max={i > 1 ? 1 : undefined} step={i > 1 ? 0.05 : 1} change={v => edit('修改反射面', d => { d.reflectors[Number(m.path[1])][field] = v; })}/>; })}
      <Toggle label="水平反射面" value={(doc.reflectors[Number(m.path[1])].tiltDeg || 0) >= 45} change={v => edit('反射面朝向', d => { d.reflectors[Number(m.path[1])].tiltDeg = v ? 90 : 0; })}/>
      <NumberField label="朝向 °" value={window.Legacy.AcousticGeo.angle(doc.reflectors[Number(m.path[1])]) * 180 / Math.PI} change={v => edit('旋转反射面', d => { const r = d.reflectors[Number(m.path[1])], G = window.Legacy.AcousticGeo; G.rotate(r, v * Math.PI / 180 - G.angle(r)); })}/>
      <NumberField label="长度 wu" min={1} value={window.Legacy.AcousticGeo.len(doc.reflectors[Number(m.path[1])])} change={v => edit('反射面长度', d => { const r = d.reflectors[Number(m.path[1])], G = window.Legacy.AcousticGeo; G.scaleLength(r, v / Math.max(.001, G.len(r))); })}/>
      <button className="danger" disabled={w.locked} onClick={() => w.removeSelection()}>删除反射面</button></section>}
      {m?.type === 'sound' && m.path[0] === 'sources' && <section>{number('发声高度 wu', 'height', object.height ?? doc.earHeight ?? 141, 0)}<button disabled={w.locked} className="danger" onClick={() => w.removeSelection()}>删除声源</button></section>}
      <section><div className="mini-row"><button disabled={w.locked} onClick={() => w.addReflector()}>＋ 反射面</button><button disabled={w.locked} onClick={() => w.addSource()}>＋ 声源</button></div></section>
    </>}
    {!m && slot.kind === 'scene' && <div className="empty">在画面或对象列表中选择实体、出生点或灯光。<br/><br/>左键拖动位置，Alt 拖动高度。</div>}
    <details><summary>文档信息</summary><div className="muted">{slot.kind === 'scene' ? `assets/scenes/${slot.id}.json` : slot.kind === 'trajectory' ? `assets/data/trajectories/${slot.id}.json` : `assets/data/acoustic_spaces.json → ${slot.id}`}</div><p className="muted">切换场景或工具保留未保存编辑。</p><button disabled={w.dirty(slot) || w.locked} title="先保存或放弃当前修改，再读取磁盘上的最新内容" onClick={() => void w.run(() => w.reload(`${slot.kind}:${slot.id}`))}>重新读取磁盘</button></details>
  </>;
}

export function App() {
  useSyncExternalStore(w.subscribe, w.snapshot);
  const lightingLink = useRef(new LightingLink(w)).current;
  const [search, setSearch] = useState(''), [newKind, setNewKind] = useState(''), [name, setName] = useState(''), [space, setSpace] = useState('screen');
  const [dialog, setDialog] = useState(''), [discardKey, setDiscardKey] = useState('');
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [runtime, setRuntime] = useState(''), [runtimeScene, setRuntimeScene] = useState(''), [allAssets, setAllAssets] = useState(false);
  const active = w.slots.get(w.active);
  useEffect(() => {
    window.workbench = { workspace: w, lightingLink, requestClose: async () => {
      (document.activeElement as HTMLElement)?.blur();
      window.__closeResult = ''; setCloseBlocked(false);
      if (w.locked || lightingLink.busy) { window.__closeResult = 'cancel'; return; }
      const preview = window.workbench.preview;
      if (preview?.active) {
        try {
          await lightingLink.pull('关闭前读取运行时灯光');
        } catch (e) { w.error = '运行时灯光未能读取：' + (e as Error).message; setCloseBlocked(true); setDialog('close'); w.notify(); return; }
      }
      if (w.dirtySlots.length) setDialog('close'); else window.__closeResult = 'close';
    } };
    void w.run(() => w.init());
    const key = (e: KeyboardEvent) => {
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && ['r', 'p'].includes(e.key.toLowerCase())) || (e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key))) { e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); (document.activeElement as HTMLElement)?.blur(); void w.run(() => w.saveAll()); return; }
      if ((e.target as HTMLElement).matches('input,textarea,select') || w.locked) return;
      const s = w.slots.get(w.active);
      if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) { e.preventDefault(); if (e.shiftKey || e.key.toLowerCase() === 'y') s?.history.redo(); else s?.history.undo(); }
      if (e.key === 'Delete') w.removeSelection();
      if (e.key === 'Escape') { w.tool = 'select'; w.notify(); }
    };
    const context = (e: Event) => e.preventDefault();
    const before = (e: BeforeUnloadEvent) => { if (w.dirtySlots.length) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('keydown', key); window.addEventListener('contextmenu', context); window.addEventListener('beforeunload', before);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('contextmenu', context); window.removeEventListener('beforeunload', before); };
  }, []);
  useEffect(() => { if (window.workbench) window.workbench.preview = { active: !!runtime, sceneId: runtimeScene }; }, [runtime, runtimeScene]);
  const useLayer = (layer: string) => { w.layer = layer; w.tool = 'select'; if (layer === 'scene' || layer === 'light') w.active = 'scene:' + w.sceneId; w.notify(); };
  const openAsset = async (kind: string, id: string, row: Doc) => {
    if (row.sceneId && (row.sceneId !== w.sceneId || (row.background && row.background !== w.background))) await w.openScene(row.sceneId, row.background || '');
    await w.openDocument(kind, id); w.selected = ''; w.selectedKeys.clear(); w.layer = kind; w.tool = 'select'; w.notify();
  };
  const marks = w.marks().filter(m => w.layer === 'scene' ? m.type === 'entity' : w.layer === 'light' ? m.type === 'light' : w.slots.get(m.slot)?.kind === w.layer);
  const rows = (w.layer === 'trajectory' ? w.catalog.trajectories : w.catalog.spaces).filter((r: Doc) => allAssets || r.sceneId === w.sceneId || r.boundBy?.includes(w.sceneId));
  const runtimeAction = (pull: boolean) => w.run(async () => {
    if (pull) {
      await lightingLink.pull();
      w.status = '已读取运行时灯光，尚未保存';
    } else {
      await lightingLink.publish(w.selection?.type === 'light' ? w.selection.label : null);
      w.status = '灯光已发送到运行时';
    }
  });
  return <div className="app">
    <header><div className="brand"><span className="brand-icon">◈</span><div><b>场景工作台</b><small>GAMEDRAFT / WORKSPACE</small></div><span className="version">01</span></div>
      <div className="scene-selector"><span className="muted">场景</span><select aria-label="场景" value={w.sceneId} disabled={w.locked} onChange={e => { void w.run(() => w.openScene(e.target.value)); }}>{w.catalog.scenes.map((s: Doc) => <option key={s.id} value={s.id}>{s.name} · {s.id}</option>)}</select>
      <select aria-label="背景" value={w.background} disabled={w.locked} onChange={e => { void w.run(() => w.openScene(w.sceneId, e.target.value)); }}>{(w.scene?.backgrounds || []).map((b: string) => <option key={b} value={b}>{b}</option>)}</select></div>
      <button className="save" disabled={!w.dirtySlots.length || w.locked} onClick={() => void w.run(() => w.saveAll())}>{w.saving ? '保存中…' : '保存全部'}{w.dirtySlots.length > 0 && <span>{w.dirtySlots.length}</span>}</button>
    </header>
    <div className="workspace">
      <nav className="rail">{Object.entries(layerNames).map(([id, label], i) => <button key={id} className={w.layer === id ? 'active' : ''} onClick={() => useLayer(id)} title={label}><span>{['▧', '☼', '⌁', '◉'][i]}</span>{label}</button>)}</nav>
      <aside className="left"><div className="panel-heading"><h2>{layerNames[w.layer]}</h2><span>{marks.length}</span></div>
        <input className="search" placeholder="筛选对象…" value={search} onChange={e => setSearch(e.target.value)}/>
        {['trajectory', 'acoustic'].includes(w.layer) && <section className="assets"><div className="section-heading"><h3>资产</h3><button disabled={w.locked || !w.scene} onClick={() => { setName(''); setNewKind(w.layer); }}>＋ 新建</button></div><Toggle label="显示其他场景的资产" value={allAssets} change={setAllAssets}/>
          {rows.map((row: Doc) => <button className={'asset ' + (w.active === `${w.layer}:${row.id}` ? 'active' : '')} key={row.id} disabled={w.locked} onClick={() => void w.run(() => openAsset(w.layer, row.id, row))}><span>{row.label || row.id}</span><small>{row.id}</small></button>)}
          {!rows.length && <p className="muted">此场景还没有{layerNames[w.layer]}资产</p>}
        </section>}
        <div className="object-list">{marks.filter(m => m.label.toLowerCase().includes(search.toLowerCase())).map(m => <button key={m.key} className={w.selectedKeys.has(m.key) || w.selected === m.key ? 'selected' : ''} onClick={e => w.select(m, e.shiftKey)}><i style={{ background: m.color }}/><span>{m.label}</span></button>)}{!marks.length && <div className="empty">{w.layer === 'light' ? '此场景没有可定位的灯光' : '选择资产后在画布中编辑'}</div>}</div>
        <div className="layers"><h3>可见图层</h3>{Object.entries(layerNames).map(([id, name]) => <label key={id}><input type="checkbox" checked={(w.visible as any)[id]} onChange={e => { (w.visible as any)[id] = e.target.checked; w.notify(); }}/>{name}</label>)}</div>
      </aside>
      <main><div className="viewport-toolbar"><div className="tabs">{[['2d', '2D 画面'], ['3d', '3D 空间'], ['runtime', '运行时']].map(([id, name]) => <button key={id} className={w.view === id ? 'active' : ''} disabled={id === '3d' && !w.cal} onClick={() => { w.view = id; w.notify(); }}>{name}</button>)}</div>
        <div className="tools">{w.view === '3d' && <><button onClick={() => window.dispatchEvent(new CustomEvent('workbench-camera', { detail: 'game' }))}>游戏机位</button><button onClick={() => window.dispatchEvent(new CustomEvent('workbench-camera', { detail: 'top' }))}>俯视</button></>}{w.layer === 'light' && <button disabled={w.locked || !w.cal} onClick={() => void w.run(() => w.addLight())}>＋ 灯光</button>}
        {active?.kind === 'trajectory' && <button className={w.tool === 'pen' ? 'active' : ''} disabled={w.locked} onClick={() => { w.tool = w.tool === 'pen' ? 'select' : 'pen'; w.notify(); }}>{w.tool === 'pen' ? '结束落点 Esc' : '添加轨迹点'}</button>}
        {active?.kind === 'acoustic' && <button disabled={w.locked} onClick={() => w.addReflector()}>＋ 反射面</button>}
        <button aria-label="撤销" title="撤销 Ctrl+Z" disabled={!active?.history.canUndo || w.locked} onClick={() => active?.history.undo()}>↶</button><button aria-label="重做" title="重做 Ctrl+Shift+Z" disabled={!active?.history.canRedo || w.locked} onClick={() => active?.history.redo()}>↷</button></div>
      </div>
      <div className="viewport">{w.view === '2d' ? <Viewport2D/> : w.view === '3d' ? <Viewport3D/> : null}<div className="runtime" style={{ position: 'absolute', inset: 0, visibility: w.view === 'runtime' ? 'visible' : 'hidden', pointerEvents: w.view === 'runtime' ? 'auto' : 'none' }}>
        <div className="runtime-bar"><button disabled={w.locked} onClick={() => void w.run(async () => {
          const r = await api('/api/runtime/start', {});
          if (runtime) {
            await lightingLink.pull('保留上一预览的灯光');
          }
          lightingLink.attach(w.sceneId);
          setRuntimeScene(w.sceneId); setRuntime(`${r.url}/?mode=dev&devScene=${encodeURIComponent(w.sceneId)}&visualCapture=1&preview=${Date.now()}`);
        })}>{runtime ? '进入当前场景' : '连接游戏预览'}</button><button disabled={!runtime || runtimeScene !== w.sceneId || w.locked} onClick={() => void runtimeAction(false)}>发送灯光</button><button disabled={!runtime || runtimeScene !== w.sceneId || w.locked} onClick={() => void runtimeAction(true)}>读取运行时灯光</button><span className="muted">{runtime && `预览：${runtimeScene}`}</span></div>
        {runtime ? <iframe title="真实游戏运行时" src={runtime} allow="autoplay; fullscreen"/> : <div className="runtime-empty"><div>◈</div><h2>使用游戏本身预览光影</h2><p>连接后使用 F2 调光、F3 拖动灯位。</p><p>读取运行时灯光后，点击「保存全部」落盘。</p></div>}
      </div>
      {w.loading && <div className="loading"><span className="spinner"/>正在加载场景与几何…</div>}
      </div>
      {active?.kind === 'trajectory' && w.view !== 'runtime' && <Timeline slot={active}/>}
      <div className="document-strip"><span>打开的文档</span>{[...w.slots.entries()].map(([key, s]) => <button key={key} className={w.active === key ? 'active' : ''} onClick={() => void w.run(async () => { if (s.kind === 'scene') { if (w.sceneId !== s.id) await w.openScene(s.id); useLayer('scene'); } else await openAsset(s.kind, s.id, s.doc.authoring || {}); w.active = key; w.notify(); })}>{w.dirty(s) && <i/>}{s.id}</button>)}</div>
      </main>
      <aside className="right"><div className="panel-heading"><h2>属性</h2>{active && w.dirty(active) && <button disabled={w.locked} onClick={() => setDiscardKey(w.active)}>放弃修改</button>}</div><div className="inspector" key={w.selected || w.active}><Inspector/></div></aside>
    </div>
    <footer><span className={w.error ? 'error' : ''}>{w.error || w.status}</span><span>{w.view === '3d' ? '右键旋转 · 中键平移 · 滚轮缩放' : '空格 / 中键平移 · 滚轮缩放'} · F 居中 · Alt 拖动高度</span><b>{w.dirtySlots.length ? `${w.dirtySlots.length} 份未保存` : '已保存'}</b></footer>
    {(newKind || dialog || discardKey) && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true">
      {newKind ? <><h2>新建{layerNames[newKind]}</h2><label>名称<input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="例如：门口巡逻"/></label>{newKind === 'trajectory' && <label>坐标空间<select value={space} onChange={e => setSpace(e.target.value)}><option value="screen">画面坐标</option><option value="world" disabled={!w.cal}>世界坐标</option></select></label>}<p className="muted">在当前视口中心创建，保存前只保留在工作台中。</p>{w.error && <p className="error">{w.error}</p>}<div className="modal-actions"><button onClick={() => setNewKind('')}>取消</button><button className="save" onClick={() => void w.run(async () => { await w.newAsset(newKind, name, space); setNewKind(''); })}>创建</button></div></>
      : discardKey ? <><h2>放弃此文档的修改？</h2><p>恢复到本次打开或最后保存的状态。</p><div className="modal-actions"><button onClick={() => setDiscardKey('')}>取消</button><button className="danger" onClick={() => { w.discard(discardKey); setDiscardKey(''); }}>放弃修改</button></div></>
      : <><h2>{closeBlocked ? '运行时灯光尚未读取' : '还有未保存的编辑'}</h2><p>{w.dirtySlots.map(s => s.id).join('、')}</p>{w.error && <p className="error">{w.error}</p>}<div className="modal-actions"><button disabled={w.saving} onClick={() => { setDialog(''); window.__closeResult = 'cancel'; }}>继续编辑</button><button disabled={w.saving} onClick={() => { window.__closeResult = 'close'; setDialog(''); }}>放弃并关闭</button>{closeBlocked ? <button onClick={() => void window.workbench.requestClose()}>重试读取</button> : <button className="save" disabled={w.saving} onClick={() => void w.run(async () => { await w.saveAll(); if (!w.dirtySlots.length) window.__closeResult = 'close'; })}>保存并关闭</button>}</div></>}
    </div></div>}
  </div>;
}
