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

const INS_OPEN = { effect: true, appearance: true, spawn: true, motion: true, life: true, collision: false, behavior: false, sound: false };

const Inspector = {
  /** 折叠状态（UI 态，不进历史） */
  open: Object.assign({}, INS_OPEN),

  section(key, title, body, extra) {
    const on = this.open[key] !== false;
    const head = h('div', { class: 'secHead', onclick: () => { this.open[key] = !on; this.rerender(); } },
      h('span', { class: 'caret' }, on ? '▾' : '▸'), h('b', {}, title), extra || null);
    const wrap = h('div', { class: 'sec' }, head);
    if (on) for (const el2 of body()) if (el2) wrap.appendChild(el2);
    return wrap;
  },

  rerender() { if (this._host) this._host.renderInspector(); },

  // ---------------------------------------------------------------- 控件
  row(label, ...kids) {
    return h('div', { class: 'row' }, h('span', {}, label), ...kids.filter(Boolean));
  },
  num(get, set, unit, opts) {
    const o = opts || {};
    const inp = h('input', { type: 'number', step: o.step == null ? 'any' : String(o.step), title: o.title || '' });
    const v = get();
    inp.value = v == null ? '' : String(v);
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
  chk(get, set, label) {
    const inp = h('input', { type: 'checkbox' });
    inp.checked = !!get();
    inp.addEventListener('change', () => set(inp.checked));
    return h('label', { class: 'chk' }, inp, label || '');
  },
  txt(get, set, ph) {
    const inp = h('input', { type: 'text', placeholder: ph || '' });
    inp.value = get() == null ? '' : String(get());
    inp.addEventListener('change', () => set(inp.value.trim() || null));
    return inp;
  },
  vec3(get, set, unit) {
    const cur = get() || [0, 0, 0];
    const mk = (i) => {
      const inp = h('input', { type: 'number', step: 'any', class: 'v3' });
      inp.value = String(cur[i]);
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
  /** 随寿命的小折线编辑器：点空白加键、拖键、右键删键（首尾 t 钳 0 / 1） */
  curve(label, get, set) {
    const W = 168, H = 54, PAD = 6;
    const cv = h('canvas', { class: 'curve', width: String(W), height: String(H), title: '左键拖关键点 / 点空白加一个 / 右键删一个（横=寿命 0→1，纵=倍率）' });
    const host = this._host;
    const pts = () => (get() || []).slice().sort((a, b) => a[0] - b[0]);
    const vmax = () => Math.max(1, ...pts().map((p) => p[1]));
    const toPx = (p) => [PAD + p[0] * (W - PAD * 2), H - PAD - (p[1] / vmax()) * (H - PAD * 2)];
    const toVal = (mx, my) => [clamp((mx - PAD) / (W - PAD * 2), 0, 1), clamp((H - PAD - my) / (H - PAD * 2) * vmax(), 0, vmax())];
    const draw = () => {
      const g = cv.getContext('2d');
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#12151b'; g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.strokeRect(0.5, 0.5, W - 1, H - 1);
      const ps = pts(); if (!ps.length) return;
      g.strokeStyle = '#6cb4ff'; g.lineWidth = 1.5; g.beginPath();
      ps.forEach((p, i) => { const c = toPx(p); if (i) g.lineTo(c[0], c[1]); else g.moveTo(c[0], c[1]); });
      g.stroke();
      g.fillStyle = '#ffe44d';
      for (const p of ps) { const c = toPx(p); g.beginPath(); g.arc(c[0], c[1], 3, 0, Math.PI * 2); g.fill(); }
    };
    const at = (mx, my) => { const ps = pts(); for (let i = 0; i < ps.length; i++) { const c = toPx(ps[i]); if (Math.hypot(c[0] - mx, c[1] - my) <= 6) return i; } return -1; };
    let dragI = -1;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('mousedown', (e) => {
      const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const i = at(mx, my);
      if (e.button === 2) {
        if (i >= 0) { const ps = pts(); if (ps.length > 1) { ps.splice(i, 1); host.edit(`改${label}`, () => set(ps)); draw(); } }
        return;
      }
      if (e.button !== 0) return;
      if (i < 0) { const ps = pts(); ps.push(toVal(mx, my)); ps.sort((a, b) => a[0] - b[0]); host.edit(`改${label}`, () => set(ps)); draw(); return; }
      dragI = i; host.dragBegin(`改${label}`);
      const onMove = (ev) => {
        if (dragI < 0) return;
        const rr = cv.getBoundingClientRect();
        const ps = pts();
        ps[dragI] = toVal(ev.clientX - rr.left, ev.clientY - rr.top);
        ps.sort((a, b) => a[0] - b[0]);
        host.dragTick(() => set(ps));
        draw();
      };
      const onUp = () => { dragI = -1; host.dragEnd(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    });
    draw();
    return h('div', { class: 'row curverow' }, h('span', {}, label), cv);
  },

  /** 非群体发射器的「怕 / 被吸引」表（motion.stimulus）。群体走 behavior.attitude，不在这里出现。 */
  stimulusRows(em, mo, E) {
    if (em.behavior) {
      return [h('div', { class: 'pad dim' }, '这个发射器是群体：刺激反应在「群体行为」里的刺激权重表，不用 motion.stimulus')];
    }
    const st = mo.stimulus;
    if (!st) {
      return [h('div', { class: 'btns' }, h('button', {
        title: '让这个发射器认 fear / attract 场（不加就只认 wind）。萤火虫"人走近就散开"靠的是它',
        onclick: () => E('加刺激反应', () => { mo.stimulus = { fear: { 'player:motion': 1 }, accel: 700 }; }),
      }, '+ 加刺激反应（怕人 / 被引）'))];
    }
    const rows = [];
    const tbl = (t, label2) => {
      for (const k of Object.keys(t || {})) {
        rows.push(h('div', { class: 'row' },
          h('span', { class: 'tag' }, `${label2}·${k}`),
          this.num(() => t[k], (v) => E('改刺激权重', () => { if (v == null) delete t[k]; else t[k] = v; }), '', { step: 0.05 }),
          h('button', { class: 'danger', onclick: () => E('删刺激权重', () => { delete t[k]; }) }, '×')));
      }
    };
    tbl(st.fear, '怕');
    tbl(st.attract, '引');
    const addTag = h('input', { type: 'text', placeholder: 'player:motion / sfx:footstep / item:bug / 自定标签' });
    return [
      h('h4', {}, '刺激反应（非群体）'),
      this.row('加速度', this.num(() => st.accel, (v) => E('改刺激加速度', () => { st.accel = v == null ? 0 : Math.max(0, v); }), 'wu/s²',
        { title: '权重 1、场强 1、粒子正在场心时的加速度。实际 = 权重 × 场强 × (1−r/R)² × 它' })),
      ...rows,
      h('div', { class: 'row' }, addTag,
        h('button', { onclick: () => { const t2 = addTag.value.trim(); if (t2) E('加恐惧标签', () => { st.fear = st.fear || {}; st.fear[t2] = 0.5; }); } }, '+ 怕'),
        h('button', { onclick: () => { const t2 = addTag.value.trim(); if (t2) E('加吸引标签', () => { st.attract = st.attract || {}; st.attract[t2] = 0.5; }); } }, '+ 引')),
      h('div', { class: 'btns' }, h('button', { class: 'danger', onclick: () => E('删刺激反应', () => { delete mo.stimulus; }) }, '删刺激反应')),
    ];
  },

  // ---------------------------------------------------------------- 主体
  render(host, container) {
    this._host = host;
    container.textContent = '';
    if (!host.doc) { container.appendChild(h('div', { class: 'pad dim' }, '还没打开任何效果')); return; }
    const doc = host.doc;
    const em = host.currentEmitter();
    container.appendChild(this.effectSection(host, doc));
    if (!em) { container.appendChild(h('div', { class: 'pad dim' }, '左栏选一个发射器')); return; }
    const E = (label, fn) => host.edit(label, fn);
    const ensure = (key, init) => { if (!em[key] || typeof em[key] !== 'object') em[key] = init; return em[key]; };

    // ---------------- 发射器本身
    container.appendChild(h('div', { class: 'sec' },
      this.row('发射器 id', this.txt(() => em.id, (v) => { if (v) E('改发射器 id', () => host.renameEmitter(em.id, v)); }, 'bats')),
      this.row('原点偏移', this.vec3(() => em.offset || [0, 0, 0], (v) => E('改发射器偏移', () => { em.offset = v.map(round2); }), 'wu')),
      h('div', { class: 'row' }, h('span', {}, ''),
        this.chk(() => !!em.subOnly, (v) => E('改子发射器', () => { if (v) { em.subOnly = true; delete em.behavior; } else delete em.subOnly; }),
          '只由 onHit 触发（子发射器）')),
    ));

    // ---------------- 外观
    container.appendChild(this.section('appearance', '外观', () => {
      const ap = em.appearance || (em.appearance = { sizeWu: 6 });
      const src = host.sources || { anims: [], images: [] };
      return [
        this.row('动画包', this.sel(() => ap.animFile, (v) => E('改动画包', () => { if (v) { ap.animFile = v; delete ap.image; } else delete ap.animFile; }), src.anims, true)),
        this.row('单图', this.sel(() => ap.image, (v) => E('改贴图', () => { if (v) { ap.image = v; delete ap.animFile; } else delete ap.image; }), src.images, true)),
        ap.animFile ? this.row('状态', this.txt(() => ap.state, (v) => E('改动画状态', () => { if (v) ap.state = v; else delete ap.state; }), 'fly')) : null,
        ap.animFile ? this.row('栖息状态', this.txt(() => ap.restState, (v) => E('改栖息状态', () => { if (v) ap.restState = v; else delete ap.restState; }), 'hang')) : null,
        this.row('宽度', this.num(() => ap.sizeWu, (v) => E('改粒子大小', () => { ap.sizeWu = v == null ? 1 : Math.max(0.01, v); }), 'wu', { title: '粒子世界宽度；高按贴图长宽比' })),
        this.row('大小抖动', this.pair(() => ap.sizeJitter || [1, 1], (v) => E('改大小抖动', () => { ap.sizeJitter = v; }), '×')),
        this.curve('大小×寿命', () => ap.sizeOverLife, (v) => { ap.sizeOverLife = v; }),
        this.curve('透明×寿命', () => ap.alphaOverLife, (v) => { ap.alphaOverLife = v; }),
        this.row('乘色', this.vec3(() => ap.tint || [1, 1, 1], (v) => E('改乘色', () => { ap.tint = v.map((x) => clamp(x, 0, 1)); }), '0–1')),
        this.row('混合', this.sel(() => ap.blend, (v) => E('改混合', () => { if (v) ap.blend = v; else delete ap.blend; }), ['normal', 'add'], true)),
        h('div', { class: 'row' }, h('span', {}, ''), this.chk(() => ap.lit !== false, (v) => E('改受光', () => { if (v) delete ap.lit; else ap.lit = false; }), '吃 probe 底光 + 实体灯（自发光的关掉）')),
        ap.lit !== false ? this.row('镜面/自发光', this.num(() => ap.emissive, (v) => E('改自发光', () => { if (v == null) delete ap.emissive; else ap.emissive = clamp(v, 0, 1); }), '0–1', { title: '这一份亮度不吃漫反射着色。水滴、火星这类靠镜面/自发光才看得见的东西才给；不是亮度拉杆' })) : null,
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
        this.row('开播爆发', this.num(() => sp.burst, (v) => E('改爆发', () => { if (v == null) delete sp.burst; else sp.burst = Math.round(v); }), '个', { int: true })),
        this.row('形状', this.sel(() => shape && shape.kind, (v) => E('改发射形状', () => {
          if (!v) { delete sp.shape; return; }
          const d = { point: {}, sphere: { radius: 20 }, disc: { radius: 20 }, box: { size: [100, 50, 100] }, line: { to: [100, 0, 0] } }[v] || {};
          sp.shape = Object.assign({ kind: v }, d);
        }), ['point', 'sphere', 'disc', 'box', 'line'], true)),
        shape && (shape.kind === 'sphere' || shape.kind === 'disc')
          ? this.row('半径', this.num(() => shape.radius, (v) => E('改发射半径', () => { shape.radius = v == null ? 1 : Math.max(0, v); }), 'wu')) : null,
        shape && shape.kind === 'box' ? this.row('盒尺寸', this.vec3(() => shape.size || [0, 0, 0], (v) => E('改发射盒', () => { shape.size = v; }), 'wu')) : null,
        shape && shape.kind === 'line' ? this.row('线终点', this.vec3(() => shape.to || [0, 0, 0], (v) => E('改发射线', () => { shape.to = v; }), 'wu')) : null,
        this.row('初速', this.pair(() => sp.speed || [0, 0], (v) => E('改初速', () => { sp.speed = v; }), 'wu/s')),
        this.row('方向', this.vec3(() => sp.direction || [0, 1, 0], (v) => E('改初速方向', () => { sp.direction = v; }), 'M-world')),
        this.row('锥角', this.num(() => sp.spread, (v) => E('改锥角', () => { if (v == null) delete sp.spread; else sp.spread = v; }), '度', { title: '围绕 direction 的圆锥半角' })),
        this.row('活跃时长', this.num(() => sp.duration, (v) => E('改活跃时长', () => { if (v == null) delete sp.duration; else sp.duration = v; }), '秒', { title: '不写 = 一直发' })),
      ];
    }));

    // ---------------- 运动
    container.appendChild(this.section('motion', '运动', () => {
      const mo = em.motion;
      if (!mo) return [h('div', { class: 'btns' }, h('button', { onclick: () => E('加运动模块', () => { ensure('motion', {}); }) }, '+ 加运动模块'))];
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
        ...this.stimulusRows(em, mo, E),
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
        h('div', { class: 'btns' }, h('button', { class: 'danger', onclick: () => E('删群体模块', () => { delete em.behavior; }) }, '删群体模块')),
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
      const a = au && au.anchor ? au.anchor : null;
      return [
        this.row('id', h('span', { class: 'mono' }, doc.id)),
        this.row('标签', this.txt(() => doc.label, (v) => E('改标签', () => { if (v) doc.label = v; else delete doc.label; }), '崖墓蝙蝠群')),
        this.row('备注', this.txt(() => au && au.note, (v) => E('改备注', () => { const o = host.ensureAuthoring(); if (v) o.note = v; else delete o.note; }), '给自己看的')),
        h('h4', {}, '预览锚点（只给工作台重开现场，运行时忽略）'),
        a ? this.row('画面点', h('span', { class: 'mono' }, `${fmt(a.x)} , ${fmt(a.y)}`)) : h('div', { class: 'pad dim' }, '还没有锚点：按 A 在场景表面上点一下'),
        a ? this.row('离面高', this.num(() => a.h == null ? 0 : a.h, (v) => E('改锚点高度', () => { const o = host.ensureAnchor(); o.h = v == null ? 0 : Math.max(0, v); }), 'wu')) : null,
        a ? this.row('落在', this.sel(() => a.surface || 'ground', (v) => E('改锚点表面', () => { const o = host.ensureAnchor(); if (v === 'shell') o.surface = 'shell'; else delete o.surface; host.reanchor(); }), [{ value: 'ground', label: '行走面' }, { value: 'shell', label: '深度壳（崖壁 / 桌面）' }])) : null,
        h('div', { class: 'pad dim' }, '发射器一览：' + (doc.emitters || []).map((x) => x.id).join(' / ')),
      ];
    });
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { Inspector };
