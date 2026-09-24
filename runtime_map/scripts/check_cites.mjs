#!/usr/bin/env node
// 出处校验:递归扫描 JSON,凡是 {f, l, m} 形状的对象都当作一条出处,
// 检查 仓库文件 f 的第 l 行(1 起算)确实包含子串 m。不符即报错。
// 用法: node runtime_map/scripts/check_cites.mjs runtime_map/diagrams/*.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cache = new Map();
function lines(f) {
  if (!cache.has(f)) {
    const abs = path.join(ROOT, f);
    cache.set(f, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n') : null);
  }
  return cache.get(f);
}

export function checkCite(c) {
  if (typeof c.f !== 'string' || !Number.isInteger(c.l) || typeof c.m !== 'string' || !c.m.length) return '出处字段不全(要 f/l/m)';
  const ls = lines(c.f);
  if (!ls) return `文件不存在: ${c.f}`;
  const text = ls[c.l - 1];
  if (text === undefined) return `行号越界: ${c.f}:${c.l}(共 ${ls.length} 行)`;
  if (!text.includes(c.m)) {
    // 附近找一找,给出修正提示
    for (let d = 1; d <= 40; d++) {
      for (const k of [c.l - d, c.l + d]) {
        if (ls[k - 1] !== undefined && ls[k - 1].includes(c.m)) return `第 ${c.l} 行不含 "${c.m}";最近在第 ${k} 行`;
      }
    }
    return `第 ${c.l} 行不含 "${c.m}"(附近 ±40 行也没有)`;
  }
  return null;
}

export function collectCites(obj, at = '$', out = []) {
  if (Array.isArray(obj)) obj.forEach((v, i) => collectCites(v, `${at}[${i}]`, out));
  else if (obj && typeof obj === 'object') {
    if ('f' in obj && 'l' in obj && 'm' in obj) out.push({ at, cite: obj });
    for (const [k, v] of Object.entries(obj)) if (v && typeof v === 'object') collectCites(v, `${at}.${k}`, out);
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let bad = 0;
  let total = 0;
  for (const p of process.argv.slice(2)) {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const cites = collectCites(data);
    for (const { at, cite } of cites) {
      total++;
      const err = checkCite(cite);
      if (err) { bad++; console.log(`✗ ${path.basename(p)} ${at}: ${err}`); }
    }
  }
  console.log(`check_cites: ${total} 条出处,${bad} 条不符`);
  process.exit(bad ? 1 : 0);
}
