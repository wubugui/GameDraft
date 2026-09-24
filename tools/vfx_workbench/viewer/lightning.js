'use strict';
/* 粒子工作台 · 雷电样式（检视器里的一节 + 动态预览）。
 *
 * 制作人 2026-09-24："我能不能四个都支持，然后可以随时改参数换样式"；同日定调雷要与 20 张参考图对齐、按世界单位摆在世界里。
 * 雷的长相 = 样式库 `assets/data/vfx_lightning_styles.json` 里的一套参数；效果资产的
 * `generator: {kind:'lightning', style, seed, group}` 说这份效果用哪套、哪个种子、和谁一组。雷在游戏里**现画**：
 * 套用 = 把参数写进效果的 `bolts` 与那几层发射器（主雷 / 回击加粗 / 落地电弧 / 水面电弧）。数据与存盘规矩全在
 * `tools/vfx_workbench/lightning.py`；这里只是作者面：
 *
 * - **控件照服务端的参数表生成**（`/api/lightning` 的 `spec`），名字、单位、上下限都是那一份，页面不另写。
 * - 改参数 / 换样式 / 另存 / 删 / 恢复预设：都经 `host.edit` 进同一条撤销栈（快照里带着样式库草稿与"换样式"清单），
 *   但**不算效果的脏**：样式库有自己的「●未套用」，要点「套用」才落盘（样式库 + 受影响的效果一次做完）。
 * - **渲染只读**：`section()` 绝不写 doc / 样式库，写只在 `host.edit` 的闭包里。
 * - 预览：草稿参数经服务端拼成「套用之后」的样子（只读），用 bundle 里与游戏同一份的代码现画（见 `BoltPreview`）。
 * - 同组几份效果：样式层各自按种子画；别的层（落点光团、碎石、水花……）用「把别的层同步给同组」从这一份抄过去。 */

const LightningPanel = {
  /** 预览播放器（整页一个，检视器重建时把同一块画布挂回去，动画不断） */
  player: null,
  /** 在飞的预览请求：`{key, promise}`；最近一次要的 key（参数 + 种子），回来的不是它就丢掉 */
  pending: null, wantKey: '', timer: 0, previewErr: '', previewBusy: false,

  section(ins, host, doc) {
    const L = host.ls;
    const gen = doc && doc.generator && doc.generator.kind === 'lightning' ? doc.generator : null;
    if (!gen) return this.offSection(ins, host, doc);
    return ins.section('lightning', `雷电样式${host.lightningDirty ? ' ●未套用' : ''}`, () => this.body(ins, host, doc, gen, L));
  },

  /** 没有生成器的效果：一节折叠着的说明 + 「做成雷电」 */
  offSection(ins, host, doc) {
    return ins.section('lightningOff', '雷电样式（没用）', () => {
      const L = host.ls;
      const first = L.lib && L.lib.styles && L.lib.styles[0];
      return [
        h('div', { class: 'pad dim' }, '让这份效果的「主雷 / 回击加粗 / 落地电弧 / 水面电弧」由一套雷电样式来画（雷符的 10 道雷就是这样）。样式只管那几层，别的发射器不动'),
        h('div', { class: 'btns' }, h('button', {
          disabled: !first || !!L.err, 'data-role': 'lightning-enable',
          title: first ? `加上生成器（样式「${first.label}」、随机种子），再点「套用」写进那几层` : '样式库读不到',
          onclick: () => host.edit('做成雷电', () => {
            doc.generator = { kind: 'lightning', style: first.id, seed: Math.floor(Math.random() * 100000) };
          }),
        }, '让这个效果由雷电样式生成')),
      ];
    });
  },

  body(ins, host, doc, gen, L) {
    if (L.err) return [h('div', { class: 'pad warn' }, `样式库读不懂（只读，不会覆盖）：${L.err}`)];
    if (!L.lib) return [h('div', { class: 'pad dim' }, '样式库还没读到')];
    const E = (label, fn) => host.edit(label, fn);
    const styles = L.lib.styles;
    const members = this.groupMembers(host, doc, gen);
    const curId = (L.assign && L.assign[doc.id]) || gen.style;
    const style = styles.find((s) => s.id === curId) || null;
    const baseStyle = (L.baseLib && L.baseLib.styles || []).find((s) => s.id === curId) || null;
    const preset = (L.presets || []).find((p) => p.id === curId) || null;
    const users = this.usersOf(host, curId);
    const row = L.effects.find((r) => r.id === doc.id);
    const out = [];

    // ---- 用哪套
    out.push(ins.row('样式', ins.sel(() => curId, (v) => {
      if (!v || v === curId) return;
      E(`换成雷电样式「${(styles.find((s) => s.id === v) || {}).label || v}」`, () => {
        const a = L.assign || (L.assign = {});
        for (const id of members) {
          const now = this.currentStyleOf(host, id);
          if (v === now) delete a[id]; else a[id] = v;
        }
      });
    }, styles.map((s) => ({ value: s.id, label: `${s.label}（${(L.kinds || {})[s.kind] || s.kind}）` })))));
    out.push(h('div', { class: 'pad dim', 'data-role': 'lightning-group' }, members.length > 1
      ? `和「${gen.group}」一组的 ${members.length} 个效果一起换：${members.join(' / ')}`
      : '只有这一个效果（组名为空；同组的效果会一起换样式）'));
    const pendingAssign = Object.entries(L.assign || {}).filter(([id]) => members.includes(id));
    if (pendingAssign.length) {
      out.push(h('div', { class: 'pad warn' }, `要把 ${pendingAssign.length} 个效果换成「${style ? style.label : curId}」：点下面「套用」才生效（Ctrl+Z 可撤）`));
    }
    if (!style) {
      out.push(h('div', { class: 'pad warn' }, `样式「${curId}」不在样式库里：换一套，或恢复样式库`));
      return out.concat(this.effectRows(ins, host, doc, gen, row));
    }

    // ---- 预览
    out.push(this.previewBlock(host, doc, gen, style));

    // ---- 参数（改的是这套样式：用它的效果都会变）
    out.push(h('div', { class: 'pad dim', 'data-role': 'lightning-users' },
      `下面改的是样式「${style.label}」，用它的 ${users.length} 个效果都会变${users.length ? `（${users.slice(0, 4).join(' / ')}${users.length > 4 ? ' …' : ''}）` : ''}`));
    const spec = (L.spec || {})[style.kind] || [];
    let group = '';
    for (const sp of spec) {
      if (sp.group !== group) { group = sp.group; out.push(h('h4', {}, group)); }
      out.push(this.paramRow(ins, host, style, baseStyle, sp));
    }

    // ---- 套用 / 放弃 / 管理
    const affected = this.affectedCount(host);
    out.push(h('div', { class: 'btns' },
      h('button', {
        class: host.lightningDirty ? 'primary dirty' : 'primary', 'data-role': 'lightning-apply',
        disabled: !host.lightningDirty && !this.anyStale(host),
        title: '存样式库 + 把受影响的效果全部按样式重新套用、落盘（当前效果要先 Ctrl+S）',
        onclick: () => host.applyLightning(),
      }, affected ? `套用（${affected} 个效果）` : '套用'),
      h('button', { disabled: !host.lightningDirty, 'data-role': 'lightning-discard', title: '样式库与换样式回到上次套用后的样子（一条历史，可撤）',
        onclick: () => E('放弃雷电样式的改动', () => { L.lib = clone(L.baseLib); L.assign = {}; }) }, '放弃改动')));
    out.push(h('div', { class: 'btns' },
      h('button', { 'data-role': 'lightning-saveas', title: '把现在这套参数存成一套新样式，这一组改用它', onclick: () => this.saveAs(host, style, members) }, '另存为新样式…'),
      h('button', { 'data-role': 'lightning-relabel', title: '改这套样式显示的名字（id 不变）', onclick: () => this.relabel(host, style) }, '改名字…'),
      preset ? h('button', { 'data-role': 'lightning-reset', disabled: canonJson(preset.params) === canonJson(style.params),
        title: '参数回到内置预设', onclick: () => E(`「${style.label}」恢复成预设值`, () => { style.params = clone(preset.params); }) }, '恢复成预设值') : null,
      h('button', { class: 'danger', 'data-role': 'lightning-delete', disabled: users.length > 0 || styles.length <= 1,
        title: users.length ? `还有 ${users.length} 个效果用着它，先换走` : '从样式库删掉这套',
        onclick: () => this.remove(host, style) }, '删掉这套')));
    return out.concat(this.effectRows(ins, host, doc, gen, row));
  },

  /** 这份效果自己的几个量（种子 / 组）+ 产物是不是最新：这些是**效果**的改动（Ctrl+S 存） */
  effectRows(ins, host, doc, gen, row) {
    const E = (label, fn) => host.edit(label, fn);
    const out = [h('h4', {}, '这个效果')];
    out.push(ins.row('种子', ins.num(() => gen.seed, (v) => { if (v != null) E('改雷的种子', () => { doc.generator.seed = Math.max(0, Math.round(v)); }); }, '',
      { int: true, title: '同一套样式、不同种子 = 不同的一道雷（雷符每次在 10 道里挑一道不重样的）' })));
    out.push(ins.row('组', ins.txt(() => gen.group, (v) => E('改雷的组', () => { if (v) doc.generator.group = v; else delete doc.generator.group; }), '雷符天雷')));
    let state;
    const first = host.docDirty ? '先 Ctrl+S 存效果，再' : '';
    if (!row) state = `还没套用过：${first}点「套用」`;
    else if (row.upToDate && gen.built === row.expected) state = '是按现在的样式套用的';
    else state = `不是按现在的样式 / 种子套用的：${first}点「套用」`;
    out.push(h('div', { class: row && row.upToDate && gen.built === row.expected ? 'pad dim' : 'pad warn', 'data-role': 'lightning-state' }, state));
    if (gen.group) {
      const others = host.ls.effects.filter((r) => r.group === gen.group && r.id !== doc.id).length;
      out.push(h('div', { class: 'btns' }, h('button', {
        'data-role': 'lightning-sync-group', disabled: !others || host.docDirty,
        title: host.docDirty ? '先 Ctrl+S 存这份效果' : `把这份效果样式以外的那几层（落点光团、火星、碎石、扬尘、水花……）抄给同组其余 ${others} 份（落盘，样式层各自保留）`,
        onclick: () => host.syncLightningGroup(),
      }, `把别的层同步给同组（${others} 份）`)));
    }
    return out;
  },

  paramRow(ins, host, style, baseStyle, sp) {
    const E = (label) => (fn) => host.edit(`改「${style.label}」的${sp.label}`, fn);
    const get = () => style.params[sp.key];
    const lim = (x) => clamp(x, sp.min == null ? -Infinity : sp.min, sp.max == null ? Infinity : sp.max);
    const changed = baseStyle && canonJson(baseStyle.params[sp.key]) !== canonJson(style.params[sp.key]);
    const unit = sp.unit || '';
    let ctl;
    if (sp.type === 'bool') {
      ctl = ins.chk(get, (v) => E(sp.label)(() => { style.params[sp.key] = !!v; }), sp.label);
    } else if (sp.type === 'color') {
      ctl = ins.color(get, (v) => E(sp.label)(() => { style.params[sp.key] = v; }));
    } else if (sp.type === 'range' || sp.type === 'irange') {
      ctl = ins.pair(get, (v) => E(sp.label)(() => {
        let a = lim(v[0]), b = lim(v[1]);
        if (sp.type === 'irange') { a = Math.round(a); b = Math.round(b); }
        style.params[sp.key] = a <= b ? [a, b] : [b, a];
      }), unit);
    } else {
      ctl = ins.num(get, (v) => { if (v != null) E(sp.label)(() => { style.params[sp.key] = sp.type === 'int' ? Math.round(lim(v)) : lim(v); }); }, unit,
        { int: sp.type === 'int', step: sp.type === 'prob' ? 0.05 : 'any' });
    }
    const r = sp.type === 'bool' ? h('div', { class: 'row' }, h('span', {}, ''), ctl) : ins.row(sp.label, ctl);
    r.title = `${sp.help || ''}${sp.min != null ? `（${sp.min}–${sp.max}）` : ''}`;
    if (changed) { r.dataset.changed = 'true'; r.style.borderLeft = '2px solid var(--warn)'; r.style.paddingLeft = '4px'; }
    return r;
  },

  // ---------------------------------------------------------------- 组 / 用量
  currentStyleOf(host, id) {
    const L = host.ls;
    if (host.doc && host.doc.id === id && host.doc.generator) return host.doc.generator.style;
    const r = L.effects.find((x) => x.id === id);
    return r ? r.style : '';
  },
  groupMembers(host, doc, gen) {
    const g = gen.group || '';
    if (!g) return [doc.id];
    const ids = host.ls.effects.filter((r) => r.group === g).map((r) => r.id);
    if (!ids.includes(doc.id)) ids.push(doc.id);
    return ids.sort();
  },
  /** 换样式之后（按草稿里的清单）用这套样式的效果 */
  usersOf(host, styleId) {
    const L = host.ls, out = [];
    const ids = new Set(L.effects.map((r) => r.id));
    if (host.doc && host.doc.generator) ids.add(host.doc.id);
    for (const id of ids) if (((L.assign || {})[id] || this.currentStyleOf(host, id)) === styleId) out.push(id);
    return out.sort();
  },
  anyStale(host) { return host.ls.effects.some((r) => !r.upToDate); },
  affectedCount(host) {
    const L = host.ls;
    if (!L.lib) return 0;
    const base = new Map(((L.baseLib && L.baseLib.styles) || []).map((s) => [s.id, canonJson(s)]));
    const changed = new Set(L.lib.styles.filter((s) => base.get(s.id) !== canonJson(s)).map((s) => s.id));
    let n = 0;
    const rows = L.effects.slice();
    // 当前这份还不在服务端那张表里（刚加上生成器、还没存过）：它换了样式也算一个
    if (host.doc && host.doc.generator && !rows.some((r) => r.id === host.doc.id)) rows.push({ id: host.doc.id, style: host.doc.generator.style, upToDate: false });
    for (const r of rows) {
      const sid = (L.assign || {})[r.id] || r.style;
      if ((L.assign || {})[r.id] || changed.has(sid) || !r.upToDate) n++;
    }
    return n;
  },

  // ---------------------------------------------------------------- 管理
  async saveAs(host, style, members) {
    const label = await promptDialog('另存为新样式', '名字', `${style.label}（改）`);
    if (!label) return;
    const L = host.ls;
    const taken = new Set(L.lib.styles.map((s) => s.id));
    const baseId = label.replace(/[\\/:*?"<>|\s（）()]+/g, '_').replace(/^_+|_+$/g, '') || 'style';
    let id = baseId, n = 2;
    while (taken.has(id)) id = `${baseId}_${n++}`;
    host.edit(`另存为雷电样式「${label}」`, () => {
      L.lib.styles.push({ id, label, kind: style.kind, params: clone(style.params) });
      const a = L.assign || (L.assign = {});
      for (const m of members) a[m] = id;
    });
  },
  async relabel(host, style) {
    const label = await promptDialog('改样式名字', '名字（id 不变）', style.label);
    if (!label || label === style.label) return;
    host.edit(`样式改名为「${label}」`, () => { style.label = label; });
  },
  async remove(host, style) {
    if (!await confirmDialog(`删掉样式「${style.label}」`, '从样式库里删掉这套（点「套用」才落盘；Ctrl+Z 可撤）')) return;
    const L = host.ls;
    host.edit(`删掉雷电样式「${style.label}」`, () => { L.lib.styles = L.lib.styles.filter((s) => s.id !== style.id); });
  },

  // ---------------------------------------------------------------- 预览
  /**
   * 预览：草稿样式经服务端 `lightning.apply_style` 拼出「套用之后」的 bolts 与那几层（参数 → 效果的映射只有那一份），
   * 这里用 bundle 里与游戏同一份的 vfxBolt（形状）+ vfxBoltGlsl（逐段卷积、挑细分级、定粗细）现画。
   */
  previewBlock(host, doc, gen, style) {
    if (!this.player) this.player = new BoltPreview();
    const p = this.player;
    this.request(host, style, gen.seed, doc);
    if (!p.raf && p.composed) p.raf = requestAnimationFrame(p.loop);
    const person = (s) => Math.round(150 * s * p.canvasScale());
    const note = this.previewErr ? `预览拼不出来：${this.previewErr}`
      : p.err ? `预览画不了：${p.err}`
      : `左：远处（一个人约 ${person(p.far)} 像素）；右：近处（约 ${person(p.near)} 像素）——同一道雷，粗细 = 世界宽与屏幕下限合成`;
    return h('div', { class: 'lightningPreview' }, p.canvas,
      h('div', { class: 'btns' },
        h('button', { onclick: () => p.replay(true), title: '换一道（随机实例种子）从劈下那一刻重播' }, '▶ 再劈一道'),
        ins_chk(p.slow, (v) => { p.slow = v; }, '慢放 ¼'),
        ins_chk(p.water, (v) => { p.water = v; p.replay(false); }, '落在水面'),
        h('span', { class: this.previewErr || p.err ? 'warn' : 'dim', style: 'font-size:12px' }, note)));
  },
  request(host, style, seed, doc) {
    const own = (doc.emitters || []).filter((e) => e && ['bolt', 'bolt_stroke', 'ground_arcs', 'water_arcs'].includes(e.id));
    const key = canonJson({ params: style.params, seed, own });
    if (key === this.wantKey) return;
    this.wantKey = key;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = 0; void this.fetchPreview(host, style, seed, doc, key); }, 200);
  },
  async fetchPreview(host, style, seed, doc, key) {
    try {
      const r = await API.post('/api/lightning/compose', {
        style: { id: style.id, label: style.label, kind: style.kind, params: style.params }, seed,
        doc: { id: doc.id, emitters: clone(doc.emitters || []) },
      });
      if (key !== this.wantKey) return;
      this.previewErr = '';
      this.player.setComposed(r, seed);
    } catch (e) {
      if (key === this.wantKey) { this.previewErr = String(e && e.message || e); host.renderInspector(); }
    }
  },
};

/** 勾选框（不经 host.edit：播放器的开关是 UI 态，不进历史） */
function ins_chk(value, set, label) {
  const inp = h('input', { type: 'checkbox' });
  inp.checked = !!value;
  inp.addEventListener('change', () => set(inp.checked));
  return h('label', { class: 'chk' }, inp, label);
}

/** 随寿命曲线采样（与运行时 `sampleCurve` 同口径：线性插值、两端取端点、空 = 恒 1） */
function lpSample(curve, t) {
  if (!curve || !curve.length) return 1;
  if (t <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (t <= curve[i][0]) {
      const a = curve[i - 1], b = curve[i];
      const u = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
      return a[1] + (b[1] - a[1]) * u;
    }
  }
  return curve[curve.length - 1][1];
}
function lpSampleColor(curve, t) {
  if (!curve || !curve.length) return [1, 1, 1];
  const at = (k) => [k[1], k[2], k[3]];
  if (t <= curve[0][0]) return at(curve[0]);
  for (let i = 1; i < curve.length; i++) {
    if (t <= curve[i][0]) {
      const a = curve[i - 1], b = curve[i];
      const u = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
      return [0, 1, 2].map((c) => a[c + 1] + (b[c + 1] - a[c + 1]) * u);
    }
  }
  return at(curve[curve.length - 1]);
}

const BOLT_PREVIEW_VS = `#version 300 es
in vec2 aPos; in vec4 aSeg; in vec2 aK; in vec4 aCol;
uniform vec2 uCanvas;
out vec2 vPos; out vec4 vSeg; out vec2 vK; out vec4 vCol;
void main() {
  vPos = aPos; vSeg = aSeg; vK = aK; vCol = aCol;
  gl_Position = vec4(aPos.x / uCanvas.x * 2.0 - 1.0, 1.0 - aPos.y / uCanvas.y * 2.0, 0.0, 1.0);
}`;
function boltPreviewFs(rt) {
  return `#version 300 es
precision highp float;
in vec2 vPos; in vec4 vSeg; in vec2 vK; in vec4 vCol;
out vec4 o;
${rt.vfxBoltGlsl.BOLT_GLSL_KERNEL}
void main() {
  float k = boltSeg(vPos, vSeg.xy, vSeg.zw, vK.x) * vK.y;
  if (k < 1e-4) discard;
  o = vec4(min(vCol.rgb * k, vec3(1.0)), clamp(vCol.a * k, 0.0, 1.0));
}`;
}

/**
 * 雷的动态预览：两格——远处（一个人几十像素）与近处（一个人一两百像素），像两块缩小了的游戏画面
 * （屏幕下限按「这块画布是一块 768 高的游戏画面」换算）。同一道雷、同一套参数，看粗细怎么随远近变。
 * 画法是 bundle 里的运行时代码（vfxBolt + vfxBoltGlsl）；这里只管摆位置、按寿命曲线调亮度、合成到 2D 画布上。
 */
class BoltPreview {
  constructor() {
    this.canvas = h('canvas', { class: 'lightningCanvas', width: '420', height: '300' });
    this.gl = null; this.glCanvas = document.createElement('canvas');
    this.prog = null; this.err = '';
    this.composed = null; this.seed = 0; this.inst = 1;
    this.geoms = null;
    this.slow = false; this.water = false;
    /** 两格的尺度：每 wu 多少游戏屏幕像素（远：雾津街头那样一个人 ~70 像素；近：一个人 ~300 像素） */
    this.far = 0.45; this.near = 2.0;
    this.t0 = performance.now();
    this.raf = 0;
    this.loop = this.loop.bind(this);
    this.buf = null; this.vao = null; this.data = new Float32Array(6 * 12 * 4096);
  }
  /** 画布相对 768 高游戏画面的缩小比例 */
  canvasScale() { return (this.canvas.height || 300) / 768; }
  setComposed(r, seed) {
    this.composed = r; this.seed = seed;
    this.replay(false);
  }
  replay(newInstance) {
    if (newInstance) this.inst = (Math.random() * 0x7fffffff) | 0;
    this.geoms = null;
    this.t0 = performance.now();
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }
  loop() {
    this.raf = 0;
    if (!this.canvas.isConnected) return;
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  }
  _ensureGl(rt) {
    if (this.prog || this.err) return !!this.prog;
    if (!rt || !rt.vfxBolt || !rt.vfxBoltGlsl) { this.err = '运行时代码包里没有雷的模块（刷新页面重打包）'; return false; }
    const gl = this.gl = this.glCanvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) { this.err = '没有 WebGL2'; return false; }
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader 编译失败');
      return s;
    };
    try {
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, BOLT_PREVIEW_VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, boltPreviewFs(rt)));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'program 链接失败');
      this.prog = p;
    } catch (e) { this.err = String(e && e.message || e); return false; }
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    this.buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const stride = 12 * 4;
    const attr = (name, n, off) => { const loc = gl.getAttribLocation(this.prog, name); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, off * 4); };
    attr('aPos', 2, 0); attr('aSeg', 4, 2); attr('aK', 2, 6); attr('aCol', 4, 8);
    gl.bindVertexArray(null);
    return true;
  }
  _geoms(rt) {
    if (this.geoms) return this.geoms;
    const out = {};
    for (const b of this.composed.bolts || []) out[b.id] = rt.vfxBolt.createBolt(b, this.inst);
    return (this.geoms = out);
  }
  draw() {
    const rt = S.rt;
    const c = this.canvas;
    const W = c.clientWidth || 420;
    if (c.width !== W) c.width = W;
    const H = c.height;
    const g = c.getContext('2d');
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    g.fillStyle = '#0b0d12'; g.fillRect(0, 0, W, H);
    if (!this.composed || !this._ensureGl(rt)) return;
    const life = 0.46, pause = 0.9;
    const t = ((performance.now() - this.t0) / 1000 * (this.slow ? 0.25 : 1)) % (life + pause);
    const k768 = this.canvasScale();
    const split = Math.round(W * 0.42);
    const panels = [{ x: 0, w: split, s: this.far * k768 }, { x: split, w: W - split, s: this.near * k768 }];
    const gl = this.gl, gc = this.glCanvas;
    if (gc.width !== W || gc.height !== H) { gc.width = W; gc.height = H; }
    gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog); gl.bindVertexArray(this.vao);
    gl.uniform2f(gl.getUniformLocation(this.prog, 'uCanvas'), W, H);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.SCISSOR_TEST);
    const geoms = this._geoms(rt);
    for (const P of panels) {
      const groundY = H - 34, cx = P.x + P.w * 0.55;
      g.fillStyle = '#161920'; g.fillRect(P.x, groundY, P.w, H - groundY);
      g.strokeStyle = '#30353f'; g.beginPath(); g.moveTo(P.x, groundY + 0.5); g.lineTo(P.x + P.w, groundY + 0.5); g.stroke();
      const ph = 150 * P.s, pw = ph * 0.26, px = cx - 120 * P.s - pw / 2;
      g.fillStyle = '#3d434e'; g.fillRect(px, groundY - ph, pw, ph);
      g.beginPath(); g.arc(px + pw / 2, groundY - ph - pw * 0.45, pw * 0.45, 0, Math.PI * 2); g.fill();
      gl.scissor(P.x, 0, P.w, H);
      if (t <= life) this._panel(rt, geoms, P, cx, groundY, t, k768, H);
    }
    gl.disable(gl.SCISSOR_TEST);
    g.globalCompositeOperation = 'lighter';
    g.drawImage(gc, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = '#2a2e36'; g.beginPath(); g.moveTo(split + 0.5, 0); g.lineTo(split + 0.5, H); g.stroke();
  }
  _panel(rt, geoms, P, cx, groundY, t, k768, H) {
    const gl = this.gl, s = P.s;
    let n = 0;
    const d = this.data;
    const push = (ax, ay, bx, by, sig, amp, col, a) => {
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-4 || n + 6 > d.length / 12) return;
      const r = sig * 3.5, tx = (bx - ax) / len * r, ty = (by - ay) / len * r, nx = -ty, ny = tx;
      const C = [[ax - tx - nx, ay - ty - ny], [bx + tx - nx, by + ty - ny], [bx + tx + nx, by + ty + ny], [ax - tx + nx, ay - ty + ny]];
      for (const k of [0, 1, 2, 0, 2, 3]) {
        const o = n * 12;
        d[o] = C[k][0]; d[o + 1] = C[k][1]; d[o + 2] = ax; d[o + 3] = ay; d[o + 4] = bx; d[o + 5] = by;
        d[o + 6] = sig; d[o + 7] = amp; d[o + 8] = col[0] * a; d[o + 9] = col[1] * a; d[o + 10] = col[2] * a; d[o + 11] = a;
        n++;
      }
    };
    for (const em of this.composed.emitters || []) {
      const ap = em.appearance || {}, L = ap.bolt;
      if (!L) continue;
      if (em.onSurface && !em.onSurface.includes(this.water ? 'water' : 'ground')) continue;
      const geo = geoms[L.bolt];
      if (!geo) continue;
      const lf = (em.life && em.life.seconds && em.life.seconds[0]) || 0.46;
      if (t > lf) continue;
      const u = t / lf;
      const a = lpSample(ap.alphaOverLife, u);
      if (a <= 0.002) continue;
      const lc = lpSampleColor(ap.tintOverLife, u), tint = ap.tint || [1, 1, 1];
      const tintC = [0, 1, 2].map((i) => tint[i] * lc[i]);
      const view = { footX: 0, footY: 0, persp: 1, pxPerScene: s, k768,
        view: { x0: (P.x - cx) / s, x1: (P.x + P.w - cx) / s, y0: -groundY / s, y1: (H - groundY) / s } };
      if (geo.kind === 'surface') view.groundToScene = (dx, dz, out) => { out.x = dx; out.y = dz * 0.5; };
      else rt.vfxBolt.extendBolt(geo, rt.vfxBoltGlsl.boltNeedHeight(view, 3000));
      const look = { part: L.part === 'main' ? 'main' : 'all', coreWu: L.coreWu, coreMinPx: L.coreMinPx, glowWu: L.glowWu,
        glowMinPx: L.glowMinPx, haloWu: L.haloWu || 0, haloMinPx: L.haloMinPx || 0, coreGain: L.coreGain, glowGain: L.glowGain,
        haloGain: L.haloGain || 0, widthMul: lpSample(ap.sizeOverLife, u) };
      const core = (L.coreColor || [1, 1, 1]).map((v, i) => v * tintC[i]);
      const glow = (L.glowColor || [1, 1, 1]).map((v, i) => v * tintC[i]);
      rt.vfxBoltGlsl.emitBoltSegments(geo, look, view, {
        segment: (ax, ay, bx, by, sig, amp, color) => push(cx + ax * s, groundY + ay * s, cx + bx * s, groundY + by * s, sig * s, amp, color === 0 ? core : glow, a),
      });
    }
    if (!n) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, n * 12), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, n);
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { LightningPanel, BoltPreview };
