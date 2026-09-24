#!/usr/bin/env node
// 组装 index.html:把 data/*.json 与 diagrams/*.json 压成一份页面数据,内嵌进 page_template.html。
// 页面不读任何本地文件(双击即开)。所有图上的出处在这里统一校验:{f,l,m} 形状的出处,
// 第 l 行必须逐字包含 m,否则构建失败。被引用到的源码行一并内嵌,点开出处就能看到那一行代码。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCite, collectCites } from './check_cites.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAP_DIR = path.resolve(HERE, '..');
const ROOT = path.resolve(MAP_DIR, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(MAP_DIR, p), 'utf8'));
const tryJson = (p) => (fs.existsSync(path.join(MAP_DIR, p)) ? readJson(p) : null);

const raw = readJson('data/raw.json');
const an = readJson('data/analysis.json');
const DIAGRAMS = ['boot', 'frame', 'scene', 'state', 'render', 'docs', 'disabled', 'uncertain'];
const diagrams = {};
for (const d of DIAGRAMS) diagrams[d] = tryJson(`diagrams/${d}.json`);
const verification = tryJson('data/verification.json');

let commit = 'unknown';
try { commit = execSync('git log -1 --format=%H -- src', { cwd: ROOT }).toString().trim(); } catch { /* not a repo */ }

// ─────────────────────── 1) 图上出处校验
let bad = 0;
let totalCites = 0;
for (const d of DIAGRAMS) {
  if (!diagrams[d]) { console.warn(`build: 缺 diagrams/${d}.json`); continue; }
  for (const { at, cite } of collectCites(diagrams[d])) {
    totalCites++;
    const err = checkCite(cite);
    if (err) { bad++; console.error(`✗ ${d} ${at}: ${err}`); }
  }
}
for (const { at, cite } of collectCites(an.meta.layersRule)) {
  totalCites++;
  const err = checkCite(cite);
  if (err) { bad++; console.error(`✗ layersRule ${at}: ${err}`); }
}
if (verification) {
  for (const { at, cite } of collectCites(verification)) {
    totalCites++;
    const err = checkCite(cite);
    if (err) { bad++; console.error(`✗ verification ${at}: ${err}`); }
  }
}
if (bad) {
  console.error(`build: ${bad} 条出处不符,拒绝生成`);
  process.exit(1);
}

// ─────────────────────── 2) 路径表 + 源码行收集
const paths = [];
const pathIdx = new Map();
const P = (p) => {
  if (!pathIdx.has(p)) { pathIdx.set(p, paths.length); paths.push(p); }
  return pathIdx.get(p);
};
for (const f of an.files) P(f.path);

const fileLines = new Map();
const linesOf = (p) => {
  if (!fileLines.has(p)) {
    const abs = path.join(ROOT, p);
    fileLines.set(p, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n') : []);
  }
  return fileLines.get(p);
};
const src = {}; // "pi:l" → 行文本
const want = (p, l, ctx = 0) => {
  const ls = linesOf(p);
  const pi = P(p);
  for (let k = l - ctx; k <= l + ctx; k++) {
    if (k < 1 || k > ls.length) continue;
    const key = `${pi}:${k}`;
    if (!(key in src)) {
      const t = ls[k - 1].replace(/\t/g, '  ');
      src[key] = t.length > 240 ? t.slice(0, 239) + '…' : t;
    }
  }
};
// 图(2~6 与清单)里的出处:带上下各 2 行
for (const d of DIAGRAMS) if (diagrams[d]) for (const { cite } of collectCites(diagrams[d])) want(cite.f, cite.l, 2);
if (verification) for (const { cite } of collectCites(verification)) want(cite.f, cite.l, 3);
for (const { cite } of collectCites(an.meta.layersRule)) want(cite.f, cite.l, 1);

// ─────────────────────── 3) 压缩结构数据
const fi = (p) => P(p);
const files = an.files.map((f) => ({ p: fi(f.path), n: f.lines, b: f.block, L: f.layer, dbg: f.debugName ? 1 : 0, asm: f.assembly ? 1 : 0, bd: f.boundary ? 1 : 0 }));

const deps = an.fileEdges.deps.map((e) => {
  for (const s of e.sites) want(s.f, s.l);
  return [fi(e.from), fi(e.to), e.runtime ? 1 : 0, e.sites.map((s) => [s.l, s.runtime ? 1 : 0, s.form === 'static' ? 0 : s.form === 'dynamic' ? 1 : s.form === 're-export' ? 2 : 3])];
});
const creates = an.fileEdges.creates.map((e) => {
  for (const s of e.sites) want(s.f, s.l);
  return [fi(e.from), fi(e.to), e.classes, e.sites.map((s) => [s.l, s.cls, s.by, s.assignedTo || '', s.injected])];
});
const events = an.events.map((g) => {
  for (const s of [...g.emit, ...g.on, ...g.off]) want(s.f, s.l);
  return {
    e: g.event, bus: g.bus,
    emit: g.emit.map((s) => [fi(s.f), s.l, s.by, s.how, s.dev ? 1 : 0]),
    on: g.on.map((s) => [fi(s.f), s.l, s.by, s.handler || '', s.how, s.viaBinding ? 1 : 0, s.dev ? 1 : 0]),
    off: g.off.map((s) => [fi(s.f), s.l, s.by]),
    eNL: g.emitNoListener ? 1 : 0, lNE: g.listenNoEmitter ? 1 : 0,
    rt: g.runtimeOnly,
  };
});
const holds = raw.holds.map((h) => {
  want(h.file, h.line);
  return [fi(h.file), h.line, h.holder, h.field, h.via, h.held.map((c) => [c.name, fi(c.file)])];
});
const actions = raw.actions.map((a) => { want(a.file, a.line); return [a.type, fi(a.file), a.line, a.enclosing]; });
const states = raw.states.map((s) => { want(s.file, s.line); return [fi(s.file), s.line, s.enclosing, s.method, s.arg]; });
const frameHooks = raw.frameHooks.map((s) => { want(s.file, s.line); return [s.kind, fi(s.file), s.line, s.enclosing]; });
const dynamicRaw = raw.dynamic.map((s) => { want(s.file, s.line); return [s.kind, fi(s.file), s.line, s.enclosing, s.text, s.note]; });
const globals = raw.globalsExposed.map((s) => { want(s.file, s.line); return [fi(s.file), s.line, s.enclosing, s.text, s.devGuarded ? 1 : 0]; });
const wrappers = raw.eventWrappers.map((w) => { want(w.file, w.line); return [w.name, fi(w.file), w.line, w.op]; });

// 异常页
const cyc = (list) => list.map((c) => {
  for (const e of c.innerEdges) for (const s of e.sites) want(s.f, s.l);
  for (const s of c.example) want(s.f, s.l);
  return { size: c.size, lines: c.lines, blocks: c.blocks, bd: c.includesBoundary ? 1 : 0, files: c.files.map(fi),
    inner: c.innerEdges.map((e) => [fi(e.from), fi(e.to), e.sites.map((s) => s.l)]), example: c.example.map((s) => [fi(s.from), fi(s.to), s.l]) };
});
const viol = (list) => list.map((v) => {
  for (const s of v.sites) want(s.f, s.l);
  return [fi(v.from), fi(v.to), v.fromLayer, v.toLayer, v.sites.map((s) => [s.l, (s.names || []).join(', ')]), v.extracted ? 1 : 0];
});
const unl = an.layering.unlayered.map((v) => {
  for (const s of v.sites) want(s.f, s.l);
  return [fi(v.from), fi(v.to), v.fromLayer, v.toLayer, v.runtime ? 1 : 0, v.sites.map((s) => s.l)];
});
const devRefs = an.devRefs.map((r) => {
  want(r.from, r.line);
  for (const u of r.uses) want(u.f, u.l);
  return { from: fi(r.from), to: fi(r.to), l: r.line, rt: r.runtime ? 1 : 0, form: r.form, rule: r.rule, names: r.names,
    uses: r.uses.map((u) => [u.l, u.name, u.by, u.devGuarded ? 1 : 0]) };
});
for (const b of an.meta.counts.busBindings || []) want(b.cite.f, b.cite.l, 1);

const page = {
  meta: {
    commit, repo: 'wubugui/GameDraft', generatedAt: process.env.RUNTIME_MAP_DATE || new Date().toISOString().slice(0, 10),
    counts: an.meta.counts, layersRule: an.meta.layersRule, totalCites,
    extractor: raw.meta,
  },
  paths,
  blocks: an.blocks.map((b) => ({ id: b.id, name: b.name, color: b.color, boundary: b.boundary, layerHint: b.layerHint, rules: b.rules, fileCount: b.fileCount, lines: b.lines, files: b.files.map((f) => fi(f.path)) })),
  files, deps, creates, events, holds, actions, states, frameHooks, dynamicRaw, globals, wrappers,
  external: an.externalPackages.map((x) => ({ pkg: x.pkg, count: x.count, runtime: x.runtime })),
  anomalies: {
    largest: an.largest.map((x) => ({ p: fi(x.path), n: x.lines, b: x.block })),
    cyclesRuntime: cyc(an.cycles.runtime), cyclesAll: cyc(an.cycles.all), blockPairs: an.cycles.blockPairs,
    violations: viol(an.layering.violations), violationsType: viol(an.layering.typeOnly), unlayered: unl,
    devRefs,
  },
  diagrams,
  verification,
  src,
};

const json = JSON.stringify(page).replace(/</g, '\\u003c');
const tpl = fs.readFileSync(path.join(HERE, 'page_template.html'), 'utf8');
const html = tpl.replace('/*__PAGE_DATA__*/null', () => json);
fs.writeFileSync(path.join(MAP_DIR, 'index.html'), html);
console.log(`build: index.html ${(html.length / 1024).toFixed(0)} KB, 出处 ${totalCites} 条全部通过, 内嵌源码行 ${Object.keys(src).length}`);
