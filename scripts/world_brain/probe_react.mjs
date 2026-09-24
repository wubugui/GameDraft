/**
 * 查"出事以后这个人躲 / 跑 / 凑过去看 / 接着做"为什么答不对（2026-09-22 制作人：一定是提示词不对，往死里查）。
 *
 * state 一律用**游戏自己拼出来的**（真跑游戏放雷符、在几个时刻 `captureSnapshots()` 抓下来的夹具，
 * 时间和物理关系都由游戏的快照写明——出事前就这样还是出事后才换的、事离他多远在哪边、跟着谁那一下来的），
 * 只比**题怎么问**：
 * - 是非题照旧（"X会躲到屋檐底下去"）；
 * - 是非题带上"刚才街上这一下，X 马上……"；
 * - 四选一选择题，正序 / 倒序各问一遍（查排位偏向），以及两遍取平均（确定的去偏法，不掷骰子）。
 *
 * 判对错用各人设定里**写明了**的反应（袍哥"真遇到邪门的事比哪个跑得都快"、糖画娃"爱凑热闹"……），其余不计分。
 *
 *   node --experimental-strip-types --no-warnings scripts/world_brain/probe_react.mjs --backend jev \
 *        --calm scripts/world_brain/fixtures/jev_街巷_平常十字口.json \
 *        --event scripts/world_brain/fixtures/jev_街巷_雷符_掷符.json [--event ...落雷.json]
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { assembleState, DEFAULT_RECIPES } from '../../src/systems/worldBrain/stateAssembly.ts';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const all = (k) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));
const backend = opt('backend') === 'laya' ? 'laya' : 'jev';
const base = `http://127.0.0.1:${Number(opt('port') ?? 5191)}/__gamedraft-api/jev`;
const scene = JSON.parse(readFileSync(new URL('../../public/assets/data/world_brain/jev_街巷.json', import.meta.url), 'utf-8'));
const BUDGET = backend === 'laya' ? 1500 : undefined;
const load = (f) => JSON.parse(readFileSync(f, 'utf-8')).map((s) => ({ ...s, setting: scene.setting, brief: scene.brief }));
const calm = load(opt('calm'));
const scenes = all('event').map((f) => ({ name: basename(f, '.json').replace(/^jev_街巷_/, ''), snaps: load(f) }));

/** 设定里写明了的反应（其余不计分）：hide 躲 / flee 跑 / look 凑过去看 / carry 接着做 */
const EXPECT = {
  袍哥: 'flee', 守糖画的娃: 'look', 跑腿伙计: 'look', 洋行伙计: 'hide', 巡街的刀差: 'look', 墙根歇脚的差役: 'hide',
  滚铁环的娃: 'look', 土狗: 'hide', 花母鸡: 'flee', 黑母鸡: 'flee', 看棋的老汉: 'carry', 洗衣婆: 'hide', 瘦猫: 'flee',
};
const NAME = { hide: '躲', flee: '跑', look: '看', carry: '做' };
const OPT = { hide: '躲到屋檐底下去', flee: '撒腿跑开', look: '凑过去看是啥子', carry: '接着做手上的事' };
const KEYS = ['hide', 'flee', 'look', 'carry'];

function noulSet(pairs) {
  const questions = {};
  const keyOf = {};
  pairs.forEach(([k, text], i) => { questions[`q${i}`] = { type: 'noul', instructions: text }; keyOf[`q${i}`] = k; });
  return { questions, read: (ans) => Object.fromEntries(Object.entries(keyOf).map(([q, k]) => [k, ans[q]?.noul])) };
}
function choice(instructions, order) {
  const letters = 'abcd';
  const criteria = {};
  const keyOf = {};
  order.forEach((k, i) => { criteria[letters[i]] = OPT[k]; keyOf[letters[i]] = k; });
  return {
    questions: { c: { type: 'choice', instructions, criteria } },
    read: (ans) => Object.fromEntries(Object.entries(keyOf).map(([l, k]) => [k, ans.c?.probabilities?.[l]])),
  };
}
/** 问法：出事那一刻问什么 / 平静时问什么（平静时题面不能提"刚才这一下"，不然题本身自相矛盾） */
const ASK = {
  '是非题（原样）': {
    hot: (x) => noulSet(KEYS.map((k) => [k, `${x}会${OPT[k]}。`])),
    calm: (x) => noulSet(KEYS.map((k) => [k, `${x}会${OPT[k]}。`])),
  },
  '是非题（刚才这一下，马上）': {
    hot: (x) => noulSet(KEYS.map((k) => [k, `刚才街上这一下，${x}马上${OPT[k]}。`])),
    calm: (x) => noulSet(KEYS.map((k) => [k, `${x}接下来${OPT[k]}。`])),
  },
  '选择题（正序）': {
    hot: (x) => choice(`刚才街上这一下，${x}头一个反应是啥子？`, KEYS),
    calm: (x) => choice(`${x}接下来会做啥子？`, KEYS),
  },
  '选择题（倒序）': {
    hot: (x) => choice(`刚才街上这一下，${x}头一个反应是啥子？`, [...KEYS].reverse()),
    calm: (x) => choice(`${x}接下来会做啥子？`, [...KEYS].reverse()),
  },
};

/**
 * 他自己那一栏的写法：游戏原样（"……之前就这样，到这会儿还没动"——还没问就先告诉模型"他没反应"，带答案）
 * vs 只说"那一下响的时候正在做"。旁人那一栏不动（旁人动没动是真信息）。
 */
const SELF = {
  原样: (st) => st,
  响的时候正在做: (st, who) => {
    const s = JSON.parse(JSON.stringify(st));
    const me = s[who];
    if (me && typeof me['在做啥子'] === 'string') {
      me['在做啥子'] = me['在做啥子'].replace(/（(.+?)之前就这样，到这会儿还没动）/, '（$1响的时候正在做）');
    }
    return s;
  },
};
// 放下题（要不要应付刚才的事）：各时刻有多少人会放下
const GATE = {
  '放下（刚才这一下，放下手上的事）': (x) => noulSet([['gate', `刚才街上这一下，${x}会放下手上的事。`]]),
  '放下（被惊动，手上停了）': (x) => noulSet([['gate', `${x}被刚才街上这一下惊动了，手上的事停了下来。`]]),
};

const items = [];
const people = calm.map((s) => s.person.label);
for (const [gn, gq] of Object.entries(GATE)) {
  for (const [sn, sf] of Object.entries(SELF)) {
    for (const who of people) {
      const c = calm.find((s) => s.person.label === who);
      items.push({ id: `g${items.length}`, kind: 'gate', an: `${gn}·${sn}`, sc: '平静', who, state: sf(assembleState(DEFAULT_RECIPES.gate, c), who), ...gq(who) });
      for (const sc of scenes) {
        const s = sc.snaps.find((x) => x.person.label === who);
        if (s) items.push({ id: `g${items.length}`, kind: 'gate', an: `${gn}·${sn}`, sc: sc.name, who, state: sf(assembleState(DEFAULT_RECIPES.gate, s), who), ...gq(who) });
      }
    }
  }
}
const ASK_NAMES = [];
for (const [an0, a] of Object.entries(ASK)) {
  for (const [sn, sf] of Object.entries(SELF)) {
    const an = `${an0}·${sn}`;
    ASK_NAMES.push(an);
    for (const who of people) {
      const c = calm.find((s) => s.person.label === who);
      const q = a.calm(who);
      items.push({ id: `c${items.length}`, an, sc: '平静', who, state: sf(assembleState(DEFAULT_RECIPES.react, c, BUDGET ? { budget: BUDGET } : {}), who), ...q });
      for (const sc of scenes) {
        const s = sc.snaps.find((x) => x.person.label === who);
        if (!s) continue;
        const qh = a.hot(who);
        items.push({ id: `h${items.length}`, an, sc: sc.name, who, state: sf(assembleState(DEFAULT_RECIPES.react, s, BUDGET ? { budget: BUDGET } : {}), who), ...qh });
      }
    }
  }
}

// ───────── 经开发服一拍一包通道发（跟游戏同一条路）─────────
const page = `react-${Date.now()}`;
const results = new Map();
const ctrl = new AbortController();
const stream = await fetch(`${base}/stream?page=${page}`, { signal: ctrl.signal });
let hello = false;
(async () => {
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (ev === 'hello') hello = true;
        if (ev === 'result' && data) { const j = JSON.parse(data); results.set(j.id, j); }
      }
    }
  } catch { /* 断开 */ }
})();
while (!hello) await new Promise((r) => setTimeout(r, 20));
for (let i = 0; i < items.length; i += 64) {
  const chunk = items.slice(i, i + 64);
  const r = await fetch(`${base}/pack?backend=${backend}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page, pack: `r${i}`, items: chunk.map((it) => ({ id: it.id, state: it.state, questions: it.questions, priority: 40, expireMs: 600000, name: `反应题查验 ${it.an}` })) }),
  });
  if (r.status !== 202) throw new Error(`交包失败 ${r.status} ${await r.text()}`);
}
const t0 = Date.now();
while (results.size < items.length && Date.now() - t0 < 900000) await new Promise((r) => setTimeout(r, 500));
ctrl.abort();

// ───────── 读 ─────────
const readGate = (it) => {
  const r = results.get(it.id);
  return r?.ok ? it.read(r.body.answers ?? {}).gate : undefined;
};
const readOf = (it) => {
  const r = results.get(it.id);
  if (!r?.ok) return null;
  const v = it.read(r.body.answers ?? {});
  return KEYS.every((k) => typeof v[k] === 'number') ? v : null;
};
const table = [];
const detail = [];
const score = (an, sc, getVals) => {
  let fit = 0; let fit3 = 0; let fitN = 0; let carryLast = 0; let carryFirst = 0; let n = 0;
  const picks = [];
  for (const who of people) {
    const v = getVals(who);
    if (!v) continue;
    n++;
    const top = KEYS.reduce((b, k) => (v[k] > v[b] ? k : b), KEYS[0]);
    const top3 = ['hide', 'flee', 'look'].reduce((b, k) => (v[k] > v[b] ? k : b), 'hide');
    if (KEYS.every((k) => k === 'carry' || v.carry < v[k])) carryLast++;
    if (KEYS.every((k) => k === 'carry' || v.carry > v[k])) carryFirst++;
    if (EXPECT[who]) {
      fitN++;
      if (top === EXPECT[who]) fit++;
      if (EXPECT[who] === 'carry' ? top === 'carry' : top3 === EXPECT[who]) fit3++;
    }
    picks.push(`${who}${EXPECT[who] ? `(该${NAME[EXPECT[who]]})` : ''}→${NAME[top]}`);
  }
  return { an, sc, fit, fit3, fitN, carryLast, carryFirst, n, picks };
};
const vals = (an, sc) => (who) => {
  const it = items.find((x) => x.an === an && x.sc === sc && x.who === who);
  return it ? readOf(it) : null;
};
const avg = (sc, sn) => (who) => {
  const a = vals(`选择题（正序）·${sn}`, sc)(who);
  const b = vals(`选择题（倒序）·${sn}`, sc)(who);
  return a && b ? Object.fromEntries(KEYS.map((k) => [k, (a[k] + b[k]) / 2])) : null;
};
for (const sc of ['平静', ...scenes.map((s) => s.name)]) {
  for (const an of ASK_NAMES) table.push(score(an, sc, vals(an, sc)));
  for (const sn of Object.keys(SELF)) table.push(score(`选择题（正倒两遍平均）·${sn}`, sc, avg(sc, sn)));
}
const lines = [`# 反应题查验 · ${backend}（${items.length} 单，回 ${results.size}；state 全是游戏自己拼的）`, ''];
// 放下题：各时刻平均读数、≥0.5 的人数
lines.push('| 放下题问法·他自己那栏写法 | ' + ['平静', ...scenes.map((s) => s.name)].join(' | ') + ' |');
lines.push('|---|' + ['平静', ...scenes.map((s) => s.name)].map(() => '---').join('|') + '|');
const gateNames = [...new Set(items.filter((x) => x.kind === 'gate').map((x) => x.an))];
for (const gn of gateNames) {
  const cells = ['平静', ...scenes.map((s) => s.name)].map((sc) => {
    const vs = items.filter((x) => x.kind === 'gate' && x.an === gn && x.sc === sc).map((x) => readGate(x)).filter((v) => typeof v === 'number');
    if (!vs.length) return '—';
    const m = vs.reduce((a, b) => a + b, 0) / vs.length;
    return `均 ${m.toFixed(2)} · ≥0.5 有 ${vs.filter((v) => v >= 0.5).length}/${vs.length}`;
  });
  lines.push(`| ${gn} | ${cells.join(' | ')} |`);
}
lines.push('');
lines.push('| 场面 | 问法 | 四选一合人设 | 放下后三选一合人设 | "接着做"排最后 | "接着做"排第一 |');
lines.push('|---|---|---|---|---|---|');
for (const r of table) {
  lines.push(`| ${r.sc} | ${r.an} | ${r.sc === '平静' ? '—' : `${r.fit}/${r.fitN}`} | ${r.sc === '平静' ? '—' : `${r.fit3}/${r.fitN}`} | ${r.carryLast}/${r.n} | ${r.carryFirst}/${r.n} |`);
  if (r.sc !== '平静') detail.push(`- ${r.sc} · ${r.an}：${r.picks.join('，')}`);
}
lines.push('', ...detail);
const errs = [...results.values()].filter((r) => !r.ok);
if (errs.length) lines.push('', `- 出错 ${errs.length}：${[...new Set(errs.map((e) => e.message))].slice(0, 2).join(' ／ ')}`);
mkdirSync('E:/GameDev/_tmp/jev/probe', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
writeFileSync(join('E:/GameDev/_tmp/jev/probe', `react-${backend}-${stamp}.json`), JSON.stringify(items.map((it) => ({ an: it.an, sc: it.sc, who: it.who, state: it.state, questions: it.questions, answer: results.get(it.id) ?? null })), null, 1));
console.log(lines.join('\n'));
process.exit(0);
