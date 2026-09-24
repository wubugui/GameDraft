#!/usr/bin/env node
// 在 data/raw.json 之上做纯计算(不读代码):大块归属、块间/文件间连线、循环依赖、分层方向、
// 事件配对、开发调试代码引用、最大文件。输出 data/analysis.json。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCKS, DEBUG_NAME_RULE, LAYERS, ASSEMBLY_FILES, UNLAYERED_DIRS, blockOf, layerOf } from './blocks.mjs';

const MAP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = JSON.parse(fs.readFileSync(path.join(MAP_DIR, 'data', 'raw.json'), 'utf8'));

const fileSet = new Set(raw.files.map((f) => f.path));
const fileInfo = new Map();
for (const f of raw.files) {
  const L = layerOf(f.path);
  fileInfo.set(f.path, {
    path: f.path, lines: f.lines, block: blockOf(f.path), boundary: f.boundary,
    layer: L ? L.id : null, rank: L ? L.rank : null,
    assembly: ASSEMBLY_FILES.some((r) => r.test(f.path)),
    debugName: DEBUG_NAME_RULE.test(f.path),
  });
}
const unassigned = raw.files.filter((f) => !fileInfo.get(f.path).block).map((f) => f.path);
if (unassigned.length) {
  console.error('有文件没有归块:', unassigned);
  process.exit(1);
}

const cite = (file, line) => ({ f: file, l: line });

// ─────────────────────────── 内部 import 边(文件级)
const internalImports = raw.imports.filter((i) => i.kind === 'internal' && fileSet.has(i.to));
const assetImports = raw.imports.filter((i) => i.kind === 'internal' && !fileSet.has(i.to));
const externalImports = raw.imports.filter((i) => i.kind === 'external');

// 文件级依赖(去重合并多条 import 语句)
const fileDeps = new Map(); // key from→to
for (const i of internalImports) {
  const k = `${i.from}→${i.to}`;
  if (!fileDeps.has(k)) fileDeps.set(k, { from: i.from, to: i.to, runtime: false, sites: [] });
  const e = fileDeps.get(k);
  e.runtime = e.runtime || i.runtime;
  e.sites.push({ f: i.from, l: i.line, runtime: i.runtime, form: i.form, names: i.names });
}

// ─────────────────────────── 创建边(new 内部类)
const createEdges = new Map();
for (const n of raw.news) {
  if (n.target.kind !== 'internal' || !fileSet.has(n.target.file)) continue;
  const k = `${n.file}→${n.target.file}`;
  if (!createEdges.has(k)) createEdges.set(k, { from: n.file, to: n.target.file, classes: new Set(), sites: [] });
  const e = createEdges.get(k);
  e.classes.add(n.target.name);
  e.sites.push({ f: n.file, l: n.line, cls: n.target.name, by: n.enclosing, assignedTo: n.assignedTo, injected: n.injected.map((x) => x.class) });
}

// ─────────────────────────── 事件配对
const byEvent = new Map();
for (const e of raw.events) {
  if (!e.event) continue;
  const key = `${e.bus}::${e.event}`;
  if (!byEvent.has(key)) byEvent.set(key, { bus: e.bus, event: e.event, emit: [], on: [], off: [] });
  const g = byEvent.get(key);
  const site = { f: e.file, l: e.line, by: e.enclosing, handler: e.handler || undefined, how: e.how, boundary: !!fileInfo.get(e.file)?.boundary, dev: !!e.devGuarded };
  if (e.op === 'emit') g.emit.push(site);
  else if (e.op === 'on' || e.op === 'once') g.on.push(site);
  else g.off.push(site);
}
// 私有总线:CanvasVfxHost 自建 EventBus,并把一个 VfxSystem 实例 init 到这条总线上。
// VfxSystem 源码里的订阅(this.eventBus.on)对这个实例而言就是订阅在私有总线上 —— 按这条装配事实把订阅复制过去。
const BUS_BINDINGS = [
  { bus: 'canvasVfxHost.bus', files: ['src/systems/vfx/VfxSystem.ts'], cite: { f: 'src/systems/canvas/CanvasVfxHost.ts', l: 147, m: 'this.system.init({ eventBus: this.bus }' } },
];
for (const b of BUS_BINDINGS) {
  for (const g of [...byEvent.values()]) {
    if (g.bus !== 'main') continue;
    const subs = g.on.filter((s) => b.files.includes(s.f));
    if (!subs.length) continue;
    const key = `${b.bus}::${g.event}`;
    if (!byEvent.has(key)) byEvent.set(key, { bus: b.bus, event: g.event, emit: [], on: [], off: [] });
    for (const s of subs) byEvent.get(key).on.push({ ...s, viaBinding: b.cite });
  }
}
const eventList = [...byEvent.values()].sort((a, b) => a.event.localeCompare(b.event) || a.bus.localeCompare(b.bus));
for (const g of eventList) {
  const rtEmit = g.emit.filter((s) => !s.boundary);
  const rtOn = g.on.filter((s) => !s.boundary);
  g.emitNoListener = g.emit.length > 0 && g.on.length === 0;
  g.listenNoEmitter = g.on.length > 0 && g.emit.length === 0;
  // 只算正式运行时(不含边界目录)时的配对状态
  g.runtimeOnly = {
    emitNoListener: rtEmit.length > 0 && rtOn.length === 0,
    listenNoEmitter: rtOn.length > 0 && rtEmit.length === 0,
  };
}
// 事件边(文件级):emitter 文件 → listener 文件
const eventEdges = new Map();
for (const g of eventList) {
  for (const em of g.emit) for (const ln of g.on) {
    const k = `${em.f}→${ln.f}`;
    if (!eventEdges.has(k)) eventEdges.set(k, { from: em.f, to: ln.f, events: new Map() });
    const e = eventEdges.get(k);
    if (!e.events.has(g.event)) e.events.set(g.event, { event: g.event, bus: g.bus, emit: [], on: [] });
    const ev = e.events.get(g.event);
    if (!ev.emit.some((s) => s.l === em.l)) ev.emit.push({ f: em.f, l: em.l });
    if (!ev.on.some((s) => s.l === ln.l)) ev.on.push({ f: ln.f, l: ln.l });
  }
}

// ─────────────────────────── 块级聚合
function aggregate(edges, kind) {
  const m = new Map();
  for (const e of edges) {
    const a = fileInfo.get(e.from).block;
    const b = fileInfo.get(e.to).block;
    if (a === b) continue;
    const k = `${a}→${b}`;
    if (!m.has(k)) m.set(k, { from: a, to: b, kind, count: 0, files: [] });
    const x = m.get(k);
    x.count++;
    x.files.push(e);
  }
  return [...m.values()];
}
const fileDepList = [...fileDeps.values()];
const blockDeps = aggregate(fileDepList.filter((e) => e.runtime), 'dep');
const blockTypeDeps = aggregate(fileDepList.filter((e) => !e.runtime), 'typedep');
const createList = [...createEdges.values()].map((e) => ({ ...e, classes: [...e.classes] }));
const blockCreates = aggregate(createList, 'create');
const eventEdgeList = [...eventEdges.values()].map((e) => ({ from: e.from, to: e.to, events: [...e.events.values()] }));
const blockEvents = aggregate(eventEdgeList, 'event').map((x) => {
  const names = new Set();
  for (const f of x.files) for (const ev of f.events) names.add(ev.event);
  return { ...x, eventNames: [...names].sort() };
});

// ─────────────────────────── 循环依赖(Tarjan SCC,运行时 import)
function sccs(nodes, adj) {
  let idx = 0;
  const stack = [];
  const on = new Set();
  const index = new Map();
  const low = new Map();
  const out = [];
  const strong = (v) => {
    index.set(v, idx); low.set(v, idx); idx++;
    stack.push(v); on.add(v);
    for (const w of adj.get(v) || []) {
      if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      out.push(comp);
    }
  };
  for (const v of nodes) if (!index.has(v)) strong(v);
  return out;
}
function cycleAnalysis(edgeFilter) {
  const adj = new Map();
  for (const e of fileDepList) {
    if (!edgeFilter(e)) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const comps = sccs([...fileSet].sort(), adj).filter((c) => c.length > 1 || (adj.get(c[0]) || []).includes(c[0]));
  return comps.map((comp) => {
    const set = new Set(comp);
    const inner = fileDepList.filter((e) => edgeFilter(e) && set.has(e.from) && set.has(e.to))
      .map((e) => ({ from: e.from, to: e.to, sites: e.sites.filter((s) => edgeFilter({ runtime: s.runtime })).map((s) => ({ f: s.f, l: s.l })) }));
    // 最短环:从最小成员 BFS 回到自身
    const start = [...comp].sort()[0];
    const prev = new Map();
    const q = [start];
    const seen = new Set([start]);
    let found = null;
    while (q.length && !found) {
      const v = q.shift();
      for (const w of adj.get(v) || []) {
        if (!set.has(w)) continue;
        if (w === start) { found = v; break; }
        if (!seen.has(w)) { seen.add(w); prev.set(w, v); q.push(w); }
      }
    }
    const pathNodes = [];
    if (found) {
      let v = found;
      while (v !== undefined) { pathNodes.unshift(v); v = prev.get(v); }
      pathNodes.push(start);
    }
    const example = [];
    for (let i = 0; i + 1 < pathNodes.length; i++) {
      const e = fileDeps.get(`${pathNodes[i]}→${pathNodes[i + 1]}`);
      const s = e.sites.find((x) => edgeFilter({ runtime: x.runtime })) || e.sites[0];
      example.push({ from: pathNodes[i], to: pathNodes[i + 1], f: s.f, l: s.l });
    }
    return {
      size: comp.length,
      files: comp.sort(),
      lines: comp.reduce((a, f) => a + fileInfo.get(f).lines, 0),
      blocks: [...new Set(comp.map((f) => fileInfo.get(f).block))],
      includesBoundary: comp.some((f) => fileInfo.get(f).boundary),
      innerEdgeCount: inner.length,
      innerEdges: inner,
      example,
    };
  }).sort((a, b) => b.size - a.size);
}
const cyclesRuntime = cycleAnalysis((e) => e.runtime);
const cyclesAll = cycleAnalysis(() => true);
// 块级双向依赖(运行时)
const blockPairs = [];
for (const d of blockDeps) {
  const back = blockDeps.find((x) => x.from === d.to && x.to === d.from);
  if (back && d.from < d.to) blockPairs.push({ a: d.from, b: d.to, ab: d.count, ba: back.count });
}

// ─────────────────────────── 分层方向
// 架构文档 §3.1 列出的"Game 提取模块"(文档说 Game 的职责委托给它们);是否算组装层文档没说,只作标注
const GAME_EXTRACTED = /^src\/core\/(ActionRegistry|InteractionCoordinator|EventBridge|DebugTools)\.ts$/;
const layerViolations = [];
const layerViolationsTypeOnly = [];
const unlayeredEdges = [];
for (const e of fileDepList) {
  const A = fileInfo.get(e.from);
  const B = fileInfo.get(e.to);
  if (A.boundary || B.boundary) continue; // 边界目录单列在"开发调试引用"
  if (A.assembly) continue; // 组装层例外(norms 律 11)
  if (A.rank != null && B.rank != null) {
    if (A.rank < B.rank) {
      const rec = { from: e.from, to: e.to, fromLayer: A.layer, toLayer: B.layer, extracted: GAME_EXTRACTED.test(e.from), sites: e.sites.filter((s) => s.runtime === e.runtime).map((s) => ({ f: s.f, l: s.l, names: s.names })) };
      (e.runtime ? layerViolations : layerViolationsTypeOnly).push(rec);
    }
  } else if ((A.rank == null) !== (B.rank == null) || (A.rank == null && B.rank == null)) {
    if (UNLAYERED_DIRS.some((r) => r.test(e.from)) || UNLAYERED_DIRS.some((r) => r.test(e.to))) {
      unlayeredEdges.push({ from: e.from, to: e.to, fromLayer: A.layer, toLayer: B.layer, runtime: e.runtime, sites: e.sites.map((s) => ({ f: s.f, l: s.l })) });
    }
  }
}
const sortV = (a, b) => (a.fromLayer + a.from).localeCompare(b.fromLayer + b.from);
layerViolations.sort(sortV);
layerViolationsTypeOnly.sort(sortV);
// 组装层自身的跨层依赖(例外,只计数展示)
const assemblyEdges = fileDepList.filter((e) => fileInfo.get(e.from).assembly && e.runtime).length;

// ─────────────────────────── 开发/调试代码被正式运行路径引用
const devRefs = [];
for (const i of raw.imports) {
  if (i.kind !== 'internal' || !fileSet.has(i.to)) continue;
  const A = fileInfo.get(i.from);
  const B = fileInfo.get(i.to);
  if (A.boundary) continue;
  const targetIsBoundary = B.boundary;
  const targetIsDebugName = B.debugName && !A.debugName;
  if (!targetIsBoundary && !targetIsDebugName) continue;
  const uses = i.form === 'dynamic'
    ? [{ f: i.from, l: i.line, name: 'import(', by: i.enclosing, devGuarded: !!i.devGuarded }]
    : (i.usages || []).filter((u) => !u.typePos).map((u) => ({ ...u, f: i.from, l: u.line }));
  devRefs.push({
    from: i.from, to: i.to, line: i.line, runtime: i.runtime, form: i.form,
    rule: targetIsBoundary ? 'boundary-dir' : 'debug-name',
    names: i.names,
    valueUses: uses.length,
    devGuardedUses: uses.filter((u) => u.devGuarded).length,
    uses: uses.map((u) => ({ f: i.from, l: u.l, name: u.name, by: u.by ?? u.enclosing, devGuarded: u.devGuarded })),
    devGuardedImport: i.devGuarded,
  });
}
devRefs.sort((a, b) => (a.rule + a.from + a.line).localeCompare(b.rule + b.from + b.line));

// ─────────────────────────── 其它统计
const largest = [...raw.files].filter((f) => !f.path.endsWith('.d.ts')).sort((a, b) => b.lines - a.lines).slice(0, 20)
  .map((f, i) => ({ rank: i + 1, path: f.path, lines: f.lines, block: fileInfo.get(f.path).block }));

const blocks = BLOCKS.map((b) => {
  const members = [...fileInfo.values()].filter((f) => f.block === b.id).sort((x, y) => y.lines - x.lines);
  return {
    id: b.id, name: b.name, color: b.color, boundary: !!b.boundary, layerHint: b.layer,
    rules: b.rules.map((r) => r.source),
    fileCount: members.length, lines: members.reduce((a, f) => a + f.lines, 0),
    files: members.map((f) => ({ path: f.path, lines: f.lines, layer: f.layer, debugName: f.debugName, assembly: f.assembly })),
  };
});

// 动作注册表:按注册文件分组
const actionsByFile = {};
for (const a of raw.actions) (actionsByFile[a.file] ||= []).push({ type: a.type, l: a.line });

const analysis = {
  meta: {
    generatedBy: 'runtime_map/scripts/analyze.mjs', from: 'data/raw.json',
    counts: {
      files: raw.files.length, lines: raw.files.reduce((a, f) => a + f.lines, 0),
      internalImports: internalImports.length, runtimeImports: internalImports.filter((i) => i.runtime).length,
      fileDeps: fileDepList.length, runtimeFileDeps: fileDepList.filter((e) => e.runtime).length,
      externalImports: externalImports.length, assetImports: assetImports.length,
      news: raw.news.length, internalNews: raw.news.filter((n) => n.target.kind === 'internal').length,
      events: eventList.length, eventCalls: raw.events.length, actions: raw.actions.length,
      busBindings: BUS_BINDINGS,
      assemblyRuntimeDeps: assemblyEdges,
    },
    layersRule: {
      source: 'agent_docs/runtime/norms.md 律 11:依赖只能自上而下(UI→系统→渲染→核心→数据),唯一例外是组装层',
      layers: LAYERS.map((L) => ({ id: L.id, name: L.name, rank: L.rank, dirs: L.dirs.map((r) => r.source) })),
      assembly: ASSEMBLY_FILES.map((r) => r.source),
      unlayered: UNLAYERED_DIRS.map((r) => r.source),
      runtimeRule: 'norms 律 11 附注:"判一处跨层引用要不要管,就看它编译后还在不在"——本页以 TypeScript transpileModule 编译后仍保留的 import 为运行时依赖',
      cites: [
        { f: 'agent_docs/runtime/norms.md', l: 42, m: '依赖只能自上而下(UI→系统→渲染→核心→数据),唯一例外是组装层', why: '分层方向' },
        { f: 'agent_docs/runtime/norms.md', l: 56, m: '通用工具层里有一处真的在运行时依赖上层', why: '通用工具层在上层之下' },
        { f: 'docs/游戏架构设计文档.md', l: 42, m: '作为引导/组装层（bootstrap）', why: '组装层 = Game' },
        { f: 'docs/游戏架构设计文档.md', l: 79, m: '**ActionRegistry**', why: 'Game 提取模块' },
      ],
    },
  },
  files: [...fileInfo.values()],
  blocks,
  blockEdges: { dep: blockDeps, typedep: blockTypeDeps, create: blockCreates, event: blockEvents },
  fileEdges: { deps: fileDepList, creates: createList, events: eventEdgeList },
  externalPackages: Object.entries(externalImports.reduce((m, i) => ((m[i.to] ||= []).push({ f: i.from, l: i.line, runtime: i.runtime }), m), {}))
    .map(([pkg, sites]) => ({ pkg, count: sites.length, runtime: sites.filter((s) => s.runtime).length, sites })),
  assetImports: assetImports.map((i) => ({ from: i.from, l: i.line, to: i.to, query: i.query })),
  events: eventList,
  cycles: { runtime: cyclesRuntime, all: cyclesAll, blockPairs },
  layering: { violations: layerViolations, typeOnly: layerViolationsTypeOnly, unlayered: unlayeredEdges },
  devRefs,
  largest,
  actionsByFile,
};
fs.writeFileSync(path.join(MAP_DIR, 'data', 'analysis.json'), JSON.stringify(analysis, null, 1));
console.log(`analyze: ${blocks.length} blocks, block dep edges ${blockDeps.length}, event edges ${blockEvents.length}, `
  + `runtime cycles ${cyclesRuntime.length} (largest ${cyclesRuntime[0]?.size ?? 0}), layer violations ${layerViolations.length} (+${layerViolationsTypeOnly.length} type-only), `
  + `events ${eventList.length} (emit-no-listener ${eventList.filter((g) => g.emitNoListener).length}, listen-no-emitter ${eventList.filter((g) => g.listenNoEmitter).length}), devRefs ${devRefs.length}`);
