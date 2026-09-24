'use strict';
/* 燃烧工作台 · 右栏检视器：模板全部字段（含真实尺寸 / 握点）、预览读数、场景视图里选中实例的只读信息与点火站位、游戏状态。
 *
 * 数值控件保值（numeric-roundtrip-fidelity）：**没写的字段显示空框 + 缺省提示，不写回**；清空 = 删键（必填的拒绝）；
 * 整数字段只收整数、越界如实拒绝（不悄悄夹）；打开→不动→保存一个字节都不变（服务端还按盘上表示回写相等的数）。
 * 缺省值取运行时包里的 `BURN_DEFAULTS`（与 TS 同一份）。每次提交是一条历史；重建推到下一拍并按 `data-key` 还焦点（Tab 能走到下一格）。
 * 宿主上的可燃配置（初始 / 玩家能不能点 / 条件 / 信号）**不在这里改**：它们住在宿主自己身上，场景视图里只读显示。 */

const INSP = { open: { doc: true, size: true, grip: true, fuel: true, points: true, spread: true, consume: true, timing: true, look: false, particles: true, light: true, blowout: true, entity: true, stance: true, preview: true, game: true }, timer: 0 };
const STATE_LABEL = { unburnt: '没点', burning: '在烧', out: '灭了', burnt: '烧完' };
const KIND_LABEL = { hotspot: '热点', npc: 'NPC', prop: '挂件预设', spawn: '轨迹 spawn', plate: '粒子薄片', other: '其它' };

function renderInspectorSoon() {
  if (INSP.timer) return;
  INSP.timer = setTimeout(() => { INSP.timer = 0; renderInspector(); }, 0);
}

function getPath(obj, path) {
  let o = obj;
  for (const k of path) { if (o == null || typeof o !== 'object') return undefined; o = o[k]; }
  return o;
}
/** 写一个路径；`value === undefined` = 删键并把删空的父对象一路剥掉（数组不剥） */
function setPath(doc, path, value) {
  let o = doc;
  const parents = [];
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (o[k] == null || typeof o[k] !== 'object') {
      if (value === undefined) return;
      o[k] = {};
    }
    parents.push([o, k]);
    o = o[k];
  }
  const last = path[path.length - 1];
  if (value === undefined) {
    delete o[last];
    for (let i = parents.length - 1; i >= 0; i--) {
      const [p, k] = parents[i];
      if (isObj(p[k]) && !Object.keys(p[k]).length) delete p[k]; else break;
    }
  } else {
    o[last] = value;
  }
}

function curDoc() { return S.docs[S.docId] || null; }
function defaults() { return S.rt ? S.rt.burnables.BURN_DEFAULTS : null; }

function sec(id, title, ...kids) {
  const d = h('details', { class: 'sec', 'data-sec': id }, h('summary', { text: title }), ...kids);
  d.open = INSP.open[id] !== false;
  d.addEventListener('toggle', () => { INSP.open[id] = d.open; });
  return d;
}
function row(label, ...kids) { return h('div', { class: 'row' }, h('label', { text: label, title: label }), ...kids); }
function note(text, kind) { return h('div', { class: `note ${kind || ''}`, text }); }

/** 数值输入的解析与校验：返回 `{n}` 或 `{bad}` */
function parseNum(s, o) {
  const n = Number(s);
  const bad = !Number.isFinite(n) ? '不是数' : o.int && !Number.isInteger(n) ? '要整数'
    : o.min !== undefined && n < o.min ? `不能小于 ${o.min}` : o.max !== undefined && n > o.max ? `不能大于 ${o.max}`
      : o.gt !== undefined && !(n > o.gt) ? `要大于 ${o.gt}` : '';
  return bad ? { bad } : { n };
}

/** 数值行（模板文档里的一个路径） */
function numRow(label, path, o) {
  const doc = curDoc();
  const cur = getPath(doc, path);
  const inp = h('input', { type: 'text', inputmode: 'decimal', value: typeof cur === 'number' ? String(cur) : cur == null ? '' : String(cur) });
  inp.dataset.key = `doc.${path.join('.')}`;
  if (o.def !== undefined) inp.placeholder = `缺省 ${o.def}`;
  if (o.tip) inp.title = o.tip;
  inp.addEventListener('change', () => {
    const d = curDoc();
    if (!d) return;
    const s = inp.value.trim();
    if (s === '') {
      if (o.required) { status(`${label} 必填`, 'err'); inp.value = cur == null ? '' : String(cur); return; }
      if (getPath(d, path) === undefined) return;
      edit(`清 ${label}`, () => setPath(d, path, undefined));
      return;
    }
    const r = parseNum(s, o);
    if (r.bad) { status(`${label}：${r.bad}（没改）`, 'err'); inp.value = cur == null ? '' : String(cur); return; }
    if (getPath(d, path) === r.n) return;
    edit(`改 ${label}`, () => setPath(d, path, r.n));
  });
  return row(label, inp, o.unit ? h('span', { class: 'unit', text: o.unit }) : null);
}
function colorRow(label, path, def) {
  const doc = curDoc();
  const cur = getPath(doc, path);
  const vals = Array.isArray(cur) ? cur : [];
  const inputs = [0, 1, 2].map((i) => {
    const inp = h('input', { type: 'text', class: 'c3', value: typeof vals[i] === 'number' ? String(vals[i]) : '', placeholder: def ? String(def[i]) : '' });
    inp.dataset.key = `doc.${path.join('.')}.${i}`;
    return inp;
  });
  const shown = Array.isArray(cur) ? cur : def;
  const sw = h('span', { class: 'sw', style: shown ? `background: rgb(${shown.map((c) => Math.round(Math.pow(clamp(Number(c) || 0, 0, 1), 1 / 2.2) * 255)).join(',')})` : '' });
  const commit = () => {
    const d = curDoc();
    if (!d) return;
    const s = inputs.map((x) => x.value.trim());
    if (s.every((x) => x === '')) { if (getPath(d, path) !== undefined) edit(`清 ${label}`, () => setPath(d, path, undefined)); return; }
    if (s.some((x) => x === '')) return;                               // 还没填全：等填完三格
    const n = s.map(Number);
    if (n.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) { status(`${label}：三个 0..1 的数（线性 RGB）`, 'err'); return; }
    if (canonJson(getPath(d, path)) === canonJson(n)) return;
    edit(`改 ${label}`, () => setPath(d, path, n));
  };
  inputs.forEach((x) => x.addEventListener('change', commit));
  return row(label, ...inputs, sw);
}
/** 下拉（模板文档路径）。`options = [[值, 文字]]`；`emptyLabel` 给了 = 有一个"不写"的选项（选它 = 删键） */
function selRow(label, path, options, emptyLabel, onPick) {
  const doc = curDoc();
  const cur = getPath(doc, path);
  const sel = h('select', { class: 'wide' });
  sel.dataset.key = `doc.${path.join('.')}`;
  if (emptyLabel !== undefined) sel.append(h('option', { value: '', text: emptyLabel }));
  const known = new Set();
  for (const [v, t] of options) { known.add(String(v)); sel.append(h('option', { value: String(v), text: t })); }
  if (cur != null && !known.has(String(cur))) sel.append(h('option', { value: String(cur), text: `${cur}（不在候选里，原样保留）` }));
  sel.value = cur == null ? '' : String(cur);
  sel.addEventListener('change', () => {
    const d = curDoc();
    if (!d) return;
    const v = sel.value;
    if (onPick) { onPick(d, v); return; }
    if (v === '') { if (getPath(d, path) !== undefined) edit(`清 ${label}`, () => setPath(d, path, undefined)); return; }
    if (getPath(d, path) === v) return;
    edit(`改 ${label}`, () => setPath(d, path, v));
  });
  return row(label, sel);
}
function checkRow(label, checked, onToggle, tip, key) {
  const cb = h('input', { type: 'checkbox' });
  cb.checked = !!checked;
  if (tip) cb.title = tip;
  if (key) cb.dataset.key = key;
  cb.addEventListener('change', () => onToggle(cb.checked));
  return row(label, cb);
}

// ---------------------------------------------------------------------------
// 真实尺寸 / 握点
// ---------------------------------------------------------------------------
/** 当前模板图的像素宽高（原画装上之前 = null） */
function docImageSize() {
  const doc = curDoc();
  const img = doc ? imageOf(doc.image) : null;
  return img ? [img.naturalWidth, img.naturalHeight] : null;
}
/** 尺寸宽高比相对图偏多少（`|尺寸比 / 图比 − 1|`），与服务端 `store.aspect_deviation` 同式 */
function aspectDeviation(doc, size) {
  const w = doc && doc.widthCm, hh = doc && doc.heightCm;
  if (!size || !(typeof w === 'number' && w > 0 && typeof hh === 'number' && hh > 0) || !(size[0] > 0 && size[1] > 0)) return null;
  return Math.abs((w / hh) / (size[0] / size[1]) - 1);
}
function aspectTolerance() { return typeof S.boot.aspectTolerance === 'number' ? S.boot.aspectTolerance : 0.02; }

/** 改宽或高：锁着比例时另一边按图比例跟（一条历史） */
function commitSize(which, n) {
  const d = curDoc();
  if (!d) return false;
  const size = docImageSize();
  const other = which === 'widthCm' ? 'heightCm' : 'widthCm';
  const follow = S.sizeLock && size && size[0] > 0 && size[1] > 0;
  const ov = follow ? round2(which === 'widthCm' ? n * size[1] / size[0] : n * size[0] / size[1]) : undefined;
  if (d[which] === n && (!follow || d[other] === ov)) return false;
  return edit(`改真实尺寸 ${which === 'widthCm' ? '宽' : '高'}`, () => {
    d[which] = n;
    if (follow && ov > 0) d[other] = ov;
  });
}

function sizeSection() {
  const doc = curDoc();
  const size = docImageSize();
  const rows = [];
  const inp = (which, label) => {
    const cur = doc[which];
    const x = h('input', { type: 'text', inputmode: 'decimal', value: typeof cur === 'number' ? String(cur) : cur == null ? '' : String(cur), placeholder: '必填' });
    x.dataset.key = `doc.${which}`;
    x.addEventListener('change', () => {
      const s = x.value.trim();
      if (s === '') { status(`真实尺寸${label}必填（闸门硬拒缺尺寸）`, 'err'); x.value = cur == null ? '' : String(cur); return; }
      const r = parseNum(s, { gt: 0 });
      if (r.bad) { status(`真实尺寸${label}：${r.bad}（没改）`, 'err'); x.value = cur == null ? '' : String(cur); return; }
      commitSize(which, r.n);
    });
    return x;
  };
  rows.push(row('宽 widthCm', inp('widthCm', '宽'), h('span', { class: 'unit', text: 'cm' })));
  rows.push(row('高 heightCm', inp('heightCm', '高'), h('span', { class: 'unit', text: 'cm' })));
  rows.push(checkRow('锁宽高比（按图）', S.sizeLock, (on) => { S.sizeLock = on; renderInspector(); },
    '锁着：改宽，高按图的像素比例跟；改高，宽跟。解锁后两边各改各的（页面偏好，不写资源）', 'size.lock'));
  const W = typeof doc.widthCm === 'number' ? doc.widthCm : NaN, Hh = typeof doc.heightCm === 'number' ? doc.heightCm : NaN;
  if (!(W > 0 && Hh > 0)) rows.push(note('⚠ 真实尺寸没写全：保存会被拒（游戏里这份模板不建）', 'loud'));
  if (size) rows.push(note(`图 ${size[0]}×${size[1]} px · 1 m = 88 wu ⇒ 画出来 ${fmt(W * 0.88, 1)} × ${fmt(Hh * 0.88, 1)} wu（宿主的缩放照乘）`));
  const dev = aspectDeviation(doc, size);
  if (dev !== null && dev > aspectTolerance()) {
    rows.push(h('div', { class: 'note loud', 'data-warn': 'aspect',
      text: `⚠ 宽高比与图差 ${fmt(dev * 100, 1)}%（尺寸 ${fmt(W / Hh, 3)}，图 ${fmt(size[0] / size[1], 3)}）：挂到手上的挂件是等比缩放、按宽算，高会变成 ${fmt(W * size[1] / size[0], 2)} cm；场景实体按这个宽高拉伸画` }));
    rows.push(h('div', { class: 'btnrow' },
      h('button', { text: '按图比例改高', 'data-act': 'fixHeight', onclick: () => { const d = curDoc(); edit('按图比例改高', () => { d.heightCm = round2(d.widthCm * size[1] / size[0]); }); } }),
      h('button', { text: '按图比例改宽', 'data-act': 'fixWidth', onclick: () => { const d = curDoc(); edit('按图比例改宽', () => { d.widthCm = round2(d.heightCm * size[0] / size[1]); }); } })));
  }
  return sec('size', '真实尺寸（厘米）', ...rows);
}

function gripSection() {
  const doc = curDoc();
  const g = isObj(doc.grip) ? doc.grip : null;
  const rows = [];
  const uvIn = (k) => {
    const cur = g ? g[k] : undefined;
    const x = h('input', { type: 'text', class: 'c3', value: typeof cur === 'number' ? String(cur) : '', placeholder: k === 'u' ? '0.5' : '1' });
    x.dataset.key = `doc.grip.${k}`;
    x.addEventListener('change', () => {
      const d = curDoc();
      const s = x.value.trim();
      const r = parseNum(s, { min: 0, max: 1 });
      if (s === '' || r.bad) { status(`握点 ${k} 要 0..1${s === '' ? '（整个握点清掉用「清掉」）' : ''}`, 'err'); x.value = cur == null ? '' : String(cur); return; }
      const cu = isObj(d.grip) && typeof d.grip.u === 'number' ? d.grip.u : 0.5;
      const cv = isObj(d.grip) && typeof d.grip.v === 'number' ? d.grip.v : 1;
      const next = k === 'u' ? { u: r.n, v: cv } : { u: cu, v: r.n };
      if (isObj(d.grip) && d.grip.u === next.u && d.grip.v === next.v) return;
      edit(`改握点 ${k}`, () => { d.grip = Object.assign(isObj(d.grip) ? d.grip : {}, next); });
    });
    return x;
  };
  rows.push(row('握点 grip', h('span', { class: 'unit', text: 'u' }), uvIn('u'), h('span', { class: 'unit', text: 'v' }), uvIn('v'),
    h('button', { class: S.selGrip ? 'on' : '', text: '●', title: '选中（原画视图里拖）', onclick: () => { S.selGrip = true; S.selPoint = ''; setView('art'); setTool('select'); renderInspector(); requestDraw(); } }),
    g ? h('button', { text: '清掉', 'data-act': 'clearGrip', title: '删掉 grip：回到底边中点', onclick: () => edit('清握点', () => { delete curDoc().grip; }) }) : null));
  rows.push(note(g ? '挂到手上时挂点对准这一点（原画视图里青色实心点，拖它改）' : '没写 = 底边中点（原画视图里画成青色虚点；拖一下就写上）'));
  return sec('grip', '握点（挂到手上时）', ...rows);
}

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------
function docSections() {
  const doc = curDoc();
  const D = defaults();
  if (!doc) return [sec('doc', '可燃物模板', note('左栏选一份模板（或新建）'))];
  const out = [];
  const L = D ? D.look : {};
  const dirty = S.dirtyIds.includes(doc.id);
  out.push(sec('doc', `模板「${doc.id}」${dirty ? ' ●' : ''}`,
    row('id', h('span', { class: 'kv', text: doc.id }), h('button', { text: '重命名…', onclick: () => renameTemplate() })),
    (() => {
      const inp = h('input', { type: 'text', class: 'wide', value: typeof doc.label === 'string' ? doc.label : '' });
      inp.dataset.key = 'doc.label';
      inp.placeholder = `缺省 = id（${doc.id}）`;
      inp.addEventListener('change', () => {
        const d = curDoc(); const v = inp.value.trim();
        if (v === (d.label || '')) return;
        edit('改名称', () => { if (v) d.label = v; else delete d.label; });
      });
      return row('名称 label', inp);
    })(),
    row('原画 image', h('span', { class: 'path', text: doc.image || '（没写）', title: doc.image || '' }),
      h('button', { text: '换…', 'data-act': 'pickImage', onclick: () => pickTemplateImage() })),
    selRow('燃烧方式 mode', ['mode'], [['spread', '面燃烧（纸 / 布 / 纸扎）'], ['consume', '消耗燃烧（蜡烛 / 香）']], doc.mode === undefined ? '不写（= spread）' : undefined),
    selRow('摆法 orientation', ['orientation'], [['upright', '立着（浮力沿图的上方）'], ['ground', '平躺（浮力不在画面内）']], doc.orientation === undefined ? '不写（= upright）' : undefined),
    numRow('网格长边 gridCells', ['gridCells'], { def: D && D.gridCells, int: true, min: 16, max: 160, tip: '模拟网格长边格数（16..160）' }),
  ));
  out.push(sizeSection());
  out.push(gripSection());
  // 燃料
  const fuelMask = doc.fuel && typeof doc.fuel.maskData === 'string';
  out.push(sec('fuel', '燃料 fuel',
    numRow('alpha 阈值', ['fuel', 'alphaThreshold'], { def: D && D.alphaThreshold, min: 0, max: 1, tip: '图的 alpha 低于它的地方不可燃（原画视图里压暗的格）' }),
    row('燃料涂层', h('span', { class: 'kv', text: fuelMask ? `有（${(doc.fuel.maskData.length / 1024).toFixed(1)} KB）` : '没有（alpha 以上全是 1）' }),
      h('button', { text: '去涂', onclick: () => { setView('art'); setTool('fuel'); } }),
      fuelMask ? h('button', { text: '清掉', onclick: () => edit('清燃料涂层', () => { const d = curDoc(); delete d.fuel.maskData; if (!Object.keys(d.fuel).length) delete d.fuel; }) }) : null),
  ));
  // 着火点
  const pts = Array.isArray(doc.ignitionPoints) ? doc.ignitionPoints : [];
  const ptRows = pts.map((p, i) => {
    if (!isObj(p)) return note(`第 ${i + 1} 个着火点不是对象（保存会被拒）`, 'err');
    const idIn = h('input', { type: 'text', value: String(p.id ?? ''), style: 'width:64px' });
    idIn.dataset.key = `doc.ignitionPoints.${i}.id`;
    idIn.addEventListener('change', () => {
      const d = curDoc(); const v = idIn.value.trim();
      if (v === p.id) return;
      if (!validId(v)) { status('着火点 id：只许字母数字 _ - 与汉字', 'err'); idIn.value = p.id; return; }
      if (d.ignitionPoints.some((q, k) => k !== i && q && q.id === v)) { status(`着火点 id「${v}」重复`, 'err'); idIn.value = p.id; return; }
      const wasSel = S.selPoint === p.id;
      edit(`改着火点 id ${p.id}→${v}`, () => { d.ignitionPoints[i].id = v; });
      if (wasSel) S.selPoint = v;
    });
    const uvIn = (k) => {
      const inp = h('input', { type: 'text', class: 'c3', value: typeof p[k] === 'number' ? String(p[k]) : '' });
      inp.dataset.key = `doc.ignitionPoints.${i}.${k}`;
      inp.addEventListener('change', () => {
        const d = curDoc(); const n = Number(inp.value.trim());
        if (!Number.isFinite(n) || n < 0 || n > 1 || inp.value.trim() === '') { status(`着火点 ${k} 要 0..1`, 'err'); inp.value = String(p[k] ?? ''); return; }
        if (d.ignitionPoints[i][k] === n) return;
        edit(`改着火点 ${p.id} ${k}`, () => { d.ignitionPoints[i][k] = n; });
      });
      return inp;
    };
    return h('div', { class: 'row' }, h('button', { class: S.selPoint === p.id && !S.selGrip ? 'on' : '', text: '●', title: '选中（原画视图里拖）', onclick: () => { S.selPoint = p.id; S.selGrip = false; renderInspector(); requestDraw(); } }),
      idIn, h('span', { class: 'unit', text: 'u' }), uvIn('u'), h('span', { class: 'unit', text: 'v' }), uvIn('v'),
      h('button', { text: '×', title: '删这个着火点', onclick: () => edit(`删着火点 ${p.id}`, () => { const d = curDoc(); d.ignitionPoints.splice(i, 1); if (!d.ignitionPoints.length) delete d.ignitionPoints; }) }));
  });
  out.push(sec('points', `着火点 ignitionPoints · ${pts.length}`,
    note(pts.length ? '玩家点火时火头伸到离火头最近的那个；动作 igniteBurnable 缺省取第一个；实例 initial: burning 也按第一个点着' : '没有着火点 = 火头伸到可燃物中间、整体一起点燃'),
    ...ptRows,
    h('div', { class: 'btnrow' }, h('button', { text: '加一个（中间）', onclick: () => { const d = curDoc(); const id = uniquePointId(d); edit(`加着火点 ${id}`, () => { if (!Array.isArray(d.ignitionPoints)) d.ignitionPoints = []; d.ignitionPoints.push({ id, u: 0.5, v: 0.5 }); }); S.selPoint = id; S.selGrip = false; } }),
      h('button', { text: '在原画上点着加', onclick: () => { setView('art'); setTool('point'); } })),
  ));
  const mode = doc.mode === 'consume' ? 'consume' : 'spread';
  if (mode === 'spread') {
    out.push(sec('spread', '蔓延 spread（面燃烧）',
      numRow('逆流 / 横着烧', ['spread', 'speedOpposed'], { def: D && D.speedOpposed, gt: 0, unit: 'cm/s' }),
      numRow('顺流（往上）', ['spread', 'speedConcurrent'], { def: D && D.speedConcurrent, gt: 0, unit: 'cm/s', tip: '比逆流慢时运行时按逆流算' }),
      note('火线速度按真实尺寸算：原画视图里的预览就是游戏里的快慢'),
      isObj(doc.consume) ? h('div', { class: 'row' }, note('写着 consume 块：面燃烧用不上', 'warn'), h('button', { text: '删掉', onclick: () => edit('删 consume 块', () => delete curDoc().consume) })) : null,
      isObj(doc.blowout) ? h('div', { class: 'row' }, note('写着 blowout 块：面燃烧吹不灭', 'warn'), h('button', { text: '删掉', onclick: () => edit('删 blowout 块', () => delete curDoc().blowout) })) : null,
    ));
  } else {
    const c = isObj(doc.consume) ? doc.consume : {};
    const order = typeof c.orderData === 'string';
    out.push(sec('consume', '消耗 consume（蜡烛 / 香）',
      numRow('累计明火秒 seconds', ['consume', 'seconds'], { def: D && D.consumeSeconds, gt: 0, unit: 's' }),
      selRow('从哪头烧 from', ['consume', 'from'], [['top', '上 → 下'], ['bottom', '下 → 上'], ['left', '左 → 右'], ['right', '右 → 左']], '不写（= top）'),
      row('顺序涂层', h('span', { class: 'kv', text: order ? '有（优先于 from）' : '没有（按 from）' }),
        h('button', { text: '去涂', onclick: () => { setView('art'); setTool('order'); } }),
        order ? h('button', { text: '清掉', onclick: () => edit('清顺序涂层', () => { const d = curDoc(); delete d.consume.orderData; if (!Object.keys(d.consume).length) delete d.consume; }) }) : null),
      numRow('火苗列 flameU', ['consume', 'flameU'], { min: 0, max: 1, tip: '空 = 燃料的横向重心' }),
      numRow('火苗列宽 flameWidth', ['consume', 'flameWidth'], { def: D && D.flameWidth, gt: 0, max: 1 }),
      isObj(doc.spread) ? h('div', { class: 'row' }, note('写着 spread 块：消耗燃烧用不上', 'warn'), h('button', { text: '删掉', onclick: () => edit('删 spread 块', () => delete curDoc().spread) })) : null,
    ));
  }
  out.push(sec('timing', '时长 / 火焰',
    numRow('明火 flameSeconds', ['flameSeconds'], { def: D && D.flameSeconds, gt: 0, unit: 's', tip: '一处明火烧多久；消耗燃烧 = 火线带厚度' }),
    numRow('余烬 emberSeconds', ['emberSeconds'], { def: D && D.emberSeconds, min: 0, unit: 's' }),
    numRow('火焰长 flameLength', ['flameLength'], { def: D && D.flameLength, gt: 0, unit: 'cm', tip: '引燃别人够得着多远、浮力速度、火光中心高度' }),
    numRow('引燃延迟 ignitionDelay', ['ignitionDelay'], { def: D && D.ignitionDelay, min: 0, unit: 's' }),
    checkRow('雷劈能点着 lightningIgnites', doc.lightningIgnites === true,
      (on) => edit(on ? '雷劈能点着' : '雷劈不点着', () => { const d = curDoc(); if (on) d.lightningIgnites = true; else delete d.lightningIgnites; }),
      '落雷落点一定半径内、开了这一项的当场着（场景里摆的、手上拿的、纸钱薄片绑的都算）；点着会进存档、烧完永久没了。'
      + '场景里摆的还要过宿主那道门：不许玩家点 / 能点的条件没满足的，雷也不点', 'doc.lightningIgnites'),
  ));
  out.push(sec('look', '样子 look',
    numRow('烤黄提前 scorchSeconds', ['look', 'scorchSeconds'], { def: L.scorchSeconds, min: 0, unit: 's' }),
    colorRow('烤黄色 scorchColor', ['look', 'scorchColor'], L.scorchColor),
    colorRow('焦黑色 charColor', ['look', 'charColor'], L.charColor),
    numRow('火线色温 glowKelvin', ['look', 'glowKelvin'], { def: L.glowKelvin, min: 1000, max: 40000, unit: 'K' }),
    numRow('火线强度 glowStrength', ['look', 'glowStrength'], { def: L.glowStrength, min: 0 }),
    numRow('余烬色温 emberKelvin', ['look', 'emberKelvin'], { def: L.emberKelvin, min: 1000, max: 40000, unit: 'K' }),
    numRow('余烬强度 emberStrength', ['look', 'emberStrength'], { def: L.emberStrength, min: 0 }),
    colorRow('灰色 ashColor', ['look', 'ashColor'], L.ashColor),
    numRow('灰不透明 ashAlpha', ['look', 'ashAlpha'], { def: L.ashAlpha, min: 0, max: 1, tip: '0 = 烧没' }),
    numRow('成灰过渡 ashFadeSeconds', ['look', 'ashFadeSeconds'], { def: L.ashFadeSeconds, min: 0, unit: 's' }),
    numRow('毛边 edgeNoise', ['look', 'edgeNoise'], { def: L.edgeNoise, min: 0, unit: 's' }),
  ));
  // 粒子
  const parts = Array.isArray(doc.particles) ? doc.particles : [];
  const effOpts = S.effects.map((e) => [e.id, `${e.id}${e.label ? ` · ${e.label}` : ''}${e.external ? '' : '（发射形状不是 external）'}`]);
  const partRows = parts.map((p, i) => {
    if (!isObj(p)) return note(`particles[${i}] 不是对象（保存会被拒）`, 'err');
    const eff = h('select', { class: 'wide' });
    eff.dataset.key = `doc.particles.${i}.effect`;
    const known = new Set(effOpts.map((x) => x[0]));
    for (const [v, t] of effOpts) eff.append(h('option', { value: v, text: t }));
    if (!known.has(p.effect)) eff.append(h('option', { value: p.effect || '', text: `${p.effect || '（空）'}（不在效果库里）` }));
    eff.value = p.effect || '';
    eff.addEventListener('change', () => { const v = eff.value; if (v !== p.effect) edit(`改粒子 ${i + 1} 效果`, () => { curDoc().particles[i].effect = v; }); });
    const from = h('select', {});
    from.dataset.key = `doc.particles.${i}.from`;
    for (const [v, t] of [['flame', '明火'], ['ember', '余烬'], ['ash', '成灰（飞灰）']]) from.append(h('option', { value: v, text: t }));
    if (!['flame', 'ember', 'ash'].includes(p.from)) from.append(h('option', { value: String(p.from ?? ''), text: `${p.from}（不合法）` }));
    from.value = String(p.from ?? '');
    from.addEventListener('change', () => { const v = from.value; if (v !== p.from) edit(`改粒子 ${i + 1} 来源`, () => { curDoc().particles[i].from = v; }); });
    const ref = h('input', { type: 'text', class: 'c3', value: typeof p.refArea === 'number' ? String(p.refArea) : '', placeholder: String(D ? D.particleRefArea : 100), title: '参考面积 cm²：效果里的发射率 = 这么大一块在烧时的量' });
    ref.dataset.key = `doc.particles.${i}.refArea`;
    ref.addEventListener('change', () => {
      const s = ref.value.trim();
      if (s === '') { if (p.refArea !== undefined) edit(`清粒子 ${i + 1} 参考面积`, () => { delete curDoc().particles[i].refArea; }); return; }
      const n = Number(s);
      if (!(Number.isFinite(n) && n > 0)) { status('参考面积要 > 0（cm²）', 'err'); ref.value = p.refArea ?? ''; return; }
      if (n !== p.refArea) edit(`改粒子 ${i + 1} 参考面积`, () => { curDoc().particles[i].refArea = n; });
    });
    const mv = (dlt) => edit('粒子挪位置', () => { const a = curDoc().particles; const j = i + dlt; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; });
    return h('div', { class: 'sub' }, h('div', { class: 'row' }, eff), h('div', { class: 'row' }, from, h('span', { class: 'unit', text: 'cm²' }), ref,
      h('button', { text: '↑', onclick: () => mv(-1) }), h('button', { text: '↓', onclick: () => mv(1) }),
      h('button', { text: '×', onclick: () => edit(`删粒子 ${i + 1}`, () => { const d = curDoc(); d.particles.splice(i, 1); if (!d.particles.length) delete d.particles; }) })));
  });
  out.push(sec('particles', `粒子 particles · ${parts.length}`,
    ...partRows,
    S.effects.length ? h('div', { class: 'btnrow' }, h('button', { text: '加一条', onclick: () => edit('加粒子', () => { const d = curDoc(); if (!Array.isArray(d.particles)) d.particles = []; d.particles.push({ effect: (S.effects.find((e) => e.external) || S.effects[0]).id, from: 'flame' }); }) }))
      : note('效果库里没有粒子效果（assets/data/vfx/），先去粒子工作台做一个 external 发射形状的', 'warn'),
  ));
  // 火光
  const light = isObj(doc.light) ? doc.light : null;
  out.push(sec('light', '火光 light',
    checkRow('有火光', !!light, (on) => edit(on ? '加火光' : '去掉火光', () => { const d = curDoc(); if (on) d.light = { kelvin: 1700, intensityPerM2: 12 }; else delete d.light; })),
    ...(light ? [
      numRow('色温 kelvin', ['light', 'kelvin'], { def: 1700, min: 1000, max: 40000, unit: 'K', tip: '写了 color 时运行时用 color' }),
      colorRow('颜色 color', ['light', 'color'], null),
      numRow('每 m² 强度', ['light', 'intensityPerM2'], { required: true, gt: 0, tip: '实际 = 它 × 明火面积 × 闪烁' }),
      numRow('强度上限', ['light', 'maxIntensity'], { gt: 0, tip: '空 = 不封' }),
      numRow('范围 range', ['light', 'range'], { def: D && D.lightRange, gt: 0, unit: 'wu' }),
      numRow('软化半径', ['light', 'softeningRadius'], { def: D && D.lightSoftening, gt: 0, unit: 'wu' }),
      numRow('喘幅度 puffAmp', ['light', 'puffAmp'], { def: D && D.lightPuffAmp, min: 0, max: 1 }),
      checkRow('投影 castShadow', light.castShadow === true, (on) => edit(on ? '火光投影' : '火光不投影', () => { const d = curDoc(); if (on) d.light.castShadow = true; else delete d.light.castShadow; })),
    ] : []),
  ));
  if (mode === 'consume') {
    const bo = isObj(doc.blowout) ? doc.blowout : null;
    out.push(sec('blowout', '吹熄 blowout（只对消耗燃烧）',
      checkRow('会被风吹灭', !!bo, (on) => edit(on ? '加吹熄' : '去掉吹熄', () => { const d = curDoc(); if (on) d.blowout = { windSpeed: 3, drainSeconds: 1.5, recoverSeconds: 2 }; else delete d.blowout; })),
      ...(bo ? [
        numRow('吹熄风速', ['blowout', 'windSpeed'], { required: true, gt: 0, unit: 'm/s' }),
        numRow('掉到底秒数', ['blowout', 'drainSeconds'], { required: true, gt: 0, unit: 's', tip: '风是吹熄风速两倍时从满到底' }),
        numRow('回满秒数', ['blowout', 'recoverSeconds'], { required: true, gt: 0, unit: 's', tip: '无风时从底回满' }),
        S.view === 'art' && !(S.wind.mps > 0) ? note('原画视图的预览风是「无」：吹不灭（底栏「风」选一档试）', 'warn') : null,
      ] : []),
    ));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 场景视图：选中实例（只读）+ 站位
// ---------------------------------------------------------------------------
function entitySection() {
  const sv = S.sv;
  if (S.view !== 'scene' || !sv) return null;
  if (!sv.scene) return sec('entity', '场景视图', note('场景装载中…'));
  const ent = sv.scene.entities.find((e) => e.id === sv.entityId);
  if (!ent) return sec('entity', `场景「${sv.scene.id}」· 实例`, note('点一个实例看它（只读：摆放 / 可燃配置在主编辑器场景页里改）'));
  const it = sceneItem(ent.id);
  const host = ent.host || {};
  const rows = [];
  const persp = entityPerspective(ent);
  rows.push(h('div', { class: 'kv', text:
    `${KIND_LABEL[ent.kind] || ent.kind} ${ent.id}${ent.label ? ` · ${ent.label}` : ''}\n`
    + `模板 ${ent.template}${ent.template === S.docId ? '（当前模板：用页面工作态）' : ''}\n`
    + `(${fmt(Number(ent.x), 1)}, ${fmt(Number(ent.y), 1)}) · scale ${ent.scale ?? 1} · 旋转 ${ent.rotation ?? 0}°${ent.anchor ? ` · 锚点 (${ent.anchor.x ?? 0.5}, ${ent.anchor.y ?? 1})` : ''}\n`
    + `朝${entityFacingLeft(ent) ? '左' : '右'} · 透视 ${persp ? `吃（×${it ? fmt(it.depthScale, 3) : '?'}）` : '不吃'}${ent.kind === 'npc' ? '（NPC 缺省吃；renderRaw 不吃）' : '（热点只有 perspectiveScaleEnabled 才吃）'}\n`
    + (it ? `画出来 ${fmt(S.rt.burnGeometry.burnFrameExtent(it.frame).width, 1)} × ${fmt(S.rt.burnGeometry.burnFrameExtent(it.frame).height, 1)} wu · 交互圈 ${fmt(interactionRadius(it), 1)} wu` : '') }));
  rows.push(h('div', { class: 'kv', text:
    `实例配置（宿主身上的 burnable，只读）\n`
    + `  初始 ${host.initial === 'burning' ? '在烧（0 秒点着）' : '没点'} · 玩家按 E ${host.playerIgnite === false ? '不能点' : '能点'}`
    + `${Array.isArray(host.igniteConditions) && host.igniteConditions.length ? ` · 点火条件 ${host.igniteConditions.length} 条` : ''}\n`
    + `  信号：${isObj(host.signals) && Object.keys(host.signals).length ? Object.entries(host.signals).map(([k, v]) => `${k} → ${v}`).join('，') : '不发'}` }));
  for (const p of P.sc.problems.filter((x) => x.key === ent.id)) rows.push(note(p.msg, p.level === 'error' ? 'err' : 'warn'));
  if (ent.template !== S.docId && S.docs[ent.template]) {
    rows.push(h('div', { class: 'btnrow' }, h('button', { text: `打开模板「${ent.template}」`, 'data-act': 'openEntityTemplate',
      title: '检视器下半截换成这份模板（场景视图留着）', onclick: () => { void openTemplate(ent.template, { view: 'scene' }); } })));
  }
  rows.push(note('改摆放、改可燃配置：去主编辑器的场景页（这里只读）'));
  return sec('entity', `场景「${sv.scene.id}」· ${ent.id}`, ...rows);
}

function stanceSection() {
  const sv = S.sv;
  if (S.view !== 'scene' || !sv || !sv.entityId || !sceneItem(sv.entityId)) return null;
  const st = S.stances;
  const rows = [];
  const inp = st && st.input;
  const psel = h('select', { class: 'wide' });
  psel.dataset.key = 'stance.preset';
  if (!S.presets.length) psel.append(h('option', { value: '', text: '（没有能点火的挂件预设）' }));
  for (const p of S.presets) psel.append(h('option', { value: p.id, text: `${p.id}${p.label ? ` · ${p.label}` : ''}` }));
  psel.value = (inp && inp.presetRow && inp.presetRow.id) || S.stance.presetId || '';
  psel.addEventListener('change', () => { S.stance.presetId = psel.value; S.stance.state = ''; refreshStances(); });
  rows.push(row('手里拿的 预设', psel));
  if (inp && inp.stateNames && inp.stateNames.length) {
    const ssel = h('select', {});
    ssel.dataset.key = 'stance.state';
    for (const n of inp.stateNames) ssel.append(h('option', { value: n, text: n }));
    ssel.value = inp.stateName || '';
    ssel.addEventListener('change', () => { S.stance.state = ssel.value; refreshStances(); });
    rows.push(row('状态', ssel));
  }
  if (inp && inp.socketNames && inp.socketNames.length) {
    const ksel = h('select', {});
    ksel.dataset.key = 'stance.socket';
    for (const n of inp.socketNames) ksel.append(h('option', { value: n, text: n }));
    ksel.value = inp.socket || '';
    ksel.addEventListener('change', () => { S.stance.socket = ksel.value; refreshStances(); });
    rows.push(row('挂点', ksel));
  }
  if (!st) { rows.push(note('站位还没算（预览建起来之后）')); return sec('stance', '点火站位', ...rows); }
  if (st.contactNote) rows.push(note(st.contactNote, /用 idle|没标/.test(st.contactNote) ? 'warn' : ''));
  for (const p of st.problems) if (p !== st.contactNote) rows.push(note(p, 'warn'));
  const walk = S.walk && S.walk.key === st.walkKey ? S.walk : null;
  rows.push(note(walk ? `能不能站：${walk.source === 'game' ? '游戏判定（它自己的 isCollision）' : `本地判定 · ${walk.note || ''}`}` : '能不能站：还没判', walk && walk.source === 'game' ? 'ok' : ''));
  let fi = 0;
  for (const pt of st.points) {
    const t = pt.target;
    const lines = [`${t.id ? `着火点 ${t.id}` : '中间（整体点着）'} · uv (${fmt(t.u, 3)}, ${fmt(t.v, 3)}) → 画面 (${fmt(t.scene.x, 1)}, ${fmt(t.scene.y, 1)})`];
    for (const [side, label] of [[pt.right, '朝右（人在左）'], [pt.left, '朝左（人在右）']]) {
      if (!side) { lines.push(`  ${label}：解不出（这一帧没标挂点 / 片段不存在）`); continue; }
      const verdict = walk ? walk.results[fi] : undefined;
      fi++;
      const ws = verdict === true ? '✓ 站得了' : verdict === false ? '✗ 站不了' : '? 未判';
      lines.push(`  ${label}：脚 (${fmt(side.x, 1)}, ${fmt(side.y, 1)}) · 残差 ${side.residual < 1e-3 ? side.residual.toExponential(1) : fmt(side.residual, 3)} wu · ${ws}`
        + ` · 离实体 ${fmt(side.dist, 0)} wu${side.outOfRange ? `（⚠ 在交互圈 ${fmt(st.radius, 0)} 外：表演开始时玩家在圈内，要多走一截）` : ''}`);
    }
    rows.push(h('div', { class: 'kv', text: lines.join('\n') }));
  }
  rows.push(note('游戏里先试「着火点那一侧」的朝向（人在火点左边就朝右点），站不了换另一侧，两侧都站不了原地点（火头对不齐）'));
  return sec('stance', '点火站位', ...rows);
}

// ---------------------------------------------------------------------------
// 预览读数 / 游戏
// ---------------------------------------------------------------------------
function previewSection() {
  const rows = [];
  const list = [];
  if (S.view === 'art') { if (P.art && P.art.sim && P.art.id === S.docId) list.push([P.art.sim, P.art]); }
  else if (P.sc.sim) for (const it of P.sc.items) list.push([P.sc.sim, it]);
  if (!list.length) rows.push(note(S.rt ? '没有可预览的实例' : '没有运行时包：本地预览不可用', S.rt ? '' : 'err'));
  for (const [sim, it] of list) {
    const r = itemReadout(sim, it);
    if (!r) continue;
    const parts = r.particles.map((p) => `${p.effect}(${p.from}) ×${fmt(p.rate, 2)}`).join('，');
    rows.push(h('div', { class: 'kv', text:
      `${it.key === TEMPLATE_KEY ? `模板「${it.b.id}」（真实尺寸）` : `${it.key} · ${it.b.id}`} · ${STATE_LABEL[r.state] || r.state}\n`
      + `  剩余燃料 ${fmt(r.fuelLeft * 100, 0)}% · 在烧 ${r.flameCount} 格 (${fmt(r.flameArea, 0)} cm²)${it.b.mode === 'consume' ? ` · 火势 ${fmt(r.vit, 2)}` : ''} · 事件 ${r.events}\n`
      + `  火光 ${r.light ? fmt(r.light.intensity, 2) : '—'}${parts ? ` · 粒子 ${parts}` : ''}` }));
  }
  if (S.view === 'scene') {
    const sel = S.sv ? S.sv.entityId : '';
    for (const p of P.sc.problems.filter((x) => x.key !== sel)) rows.push(note(`${p.key}：${p.msg}`, p.level === 'error' ? 'err' : 'warn'));
  }
  return sec('preview', `预览 · t=${fmt(P.t, 2)} s`, ...rows);
}

function gameItemLabel(it) {
  return it.kind === 'held' ? `手上 ${it.target} · ${it.socket || '?'}` : `${it.sceneId || '?'} / ${it.target}`;
}
function gameSection() {
  const st = S.link.status;
  const rows = [];
  if (!st || !st.connected) rows.push(note(`游戏没开（${(st && st.gameUrl) || S.link.gameUrl || '?'}）：开了会自动推过去`));
  else if (!st.gameAlive) rows.push(note('dev server 在，但没有游戏页'));
  else {
    const d = st.doc || {};
    rows.push(h('div', { class: 'kv', text: `游戏在「${d.sceneId || '?'}」· 用的是${d.appliedRev ? `工作态 #${d.appliedRev}` : '盘上那份'} · 燃烧钟 ${d.stats ? d.stats.clock : '?'} s\n`
      + `实例 ${d.stats ? d.stats.items : '?'} · 在烧 ${d.stats ? d.stats.burning : '?'} · 灯 ${d.stats ? d.stats.lights : '?'} · 粒子 ${d.stats ? d.stats.particles : '?'} · 模拟 ${d.stats ? d.stats.simMs : '?'} ms` }));
    const items = Array.isArray(d.items) ? d.items : [];
    const mine = items.filter((it) => it && it.template === S.docId);
    if (!mine.length) rows.push(note(`游戏里此刻没有用「${S.docId}」的实例（当前场景 + 手上的）`));
    for (const it of mine) rows.push(h('div', { class: 'kv', text: `  ${gameItemLabel(it)} · ${STATE_LABEL[it.state] || it.state} · 事件 ${it.events}${it.ready ? '' : ' · 没就绪'}` }));
    const others = items.length - mine.length;
    if (others > 0) rows.push(note(`另有 ${others} 个实例用别的模板`));
    if (st.probeSeq) rows.push(note(`探针 #${st.probeSeq} ${d.probeSeqDone >= st.probeSeq ? '✓ 游戏做了' : '… 还没做（游戏里没有那个实例 / 不在那个场景）'}`));
  }
  if (S.link.err) rows.push(note(S.link.err, 'err'));
  for (const n of S.link.notes) rows.push(note(n, 'warn'));
  return sec('game', '游戏', ...rows);
}

function renderInspector() {
  const side = el('side');
  if (window.Dropdown && window.Dropdown.isOpen()) { renderInspectorSoon(); return; }
  const ae = document.activeElement;
  const focusKey = ae && side.contains(ae) && ae.dataset ? ae.dataset.key : '';
  const scroll = side.scrollTop;
  side.textContent = '';
  const secs = S.view === 'scene'
    ? [entitySection(), stanceSection(), previewSection(), gameSection(), ...docSections()]
    : [...docSections(), previewSection(), gameSection()];
  for (const s of secs) if (s) side.append(s);
  side.scrollTop = scroll;
  if (focusKey) {
    const t = side.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    if (t) t.focus({ preventScroll: true });
  }
}
