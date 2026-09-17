'use strict';
/* 燃烧工作台 · 中间两个视图（WebGL2 着色层 `#gl` + 2D 标注层 `#ov`）。
 *
 * - **原画视图**（主视图）：模板自己的图（燃烧着色同一份，按真实尺寸跑的那份模拟）+ 燃料格（不可燃的格压暗）+ 网格 +
 *   涂层叠加 + 着火点（增删拖）+ 握点（拖；没写 = 底边中点，画成虚点）+ 尺寸标注 + 消耗燃烧的方向箭头 / 火苗列 + 粒子源 + 火光。
 * - **场景视图**（只读，从「用在哪」点开）：背景 + 这个场景所有开了可燃的实体（各用各的模板，按实体 transform 摆）+
 *   选中实例的交互圈、着火点、每个着火点左右两个站位（脚点按能不能站着色：绿 / 红 / 灰 = 未判）+ 粒子源 + 火光。
 *   **不能拖、不能改任何实体**（那是主编辑器的事）：只有选中与点火。
 * - 手势照其它工作台：滚轮朝光标缩放、中键 / 空格 + 左键平移、F 整幅；右键拖 = 擦涂层。
 * - 涂层：页面里一张长边 256 的单通道缓冲（R = 燃料量 / 顺序），一笔画完编码成 PNG data URL 写进文档（一笔一条历史）。
 *   撤销 / 重做换了文档里的 data URL ⇒ 缓冲按新串重解码。 */

const V = {
  gl: null, ov: null, ctx: null, dpr: 1, w: 1, h: 1,
  cam: { art: { k: 1, ox: 0, oy: 0, fitKey: '' }, scene: { k: 1, ox: 0, oy: 0, fitKey: '' } },
  queued: false,
  imgs: new Map(),
  mouse: { x: -1, y: -1, inside: false },
  drag: null,
  masks: { fuel: null, order: null },
  spaceDown: false,
  sceneHits: [],
};
const MASK_LONG = 256;
const WALK_RGB = { true: '#7ed492', false: '#ff6b6b', null: '#9aa1ad' };
const SRC_RGB = { flame: '#ffb040', ember: '#ff4a20', ash: '#b8b8b8' };
const GRIP_RGB = '#6cf0e0';

function requestDraw() {
  if (V.queued) return;
  V.queued = true;
  requestAnimationFrame(() => { V.queued = false; draw(); });
}

/** 模板原画（Image，给 GL 贴图）。没到 = null，到了自己重画 */
function imageOf(url) {
  if (!url) return null;
  let r = V.imgs.get(url);
  if (!r) {
    r = { img: null, err: '' };
    V.imgs.set(url, r);
    API.image(url).then((img) => { r.img = img; requestDraw(); if (typeof onImageLoaded === 'function') onImageLoaded(url); },
      (e) => { r.err = String((e && e.message) || e); requestDraw(); });
  }
  return r.img;
}

function cam() { return V.cam[S.view]; }
function toScreen(x, y) { const c = cam(); return [x * c.k + c.ox, y * c.k + c.oy]; }
function toWorld(sx, sy) { const c = cam(); return [(sx - c.ox) / c.k, (sy - c.oy) / c.k]; }
function artSize() {
  const doc = S.docs[S.docId];
  const img = doc ? imageOf(doc.image) : null;
  return img ? [img.naturalWidth, img.naturalHeight] : null;
}
/** 整幅。视口还没量出尺寸（启动 / 隐藏时）返回假，不动相机 */
function fitView() {
  const c = cam();
  let W, Hh;
  if (S.view === 'scene') { if (!S.sv || !S.sv.scene) return false; W = S.sv.scene.worldWidth; Hh = S.sv.scene.worldHeight; }
  else { const s = artSize(); if (!s) return false; [W, Hh] = s; }
  const center = el('center');
  V.w = center.clientWidth; V.h = center.clientHeight;
  // 上边留出视图工具条 + 原画视图的尺寸标注，左边留出高度标注，下边留出状态说明
  const padL = S.view === 'art' ? 60 : 40, padR = 40, padT = 72, padB = 48;
  const aw = V.w - padL - padR, ah = V.h - padT - padB;
  if (!(aw > 8 && ah > 8)) return false;
  c.k = Math.max(1e-3, Math.min(aw / W, ah / Hh));
  c.ox = padL + (aw - W * c.k) / 2;
  c.oy = padT + (ah - Hh * c.k) / 2;
  requestDraw();
  return true;
}
function ensureFit() {
  const c = cam();
  const key = S.view === 'scene' ? (S.sv && S.sv.scene ? `s:${S.sv.scene.id}` : '') : (artSize() ? `a:${S.docId}` : '');
  if (key && c.fitKey !== key && fitView()) c.fitKey = key;
}

function setView(v) {
  S.view = v === 'scene' && S.sv ? 'scene' : 'art';
  if (!TOOLS[S.view].some((t) => t[0] === S.tool)) S.tool = 'select';
  renderViewBar();
  ensureFit();
  requestDraw();
  refreshDirty();
  if (typeof renderInspector === 'function') renderInspector();
  if (typeof renderSimBar === 'function') renderSimBar();
}
function setTool(t) {
  if (!TOOLS[S.view].some((x) => x[0] === t)) return;
  if (t === 'order') {
    const doc = S.docs[S.docId];
    if (!doc || doc.mode !== 'consume') { status('顺序涂层只对消耗燃烧（mode=consume）有用', 'warn'); return; }
  }
  S.tool = t;
  renderViewBar();
  requestDraw();
}

const TOOLS = {
  art: [['select', '选择', 'V：选 / 拖着火点与握点'], ['point', '加着火点', 'P：点一下加一个'], ['fuel', '燃料涂层', 'B：R 通道 = 燃料量；右键拖 / E = 擦'],
    ['order', '顺序涂层', 'O：消耗燃烧的顺序（黑先白后）'], ['ignite', '点火', 'I：点一下 = 预览里在那一点点着']],
  scene: [['select', '选择', 'V：选一个实例（只读：不能拖）'], ['ignite', '点火', 'I：点在实例图上 = 预览里在那一点点着']],
};
const LAYERS = {
  art: [['grid', '网格'], ['fuel', '不可燃格'], ['mask', '涂层'], ['particles', '粒子源'], ['lights', '火光']],
  scene: [['particles', '粒子源'], ['lights', '火光'], ['stances', '站位'], ['ranges', '交互圈']],
};

function renderViewBar() {
  el('btnViewArt').classList.toggle('on', S.view === 'art');
  const sb = el('btnViewScene');
  sb.hidden = !S.sv;
  el('btnCloseScene').hidden = !S.sv;
  if (S.sv) {
    sb.textContent = `场景 ${S.sv.scene ? S.sv.scene.id : S.sv.sceneId}（只读）`;
    sb.classList.toggle('on', S.view === 'scene');
  }
  const tb = el('toolBtns');
  tb.textContent = '';
  for (const [id, label, tip] of TOOLS[S.view]) {
    tb.append(h('button', { class: S.tool === id ? 'on' : '', title: tip, 'data-tool': id, text: label, onclick: () => setTool(id) }));
  }
  const lb = el('layerBtns');
  lb.textContent = '';
  for (const [id, label] of LAYERS[S.view]) {
    lb.append(h('button', { class: S.layers[id] ? 'on' : '', 'data-layer': id, text: label, onclick: () => { S.layers[id] = !S.layers[id]; renderViewBar(); requestDraw(); } }));
  }
  const brush = S.view === 'art' && (S.tool === 'fuel' || S.tool === 'order');
  el('brushbar').hidden = !brush;
  el('brushValueWrap').hidden = S.tool !== 'order' && S.tool !== 'fuel';
}

// ---------------------------------------------------------------------------
// 涂层缓冲
// ---------------------------------------------------------------------------
function maskSrc(doc, kind) {
  if (!doc) return null;
  const s = kind === 'fuel' ? doc.fuel && doc.fuel.maskData : doc.consume && doc.consume.orderData;
  return typeof s === 'string' && s ? s : null;
}
function defaultOrder(m, from) {
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const fy = m.h > 1 ? y / (m.h - 1) : 0, fx = m.w > 1 ? x / (m.w - 1) : 0;
      const o = from === 'bottom' ? 1 - fy : from === 'left' ? fx : from === 'right' ? 1 - fx : fy;
      m.data[y * m.w + x] = Math.round(o * 255);
    }
  }
}
/** 当前模板的一层涂层缓冲；文档里的串变了（撤销 / 重做 / 清涂层）就重建。没准备好 = 返回的 `ready` 为假 */
function maskFor(kind) {
  const doc = S.docs[S.docId];
  const size = artSize();
  if (!doc || !size) return null;
  const src = maskSrc(doc, kind);
  const from = doc.consume && doc.consume.from;
  let m = V.masks[kind];
  if (m && m.docId === S.docId && m.src === src && (src || kind !== 'order' || m.from === from)) return m;
  const long = Math.max(size[0], size[1], 1);
  m = { docId: S.docId, src, from, w: Math.max(1, Math.round(MASK_LONG * size[0] / long)), h: Math.max(1, Math.round(MASK_LONG * size[1] / long)), data: null, ready: false, canvas: document.createElement('canvas'), rev: 0 };
  m.data = new Uint8Array(m.w * m.h);
  V.masks[kind] = m;
  if (!src) {
    if (kind === 'fuel') m.data.fill(255); else defaultOrder(m, from);
    m.ready = true;
    paintMaskCanvas(kind, m);
    return m;
  }
  const img = new Image();
  img.onload = () => {
    if (V.masks[kind] !== m) return;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const id = cx.getImageData(0, 0, c.width, c.height).data;
    m.w = c.width; m.h = c.height; m.data = new Uint8Array(m.w * m.h);
    for (let i = 0; i < m.w * m.h; i++) m.data[i] = id[i * 4];
    m.ready = true;
    paintMaskCanvas(kind, m);
    requestDraw();
  };
  img.onerror = () => { if (V.masks[kind] === m) { m.err = '涂层解码失败'; requestDraw(); } };
  img.src = src;
  return m;
}
function paintMaskCanvas(kind, m) {
  m.canvas.width = m.w; m.canvas.height = m.h;
  const cx = m.canvas.getContext('2d');
  const id = cx.createImageData(m.w, m.h);
  for (let i = 0; i < m.w * m.h; i++) {
    const v = m.data[i], o = i * 4;
    if (kind === 'fuel') { id.data[o] = 40; id.data[o + 1] = 120; id.data[o + 2] = 255; id.data[o + 3] = Math.round((255 - v) * 0.6); }
    else { id.data[o] = v; id.data[o + 1] = v; id.data[o + 2] = v; id.data[o + 3] = 150; }
  }
  cx.putImageData(id, 0, 0);
  m.rev++;
}
/** R = G = B = 值、A = 255 的 PNG data URL（alpha 满，读回不经预乘取整） */
function encodeMask(m) {
  const c = document.createElement('canvas');
  c.width = m.w; c.height = m.h;
  const cx = c.getContext('2d');
  const id = cx.createImageData(m.w, m.h);
  for (let i = 0; i < m.w * m.h; i++) {
    const o = i * 4, v = m.data[i];
    id.data[o] = v; id.data[o + 1] = v; id.data[o + 2] = v; id.data[o + 3] = 255;
  }
  cx.putImageData(id, 0, 0);
  return c.toDataURL('image/png');
}
function brushDab(m, cx, cy, r, target, strength) {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(m.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(m.h - 1, Math.ceil(cy + r));
  let changed = false;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > r) continue;
      const fall = d < r * 0.5 ? 1 : 1 - (d - r * 0.5) / (r * 0.5);
      const i = y * m.w + x, v = m.data[i];
      const nv = Math.round(v + (target - v) * strength * fall);
      if (nv !== v) { m.data[i] = nv; changed = true; }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// 画
// ---------------------------------------------------------------------------
function draw() {
  const center = el('center');
  const cw = center.clientWidth, ch = center.clientHeight;
  V.dpr = window.devicePixelRatio || 1;
  V.w = cw; V.h = ch;
  if (V.gl) V.gl.resize(cw, ch, V.dpr);
  const ov = V.ov;
  const W = Math.max(1, Math.round(cw * V.dpr)), Hh = Math.max(1, Math.round(ch * V.dpr));
  if (ov.width !== W || ov.height !== Hh) { ov.width = W; ov.height = Hh; }
  ensureFit();
  const ctx = V.ctx;
  ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
  const glOk = V.gl && V.gl.begin();
  if (S.view === 'scene') drawScene(glOk, ctx); else drawArt(glOk, ctx);
  renderViewInfo();
  if (typeof renderSimBar === 'function') renderSimBar();
}

/** 燃烧着色：与游戏同一条——只在"烧过"（状态 ≠ 没点）时挂（`BurnRenderer`）；没点的消耗燃烧照挂的话顶上那一格会按 0 秒火线发光 */
function burnFor(name, sim, it) {
  if (!V.gl || !V.gl.prog || !sim || !it || !it.grid || !sim.has(it.key)) return null;
  if (sim.state(it.key) === 'unburnt') return null;
  const field = V.gl.fieldOf(name, sim, it.key, it.grid.nx, it.grid.ny);
  return { field, params: shadeParamsOf(it.b, it.grid, sim.shaderClock(it.key)) };
}

function frameCorners(f) {
  const g = S.rt.burnGeometry;
  return [g.burnUvToScene(f, 0, 0), g.burnUvToScene(f, 1, 0), g.burnUvToScene(f, 1, 1), g.burnUvToScene(f, 0, 1)].map((p) => [p.x, p.y]);
}

function drawScene(glOk, ctx) {
  const sv = S.sv;
  const sc = sv && sv.scene;
  if (!sc) { ctx.fillStyle = '#9aa1ad'; ctx.fillText('场景装载中…', 20, 60); return; }
  const keepFields = new Set();
  if (glOk && sv.bgImg) V.gl.quad([[0, 0], [sc.worldWidth, 0], [sc.worldWidth, sc.worldHeight], [0, sc.worldHeight]].map((p) => toScreen(p[0], p[1])), sv.bgImg, null, 1);
  const items = P.sc.items.slice().sort((a, b) => a.placement.footY - b.placement.footY);
  V.sceneHits = [];
  for (const it of items) {
    const corners = frameCorners(it.frame);
    V.sceneHits.push({ it, corners });
    const img = imageOf(it.b.image);
    if (!glOk || !img) continue;
    const burn = burnFor(`s:${it.key}`, P.sc.sim, it);
    if (burn) keepFields.add(`s:${it.key}`);
    V.gl.quad(corners.map((p) => toScreen(p[0], p[1])), img, burn, 1);
  }
  if (V.gl && V.gl.ok) V.gl.dropFields(new Set([...keepFields, ...[...V.gl.fields.keys()].filter((k) => k.startsWith('a:'))]));
  const g = S.rt && S.rt.burnGeometry;
  ctx.lineWidth = 1;
  for (const { it, corners } of V.sceneHits) {
    const sel = it.key === sv.entityId;
    const mine = it.ent.template === S.docId;
    const bad = P.sc.problems.some((p) => p.key === it.key && p.level === 'error');
    ctx.strokeStyle = sel ? '#6cb4ff' : bad ? '#ff6b6b' : mine ? 'rgba(255,140,58,.9)' : 'rgba(255,255,255,.3)';
    ctx.lineWidth = sel ? 2 : 1;
    ctx.beginPath();
    corners.forEach((p, i) => { const s = toScreen(p[0], p[1]); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); });
    ctx.closePath();
    ctx.stroke();
    const s = toScreen(it.ent.x, it.ent.y);
    ctx.fillStyle = sel ? '#6cb4ff' : mine ? '#ff8c3a' : '#c8ccd4';
    ctx.fillText(`${it.ent.kind === 'npc' ? '👤 ' : ''}${it.key} · ${it.ent.template}`, s[0] + 4, s[1] + 14);
  }
  for (const p of P.sc.problems) {
    if (p.level !== 'error') continue;
    const ent = sc.entities.find((e) => e.id === p.key);
    if (!ent) continue;
    const s = toScreen(ent.x, ent.y);
    ctx.fillStyle = '#ff6b6b';
    ctx.fillText(`⚠ ${p.key}：${p.msg}`, s[0] + 4, s[1] + 14);
  }
  // 交互圈（选中的）
  const selIt = sceneItem(sv.entityId);
  if (S.layers.ranges && selIt) {
    const r = interactionRadius(selIt) * cam().k;
    const s = toScreen(selIt.ent.x, selIt.ent.y);
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(108,180,255,.9)';
    ctx.beginPath(); ctx.arc(s[0], s[1], Math.max(2, r), 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
  // 着火点
  for (const it of items) {
    if (!g) break;
    for (const p of it.b.ignitionPoints) {
      const sp = g.burnUvToScene(it.frame, p.u, p.v);
      const s = toScreen(sp.x, sp.y);
      const on = it.key === sv.entityId && p.id === S.selPoint;
      ctx.fillStyle = on ? '#ffe36b' : '#ff8c3a';
      ctx.strokeStyle = '#000';
      ctx.beginPath(); ctx.arc(s[0], s[1], on ? 5 : 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
  if (S.layers.stances) drawStances(ctx);
  if (P.sc.sim && g) for (const it of items) drawSources(ctx, P.sc.sim, it, (u, v) => { const sp = g.burnUvToScene(it.frame, u, v); return toScreen(sp.x, sp.y); }, 'scene');
}

function drawStances(ctx) {
  const st = S.stances;
  if (!st || !S.sv || st.entityId !== S.sv.entityId || !st.points.length) return;
  const walk = S.walk && S.walk.key === st.walkKey ? S.walk : null;
  let fi = 0;
  for (const pt of st.points) {
    const t = toScreen(pt.target.scene.x, pt.target.scene.y);
    ctx.strokeStyle = '#ffe36b'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(t[0] - 6, t[1]); ctx.lineTo(t[0] + 6, t[1]); ctx.moveTo(t[0], t[1] - 6); ctx.lineTo(t[0], t[1] + 6); ctx.stroke();
    for (const [side, label] of [[pt.right, '朝右'], [pt.left, '朝左']]) {
      if (!side) continue;
      const idx = fi++;
      const verdict = walk ? walk.results[idx] : undefined;
      const col = verdict === undefined ? WALK_RGB.null : WALK_RGB[String(verdict)];
      const f = toScreen(side.x, side.y);
      if (side.tip) {
        const tp = toScreen(side.tip.x, side.tip.y);
        ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(f[0], f[1]); ctx.lineTo(tp[0], tp[1]); ctx.stroke(); ctx.setLineDash([]);
        ctx.strokeStyle = side.residual > 0.5 ? '#ff6b6b' : '#ffe36b';
        ctx.beginPath(); ctx.moveTo(tp[0], tp[1]); ctx.lineTo(t[0], t[1]); ctx.stroke();
        ctx.fillStyle = '#ffb040'; ctx.beginPath(); ctx.arc(tp[0], tp[1], 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = col; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(f[0], f[1] - 7); ctx.lineTo(f[0] + 6, f[1]); ctx.lineTo(f[0], f[1] + 7); ctx.lineTo(f[0] - 6, f[1]); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = side.outOfRange ? '#ffb454' : '#e6e8ec';
      ctx.fillText(`${label}${side.outOfRange ? ' ⚠圈外' : ''}`, f[0] + 8, f[1] - 6);
      if (side.outOfRange) {
        ctx.strokeStyle = '#ffb454'; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.arc(f[0], f[1], 11, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      }
    }
  }
}

/** 粒子源（flame / ember / ash 的格）画成点、火光画成圈。`uvToScreen(u, v)` 把格心 uv 画到当前视图 */
function drawSources(ctx, sim, it, uvToScreen, where) {
  if (!sim.has(it.key) || !S.layers.particles && !S.layers.lights) return;
  const nx = it.grid.nx, ny = it.grid.ny;
  if (S.layers.particles) {
    for (const src of ['ash', 'ember', 'flame']) {
      const q = sim.query(it.key, src, P.query);
      if (!q.count) continue;
      ctx.fillStyle = SRC_RGB[src];
      const step = Math.max(1, Math.ceil(q.count / 600));
      const r = where === 'art' ? 2.2 : 1.6;
      for (let k = 0; k < q.count; k += step) {
        const c = q.cells[k], i = c % nx, j = (c - i) / nx;
        const s = uvToScreen((i + 0.5) / nx, (j + 0.5) / ny);
        ctx.fillRect(s[0] - r, s[1] - r, r * 2, r * 2);
      }
    }
  }
  if (S.layers.lights && it.b.light) {
    const rd = itemReadout(sim, it);
    if (rd && rd.light) {
      const q = sim.query(it.key, 'flame', P.query);
      let su = 0, sv = 0;
      for (let k = 0; k < q.count; k++) { const c = q.cells[k], i = c % nx; su += (i + 0.5) / nx; sv += ((c - i) / nx + 0.5) / ny; }
      // 火光中心 = 明火格心的平均，往"图的上方"抬半个火焰长（画面标注用；游戏里的灯位在世界空间算）
      const ext = S.rt.burnGeometry.burnFrameExtent(it.frame);
      const lift = (it.b.flameLengthCm * S.rt.burnables.BURN_WU_PER_CM / 2) / Math.max(1e-6, ext.height);
      const s = uvToScreen(su / Math.max(1, q.count), sv / Math.max(1, q.count) - lift);
      const rad = clamp(Math.sqrt(rd.light.intensity) * 18, 6, 140);
      const grd = ctx.createRadialGradient(s[0], s[1], 0, s[0], s[1], rad);
      grd.addColorStop(0, 'rgba(255,170,70,.45)'); grd.addColorStop(1, 'rgba(255,120,30,0)');
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(s[0], s[1], rad, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,190,90,.9)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(s[0], s[1], 4, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#ffd29a';
      ctx.fillText(`光 ${fmt(rd.light.intensity, 2)}`, s[0] + 6, s[1] - 6);
    }
  }
}

/** 握点：写了 = 实心；没写 = 底边中点的虚点（挂到手上时挂点对准它） */
function gripOf(doc) {
  const g = doc && doc.grip;
  if (isObj(g) && typeof g.u === 'number' && typeof g.v === 'number') return { u: clamp(g.u, 0, 1), v: clamp(g.v, 0, 1), written: true };
  return { u: 0.5, v: 1, written: false };
}

function drawDimension(ctx, a, b, text, side) {
  ctx.strokeStyle = 'rgba(200,220,255,.65)'; ctx.fillStyle = '#cfe0ff'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  const tick = (p) => {
    if (side === 'top') { ctx.beginPath(); ctx.moveTo(p[0], p[1] - 4); ctx.lineTo(p[0], p[1] + 4); ctx.stroke(); }
    else { ctx.beginPath(); ctx.moveTo(p[0] - 4, p[1]); ctx.lineTo(p[0] + 4, p[1]); ctx.stroke(); }
  };
  tick(a); tick(b);
  const w = ctx.measureText(text).width;
  if (side === 'top') ctx.fillText(text, (a[0] + b[0]) / 2 - w / 2, a[1] - 6);
  else { ctx.save(); ctx.translate(a[0] - 6, (a[1] + b[1]) / 2 + w / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(text, 0, 0); ctx.restore(); }
}

function drawArt(glOk, ctx) {
  const doc = S.docs[S.docId];
  if (!doc) { ctx.fillStyle = '#9aa1ad'; ctx.fillText('没有打开模板（左栏选一份或新建）', 20, 60); return; }
  const size = artSize();
  const img = imageOf(doc.image);
  if (!size || !img) {
    const r = V.imgs.get(doc.image);
    ctx.fillStyle = r && r.err ? '#ff6b6b' : '#9aa1ad';
    ctx.fillText(r && r.err ? `原画装不上：${doc.image}` : doc.image ? '原画装载中…' : '模板没写原画', 20, 60);
    return;
  }
  const [W, Hh] = size;
  const it = P.art && P.art.id === S.docId && P.art.grid ? P.art : null;
  const rect = [[0, 0], [W, 0], [W, Hh], [0, Hh]].map((p) => toScreen(p[0], p[1]));
  if (glOk) {
    const burn = it ? burnFor(`a:${it.key}`, it.sim, it) : null;
    V.gl.quad(rect, img, burn, 1);
  }
  const [x0, y0] = toScreen(0, 0), [x1, y1] = toScreen(W, Hh);
  // 不可燃格 / 网格
  if (it) {
    const { nx, ny, fuel } = it.grid;
    const cw = (x1 - x0) / nx, chh = (y1 - y0) / ny;
    if (S.layers.fuel) {
      ctx.fillStyle = 'rgba(160,20,60,.28)';
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (fuel[j * nx + i] >= S.rt.burnSim.BURN_MIN_FUEL) continue;
        ctx.fillRect(x0 + i * cw, y0 + j * chh, cw, chh);
      }
    }
    if (S.layers.grid && cw > 3) {
      ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= nx; i++) { ctx.moveTo(x0 + i * cw, y0); ctx.lineTo(x0 + i * cw, y1); }
      for (let j = 0; j <= ny; j++) { ctx.moveTo(x0, y0 + j * chh); ctx.lineTo(x1, y0 + j * chh); }
      ctx.stroke();
    }
  }
  // 涂层叠加
  if (S.layers.mask) {
    const kind = S.tool === 'order' ? 'order' : 'fuel';
    const m = kind === 'fuel' && !maskSrc(doc, 'fuel') && S.tool !== 'fuel' ? null : maskFor(kind);
    if (m && m.ready) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(m.canvas, x0, y0, x1 - x0, y1 - y0);
      ctx.imageSmoothingEnabled = true;
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  // 真实尺寸标注
  const wcm = typeof doc.widthCm === 'number' ? `${doc.widthCm} cm` : '宽 ? cm';
  const hcm = typeof doc.heightCm === 'number' ? `${doc.heightCm} cm` : '高 ? cm';
  drawDimension(ctx, [x0, y0 - 14], [x1, y0 - 14], wcm, 'top');
  drawDimension(ctx, [x0 - 14, y0], [x0 - 14, y1], hcm, 'left');
  // 消耗燃烧：方向 / 火苗列
  if (doc.mode === 'consume') {
    const c = isObj(doc.consume) ? doc.consume : {};
    const fu = typeof c.flameU === 'number' ? c.flameU : (it ? it.grid.centroidU : 0.5);
    const fw = typeof c.flameWidth === 'number' ? c.flameWidth : S.rt ? S.rt.burnables.BURN_DEFAULTS.flameWidth : 0.2;
    const a = x0 + (fu - fw / 2) * (x1 - x0), b = x0 + (fu + fw / 2) * (x1 - x0);
    ctx.fillStyle = 'rgba(255,200,80,.10)'; ctx.fillRect(a, y0, b - a, y1 - y0);
    ctx.strokeStyle = 'rgba(255,200,80,.8)'; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(a, y0); ctx.lineTo(a, y1); ctx.moveTo(b, y0); ctx.lineTo(b, y1); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#ffd27a'; ctx.fillText(`火苗列 u=${fmt(fu, 3)}±${fmt(fw / 2, 3)}${typeof c.flameU === 'number' ? '' : '（燃料重心）'}`, a + 2, y1 + 14);
    if (!c.orderData) {
      const from = c.from || 'top';
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, L = Math.min(x1 - x0, y1 - y0) * 0.35;
      const dir = { top: [0, 1], bottom: [0, -1], left: [1, 0], right: [-1, 0] }[from] || [0, 1];
      const sx = mx - dir[0] * L, sy = my - dir[1] * L, ex = mx + dir[0] * L, ey = my + dir[1] * L;
      ctx.strokeStyle = '#ffe36b'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - dir[0] * 12 - dir[1] * 8, ey - dir[1] * 12 + dir[0] * 8); ctx.lineTo(ex - dir[0] * 12 + dir[1] * 8, ey - dir[1] * 12 - dir[0] * 8); ctx.closePath(); ctx.fillStyle = '#ffe36b'; ctx.fill();
      ctx.lineWidth = 1;
      ctx.fillText(`从 ${({ top: '上', bottom: '下', left: '左', right: '右' })[from] || from} 往 ${({ top: '下', bottom: '上', left: '右', right: '左' })[from] || ''} 烧`, sx + 6, sy + 14);
    } else {
      ctx.fillStyle = '#ffd27a'; ctx.fillText('顺序：按顺序涂层（黑先白后）', x0 + 4, y1 + 28);
    }
  }
  // 着火点
  for (const p of (Array.isArray(doc.ignitionPoints) ? doc.ignitionPoints : [])) {
    if (!isObj(p) || typeof p.u !== 'number' || typeof p.v !== 'number') continue;
    const s = toScreen(p.u * W, p.v * Hh);
    const on = p.id === S.selPoint && !S.selGrip;
    ctx.fillStyle = on ? '#ffe36b' : '#ff8c3a'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(s[0], s[1], on ? 7 : 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.fillText(String(p.id), s[0] + 8, s[1] - 6);
  }
  // 握点
  const gp = gripOf(doc);
  const gs = toScreen(gp.u * W, gp.v * Hh);
  ctx.lineWidth = S.selGrip ? 2.5 : 1.5;
  ctx.strokeStyle = S.selGrip ? '#ffffff' : GRIP_RGB;
  if (gp.written) {
    ctx.fillStyle = 'rgba(108,240,224,.55)';
    ctx.beginPath(); ctx.arc(gs[0], gs[1], 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  } else {
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(gs[0], gs[1], 7, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.beginPath(); ctx.moveTo(gs[0] - 10, gs[1]); ctx.lineTo(gs[0] + 10, gs[1]); ctx.moveTo(gs[0], gs[1] - 10); ctx.lineTo(gs[0], gs[1] + 10); ctx.stroke();
  ctx.fillStyle = GRIP_RGB;
  ctx.fillText(gp.written ? '握点' : '握点（没写 = 底边中点）', gs[0] + 10, gs[1] + (gp.v > 0.9 ? 16 : -8));
  if (it && it.sim) drawSources(ctx, it.sim, it, (u, v) => toScreen(u * W, v * Hh), 'art');
  // 笔刷光标
  if ((S.tool === 'fuel' || S.tool === 'order') && V.mouse.inside) {
    const m = maskFor(S.tool === 'fuel' ? 'fuel' : 'order');
    if (m) {
      const r = S.brush.size * (W / m.w) * cam().k;
      ctx.strokeStyle = S.brush.erase ? '#ff6b6b' : '#ffffff'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(V.mouse.x, V.mouse.y, Math.max(1, r), 0, Math.PI * 2); ctx.stroke();
    }
  }
}

function renderViewInfo() {
  const box = el('viewInfo');
  const lines = [];
  if (S.rtErr) lines.push(['err', `⚠ 运行时包装不上：${S.rtErr}（本地预览 / 站位不可用）`]);
  if (S.glslErr) lines.push(['err', `⚠ burnShade.glsl：${S.glslErr}`]);
  if (V.gl && V.gl.err) lines.push(['err', `⚠ ${V.gl.err}`]);
  if (P.buildErr) lines.push(['err', `⚠ 预览建不起来：${P.buildErr}`]);
  if (S.view === 'scene' && S.sv && S.sv.scene) {
    const sc = S.sv.scene;
    lines.push(['', `只读场景视图「${sc.name}」（${sc.id}）· 空间：${P.sc.spaceKind === 'field' ? '场景载荷（field，与游戏同一份）' : '平面近似（planar）'}${sc.calNote ? ` · ${sc.calNote}` : ''} · 风：${P.sc.wind ? `${fmt(P.sc.wind.speed / 88, 1)} m/s` : '无'}`]);
    const errs = P.sc.problems.filter((p) => p.level === 'error').length;
    if (errs) lines.push(['err', `⚠ ${errs} 个实例游戏里建不起来（右栏「预览」里有原因）`]);
  }
  if (S.view === 'art') {
    const doc = S.docs[S.docId];
    const a = P.art && P.art.id === S.docId ? P.art : null;
    if (a && a.error) lines.push(['err', `⚠ ${a.error}`]);
    else if (a && doc) {
      const size = artSize();
      lines.push(['', `按真实尺寸预览：${doc.widthCm} × ${doc.heightCm} cm = ${fmt(a.size.width, 1)} × ${fmt(a.size.height, 1)} wu${size ? `（图 ${size[0]}×${size[1]} px）` : ''} · 平面空间 · 预览风：${S.wind.mps > 0 ? `${S.wind.mps} m/s 往${S.wind.dir < 0 ? '左' : '右'}` : '无'}`]);
      if (a.maskErr) lines.push(['warn', '燃料涂层读不出来：按没有涂层算（与游戏同）']);
      if (a.orderErr) lines.push(['warn', '顺序涂层读不出来：按方向算（与游戏同）']);
      if (a.grid && a.grid.fuelCells === 0) lines.push(['warn', '一格燃料都没有（alpha 阈值 / 涂层把它全抹了）：点不着']);
    }
  }
  box.textContent = '';
  for (const [k, s] of lines) box.append(h('div', { class: k, text: s }));
  box.hidden = !lines.length;
}

// ---------------------------------------------------------------------------
// 手势
// ---------------------------------------------------------------------------
function evPos(e) { const r = V.ov.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

/** 场景视图里点到的实例（画的顺序倒着找：在上面的先中）；没点在图上 = 实体锚点 10 px 内 */
function pickSceneItem(sx, sy) {
  const [wx, wy] = toWorld(sx, sy);
  const g = S.rt && S.rt.burnGeometry;
  for (let i = V.sceneHits.length - 1; i >= 0; i--) {
    const { it } = V.sceneHits[i];
    if (!g) break;
    const uv = g.burnSceneToUv(it.frame, wx, wy);
    if (uv.u >= 0 && uv.u <= 1 && uv.v >= 0 && uv.v <= 1) return { it, uv };
  }
  for (const it of P.sc.items) {
    const s = toScreen(it.ent.x, it.ent.y);
    if (Math.hypot(s[0] - sx, s[1] - sy) < 10) return { it, uv: null };
  }
  return null;
}
/** 原画视图里点到的把手：着火点或握点（离得最近的，11 px 内） */
function pickArtHandle(sx, sy) {
  const doc = S.docs[S.docId], size = artSize();
  if (!doc || !size) return null;
  let best = null, bd = 11;
  for (const p of Array.isArray(doc.ignitionPoints) ? doc.ignitionPoints : []) {
    if (!isObj(p)) continue;
    const s = toScreen(p.u * size[0], p.v * size[1]);
    const d = Math.hypot(s[0] - sx, s[1] - sy);
    if (d < bd) { bd = d; best = { kind: 'point', id: p.id }; }
  }
  const gp = gripOf(doc);
  const gs = toScreen(gp.u * size[0], gp.v * size[1]);
  const dg = Math.hypot(gs[0] - sx, gs[1] - sy);
  if (dg < bd) best = { kind: 'grip' };
  return best;
}
function uniquePointId(doc) {
  const used = new Set((doc.ignitionPoints || []).map((p) => p && p.id));
  let k = 1;
  while (used.has(`p${k}`)) k++;
  return `p${k}`;
}
const round4 = (v) => Math.round(v * 10000) / 10000;

function onMouseDown(e) {
  if (S.busy) return;
  V.ov.focus({ preventScroll: true });
  const [sx, sy] = evPos(e);
  if (e.button === 1 || (e.button === 0 && V.spaceDown)) {
    e.preventDefault();
    const c = cam();
    V.drag = { kind: 'pan', sx, sy, ox: c.ox, oy: c.oy };
    return;
  }
  if (S.view === 'scene') {
    if (e.button !== 0) return;
    const hit = pickSceneItem(sx, sy);
    if (S.tool === 'ignite') {
      if (hit && hit.uv && P.sc.sim) {
        addPreviewEvent({ sim: P.sc.sim, key: hit.it.key, it: hit.it, scene: true }, 'ignite', hit.uv.u, hit.uv.v);
        status(`预览：在「${hit.it.key}」(u ${fmt(hit.uv.u, 3)}, v ${fmt(hit.uv.v, 3)}) 点着 @ ${fmt(P.t, 2)} s`, 'ok');
      } else status('点在实例的图上才点得着', 'warn');
      return;
    }
    if (typeof selectEntity === 'function') selectEntity(hit ? hit.it.key : '');
    return;
  }
  // 原画视图
  const doc = S.docs[S.docId], size = artSize();
  if (!doc || !size) return;
  const [wx, wy] = toWorld(sx, sy);
  const u = clamp(wx / size[0], 0, 1), v = clamp(wy / size[1], 0, 1);
  if (S.tool === 'ignite' && e.button === 0) {
    const t = eventTarget();
    if (!t) { status('预览还没建起来', 'warn'); return; }
    addPreviewEvent(t, 'ignite', u, v);
    status(`预览：在 (u ${fmt(u, 3)}, v ${fmt(v, 3)}) 点着 @ ${fmt(P.t, 2)} s`, 'ok');
    return;
  }
  if (S.tool === 'point' && e.button === 0) {
    const id = uniquePointId(doc);
    edit(`加着火点 ${id}`, () => {
      if (!Array.isArray(doc.ignitionPoints)) doc.ignitionPoints = [];
      doc.ignitionPoints.push({ id, u: round4(u), v: round4(v) });
    });
    S.selPoint = id; S.selGrip = false;
    requestDraw();
    return;
  }
  if (S.tool === 'select' && e.button === 0) {
    const p = pickArtHandle(sx, sy);
    S.selPoint = p && p.kind === 'point' ? p.id : '';
    S.selGrip = !!(p && p.kind === 'grip');
    if (p) V.drag = { kind: p.kind, id: p.id, moved: false };
    if (typeof renderInspector === 'function') renderInspector();
    requestDraw();
    return;
  }
  if ((S.tool === 'fuel' || S.tool === 'order') && (e.button === 0 || e.button === 2)) {
    const kind = S.tool === 'fuel' ? 'fuel' : 'order';
    const m = maskFor(kind);
    if (!m || !m.ready) { status('涂层还在解码，稍等', 'warn'); return; }
    const erase = e.button === 2 || S.brush.erase;
    V.drag = { kind: 'brush', mask: kind, m, before: m.data.slice(), erase, last: null };
    strokeTo(sx, sy);
  }
}
function strokeTo(sx, sy) {
  const d = V.drag, size = artSize();
  if (!d || d.kind !== 'brush' || !size) return;
  const [wx, wy] = toWorld(sx, sy);
  const mx = wx / size[0] * d.m.w, my = wy / size[1] * d.m.h;
  const r = Math.max(0.5, S.brush.size);
  const target = d.erase ? 0 : Math.round(S.brush.value * 255);
  const pts = [];
  if (d.last) {
    const dist = Math.hypot(mx - d.last[0], my - d.last[1]);
    const step = Math.max(0.5, r * 0.35);
    for (let s = step; s <= dist; s += step) pts.push([d.last[0] + (mx - d.last[0]) * s / dist, d.last[1] + (my - d.last[1]) * s / dist]);
    if (!pts.length) return;
  } else pts.push([mx, my]);
  let changed = false;
  for (const p of pts) changed = brushDab(d.m, p[0], p[1], r, target, S.brush.strength) || changed;
  d.last = pts[pts.length - 1];
  if (changed) { paintMaskCanvas(d.mask, d.m); requestDraw(); }
}
function onMouseMove(e) {
  const [sx, sy] = evPos(e);
  V.mouse = { x: sx, y: sy, inside: sx >= 0 && sy >= 0 && sx <= V.w && sy <= V.h };
  const d = V.drag;
  if (!d) { if (S.tool === 'fuel' || S.tool === 'order') requestDraw(); return; }
  if (d.kind === 'pan') {
    const c = cam();
    c.ox = d.ox + (sx - d.sx); c.oy = d.oy + (sy - d.sy);
    requestDraw();
  } else if (d.kind === 'point' || d.kind === 'grip') {
    const doc = S.docs[S.docId], size = artSize();
    if (!doc || !size || S.view !== 'art') return;
    const [wx, wy] = toWorld(sx, sy);
    const u = round4(clamp(wx / size[0], 0, 1)), v = round4(clamp(wy / size[1], 0, 1));
    if (d.kind === 'point') {
      const p = Array.isArray(doc.ignitionPoints) ? doc.ignitionPoints.find((x) => x && x.id === d.id) : null;
      if (!p) return;
      if (!d.moved) { beginDrag(`拖着火点 ${d.id}`); d.moved = true; }
      p.u = u; p.v = v;
    } else {
      if (!d.moved) { beginDrag('拖握点'); d.moved = true; }
      doc.grip = { u, v };
    }
    refreshDirty();
    requestDraw();
  } else if (d.kind === 'brush') {
    strokeTo(sx, sy);
  }
}
function onMouseUp() {
  const d = V.drag;
  V.drag = null;
  if (!d) return;
  if ((d.kind === 'point' || d.kind === 'grip') && d.moved) endDrag();
  if (d.kind === 'brush') {
    const m = d.m;
    let same = m.data.length === d.before.length;
    if (same) for (let i = 0; i < m.data.length; i++) if (m.data[i] !== d.before[i]) { same = false; break; }
    if (same) return;
    const url = encodeMask(m);
    const doc = S.docs[m.docId];
    if (!doc) return;
    m.src = url;
    edit(d.mask === 'fuel' ? '涂燃料' : '涂顺序', () => {
      if (d.mask === 'fuel') { if (!isObj(doc.fuel)) doc.fuel = {}; doc.fuel.maskData = url; }
      else { if (!isObj(doc.consume)) doc.consume = {}; doc.consume.orderData = url; }
    });
  }
}
function onWheel(e) {
  e.preventDefault();
  const [sx, sy] = evPos(e);
  const c = cam();
  const f = Math.exp(-e.deltaY * 0.0015);
  const k2 = clamp(c.k * f, 1e-3, 400);
  const rf = k2 / c.k;
  c.ox = sx - (sx - c.ox) * rf; c.oy = sy - (sy - c.oy) * rf; c.k = k2;
  requestDraw();
}

function initViews() {
  V.ov = el('ov');
  V.ctx = V.ov.getContext('2d');
  V.gl = new BurnGL(el('gl'));
  if (V.gl.ok && S.glsl) V.gl.compile(S.glsl);
  else if (V.gl.ok) V.gl.err = `没有 burnShade.glsl：${S.glslErr || '?'}`;
  V.ov.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  V.ov.addEventListener('wheel', onWheel, { passive: false });
  V.ov.addEventListener('contextmenu', (e) => e.preventDefault());
  V.ov.addEventListener('mouseleave', () => { V.mouse.inside = false; requestDraw(); });
  el('btnViewArt').addEventListener('click', () => setView('art'));
  el('btnViewScene').addEventListener('click', () => setView('scene'));
  el('btnFit').addEventListener('click', () => fitView());
  el('brushSize').addEventListener('input', (e) => { S.brush.size = Number(e.target.value); requestDraw(); });
  el('brushStrength').addEventListener('input', (e) => { S.brush.strength = Number(e.target.value) / 100; });
  el('brushValue').addEventListener('input', (e) => { S.brush.value = Number(e.target.value) / 100; });
  el('brushErase').addEventListener('change', (e) => { S.brush.erase = e.target.checked; requestDraw(); });
  el('btnClearMask').addEventListener('click', () => {
    const doc = S.docs[S.docId];
    if (!doc) return;
    const kind = S.tool === 'order' ? 'order' : 'fuel';
    const had = !!maskSrc(doc, kind);
    if (!had) { status('这层本来就没有涂层', 'warn'); return; }
    edit(kind === 'fuel' ? '清燃料涂层' : '清顺序涂层', () => {
      if (kind === 'fuel') { delete doc.fuel.maskData; if (!Object.keys(doc.fuel).length) delete doc.fuel; }
      else { delete doc.consume.orderData; if (!Object.keys(doc.consume).length) delete doc.consume; }
    });
  });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => requestDraw()).observe(el('center'));
  window.addEventListener('resize', () => requestDraw());
  renderViewBar();
}
