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
 * - 预览：草稿参数经服务端拼成「套用之后」的样子（只读），交给 bundle 里游戏同一份的运行时模拟 + `VfxRenderer` 现画
 *   （经工作台 RHI 接入层画在 WebGPU 上，见 `BoltPreview`）——页面里没有着色器。
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
   * 这里交给 bundle 里游戏同一份的运行时模拟（`VfxInstanceSim`）与渲染（`VfxRenderer`：雷形、逐段挑细分级、定粗细、WGSL）现画。
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

/**
 * 雷的动态预览：两格——远处（一个人几十像素）与近处（一个人一两百像素），像两块缩小了的游戏画面
 * （屏幕下限按「这块画布是一块 768 高的游戏画面」换算）。同一道雷、同一套参数，看粗细怎么随远近变。
 * 画面整个是游戏的东西：`S.rt.vfxView.BoltPreviewStage` 把「套用之后」的效果（bolts + 样式那几层）放进游戏同一份运行时模拟，
 * 每格一个游戏的 `VfxRenderer`（雷形、挑细分级、粗细、按寿命曲线的亮度与颜色、WGSL 全是游戏那一份），画布是游戏同一个
 * WebGPU 渲染器（工作台 RHI 接入层）。这里只管时间轴（劈下 → 停一会 → 再劈）、两格的尺度与开关。
 * 拿不到 WebGPU（如 offscreen 的 QtWebEngine）就在说明行里写原因，**不回落**任何别的 API。
 */
class BoltPreview {
  constructor() {
    this.canvas = h('canvas', { class: 'lightningCanvas', width: '420', height: '300' });
    this.host = null; this.stage = null; this.starting = null; this.err = '';
    this.composed = null; this.seed = 0; this.inst = 1;
    this.slow = false; this.water = false;
    /** 两格的尺度：每 wu 多少游戏屏幕像素（远：雾津街头那样一个人 ~70 像素；近：一个人 ~300 像素） */
    this.far = 0.45; this.near = 2.0;
    this.t0 = performance.now();
    this.raf = 0;
    this.loop = this.loop.bind(this);
    /** 效果换了 / 要从劈下那一刻重来（下一次 draw 落实） */
    this.effectDirty = false; this.restartPending = true; this.lastT = -1;
  }
  /** 画布相对 768 高游戏画面的缩小比例 */
  canvasScale() { return (this.canvas.clientHeight || this.canvas.height || 300) / 768; }
  /** GPU 画面建起来（只建一次；失败原因进 `err`） */
  ready() {
    if (this.starting) return this.starting;
    const rt = S.rt;
    this.starting = (async () => {
      if (!rt || !rt.workbenchRhi || !rt.vfxView) { this.err = '运行时代码包里没有雷的画面模块（刷新页面重打包）'; return false; }
      try {
        this.host = await rt.workbenchRhi.createCanvasHost(this.canvas, { background: 0x0b0d12 });
        this.stage = new rt.vfxView.BoltPreviewStage();
        this.effectDirty = true; this.restartPending = true;
        return true;
      } catch (e) {
        this.err = String((e && e.message) || e);
        return false;
      }
    })();
    return this.starting;
  }
  setComposed(r, seed) {
    this.composed = r; this.seed = seed;
    this.effectDirty = true;
    this.replay(false);
  }
  replay(newInstance) {
    if (newInstance) this.inst = (Math.random() * 0x7fffffff) | 0;
    this.restartPending = true;
    this.t0 = performance.now();
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }
  loop() {
    this.raf = 0;
    if (!this.canvas.isConnected) return;
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  }
  draw() {
    if (!this.composed) return;
    if (!this.host) { if (!this.starting) void this.ready().then(() => this.draw()); return; }
    const c = this.canvas;
    const W = c.clientWidth || 420, H = c.clientHeight || 300;
    this.host.resize(W, H, window.devicePixelRatio || 1);
    const st = this.stage;
    if (this.effectDirty) {
      this.effectDirty = false;
      const comp = this.composed;
      try { st.setEffect({ id: 'bolt_preview', bolts: comp.bolts || [], emitters: comp.emitters || [] }); this.err = ''; }
      catch (e) { this.err = String((e && e.message) || e); st.setEffect(null); }
      this.restartPending = true;
    }
    const life = 0.46, pause = 0.9;
    const t = ((performance.now() - this.t0) / 1000 * (this.slow ? 0.25 : 1)) % (life + pause);
    if (this.restartPending || t < this.lastT) {
      this.restartPending = false;
      try { st.restart(this.inst, this.water ? 'water' : 'ground'); } catch (e) { this.err = String((e && e.message) || e); }
    }
    this.lastT = t;
    st.advanceTo(t);
    const k768 = this.canvasScale();
    const split = Math.round(W * 0.42);
    st.layout(W, H, [{ x: 0, w: split, scale: this.far * k768 }, { x: split, w: W - split, scale: this.near * k768 }]);
    st.sync();
    this.host.render(st.root);
    if (this.host.lastError && !this.err) this.err = `GPU：${this.host.lastError}`;
  }
  /** 回读画布（同一个任务里重画再读；自检用）；没有 GPU = null */
  readPixels() { return this.host ? this.host.readPixels() : null; }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { LightningPanel, BoltPreview };
