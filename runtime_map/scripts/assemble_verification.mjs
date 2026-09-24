#!/usr/bin/env node
// 汇总抽样核对:data/sample.json(抽出的 15 条)+ data/sample_checks.json(独立代理逐条回代码核对的原始结果)
// → data/verification.json。另外对每条做一遍脚本机械复核(对照 raw.json 与源码行),两路结论都写进去。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCite } from './check_cites.mjs';

const MAP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(MAP_DIR, '..');
const J = (p) => JSON.parse(fs.readFileSync(path.join(MAP_DIR, p), 'utf8'));
const sample = J('data/sample.json');
const checks = J('data/sample_checks.json');
const raw = J('data/raw.json');
const outlines = J('data/outlines.json');

const lineOf = (f, l) => (fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')[l - 1] || '');

/** 某行属于哪个预抽函数大纲(没有就 null) */
const fnOf = (f, l) => {
  const o = outlines.find((x) => x.file === f && x.startLine <= l && l <= x.endLine);
  return o ? o.fn : null;
};

function mechanical(it) {
  const c = it.cites;
  if (it.source.includes('依赖')) {
    const hit = raw.imports.find((i) => i.from === c[0].f && i.line === c[0].l && it.arrow.endsWith(i.to));
    return hit ? { ok: hit.runtime, text: `raw.json:该行的 import 指向 ${hit.to},编译后保留的绑定 ${hit.runtimeNames.join(', ') || '无'}` } : { ok: false, text: 'raw.json 里找不到这条 import' };
  }
  if (it.source.includes('事件')) {
    const ev = (it.arrow.match(/"([^"]+)"/) || [])[1];
    const em = raw.events.find((e) => e.file === c[0].f && e.line === c[0].l && e.op === 'emit' && e.event === ev && e.bus === 'main');
    const on = raw.events.find((e) => e.file === c[1].f && e.line === c[1].l && (e.op === 'on' || e.op === 'once') && e.event === ev && e.bus === 'main');
    return { ok: !!(em && on), text: `raw.json:发处${em ? '在' : '不在'}、收处${on ? `在(${on.how})` : '不在'},事件名 "${ev}"` };
  }
  if (it.source.includes('创建')) {
    const n = raw.news.find((x) => x.file === c[0].f && x.line === c[0].l);
    return n ? { ok: it.arrow.endsWith(n.target.file), text: `raw.json:该行 new ${n.target.name}(定义于 ${n.target.file}),所在函数 ${n.enclosing}` } : { ok: false, text: 'raw.json 里找不到这次 new' };
  }
  // 先后箭头:两端出处都在;同文件同函数时比行号
  const e0 = checkCite(c[0]);
  const e1 = checkCite(c[1]);
  if (e0 || e1) return { ok: false, text: `出处不符:${e0 || e1}` };
  const f0 = fnOf(c[0].f, c[0].l);
  const f1 = fnOf(c[1].f, c[1].l);
  if (c[0].f === c[1].f && f0 && f0 === f1) {
    return { ok: c[0].l < c[1].l, text: `两端同在 ${f0} 内:第 ${c[0].l} 行 ${c[0].l < c[1].l ? '<' : '≥'} 第 ${c[1].l} 行` };
  }
  return { ok: null, text: `两端不在同一个预抽函数里(${c[0].f}:${c[0].l} / ${c[1].f}:${c[1].l}),先后只能顺调用链核,见代理核对` };
}

const items = sample.items.map((it, i) => {
  const ck = checks[i];
  if (!ck || ck.arrow !== it.arrow) throw new Error(`第 ${i + 1} 条的核对结果与抽样对不上`);
  const mech = mechanical(it);
  const seen = new Set();
  const cites = [];
  for (const c of [...it.cites, ...(ck.check.cites || [])]) {
    const k = `${c.f}:${c.l}`;
    if (seen.has(k) || checkCite(c)) continue;
    seen.add(k);
    cites.push(c);
  }
  return {
    source: it.source, arrow: it.arrow, claim: it.claim,
    result: ck.check.result === 'ok' && mech.ok !== false ? 'ok' : 'mismatch',
    agentResult: ck.check.result, note: ck.check.note,
    mechanical: mech,
    cites,
  };
});
const ok = items.filter((x) => x.result === 'ok').length;
const out = {
  method: `${sample.method} 每条交给一个独立代理回代码核对(只看代码、默认怀疑,依赖看是否编译后仍在、事件看是否同一条主总线同名、创建看 new 与类定义、先后看实际执行顺序);另由脚本对照 raw.json 与源码行机械复核一遍。两路都通过才记"一致"。`,
  seed: sample.seed, commit: sample.commit, poolSizes: sample.poolSizes,
  summary: `代理核对 ${items.filter((x) => x.agentResult === 'ok').length}/15 属实;脚本机械复核 ${items.filter((x) => x.mechanical.ok === true).length} 条直接判定一致、${items.filter((x) => x.mechanical.ok === null).length} 条跨函数交由代理顺调用链核对、${items.filter((x) => x.mechanical.ok === false).length} 条不一致`,
  items,
};
fs.writeFileSync(path.join(MAP_DIR, 'data', 'verification.json'), JSON.stringify(out, null, 2));
console.log(`verification: ${ok}/${items.length} 一致;${out.summary}`);
