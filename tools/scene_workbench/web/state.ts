import { useRuntimeProjection } from './coordinates';
// UI documents only. Geometry, point editing, baking and disk formats stay with
// the existing tools, loaded as /reuse/*.js or called through the Python adapter.
export type Doc = Record<string, any>;
export type Slot = { kind: string; id: string; doc: Doc; baseline: string; revision: string; history: any; bake?: Doc; isNew?: boolean };
export type Mark = { key: string; slot: string; type: string; path: (string | number)[]; label: string; color: string; screen: number[]; world?: number[]; segment?: number; point?: number };
declare global { interface Window { Legacy: any; workbench: any; __closeResult: string; __selftestResult: string } }

export async function api(path: string, body?: unknown): Promise<any> {
  const r = await fetch(path, { cache: 'no-store', ...(body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.err || `请求失败 ${r.status}`);
  return j;
}
export const clone = <T,>(doc: T): T => structuredClone(doc);
export function at(doc: Doc, path: (string | number)[]): any { return path.reduce((d: any, key) => d?.[key], doc); }

// UI synchronization guard only; phase splitting/merging remains in scene_lights.
const lightingStamp = (doc: Doc) => JSON.stringify([doc.lighting, Object.entries(doc.timeVariants || {}).map(([phase, v]: [string, any]) => [phase, v.lighting])]);
export class LightingLink {
  sceneId = ''; baseline = ''; busy = false;
  constructor(private workspace: Workspace) {}
  attach(sceneId: string) {
    if (this.sceneId === sceneId) return;
    this.sceneId = sceneId;
    this.baseline = lightingStamp(JSON.parse(this.workspace.slots.get('scene:' + sceneId)!.baseline));
  }
  async pull(label = '从运行时读取灯光') {
    if (this.busy || this.workspace.locked) throw new Error('请等待当前操作完成后再读取灯光');
    const w = this.workspace, key = 'scene:' + this.sceneId, slot = w.slots.get(key)!;
    const before = lightingStamp(slot.doc);
    if (before !== this.baseline) throw new Error('工作台有尚未发送的灯光修改，请先发送灯光，或撤销本地灯光修改后再读取');
    this.busy = true;
    try {
      const r = await api('/api/lighting/pull', { sceneId: this.sceneId, base: slot.doc.lighting, variants: slot.doc.timeVariants });
      if (w.locked || before !== lightingStamp(slot.doc)) throw new Error('读取期间工作台灯光发生变化，已保留本地修改，请重试');
      w.edit(key, label, d => { d.lighting = r.lighting; if (r.phase && (Object.keys(r.variant || {}).length || d.timeVariants?.[r.phase]?.lighting !== undefined)) { d.timeVariants ||= {}; d.timeVariants[r.phase] ||= {}; d.timeVariants[r.phase].lighting = r.variant; } });
      this.baseline = lightingStamp(slot.doc);
    } finally { this.busy = false; }
  }
  async publish(selectedId: string | null) {
    if (this.busy) throw new Error('灯光正在同步，请稍候');
    const slot = this.workspace.slots.get('scene:' + this.sceneId)!, sent = clone(slot.doc);
    if (!sent.lighting) throw new Error('当前场景没有灯光配置');
    this.busy = true;
    try {
      await api('/api/lighting/publish', { sceneId: this.sceneId, lighting: sent.lighting, variants: sent.timeVariants, selectedId });
      this.baseline = lightingStamp(sent);
    } finally { this.busy = false; }
  }
}

export class Workspace {
  slots = new Map<string, Slot>();
  catalog: Doc = { scenes: [], trajectories: [], spaces: [] };
  sceneId = ''; background = ''; scene: Doc | null = null; cal: any = null;
  image: HTMLImageElement | null = null; mesh: ArrayBuffer | null = null;
  selected = ''; active = ''; tool = 'select'; layer = 'scene'; view = '2d';
  selectedKeys = new Set<string>();
  playhead = 0; playing = false; loop = true;
  visible = { scene: true, light: true, trajectory: true, acoustic: true };
  status = '正在读取工程…'; error = ''; loading = false; saving = false; version = 0;
  listeners = new Set<() => void>(); loadEpoch = 0; bakeEpoch = new Map<string, number>();
  viewportCenter: (() => number[]) | null = null;
  notify = () => { this.version++; this.listeners.forEach(fn => fn()); };
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.version;
  get currentScene() { return this.slots.get('scene:' + this.sceneId); }
  dirty(s: Slot) { return JSON.stringify(s.doc) !== s.baseline; }
  get dirtySlots() { return [...this.slots.values()].filter(s => this.dirty(s)); }
  get locked() { return this.loading || this.saving; }
  get center() { return this.viewportCenter?.() || [this.scene!.worldWidth / 2, this.scene!.worldHeight / 2]; }
  async run(fn: () => Promise<unknown> | unknown) {
    try { this.error = ''; await fn(); } catch (e) { this.error = String((e as Error).message || e); } finally { this.notify(); }
  }
  async init() {
    await this.refresh();
    const sid = new URLSearchParams(location.search).get('scene');
    const first = this.catalog.scenes.find((s: Doc) => s.id === sid) || this.catalog.scenes.find((s: Doc) => s.depth) || this.catalog.scenes[0];
    if (first) await this.openScene(first.id); else this.status = '工程没有可用场景';
  }
  async refresh() { this.catalog = await api('/api/catalog'); this.notify(); }
  install(kind: string, id: string, doc: Doc, revision: string, isNew = false) {
    const key = `${kind}:${id}`;
    const s: Slot = { kind, id, doc, baseline: isNew ? '' : JSON.stringify(doc), revision, history: null, isNew };
    s.history = new window.Legacy.History({ get: () => s.doc, set: (d: Doc) => { s.doc = d; this.changed(key); }, onChange: this.notify });
    this.slots.set(key, s);
    return s;
  }
  async openDocument(kind: string, id: string) {
    const key = `${kind}:${id}`;
    if (!this.slots.has(key)) { const r = await api(`/api/document?kind=${kind}&id=${encodeURIComponent(id)}`); this.install(kind, id, r.doc, r.revision); }
    this.active = key;
    if (kind === 'trajectory') void this.bake(key);
    this.notify();
    return this.slots.get(key)!;
  }
  async openScene(id: string, bg = '') {
    if (this.saving) return;
    const epoch = ++this.loadEpoch;
    this.loading = true; this.selected = ''; this.selectedKeys.clear(); this.notify();
    try {
      await this.openDocument('scene', id);
      const r = await api(`/api/scene?id=${encodeURIComponent(id)}&bg=${encodeURIComponent(bg)}`);
      const scene = r.scene;
      const query = `?id=${encodeURIComponent(id)}&bg=${encodeURIComponent(scene.background)}`;
      const image = new Image();
      const loaded = new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('场景背景加载失败')); });
      image.src = '/api/background' + query;
      let cal = null; let mesh = null;
      if (scene.cal) {
        const results = await Promise.all(['ground', 'heightfield', 'mesh'].map(async name => {
          const res = await fetch(`/api/${name}` + query, { cache: 'no-store' });
          if (!res.ok) throw new Error(`${name} 加载失败`); return res.arrayBuffer();
        }));
        cal = new window.Legacy.SceneCal(scene.cal, scene.worldWidth, scene.worldHeight);
        cal.setGround(results[0]); cal.setHeightfield(results[1]); useRuntimeProjection(cal); mesh = results[2];
      }
      await loaded;
      if (epoch !== this.loadEpoch) return;
      this.sceneId = id; this.background = scene.background; this.scene = scene; this.cal = cal; this.mesh = mesh; this.image = image;
      this.active = 'scene:' + id; this.tool = 'select';
      this.status = scene.cal ? `已打开 ${scene.name} · ${scene.cal.groundSource === 'shell' ? '无行走面烘焙，拾取使用深度壳近似' : '行走面已加载'}` : `已打开 ${scene.name} · 无深度，可编辑画面坐标`;
    } finally { if (epoch === this.loadEpoch) { this.loading = false; this.notify(); } }
  }
  host(s: Slot) {
    const cal = this.cal;
    return { doc: s.doc, cal, bakeSegment: (i: number) => s.bake?.segments?.[i],
      restH: () => cal ? Math.max(0, Number(s.doc.authoring?.contactOffsetY || 0)) / Math.max(0.1, Math.abs(cal.cosTheta)) : 0 };
  }
  async bake(key: string) {
    const s = this.slots.get(key); if (!s || s.kind !== 'trajectory') return;
    const epoch = (this.bakeEpoch.get(key) || 0) + 1; this.bakeEpoch.set(key, epoch);
    try { const b = await api('/api/bake', { doc: clone(s.doc) }); if (this.bakeEpoch.get(key) === epoch) { s.bake = b; this.notify(); } }
    catch (e) { if (this.bakeEpoch.get(key) === epoch) { this.error = String((e as Error).message); this.notify(); } }
  }
  changed(key: string) { this.notify(); if (this.slots.get(key)?.kind === 'trajectory') void this.bake(key); }
  edit(key: string, label: string, fn: (doc: Doc) => void) {
    if (this.locked) return;
    const s = this.slots.get(key)!;
    if (s.history.commit(label, () => fn(s.doc))) this.changed(key);
  }
  async save(key: string) {
    const s = this.slots.get(key)!; if (!this.dirty(s)) return;
    const sent = clone(s.doc);
    const r = await api('/api/save', { kind: s.kind, id: s.id, doc: sent, revision: s.revision, create: s.isNew });
    const previousRevision = s.revision;
    if (s.kind === 'acoustic') for (const other of this.slots.values()) {
      if (other.kind === 'acoustic' && other.revision === previousRevision) other.revision = r.revision;
    }
    s.revision = r.revision; s.baseline = JSON.stringify(r.doc);
    s.isNew = false;
    // Preserve an edit made while a save was in flight (also important for automation).
    if (JSON.stringify(s.doc) === JSON.stringify(sent)) s.doc = r.doc;
    if (r.bake) s.bake = r.bake;
    this.status = `已保存 ${s.id}`; this.notify();
  }
  async saveAll() {
    if (this.locked) return;
    this.saving = true; this.notify();
    try { for (const [key, s] of this.slots) if (this.dirty(s)) await this.save(key); await this.refresh(); }
    finally { this.saving = false; this.notify(); }
  }
  discard(key: string) {
    const s = this.slots.get(key)!;
    if (!s.baseline) this.slots.delete(key); else { s.doc = JSON.parse(s.baseline); s.history.clear(); this.changed(key); }
    this.selected = ''; this.selectedKeys.clear(); this.notify();
  }
  async reload(key: string) {
    const s = this.slots.get(key)!;
    const r = await api(`/api/document?kind=${s.kind}&id=${encodeURIComponent(s.id)}`);
    this.install(s.kind, s.id, r.doc, r.revision);
    this.selected = ''; this.selectedKeys.clear(); this.status = `已重新读取 ${s.id}`; this.changed(key);
  }
  marks(): Mark[] {
    if (!this.scene) return [];
    const out: Mark[] = []; const cal = this.cal;
    const add = (slot: string, type: string, path: (string | number)[], label: string, color: string, screen: number[], world?: number[], extra = {}) => {
      if (screen.every(Number.isFinite)) out.push({ key: slot + '/' + path.join('/'), slot, type, path, label, color, screen, world, ...extra });
    };
    const fromScreen = (p: number[]) => cal ? cal.sceneToWorldGround(p[0], p[1]) : undefined;
    const toScreen = (p: number[]) => cal.worldToScene(...p);
    const sceneKey = 'scene:' + this.sceneId, doc = this.currentScene!.doc;
    if (this.visible.scene) {
      for (const group of ['npcs', 'hotspots']) (doc[group] || []).forEach((n: Doc, i: number) => {
        if (Number.isFinite(n.x) && Number.isFinite(n.y)) add(sceneKey, 'entity', [group, i], n.name || n.id || group, '#73b7ff', [n.x, n.y], fromScreen([n.x, n.y]));
      });
      if (doc.spawnPoint) add(sceneKey, 'entity', ['spawnPoint'], '默认出生点', '#6ae1b5', [doc.spawnPoint.x, doc.spawnPoint.y], fromScreen([doc.spawnPoint.x, doc.spawnPoint.y]));
      Object.entries(doc.spawnPoints || {}).forEach(([id, p]: [string, any]) => add(sceneKey, 'entity', ['spawnPoints', id], `出生点 · ${id}`, '#6ae1b5', [p.x, p.y], fromScreen([p.x, p.y])));
    }
    if (this.visible.light && cal) (doc.lighting?.lights || []).forEach((l: Doc, i: number) => {
      if (Array.isArray(l.pos)) add(sceneKey, 'light', ['lighting', 'lights', i], l.id || `灯 ${i + 1}`, '#ffcc72', toScreen(l.pos), l.pos);
    });
    for (const [key, s] of this.slots) {
      if (s.doc.authoring?.sceneId !== this.sceneId || (s.doc.authoring?.background && s.doc.authoring.background !== this.background)) continue;
      if (s.kind === 'trajectory' && this.visible.trajectory && (s.doc.space !== 'world' || cal)) {
        const host = this.host(s), Edit = window.Legacy.Edit;
        (s.doc.source?.segments || []).forEach((seg: Doc, i: number) => {
          if (seg.kind === 'physics') {
            const info = Edit.physicsInfo(host, seg);
            if (info) for (const [handle, label] of [['tip', '初速'], ['landing', '落点'], ['apex', '最高点']]) {
              if (info[handle]) add(key, handle, ['source', 'segments', i, handle], `${seg.id} · ${label}`, '#ffae91', info[handle], info[handle + 'W'] || fromScreen(info[handle]), { segment: i });
            }
            return;
          }
          if (seg.kind !== 'manual') return;
          Edit.effPoints(host, seg).forEach((p: Doc, j: number) => add(key, 'point', ['source', 'segments', i, 'path', 'points', j], `${seg.id} · ${j + 1}`, '#bba2ff', [p.sx, p.sy], p.pos || fromScreen([p.sx, p.sy]), { segment: i, point: j }));
        });
        const a = s.doc.authoring?.anchor;
        if (a) add(key, 'anchor', ['authoring', 'anchor'], '轨迹锚点', '#e8d9ff', [a.x, a.y], fromScreen([a.x, a.y]));
      }
      if (s.kind === 'acoustic' && this.visible.acoustic && cal) {
        const point = (p: Doc, path: (string | number)[], label: string) => { const w = [p.x, p.y ?? cal.groundHeight(p.x, p.z), p.z]; add(key, 'sound', path, label, '#64e3d0', toScreen(w), w); };
        point(s.doc.listener, ['listener'], '听者');
        (s.doc.sources || []).forEach((p: Doc, i: number) => point(p, ['sources', i], p.label || p.id));
        (s.doc.reflectors || []).forEach((r: Doc, i: number) => ['a', 'b'].forEach(end => {
          const p = r[end]; const w = [p[0], r.y ?? 0, p[1]];
          add(key, 'reflector', ['reflectors', i, end], `${r.id || '反射面'} · ${end.toUpperCase()}`, '#64e3d0', toScreen(w), w);
        }));
      }
    }
    return out;
  }
  select(mark?: Mark, toggle = false) {
    if (!toggle || (mark && this.active !== mark.slot)) this.selectedKeys.clear();
    if (mark) { if (toggle && this.selectedKeys.has(mark.key)) this.selectedKeys.delete(mark.key); else this.selectedKeys.add(mark.key); this.active = mark.slot; }
    this.selected = mark && this.selectedKeys.has(mark.key) ? mark.key : [...this.selectedKeys].at(-1) || '';
    this.notify();
  }
  get selection() { return this.marks().find(m => m.key === this.selected); }
  move(mark: Mark, screen: number[], world?: number[]) {
    const s = this.slots.get(mark.slot)!; const target = at(s.doc, mark.path); const cal = this.cal;
    const w = world || (cal ? cal.sceneToWorldGround(...screen) : null);
    if (['tip', 'landing', 'apex'].includes(mark.type)) {
      const Edit = window.Legacy.Edit, host = this.host(s), seg = s.doc.source.segments[mark.segment!], world = s.doc.space === 'world';
      if (mark.type === 'tip') Edit.setTip(host, seg, world ? w : screen);
      if (mark.type === 'landing') Edit.setLanding(host, seg, world ? [w[0], w[2]] : screen);
      if (mark.type === 'apex') Edit.setApex(host, seg, world ? w[1] : screen[1]);
    }
    else if (mark.type === 'light') { target.pos = w; }
    else if (mark.type === 'sound') { target.x = w[0]; target.y = w[1]; target.z = w[2]; }
    else if (mark.type === 'reflector') { target[0] = w[0]; target[1] = w[2]; s.doc.reflectors[Number(mark.path[1])].y = w[1]; }
    else if (mark.type === 'anchor') window.Legacy.Edit.setAnchorScreen(this.host(s), screen[0], screen[1], true);
    else if (mark.type === 'point') {
      const pos = s.doc.space === 'world' ? { x: w[0], z: w[2], h: Math.max(0, w[1] - cal.groundHeight(w[0], w[2]) - this.host(s).restH()) } : screen;
      window.Legacy.Edit.setPoint(this.host(s), s.doc.source.segments[mark.segment!], mark.point, pos);
    } else { target.x = Math.round(screen[0] * 100) / 100; target.y = Math.round(screen[1] * 100) / 100; }
    this.notify();
  }
  async addLight() {
    if (!this.cal) throw new Error('当前场景没有深度，无法摆放世界灯位');
    const key = 'scene:' + this.sceneId, doc = this.currentScene!.doc;
    const r = await api('/api/default-light?index=' + (doc.lighting?.lights?.length || 0));
    const taken = new Set((doc.lighting?.lights || []).map((l: Doc) => l.id)); let id = r.light.id; let n = 2;
    while (taken.has(id)) id = `${r.light.id}_${n++}`;
    r.light.id = id; r.light.pos = this.cal.sceneToWorldGround(...this.center); r.light.pos[1] += 150;
    this.edit(key, '新增灯', d => { d.lighting ||= r.lighting; d.lighting.lights ||= []; d.lighting.lights.push(r.light); });
    this.layer = 'light'; this.select(this.marks().find(m => m.type === 'light' && m.label === id));
  }
  addPoint(screen: number[]) {
    const s = this.slots.get(this.active); if (s?.kind !== 'trajectory') return;
    this.edit(this.active, '添加轨迹点', () => {
      const Edit = window.Legacy.Edit, host = this.host(s);
      let seg = s.doc.source?.segments?.at(-1);
      if (!seg || seg.kind !== 'manual') seg = s.doc.source.segments[Edit.addSegment(host, 'manual')];
      const p = s.doc.space === 'world' ? this.cal.worldToXZH(...this.cal.sceneToWorldGround(...screen)) : screen;
      Edit.appendPoint(host, seg, p);
    });
  }
  async newAsset(kind: string, id: string, space = 'screen') {
    if (!id.trim() || id !== id.trim() || /[\\/:*?"<>|]/.test(id) || id.startsWith('.')) throw new Error('请使用有效且不重复的名称');
    const rows = kind === 'trajectory' ? this.catalog.trajectories : this.catalog.spaces;
    if (rows.some((r: Doc) => r.id === id) || this.slots.has(`${kind}:${id}`)) throw new Error('名称已存在');
    const [x, y] = this.center;
    let doc: Doc;
    if (kind === 'trajectory') {
      doc = { id, label: '', space, keyframes: [], source: { segments: [] }, authoring: { sceneId: this.sceneId, background: this.background, anchor: { x, y }, contactOffsetY: 0 } };
    } else {
      if (!this.cal) throw new Error('当前场景没有深度，无法编辑声学空间');
      doc = (await api('/api/new-space', { sceneId: this.sceneId, background: this.background })).doc;
      const w = this.cal.sceneToWorldGround(x, y); doc.listener = { x: w[0], y: w[1], z: w[2] };
    }
    // Acoustic revision covers the whole original library, not just one key.
    let rev = 'absent';
    if (kind === 'acoustic') rev = (await api('/api/acoustic-revision')).revision;
    const s = this.install(kind, id, doc, rev, true);
    this.active = `${kind}:${id}`; this.layer = kind; this.selected = ''; this.selectedKeys.clear();
    if (kind === 'trajectory') { window.Legacy.Edit.addSegment(this.host(s), 'manual'); this.tool = 'pen'; }
    this.notify();
  }
  addReflector() {
    const s = this.slots.get(this.active); if (s?.kind !== 'acoustic' || !this.cal) return;
    const w = this.cal.sceneToWorldGround(...this.center);
    const used = new Set(s.doc.reflectors.map((r: Doc) => r.id)); let n = 1; while (used.has(`反射面_${n}`)) n++;
    this.edit(this.active, '新增反射面', d => d.reflectors.push({ id: `反射面_${n}`, a: [w[0] - 100, w[2]], b: [w[0] + 100, w[2]], y: w[1], height: 300, absorb: 0.1, rough: 0.4 }));
  }
  transformTrajectory(scope: string, segment: number, kind: string, a: number, b: number) {
    const s = this.slots.get(this.active); if (s?.kind !== 'trajectory') return;
    const E = window.Legacy.Edit, host = this.host(s), world = s.doc.space === 'world';
    const seg = s.doc.source.segments[segment]; if (!seg) return;
    const pivot = scope === 'all' ? (world ? E.anchorWorld(host) : Object.values(s.doc.authoring.anchor))
      : (world ? E.segStartWorld(host, seg) : E.segStartScreen(host, seg));
    const p = world ? [pivot[0], pivot[2], 0] : pivot;
    const T = kind === 'translate' ? (world ? E.T.translate3(a, b, 0) : E.T.translate2(a, b))
      : kind === 'rotate' ? (world ? E.T.rotateY(p, a) : E.T.rotate2(p, a))
      : kind === 'mirror' ? (world ? E.T.mirror3(p, a === 0 ? 'x' : 'z') : E.T.mirror2(p, a === 0 ? 'x' : 'y'))
      : (world ? E.T.scale3(p, a, b, 1) : E.T.scale2(p, a, b));
    const selected = new Set(this.marks().filter(m => m.slot === this.active && this.selectedKeys.has(m.key) && m.type === 'point' && m.segment === segment).map(m => m.point));
    if (scope === 'points' && !selected.size) { this.status = '请先用 Shift 多选本段控制点'; this.notify(); return; }
    this.edit(this.active, '变换轨迹', () => { if (scope === 'all') E.transformAll(host, T); else E.transformSegment(host, seg, T, scope === 'points' ? selected : null); });
  }
  addSource() {
    const s = this.slots.get(this.active); if (s?.kind !== 'acoustic' || !this.cal) return;
    const p = this.cal.sceneToWorldGround(...this.center);
    let n = 1; while ((s.doc.sources || []).some((v: Doc) => v.id === `声源_${n}`)) n++;
    this.edit(this.active, '新增声源', d => { (d.sources ||= []).push({ id: `声源_${n}`, x: p[0], y: p[1], z: p[2] }); });
  }
  removeSelection() {
    const m = this.selection; if (!m || !['light', 'point', 'reflector', 'sound'].includes(m.type)) return;
    if (m.type === 'sound' && m.path[0] !== 'sources') return;
    this.edit(m.slot, '删除选中项', d => {
      if (m.type === 'light') d.lighting.lights.splice(Number(m.path[2]), 1);
      if (m.type === 'reflector') d.reflectors.splice(Number(m.path[1]), 1);
      if (m.type === 'sound') d.sources.splice(Number(m.path[1]), 1);
      if (m.type === 'point') for (const [i, seg] of d.source.segments.entries()) {
        const points = this.marks().filter(p => p.slot === m.slot && p.type === 'point' && p.segment === i && (this.selectedKeys.has(p.key) || p.key === m.key)).map(p => p.point);
        if (points.length) window.Legacy.Edit.deletePoints(this.host(this.slots.get(m.slot)!), seg, points);
      }
    });
    this.selected = ''; this.selectedKeys.clear(); this.notify();
  }
}
export const workspace = new Workspace();
