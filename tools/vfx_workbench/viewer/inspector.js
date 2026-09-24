'use strict';
/* 粒子工作台 · 右栏检视器：按模块折叠，字段逐条按 `src/data/types.ts` 的 VFX 一节建。
 *
 * 三条纪律（editor-tools norms）：
 * - **渲染只读**：`render()` 绝不写 doc（拖拽中只重画数字，不重建控件）；缺省容器只在写入闭包里补
 *   （`ensure()`），否则"看一眼参数"就把一堆空模块塞进资产、往返不再等价。
 * - **枚举一律下拉，不用裸输入框**：碰撞响应 / 混合 / 形状 / 初始群态 / 音效 id 都是选择器。
 * - **重块默认折叠**（群体行为二十来个字段），折叠状态只是 UI 态，不进历史、不标脏。
 *
 * 数值框带单位提示（wu / wu/s / wu/s²/ 秒 / 度），改完 `change` 才提交一条历史；空值 = 删掉那个键
 * （回到 types.ts 的缺省），不落 0 —— 0 与"没写"在运行时不是一回事（`gravity` 0 = 不受重力，
 * 没写也是；但 `restitution` 0 = 不反弹，没写 = 运行时缺省）。 */

/** 颜色关键点的新值取三位小数（插值出来的 0.54999… 不往资产里写一长串） */
const round3 = (v) => Math.round(v * 1000) / 1000;

const INS_OPEN = { effect: true, lightning: true, lightningOff: false, placement: true, surfaces: false, appearance: true, spawn: true, motion: true, life: true, collision: false, behavior: false, sound: false };
/** 雷电样式生成器拥有的那几层（与 `tools/vfx_workbench/lightning.py` 的 OWNED 同一份）：贴图 / 宽度由样式定，检视器里锁住 */
/** 雷电样式那几层（与 tools/vfx_workbench/lightning.py 的 OWNED 同一份名单） */
const LIGHTNING_OWNED = ['bolt', 'bolt_stroke', 'ground_arcs', 'water_arcs'];

const Inspector = {
  /** 折叠状态（UI 态，不进历史） */
  open: Object.assign({}, INS_OPEN),

  section(key, title, body, extra) {
    const on = this.open[key] !== false;
    const head = h('div', { class: 'secHead', onclick: () => { this.open[key] = !on; this.rerender(); } },
      h('span', { class: 'caret' }, on ? '▾' : '▸'), h('b', {}, title), extra || null);
    const wrap = h('div', { class: 'sec', 'data-sec': key }, head);
    if (on) for (const el2 of body()) if (el2) wrap.appendChild(el2);
    return wrap;
  },

  rerender() { if (this._host) this._host.renderInspector(); },

  /**
   * 给检视器里每个可聚焦控件盖一个**稳定的身份键** `data-key` = `模块/行名/行内序号`（重名再加 `#n`）。
   * 重建后按它把焦点放回**同一个参数**（app.js `rebuildInspector`）——原来按"第几个控件"放：
   * 在「湍流强度」里打了数没回车、直接点「速度上限」，提交让上面多出「湍流尺度 / 湍流速率」两行，
   * 同一个序号落到了「湍流尺度」上，接着打的 300 写进了 turbulence.scale、状态栏还说"改湍流尺度"。
   * 新检视器里找不到这个键（那一行没了、按钮换了字）= 不放焦点，绝不猜到别的参数上。
   */
  stampKeys(container) {
    const seen = new Map();
    for (const n of container.querySelectorAll('input, select, textarea, button')) {
      const sec = n.closest('.sec');
      const secKey = (sec && sec.dataset.sec) || 'emitter';
      const row = n.closest('.row, .btns');
      let label = '';
      if (row && row.classList.contains('row')) {
        const first = row.firstElementChild;
        if (first && first.tagName === 'SPAN' && !first.contains(n)) label = first.textContent;
        if (!label) { const lab = n.closest('label'); label = lab ? lab.textContent : ''; }   // 勾选框那几行行名是空的，用勾选框自己的字
      }
      if (n.tagName === 'BUTTON') label += `|${n.getAttribute('data-role') || n.textContent}`;
      const peers = row ? [...row.querySelectorAll(n.tagName)] : [n];
      let key = `${secKey}/${label}/${n.tagName}${peers.indexOf(n)}`;
      const k = seen.get(key) || 0;
      seen.set(key, k + 1);
      if (k) key += `#${k}`;
      n.dataset.key = key;
    }
  },

  /**
   * 滚轮落在**有焦点**的数值框上：先让它失焦。Chromium 对有焦点、被悬停的 `<input type=number>` 把滚轮当成步进
   * （±1 一格）并吞掉事件——作者 Tab 过来之后想滚右栏找下一个参数，右栏不动、数值一格一格变，
   * 下一次点别处 / Ctrl+S 把被滚过的值当成正常改动提交了。失焦发生在浏览器默认处理之前：打了的值照常经 `change` 提交，滚轮去滚面板。
   */
  blurOnWheel(inp) {
    inp.addEventListener('wheel', () => { if (document.activeElement === inp) inp.blur(); }, { passive: true });
    return inp;
  },

  // ---------------------------------------------------------------- 控件
  row(label, ...kids) {
    return h('div', { class: 'row' }, h('span', {}, label), ...kids.filter(Boolean));
  },
  num(get, set, unit, opts) {
    const o = opts || {};
    const inp = h('input', { type: 'number', step: o.step == null ? 'any' : String(o.step), title: o.title || '', placeholder: o.placeholder || null });
    if (o.disabled) inp.disabled = true;
    const v = get();
    inp.value = v == null ? '' : String(v);
    inp.dataset.v0 = inp.value;                        // 建出来时的值：没动过的框里 Ctrl+Z 归页面撤销栈（app.js onKey）
    this.blurOnWheel(inp);
    inp.addEventListener('change', () => {
      const raw = inp.value.trim();
      if (raw === '') { set(null); return; }
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) { inp.value = get() == null ? '' : String(get()); return; }
      set(o.int ? Math.round(n) : n);
    });
    return h('span', { class: 'numwrap' }, inp, unit ? h('span', { class: 'unit' }, unit) : null);
  },
  sel(get, set, options, allowEmpty) {
    const s = h('select', {});
    if (allowEmpty) s.appendChild(h('option', { value: '' }, '（不写）'));
    for (const o of options) {
      const val = typeof o === 'string' ? o : o.value;
      const lab = typeof o === 'string' ? o : (o.label || o.value);
      s.appendChild(h('option', { value: val }, lab));
    }
    const cur = get();
    s.value = cur == null ? '' : String(cur);
    // 悬垂值保值展示（选择器铁律：不许静默顶替）
    if (cur != null && String(cur) !== '' && s.value !== String(cur)) {
      s.appendChild(h('option', { value: String(cur) }, `${cur}（当前值，候选里没有）`));
      s.value = String(cur);
    }
    s.addEventListener('change', () => set(s.value === '' ? null : s.value));
    return s;
  },
  chk(get, set, label, opts) {
    const o = opts || {};
    const inp = h('input', { type: 'checkbox' });
    inp.checked = !!get();
    if (o.disabled) inp.disabled = true;
    if (o.role) inp.setAttribute('data-role', o.role);
    inp.addEventListener('change', () => set(inp.checked));
    return h('label', { class: 'chk', title: o.title || null }, inp, label || '');
  },
  txt(get, set, ph) {
    const inp = h('input', { type: 'text', placeholder: ph || '' });
    inp.value = get() == null ? '' : String(get());
    inp.dataset.v0 = inp.value;
    inp.addEventListener('change', () => set(inp.value.trim() || null));
    return inp;
  },
  vec3(get, set, unit) {
    const cur = get() || [0, 0, 0];
    const mk = (i) => {
      const inp = h('input', { type: 'number', step: 'any', class: 'v3' });
      inp.value = String(cur[i]);
      inp.dataset.v0 = inp.value;
      this.blurOnWheel(inp);
      inp.addEventListener('change', () => {
        const a = (get() || [0, 0, 0]).slice();
        const n = parseFloat(inp.value);
        a[i] = Number.isFinite(n) ? n : 0;
        set(a);
      });
      return inp;
    };
    return h('span', { class: 'numwrap' }, mk(0), mk(1), mk(2), unit ? h('span', { class: 'unit' }, unit) : null);
  },
  pair(get, set, unit) {
    const cur = get() || [0, 0];
    const mk = (i) => {
      const inp = h('input', { type: 'number', step: 'any', class: 'v2' });
      inp.value = String(cur[i]);
      inp.dataset.v0 = inp.value;
      this.blurOnWheel(inp);
      inp.addEventListener('change', () => {
        const a = (get() || [0, 0]).slice();
        const n = parseFloat(inp.value);
        a[i] = Number.isFinite(n) ? n : 0;
        set(a);
      });
      return inp;
    };
    return h('span', { class: 'numwrap' }, mk(0), h('span', { class: 'unit' }, '…'), mk(1), unit ? h('span', { class: 'unit' }, unit) : null);
  },
  /**
   * 随寿命的小折线编辑器：点空白加键、拖键、右键删键（首尾 t 钳 0 / 1）。
   * 纵轴刻度 = `max(2, 最大值 × 1.5)`（留出往上拖的余量；`opts.cap` 给了就钉死，透明度上限 1），
   * **拖拽期间刻度冻住**、拖的那个键**按对象引用追**：原来每次 mousemove 都按"刚写回的曲线"重算刻度，
   * 拖的正是最大那个键时值每动一下再乘一次（2.1 往下拖到 1.6，落手只剩 0.7，点还一直跟着光标）；
   * 往上钳在当前最大值，永远拖不过 1×；按下标追的话横着拖过邻居，下一拍写进的是邻居那一格。
   */
  curve(label, get, set, opts) {
    const o = opts || {};
    const W = 168, H = 54, PAD = 6;
    const cv = h('canvas', { class: 'curve', width: String(W), height: String(H), title: '左键拖关键点 / 点空白加一个 / 右键删一个（横=寿命 0→1，纵=倍率）' });
    const host = this._host;
    const pts = () => (get() || []).map((p) => p.slice()).sort((a, b) => a[0] - b[0]);
    const scaleOf = (ps) => (o.cap ? o.cap : Math.max(2, ...ps.map((p) => p[1] * 1.5)));
    let drag = null;                                   // { scale, pts, key }：拖拽期间的冻结刻度 / 本地点表 / 拖的那个键（引用）
    const scale = () => (drag ? drag.scale : scaleOf(pts()));
    const toPx = (p) => [PAD + p[0] * (W - PAD * 2), H - PAD - (p[1] / scale()) * (H - PAD * 2)];
    const toVal = (mx, my) => [clamp((mx - PAD) / (W - PAD * 2), 0, 1), clamp((H - PAD - my) / (H - PAD * 2) * scale(), 0, scale())];
    cv.dataset.curve = label;
    // 自检用：此刻的像素换算（与画的是同一套）
    cv._curve = { toPx, toVal, scale, W, H, PAD };
    const draw = () => {
      const g = cv.getContext('2d');
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#12151b'; g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.strokeRect(0.5, 0.5, W - 1, H - 1);
      const ps = drag ? drag.pts : pts();
      if (!ps.length) {
        // 没写 = 运行时恒 1（`sampleCurve` 空曲线回 1）：画一条虚线把这个缺省摆出来——原来整块空白，作者看不出"不写"是什么
        const y = toPx([0, 1])[1];
        g.strokeStyle = 'rgba(108,180,255,.55)'; g.lineWidth = 1; g.setLineDash([4, 3]);
        g.beginPath(); g.moveTo(PAD, y); g.lineTo(W - PAD, y); g.stroke(); g.setLineDash([]);
        return;
      }
      g.strokeStyle = '#6cb4ff'; g.lineWidth = 1.5; g.beginPath();
      ps.forEach((p, i) => { const c = toPx(p); if (i) g.lineTo(c[0], c[1]); else g.moveTo(c[0], c[1]); });
      g.stroke();
      g.fillStyle = '#ffe44d';
      for (const p of ps) { const c = toPx(p); g.beginPath(); g.arc(c[0], c[1], 3, 0, Math.PI * 2); g.fill(); }
    };
    const at = (mx, my) => { const ps = pts(); for (let i = 0; i < ps.length; i++) { const c = toPx(ps[i]); if (Math.hypot(c[0] - mx, c[1] - my) <= 6) return i; } return -1; };
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('mousedown', (e) => {
      const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const i = at(mx, my);
      if (e.button === 2) {
        // 右键删最后一个键 = 删掉这条曲线（回到运行时缺省恒 1）。原来剩一个键就拒删、也没有别的按钮能清，
        // 点错一下只能 Ctrl+Z——连带把之后改的参数一起撤掉
        if (i >= 0) { const ps = pts(); ps.splice(i, 1); host.edit(`改${label}`, () => set(ps.length ? ps : null)); draw(); }
        return;
      }
      if (e.button !== 0) return;
      if (i < 0) {
        const v = toVal(mx, my);
        let ps = pts();
        if (!ps.length) {
          // 空曲线 = 运行时恒 1：先铺上缺省的两个端点再加这一个。原来直接存成单键曲线，`sampleCurve` 对单键整段取它的值——
          // 点一下右下角想做淡出，整个寿命透明度都成了 0，游戏里粒子全没了（工作台 3D 按点画、看不出来）
          ps = [[0, 1], [1, 1]];
          // 点在端点那一竖上（与拾取同一个 6 px）：改那个端点的值，不在同一个 t 上叠第二个键（运行时取先排的那个，等于没点）
          const end = ps.find((p) => Math.abs(toPx(p)[0] - mx) <= 6);
          if (end) end[1] = v[1]; else ps.push(v);
        } else ps.push(v);
        ps.sort((a, b) => a[0] - b[0]);
        host.edit(`改${label}`, () => set(ps));
        draw();
        return;
      }
      const ps0 = pts();
      drag = { scale: scaleOf(ps0), pts: ps0, key: ps0[i] };
      host.dragBegin(`改${label}`);
      const onMove = (ev) => {
        if (!drag) return;
        const rr = cv.getBoundingClientRect();
        const v = toVal(ev.clientX - rr.left, ev.clientY - rr.top);
        drag.key[0] = v[0]; drag.key[1] = v[1];        // 改的是那个键对象本身：排序换了位置也还是它
        drag.pts.sort((a, b) => a[0] - b[0]);
        const out = drag.pts.map((p) => p.slice());
        host.dragTick(() => set(out));
        draw();
      };
      const onUp = () => {
        drag = null;                                   // 松手才按数据重算刻度（值拖大了，余量跟着长）
        window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
        host.dragEnd();
        draw();
      };
      window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    });
    draw();
    return h('div', { class: 'row curverow' }, h('span', {}, label), cv);
  },

  /**
   * 「颜色×寿命」：`appearance.tintOverLife` = `[t, r, g, b][]`，**乘在乘色 tint 上**（最终色 = tint × 它(t)）。
   * 采样与运行时 `sampleColorCurve` 同口径：按 t 线性插值、超出两端取端点、空 / 不写 = 恒白。
   *
   * 关键点列表（每行一个键：寿命 t + r/g/b + 色块 + 删），上面一条渐变条画的是最终色 tint × 曲线。
   * - 「+ 关键点」：空时先铺上缺省的两端白（与曲线编辑器同一个理由：单键 = 整段一个色，点一下就把整条寿命染死）；
   *   非空时插在最宽的那段 t 空档正中、颜色取那一点的插值（加一个键画面不变，再去改它）；
   * - 改 t 后按 t 重排（形状闸门要求非降序），数值一律夹到 0..1（与闸门 / 校验器同口径）；
   * - 删到最后一个 = **删键**（回到恒白），不落 `[]`；每次改动一条历史（`E` = host.edit）。
   */
  tintOverLifeRows(ap, E) {
    const keys = () => (Array.isArray(ap.tintOverLife) ? ap.tintOverLife : []);
    const write = (label, fn) => E(label, () => {
      const ks = keys().map((k) => k.slice());
      fn(ks);
      ks.sort((a, b) => a[0] - b[0]);                  // 稳定排序：同一个 t 的两个键保持原先后（硬切）
      if (ks.length) ap.tintOverLife = ks; else delete ap.tintOverLife;
    });
    const sample = (ks, t) => {
      if (!ks.length) return [1, 1, 1];
      if (t <= ks[0][0]) return ks[0].slice(1, 4);
      for (let i = 1; i < ks.length; i++) {
        if (t <= ks[i][0]) {
          const a = ks[i - 1], b = ks[i];
          const k = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 1;
          return [1, 2, 3].map((j) => a[j] + (b[j] - a[j]) * k);
        }
      }
      return ks[ks.length - 1].slice(1, 4);
    };
    const css = (c) => `rgb(${c.map((x) => Math.round(clamp(x, 0, 1) * 255)).join(',')})`;
    const tint = Array.isArray(ap.tint) && ap.tint.length === 3 ? ap.tint : [1, 1, 1];
    const W = 168, H = 14;
    const bar = h('canvas', { class: 'gradient', width: String(W), height: String(H), 'data-role': 'tol-bar',
      title: '最终颜色 = 乘色 × 颜色×寿命（横 = 寿命 0→1）。没写 = 恒白（只剩乘色）' });
    const g = bar.getContext('2d');
    const ks0 = keys();
    for (let x = 0; x < W; x++) {
      const c = sample(ks0, x / (W - 1));
      g.fillStyle = css([c[0] * tint[0], c[1] * tint[1], c[2] * tint[2]]);
      g.fillRect(x, 0, 1, H);
    }
    for (const k of ks0) { g.fillStyle = '#ffe44d'; g.fillRect(Math.round(clamp(k[0], 0, 1) * (W - 1)) - 1, H - 4, 3, 4); }
    bar._sample = (t) => sample(keys(), t);            // 自检用：与画的是同一个采样
    const add = () => write('加颜色关键点', (ks) => {
      if (!ks.length) { ks.push([0, 1, 1, 1], [1, 1, 1, 1]); return; }
      const edges = [0, ...ks.map((k) => clamp(k[0], 0, 1)), 1];
      let best = 0;
      for (let i = 1; i < edges.length; i++) if (edges[i] - edges[i - 1] > edges[best + 1] - edges[best]) best = i - 1;
      const t = round3((edges[best] + edges[best + 1]) / 2);
      ks.push([t, ...sample(ks, t).map(round3)]);
    });
    const rows = [
      h('div', { class: 'row gradrow' }, h('span', {}, '颜色×寿命'), bar,
        h('button', { 'data-role': 'tol-add', title: '加一个颜色关键点（空的时候先铺上两端白）', onclick: add }, '+ 关键点')),
    ];
    ks0.forEach((k, i) => {
      rows.push(h('div', { class: 'row' },
        h('span', { class: 'dim' }, `  键 ${i + 1}`),
        this.num(() => k[0], (v) => write('改颜色关键点寿命', (ks) => { ks[i][0] = v == null ? 0 : clamp(v, 0, 1); }), 't',
          { step: 0.05, title: '寿命归一化进度 0..1；改完按 t 重排' }),
        this.vec3(() => k.slice(1, 4), (v) => write('改颜色关键点', (ks) => { ks[i] = [ks[i][0], ...v.map((x) => clamp(x, 0, 1))]; }), 'rgb'),
        h('span', { class: 'swatch', 'data-role': `tol-swatch:${i}`, title: '这一键的颜色（未乘 tint）', style: `background:${css(k.slice(1, 4))}` }),
        h('button', { class: 'danger', 'data-role': `tol-del:${i}`, title: '删这个关键点（删到最后一个 = 删掉整条，回到恒白）',
          onclick: () => write('删颜色关键点', (ks) => { ks.splice(i, 1); }) }, '×')));
    });
    return rows;
  },

  /** 非群体发射器的「怕 / 被吸引」表（motion.stimulus）。群体走 behavior.attitude，不在这里出现。 */
  stimulusRows(em, mo, E) {
    if (this._host.programApi?.resolveEmitterProgram(em).solver === 'flock') {
      return [h('div', { class: 'pad dim' }, '这个发射器是群体：刺激反应在「群体行为」里的刺激权重表，不用 motion.stimulus')];
    }
    const st = mo.stimulus;
    if (!st) {
      return [h('div', { class: 'btns' }, h('button', {
        'data-role': 'stim-on',
        title: '让这个发射器认 fear / attract 场（不加就只认 wind）。萤火虫"人走近就散开"靠的是它',
        onclick: () => E('加刺激反应', () => { mo.stimulus = { fear: { 'player:motion': 1 }, accel: 700 }; }),
      }, '+ 加刺激反应（怕人 / 被引）'))];
    }
    const rows = [];
    // 删掉一张表的最后一个标签 = 连这张表一起删（空表过不了闸门：`{}` 不许存、也推不到游戏）；两张都没了 = 删刺激反应。
    // 原来留下 `fear: {}`：只想要"被吸引"（先加引、再删默认的怕）根本存不了，这期间的布置改动也一起推不出去
    const prune = (key) => {
      if (st[key] && typeof st[key] === 'object' && !Object.keys(st[key]).length) delete st[key];
      if (!st.fear && !st.attract && mo.stimulus === st) delete mo.stimulus;
    };
    const tbl = (t, label2, key) => {
      for (const k of Object.keys(t || {})) {
        rows.push(h('div', { class: 'row' },
          h('span', { class: 'tag' }, `${label2}·${k}`),
          this.num(() => t[k], (v) => E('改刺激权重', () => { if (v == null) { delete t[k]; prune(key); } else t[k] = v; }), '', { step: 0.05 }),
          h('button', { class: 'danger', 'data-role': `stim-del:${key}:${k}`, onclick: () => E('删刺激权重', () => { delete t[k]; prune(key); }) }, '×')));
      }
    };
    tbl(st.fear, '怕', 'fear');
    tbl(st.attract, '引', 'attract');
    const addTag = h('input', { type: 'text', 'data-role': 'stim-tag', placeholder: 'player:motion / sfx:footstep / item:bug / 自定标签' });
    return [
      h('h4', {}, '刺激反应（非群体）'),
      this.row('加速度', this.num(() => st.accel, (v) => E('改刺激加速度', () => { st.accel = v == null ? 0 : Math.max(0, v); }), 'wu/s²',
        { title: '权重 1、场强 1、粒子正在场心时的加速度。实际 = 权重 × 场强 × (1−r/R)² × 它' })),
      ...rows,
      h('div', { class: 'row' }, addTag,
        h('button', { 'data-role': 'stim-add:fear', onclick: () => { const t2 = addTag.value.trim(); if (t2) E('加恐惧标签', () => { st.fear = st.fear || {}; st.fear[t2] = 0.5; }); } }, '+ 怕'),
        h('button', { 'data-role': 'stim-add:attract', onclick: () => { const t2 = addTag.value.trim(); if (t2) E('加吸引标签', () => { st.attract = st.attract || {}; st.attract[t2] = 0.5; }); } }, '+ 引')),
      h('div', { class: 'btns' }, h('button', { class: 'danger', onclick: () => E('删刺激反应', () => { delete mo.stimulus; }) }, '删刺激反应')),
    ];
  },

  /**
   * 「跟着发射点走」= `motion.followAnchor`（types.ts `VfxFollowAnchor`）：锚点动了，**已经发出去的**粒子怎么走。
   * - 不写 = `none`：选「不跟」是**删键**（不落 `"none"`；删完运动模块空了连 `motion` 一起删——空模块与没有在运行时一样）；
   *   显式写着的 `"none"` 显示成「不跟」、原样不动（形状闸门也不改它）；
   * - 选别的 = 一次编辑写 `motion.followAnchor`（运动模块不在时在写入闭包里补，渲染只读）；
   * - 群体 / 薄片运行时不吃（`moveAnchor` 对它们整个跳过）：没写时不出下拉、只留一行灰字（悬停说为什么）；
   *   **写了**（比如从普通粒子切成群体）照样出下拉并黄字提醒，好让作者选「不跟」删掉——措辞与形状闸门 / 校验器同一句。
   * 本地预览：挂点模式页面调运行时 `moveAnchor(a)` 不传 carry，所以「完全跟」看得出来、「跟动作、不跟走」在工作台里等于不跟。
   */
  followAnchorRows(em, E) {
    const mo = em.motion && typeof em.motion === 'object' ? em.motion : null;
    const cur = mo ? mo.followAnchor : undefined;
    const api = this._host.programApi;
    const solver = api ? api.resolveEmitterProgram(em).solver : (em.behavior ? 'flock' : em.plate ? 'plate' : 'particle');
    const kind = solver === 'flock' ? '群体' : solver === 'plate' ? '薄片' : '';
    const why = kind ? `群体 / 薄片不吃 followAnchor，写了没用（这是${kind}发射器：运行时挪锚点时整个跳过它，在飞的粒子不跟锚点）` : '';
    if (kind && cur == null) {
      return [h('div', { class: 'row', 'data-role': 'followAnchor-na', title: why },
        h('span', {}, '跟着发射点走'), h('span', { class: 'dim' }, `${kind}不吃（悬停看为什么）`))];
    }
    const title = [
      '锚点动了（挂件粒子挂载 / playPropVfx 的效果每帧跟着挂点挪），已经发出去的粒子怎么走。',
      '· 不跟（缺省，不写）：发出去就归空气，留在原地——烟、火星',
      '· 跟动作、不跟走：只跟宿主转身 / 换姿势 / 动画换帧带出来的那份位移，人在世界里走路那份不跟（火舌拖在身后）。'
        + '只有效果挂在手持挂件上（挂件粒子挂载 / playPropVfx）时才和「不跟」不一样；布置、playVfx、工作台本地预览里等于不跟',
      '· 完全跟：整个跟着锚点走，粘在发射点上——火头余烬的红光、炭火',
    ].join('\n');
    const s = this.sel(() => (cur === 'none' ? '' : cur), (v) => E('改跟着发射点走', () => {
      if (v == null) {
        const m = em.motion;
        if (!m || typeof m !== 'object') return;
        delete m.followAnchor;
        if (!Object.keys(m).length) delete em.motion;
        return;
      }
      if (!em.motion || typeof em.motion !== 'object') em.motion = {};
      em.motion.followAnchor = v;
    }), [
      { value: '', label: '不跟（缺省）：发出去就归空气——烟、火星' },
      { value: 'rig', label: '跟动作、不跟走（手持挂件）：转身 / 换姿势 / 动画换帧带着走，人走路留拖尾——火舌' },
      { value: 'full', label: '完全跟：粘在发射点上——火头余烬的红光、炭火' },
    ], false);
    s.setAttribute('data-role', 'followAnchor');
    s.title = kind ? why : title;
    const row = this.row('跟着发射点走', s);
    row.title = s.title;
    return [row, kind ? h('div', { class: 'pad warn', 'data-role': 'followAnchor-warn' }, `${why}——选「不跟」删掉`) : null];
  },

  /**
   * 「最远烧到多远」= `life.maxDistance`（types.ts `VfxLifeDef`，wu，离发射器原点）：运行时 `stepGeneric` 每步把粒子的
   * age 抬到 `离原点距离 / (maxDistance × 实例距离倍率) × 寿命`，离火源越远越早走完寿命曲线、到这个距离烧完。
   * - 空 = **删键**（不限距离；运行时 ≤ 0 也当不限，所以填 0 / 负数同样删键，不落 0）；填正数 = 一次编辑写进去；
   * - 群体 / 薄片不走普通粒子那一步、没有 `life.seconds` 的粒子永生：运行时都不读它——没写时不出输入框、只留一行灰字
   *   （悬停说为什么）；**写了**照样出输入框并黄字提醒（好清空删掉）——措辞与形状闸门 / 校验器（`shared/vfx_life.py`）同一句。
   */
  maxDistanceRows(em, li, E) {
    const cur = li.maxDistance;
    const api = this._host.programApi;
    const solver = api ? api.resolveEmitterProgram(em).solver : (em.behavior ? 'flock' : em.plate ? 'plate' : 'particle');
    const kind = solver === 'flock' ? '群体' : solver === 'plate' ? '薄片' : '';
    const reason = kind ? `这是${kind}发射器，运行时不走普通粒子那一步`
      : li.seconds == null ? '这个发射器没有 life.seconds（永生），运行时只对有寿命的粒子按距离烧完' : '';
    const why = reason ? `没有寿命 / 群体 / 薄片不吃 maxDistance，写了没用（${reason}，life.maxDistance 被忽略）` : '';
    if (why && cur == null) {
      return [h('div', { class: 'row', 'data-role': 'maxDistance-na', title: why },
        h('span', {}, '最远烧到多远'), h('span', { class: 'dim' }, `${kind || '没有寿命'}不吃（悬停看为什么）`))];
    }
    const title = '离发射器原点超过这个距离就烧完（按距离提前走完寿命曲线）。火苗核心 / 光晕这类燃气用：风大、人跑时火舌不会被拖得比人还长。火星、烟不要写。手持挂件上还会按燃烧强度和风自动缩短。';
    const wrap = this.num(() => cur, (v) => E('改最远烧到多远', () => {
      if (v != null && v > 0) li.maxDistance = v; else delete li.maxDistance;
    }), 'wu', { placeholder: '不限', title: why || title });
    wrap.querySelector('input').setAttribute('data-role', 'maxDistance');
    const row = this.row('最远烧到多远', wrap);
    row.title = why || title;
    return [row, why ? h('div', { class: 'pad warn', 'data-role': 'maxDistance-warn' }, `${why}——清空删掉`) : null];
  },

  /**
   * 发射「方向 / 锥角」。`spawn.direction` 没写 = 运行时**各向同性随机**（vfxSim spawnOne 走 unitVector），
   * 由别的发射器 onHit 触发时没写 = **沿命中法线**（flushHits）；锥角只在有基准方向时才读。
   * 原来没写时显示成 0 / 1 / 0（读着像"朝上"，预览却四散）、锥角填了没反应，改一个分量就把显示的缺省整条写进去
   * （萤火虫成了一束直线），也没有回到"不写"的路，只能 Ctrl+Z 连带撤掉之后改的东西。
   */
  directionRows(doc, em, sp, E) {
    const hasDir = Array.isArray(sp.direction);
    const hitTarget = (doc.emitters || []).some((x) => x !== em && x.collision && x.collision.onHit && x.collision.onHit.emitter === em.id);
    const unsetLabel = em.subOnly ? '沿命中法线（不写）' : hitTarget ? '各向同性；被撞击触发时沿命中法线（不写）' : '各向同性（不写）';
    const spreadUsed = hasDir || !!em.subOnly || hitTarget;
    const mode = this.sel(() => (hasDir ? 'set' : null), (v) => {
      if (v === 'set') E('指定初速方向', () => { sp.direction = [0, 1, 0]; });
      else E(`初速方向改回${unsetLabel.replace('（不写）', '')}`, () => { delete sp.direction; });
    }, [{ value: '', label: unsetLabel }, { value: 'set', label: '指定方向' }], false);
    mode.setAttribute('data-role', 'spawnDirMode');
    mode.title = em.subOnly ? '不写 = 被撞击触发时沿命中面的法线发射（锥角围绕法线）；指定 = 一律朝这个方向'
      : '不写 = 每个粒子随机朝任意方向（各向同性）；指定 = 围绕这个方向、按锥角散开';
    const spreadTitle = !spreadUsed ? '未指定方向时锥角无意义（各向同性随机发射，运行时不读它）；先把「方向」切到「指定方向」'
      : hasDir ? '围绕 direction 的圆锥半角' : '围绕命中法线的圆锥半角';
    const spreadRow = this.row('锥角', this.num(() => sp.spread, (v) => E('改锥角', () => { if (v == null) delete sp.spread; else sp.spread = v; }), '度',
      { title: spreadTitle, disabled: !spreadUsed }));
    if (!spreadUsed) spreadRow.title = spreadTitle;     // 禁用的框不吃鼠标：整行挂同一句提示，悬停在行上就看得到为什么灰着
    return [
      this.row('方向', mode),
      hasDir ? this.row('方向向量', this.vec3(() => sp.direction, (v) => E('改初速方向', () => { sp.direction = v; }), 'M-world')) : null,
      spreadRow,
    ];
  },

  /**
   * 发射形状下拉。「外部给点（燃烧系统）」= `{kind: 'external'}`（types.ts `VfxSpawnShapeDef`）：出生点由燃烧系统每帧交进来，
   * 选它**不写 jitter**（缺省 1）；当前出生位置是「发射区域的可见表面」时一并切回「发射形状」（表面铺撒会把外部点挪走、
   * 没点时一颗都不发——与形状闸门那条提醒同一件事），与选 area 时切到表面对称。
   */
  shapeSelect(em, sp, shape, E) {
    const host = this._host;
    const beams = (host.doc && host.doc.beams) || [];
    const s = this.sel(() => shape && shape.kind, (v) => E('改发射形状', () => {
      if (!v) { delete sp.shape; return; }
      const d = { point: {}, sphere: { radius: 20 }, disc: { radius: 20 }, box: { size: [100, 50, 100] }, line: { to: [100, 0, 0] }, area: { radius: 200 }, external: {},
        beam: { beam: beams.length ? beams[0].id : '' } }[v] || {};
      sp.shape = Object.assign({ kind: v }, d);
      if (v === 'area' && host.programApi) {
        em.simulation = structuredClone(host.programApi.resolveEmitterProgram(em));
        em.simulation.spawnPlacement = 'surface';
      }
      if (v === 'external' && host.programApi && host.programApi.resolveEmitterProgram(em).spawnPlacement === 'surface') {
        em.simulation = structuredClone(host.programApi.resolveEmitterProgram(em));
        em.simulation.spawnPlacement = 'shape';
      }
      // 光柱体积：出生位置全由光柱定，表面铺撒会把点挪走——切回「发射形状」（与 external 同一个理由）
      if (v === 'beam' && host.programApi && host.programApi.resolveEmitterProgram(em).spawnPlacement === 'surface') {
        em.simulation = structuredClone(host.programApi.resolveEmitterProgram(em));
        em.simulation.spawnPlacement = 'shape';
      }
    }), ['point', 'sphere', 'disc', 'box', 'line', 'area', { value: 'external', label: '外部给点（燃烧系统）' },
      { value: 'beam', label: '光柱体积（光柱尘埃）' }], true);
    s.setAttribute('data-role', 'spawnShape');
    return s;
  },

  /** 外部给点：jitter 一行（空 = 删键、缺省 1）+ 说明（工作台里没有外部点 → 预览用假点；真东西去燃烧工作台看） */
  externalShapeRows(em, shape, E) {
    if (!shape || shape.kind !== 'external') return [];
    const host = this._host;
    const wrap = this.num(() => shape.jitter, (v) => E('改外部点抖动', () => { if (v == null) delete shape.jitter; else shape.jitter = Math.max(0, v); }), '× 点半径',
      { placeholder: '1', title: '每颗在挑中的那个外部点周围、半径 = 点的半径 × 它 的球里出生；空 = 缺省 1；0 = 正好生在点上' });
    wrap.querySelector('input').setAttribute('data-role', 'shape-jitter');
    const p = host.programApi ? host.programApi.resolveEmitterProgram(em) : null;
    const why = p && p.solver === 'flock' ? '群体发射器用了外部给点（external）：群体出生由巢管理，没有外部点时整群一个都摆不出来'
      : p && p.spawnPlacement === 'surface' ? '出生位置是「发射区域的可见表面」时外部给点（external）的点不起作用（出生后被挪到区域表面），没有外部点时一个都不发——外部给点要配「发射形状」'
        : '';
    return [
      this.row('外部点抖动', wrap),
      h('div', { class: 'pad dim', 'data-role': 'external-note' },
        '出生点由燃烧系统每帧给（正在烧的格 / 燃着的纸）；没给点就不出生。工作台里没有外部点，本来预览不出生——'
        + '本地预览在锚点周围摆了一圈「预览用假点」代发（只在预览里，写盘不带、不推游戏）；真实效果挂到可燃物上看——燃烧工作台'),
      why ? h('div', { class: 'pad warn', 'data-role': 'external-warn' }, why) : null,
    ];
  },

  /**
   * 薄片「可燃模板」= `plate.burnable = {template}`（types.ts `BurnablePlateBindingDef`，2026-09-16 模板化）：
   * 薄片绑一份**面燃烧**可燃物模板（燃烧工作台做的，`assets/data/burnables/<id>.json`）——多久点着、火焰多长、
   * 火线速度、焦黑与发光、火苗粒子、火光全取模板；**贴图与大小仍归粒子自己**。
   *
   * - **选择器**：候选只列能绑的模板（服务端 `/api/burnables` 的 `bindable`，= 形状闸门零提醒的集合，候选面 = 校验面）；
   *   当前值不在候选里（不存在 / 读不懂 / 是消耗燃烧 / 装不上 / 模板表没读到）时**保值展示**并在下面一行说清为什么，
   *   不静默顶替、不清空。选中 = 一次编辑写 `plate.burnable.template`（块里别的键原样留着）；选「不可燃」= 删掉整个 `burnable` 键。
   * - **只读参数**：所选模板在表里就列关键参数（服务端 `plate_template_summary`）；模板没写、取运行时缺省的那几项灰显。
   * - **打开燃烧工作台**：带当前模板 id（`/api/open_burn_workbench`）；那边存盘后切回来，页面重取模板表、本地预览按新模板烧。
   * - 残留旧 `plate.flammable`（作废、运行时不读）：一行提示 +「删掉」（删键、一条历史）。
   * 渲染只读：什么都不往 doc 里塞，写入全在 `E(label, fn)` 闭包里。
   */
  burnableRows(pl, E) {
    const host = this._host;
    const B = host.burn || {};
    const rows = [];
    const raw = pl.burnable;
    const isObj = !!raw && typeof raw === 'object' && !Array.isArray(raw);
    // 与运行时 plateBurnOf 同口径：template 去空白后才是它找的 id
    const cur = isObj && typeof raw.template === 'string' ? raw.template.trim() : '';
    const badShape = 'burnable' in pl && !cur;
    const st = cur ? host.burnTemplateStatus(cur) : null;
    const cands = (B.rows || []).filter((r) => r.bindable)
      .map((r) => ({ value: r.id, label: r.label && r.label !== r.id ? `${r.id} · ${r.label}` : r.id }));
    if (cur && !cands.some((o) => o.value === cur)) cands.push({ value: cur, label: `${cur}（当前值：${st.short}）` });
    const s = this.sel(() => cur || null, (v) => {
      if (v == null) { E('设为不可燃', () => { delete pl.burnable; }); return; }
      E('改可燃模板', () => {
        if (pl.burnable && typeof pl.burnable === 'object' && !Array.isArray(pl.burnable)) pl.burnable.template = v;
        else pl.burnable = { template: v };
      });
    }, cands, true);
    s.options[0].textContent = '（不可燃）';
    s.setAttribute('data-role', 'burnable-template');
    s.title = '绑一份面燃烧可燃物模板：碰到火（可燃物的火、燃着的火把 / 可燃道具、别的燃着的纸）受热够了就着，按模板的火线速度'
      + '从被火碰到的那边烧过去、焦黑、成灰——这一张永久没了、不补回。候选只有面燃烧模板（蜡烛 / 香这类消耗燃烧不能绑）；'
      + '选「不可燃」= 删掉 plate.burnable';
    const row = this.row('可燃模板', s);
    row.title = s.title;
    rows.push(row);
    if (B.err) {
      rows.push(h('div', { class: 'pad warn', 'data-role': 'burnable-table-err' },
        `可燃物模板表没读到（${B.err}）：候选空着，当前值原样保留；切回窗口或点「↺ 重置」会再读一次`));
    }
    if (badShape) {
      rows.push(h('div', { class: 'pad warn', 'data-role': 'burnable-shape' },
        'plate.burnable 形状不对（要是 {template: 模板 id}），存不了：选一份模板改好，或选「不可燃」删掉'));
    }
    if (st && st.state !== 'ok') rows.push(h('div', { class: 'pad warn', 'data-role': 'burnable-why' }, st.why));
    const sm = st && st.row ? st.row.summary : null;
    if (sm) {
      const dflt = new Set(sm.defaulted || []);
      const val = (key, text, title) => h('span', {
        class: dflt.has(key) ? 'mono dim' : 'mono', 'data-role': `burn-sum:${key}`,
        title: dflt.has(key) ? `模板没写，取运行时缺省${title ? `——${title}` : ''}` : (title || ''),
      }, text);
      const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '?');
      rows.push(
        this.row('名字', val('label', sm.label || cur, `模板 id「${cur}」`)),
        this.row('尺寸', val('size', `${n(sm.widthCm)} × ${n(sm.heightCm)} 厘米`, '模板的真实尺寸（宽 × 高）；纸钱的贴图与大小仍归粒子自己')),
        this.row('引燃时间', val('ignitionDelay', `${n(sm.ignitionDelay)} 秒`, '被火碰到、累计受热这么多秒才着')),
        this.row('火焰长度', val('flameLength', `${n(sm.flameLength)} 厘米`, '燃着时一张纸的火焰长度：会点着挨着的纸与可燃物，也托起一股上升气流')),
        this.row('火线速度', h('span', {},
          val('speedOpposed', `逆流 ${n(sm.speedOpposed)}`, '往下 / 横着烧的火线速度（cm/s）'), ' / ',
          val('speedConcurrent', `顺流 ${n(sm.speedConcurrent)}`, '往上烧的火线速度（cm/s）；一张纸烧完 = 纸宽 / 按此刻朝向插值出来的速度'),
          h('span', { class: 'unit' }, ' cm/s'))),
        this.row('火苗粒子', val('particles', sm.particles && sm.particles.length ? sm.particles.join('、') : '（没有）',
          '模板挂的燃烧粒子效果（来源）：燃着的纸上只发 from = flame 的那几条，出生点 = 燃着的纸')),
        this.row('火光', val('light', sm.light ? '有' : '没有', '燃着的纸按燃着的面积发火光（模板 light）')),
      );
    }
    rows.push(h('div', { class: 'btns' }, h('button', {
      'data-role': 'burn-open',
      title: cur ? `在燃烧工作台里打开模板「${cur}」（另起进程；那边存盘后切回这里，本地预览按新模板烧）`
        : '另起燃烧工作台（可燃物模板在那边做；存盘后切回这里，候选与本地预览自动跟上）',
      onclick: () => host.openBurnWorkbench(cur),
    }, '打开燃烧工作台')));
    if (B.errors && Object.keys(B.errors).length) {
      rows.push(h('div', { class: 'pad dim', 'data-role': 'burnable-unreadable', title: Object.entries(B.errors).map(([k, v]) => `${k}：${v}`).join('\n') },
        `有 ${Object.keys(B.errors).length} 份模板读不懂、不在候选里：${Object.keys(B.errors).join(' / ')}（悬停看原因）`));
    }
    if ('flammable' in pl) {
      rows.push(h('div', { class: 'row', 'data-role': 'flammable-legacy', title: '2026-09-16 起薄片的可燃参数全取绑的可燃物模板；旧参数表 plate.flammable 运行时一个字都不读' },
        h('span', { class: 'warn' }, '旧可燃参数'),
        h('span', { class: 'warn' }, '旧可燃参数已作废，运行时不读'),
        h('button', { class: 'danger', 'data-role': 'flammable-legacy-del', title: '删掉 plate.flammable（一条历史）；要可燃就在上面选一份模板',
          onclick: () => E('删掉旧可燃参数', () => { delete pl.flammable; }) }, '删掉')));
    }
    rows.push(h('div', { class: 'pad dim', 'data-role': 'burnable-note' },
      '本地预览：按 I（左侧「火」）在光标处放一段调试火焰，看纸片被点着（火色）、焦黑、成灰消失；火光与火苗粒子在游戏 / 燃烧工作台里看'));
    return rows;
  },

  // ---------------------------------------------------------------- 主体
  render(host, container) {
    this._renderBody(host, container);
    if (!host.currentBeam()) this.applyCapabilities(host, container);
    this.stampKeys(container);                         // 焦点按身份键放回（见 stampKeys）
  },

  /** sRGB 0..1 三元组的颜色控件：系统取色器 + 三格数值（取色器改完 = 一次编辑；数值夹到 0..1、三位小数） */
  color(get, set, role) {
    const cur = get() || [1, 1, 1];
    const hex = '#' + cur.map((x) => Math.round(clamp(x, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
    const pick = h('input', { type: 'color', value: hex, 'data-role': role || null, title: '取色（sRGB）' });
    pick.addEventListener('change', () => {
      const v = pick.value.replace('#', '');
      set([0, 2, 4].map((i) => round3(parseInt(v.slice(i, i + 2), 16) / 255)));
    });
    return h('span', { class: 'numwrap' }, pick, this.vec3(get, (v) => set(v.map((x) => round3(clamp(x, 0, 1)))), 'sRGB 0–1'));
  },

  /**
   * 光柱（体积光，types.ts `VfxBeamDef`）。字段逐条对 types.ts；缺省 / 上下限读打包进页面的运行时契约
   * （`vfxBeam.VFX_BEAM_CONTRACT` = `src/data/vfxBeamContract.json`，与 Python 闸门同一份）——灰字占位是缺省，空 = 删键。
   * 写入时夹到契约范围：页面产生不了被闸门拒存的值。形状过不了运行时闸门时顶上黄字列出（与存盘拒绝同一句）。
   */
  beamSections(host, doc, b) {
    const api = host.beamApi();
    const C = api ? api.VFX_BEAM_CONTRACT : { defaults: {}, limits: {} };
    const D = C.defaults, L = C.limits;
    const E = (label, fn) => host.edit(label, fn);
    const lim = (k, v) => (L[k] ? clamp(v, L[k][0], L[k][1]) : v);
    const optNum = (label, key, unit, title, opts) => this.row(label, this.num(() => b[key], (v) => E(`改${label}`, () => {
      if (v == null) delete b[key]; else b[key] = lim(key === 'fadeIn' || key === 'fadeOut' ? 'fadeSeconds' : key, v);
    }), unit, Object.assign({ placeholder: D[key] == null ? '' : String(D[key]), title }, opts || {})));
    const errors = api ? api.beamDefErrors(b) : [];
    const users = host.beamRefs(b.id);
    const out = [];
    if (errors.length) out.push(h('div', { class: 'pad warn', 'data-role': 'beam-errors' }, `这根光柱现在存不了（也推不到游戏）：${errors.join('；')}`));
    const DEFAULT_3D = { from: [-160, 280, 60], to: [30, -20, -10], section: { kind: 'rect', width: 110, height: 30 } };
    const DEFAULT_2D = { from: [-60, -240], to: [0, 0], width: [40, 150] };
    out.push(this.section('beam', `光柱 · ${b.id}`, () => [
      this.row('id', this.txt(() => b.id, (v) => { if (v && v !== b.id) E('改光柱 id', () => host.renameBeam(b.id, v)); }, 'window_light')),
      this.row('模式', this.sel(() => b.mode, (v) => E('切光柱模式', () => {
        b.mode = v === '2d' ? '2d' : '3d';
        // 另一个模式的形状原样留着（切回来还在）；这个模式还没有形状就给缺省
        if (b.mode === '3d' && !b.shape3d) b.shape3d = clone(DEFAULT_3D);
        if (b.mode === '2d' && !b.shape2d) b.shape2d = clone(DEFAULT_2D);
      }), [{ value: '3d', label: '3D 光柱（伪 3D 世界里的棱台，原画深度挡得住）' }, { value: '2d', label: '2D 光带（画面坐标里的梯形，没深度也能用）' }])),
      this.row('颜色', this.color(() => b.color, (v) => E('改光柱颜色', () => { b.color = v; }), 'beam-color')),
      h('div', { class: 'row' }, h('span', {}, ''), this.chk(() => Array.isArray(b.colorEnd), (v) => E(v ? '光柱颜色沿长度渐变' : '光柱去掉渐变', () => {
        if (v) b.colorEnd = (b.color || [1, 1, 1]).slice(); else delete b.colorEnd;
      }), '终点颜色不一样（沿长度渐变）', { role: 'beam-colorEnd' })),
      Array.isArray(b.colorEnd) ? this.row('终点颜色', this.color(() => b.colorEnd, (v) => E('改光柱终点颜色', () => { b.colorEnd = v; }), 'beam-colorEnd-pick')) : null,
      this.row('强度', this.num(() => b.intensity, (v) => E('改光柱强度', () => { b.intensity = lim('intensity', v == null ? 0 : v); }), '',
        { step: 0.05, title: '显示空间的亮度：1 = 光柱颜色整份叠上去（与粒子 alpha 同一个约定）；暗场景一般 0.2–0.6' })),
      optNum('边缘软度', 'edgeSoftness', '0–1', '0 = 硬边；越大越从中心就开始暗', { step: 0.05 }),
      b.mode === '3d' ? optNum('厚度感', 'thickness', '0–1', '按视线穿过光柱多厚加权：1 = 截面形状看得出来（矩形窗光中间平、棱边亮）；0 = 只看边缘软度', { step: 0.1 }) : null,
      optNum('贴地软收尾', 'contactSoftWu', 'wu', '光柱碰到原画表面（地面 / 墙 / 前景）时在这个距离里淡掉；0 = 硬切'),
      this.row('混合', this.sel(() => b.blend, (v) => E('改光柱混合', () => { if (v) b.blend = v; else delete b.blend; }),
        [{ value: 'add', label: 'add 叠加（缺省）' }, { value: 'screen', label: 'screen 柔叠加（亮处不爆）' }, { value: 'normal', label: 'normal 普通透明' }], true)),
      this.row('与实体前后', this.sel(() => b.sort, (v) => E('改光柱前后', () => { if (v) b.sort = v; else delete b.sort; }),
        [{ value: 'depth', label: '按落点参与实体排序（缺省）：人在落点前面挡住光柱、后面被叠上' },
          { value: 'background', label: '钉在所有实体后面' }, { value: 'foreground', label: '钉在所有实体前面' }], true)),
      optNum('淡入', 'fadeIn', '秒', 'playVfx / 条件翻真时淡入', { step: 0.1 }),
      optNum('淡出', 'fadeOut', '秒', 'stopVfx / 条件翻假时淡出（淡完实例才收）', { step: 0.1 }),
      users.length ? h('div', { class: 'pad dim' }, `尘埃发射器 ${users.join(' / ')} 用着它（光柱体积出生 / 被光柱照亮）`) : null,
      h('div', { class: 'pad dim' }, '真实效果看原画视图（运行时那段着色器）；3D 视图画线框。不给人物加光。'),
    ]));
    // ---- 形状
    out.push(this.section('beamShape', b.mode === '2d' ? '形状（2D 光带）' : '形状（3D 光柱）', () => {
      if (b.mode === '2d') {
        const s = b.shape2d || {};
        const W = (label, fn) => E(label, () => { b.shape2d = b.shape2d || clone(DEFAULT_2D); fn(b.shape2d); });
        return [
          h('div', { class: 'pad dim' }, '画面坐标（wu），相对布置锚点投到画面上的那一点；拖原画上的起点 / 终点把手也行'),
          this.row('起点', this.pair(() => s.from || [0, 0], (v) => W('改光带起点', (q) => { if (v.every((x) => x === 0)) delete q.from; else q.from = v.map(round2); }), '画面 wu')),
          this.row('终点', this.pair(() => s.to || [0, 0], (v) => W('改光带终点', (q) => { q.to = v.map(round2); }), '画面 wu')),
          this.row('起止全宽', this.pair(() => s.width || [0, 0], (v) => W('改光带宽', (q) => { q.width = v.map((x) => Math.max(0, round2(x))); }), 'wu')),
          h('div', { class: 'row' }, h('span', {}, ''), this.chk(() => s.occludeByDepth === true, (v) => W(v ? '光带被原画前景挡住' : '光带不被原画挡', (q) => {
            if (v) q.occludeByDepth = true; else delete q.occludeByDepth;
          }), '原画前景挡住它（立在锚点脚下那一深度）', { role: 'beam-occlude', title: '光带立在锚点脚下那一深度的直立面上，原画比它近的地方把它挡掉；没深度的场景忽略' })),
        ];
      }
      const s = b.shape3d || {};
      const sec = s.section || { kind: 'rect', width: 60, height: 20 };
      const W = (label, fn) => E(label, () => { b.shape3d = b.shape3d || clone(DEFAULT_3D); fn(b.shape3d); });
      const polygon = sec.kind === 'polygon';
      return [
        h('div', { class: 'pad dim' }, '伪 3D 世界（wu），相对布置锚点；终点一般拖到地面稍微穿进去一点，交给原画深度截断'),
        this.row('起点', this.vec3(() => s.from || [0, 0, 0], (v) => W('改光柱起点', (q) => { if (v.every((x) => x === 0)) delete q.from; else q.from = v.map(round2); }), 'wu')),
        this.row('终点', this.vec3(() => s.to || [0, 0, 0], (v) => W('改光柱终点', (q) => { q.to = v.map(round2); }), 'wu')),
        this.row('截面', this.sel(() => sec.kind, (v) => W('改光柱截面', (q) => {
          const old = q.section || sec;
          if (v === 'polygon' && old.kind !== 'polygon') q.section = { kind: 'polygon', sides: 6, radius: round2(Math.max(old.width || 0, old.height || 0) / 2 || 30) };
          if (v === 'rect' && old.kind !== 'rect') q.section = { kind: 'rect', width: round2((old.radius || 30) * 2), height: round2((old.radius || 30) * 2) };
        }), [{ value: 'rect', label: '矩形（窗、门缝、瓦缝）' }, { value: 'polygon', label: '正多边形（天窗圆孔之类）' }])),
        !polygon ? this.row('截面宽 × 高', this.pair(() => [sec.width, sec.height], (v) => W('改光柱截面尺寸', (q) => {
          q.section = { kind: 'rect', width: Math.max(0.5, round2(v[0])), height: Math.max(0.5, round2(v[1])) };
        }), 'wu')) : null,
        polygon ? this.row('边数', this.num(() => sec.sides, (v) => W('改截面边数', (q) => {
          q.section = Object.assign({}, q.section, { sides: Math.round(clamp(v == null ? 6 : v, 3, 8)) });
        }), '3–8', { int: true })) : null,
        polygon ? this.row('外接圆半径', this.num(() => sec.radius, (v) => W('改截面半径', (q) => {
          q.section = Object.assign({}, q.section, { radius: Math.max(0.5, v == null ? 30 : v) });
        }), 'wu')) : null,
        this.row('张角', this.pair(() => s.spreadDeg || [0, 0], (v) => W('改光柱张角', (q) => {
          const a = v.map((x) => round2(lim('spreadDeg', x)));
          if (a.every((x) => x === 0)) delete q.spreadDeg; else q.spreadDeg = a;
        }), polygon ? '度（只看第一个）' : '度（沿宽, 沿高）', { title: '全角；0 = 平行光棱柱（太阳透窗），大于 0 往外张开' })),
        this.row('绕轴转角', this.num(() => s.rollDeg, (v) => W('改光柱转角', (q) => { if (!v) delete q.rollDeg; else q.rollDeg = round2(v); }), '度',
          { placeholder: '0', title: '截面绕光柱轴转：让矩形的边对齐墙 / 窗框（0 = 宽沿水平）' })),
      ];
    }));
    // ---- 沿长度亮度
    out.push(this.section('beamAlong', '沿长度亮度', () => [
      this.curve('沿长度亮度', () => b.alongCurve, (v) => {
        if (v && v.length) b.alongCurve = v.slice(0, 8).map((k) => [round3(clamp(k[0], 0, 1)), round3(lim('alongValue', k[1]))]);
        else delete b.alongCurve;
      }),
      h('div', { class: 'pad dim' }, '横 = 起点→终点，纵 = 倍率；不写 = 恒 1。起点淡入、落地前变暗靠它（最多 8 个点）'),
    ]));
    // ---- 雾气噪声
    out.push(this.section('beamNoise', '雾气噪声', () => {
      const n = b.noise;
      const rows = [h('div', { class: 'row' }, h('span', {}, ''), this.chk(() => !!n, (v) => E(v ? '加光柱雾气噪声' : '去掉光柱雾气噪声', () => {
        if (v) b.noise = { strength: 0.3, scaleWu: 90, velocity: [8, 3, 0] }; else delete b.noise;
      }), '光柱里流动的雾气', { role: 'beam-noise' }))];
      if (!n) return rows;
      rows.push(
        this.row('强度', this.num(() => n.strength, (v) => E('改雾气强度', () => { n.strength = lim('noiseStrength', v == null ? 0 : v); }), '0–1', { step: 0.05, title: '亮度在 [1−强度, 1+强度] 之间起伏' })),
        this.row('尺度', this.num(() => n.scaleWu, (v) => E('改雾气尺度', () => { n.scaleWu = Math.max(1, v == null ? 90 : v); }), 'wu', { title: '一团雾大约多大' })),
        this.row('流速', this.vec3(() => n.velocity || [0, 0, 0], (v) => E('改雾气流速', () => { if (v.every((x) => x === 0)) delete n.velocity; else n.velocity = v.map(round2); }),
          b.mode === '2d' ? 'wu/s（2D 只看前两个，画面坐标）' : 'wu/s（M-world）')),
      );
      return rows;
    }));
    // ---- 图案遮罩
    out.push(this.section('beamCookie', '图案遮罩（窗棂 / 树叶）', () => {
      const ck = b.cookie;
      const images = (host.sources && host.sources.images) || [];
      const rows = [h('div', { class: 'row' }, h('span', {}, ''), this.chk(() => !!ck, (v) => E(v ? '加光柱图案遮罩' : '去掉光柱图案遮罩', () => {
        if (v) b.cookie = { image: images[0] || '' }; else delete b.cookie;
      }), '截面上贴一张灰度图，沿光柱投出一条条光', { role: 'beam-cookie' }))];
      if (!ck) return rows;
      rows.push(
        this.row('灰度图', this.sel(() => ck.image, (v) => E('改图案遮罩', () => { ck.image = v || ''; }), images, false)),
        images.length ? null : h('div', { class: 'pad warn' }, 'resources/runtime/images/vfx/ 下还没有图片：先把窗棂 / 树叶灰度图放进去'),
        this.row('强度', this.num(() => ck.strength, (v) => E('改图案强度', () => { if (v == null) delete ck.strength; else ck.strength = lim('cookieStrength', v); }), '0–1', { placeholder: String(D.cookieStrength), step: 0.05 })),
        this.row('铺几遍', this.pair(() => ck.scale || [1, 1], (v) => E('改图案缩放', () => { const a = v.map((x) => Math.max(0.01, round3(x))); if (a[0] === 1 && a[1] === 1) delete ck.scale; else ck.scale = a; }), '宽, 高')),
        this.row('偏移', this.pair(() => ck.offset || [0, 0], (v) => E('改图案偏移', () => { const a = v.map(round3); if (a.every((x) => x === 0)) delete ck.offset; else ck.offset = a; }), '截面归一化')),
        this.row('旋转', this.num(() => ck.rotationDeg, (v) => E('改图案旋转', () => { if (!v) delete ck.rotationDeg; else ck.rotationDeg = round2(v); }), '度', { placeholder: '0' })),
      );
      return rows;
    }));
    // ---- 亮度起伏
    out.push(this.section('beamPulse', '亮度起伏', () => {
      const p = b.pulse;
      const rows = [this.row('起伏', this.sel(() => p && p.kind, (v) => E('改光柱亮度起伏', () => {
        if (!v) { delete b.pulse; return; }
        const keep = b.pulse && typeof b.pulse === 'object' ? b.pulse : null;
        b.pulse = { kind: v, hz: keep ? keep.hz : (v === 'flicker' ? 6 : 0.2), amount: keep ? keep.amount : (v === 'flicker' ? 0.3 : 0.35) };
      }), [{ value: 'flicker', label: '闪烁（平滑随机）' }, { value: 'breathe', label: '慢呼吸（正弦，云过太阳）' }], true))];
      if (!p) return rows;
      rows.push(
        this.row('频率', this.num(() => p.hz, (v) => E('改起伏频率', () => { p.hz = lim('pulseHz', v == null ? 0 : v); }), 'Hz', { step: 0.1 })),
        this.row('幅度', this.num(() => p.amount, (v) => E('改起伏幅度', () => { p.amount = lim('pulseAmount', v == null ? 0 : v); }), '0–1', { step: 0.05, title: '最暗时亮度 = 1 − 幅度' })),
      );
      return rows;
    }));
    return out;
  },

  /** 发射形状「光柱体积」那几行：用哪根光柱 + 沿长度那一段（不写 = 整根） */
  beamShapeRows(doc, em, shape, E) {
    if (!shape || shape.kind !== 'beam') return [];
    const ids = (doc.beams || []).map((b) => b.id);
    const errs = [];
    const api = this._host.beamApi();
    if (api && this._host.programApi) {
      const own = new Set(ids);
      for (const e of api.emitterBeamRefErrors(em, own, this._host.programApi.resolveEmitterProgram(em).solver)) errs.push(e);
    }
    return [
      this.row('光柱', this.sel(() => shape.beam, (v) => E('改出生光柱', () => { shape.beam = v || ''; }), ids, false)),
      this.row('沿长度', this.pair(() => shape.along || [0, 1], (v) => E('改出生区段', () => {
        const a = v.map((x) => round3(clamp(x, 0, 1))).sort((x, y) => x - y);
        if (a[0] === 0 && a[1] === 1) delete shape.along; else shape.along = a;
      }), '0–1', { title: '只在光柱沿长度这一段里出生；不写 = 整根' })),
      ids.length ? null : h('div', { class: 'pad warn' }, '这个效果还没有光柱：左栏「光柱」先加一根'),
      errs.length ? h('div', { class: 'pad warn', 'data-role': 'beam-shape-errors' }, errs.join('；')) : null,
    ];
  },

  programSection(host, em) {
    const api = host.programApi;
    if (!api) return h('div', { class: 'pad dim' }, '模拟模块加载后可编辑执行配置');
    const p = api.resolveEmitterProgram(em);
    const change = (label, fn) => host.edit(label, () => {
      // Materialize exactly the current effective plan, only on a real edit. Unknown fields survive.
      if (!em.simulation) em.simulation = structuredClone(api.resolveEmitterProgram(em));
      fn(em.simulation);
    });
    return this.section('simulation', '模拟与外部影响', () => [
      this.row('运动模型', this.sel(() => p.solver, (v) => host.edit('切换运动模型', () => {
        em.simulation = api.switchEmitterProgram(em, v);
      }), [{ value: 'particle', label: '普通粒子' }, ...(em.plate ? [{ value: 'plate', label: '薄片' }] : []),
        ...(em.behavior && !em.subOnly ? [{ value: 'flock', label: '群体' }] : [])])),
      this.row('出生位置', this.sel(() => p.spawnPlacement, (v) => change('改出生位置', (q) => {
        q.spawnPlacement = v;
        if (v === 'shape' && em.spawn.shape?.kind === 'area') em.spawn.shape = { ...em.spawn.shape, kind: 'disc' };
      }),
        p.solver === 'flock' ? [{ value: 'shape', label: '由群体的巢管理' }]
          : [{ value: 'shape', label: '发射形状' }, { value: 'surface', label: '发射区域的可见表面' }])),
      p.solver !== 'flock' ? this.row('出生速度', this.sel(() => p.initialVelocity, (v) => change('改出生速度方式', q => { q.initialVelocity = v; }),
        [{ value: 'rest', label: '静止' }, { value: 'configured', label: '使用发射初速与方向' }])) : null,
      p.spawnPlacement === 'surface' || p.recycle.mode !== 'none' ? this.row('无区域时半径', this.num(
        () => p.surfaceRadius ?? (em.spawn.shape?.kind === 'area' ? em.spawn.shape.radius ?? 200 : 200),
        v => change('改表面铺撒半径', q => { if (v == null) delete q.surfaceRadius; else q.surfaceRadius = Math.max(1, v); }), 'wu',
        { title: '未画发射区域时使用的圆盘半径；画了区域则按区域采样。清空恢复原有半径。' })) : null,
      ...[['sceneWind', '场景风（空气速度）'], ['wind', '局部推力（加速度）'], ['airflow', '局部气流（空气速度）'], ['contact', '角色接触（踢动）'], ['stimulus', '标签刺激响应']].map(([key, label]) => {
        const row = this.row(label, this.chk(() => p.influences[key], (v) => change('改' + label, (q) => { q.influences[key] = v; }), '接收'));
        if (p.solver === 'flock' && key !== 'stimulus') for (const n of row.querySelectorAll('input')) n.disabled = true;
        return row;
      }),
      this.row('出界补回', this.sel(() => p.recycle.mode, (v) => change('改出界补回', (q) => { q.recycle.mode = v; }),
        p.solver === 'flock' ? [{ value: 'none', label: '由群体返回行为管理' }]
          : [{ value: 'none', label: '不补回' }, { value: 'surface', label: '在发射区域表面补回' }, { value: 'airborne', label: '从上风空中补回' }])),
      p.recycle.mode === 'airborne' ? this.row('高度方式', this.sel(() => p.recycle.height ? 'custom' : 'auto', (v) => change('改补回高度方式', q => {
        if (v === 'auto') delete q.recycle.height; else q.recycle.height = [50, 50];
      }), [{ value: 'auto', label: '自动（按范围限制与落速）' }, { value: 'custom', label: '指定高度' }])) : null,
      p.recycle.mode === 'airborne' && p.recycle.height ? this.row('补回高度', this.pair(() => p.recycle.height, (v) => change('改补回高度', (q) => { q.recycle.height = v; }), 'wu')) : null,
      p.recycle.mode === 'airborne' ? this.row('上风偏移', h('div', { class: 'row' },
        this.pair(() => p.recycle.upwind || [0, 260], (v) => change('改补回上风偏移', (q) => { q.recycle.upwind = v; }), 'wu'),
        p.recycle.upwind ? h('button', { onclick: () => change('恢复默认上风偏移', q => { delete q.recycle.upwind; }) }, '默认') : null)) : null,
      h('div', { class: 'pad dim', title: '仅查看不会改写配置。首次编辑在当前实际行为上修改；切换运动模型使用该模型的默认执行配置，物性参数保留，可撤销。' },
        '发射、外部影响、运动与补回分别配置。'),
    ]);
  },

  applyCapabilities(host, container) {
    const em = host.currentEmitter();
    if (!em || !host.programApi) return;
    const c = host.programApi.emitterCapabilities(em);
    const disable = (n, why) => {
      if (!n) return;
      n.title = why + '；已有数据原样保留';
      n.dataset.inactive = 'true';
      for (const input of n.querySelectorAll('input, select, textarea, button')) input.disabled = true;
    };
    const row = (sec, label) => [...container.querySelectorAll(`.sec[data-sec="${sec}"] .row`)].find(n => n.firstElementChild?.textContent === label || n.querySelector('label')?.textContent === label);
    if (!c.initialVelocity) for (const label of ['初速', '方向', '方向向量', '锥角']) disable(row('spawn', label), '当前出生方式不使用初速度');
    if (!c.genericMotion) for (const label of ['重力', '阻力', '恒定风', '浮力', '速度上限']) disable(row('motion', label), '当前运动模型不使用此通用参数');
    if (!c.turbulence) for (const label of ['湍流强度', '湍流尺度', '湍流速率']) disable(row('motion', label), '群体运动不使用通用湍流');
    if (c.spawnPlacement === 'surface') for (const label of ['形状', '半径', '盒尺寸', '线终点', '外部点抖动']) disable(row('spawn', label), '出生位置取布置的发射区域表面');
    if (host.areaPoly(host.activePlacement())?.length >= 3) disable(row('simulation', '无区域时半径'), '当前使用已绘制的发射区域');
    if (c.flock) {
      for (const label of ['速率', '间隔浮动', '开播爆发', '形状', '半径', '预览半径', '盒尺寸', '线终点', '外部点抖动', '活跃时长']) disable(row('spawn', label), '群体出生由巢管理');
      disable(container.querySelector('.sec[data-sec="life"]'), '群体生命周期由状态机管理');
    }
    if (!c.collision) disable(container.querySelector('.sec[data-sec="collision"]'), '接触由当前运动模型处理');
    if (em.plate && !c.plate) disable(container.querySelector('.sec[data-sec="plate"]'), '薄片参数未启用，可在运动模型中切换');
    if (em.behavior && !c.flock) disable(container.querySelector('.sec[data-sec="behavior"]'), '群体参数未启用，可在运动模型中切换');
    if (c.plate) for (const label of ['自转', '初始随机相位', '速度拉伸', '左右镜像随速度 x（侧视贴图）']) disable(row('appearance', label), '薄片朝向由物理模拟决定');
    if (!c.influences.stimulus) disable(container.querySelector('[data-role="stimulus-controls"]'), '标签刺激响应未启用，在模拟与外部影响中开启');
    for (const sec of container.querySelectorAll('.sec[data-inactive="true"]')) {
      sec.firstElementChild?.appendChild(h('span', { class: 'dim' }, ' · 未启用'));
    }
    if (c.errors.length) container.prepend(h('div', { class: 'pad warn' }, c.errors.join('；')));
    // 雷电样式那几层：画法（雷的形状 / 粗细 / 光晕）是样式写进来的（改了下一次套用就被覆盖），贴图 / 宽度锁住；
    // 时间曲线（亮度 / 颜色 / 粗细随寿命）照常可调，重新套用时保留
    const doc = host.doc;
    if (doc && doc.generator && doc.generator.kind === 'lightning' && LIGHTNING_OWNED.includes(em.id)) {
      for (const label of ['动画包', '单图', '状态', '栖息状态', '宽度']) disable(row('appearance', label), '这一层由雷电样式来画，在上面「雷电样式」里改');
      const sec = container.querySelector('.sec[data-sec="appearance"]');
      if (sec) sec.insertBefore(h('div', { class: 'pad dim', 'data-role': 'lightning-owned' },
        '这一层由「雷电样式」来画：形状、粗细、光晕在上面「雷电样式」里改；亮度 / 颜色 / 粗细随寿命可以在这里调，重新套用时保留'), sec.children[1] || null);
    }
  },

  _renderBody(host, container) {
    this._host = host;
    container.textContent = '';
    if (!host.doc) { container.appendChild(h('div', { class: 'pad dim' }, '还没打开任何效果')); return; }
    const doc = host.doc;
    const em = host.currentEmitter();
    container.appendChild(this.effectSection(host, doc));
    // classic script 顶层的 const 不挂 window：按裸标识符判（与 app.js 的 S 同理）
    if (typeof LightningPanel !== 'undefined') container.appendChild(LightningPanel.section(this, host, doc));
    container.appendChild(this.section('timing', '起播错峰', () => [
      this.row('随机预热', this.chk(() => doc.prewarmSeconds !== undefined,
        (v) => host.edit('改随机预热', () => { if (v) doc.prewarmSeconds = [1, 4]; else delete doc.prewarmSeconds; }),
        '启用', { title: '按实例种子选择预热时长，先静默模拟再显示；适合烟、虫群、灯火。关闭则从头起播。' })),
      doc.prewarmSeconds ? this.row('预热时长', this.pair(() => doc.prewarmSeconds,
        (v) => host.edit('改预热时长', () => { doc.prewarmSeconds = v.map((x) => clamp(x, 0, 15)).sort((a, b) => a - b); }), '秒')) : null,
    ]));
    container.appendChild(this.placementSection(host, doc));
    container.appendChild(this.surfaceSection(host));
    // 选中的是光柱把手：检视器换成这根光柱（发射器那几块不出——左栏点发射器回来）
    const bm = host.currentBeam();
    if (bm) { for (const n of this.beamSections(host, doc, bm)) if (n) container.appendChild(n); return; }
    if (!em) { container.appendChild(h('div', { class: 'pad dim' }, '左栏选一个发射器')); return; }
    const E = (label, fn) => host.edit(label, fn);
    const ensure = (key, init) => { if (!em[key] || typeof em[key] !== 'object') em[key] = init; return em[key]; };
    const activate = (solver) => { if (host.programApi) em.simulation = host.programApi.switchEmitterProgram(em, solver); };
    container.appendChild(this.programSection(host, em));

    // ---------------- 发射器本身
    container.appendChild(h('div', { class: 'sec' },
      this.row('发射器 id', this.txt(() => em.id, (v) => { if (v) E('改发射器 id', () => host.renameEmitter(em.id, v)); }, 'bats')),
      this.row('原点偏移', this.vec3(() => em.offset || [0, 0, 0], (v) => E('改发射器偏移', () => { em.offset = v.map(round2); }), 'wu')),
      h('div', { class: 'row' }, h('span', {}, ''),
        this.chk(() => !!em.subOnly, (v) => E('改子发射器', () => { if (v) { em.subOnly = true; if (host.programApi?.resolveEmitterProgram(em).solver === 'flock') activate('particle'); } else delete em.subOnly; }),
          '只由 onHit 触发（子发射器）')),
    ));

    // ---------------- 外观
    container.appendChild(this.section('appearance', '外观', () => {
      const ap = em.appearance || (em.appearance = { sizeWu: 6 });
      const src = host.sources || { anims: [], images: [] };
      return [
        this.row('动画包', this.sel(() => ap.animFile, (v) => E('改动画包', () => { if (v) { ap.animFile = v; delete ap.image; } else delete ap.animFile; }), src.anims, true)),
        this.row('单图', this.sel(() => ap.image, (v) => E('改贴图', () => { if (v) { ap.image = v; delete ap.animFile; } else delete ap.image; }), src.images, true)),
        // 状态名是对动画包的引用（选择器铁律）：下拉候选 = 那个 anim.json 的 states；打错的旧值保值显示成「当前值，候选里没有」。
        // 原来是裸文本框：打成 fyl 运行时静默退回第一个状态（蝙蝠飞着倒挂），本地预览按点画也看不出来
        ap.animFile ? this.row('状态', this.sel(() => ap.state, (v) => E('改动画状态', () => { if (v) ap.state = v; else delete ap.state; }), host.animStates(ap.animFile), true)) : null,
        ap.animFile ? this.row('栖息状态', this.sel(() => ap.restState, (v) => E('改栖息状态', () => { if (v) ap.restState = v; else delete ap.restState; }), host.animStates(ap.animFile), true)) : null,
        this.row('宽度', this.num(() => ap.sizeWu, (v) => E('改粒子大小', () => { ap.sizeWu = v == null ? 1 : Math.max(0.01, v); }), 'wu', { title: '粒子世界宽度；高按贴图长宽比' })),
        this.row('大小抖动', this.pair(() => ap.sizeJitter || [1, 1], (v) => E('改大小抖动', () => { ap.sizeJitter = v; }), '×')),
        // 空 = 删键（回到运行时缺省恒 1），不落 `[]` / null
        this.curve('大小×寿命', () => ap.sizeOverLife, (v) => { if (v && v.length) ap.sizeOverLife = v; else delete ap.sizeOverLife; }),
        this.curve('透明×寿命', () => ap.alphaOverLife, (v) => { if (v && v.length) ap.alphaOverLife = v; else delete ap.alphaOverLife; }, { cap: 1 }),
        this.row('乘色', this.vec3(() => ap.tint || [1, 1, 1], (v) => E('改乘色', () => { ap.tint = v.map((x) => clamp(x, 0, 1)); }), '0–1')),
        ...this.tintOverLifeRows(ap, E),
        this.row('混合', this.sel(() => ap.blend, (v) => E('改混合', () => { if (v) ap.blend = v; else delete ap.blend; }), ['normal', 'add'], true)),
        // 被光柱照亮（光柱里的尘埃）：候选 = 本效果的光柱（选择器铁律；悬垂值保值显示）
        this.row('被光柱照亮', this.sel(() => ap.beamLit && ap.beamLit.beam, (v) => E('改被光柱照亮', () => {
          if (!v) { delete ap.beamLit; return; }
          ap.beamLit = Object.assign({}, ap.beamLit, { beam: v });
        }), ((doc.beams || []).map((b) => b.id)), true)),
        ap.beamLit ? this.row('光柱亮度倍率', this.num(() => ap.beamLit.gain, (v) => E('改光柱照亮倍率', () => {
          if (v == null) delete ap.beamLit.gain; else ap.beamLit.gain = clamp(v, 0, 20);
        }), '×', { placeholder: '1', step: 0.1, title: '尘埃亮度 = 光柱在它那一点的亮度 × 这个倍率；柱外看不见' })) : null,
        h('div', { class: 'row' }, h('span', {}, ''), this.chk(() => ap.lit !== false, (v) => E('改受光', () => { if (v) delete ap.lit; else ap.lit = false; }), '吃 probe 底光 + 实体灯（自发光的关掉）')),
        ap.lit !== false ? this.row('镜面/自发光', this.num(() => ap.emissive, (v) => E('改自发光', () => { if (v == null) delete ap.emissive; else ap.emissive = clamp(v, 0, 1); }), '0–1', { title: '这一份亮度不吃漫反射着色。水滴、火星这类靠镜面/自发光才看得见的东西才给；不是亮度拉杆' })) : null,
        // 空 = 删键（运行时缺省 1）；夹到 0..10（与形状闸门 / 校验器 / 运行时同口径）
        ap.lit !== false ? this.row('受光强度', this.num(() => ap.lightGain, (v) => E('改受光强度', () => { if (v == null) delete ap.lightGain; else ap.lightGain = clamp(v, 0, 10); }), '0–10', { placeholder: '1', title: '乘在这个发射器接收到的光上（probe 底光 + 实体灯），不乘自发光；1 = 与角色同口径；只在受光（lit）时有意义' })) : null,
        h('div', { class: 'row' }, h('span', {}, ''), this.chk(() => !!ap.faceVelocity, (v) => E('改朝向速度', () => { if (v) ap.faceVelocity = true; else delete ap.faceVelocity; }), '左右镜像随速度 x（侧视贴图）')),
        this.row('速度拉伸', this.num(() => ap.stretchByVelocity, (v) => E('改速度拉伸', () => { if (v == null) delete ap.stretchByVelocity; else ap.stretchByVelocity = v; }), '秒', { title: '长度 = 速度 × 该秒数；0 = 纯 billboard' })),
        this.row('软边', this.num(() => ap.softEdgeWu, (v) => E('改软边', () => { if (v == null) delete ap.softEdgeWu; else ap.softEdgeWu = v; }), 'wu', { title: '与壳的深度差在此宽度内线性淡出（烟贴墙不切硬边）' })),
        this.row('自转', this.pair(() => (ap.spin && ap.spin.rate) || [0, 0], (v) => E('改自转', () => { ap.spin = Object.assign({}, ap.spin, { rate: v }); }), '度/秒')),
        ap.spin ? h('div', { class: 'row' }, h('span', {}, ''), this.chk(() => !!(ap.spin && ap.spin.randomPhase), (v) => E('改自转相位', () => { ap.spin = Object.assign({}, ap.spin, { randomPhase: v }); if (!v) delete ap.spin.randomPhase; }), '初始随机相位')) : null,
      ];
    }));

    // ---------------- 发射
    container.appendChild(this.section('spawn', '发射', () => {
      const sp = em.spawn || (em.spawn = { max: 10 });
      const shape = sp.shape || null;
      return [
        this.row('池容量', this.num(() => sp.max, (v) => E('改池容量', () => { sp.max = Math.max(1, Math.round(v == null ? 1 : v)); }), '个', { int: true, title: '同时存活上限' })),
        this.row('速率', this.num(() => sp.rate, (v) => E('改发射速率', () => { if (v == null) delete sp.rate; else sp.rate = v; }), '个/秒', { title: '不写 = 只有 burst' })),
        this.row('间隔浮动', this.num(() => sp.intervalJitter, (v) => E('改间隔浮动', () => {
          if (v == null) delete sp.intervalJitter; else sp.intervalJitter = clamp(v, 0, 0.95);
        }), '比例', { step: 0.05, title: '0 = 固定节拍；0.3 = 每次发射间隔随机上下浮动 30%。由实例种子驱动。', disabled: !(sp.rate > 0) || !!em.subOnly })),
        this.row('开播爆发', this.num(() => sp.burst, (v) => E('改爆发', () => { if (v == null) delete sp.burst; else sp.burst = Math.round(v); }), '个', { int: true })),
        this.row('形状', this.shapeSelect(em, sp, shape, E)),
        ...this.externalShapeRows(em, shape, E),
        ...this.beamShapeRows(doc, em, shape, E),
        shape && (shape.kind === 'sphere' || shape.kind === 'disc')
          ? this.row('半径', this.num(() => shape.radius, (v) => E('改发射半径', () => { shape.radius = v == null ? 1 : Math.max(0, v); }), 'wu')) : null,
        shape && shape.kind === 'area'
          ? this.row('预览半径', this.num(() => shape.radius, (v) => E('改区域预览半径', () => { shape.radius = v == null ? 200 : Math.max(1, v); }), 'wu', { title: '铺在布置的发射区域（area 多边形）里；布置没圈发射区域时退成这个半径的圆盘' })) : null,
        shape && shape.kind === 'box' ? this.row('盒尺寸', this.vec3(() => shape.size || [0, 0, 0], (v) => E('改发射盒', () => { shape.size = v; }), 'wu')) : null,
        shape && shape.kind === 'line' ? this.row('线终点', this.vec3(() => shape.to || [0, 0, 0], (v) => E('改发射线', () => { shape.to = v; }), 'wu')) : null,
        this.row('初速', this.pair(() => sp.speed || [0, 0], (v) => E('改初速', () => { sp.speed = v; }), 'wu/s')),
        ...this.directionRows(doc, em, sp, E),
        this.row('活跃时长', this.num(() => sp.duration, (v) => E('改活跃时长', () => { if (v == null) delete sp.duration; else sp.duration = v; }), '秒', { title: '不写 = 一直发' })),
      ];
    }));

    // ---------------- 运动
    container.appendChild(this.section('motion', '运动', () => {
      const mo = em.motion;
      if (!mo) return [...this.followAnchorRows(em, E), h('div', { class: 'btns' }, h('button', { onclick: () => E('加运动模块', () => { ensure('motion', {}); }) }, '+ 加运动模块'))];
      const t = mo.turbulence || null;
      return [
        this.row('重力', this.num(() => mo.gravity, (v) => E('改重力', () => { if (v == null) delete mo.gravity; else mo.gravity = v; }), 'wu/s²', { title: '正值向下；水滴 865（= 9.8 m/s²）' })),
        this.row('阻力', this.num(() => mo.drag, (v) => E('改阻力', () => { if (v == null) delete mo.drag; else mo.drag = v; }), '1/s')),
        this.row('浮力', this.num(() => mo.buoyancy, (v) => E('改浮力', () => { if (v == null) delete mo.buoyancy; else mo.buoyancy = v; }), 'wu/s²')),
        this.row('恒定风', this.vec3(() => mo.wind || [0, 0, 0], (v) => E('改风', () => { mo.wind = v; }), 'wu/s²')),
        this.row('湍流强度', this.num(() => t && t.strength, (v) => E('改湍流', () => {
          if (v == null) { delete mo.turbulence; return; }
          mo.turbulence = Object.assign({ scale: 60 }, mo.turbulence, { strength: v });
        }), 'wu/s²')),
        t ? this.row('湍流尺度', this.num(() => t.scale, (v) => E('改湍流尺度', () => { t.scale = v == null ? 60 : Math.max(0.001, v); }), 'wu')) : null,
        t ? this.row('湍流速率', this.num(() => t.speed, (v) => E('改湍流速率', () => { if (v == null) delete t.speed; else t.speed = v; }), '1/s')) : null,
        this.row('速度上限', this.num(() => mo.maxSpeed, (v) => E('改速度上限', () => { if (v == null) delete mo.maxSpeed; else mo.maxSpeed = v; }), 'wu/s')),
        h('div', { 'data-role': 'stimulus-controls' }, ...this.stimulusRows(em, mo, E)),
        ...this.followAnchorRows(em, E),
        h('div', { class: 'btns' }, h('button', { class: 'danger', onclick: () => E('删运动模块', () => { delete em.motion; }) }, '删运动模块')),
      ];
    }));

    // ---------------- 寿命
    container.appendChild(this.section('life', '寿命', () => {
      const li = em.life;
      if (!li) return [h('div', { class: 'pad dim' }, '没有寿命模块 = 永生（群体）'),
        h('div', { class: 'btns' }, h('button', { onclick: () => E('加寿命模块', () => { ensure('life', { seconds: [1, 2] }); }) }, '+ 加寿命模块'))];
      return [
        this.row('寿命', this.pair(() => li.seconds || [1, 2], (v) => E('改寿命', () => { li.seconds = v; }), '秒')),
        ...this.maxDistanceRows(em, li, E),
        h('div', { class: 'btns' }, h('button', { class: 'danger', onclick: () => E('删寿命模块', () => { delete em.life; }) }, '删寿命模块（永生）')),
      ];
    }));

    // ---------------- 碰撞
    container.appendChild(this.section('collision', '碰撞', () => {
      const co = em.collision;
      if (!co) return [h('div', { class: 'btns' }, h('button', { onclick: () => E('加碰撞模块', () => { ensure('collision', { radiusWu: 2 }); }) }, '+ 加碰撞模块'))];
      const others = (doc.emitters || []).map((x) => x.id).filter((x) => x !== em.id);
      const oh = co.onHit || null;
      return [
        this.row('撞行走面', this.sel(() => co.ground, (v) => E('改撞地响应', () => { if (v) co.ground = v; else delete co.ground; }), ['none', 'kill', 'bounce', 'stick', 'slide'], true)),
        this.row('撞深度壳', this.sel(() => co.shell, (v) => E('改撞壳响应', () => { if (v) co.shell = v; else delete co.shell; }), ['none', 'kill', 'bounce', 'stick', 'slide'], true)),
        this.row('弹性', this.num(() => co.restitution, (v) => E('改弹性', () => { if (v == null) delete co.restitution; else co.restitution = clamp(v, 0, 1); }), '0–1')),
        this.row('摩擦', this.num(() => co.friction, (v) => E('改摩擦', () => { if (v == null) delete co.friction; else co.friction = clamp(v, 0, 1); }), '0–1')),
        this.row('碰撞半径', this.num(() => co.radiusWu, (v) => E('改碰撞半径', () => { if (v == null) delete co.radiusWu; else co.radiusWu = Math.max(0, v); }), 'wu')),
        this.row('撞击子发射', this.sel(() => oh && oh.emitter, (v) => E('改撞击子发射', () => {
          if (!v) { delete co.onHit; return; }
          co.onHit = { emitter: v, count: oh ? oh.count : 5 };
        }), others, true)),
        oh ? this.row('每次发', this.num(() => oh.count, (v) => E('改子发射数', () => { oh.count = Math.max(1, Math.round(v == null ? 1 : v)); }), '个', { int: true })) : null,
        others.length ? null : h('div', { class: 'pad dim' }, '只有一个发射器：撞击子发射要先加第二个（勾上"只由 onHit 触发"）'),
        h('div', { class: 'btns' }, h('button', { class: 'danger', onclick: () => E('删碰撞模块', () => { delete em.collision; }) }, '删碰撞模块')),
      ];
    }));

    // ---------------- 群体行为（重块，默认折叠）
    container.appendChild(this.section('behavior', '群体行为', () => {
      const be = em.behavior;
      if (em.subOnly) return [h('div', { class: 'pad dim' }, '子发射器不能有群体行为（状态机永远推不动它）')];
      if (!be) return [h('div', { class: 'btns' }, h('button', {
        onclick: () => E('加群体模块', () => {
          em.behavior = {
            cruise: 400, max: 700, maxAccel: 2600, minAltitude: 60, senseRadius: 120, separation: 30,
            accel: { separation: 2000, alignment: 800, cohesion: 600 },
            orbit: { radius: 180, height: 170, handedness: 'mixed' },
            home: { nestRadius: 45, rangeRadius: 900, startleRadius: 260 },
            attitude: { fear: { 'player:motion': 0.35 }, reactionDelay: [0.05, 0.25], fearDecay: 0.6, fleeThreshold: 0.35, calmSeconds: 6 },
            initialState: 'roosting',
          };
          activate('flock');
        }),
      }, '+ 加群体模块（这一群会互相看见）'))];
      const at = be.attitude, ac = be.accel, ob = be.orbit, hm = be.home;
      const fearRows = [];
      const weights = (tbl, label2) => {
        for (const k of Object.keys(tbl || {})) {
          fearRows.push(h('div', { class: 'row' },
            h('span', { class: 'tag' }, `${label2}·${k}`),
            this.num(() => tbl[k], (v) => E('改刺激权重', () => { if (v == null) delete tbl[k]; else tbl[k] = v; }), '', { step: 0.05 }),
            h('button', { class: 'danger', onclick: () => E('删刺激权重', () => { delete tbl[k]; }) }, '×')));
        }
      };
      weights(at.fear, '怕');
      weights(at.attract, '引');
      const addTag = h('input', { type: 'text', placeholder: 'item:bug / light / sfx:footstep / 自定标签' });
      return [
        this.row('巡航速度', this.num(() => be.cruise, (v) => E('改巡航速度', () => { be.cruise = v == null ? 0 : v; }), 'wu/s')),
        this.row('最大速度', this.num(() => be.max, (v) => E('改最大速度', () => { be.max = v == null ? 0 : v; }), 'wu/s')),
        this.row('最大加速', this.num(() => be.maxAccel, (v) => E('改最大加速', () => { be.maxAccel = v == null ? 0 : v; }), 'wu/s²')),
        this.row('最低高度', this.num(() => be.minAltitude, (v) => E('改最低高度', () => { be.minAltitude = v == null ? 0 : v; }), 'wu')),
        this.row('感知半径', this.num(() => be.senseRadius, (v) => E('改感知半径', () => { be.senseRadius = v == null ? 0 : v; }), 'wu')),
        this.row('期望间距', this.num(() => be.separation, (v) => E('改期望间距', () => { be.separation = v == null ? 0 : v; }), 'wu')),
        this.row('分离加速', this.num(() => ac.separation, (v) => E('改分离加速', () => { ac.separation = v == null ? 0 : v; }), 'wu/s²')),
        this.row('对齐加速', this.num(() => ac.alignment, (v) => E('改对齐加速', () => { ac.alignment = v == null ? 0 : v; }), 'wu/s²')),
        this.row('聚合加速', this.num(() => ac.cohesion, (v) => E('改聚合加速', () => { ac.cohesion = v == null ? 0 : v; }), 'wu/s²')),
        this.row('轨道半径', this.num(() => ob.radius, (v) => E('改轨道半径', () => { ob.radius = v == null ? 0 : v; }), 'wu')),
        this.row('轨道高度', this.num(() => ob.height, (v) => E('改轨道高度', () => { ob.height = v == null ? 0 : v; }), 'wu')),
        this.row('转向', this.sel(() => ob.handedness, (v) => E('改轨道转向', () => { if (v) ob.handedness = v; else delete ob.handedness; }), ['cw', 'ccw', 'mixed'], true)),
        this.row('巢半径', this.num(() => hm.nestRadius, (v) => E('改巢半径', () => { hm.nestRadius = v == null ? 0 : Math.max(0, v); }), 'wu', { title: '3D 里那个最小的线框球，可以用缩放 gizmo 直接拉' })),
        this.row('活动域', this.num(() => hm.rangeRadius, (v) => E('改活动域半径', () => { hm.rangeRadius = v == null ? 0 : Math.max(0, v); }), 'wu')),
        this.row('惊起半径', this.num(() => hm.startleRadius, (v) => E('改惊起半径', () => { hm.startleRadius = v == null ? 0 : Math.max(0, v); }), 'wu')),
        this.row('反应延迟', this.pair(() => at.reactionDelay || [0, 0], (v) => E('改反应延迟', () => { at.reactionDelay = v; }), '秒')),
        this.row('恐惧衰减', this.num(() => at.fearDecay, (v) => E('改恐惧衰减', () => { if (v == null) delete at.fearDecay; else at.fearDecay = v; }), '/秒')),
        this.row('惊飞阈值', this.num(() => at.fleeThreshold, (v) => E('改惊飞阈值', () => { if (v == null) delete at.fleeThreshold; else at.fleeThreshold = v; }), '')),
        this.row('安静回巢', this.num(() => at.calmSeconds, (v) => E('改回巢时长', () => { if (v == null) delete at.calmSeconds; else at.calmSeconds = v; }), '秒')),
        this.row('开播状态', this.sel(() => be.initialState, (v) => E('改开播状态', () => { if (v) be.initialState = v; else delete be.initialState; }), ['roosting', 'airborne', 'fleeing', 'returning'], true)),
        this.row('近身侵扰半径', this.num(() => be.harassment && be.harassment.radius, (v) => E('改近身侵扰', () => {
          if (v == null) { delete be.harassment; return; }
          be.harassment = Object.assign({ height: 90, attackPerSecond: 5 }, be.harassment, { radius: v });
        }), 'wu', { title: '留空关闭。个体实际飞进玩家身边才扣阳气；整群按秒结算，不乘粒子数量；惊飞/回巢时不扣。' })),
        be.harassment ? this.row('侵扰中心离脚点', this.num(() => be.harassment.height, (v) => E('改侵扰高度', () => { be.harassment.height = v == null ? 0 : v; }), 'wu')) : null,
        be.harassment ? this.row('侵扰每秒扣阳气', this.num(() => be.harassment.attackPerSecond, (v) => E('改侵扰伤害', () => { be.harassment.attackPerSecond = v == null ? 0 : v; }), '/秒')) : null,
        this.row('扑翼巡航', this.num(() => be.wingFlap && be.wingFlap.atCruise, (v) => E('改扑翼频率', () => {
          if (v == null) { delete be.wingFlap; return; }
          be.wingFlap = Object.assign({ atMax: v * 1.6 }, be.wingFlap, { atCruise: v });
        }), 'Hz')),
        be.wingFlap ? this.row('扑翼最快', this.num(() => be.wingFlap.atMax, (v) => E('改扑翼最快', () => { be.wingFlap.atMax = v == null ? 0 : v; }), 'Hz')) : null,
        this.row('个性抖动', this.num(() => be.speedJitter, (v) => E('改个性抖动', () => { if (v == null) delete be.speedJitter; else be.speedJitter = v; }), '±比例')),
        this.row('游走扰动', this.num(() => be.wander, (v) => E('改游走扰动', () => { if (v == null) delete be.wander; else be.wander = v; }), 'wu/s²')),
        this.row('惊起脉冲', this.num(() => be.startlePulse && be.startlePulse.radius, (v) => E('改惊起脉冲', () => {
          if (v == null) { delete be.startlePulse; return; }
          be.startlePulse = Object.assign({ strength: 1, duration: 0.5 }, be.startlePulse, { radius: v });
        }), 'wu', { title: '首次惊起时自动发一个 startle 标签的恐惧脉冲' })),
        h('h4', {}, '刺激权重（标签 → 权重）'),
        ...fearRows,
        h('div', { class: 'row' }, addTag,
          h('button', { onclick: () => { const t2 = addTag.value.trim(); if (t2) E('加恐惧标签', () => { at.fear = at.fear || {}; at.fear[t2] = 0.5; }); } }, '+ 怕'),
          h('button', { onclick: () => { const t2 = addTag.value.trim(); if (t2) E('加吸引标签', () => { at.attract = at.attract || {}; at.attract[t2] = 0.5; }); } }, '+ 引')),
        h('div', { class: 'btns' }, h('button', { class: 'danger', onclick: () => E('删群体模块', () => { delete em.behavior; activate('particle'); }) }, '删群体模块')),
      ];
    }));

    // ---------------- 薄片（纸钱 / 落叶）
    container.appendChild(this.section('plate', '薄片（纸钱）', () => {
      const pl = em.plate;
      if (host.programApi?.resolveEmitterProgram(em).solver === 'flock' && !pl) return [h('div', { class: 'pad dim' }, '先将运动模型切换为普通粒子，再添加薄片参数')];
      if (!pl) return [h('div', { class: 'pad dim' }, '挂上它，每颗粒子就是一张有朝向、会弯的薄片：吃场景风、躺地贴物、能被吹走'),
        h('div', { class: 'btns' }, h('button', { onclick: () => E('加薄片模块', () => { ensure('plate', { size: [16, 16], terminalSpeed: 90 }); activate('plate'); }) }, '+ 加薄片模块'))];
      const sub = (key) => pl[key] || (pl[key] = {});
      const numIn = (label, key, field, unit, title, lo, hi) => this.row(label, this.num(
        () => (pl[key] || {})[field],
        (v) => E(`改${label}`, () => { const o = sub(key); if (v == null) delete o[field]; else o[field] = clamp(v, lo, hi); if (!Object.keys(o).length) delete pl[key]; }),
        unit, { title }));
      return [
        this.row('尺寸', this.pair(() => pl.size || [16, 16], (v) => E('改薄片尺寸', () => { pl.size = [Math.max(0.5, v[0]), Math.max(0.5, v[1])]; }), 'wu（真实）')),
        this.row('终端速度', this.num(() => pl.terminalSpeed, (v) => E('改终端速度', () => { pl.terminalSpeed = Math.max(5, v == null ? 90 : v); }), 'wu/s', { title: '平着自由下落的终端速度；薄纸 ≈ 90（≈ 1 m/s）' })),
        this.row('切向阻力比', this.num(() => pl.edgeDrag, (v) => E('改切向阻力比', () => { if (v == null) delete pl.edgeDrag; else pl.edgeDrag = clamp(v, 0, 1); }), '0–1')),
        this.row('压心偏移', this.num(() => pl.pressureOffset, (v) => E('改压心偏移', () => { if (v == null) delete pl.pressureOffset; else pl.pressureOffset = clamp(v, 0, 0.25); }), '弦长比例', { title: '翻转力矩的来源：越大越爱翻' })),
        numIn('静摩擦', 'friction', 'static', 'μ', '', 0, 5),
        numIn('动摩擦', 'friction', 'kinetic', 'μ', '', 0, 5),
        numIn('贴死比例', 'adhere', 'pinned', '0–1', '出生就贴死的比例（湿了 / 被石子压住）：吹不走，但边角照样被风掀', 0, 1),
        numIn('物件上贴死', 'adhere', 'onObjects', '0–1', '生在石头 / 树 / 灌丛表面的那批挂住的概率', 0, 1),
        numIn('附着力上限', 'adhere', 'hold', 'wu/s²', '其余纸片逐张在 0..它 之间抽', 0, 1e6),
        numIn('弯曲刚度', 'bend', 'stiffness', 'wu/s²', '弯到边缘翘起半个宽度所需的法向气动加速度', 1, 1e7),
        numIn('弯曲频率', 'bend', 'freq', 'Hz', '', 0.1, 60),
        numIn('弯曲上限', 'bend', 'max', '', '', 0, 1.5),
        numIn('静卷曲', 'bend', 'rest', '', '躺着时自带的卷曲（逐张在 ±它 里抽）', 0, 1),
        this.row('渲染段数', this.num(() => pl.segments, (v) => E('改渲染段数', () => { if (v == null) delete pl.segments; else pl.segments = Math.max(1, Math.min(16, Math.round(v))); }), '段', { int: true })),
        h('h4', {}, '可燃'),
        ...this.burnableRows(pl, E),
        h('div', { class: 'pad dim' }, '受力来源见「模拟与外部影响」；铺撒区域取活动布置的发射区域；本地预览与游戏共用模拟，片的朝向与弯曲在游戏里看'),
        h('div', { class: 'btns' }, h('button', { class: 'danger', onclick: () => E('删薄片模块', () => { delete em.plate; activate('particle'); }) }, '删薄片模块')),
      ];
    }));

    // ---------------- 声音
    container.appendChild(this.section('sound', '声音', () => {
      const so = em.sound;
      if (!so) return [h('div', { class: 'btns' }, h('button', { onclick: () => E('加声音模块', () => { ensure('sound', {}); }) }, '+ 加声音模块'))];
      const ids = (host.sfx || []).map((s) => ({ value: s.id, label: s.label ? `${s.id} · ${s.label}` : s.id }));
      return [
        this.row('循环环境声', this.sel(() => so.loop, (v) => E('改循环声', () => { if (v) so.loop = v; else delete so.loop; }), ids, true)),
        this.row('起播 / 惊起', this.sel(() => so.start, (v) => E('改起播声', () => { if (v) so.start = v; else delete so.start; }), ids, true)),
        this.row('撞击', this.sel(() => so.hit, (v) => E('改撞击声', () => { if (v) so.hit = v; else delete so.hit; }), ids, true)),
        h('div', { class: 'pad dim' }, '声音在游戏里才响（工作台不播）：本地预览只把 sound 事件计数写在状态栏'),
        h('div', { class: 'btns' }, h('button', { class: 'danger', onclick: () => E('删声音模块', () => { delete em.sound; }) }, '删声音模块')),
      ];
    }));
  },

  effectSection(host, doc) {
    const E = (label, fn) => host.edit(label, fn);
    return this.section('effect', '效果', () => {
      const au = doc.authoring || null;
      // 预览锚点只在它的作者场景里算数（与 app.js `sceneAnchor` 同一条判据）：记在别的场景的那份不当成这里的值显示，
      // 否则画面点 / 离面高 / 落在 摆着别的场景的数，预览却在出生点跑；改一下离面高，那份锚点被静默换成出生点
      const here = !!(au && au.anchor && host.authoringAnchorHere(au));
      const a = here ? au.anchor : null;
      const foreign = au && au.anchor && !here ? String(au.sceneId || '') : '';
      const sp = foreign ? host.sceneAnchor() : null;
      const foreignTxt = foreign ? `预览锚点记在「${foreign}」；这里用出生点（${fmt(sp.x)} , ${fmt(sp.y)}）——按 A 在这里点一下放一个，或点顶栏「记为作者场景」从出生点起一个` : '';
      const at = host.attach;
      const ap = host.activePlacement();
      if (ap && !at) {
        // 有活动布置：场景锚点就是布置的 anchor（运行时读的就是它），在「布置」一节改；效果里的预览锚点这时不参与
        return [
          this.row('id', h('span', { class: 'mono' }, doc.id)),
          this.row('标签', this.txt(() => doc.label, (v) => E('改标签', () => { if (v) doc.label = v; else delete doc.label; }), '崖墓蝙蝠群')),
          this.row('备注', this.txt(() => au && au.note, (v) => E('改备注', () => { const o = host.ensureAuthoring(); if (v) o.note = v; else delete o.note; }), '给自己看的')),
          h('h4', {}, '预览锚点'),
          this.row('锚在', this.sel(() => 'surface', (v) => host.setAttachMode(v === 'socket'),
            [{ value: 'surface', label: '场景面（行走面 / 深度壳）' }, { value: 'socket', label: '角色挂点（手持：火把 / 灯笼）' }])),
          h('div', { class: 'pad dim' }, `锚点跟着活动布置「${ap.id}」走（运行时读的就是它），在下面「布置」一节改；效果自己的预览锚点只在本份没布置它时用`),
          h('div', { class: 'pad dim' }, '发射器一览：' + (doc.emitters || []).map((x) => x.id).join(' / ')),
          (doc.beams || []).length ? h('div', { class: 'pad dim' }, '光柱一览：' + doc.beams.map((x) => x.id).join(' / ')) : null,
        ];
      }
      return [
        this.row('id', h('span', { class: 'mono' }, doc.id)),
        this.row('标签', this.txt(() => doc.label, (v) => E('改标签', () => { if (v) doc.label = v; else delete doc.label; }), '崖墓蝙蝠群')),
        this.row('备注', this.txt(() => au && au.note, (v) => E('改备注', () => { const o = host.ensureAuthoring(); if (v) o.note = v; else delete o.note; }), '给自己看的')),
        h('h4', {}, '预览锚点（只给工作台重开现场，运行时忽略）'),
        this.row('锚在', this.sel(() => (at ? 'socket' : 'surface'), (v) => host.setAttachMode(v === 'socket'),
          [{ value: 'surface', label: '场景面（行走面 / 深度壳）' }, { value: 'socket', label: '角色挂点（手持：火把 / 灯笼）' }])),
        // ---- 角色挂点那一档：两个量与运行时挂点同口径（画面横向偏移 + 离脚点高度）
        at ? this.row('挂点高', this.num(() => at.heightWu, (v) => E('改挂点高', () => { const o = host.ensureAttach(); o.heightWu = Math.max(0, v == null ? 110 : v); }), 'wu',
          { title: '离脚点的高度：角色高 150 wu，火把火头大约 100–120 wu' })) : null,
        at ? this.row('左右偏移', this.num(() => (at.offsetX == null ? 0 : at.offsetX), (v) => E('改挂点左右偏移', () => {
          const o = host.ensureAttach();
          if (!v) delete o.offsetX; else o.offsetX = v;
        }), 'wu（画面横向）', { title: '手伸在身侧 / 身前：与运行时挂点的画面横向偏移（contact.x + pose.x）同口径' })) : null,
        at ? h('div', { class: 'row' }, h('span', {}, ''), this.chk(() => host.walk.on, (v) => host.setWalk(v),
          '让角色来回走（看锚点在动、已发射的粒子按「跟着发射点走」留下或跟上）')) : null,
        at && !host.player.on ? h('div', { class: 'pad warn' }, '场上还没有角色：按 M 点一下地面放一个（挂点跟着它走；没有角色时锚点暂时落在场景面上）') : null,
        at ? h('div', { class: 'pad dim' }, '运行时就是这条：挂件预设的 vfx 由 HeldPropSystem 每帧把锚点挪到挂点上（moveAnchor），已发射的粒子按各发射器「跟着发射点走」（运动一节；缺省留在原地）——本地预览跑的是同一份函数（不带动画位移，「跟动作、不跟走」在这里等于不跟）。A 工具点一下 = 把火头摆到那里')
          : null,
        // ---- 场景面那一档
        at ? h('div', { class: 'pad dim' }, `场景锚点（切回「场景面」才用）：${a ? `${fmt(a.x)} , ${fmt(a.y)}` : foreign ? `记在「${foreign}」（这里用出生点）` : '还没有'}`) : null,
        !at && a ? this.row('画面点', h('span', { class: 'mono' }, `${fmt(a.x)} , ${fmt(a.y)}`)) : null,
        !at && !a && foreign ? h('div', { class: 'pad dim', 'data-role': 'foreignAnchor' }, foreignTxt) : null,
        !at && !a && !foreign ? h('div', { class: 'pad dim' }, '还没有锚点：按 A 在场景表面上点一下') : null,
        !at && a ? this.row('离面高', this.num(() => a.h == null ? 0 : a.h, (v) => E('改锚点高度', () => { const o = host.ensureAnchor(); o.h = v == null ? 0 : Math.max(0, v); }), 'wu')) : null,
        !at && a ? this.row('落在', this.sel(() => a.surface || 'ground', (v) => E('改锚点表面', () => { const o = host.ensureAnchor(); if (v === 'shell') o.surface = 'shell'; else delete o.surface; host.reanchor(); }), [{ value: 'ground', label: '行走面' }, { value: 'shell', label: '深度壳（崖壁 / 桌面）' }])) : null,
        h('div', { class: 'pad dim' }, '发射器一览：' + (doc.emitters || []).map((x) => x.id).join(' / ')),
        (doc.beams || []).length ? h('div', { class: 'pad dim' }, '光柱一览：' + doc.beams.map((x) => x.id).join(' / ')) : null,
      ];
    });
  },

  /**
   * 「布置」一节 = 活动布置（本份里当前效果被选中的那条）。语义照主编辑器场景页那一栏（已搬过来）：
   * 删范围区域 = 退回用发射区域（限定照开）；两块都没了 confine 一起删；去掉「限定」勾 = confine（含拉好的
   * 范围区域）收进本次会话的 stash，再勾上原样回来。conditions 只读（原样保留）。
   * **渲染只读**：每个写入都经 `host.editPlacement(id, …)` 在写入时按 id 现找那一行。
   */
  placementSection(host, doc) {
    const ap = host.activePlacement();
    return this.section('placement', ap ? `布置 · ${ap.id}` : '布置', () => {
      if (!host.scene) return [h('div', { class: 'pad dim' }, '还没装场景')];
      const where = `${host.scene.name || host.scene.id} · ${host.phaseLabel(host.scene.id, host.phase)}`;
      if (!ap) {
        return [
          h('div', { class: 'pad dim' }, `「${where}」没有布置「${doc.id}」：本地预览用效果里的预览锚点、没有区域（游戏里这一份不会出现它——没配就没有，不继承别的时段）`),
          h('div', { class: 'btns' }, h('button', { class: 'primary', disabled: !!host.libErr, onclick: () => host.placeHere() }, '把当前效果布置到这里')),
        ];
      }
      const id = ap.id;
      // 写入时读**行对象此刻的 id**（`ap` 就是库里那一行，改名是原地改它的 id），不拿渲染那一刻的 id：
      // 在 id 框里改了名没回车、直接去点「自动开」下拉，改名提交了但检视器还没重建（列表开着时不许重建），
      // 下拉选中走的还是这批闭包——拿旧 id 找行一个都找不到，选了等于没选、状态栏也不说
      const E = (label, fn) => host.editPlacement(ap.id, label, fn);
      const a = ap.anchor || {};
      const emit = host.areaPoly(ap, 'emit'), rng = host.areaPoly(ap, 'range');
      const conf = ap.confine && typeof ap.confine === 'object' ? ap.confine : null;
      const stash = host.confineStash[host.stashKey(id)];
      const stashArea = stash && Array.isArray(stash.area) && stash.area.length >= 3;
      const rangeTxt = rng ? `范围区域 ${rng.length} 个顶点` : conf && emit ? '范围区域 = 发射区域'
        : !conf && stashArea ? '范围区域已收起（勾上「限定」恢复）' : '不限定';
      const hash = host.hashSeedOf(id);
      const nCond = Array.isArray(ap.conditions) ? ap.conditions.length : 0;
      return [
        h('div', { class: 'pad dim' }, `${where}（运行时就按这一条建实例）`),
        this.row('id', this.txt(() => ap.id, (v) => { if (v && v !== ap.id) host.renamePlacement(ap.id, v); }, 'vfx_…')),
        this.row('效果', h('span', { class: 'mono' }, ap.effect)),
        h('h4', {}, '锚点（画面点 + 离表面高）'),
        this.row('x', this.num(() => a.x, (v) => { if (v != null) E('改布置锚点', (r) => { r.anchor.x = round2(v); }); }, 'wu')),
        this.row('y', this.num(() => a.y, (v) => { if (v != null) E('改布置锚点', (r) => { r.anchor.y = round2(v); }); }, 'wu')),
        this.row('离面高', this.num(() => a.h, (v) => E('改布置锚点高度', (r) => { if (v == null) delete r.anchor.h; else r.anchor.h = Math.max(0, v); }), 'wu', { placeholder: '0' })),
        this.row('落在', this.sel(() => a.surface || 'ground', (v) => E('改布置锚点表面', (r) => { if (v === 'shell') r.anchor.surface = 'shell'; else delete r.anchor.surface; }),
          [{ value: 'ground', label: '行走面' }, { value: 'shell', label: '深度壳（崖壁 / 桌面）' }])),
        h('h4', {}, '实例'),
        this.row('种子', this.num(() => ap.seed, (v) => E('改布置种子', (r) => { if (v == null) delete r.seed; else r.seed = Math.round(v); }), '空 = 按 id 哈希',
          { int: true, placeholder: hash == null ? '' : String(hash), title: `空 = 按实例 id 哈希（与游戏 VfxSystem 同一个 hashSeed${hash == null ? '' : `，现在是 ${hash}`}）` })),
        this.row('数量倍率', this.num(() => ap.countScale, (v) => E('改数量倍率', (r) => { if (v == null) delete r.countScale; else r.countScale = Math.max(0.01, v); }), '×',
          { placeholder: '1', title: '乘每个发射器的 max / burst / rate' })),
        this.row('自动开', this.sel(() => (ap.autoStart == null ? null : String(ap.autoStart)), (v) => E('改自动开', (r) => { if (v == null) delete r.autoStart; else r.autoStart = v === 'true'; }),
          [{ value: 'true', label: '进场就放' }, { value: 'false', label: '等 playVfx 才放' }], true)),
        h('div', { class: 'pad dim' }, nCond ? `条件 ${nCond} 条（原样保留）` : '没有条件（一直在场）'),
        h('h4', {}, '粒子区域'),
        h('div', { class: 'pad', 'data-role': 'areaInfo' }, `${emit ? `发射区域 ${emit.length} 个顶点` : '没有发射区域：纸钱铺撒退成锚点周围的圆盘'}　·　${rangeTxt}`),
        h('div', { class: 'btns' },
          h('button', { class: 'areaBtn', title: '按住拖一个框 = 发射区域（青色虚线）', onclick: () => host.setTool('areaEmit') }, emit ? '重拉发射区域' : '拉发射区域'),
          h('button', { class: 'areaBtn', title: '按住拖一个框 = 范围区域（黄色实线，打开限定）', onclick: () => host.setTool('areaRange') }, rng ? '重拉范围区域' : '拉范围区域')),
        h('div', { class: 'btns' },
          h('button', { class: 'danger', disabled: !emit, onclick: () => host.clearArea('emit') }, '清除发射区域'),
          h('button', { class: 'danger', disabled: !rng, onclick: () => host.clearArea('range'), title: '退回用发射区域（限定照开）' }, '清除范围区域')),
        h('div', { class: 'row' }, h('span', {}, ''), this.chk(() => !!conf, (v) => host.setConfine(v), '粒子限定在区域里',
          { role: 'confine', disabled: !(emit || conf || stashArea), title: '去勾时范围区域先收着，本次会话里再勾上原样回来' })),
        this.row('边带宽', this.num(() => (conf ? conf.feather : null), (v) => E('改边带宽', (r) => { if (!r.confine) return; if (v == null) delete r.confine.feather; else r.confine.feather = Math.max(0, v); }), 'wu',
          { placeholder: '120', disabled: !conf, title: '从框线往里这么宽的一带里风变弱、纸变稀（缺省 120）' })),
        this.row('限高', this.num(() => (conf ? conf.ceiling : null), (v) => E('改限高', (r) => { if (!r.confine) return; if (v != null && v > 0) r.confine.ceiling = v; else delete r.confine.ceiling; }), 'wu',
          { placeholder: '不限', disabled: !conf, title: '离地真实高度上限；空 = 不限' })),
      ];
    });
  },

  /**
   * 「表面材质区」一节：本场景的水面 / 湿地（布置库 `scenes[场景].surfaces`，**所有时段共用**，不跟着效果走）。
   * 落雷与所有标了反光的灯在这里照出倒影 / 高光；落在水面的雷改放水面电弧与水花（发射器 onSurface）。
   * 渲染只读：每个写入都经 host 在写入时按下标现找那一块。
   */
  surfaceSection(host) {
    const rs = host.scene ? host.sceneSurfaces() : [];
    return this.section('surfaces', rs.length ? `表面材质区 · ${rs.length} 块` : '表面材质区', () => {
      if (!host.scene) return [h('div', { class: 'pad dim' }, '还没装场景')];
      const D = host.surfaceDefaults, L = host.surfaceLabel;
      const G = D.ground, ds = host.defaultSurface;
      const out = [
        h('h4', { 'data-role': 'surfDefault' }, '没画区域的地方（全局：所有场景一份）'),
        h('div', { class: 'pad dim' }, '雷是任意地方随机落的：没画区域的地方一律按这里的材质照出反光。细节起伏 = 地面上把高光打碎的细小起伏（程序化，不对应原画）；水面雨纹 = 所有水面上雨点打出的涟漪。'),
        this.row('反光', this.num(() => ds.reflect, (v) => host.setDefaultSurfaceField('reflect', v == null ? null : Math.max(0, Math.min(1, v)), '反光'), '0..1',
          { placeholder: String(G.reflect), title: `整片地面照出多少反光（0..1；空 = 缺省 ${G.reflect}）` })),
        this.row('粗糙度', this.num(() => ds.roughness, (v) => host.setDefaultSurfaceField('roughness', v == null ? null : Math.max(0, Math.min(1, v)), '粗糙度'), '0..1',
          { placeholder: String(G.roughness), title: `越小越像湿透、高光越集中；越大越干、越散（空 = 缺省 ${G.roughness}）` })),
        this.row('细节起伏', this.num(() => ds.detail, (v) => host.setDefaultSurfaceField('detail', v == null ? null : Math.max(0, Math.min(2, v)), '细节起伏'), '0..2',
          { placeholder: String(G.detail), title: `地面与湿地上把高光打碎的细小起伏有多强（0 = 光滑一片；空 = 缺省 ${G.detail}）` })),
        this.row('水面雨纹', this.num(() => ds.ripple, (v) => host.setDefaultSurfaceField('ripple', v == null ? null : Math.max(0, Math.min(2, v)), '水面雨纹'), '0..2',
          { placeholder: String(G.ripple), title: `所有水面上雨点涟漪与细浪有多强（0 = 平静如镜；空 = 缺省 ${G.ripple}）` })),
        h('h4', {}, '本场景的表面材质区'),
        h('div', { class: 'pad dim' }, `「${host.scene.name || host.scene.id}」里材质真正不一样的地方（水面、石板地；整个场景所有时段共用）：水面上的雷改放水花与水面电弧。后画的盖在先画的上面——水面里画一块湿地 = 挖出一块露出来的滩。`),
        h('div', { class: 'row' }, h('span', {}, ''), this.chk(() => host.surfEdit, (v) => host.setSurfEdit(v), '在画面上显示并编辑', { role: 'surfEdit', title: '关着时画面上不画、不能拖（不影响游戏）' })),
        h('div', { class: 'btns' },
          h('button', { class: 'areaBtn', 'data-role': 'surfWater', disabled: !!host.libErr, title: '按住拖一个框 = 新的一块水面（蓝）', onclick: () => host.setTool('areaWater') }, '拉一块水面'),
          h('button', { class: 'areaBtn', 'data-role': 'surfWet', disabled: !!host.libErr, title: '按住拖一个框 = 新的一块湿地（青绿）', onclick: () => host.setTool('areaWet') }, '拉一块湿地')),
      ];
      if (!rs.length) out.push(h('div', { class: 'pad dim' }, '这个场景没有表面材质区：整张图都按上面的缺省材质反光，落点一律按地面放碎石扬尘'));
      rs.forEach((r, ri) => {
        if (!r || typeof r !== 'object') return;
        const kind = r.kind === 'wet' ? 'wet' : 'water';
        const d = D[kind];
        const n = Array.isArray(r.polygon) ? r.polygon.length : 0;
        out.push(h('h4', { 'data-role': 'surfRow' }, `${L[kind]} · ${r.id}（${n} 个顶点）`));
        out.push(this.row('id', this.txt(() => r.id, (v) => host.renameSurface(ri, v), 'water_1')));
        out.push(this.row('种类', this.sel(() => kind, (v) => host.setSurfaceField(ri, 'kind', v === 'wet' ? 'wet' : 'water', '种类'),
          [{ value: 'water', label: '水面（倒影 + 雨点细波纹；雷落上去放水花）' }, { value: 'wet', label: '湿地（湿亮一片；雷落上去照常放碎石）' }])));
        out.push(this.row('反光', this.num(() => r.reflect, (v) => host.setSurfaceField(ri, 'reflect', v == null ? null : Math.max(0, Math.min(1, v)), '反光'), '0..1',
          { placeholder: String(d.reflect), title: `照出多少倒影 / 高光（0..1；空 = 缺省 ${d.reflect}）` })));
        out.push(this.row('粗糙度', this.num(() => r.roughness, (v) => host.setSurfaceField(ri, 'roughness', v == null ? null : Math.max(0, Math.min(1, v)), '粗糙度'), '0..1',
          { placeholder: String(d.roughness), title: `越小倒影越清、越大越糊成一片（0..1；空 = 缺省 ${d.roughness}）` })));
        out.push(this.row('边缘羽化', this.num(() => r.feather, (v) => host.setSurfaceField(ri, 'feather', v == null ? null : Math.max(0, v), '边缘羽化'), 'wu',
          { placeholder: String(D.feather), title: `边缘这么宽的一带慢慢淡出（空 = 缺省 ${D.feather} wu）` })));
        out.push(h('div', { class: 'btns' },
          h('button', { title: '选中它的第一个顶点（画面上显示出来）', onclick: () => host.selectSurface(ri) }, '选中'),
          h('button', { class: 'danger', 'data-role': 'surfDelete', onclick: () => host.deleteSurface(ri) }, '删掉这块')));
      });
      return out;
    });
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { Inspector };
