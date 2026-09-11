'use strict';
/* 变换 gizmo（Unity 的 W/E/R）：几何 / 拾取 / 绘制 / 拖拽数学，**与视图无关**——2D 原画视图与 3D 世界视图共用同一份，
 * 选中任何东西（一个点也算）立刻出现在轴心，不用切视图、不用切模式（2026-09-11 制作人："第一次点击根本没有 gizmo"）。
 *
 * gizmo 只在"模型空间"里算，视图给一个 projector（proj）把模型点投到画布、把鼠标射回模型：
 *   世界空间资产：模型点 = 世界 xyz（wu）；轴 X / Y(h) / Z；面 XZ / XY / YZ（2D 原画里只有 XZ：Y 与 Z 在画上重叠，YZ 面是一条线）；
 *                 中心与 XZ 面 = "贴地走"（h 不变，跟地形）
 *   画面空间资产：模型点 = 画面 [x,y]（wu，y 向下）；轴 X / Y（画面上）；中心 = 自由挪
 * proj 接口（模型点 = 数组，dim 2 或 3）：
 *   dim                          2 | 3
 *   project(p)                   模型点 → 画布 css px [x,y]，相机背后 null
 *   worldPerPx(p)                p 处 1 px 对应的模型长度（gizmo 常显同一屏幕尺寸）
 *   axisParam(mx,my,p0,a)        鼠标落在"过 p0 沿 a 的直线"上的参数（模型长度）；轴对着视线无解 null
 *   planePoint(mx,my,p0,a,b)     鼠标落在"过 p0、由 a/b 张成的面"上的模型点；面对着视线无解 null
 *   groundPoint(mx,my,p0)        "贴地走"的模型点（3D：p0 高度的水平面；2D 世界：地面拾取；画面：画面点）
 *   viewPlanePoint(mx,my,p0)     过 p0、正对相机的面上的模型点（面退化时的退路）
 *   eyeAbove(p0)                 相机在 p0 之上（环边缘视角退屏幕角时定符号）
 * 拖拽结果是模型空间的量（{kind:'move', v:{x,y,z}} / {kind:'rotate', deg} / {kind:'scale', k:{x,y,z|all}}），
 * 视图再换成 Edit.T：世界 translate3(x, z, y=h) / rotateY / scale3；画面 translate2 / rotate2 / scale2。
 * 数学与拾取纯函数，node 测试 tests/math.test.cjs 用假 projector 钉住。 */

const GZ = {
  len: 84, planeOff: 0.34, planeSize: 0.22, ring: 0.9, pick: 9, tipPick: 10, sep: 16,
  snapMove: 10, snapRot: 15, snapScale: 0.1,
  col: { x: '#ff5b5b', y: '#7ed492', z: '#5aa9ff', c: '#e6e8ec', hot: '#ffe44d' },
};
/** 各空间的轴 / 面全集：planes = [key, 轴 a, 轴 b, 颜色取哪根轴]；ground = 走"贴地"（跟地形）的把手 */
const GZ_CFG = {
  world3: {
    axes: [{ k: 'x', v: [1, 0, 0], label: 'X' }, { k: 'y', v: [0, 1, 0], label: 'Y(h)' }, { k: 'z', v: [0, 0, 1], label: 'Z' }],
    planes: [['xz', 'x', 'z', 'y'], ['xy', 'x', 'y', 'z'], ['yz', 'z', 'y', 'x']], ground: ['c', 'xz'], ring: ['x', 'z'], center: true,
  },
  world2: {
    axes: [{ k: 'x', v: [1, 0, 0], label: 'X' }, { k: 'y', v: [0, 1, 0], label: 'Y(h)' }, { k: 'z', v: [0, 0, 1], label: 'Z' }],
    planes: [['xz', 'x', 'z', 'y']], ground: ['c', 'xz'], ring: ['x', 'z'], center: true,
  },
  screen: {
    axes: [{ k: 'x', v: [1, 0], label: 'X' }, { k: 'y', v: [0, -1], label: 'Y' }],
    planes: [], ground: ['c'], ring: ['x', 'ydown'], center: true,
  },
  /** 按"选中了什么"裁剪：控制点 / 整段 / 整条 = 全集；抛体把手与锚点各有自己的自由度（最高点只有高度、落点只在地上、锚点只在地上……）。
   *  ground=false 的中心 / XZ 面走"该高度的水平面"（初速箭尖在空中，不跟地形）。 */
  kinds: {
    points: { world: { axes: ['x', 'y', 'z'], planes: ['xz', 'xy', 'yz'], ground: true }, screen: { axes: ['x', 'y'] } },
    segment: { world: { axes: ['x', 'y', 'z'], planes: ['xz', 'xy', 'yz'], ground: true }, screen: { axes: ['x', 'y'] } },
    all: { world: { axes: ['x', 'y', 'z'], planes: ['xz', 'xy', 'yz'], ground: true }, screen: { axes: ['x', 'y'] } },
    v0: { world: { axes: ['x', 'y', 'z'], planes: ['xz', 'xy', 'yz'], ground: false }, screen: { axes: ['x', 'y'] } },
    apex: { world: { axes: ['y'], planes: [], center: false }, screen: { axes: ['y'], center: false } },
    landing: { world: { axes: ['x', 'z'], planes: ['xz'], ground: true }, screen: { axes: ['x'], center: false } },
    start: { world: { axes: ['x', 'y', 'z'], planes: ['xz'], ground: true }, screen: { axes: ['x', 'y'] } },
    /** 命名插槽：地面上的站位，只在地上挪 */
    slot: { world: { axes: ['x', 'z'], planes: ['xz'], ground: true }, screen: { axes: ['x', 'y'] } },
  },
  /** 组一份配置：base = world3 / world2 / screen（视图决定，2D 原画没有 XY / YZ 面），kind = 选中的东西（'slot:<id>' 归 slot） */
  build(base, kind) {
    const key = typeof kind === 'string' && kind.startsWith('slot:') ? 'slot' : kind;
    const k = (GZ_CFG.kinds[key] || GZ_CFG.kinds.points)[base === GZ_CFG.screen ? 'screen' : 'world'];
    const axes = base.axes.filter((a) => k.axes.includes(a.k));
    const planes = base.planes.filter((p) => (k.planes || []).includes(p[0]));
    const center = k.center !== false;
    const ground = k.ground === false ? [] : base.ground.filter((g) => g !== 'c' || center);
    return { axes, planes, ground, ring: base.ring, center, flat: k.ground === false };
  },
};

const Gizmo = {
  _add(p, v, s) { const o = p.slice(); for (let i = 0; i < o.length; i++) o[i] += (v[i] || 0) * s; return o; },
  _area(poly) { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; },
  _ringAxes(cfg, dim) {
    const ax = (k) => (k === 'ydown' ? [0, 1] : cfg.axes.find((a) => a.k === k).v);
    return [ax(cfg.ring[0]), ax(cfg.ring[1])];
  },
  /** 几何。pivot 模型点；n = 选中数（< 2 只给移动）；label = 画在轴心旁的"选中了什么"。
   *  返回 null 或 g = {pivot,n,mode,L,c,dim,axes,tip,base,planes,ring,cfg,label} */
  geom(proj, cfg, pivot, mode, n, label) {
    const c = proj.project(pivot); if (!c) return null;
    mode = n < 2 ? 'move' : (mode || 'move');
    const L = GZ.len * proj.worldPerPx(pivot);
    const axes = cfg.axes.map((a) => ({ k: a.k, v: a.v, label: a.label, col: GZ.col[a.k], offset: false }));
    const tip = {}, base = {};
    for (const a of axes) { tip[a.k] = proj.project(Gizmo._add(pivot, a.v, L)); base[a.k] = c.slice(); }
    // 屏幕上重叠的两根轴（2D 原画里 Y 与 Z 都朝上）：后一根整体平移 16px 画在旁边——只是画法，拖拽数学仍按真实轴向
    for (let i = 0; i < axes.length; i++) for (let j = 0; j < i; j++) {
      const A = axes[i].k, B = axes[j].k; if (!tip[A] || !tip[B]) continue;
      const da = [tip[A][0] - c[0], tip[A][1] - c[1]], db = [tip[B][0] - base[B][0], tip[B][1] - base[B][1]];
      const la = Math.hypot(da[0], da[1]), lb = Math.hypot(db[0], db[1]); if (la < 14 || lb < 14) continue;
      const cs = (da[0] * db[0] + da[1] * db[1]) / (la * lb);
      if (cs > Math.cos(10 * Math.PI / 180)) { const px = da[1] / la * GZ.sep, py = -da[0] / la * GZ.sep; tip[A] = [tip[A][0] + px, tip[A][1] + py]; base[A] = [c[0] + px, c[1] + py]; axes[i].offset = true; }   // 朝上的轴往左错开（右边是 X 箭头）
    }
    const g = { pivot: pivot.slice(), n, mode, L, c, dim: pivot.length, axes, tip, base, planes: {}, ring: null, cfg, label: label || '' };
    if (mode === 'move') {
      const o = GZ.planeOff * L, s = GZ.planeSize * L;
      for (const [k, ak, bk, ck] of cfg.planes) {
        const a = cfg.axes.find((x) => x.k === ak).v, b = cfg.axes.find((x) => x.k === bk).v;
        const P = (u, w) => proj.project(Gizmo._add(Gizmo._add(pivot, a, u), b, w));
        const poly = [P(o, o), P(o + s, o), P(o + s, o + s), P(o, o + s)];
        if (poly.every(Boolean) && Gizmo._area(poly) > 30) g.planes[k] = { poly, col: GZ.col[ck] };   // 面对着视线（一条线）就不给
      }
    } else if (mode === 'rotate') {
      const [a, b] = Gizmo._ringAxes(cfg, g.dim); const R = GZ.ring * L, pts = [];
      for (let i = 0; i < 48; i++) { const t = i / 48 * Math.PI * 2; const p = proj.project(Gizmo._add(Gizmo._add(pivot, a, Math.cos(t) * R), b, Math.sin(t) * R)); if (!p) { pts.length = 0; break; } pts.push(p); }
      if (pts.length) g.ring = pts;
    }
    return g;
  },
  /** 拾取：返回 part（'x'|'y'|'z'|'xz'|'xy'|'yz'|'c'|'ring'|'sx'|'sy'|'sz'|'sc'）或 null。
   *  中心（'c' / 'sc'）视图要放到"点 / 把手"之后再认：单点选中时中心就压在那个点上，拖点得还是拖点。 */
  hit(g, mx, my) {
    const near = (p, r) => !!p && Math.hypot(p[0] - mx, p[1] - my) <= r;
    const alive = (k) => { const t = g.tip[k], b = g.base[k]; return !!t && Math.hypot(t[0] - b[0], t[1] - b[1]) >= 14; };   // 对着视线的轴投影成一个点：不可抓
    const segHit = (k) => alive(k) && distToSeg(mx, my, g.base[k], g.tip[k]) <= GZ.pick;
    if (g.mode === 'move') {
      if (g.cfg.center && near(g.c, 8)) return 'c';
      for (const a of g.axes) if (alive(a.k) && near(g.tip[a.k], GZ.tipPick)) return a.k;
      for (const k in g.planes) if (pointInPoly(mx, my, g.planes[k].poly)) return k;
      for (const a of g.axes) if (segHit(a.k)) return a.k;
    } else if (g.mode === 'rotate') {
      if (g.ring) for (let i = 0; i < g.ring.length; i++) { const a = g.ring[i], b = g.ring[(i + 1) % g.ring.length]; if (distToSeg(mx, my, a, b) <= GZ.pick) return 'ring'; }
    } else {
      if (g.cfg.center && near(g.c, 9)) return 'sc';
      for (const a of g.axes) if (alive(a.k) && near(g.tip[a.k], GZ.tipPick)) return 's' + a.k;
      for (const a of g.axes) if (segHit(a.k)) return 's' + a.k;
    }
    return null;
  },
  isCenter(part) { return part === 'c' || part === 'sc'; },
  cursor(part) { return part === 'ring' ? 'crosshair' : part[0] === 's' ? 'nwse-resize' : 'move'; },
  /** 画在 canvas 2D 上（css px 坐标系已由调用方设好）。hot = 悬停 / 正在拖的 part */
  draw(g2, g, hot) {
    const col = (part, base) => (hot === part ? GZ.col.hot : base);
    const c = g.c;
    g2.save(); g2.lineWidth = 2; g2.font = 'bold 11px sans-serif'; g2.textAlign = 'left'; g2.textBaseline = 'alphabetic';
    const axisSeg = (k) => { const t = g.tip[k], b = g.base[k]; if (!t) return null; const dx = t[0] - b[0], dy = t[1] - b[1], l = Math.hypot(dx, dy); if (l < 14) return null; return { t, b, d: [dx / l, dy / l], l }; };
    if (g.mode === 'move') {
      for (const k in g.planes) {
        const pl = g.planes[k];
        g2.beginPath(); pl.poly.forEach((p, i) => (i ? g2.lineTo(p[0], p[1]) : g2.moveTo(p[0], p[1]))); g2.closePath();
        g2.fillStyle = hot === k ? 'rgba(255,228,77,.55)' : pl.col + '55'; g2.fill(); g2.strokeStyle = col(k, pl.col); g2.lineWidth = 1; g2.stroke(); g2.lineWidth = 2;
      }
      for (const a of g.axes) {
        const s = axisSeg(a.k); if (!s) continue;
        g2.strokeStyle = g2.fillStyle = col(a.k, a.col);
        if (a.offset) g2.setLineDash([5, 3]);
        g2.beginPath(); g2.moveTo(s.b[0], s.b[1]); g2.lineTo(s.t[0], s.t[1]); g2.stroke(); g2.setLineDash([]);
        const px = -s.d[1], py = s.d[0];
        g2.beginPath(); g2.moveTo(s.t[0], s.t[1]); g2.lineTo(s.t[0] - s.d[0] * 12 + px * 5, s.t[1] - s.d[1] * 12 + py * 5); g2.lineTo(s.t[0] - s.d[0] * 12 - px * 5, s.t[1] - s.d[1] * 12 - py * 5); g2.closePath(); g2.fill();
        g2.fillText(a.label, s.t[0] + s.d[0] * 10 + 3, s.t[1] + s.d[1] * 10 + 4);
      }
      if (g.cfg.center) { g2.fillStyle = col('c', GZ.col.c); g2.fillRect(c[0] - 5, c[1] - 5, 10, 10); g2.strokeStyle = 'rgba(0,0,0,.6)'; g2.lineWidth = 1; g2.strokeRect(c[0] - 5.5, c[1] - 5.5, 11, 11); }
      else { g2.strokeStyle = GZ.col.c; g2.lineWidth = 1.5; g2.beginPath(); g2.arc(c[0], c[1], 6, 0, Math.PI * 2); g2.stroke(); }
    } else if (g.mode === 'rotate') {
      if (g.ring) { g2.strokeStyle = col('ring', GZ.col.y); g2.beginPath(); g.ring.forEach((p, i) => (i ? g2.lineTo(p[0], p[1]) : g2.moveTo(p[0], p[1]))); g2.closePath(); g2.stroke(); }
      g2.fillStyle = GZ.col.c; g2.beginPath(); g2.arc(c[0], c[1], 3, 0, Math.PI * 2); g2.fill();
      g2.fillStyle = col('ring', GZ.col.y); g2.fillText(g.dim === 3 ? '绕 Y' : '旋转', c[0] + 8, c[1] - 8);
    } else {
      for (const a of g.axes) {
        const s = axisSeg(a.k); if (!s) continue;
        g2.strokeStyle = g2.fillStyle = col('s' + a.k, a.col);
        if (a.offset) g2.setLineDash([5, 3]);
        g2.beginPath(); g2.moveTo(s.b[0], s.b[1]); g2.lineTo(s.t[0], s.t[1]); g2.stroke(); g2.setLineDash([]);
        g2.fillRect(s.t[0] - 5, s.t[1] - 5, 10, 10);
        g2.fillText(a.label, s.t[0] + s.d[0] * 10 + 3, s.t[1] + s.d[1] * 10 + 4);
      }
      if (g.cfg.center) { g2.fillStyle = col('sc', GZ.col.c); g2.fillRect(c[0] - 6, c[1] - 6, 12, 12); g2.strokeStyle = 'rgba(0,0,0,.6)'; g2.lineWidth = 1; g2.strokeRect(c[0] - 6.5, c[1] - 6.5, 13, 13); }
    }
    // 轴心旁写清楚"选中了什么"（制作人 2026-09-11："完全不知道选中了什么"）
    if (g.label) {
      g2.font = 'bold 11px sans-serif'; const w = g2.measureText(g.label).width + 10;
      g2.fillStyle = 'rgba(0,0,0,.65)'; g2.fillRect(c[0] + 10, c[1] + 10, w, 16); g2.fillStyle = GZ.col.hot; g2.fillText(g.label, c[0] + 15, c[1] + 22);
    }
    g2.restore();
  },
  /** 光标旁的读数 */
  drawReadout(g2, r) {
    if (!r) return;
    g2.save(); g2.font = 'bold 12px sans-serif'; g2.textAlign = 'left'; g2.textBaseline = 'alphabetic';
    const w = g2.measureText(r.text).width + 12;
    g2.fillStyle = 'rgba(0,0,0,.7)'; g2.fillRect(r.x, r.y - 13, w, 18); g2.fillStyle = GZ.col.hot; g2.fillText(r.text, r.x + 6, r.y);
    g2.restore();
  },
  /** 拖拽开始：记下起点处的模型量。 */
  dragBegin(proj, g, part, mx, my) {
    const d = { kind: 'gz', part, p0: g.pivot.slice(), L: g.L, c: g.c, sx: mx, sy: my, moved: false, mode: g.mode, dim: g.dim };
    const axisOf = (k) => g.axes.find((a) => a.k === k);
    const m = /^s?([xyz])$/.exec(part);
    if (m) {
      const a = axisOf(m[1]); d.axisKey = m[1]; d.axis = a.v; d.label = a.label;
      d.t0 = proj.axisParam(mx, my, d.p0, a.v);
      const t = g.tip[m[1]], b = g.base[m[1]];
      if (t) { const l = Math.hypot(t[0] - b[0], t[1] - b[1]); if (l > 1) { d.sdir = [(t[0] - b[0]) / l, (t[1] - b[1]) / l]; d.sk = g.L / l; } }
    } else if (part === 'ring') {
      const [a, b] = Gizmo._ringAxes(g.cfg, g.dim); d.ra = a; d.rb = b;
      const q = proj.planePoint(mx, my, d.p0, a, b);
      d.a0 = q ? Gizmo._angle(q, d.p0, a, b) : null;
      d.sa0 = g.dim === 3 ? Math.atan2(-(my - g.c[1]), mx - g.c[0]) : Math.atan2(my - g.c[1], mx - g.c[0]);
      d.sign = g.dim === 3 ? (proj.eyeAbove(d.p0) ? 1 : -1) : 1; d.acc = 0; d.last = null;
    } else if (part !== 'sc') {
      if (g.dim === 2 || g.cfg.ground.includes(part)) { d.ground = true; d.q0 = proj.groundPoint(mx, my, d.p0); }
      else if (part === 'c' || part === 'xz') { d.pa = [1, 0, 0]; d.pb = [0, 0, 1]; d.q0 = proj.planePoint(mx, my, d.p0, d.pa, d.pb); }   // 不跟地形：该高度的水平面（初速箭尖在空中）
      else { const pl = g.cfg.planes.find((p) => p[0] === part); d.pa = axisOf(pl[1]).v; d.pb = axisOf(pl[2]).v; d.q0 = proj.planePoint(mx, my, d.p0, d.pa, d.pb); }
      if (!d.q0) { d.ground = false; d.cam = true; d.q0 = proj.viewPlanePoint(mx, my, d.p0); }   // 面对着视线：退到相机平面
    }
    return d;
  },
  _angle(q, p0, a, b) { let u = 0, w = 0; for (let i = 0; i < p0.length; i++) { u += (q[i] - p0[i]) * (a[i] || 0); w += (q[i] - p0[i]) * (b[i] || 0); } return Math.atan2(w, u); },
  /** 拖拽中：返回 {kind, ..., text} 或 null（死区 / 无解）。3px 死区：纯点一下不算编辑。 */
  dragUpdate(proj, d, mx, my, ctrl) {
    if (!d.moved && Math.hypot(mx - d.sx, my - d.sy) < 3) return null;
    d.moved = true;
    const snap = (v, s) => (ctrl ? Math.round(v / s) * s : v);
    const tag = ctrl ? '  [吸附]' : '';
    const lbl = (k) => (d.dim === 3 && k === 'y' ? 'h' : k);
    if (d.axis) {
      let dd = null;
      if (d.t0 != null) { const t = proj.axisParam(mx, my, d.p0, d.axis); if (t != null) dd = t - d.t0; }
      if (dd == null && d.sdir) dd = ((mx - d.sx) * d.sdir[0] + (my - d.sy) * d.sdir[1]) * d.sk;
      if (dd == null) return null;
      if (d.mode === 'move') {
        dd = snap(dd, GZ.snapMove);
        const v = {}; ['x', 'y', 'z'].slice(0, d.dim).forEach((k, i) => { v[k] = (d.axis[i] || 0) * dd; });
        return { kind: 'move', v, text: `Δ${lbl(d.axisKey)} ${fmt(dd)}${tag}` };
      }
      const k = Math.max(0.05, snap(1 + dd / d.L, GZ.snapScale));
      return { kind: 'scale', k: { [d.axisKey]: k }, text: `×${fmt(k, 2)} ${lbl(d.axisKey)}${tag}` };
    }
    if (d.part === 'sc') {
      const k = Math.max(0.05, snap(Math.exp(((mx - d.sx) - (my - d.sy)) / 150), GZ.snapScale));
      return { kind: 'scale', k: { all: k }, text: `×${fmt(k, 2)}${tag}` };
    }
    if (d.part === 'ring') {
      const q = proj.planePoint(mx, my, d.p0, d.ra, d.rb);
      const a = q && d.a0 != null ? Gizmo._angle(q, d.p0, d.ra, d.rb) - d.a0
        : ((d.dim === 3 ? Math.atan2(-(my - d.c[1]), mx - d.c[0]) : Math.atan2(my - d.c[1], mx - d.c[0])) - d.sa0) * d.sign;
      if (d.last == null) { let a0 = a; while (a0 > Math.PI) a0 -= 2 * Math.PI; while (a0 < -Math.PI) a0 += 2 * Math.PI; d.acc = a0; }
      else { let dl = a - d.last; while (dl > Math.PI) dl -= 2 * Math.PI; while (dl < -Math.PI) dl += 2 * Math.PI; d.acc += dl; }
      d.last = a;
      const deg = snap(d.acc * 180 / Math.PI, GZ.snapRot);
      return { kind: 'rotate', deg, text: `${fmt(deg)}°${tag}` };
    }
    const q = d.ground ? proj.groundPoint(mx, my, d.p0) : d.cam ? proj.viewPlanePoint(mx, my, d.p0) : proj.planePoint(mx, my, d.p0, d.pa, d.pb);
    if (!q || !d.q0) return null;
    const delta = q.map((x, i) => snap(x - d.q0[i], GZ.snapMove));
    if (d.ground && d.dim === 3) delta[1] = 0;   // 贴地走：h 不变（跟地形）
    const v = {}; ['x', 'y', 'z'].slice(0, d.dim).forEach((k, i) => { v[k] = delta[i]; });
    const parts = Object.keys(v).filter((k) => Math.abs(v[k]) > 1e-9 || !d.ground).map((k) => `Δ${lbl(k)} ${fmt(v[k])}`);
    return { kind: 'move', v, text: (parts.length ? parts.join('  ') : 'Δ 0') + tag };
  },
  /** 拖拽结果 → Edit.T（world：{x,z,h}；screen：{x,y}）。pv = 变换轴（host._pivotNative()，旋转 / 缩放才用）。 */
  toTransform(res, world, pv) {
    if (!res) return null;
    if (res.kind === 'move') return world ? Edit.T.translate3(res.v.x || 0, res.v.z || 0, res.v.y || 0) : Edit.T.translate2(res.v.x || 0, res.v.y || 0);
    if (!pv) return null;
    if (res.kind === 'rotate') return world ? Edit.T.rotateY(pv, res.deg) : Edit.T.rotate2(pv, res.deg);
    const k = res.k, all = k.all == null ? 1 : k.all;
    const kx = k.x == null ? all : k.x, ky = k.y == null ? all : k.y, kz = k.z == null ? all : k.z;
    return world ? Edit.T.scale3(pv, kx, kz, ky) : Edit.T.scale2(pv, kx, ky);
  },
  label(mode) { return { move: '移动', rotate: '旋转', scale: '缩放' }[mode] || '变换'; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { GZ, GZ_CFG, Gizmo };
