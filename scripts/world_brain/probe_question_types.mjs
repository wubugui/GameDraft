/**
 * 世界脑第二版 · 动工前的题型探测（设计稿 §12.3）。
 *
 * 看的是**这种题能不能用**，不拿读数去定线（数都是设计值，两个模型共用）：
 * - 饱和率：读数贴着 0 / 1 的比例（贴死了就分不出轻重）；
 * - 分离度：两极（平静 ↔ 雷劈在跟前、定神 ↔ 吓破胆……）的涨幅之差，要明显大于迟滞带；
 * - 波动：只改无关字段（时辰措辞、记忆顺序）读数动了多少，要小于迟滞带；
 * - 两个已知风险：字面重合（记忆里有"盘问过"，"盘问"题会不会被抬高）、重字眼饱和（"心慌""防着他"进 state 后怕类题整体饱和）。
 *
 * state 用游戏里那一份拼装代码（`src/systems/worldBrain/stateAssembly.ts`，配方 + 快照 → state），一字不差；
 * 题目经开发服的一拍一包通道发（跟游戏同一条路），所以要先起开发服。
 *
 *   node --experimental-strip-types --no-warnings scripts/world_brain/probe_question_types.mjs \
 *        --backend laya|jev [--port 5191] [--scene jev_街巷] [--band 0.1] [--out E:/GameDev/_tmp/jev/probe]
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assembleState, counterfactualSnapshot, DEFAULT_RECIPES,
} from '../../src/systems/worldBrain/stateAssembly.ts';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const backend = args.backend === 'jev' ? 'jev' : 'laya';
const port = Number(args.port ?? 5191);
const sceneId = args.scene ?? 'jev_街巷';
/** 迟滞带（设计值草稿：高出多少才算明显高出一截，§14.2，制作人审）；通过线 = 两倍迟滞带 */
const BAND = Number(args.band ?? 0.1);
const outDir = args.out ?? 'E:/GameDev/_tmp/jev/probe';
/** 只跑其中几类题（逗号分隔：gate,lean,routine,voice,reply,attitude,belief）；不写 = 全跑 */
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const want = (type) => !ONLY || ONLY.has(type);
const base = `http://127.0.0.1:${port}/__gamedraft-api/jev`;

const scene = JSON.parse(readFileSync(new URL(`../../public/assets/data/world_brain/${sceneId}.json`, import.meta.url), 'utf-8'));
const P = scene.player.label;
const people = scene.people.map((p) => ({ id: p.npcId, label: p.label, identity: p.identity, temper: p.temper, animal: p.kind === 'animal' }));
const humans = people.filter((p) => !p.animal);

// ───────────────────────── 探测用的场面（写成话的快照栏） ─────────────────────────

/** 事的几档：平静 / 中等（喊一嗓子、狗叫、有人跑过）/ 雷劈在跟前 */
const EVENTS = {
  calm: [],
  shout: ['刚才：街上有人扯起嗓子喊了一声'],
  dog: ['刚才：面摊那边的狗汪汪叫了几声'],
  runPast: ['刚才：有个人从旁边跑过去'],
  thunder: ['刚才：头顶一声炸雷，一道白光劈在跟前的石板上，震得耳朵嗡嗡响'],
};
const MEDIUM = ['shout', 'dog', 'runPast'];

/**
 * 夹具：从真跑的游戏里抓下来的每人此刻的全量快照（`--fixture scripts/world_brain/fixtures/<名>.json`，
 * 游戏里 `__game.worldBrain.captureSnapshots()` 存的）。有夹具就以它为底，各场面只往上叠要比的那一栏；
 * 没有才退回手写的残缺底子（只作兜底，结论以真快照为准——手写的"在街上做自己手上的事"判不出东西）。
 */
const FIXTURE = args.fixture ? JSON.parse(readFileSync(args.fixture, 'utf-8')) : null;
const realOf = new Map((FIXTURE ?? []).map((s) => [s.person?.label, s]));
/** 只按模型的容量裁（Laya 读得下的约 1500 估算 token；Jev 一发上万照常回，不裁） */
const BUDGET = args.budget ? Number(args.budget) : backend === 'laya' ? 1500 : undefined;
const personSnap = (p, extra = {}) => ({
  label: p.label, identity: p.animal ? `（牲口）${p.identity}` : p.identity, temper: p.temper,
  where: '街上', doing: '做自己手上的事', doingFor: '一阵子', ...extra,
});
const baseSnap = (p, extra = {}) => {
  const real = realOf.get(p.label);
  if (real) {
    const { person: xp, player: xpl, ...rest } = extra;
    return {
      ...real, setting: scene.setting, brief: scene.brief, events: [], ...rest,
      player: { ...real.player, ...(xpl ?? {}) },
      person: { ...real.person, ...(xp ?? {}) },
    };
  }
  return {
    setting: scene.setting, brief: scene.brief, time: '下午',
    player: { label: P, identity: scene.player.identity, where: '街上', doing: '站着' },
    ...extra,
    person: personSnap(p, extra.person ?? {}),
  };
};

// ───────────────────────── 题（§12.1 的题面） ─────────────────────────

const S = {
  gate: (x) => `${x}会放下手上的事，去应付刚才的事。`,
  hide: (x) => `${x}会躲到屋檐底下去。`,
  flee: (x) => `${x}会撒腿跑开。`,
  look: (x) => `${x}会凑过去看。`,
  carry: (x) => `${x}会接着做手上的事。`,
  // 乙种问法：每个选项带上"为啥这么做"，彼此互斥（"没当回事"跟"被吓到"不能同时真）
  gateB: (x) => `${x}被刚才的事惊动了，手上的事停了下来。`,
  hideB: (x) => `${x}被吓到了，躲到屋檐底下去。`,
  fleeB: (x) => `${x}吓得撒腿就跑。`,
  lookB: (x) => `${x}好奇，凑过去看是啥子。`,
  carryB: (x) => `${x}没当回事，接着做手上的事。`,
  change: (x) => `${x}会因为这事对${P}改看法。`,
  // 第 2 轮换的说法
  wary2: (x) => `${x}往后见了${P}会多个心眼。`,
  change2: (x) => `这件事让${x}对${P}的看法变了。`,
  believe2: (x, s) => `${x}信了${s}的话。`,
  askAbout2: (x) => `${x}会问${P}那道雷是咋个回事。`,
  shoo2: (x) => `${x}会叫${P}离他远点。`,
  rCarry: (x) => `${x}接下来会接着做手上的事。`,
  rHome: (x) => `${x}接下来会收拾东西回屋。`,
  vCry: (x) => `${x}会叫出声来。`,
  vPray: (x) => `${x}会念一句菩萨保佑。`,
  vCurse: (x) => `${x}会骂一句。`,
  askAbout: (x) => `${x}会盘问${P}刚才的事。`,
  shoo: (x) => `${x}会撵${P}走。`,
  chat: (x) => `${x}会跟${P}摆龙门阵。`,
  ignore: (x) => `${x}会只顾做自己的事，不理${P}。`,
  wary: (x) => `${x}对${P}会防着点。`,
  warm: (x) => `${x}对${P}会更亲近些。`,
  believe: (x, s) => `${x}会把${s}说的当回事。`,
};

// ───────────────────────── 出单 ─────────────────────────

/** 一单 = 一个人一份 state + 这份 state 上的几道是非题（跟游戏一样：一发只放一个人） */
const items = [];
let seq = 0;
function add(type, person, cond, variant, recipe, snap, statements) {
  if (!want(type)) return;
  const questions = {};
  const keys = Object.keys(statements);
  keys.forEach((k, i) => { questions[`q${i}`] = { type: 'noul', instructions: statements[k] }; });
  items.push({
    id: `x${++seq}`, meta: { type, person: person.label, cond, variant, keys },
    state: assembleState(recipe, snap, BUDGET !== undefined ? { budget: BUDGET } : {}), questions,
  });
}
/**
 * 无关扰动（改了不该影响判断的字眼；都是反应题配方里**真有**的栏，不在配方里的栏改了等于没改）：
 * 时辰换个说法 / 在哪换个说法 / 在做啥子换个近义说法
 */
const NOISES = {
  // 同义换说法：时辰换个叫法、地名后头加个"那点"、在做啥前头加个"正"——意思一点没变
  time: (s) => ({ ...s, time: s.time === '午时' ? '晌午' : s.time === '下午' ? '半下午' : `${s.time}前后` }),
  where: (s) => ({ ...s, person: { ...s.person, where: `${s.person.where}那点` } }),
  doing: (s) => ({ ...s, person: { ...s.person, doing: `正${String(s.person.doing).replace(/^在/, '')}` } }),
  // 同一件事换个说法（这一栏跟判断有关，但同义改写不该让判断大变）
  wording: (s) => ({ ...s, events: (s.events ?? []).map((e) => e
    .replace('头顶一声炸雷，一道白光劈在跟前的石板上，震得耳朵嗡嗡响', '天上打了个炸雷，白光一闪，就劈在跟前的石板上，耳朵都震聋了')) }),
};
const both = (type, person, cond, recipe, snap, cf, statements, noise) => {
  add(type, person, cond, 'main', recipe, snap, statements);
  add(type, person, cond, 'cf', recipe, counterfactualSnapshot(snap, cf), statements);
  if (noise === true) {
    for (const [n, fn] of Object.entries(NOISES)) {
      // 这份配方里没有的栏改了等于没改：不出这一单
      const changed = JSON.stringify(assembleState(recipe, fn(snap))) !== JSON.stringify(assembleState(recipe, snap));
      if (changed) add(type, person, cond, `noise:${n}`, recipe, fn(snap), statements);
    }
  } else if (noise) add(type, person, cond, 'noise:order', recipe, noise(snap), statements);
};

// 放下 + 反应：同一份 state（跟游戏同一发），对照甲（去掉刚才的事）；两种问法放在同一份 state 上比
for (const p of people) {
  for (const cond of Object.keys(EVENTS)) {
    const snap = baseSnap(p, { events: EVENTS[cond] });
    const st = {
      gate: S.gate(p.label), hide: S.hide(p.label), flee: S.flee(p.label), look: S.look(p.label), carry: S.carry(p.label),
      gateB: S.gateB(p.label), hideB: S.hideB(p.label), fleeB: S.fleeB(p.label), lookB: S.lookB(p.label), carryB: S.carryB(p.label),
    };
    both('gate', p, cond, DEFAULT_RECIPES.react, snap, 'noEvents', st, cond === 'thunder' || cond === 'calm');
  }
}
// 带心头的日常：心头 不带 / 三档（甲种说法"定了神…"、乙种说法"心里踏实…"），对照乙（身份换泛称）
const HEARTS = { none: '', 定了神: '定了神', 心头有点慌: '心头有点慌', 吓破了胆: '吓破了胆', 'B踏实': '心里踏实', 'B发慌': '心里有点发慌', 'B怕得很': '怕得很，腿都软了' };
for (const p of people) {
  for (const [cond, heart] of Object.entries(HEARTS)) {
    const snap = baseSnap(p, { person: heart ? { heart } : {} });
    both('routine', p, cond, DEFAULT_RECIPES.routine, snap, 'anon', { carry: S.rCarry(p.label), home: S.rHome(p.label) });
  }
  // 第 5 轮：心头要有起因——一分钟前那道雷已经劈过、街上刚平静下来，这时候他心头是定神还是吓破胆
  // （平白无故写"吓破了胆"是自相矛盾的场面，模型不当真是对的）
  const after = ['一分钟前：头顶一声炸雷，一道白光劈在跟前的石板上，震得耳朵嗡嗡响'];
  for (const [cond, heart] of [['H:none', ''], ['H:定了神', '定了神'], ['H:心头有点慌', '心头还有点慌'], ['H:吓破了胆', '吓破了胆，腿还在抖']]) {
    const snap = baseSnap(p, { events: after, person: heart ? { heart } : {} });
    both('routine', p, cond, DEFAULT_RECIPES.routine, snap, 'anon', { carry: S.rCarry(p.label), home: S.rHome(p.label) });
  }
}
// 开腔：进的状态 × 刚才的事，对照甲
for (const p of humans) {
  // 第 5 轮加一组"雷劈了但他照样干活"：分清是雷的作用还是躲进屋檐那个状态的作用
  for (const [cond, events, entered] of [
    ['calm', EVENTS.calm, '接着做手上的事'],
    ['thunder', EVENTS.thunder, '吓得躲到屋檐底下'],
    ['thunderWork', EVENTS.thunder, '没理会，接着做手上的事'],
  ]) {
    both('voice', p, cond, DEFAULT_RECIPES.voice, baseSnap(p, { events, person: { enteredState: entered } }), 'noEvents',
      { cry: S.vCry(p.label), pray: S.vPray(p.label), curse: S.vCurse(p.label) });
  }
}
// 带记忆的回话：记得的事 没有 / 昨天的雷 / 盘问过（字面重合风险），对照丁（记得的事换中性占位）；波动 = 两条记忆换顺序
const MEM = {
  none: [],
  thunder: [`昨天${P}在面摊跟前掷了一张符，一道炸雷劈下来`, '昨晚落了一场大雨'],
  asked: [`上回拿炸雷的事盘问过${P}`, '昨晚落了一场大雨'],
};
for (const p of humans) {
  for (const cond of Object.keys(MEM)) {
    const snap = baseSnap(p, {
      player: { label: P, identity: scene.player.identity, where: '跟前', doing: '走到跟前', activity: '走到跟前跟他搭话' },
      // 第 3 轮：去掉"对关二狗：没啥看法"——它跟"记得他招过雷"打架，Jev 认这句就不撵人，测的就不是记忆了
      person: { memories: MEM[cond] },
    });
    both('reply', p, cond, DEFAULT_RECIPES.reply, snap, 'noMemories',
      {
        askAbout: S.askAbout(p.label), shoo: S.shoo(p.label), chat: S.chat(p.label), ignore: S.ignore(p.label),
        askAbout2: S.askAbout2(p.label), shoo2: S.shoo2(p.label),
      },
      MEM[cond].length > 1 ? (s) => ({ ...s, person: { ...s.person, memories: [...s.person.memories].reverse() } }) : null);
  }
}
// 看法：新证据 没有 / 轻 / 重，对照甲′（只换新证据）
const EVID = {
  none: [{ text: `${P}平时在街上混`, fresh: false }],
  mild: [{ text: `${P}平时在街上混`, fresh: false }, { text: `${P}今天在街上转了一圈`, fresh: true }],
  strong: [{ text: `${P}平时在街上混`, fresh: false }, { text: `${P}在面摊跟前掷了一张符，一道炸雷劈下来，锅都震翻了`, fresh: true }],
};
for (const p of humans) {
  for (const cond of Object.keys(EVID)) {
    both('attitude', p, cond, DEFAULT_RECIPES.attitude,
      baseSnap(p, { person: { axisLevel: `对${P}：没啥看法`, evidence: EVID[cond] } }), 'noFreshEvidence',
      {
        wary: S.wary(p.label), warm: S.warm(p.label), change: S.change(p.label),
        wary2: S.wary2(p.label), change2: S.change2(p.label),
      });
  }
}
// 信不信：听到的那句（招雷的闲话 / 家常）× 跟说话的人（处得好 / 不熟），对照甲（听到的那句换中性）
const SPEAKER = '跑腿伙计';
for (const p of humans.filter((h) => h.label !== SPEAKER)) {
  // 第 3 轮：另一头换成真不该当回事的话（面价涨了本来就该当回事，拿它当对照是题出错了）；
  // 关系换成"处得好"对"晓得他爱乱说"——"不熟"不等于不可信
  for (const [lineCond, line] of [['rumor', `${SPEAKER}说：${P}手上那张符招雷，昨天那道炸雷就是他引来的`], ['mundane', `${SPEAKER}说：他昨晚做梦吃了一碗面`]]) {
    for (const [relCond, rel] of [['close', '街坊，平时处得好'], ['stranger', '晓得他嘴巴爱乱说，十句有九句是编的']]) {
      both('belief', p, `${lineCond}/${relCond}`, DEFAULT_RECIPES.belief,
        baseSnap(p, { person: { heardLine: line, relationToSpeaker: { speaker: SPEAKER, text: rel } } }), 'noEvents',
        { believe: S.believe(p.label, SPEAKER), believe2: S.believe2(p.label, SPEAKER) });
    }
  }
}

// ───────────────────────── 经开发服的一拍一包通道发 ─────────────────────────

const page = `probe-${Date.now()}`;
const results = new Map();
const ctrl = new AbortController();
const stream = await fetch(`${base}/stream?page=${page}`, { signal: ctrl.signal });
if (!stream.ok) throw new Error(`推送通道开不了：${stream.status}（开发服起了没有？）`);
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

const t0 = Date.now();
const PACK = 64;
for (let i = 0; i < items.length; i += PACK) {
  const chunk = items.slice(i, i + PACK);
  const r = await fetch(`${base}/pack?backend=${backend}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page, pack: `probe${i / PACK}`,
      items: chunk.map((it) => ({ id: it.id, state: it.state, questions: it.questions, priority: 40, expireMs: 600000, name: `题型探测 ${it.meta.type}` })),
    }),
  });
  if (r.status !== 202) throw new Error(`交包失败：${r.status} ${await r.text()}`);
}
process.stdout.write(`已交 ${items.length} 单（${backend}），等结果`);
while (results.size < items.length && Date.now() - t0 < 900000) {
  await new Promise((r) => setTimeout(r, 1000));
  process.stdout.write(`\r已交 ${items.length} 单（${backend}），回来 ${results.size}   `);
}
process.stdout.write('\n');
ctrl.abort();
const wallMs = Date.now() - t0;

// ───────────────────────── 读数 ─────────────────────────

const errors = [];
const read = new Map(); // `${type}|${person}|${cond}|${variant}` → { key: p }
for (const it of items) {
  const r = results.get(it.id);
  if (!r || !r.ok) { errors.push(r ? `${r.error_type}: ${r.message}` : '没回'); continue; }
  const ans = r.body?.answers ?? {};
  const row = {};
  it.meta.keys.forEach((k, i) => {
    const a = ans[`q${i}`];
    const v = typeof a?.noul === 'number' ? a.noul : typeof a?.probability === 'number' ? a.probability : null;
    if (v !== null) row[k] = v;
  });
  read.set(`${it.meta.type}|${it.meta.person}|${it.meta.cond}|${it.meta.variant}`, row);
}
const model = [...results.values()].find((r) => r.ok)?.model ?? null;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const p95 = (xs) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };
const f = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const who = (type) => (['gate', 'lean', 'routine'].includes(type) ? people : humans).map((p) => p.label);
/** 某题某人某场面：正题读数、对照读数、涨幅 */
const cell = (type, person, cond, key) => {
  const m = read.get(`${type}|${person}|${cond}|main`)?.[key];
  const c = read.get(`${type}|${person}|${cond}|cf`)?.[key];
  return { m, c, d: m !== undefined && c !== undefined ? m - c : undefined };
};
const deltas = (type, cond, key, list = who(type)) => list.map((p) => cell(type, p, cond, key).d).filter((x) => x !== undefined);
const mains = (type, key) => [...read.entries()].filter(([k]) => k.startsWith(`${type}|`) && k.endsWith('|main')).map(([, v]) => v[key]).filter((x) => x !== undefined);
const saturation = (xs) => (xs.length ? xs.filter((x) => x >= 0.95 || x <= 0.05).length / xs.length : NaN);
/** 无关扰动前后同一道题差了多少（`kinds` = 哪几种扰动） */
const noise = (type, key, conds, kinds) => who(type).flatMap((p) => conds.flatMap((c) => kinds.map((n) => {
  const a = read.get(`${type}|${p}|${c}|main`)?.[key];
  const b = read.get(`${type}|${p}|${c}|noise:${n}`)?.[key];
  return a !== undefined && b !== undefined ? Math.abs(a - b) : undefined;
}))).filter((x) => x !== undefined);
const NOISE_KINDS = Object.keys(NOISES);

const rows = [];
/**
 * 这个模型自己的摆动（放下题在各种同义改写下的 P95）：分不分得开要跟它比，不能拿一条拍脑袋的固定线——
 * Jev 读数紧（摆 0.03~0.05），差 0.15 就是真信号；Laya 摆 0.2~0.4，差 0.3 也可能是噪声（第 5 轮改的）。
 */
const NOISE_FLOOR = (() => {
  const all = ['gate', 'gateB'].flatMap((k) => noise('gate', k, ['calm', 'thunder'], NOISE_KINDS));
  return all.length ? p95(all) : NaN;
})();
/** 通过线：两极之差 ≥ 迟滞带，且 ≥ 本模型摆动的 3 倍 */
const PASS_LINE = Number.isFinite(NOISE_FLOOR) ? Math.max(BAND, 3 * NOISE_FLOOR) : BAND;
const verdict = (sep, sat, nz) => {
  const bad = [];
  if (!(sep >= PASS_LINE)) bad.push('分不开');
  if (sat > 0.2) bad.push('饱和');
  if (Number.isFinite(nz) && nz > BAND) bad.push('波动大');
  return bad.length ? `✗ ${bad.join('、')}` : '✓ 能用';
};
/** 按涨幅（比对照）读的题：两极涨幅之差 */
const addRow = (name, key, type, lo, hi, nz) => {
  const dLo = mean(deltas(type, lo, key));
  const dHi = mean(deltas(type, hi, key));
  const sep = dHi - dLo;
  const sat = saturation(mains(type, key));
  const n = nz ? p95(noise(type, key, nz.conds, nz.kinds ?? NOISE_KINDS)) : NaN;
  rows.push({ name, lo, hi, dLo, dHi, sep, sat, nz: n, v: verdict(sep, sat, n) });
};
/** 按"比不带这一栏"读的题（心头）：main(hi) − main(基线场面) */
const addRawRow = (name, key, type, baseCond, lo, hi, sign = 1) => {
  const eff = (c) => mean(who(type).map((p) => cell(type, p, c, key).m - cell(type, p, baseCond, key).m).filter(Number.isFinite));
  const dLo = eff(lo);
  const dHi = eff(hi);
  const sep = sign * (dHi - dLo);
  const sat = saturation(mains(type, key));
  rows.push({ name, lo, hi, dLo, dHi, sep, sat, nz: NaN, v: verdict(sep, sat, NaN) });
};
const GN = { conds: ['calm', 'thunder'] };
for (const [type, tag] of [['gate', '全量']]) {
  addRow(`放下（甲种·${tag}）`, 'gate', type, 'calm', 'thunder', GN);
  addRow(`放下（乙种·${tag}）`, 'gateB', type, 'calm', 'thunder', GN);
  for (const [k, n] of [['hide', '躲'], ['flee', '跑'], ['look', '凑过去看']]) {
    addRow(`反应·${n}（甲种·${tag}）`, k, type, 'calm', 'thunder', GN);
    addRow(`反应·${n}（乙种·${tag}）`, `${k}B`, type, 'calm', 'thunder', GN);
  }
  addRow(`反应·接着做（甲种·${tag}，应降）`, 'carry', type, 'thunder', 'calm', GN);
  addRow(`反应·没当回事接着做（乙种·${tag}，应降）`, 'carryB', type, 'thunder', 'calm', GN);
}
addRawRow('日常·回屋（心头甲种，比不带）', 'home', 'routine', 'none', '定了神', '吓破了胆');
addRawRow('日常·回屋（心头乙种，比不带）', 'home', 'routine', 'none', 'B踏实', 'B怕得很');
addRawRow('日常·接着做（心头乙种，应降）', 'carry', 'routine', 'none', 'B踏实', 'B怕得很', -1);
// 心头（第 5 轮，有起因）：都是那道雷劈过一分钟，比"心头写了几档"跟"没写心头"
addRawRow('日常·回屋（雷后，心头吓破胆 vs 定神）', 'home', 'routine', 'H:none', 'H:定了神', 'H:吓破了胆');
addRawRow('日常·接着做（雷后，心头吓破胆 vs 定神，应降）', 'carry', 'routine', 'H:none', 'H:吓破了胆', 'H:定了神');
// 开腔读**原始读数**：对照里也带着"进的这个状态"，按涨幅算会把状态的作用减掉（跟信不信同一个错）
for (const [k, n] of [['cry', '叫出声'], ['pray', '念菩萨保佑'], ['curse', '骂一句']]) {
  addRawRow(`开腔·${n}（原始读数：平静干活 → 雷后躲屋檐）`, k, 'voice', 'calm', 'calm', 'thunder');
  addRawRow(`开腔·${n}（原始读数：雷后照样干活 → 雷后躲屋檐）`, k, 'voice', 'thunderWork', 'thunderWork', 'thunder');
}
addRow('看法·防着点', 'wary', 'attitude', 'none', 'strong');
addRow('看法·多个心眼（第 2 轮说法）', 'wary2', 'attitude', 'none', 'strong');
addRow('看法·会改看法（退路题）', 'change', 'attitude', 'none', 'strong');
addRow('看法·看法变了（退路题，第 2 轮说法）', 'change2', 'attitude', 'none', 'strong');
addRow('信不信（招雷闲话 vs 家常）', 'believe', 'belief', 'mundane/close', 'rumor/close');
addRow('信不信·信了他的话（第 2 轮说法）', 'believe2', 'belief', 'mundane/close', 'rumor/close');
const RN = { conds: ['thunder', 'asked'], kinds: ['order'] };
addRow('回话·盘问（记得那道雷 vs 没记忆）', 'askAbout', 'reply', 'none', 'thunder', RN);
addRow('回话·问那道雷咋回事（第 2 轮说法）', 'askAbout2', 'reply', 'none', 'thunder', RN);
addRow('回话·撵走（记得那道雷 vs 没记忆）', 'shoo', 'reply', 'none', 'thunder', RN);
addRow('回话·叫他离远点（第 2 轮说法）', 'shoo2', 'reply', 'none', 'thunder', RN);

/**
 * 选项分不分得开：雷劈在跟前时，"接着做"是不是排在躲 / 跑 / 凑过去看之下；平静时是不是排在它们之上。
 * 按原始读数和按涨幅各看一遍（每人一票）。
 */
const rankCheck = (suffix, type = 'gate') => {
  const opts = ['hide', 'flee', 'look'].map((k) => k + suffix);
  const carry = `carry${suffix}`;
  const tally = { rawThunder: 0, deltaThunder: 0, rawCalm: 0, n: 0 };
  for (const p of people) {
    const t = read.get(`${type}|${p.label}|thunder|main`);
    const tc = read.get(`${type}|${p.label}|thunder|cf`);
    const c = read.get(`${type}|${p.label}|calm|main`);
    if (!t || !tc || !c) continue;
    tally.n++;
    if (opts.every((k) => t[carry] < t[k])) tally.rawThunder++;
    if (opts.every((k) => t[carry] - tc[carry] < t[k] - tc[k])) tally.deltaThunder++;
    if (opts.every((k) => c[carry] > c[k])) tally.rawCalm++;
  }
  return tally;
};
const rankA = rankCheck('');
const rankB = rankCheck('B');
/**
 * 放下以后三选一（躲 / 跑 / 凑过去看，"接着做"归放下题管）：雷劈在跟前时每人挑中哪个——按读数、按涨幅各挑一次，
 * 列出来给人看合不合人设（胆大好奇的该凑过去、胆小的该躲、嘴硬心虚的该跑）；波动 = 无关扰动后挑中的变没变。
 */
const pick3 = (suffix, type = 'gate') => people.map((p) => {
  const keys = ['hide', 'flee', 'look'].map((k) => k + suffix);
  const t = read.get(`${type}|${p.label}|thunder|main`);
  const tc = read.get(`${type}|${p.label}|thunder|cf`);
  if (!t || !tc) return null;
  const arg = (score) => keys.reduce((b, k) => (score(k) > score(b) ? k : b), keys[0]);
  const byRaw = arg((k) => t[k]);
  const byDelta = arg((k) => t[k] - tc[k]);
  const flips = NOISE_KINDS.filter((n) => {
    const z = read.get(`${type}|${p.label}|thunder|noise:${n}`);
    return z && keys.reduce((b, k) => (z[k] > z[b] ? k : b), keys[0]) !== byRaw;
  }).length;
  return { who: p.label, byRaw: byRaw.replace(suffix, ''), byDelta: byDelta.replace(suffix, ''), flips };
}).filter(Boolean);
const NAME3 = { hide: '躲', flee: '跑', look: '看' };
const pickA = pick3('');
const pickB = pick3('B');
const noiseBy = Object.fromEntries(NOISE_KINDS.map((n) => [n, p95(noise('gate', 'gate', ['calm', 'thunder'], [n]))]));
const noiseByB = Object.fromEntries(NOISE_KINDS.map((n) => [n, p95(noise('gate', 'gateB', ['calm', 'thunder'], [n]))]));

// 中等事排在两极之间没有（放下题）
const order = ['calm', ...MEDIUM, 'thunder'].map((c) => [c, mean(deltas('gate', c, 'gate'))]);
// 字面重合：记忆里写着"盘问过"，盘问题被抬高还是压低（跟"记得那道雷"比）
const literal = {
  askedVsThunder: mean(humans.map((p) => cell('reply', p.label, 'asked', 'askAbout').m - cell('reply', p.label, 'thunder', 'askAbout').m).filter(Number.isFinite)),
  memoryEffectAsked: mean(humans.map((p) => cell('reply', p.label, 'asked', 'askAbout').d).filter(Number.isFinite)),
};
// 重字眼饱和：心头写"吓破了胆"时怕类题贴死没有
const heavy = {
  homeAtBroken: mean(people.map((p) => cell('routine', p.label, '吓破了胆', 'home').m).filter(Number.isFinite)),
  satAtBroken: saturation(people.map((p) => cell('routine', p.label, '吓破了胆', 'home').m).filter(Number.isFinite)),
};
// 关系对信不信的影响
const rel = mean(humans.filter((h) => h.label !== SPEAKER).map((p) => cell('belief', p.label, 'rumor/close', 'believe').d - cell('belief', p.label, 'rumor/stranger', 'believe').d).filter(Number.isFinite));

const lines = [];
lines.push(`# 题型探测 · ${backend === 'laya' ? 'Laya' : 'Jev'}（模型 ${model ?? '?'}）`);
lines.push('');
lines.push(`${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${items.length} 单 · 错 ${errors.length} · 用时 ${(wallMs / 1000).toFixed(0)} 秒 · 迟滞带（设计值草稿）${BAND} · 本模型摆动 P95 ${f(NOISE_FLOOR)} · 通过线：分离度 ≥ ${f(PASS_LINE)}（迟滞带与三倍摆动取大）、饱和 ≤ 20%`);
lines.push('');
lines.push('| 题 | 低一极 | 高一极 | 低极涨幅 | 高极涨幅 | 分离度 | 饱和率 | 波动 P95 | 结论 |');
lines.push('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) lines.push(`| ${r.name} | ${r.lo} | ${r.hi} | ${f(r.dLo)} | ${f(r.dHi)} | ${f(r.sep)} | ${Number.isFinite(r.sat) ? `${Math.round(r.sat * 100)}%` : '—'} | ${f(r.nz)} | ${r.v} |`);
lines.push('');
lines.push(`- 放下题按事的轻重排：${order.map(([c, v]) => `${c} ${f(v)}`).join(' → ')}`);
const rk = (t) => `雷下"接着做"排在躲/跑/看之下：按读数 ${t.rawThunder}/${t.n}、按涨幅 ${t.deltaThunder}/${t.n}；平静时排在它们之上 ${t.rawCalm}/${t.n}`;
lines.push(`- 选项分不分得开（甲种）：${rk(rankA)}`);
lines.push(`- 选项分不分得开（乙种）：${rk(rankB)}`);
lines.push(`- state：${FIXTURE ? `真快照（${args.fixture}）叠场面` : '手写底子（残缺，只作兜底）'} · 配方全量 · 裁剪上限 ${BUDGET ?? '不裁'} · 平均 state ${Math.round(mean(items.map((it) => JSON.stringify(it.state).length)))} 字`);
lines.push(`- 放下题各种扰动的波动 P95（甲种）：${Object.entries(noiseBy).map(([n, v]) => `${n} ${f(v)}`).join(' · ')}；乙种：${Object.entries(noiseByB).map(([n, v]) => `${n} ${f(v)}`).join(' · ')}`);
for (const [nm, list] of [['甲种', pickA], ['乙种', pickB]]) {
  const flipped = list.filter((x) => x.flips > 0).length;
  lines.push(`- 雷劈在跟前、放下以后三选一（${nm}，按读数 / 按涨幅；* = 无关扰动后挑的变了，共 ${flipped}/${list.length} 人）：` +
    list.map((x) => `${x.who} ${NAME3[x.byRaw]}/${NAME3[x.byDelta]}${x.flips ? '*' : ''}`).join('，'));
}
lines.push(`- 字面重合：记忆写"盘问过${P}"时，盘问题比"记得那道雷"时 ${f(literal.askedVsThunder)}；这条记忆本身让盘问涨 ${f(literal.memoryEffectAsked)}`);
lines.push(`- 重字眼：心头"吓破了胆"时"回屋"平均读数 ${f(heavy.homeAtBroken)}，贴死比例 ${Number.isFinite(heavy.satAtBroken) ? Math.round(heavy.satAtBroken * 100) : '—'}%`);
// 关系的作用要看**原始读数**：对照题（听到的那句换中性）里也带着同一句关系，按涨幅算会把关系的作用整个减掉
const relRaw = (key) => mean(humans.filter((h) => h.label !== SPEAKER)
  .map((p) => cell('belief', p.label, 'rumor/close', key).m - cell('belief', p.label, 'rumor/stranger', key).m).filter(Number.isFinite));
lines.push(`- 信不信：同一句招雷闲话，"处得好"的人说比"晓得他爱乱说"的人说，原始读数高 ${f(relRaw('believe'))}（"信了他的话"说法 ${f(relRaw('believe2'))}；按涨幅算会把关系减掉，只供对照 ${f(rel)}）`);
if (errors.length) lines.push(`- 出错样例：${[...new Set(errors)].slice(0, 3).join(' ／ ')}`);

mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
writeFileSync(join(outDir, `probe-${backend}-${stamp}.md`), lines.join('\n'), 'utf-8');
writeFileSync(join(outDir, `probe-${backend}-${stamp}.json`), JSON.stringify({
  backend, model, band: BAND, items: items.map((it) => ({ ...it.meta, state: it.state, questions: it.questions, answer: results.get(it.id) ?? null })),
}, null, 1), 'utf-8');
console.log(lines.join('\n'));
process.exit(0);
