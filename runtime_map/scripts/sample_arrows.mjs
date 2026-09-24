#!/usr/bin/env node
// 抽样:从页面上画出来的全部箭头里随机抽 15 条,供回代码核对。输出 data/sample.json。
// 箭头池:
//   模块图  依赖(文件级运行时 import 语句)、事件(同名事件的 发处→收处)、创建(new 处)
//   图 2~6  相邻两步之间的"先后"箭头(启动各阶段内及阶段交界、一帧、场景生命周期、存/读档流程、渲染管线)
// 分层随机:模块图 6 条(依赖 3、事件 2、创建 1),图 2~6 各抽 2 条 + 渲染再加 1 条 = 9 条。
// 随机源:mulberry32,种子 = 代码版本(commit)前 8 位十六进制 —— 同一版本重跑结果相同。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(MAP_DIR, '..');
const J = (p) => JSON.parse(fs.readFileSync(path.join(MAP_DIR, p), 'utf8'));
const raw = J('data/raw.json');
const an = J('data/analysis.json');
const dg = Object.fromEntries(['boot', 'frame', 'scene', 'state', 'render'].map((k) => [k, J(`diagrams/${k}.json`)]));
const commit = execSync('git log -1 --format=%H -- src', { cwd: ROOT }).toString().trim();
const seed = parseInt(commit.slice(0, 8), 16) >>> 0;

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(seed);
// 注:池只含主干步骤(见 seqPairs)
const pick = (pool, n) => {
  const a = pool.slice();
  const out = [];
  while (out.length < n && a.length) out.push(a.splice(Math.floor(rnd() * a.length), 1)[0]);
  return out;
};

const lineText = (f, l) => (fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')[l - 1] || '').trim();
const firstCite = (s) => (s.cites || [])[0];

// ── 模块图池
const depPool = raw.imports.filter((i) => i.kind === 'internal' && i.runtime && an.files.some((f) => f.path === i.to))
  .map((i) => {
    const t = lineText(i.from, i.line);
    return { source: '模块图 · 依赖', arrow: `${i.from} → ${i.to}`, claim: `${i.from} 第 ${i.line} 行起的 import 语句引入了 ${i.to}("${i.spec}"),且编译后仍保留(运行时依赖)`, cites: [{ f: i.from, l: i.line, m: t.includes(i.spec) ? i.spec : t.slice(0, 24) }] };
  });
const evtPool = [];
for (const g of an.events) {
  if (g.bus !== 'main') continue;
  for (const e of g.emit) for (const o of g.on) if (e.f !== o.f) {
    evtPool.push({ source: '模块图 · 事件', arrow: `${e.f} ─"${g.event}"→ ${o.f}`, claim: `${e.f}:${e.l} 在主事件总线上发出 "${g.event}",${o.f}:${o.l} 在主事件总线上收听同名事件`, cites: [{ f: e.f, l: e.l, m: lineText(e.f, e.l).includes(g.event) ? g.event : lineText(e.f, e.l).slice(0, 30) }, { f: o.f, l: o.l, m: lineText(o.f, o.l).includes(g.event) ? g.event : lineText(o.f, o.l).slice(0, 30) }] });
  }
}
const crtPool = raw.news.filter((n) => n.target.kind === 'internal' && n.target.file !== n.file)
  .map((n) => ({ source: '模块图 · 创建', arrow: `${n.file} ─new→ ${n.target.file}`, claim: `${n.file}:${n.line}(${n.enclosing})里 new 了 ${n.target.name},该类定义在 ${n.target.file}`, cites: [{ f: n.file, l: n.line, m: n.target.name }] }));

// ── 顺序图池:相邻两步
// 只取主干上相邻的两步:track 为 branch(分叉)/entry(并列入口)/side(旁路)的步骤不构成"先后"箭头
const seqPairs = (name, steps0) => {
  const steps = steps0.filter((x) => !x.track || x.track === 'main');
  const out = [];
  for (let i = 0; i + 1 < steps.length; i++) {
    const a = steps[i];
    const b = steps[i + 1];
    const ca = firstCite(a);
    const cb = firstCite(b);
    if (!ca || !cb) continue;
    out.push({ source: name, arrow: `「${a.label}」→「${b.label}」`, claim: `图上画的是先「${a.label}」后「${b.label}」`, cites: [ca, cb], ids: [a.id, b.id] });
  }
  return out;
};
const bootSteps = (dg.boot.phases || []).flatMap((p) => p.steps || []);
const bootPool = seqPairs('图 2 · 启动', bootSteps);
const framePool = seqPairs('图 3 · 一帧', [...(dg.frame.steps || [])].sort((a, b) => a.order - b.order));
const scenePool = seqPairs('图 4 · 场景生命周期', [...(dg.scene.steps || [])].sort((a, b) => a.order - b.order));
const statePool = [...seqPairs('图 5 · 存档流程', [...(dg.state.saveFlow || [])].sort((a, b) => a.order - b.order)), ...seqPairs('图 5 · 读档流程', [...(dg.state.loadFlow || [])].sort((a, b) => a.order - b.order))];
const renderPool = seqPairs('图 6 · 渲染管线', [...(dg.render.passes || [])].sort((a, b) => a.order - b.order));

const picked = [
  ...pick(depPool, 3), ...pick(evtPool, 2), ...pick(crtPool, 1),
  ...pick(bootPool, 2), ...pick(framePool, 2), ...pick(scenePool, 2), ...pick(statePool, 2), ...pick(renderPool, 1),
];
const out = {
  seed, commit,
  method: `从页面画出的全部箭头里分层随机抽 15 条:模块图 6 条(依赖 3 / 事件 2 / 创建 1),图 2~6 的"先后"箭头 9 条(启动 2 / 一帧 2 / 场景 2 / 存读档 2 / 渲染 1)。随机源 mulberry32,种子 = 代码版本前 8 位(0x${seed.toString(16)}),同一版本可复现。`,
  poolSizes: { dep: depPool.length, evt: evtPool.length, crt: crtPool.length, boot: bootPool.length, frame: framePool.length, scene: scenePool.length, state: statePool.length, render: renderPool.length },
  items: picked,
};
fs.writeFileSync(path.join(MAP_DIR, 'data', 'sample.json'), JSON.stringify(out, null, 2));
console.log(`sample: ${picked.length} 条;池 ${JSON.stringify(out.poolSizes)}`);
