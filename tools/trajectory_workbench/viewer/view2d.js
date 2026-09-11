'use strict';
/* 2D 画面视图：背景 + 参考层 + 全部段的烘焙曲线 + 活动段的把手 + gizmo + 幽灵。
 * 作者面主入口。工具模式（host.tool）：
 *   select  左键：点/把手拖动、点曲线选段、框选、Shift 多选；双击曲线插点；Delete 删点
 *   pen     左键：给活动手绘段追加点（按下即可拖动定位）；点线上插点；Esc/Enter 回 select
 *   physics 左键按下拖动：拖落点（活动段不是抛体就新建一段）
 *   slot    左键：放一个命名插槽（放完回 select）
 *   origin  左键：把曲线原点放到这儿（放完回 select）
 *   pan     左键拖平移
 *   任何模式：中键 / 空格+左键 / 右键拖 = 平移；滚轮 = 缩放；右键点在控制点上 = 删点
 *   世界空间：拖点 = 沿地面挪（射线打地面场）；点上方的 ▲ 把手（多选时）/ Alt+拖 = 改离地高度
 *   变换 gizmo（gizmo.js，与 3D 视图共用；选中 ≥1 点 / 整段 / 整条时立刻出现在轴心，加点模式下也在）：
 *     世界空间：X（画面右）/ Y(h)（竖直）/ Z（沿地面往远处，画上与 Y 重叠所以错开 16px 画成虚线）三根轴 + XZ 贴地面片 + 中心贴地走；
 *     画面空间：X / Y 两根轴 + 中心自由挪；W/E/R 切移动 / 旋转 / 缩放；拖动时 Ctrl 吸附；读数跟光标
 *   点幽灵（预览实体）= 选整条（幽灵就是"那个物体"，gizmo 落在曲线起点上）；点插槽 = 选它
 * 视图不写数据：一切改动经 host（app.js）落进 doc、进历史栈、触发重烘。 */

const HIT_R = 9;

class View2D {
  constructor(canvas, host) {
    this.c = canvas; this.g = canvas.getContext('2d'); this.host = host;
    this.zoom = 0.5; this.ox = 0; this.oy = 0;           // 画面 wu → 画布 px：cx = ox + sx*zoom
    this.drag = null; this.spaceDown = false; this.box = null; this.hover = null; this.readout = null;
    this.mouse = null;
    this.dpr = window.devicePixelRatio || 1;
    this._bind();
  }
  // ------------------------------------------------------------- 坐标
  toCanvas(sx, sy) { return [this.ox + sx * this.zoom, this.oy + sy * this.zoom]; }
  toScene(cx, cy) { return [(cx - this.ox) / this.zoom, (cy - this.oy) / this.zoom]; }
  fit() {
    const s = this.host.scene;
    if (!s) return;
    const W = this.c.clientWidth, H = this.c.clientHeight;
    if (W < 2 || H < 2) { this.pendingFit = 'scene'; return; }   // 还没排版（隐藏标签页 / 窗口未显示）：等 resize 再复位
    this.pendingFit = null;
    this.zoom = Math.min(W / s.worldWidth, H / s.worldHeight) * 0.96;
    this.ox = (W - s.worldWidth * this.zoom) / 2; this.oy = (H - s.worldHeight * this.zoom) / 2;
    this.draw();
  }
  /** 把整条轨迹（或活动段）框进视口。 */
  fitCurve() {
    const host = this.host;
    let b = Edit.bounds(host, 'all');
    if (!b && host.doc) { const o = Edit.originScreen(host); b = { x0: o[0] - 100, y0: o[1] - 100, x1: o[0] + 100, y1: o[1] + 100 }; }
    if (b && host.doc) for (const sl of Edit.slots(host.doc)) { b.x0 = Math.min(b.x0, num(sl.x, 0)); b.x1 = Math.max(b.x1, num(sl.x, 0)); b.y0 = Math.min(b.y0, num(sl.y, 0)); b.y1 = Math.max(b.y1, num(sl.y, 0)); }
    if (b && host.doc) { const o = Edit.originScreen(host); b.x0 = Math.min(b.x0, o[0]); b.x1 = Math.max(b.x1, o[0]); b.y0 = Math.min(b.y0, o[1]); b.y1 = Math.max(b.y1, o[1]); }
    if (!b) return this.fit();
    const pad = 120;
    const W = this.c.clientWidth, H = this.c.clientHeight;
    if (W < 2 || H < 2) { this.pendingFit = 'curve'; return; }
    this.pendingFit = null;
    const w = Math.max(b.x1 - b.x0 + pad * 2, 200), hh = Math.max(b.y1 - b.y0 + pad * 2, 200);
    this.zoom = clamp(Math.min(W / w, H / hh), 0.05, 6);
    this.ox = W / 2 - (b.x0 + b.x1) / 2 * this.zoom; this.oy = H / 2 - (b.y0 + b.y1) / 2 * this.zoom;
    this.draw();
  }
  resize() {
    const r = this.c.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.c.width = Math.max(1, Math.round(r.width * this.dpr)); this.c.height = Math.max(1, Math.round(r.height * this.dpr));
    if (this.pendingFit && r.width >= 2 && r.height >= 2) { const p = this.pendingFit; this.pendingFit = null; if (p === 'curve') this.fitCurve(); else this.fit(); return; }
    this.draw();
  }
  // ------------------------------------------------------------- 绘制
  draw() {
    const g = this.g, host = this.host;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const W = this.c.clientWidth, H = this.c.clientHeight;
    g.clearRect(0, 0, W, H);
    const s = host.scene;
    if (!s) { g.fillStyle = '#666'; g.font = '13px sans-serif'; g.fillText('先选一个烘焙场景', 20, 30); return; }
    const z = this.zoom, L = host.layers;
    if (host.bgImage) {
      g.imageSmoothingEnabled = z < 1;
      g.drawImage(host.bgImage, this.ox, this.oy, s.worldWidth * z, s.worldHeight * z);
    } else { g.fillStyle = '#222'; g.fillRect(this.ox, this.oy, s.worldWidth * z, s.worldHeight * z); }
    if (L.obstacles && host.obstacleCanvas) { g.globalAlpha = 0.45; g.drawImage(host.obstacleCanvas, this.ox, this.oy, s.worldWidth * z, s.worldHeight * z); g.globalAlpha = 1; }
    if (L.grid) this._grid(W, H);
    if (L.axis) this._perspAxis(s);
    if (L.npcs) this._npcs();
    const doc = host.doc;
    if (!doc) return;
    this._curves();
    const gz = this._gizmo();
    this._activeSegment(gz);
    this._slots();
    this._origin();
    if (L.ghost) { const prev = host.bake && host.bake.preview && host.bake.preview.screen; if (prev && prev.length) { const pose = sampleScreen(prev, host.tMs); if (pose) this._ghost(pose); } }
    if (gz) Gizmo.draw(g, gz, this._hotPart());
    if (this.box) { const b = this.box; g.strokeStyle = 'rgba(108,180,255,.9)'; g.fillStyle = 'rgba(108,180,255,.12)'; g.lineWidth = 1; g.setLineDash([4, 3]); g.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.setLineDash([]); }
    Gizmo.drawReadout(g, this.readout);
    g.font = '12px sans-serif';
    if (host.tool === 'slot') { g.fillStyle = '#5ad9cc'; g.fillText('点击画面放置一个命名插槽（曲线暴露给场景的位置）· Enter/Esc 结束', 12, H - 30); }
    if (host.tool === 'origin') { g.fillStyle = '#ffb454'; g.fillText('点击画面把曲线原点放到那儿（播放时给的位置对齐的就是它）· Enter/Esc 结束', 12, H - 30); }
    else if (host.tool === 'pen') { g.fillStyle = '#6cb4ff'; g.fillText('点击追加控制点 · 点在线上插点 · 刚加的点带着 gizmo，可直接拖轴 · Enter/Esc 结束', 12, H - 30); }
    else if (host.tool === 'physics') { g.fillStyle = '#ffb454'; g.fillText('按住拖动：把抛体落点拖到目标处', 12, H - 30); }
    else if (gz) { g.fillStyle = 'rgba(255,255,255,.6)'; const world = host.doc.space === 'world'; g.fillText({ move: world ? '移动（W）：红 X 沿画面右 · 绿 Y 改离地高度 · 蓝 Z 沿地面往远处 · 绿面片 / 中心 = 贴地走 · 拖点 = 贴地走' : '移动（W）：X / Y 箭头沿轴 · 中心 = 自由挪', rotate: world ? '旋转（E）：拖圆环 = 绕竖直轴' : '旋转（E）：拖圆环', scale: '缩放（R）：轴末端 = 单轴 · 中心 = 等比' }[gz.mode] + ' · 按住 Ctrl 吸附 · W/E/R 切模式', 12, H - 30); }
    else if (host.tool === 'select') { g.fillStyle = 'rgba(255,255,255,.45)'; g.fillText('点点 / 框选 = 选点 · 点曲线 = 选整段 · 点幽灵 = 选整条 · 点插槽 = 选它 · 选中即出现 gizmo（W/E/R 移动/旋转/缩放）', 12, H - 30); }
  }
  _grid(W, H) {
    const g = this.g, z = this.zoom;
    const cands = [10, 20, 50, 100, 200, 500, 1000, 2000];
    let step = cands.find((c) => c * z >= 48) || 2000;
    const [sx0, sy0] = this.toScene(0, 0), [sx1, sy1] = this.toScene(W, H);
    g.lineWidth = 1; g.font = '10px sans-serif';
    for (let x = Math.floor(sx0 / step) * step; x <= sx1; x += step) {
      const c = this.toCanvas(x, 0)[0]; const major = Math.round(x / step) % 5 === 0;
      g.strokeStyle = major ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.09)'; g.beginPath(); g.moveTo(c, 0); g.lineTo(c, H); g.stroke();
      if (major) { g.fillStyle = 'rgba(255,255,255,.5)'; g.fillText(String(x), c + 2, 10); }
    }
    for (let y = Math.floor(sy0 / step) * step; y <= sy1; y += step) {
      const c = this.toCanvas(0, y)[1]; const major = Math.round(y / step) % 5 === 0;
      g.strokeStyle = major ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.09)'; g.beginPath(); g.moveTo(0, c); g.lineTo(W, c); g.stroke();
      if (major) { g.fillStyle = 'rgba(255,255,255,.5)'; g.fillText(String(y), 2, c - 2); }
    }
  }
  _perspAxis(s) {
    const g = this.g, ps = s.perspectiveScale;
    if (!ps || !ps.near || !ps.far) return;
    const a = this.toCanvas(ps.near.x, ps.near.y), b = this.toCanvas(ps.far.x, ps.far.y);
    g.strokeStyle = 'rgba(255,255,255,.25)'; g.setLineDash([4, 6]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); g.setLineDash([]);
    g.fillStyle = 'rgba(255,255,255,.5)'; g.font = '10px sans-serif';
    g.fillText(`近 ×${fmt(ps.near.scale, 2)}`, a[0] + 4, a[1] - 3); g.fillText(`远 ×${fmt(ps.far.scale, 2)}`, b[0] + 4, b[1] - 3);
  }
  _npcs() {
    const g = this.g, host = this.host, z = this.zoom;
    for (const n of host.npcs()) {
      const c = this.toCanvas(n.x, n.y);
      const img = host.npcImage(n.id);
      if (img && img.img) {
        const m = img.meta, w = m.worldWidth * m.scale * z, hh = m.worldHeight * m.scale * z;
        g.globalAlpha = 0.55; g.drawImage(img.img, c[0] - m.anchor.x * w, c[1] - m.anchor.y * hh, w, hh); g.globalAlpha = 1;
      }
      g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1; g.beginPath(); g.moveTo(c[0] - 6, c[1]); g.lineTo(c[0] + 6, c[1]); g.moveTo(c[0], c[1] - 6); g.lineTo(c[0], c[1] + 6); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.75)'; g.font = '11px sans-serif'; g.fillText(n.name, c[0] + 7, c[1] + 12);
    }
  }
  /** 全部段的曲线（按段切片；活动段粗、其余细），落点线，硬帧刻度，时间刻度。
   *  手绘段画的是**几何路径**（控制点过样条的密折线），不是烘焙采样：烘焙采样按时间等距，时间曲线一改，
   *  快的地方采样稀、折线切角，看起来像"时间曲线把曲线位置改了"（2026-09-11 制作人抓到）。采样只留刻度。
   *  抛体段的位置本来就是时间积分出来的，仍画烘焙采样。 */
  _curves() {
    const g = this.g, host = this.host;
    const slices = host.previewSlices();
    const segsAll = Edit.segs(host.doc);
    // 烘焙没回来之前也要有形状：按段走，手绘段的几何不吃烘焙；抛体段等烘焙
    for (let i = 0; i < segsAll.length; i++) {
      const on = i === host.segIndex;
      if (!on && !host.layers.allCurves) continue;
      const segI = segsAll[i];
      const sl = slices.find((s) => s.i === i) || { i, pts: [], foot: [], hard: [], ticks: [], start: host.segStartScreen(segI), label: segI.id };
      const geo = segI.kind === 'manual' ? host.localCurve(segI) : null;
      const line = geo && geo.length > 1 ? geo : sl.pts;
      g.lineWidth = on ? 2.5 : 1.5; g.strokeStyle = on ? '#6cb4ff' : 'rgba(108,180,255,.45)'; g.beginPath();
      line.forEach((p, k) => { const c = this.toCanvas(p[0], p[1]); if (k) g.lineTo(c[0], c[1]); else g.moveTo(c[0], c[1]); });
      g.stroke();
      if (on || host.layers.allCurves) {
        g.lineWidth = 1; g.strokeStyle = on ? 'rgba(255,180,84,.8)' : 'rgba(255,180,84,.3)'; g.beginPath();
        sl.foot.forEach((p, k) => { const c = this.toCanvas(p[0], p[1]); if (k) g.lineTo(c[0], c[1]); else g.moveTo(c[0], c[1]); });
        g.stroke();
      }
      if (on) {
        g.strokeStyle = '#ff6b6b';
        for (const p of sl.hard) { const c = this.toCanvas(p[0], p[1]); g.beginPath(); g.moveTo(c[0], c[1] - 5); g.lineTo(c[0], c[1] + 5); g.stroke(); }
        g.fillStyle = 'rgba(255,255,255,.7)';
        for (const p of sl.ticks) { const c = this.toCanvas(p[0], p[1]); g.beginPath(); g.arc(c[0], c[1], 1.6, 0, Math.PI * 2); g.fill(); }
      }
      // 段边界
      const st = this.toCanvas(sl.start[0], sl.start[1]);
      g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.arc(st[0], st[1], 3, 0, Math.PI * 2); g.fill();
      if (host.layers.allCurves && !on) { g.fillStyle = 'rgba(255,255,255,.6)'; g.font = '10px sans-serif'; g.fillText(sl.label, st[0] + 5, st[1] - 5); }
    }
  }
  _activeSegment(gz) {
    const g = this.g, host = this.host;
    const seg = host.activeSeg(); if (!seg) return;
    const soloGizmo = !!(gz && gz.n === 1);   // 单选：gizmo 的 Y 箭头就在 ▲ 的位置，不重复画
    const world = host.doc.space === 'world';
    if (seg.kind === 'manual') {
      const pts = host.effPoints(seg);
      // 几何路径已在 _curves 里画成实线（烘焙没回来之前也在：它不吃烘焙）；这里只画控制多边形和点
      // 控制多边形
      g.strokeStyle = 'rgba(255,255,255,.3)'; g.lineWidth = 1; g.setLineDash([3, 4]); g.beginPath();
      pts.forEach((p, i) => { const c = this.toCanvas(p.sx, p.sy); if (i) g.lineTo(c[0], c[1]); else g.moveTo(c[0], c[1]); });
      g.stroke(); g.setLineDash([]);
      const pinned = host.pinned(seg);
      pts.forEach((p, i) => {
        const c = this.toCanvas(p.sx, p.sy);
        const sel = host.sel.points.has(i);
        if (world && p.foot) { const f = this.toCanvas(p.foot[0], p.foot[1]); g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 1; g.beginPath(); g.moveTo(c[0], c[1]); g.lineTo(f[0], f[1]); g.stroke(); g.fillStyle = 'rgba(255,180,84,.8)'; g.beginPath(); g.arc(f[0], f[1], 2.5, 0, Math.PI * 2); g.fill(); }
        g.fillStyle = sel ? '#6cb4ff' : (i === 0 && pinned ? '#9a9a9a' : '#fff');
        g.beginPath(); if (i === 0 && pinned) g.rect(c[0] - 5, c[1] - 5, 10, 10); else g.arc(c[0], c[1], sel ? 6 : 4.5, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#000'; g.lineWidth = 1; g.stroke();
        g.fillStyle = '#ddd'; g.font = '10px sans-serif'; g.fillText(String(i), c[0] + 7, c[1] + 11);
        if (world) { g.fillStyle = sel ? '#fff' : '#bbb'; g.font = '11px sans-serif'; g.fillText('h ' + fmt(p.h), c[0] + 7, c[1] - 6); }
        if (world && sel && !soloGizmo) { // 高度把手 ▲
          const hy = c[1] - 18; g.fillStyle = '#ffb454'; g.beginPath(); g.moveTo(c[0], hy - 6); g.lineTo(c[0] - 5, hy + 3); g.lineTo(c[0] + 5, hy + 3); g.closePath(); g.fill();
          g.strokeStyle = 'rgba(255,180,84,.6)'; g.beginPath(); g.moveTo(c[0], hy + 3); g.lineTo(c[0], c[1] - 7); g.stroke();
        }
      });
    } else if (seg.kind === 'physics') {
      const pi = host.physicsInfo(seg); if (!pi) return;
      const a = this.toCanvas(pi.start[0], pi.start[1]), b = this.toCanvas(pi.tip[0], pi.tip[1]);
      // 解析飞行弧（第一跳，本地）
      if (pi.arc && pi.arc.length > 1) {
        g.strokeStyle = 'rgba(255,180,84,.55)'; g.lineWidth = 1.5; g.setLineDash([5, 4]); g.beginPath();
        pi.arc.forEach((p, k) => { const c = this.toCanvas(p[0], p[1]); if (k) g.lineTo(c[0], c[1]); else g.moveTo(c[0], c[1]); });
        g.stroke(); g.setLineDash([]);
      }
      // 起点
      const pinned = host.pinned(seg);
      g.fillStyle = pinned ? '#9a9a9a' : '#fff'; g.beginPath(); g.rect(a[0] - 5, a[1] - 5, 10, 10); g.fill(); g.strokeStyle = '#000'; g.stroke();
      // 初速箭头
      g.strokeStyle = '#ffb454'; g.lineWidth = 2; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      this._arrowHead(a, b, '#ffb454');
      g.fillStyle = '#ffb454'; g.beginPath(); g.arc(b[0], b[1], 6, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#000'; g.stroke();
      g.fillStyle = '#ddd'; g.font = '11px sans-serif';
      const v = seg.v0 || {};
      g.fillText(world ? `v0 (${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)})` : `v0 (${fmt(v.x)}, ${fmt(v.y)})`, b[0] + 9, b[1] + 4);
      // 最高点
      if (pi.apex) { const c = this.toCanvas(pi.apex[0], pi.apex[1]); g.fillStyle = '#c792ea'; g.beginPath(); g.arc(c[0], c[1], 5.5, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#000'; g.stroke(); g.fillStyle = '#c792ea'; g.fillText('最高点 ⇅', c[0] + 8, c[1] - 6); }
      // 落点
      if (!pi.grounded) {
        const c = this.toCanvas(pi.landing[0], pi.landing[1]);
        g.fillStyle = '#7ed492'; g.beginPath(); g.moveTo(c[0], c[1] - 8); g.lineTo(c[0] + 8, c[1]); g.lineTo(c[0], c[1] + 8); g.lineTo(c[0] - 8, c[1]); g.closePath(); g.fill(); g.strokeStyle = '#000'; g.stroke();
        g.fillStyle = '#7ed492'; g.fillText(`落点 ${fmt(pi.t * 1000, 0)}ms`, c[0] + 10, c[1] + 4);
      } else { g.fillStyle = '#7ed492'; g.fillText('起点贴地：拖箭尖往上抛，或用抛体工具拖落点', a[0] + 12, a[1] + 22); }
      if (!world && typeof seg.groundY === 'number') {
        const y = this.toCanvas(0, seg.groundY)[1];
        g.strokeStyle = 'rgba(126,212,146,.85)'; g.lineWidth = 1.5; g.setLineDash([8, 6]);
        g.beginPath(); g.moveTo(0, y); g.lineTo(this.c.clientWidth, y); g.stroke(); g.setLineDash([]);
        // 左缘专用把手：曲线常躺在地面线上，线本身让给曲线，这个把手永远抓得到
        g.fillStyle = '#7ed492'; g.beginPath(); g.moveTo(14, y - 7); g.lineTo(34, y - 7); g.lineTo(40, y); g.lineTo(34, y + 7); g.lineTo(14, y + 7); g.closePath(); g.fill();
        g.strokeStyle = '#000'; g.lineWidth = 1; g.stroke();
        g.fillStyle = '#7ed492'; g.font = '11px sans-serif'; g.fillText('地面线 y=' + fmt(seg.groundY) + '（拖左缘把手）', 46, y + 4);
      }
    }
  }
  _arrowHead(a, b, color) {
    const g = this.g, ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    g.fillStyle = color; g.beginPath(); g.moveTo(b[0], b[1]);
    g.lineTo(b[0] - 11 * Math.cos(ang - 0.4), b[1] - 11 * Math.sin(ang - 0.4)); g.lineTo(b[0] - 11 * Math.cos(ang + 0.4), b[1] - 11 * Math.sin(ang + 0.4)); g.closePath(); g.fill();
  }
  // ------------------------------------------------------------- 变换 gizmo（gizmo.js 共用；这里只提供 projector）
  /** 原画视图的 projector：世界空间走场景标定（R 投影，正交，1 wu = 1 画面 wu × zoom）；画面空间就是画布本身。 */
  _proj() {
    const host = this.host, cal = host.cal, v = this;
    if (host.doc && host.doc.space === 'world' && cal) {
      const R = cal.rows;
      const axisPx = (a) => { const o = cal.projectOffset(a[0], a[1], a[2]); return [o[0] * v.zoom, o[1] * v.zoom]; };
      const project = (p) => { const s = cal.worldToScene(p[0], p[1], p[2]); return v.toCanvas(s[0], s[1]); };
      return {
        dim: 3, project, worldPerPx: () => 1 / v.zoom,
        axisParam: (mx, my, p0, a) => { const c = project(p0), s = axisPx(a), l2 = s[0] * s[0] + s[1] * s[1]; return l2 < 1e-6 ? null : ((mx - c[0]) * s[0] + (my - c[1]) * s[1]) / l2; },
        planePoint: (mx, my, p0, a, b) => {
          const c = project(p0), A = axisPx(a), B = axisPx(b), det = A[0] * B[1] - A[1] * B[0];
          if (Math.abs(det) < 1e-3) return null;   // 面对着视线（原画里的 YZ 面）
          const dx = mx - c[0], dy = my - c[1]; const u = (dx * B[1] - dy * B[0]) / det, w = (A[0] * dy - A[1] * dx) / det;
          return [p0[0] + a[0] * u + b[0] * w, p0[1] + a[1] * u + b[1] * w, p0[2] + a[2] * u + b[2] * w];
        },
        groundPoint: (mx, my) => { const s = v.toScene(mx, my); return cal.inScene(s[0], s[1]) ? cal.sceneToWorldGround(s[0], s[1]) : null; },
        viewPlanePoint: (mx, my, p0) => { const c = project(p0), r = cal.screenRightWorld(), u = cal.screenUpWorld(); const dx = (mx - c[0]) / v.zoom, dy = -(my - c[1]) / v.zoom; return [p0[0] + r[0] * dx + u[0] * dy, p0[1] + r[1] * dx + u[1] * dy, p0[2] + r[2] * dx + u[2] * dy]; },
        eyeAbove: () => R[5] < 0,   // 视线（q 的 +z 过 R）朝下 = 相机在上
      };
    }
    const project = (p) => v.toCanvas(p[0], p[1]);
    return {
      dim: 2, project, worldPerPx: () => 1 / v.zoom,
      axisParam: (mx, my, p0, a) => { const c = project(p0), s = [a[0] * v.zoom, a[1] * v.zoom], l2 = s[0] * s[0] + s[1] * s[1]; return l2 < 1e-6 ? null : ((mx - c[0]) * s[0] + (my - c[1]) * s[1]) / l2; },
      planePoint: (mx, my) => v.toScene(mx, my),   // 画面就是那个面
      groundPoint: (mx, my) => v.toScene(mx, my),
      viewPlanePoint: (mx, my) => v.toScene(mx, my),
      eyeAbove: () => true,
    };
  }
  /** gizmo 几何；null = 不显示（没选中 / 不在选择、加点工具） */
  _gizmo() {
    const host = this.host;
    if (!host.doc || (host.tool !== 'select' && host.tool !== 'pen')) return null;
    const pv = host.gizmoPivot(); if (!pv) return null;
    return Gizmo.geom(this._proj(), GZ_CFG.build(host.doc.space === 'world' ? GZ_CFG.world2 : GZ_CFG.screen, pv.kind), pv.pivot, host.gizmoMode, pv.n, pv.label);
  }
  _hotPart() { return this.drag && this.drag.kind === 'gz' ? this.drag.part : (this.hover && this.hover.kind === 'gz' ? this.hover.part : null); }
  /** 按下 gizmo 把手：选中的是把手（初速 / 最高点 / 落点 / 起点 / 锚点）→ 走它自己的设置器；否则走变换管线 */
  _gzDown(part, mx, my) {
    const g = this._gizmo(); if (!g) return;
    const host = this.host;
    const d = Gizmo.dragBegin(this._proj(), g, part, mx, my);
    if (host.sel.handle) { d.handle = host.sel.handle; d.base = host.handleBase(d.handle); if (!d.base) return; this.drag = d; host.dragBegin('移动' + host.handleLabel(d.handle)); return; }
    this.drag = d; host.beginTransform();
  }
  _gzMove(d, mx, my, e) {
    const host = this.host;
    const res = Gizmo.dragUpdate(this._proj(), d, mx, my, e.ctrlKey || e.metaKey); if (!res) return;
    this.readout = { x: mx + 16, y: my + 22, text: res.text };
    if (d.handle) { if (res.kind === 'move') host.dragTick(() => host.applyHandle(d.handle, d.base, res.v)); return; }
    const T = Gizmo.toTransform(res, host.doc.space === 'world', host._pivotNative()); if (!T) return;
    host.applyTransform(T);
  }
  /** 幽灵（预览实体）在画布上的矩形（点它 = 选整条）；没画幽灵时 null */
  _ghostRect() {
    const host = this.host, ent = host.entity;
    const prev = host.layers.ghost && host.bake && host.bake.preview && host.bake.preview.screen;
    if (!prev || !prev.length) return null;
    const pose = sampleScreen(prev, host.tMs); if (!pose) return null;
    const c = this.toCanvas(pose.x, pose.y);
    const persp = host.layers.persp ? perspectiveScaleAt(host.scene.perspectiveScale, pose.x, pose.sortY) : 1;
    if (ent && ent.img) {
      const w = ent.meta.worldWidth * ent.meta.scale * persp * this.zoom * Math.abs(pose.sx), hgt = ent.meta.worldHeight * ent.meta.scale * persp * this.zoom * Math.abs(pose.sy);
      const ax = ent.meta.anchor.x, ay = ent.meta.anchor.y;
      return { x0: c[0] - ax * w, y0: c[1] - ay * hgt, x1: c[0] + (1 - ax) * w, y1: c[1] + (1 - ay) * hgt };
    }
    const r = Math.max(6, 8 * this.zoom * persp);
    return { x0: c[0] - r, y0: c[1] - r, x1: c[0] + r, y1: c[1] + r };
  }
  /** 命名插槽：地面上的站位（青绿菱形 + 名字）。曲线没有锚点了；首段起点就是曲线起点，可拖。 */
  _slots() {
    const g = this.g, host = this.host;
    for (const sl of Edit.slots(host.doc)) {
      const c = this.toCanvas(num(sl.x, 0), num(sl.y, 0));
      const on = host.sel.handle === 'slot:' + sl.id;
      g.fillStyle = on ? '#ffe44d' : '#5ad9cc'; g.beginPath(); g.moveTo(c[0], c[1] - 9); g.lineTo(c[0] + 9, c[1]); g.lineTo(c[0], c[1] + 9); g.lineTo(c[0] - 9, c[1]); g.closePath(); g.fill();
      g.strokeStyle = '#000'; g.lineWidth = 1; g.stroke();
      g.fillStyle = on ? '#ffe44d' : '#5ad9cc'; g.font = '11px sans-serif'; g.fillText('插槽 ' + (sl.label || sl.id), c[0] + 12, c[1] - 6);
    }
  }
  /** 曲线原点：橙色十字 + 圈。播放位置对齐的就是它，所以必须一眼看得见、能单独拖。 */
  _origin() {
    const g = this.g, host = this.host;
    const o = Edit.originScreen(host); if (!o) return;
    const c = this.toCanvas(o[0], o[1]);
    const on = host.sel.handle === 'origin';
    g.strokeStyle = on ? '#ffe44d' : '#ffb454'; g.lineWidth = on ? 2.5 : 2;
    g.beginPath(); g.moveTo(c[0] - 11, c[1]); g.lineTo(c[0] + 11, c[1]); g.moveTo(c[0], c[1] - 11); g.lineTo(c[0], c[1] + 11); g.stroke();
    g.beginPath(); g.arc(c[0], c[1], 6, 0, Math.PI * 2); g.stroke();
    g.fillStyle = on ? '#ffe44d' : '#ffb454'; g.font = '11px sans-serif';
    g.fillText(Edit.hasOrigin(host) ? '原点' : '原点（跟着起点）', c[0] + 13, c[1] + 13);
  }
  _ghost(pose) {
    const g = this.g, host = this.host, ent = host.entity;
    const c = this.toCanvas(pose.x, pose.y);
    const persp = host.layers.persp ? perspectiveScaleAt(host.scene.perspectiveScale, pose.x, pose.sortY) : 1;
    if (ent && ent.img) {
      const w = ent.meta.worldWidth * ent.meta.scale * persp * this.zoom;
      const hgt = ent.meta.worldHeight * ent.meta.scale * persp * this.zoom;
      const ax = ent.meta.anchor.x, ay = ent.meta.anchor.y;
      const mirror = ent.meta.facing === 'left' ? -1 : 1;
      g.save(); g.translate(c[0], c[1]); g.rotate(pose.rot * Math.PI / 180 * mirror); g.scale(pose.sx * mirror, pose.sy);
      g.globalAlpha = clamp(pose.alpha, 0, 1);
      g.drawImage(ent.img, -ax * w, -ay * hgt, w, hgt);
      g.restore();
    } else {
      g.save(); g.translate(c[0], c[1]); g.rotate(pose.rot * Math.PI / 180); g.scale(pose.sx, pose.sy);
      g.globalAlpha = clamp(pose.alpha, 0, 1) * 0.8; g.fillStyle = '#6cb4ff';
      const r = 8 * this.zoom * persp;
      g.beginPath(); g.arc(0, 0, Math.max(3, r), 0, Math.PI * 2); g.fill(); g.restore();
    }
    const f = this.toCanvas(pose.x, pose.sortY);
    g.strokeStyle = '#ffb454'; g.lineWidth = 1; g.beginPath(); g.moveTo(f[0] - 10, f[1]); g.lineTo(f[0] + 10, f[1]); g.stroke();
  }
  // ------------------------------------------------------------- 拾取
  /** 返回 {kind, ...}。优先级：gizmo 轴 / 面 / 环 > 地面线把手 > 锚点 > 活动段把手 > gizmo 中心（单点选中时它压在点上，拖点得还是拖点）> 幽灵 > 任一段曲线。 */
  _hit(mx, my) {
    const host = this.host, seg = host.activeSeg();
    if (!host.doc) return null;
    const near = (p, r) => Math.hypot(p[0] - mx, p[1] - my) <= (r || HIT_R);
    const gz = this._gizmo(); const part = gz ? Gizmo.hit(gz, mx, my) : null;
    const world = host.doc.space === 'world';
    const slotHit = () => {
      for (const sl of Edit.slots(host.doc)) { if (near(this.toCanvas(num(sl.x, 0), num(sl.y, 0)), 10)) return { kind: 'slot', id: sl.id }; }
      const o = Edit.originScreen(host);
      if (o && near(this.toCanvas(o[0], o[1]), 10)) return { kind: 'origin' };
      return null;
    };
    // 地面线左缘把手（画面空间抛体段）：优先级最高，曲线躺在线上也抓得到
    if (seg && seg.kind === 'physics' && !world && typeof seg.groundY === 'number') { const y = this.toCanvas(0, seg.groundY)[1]; if (mx >= 10 && mx <= 44 && Math.abs(my - y) <= 9) return { kind: 'ground' }; }
    // 1. 小目标（控制点 / 抛体把手 / 锚点）先于 gizmo 的轴、面：别的点正好躺在轴线上时点它得选它——
    //    不然"选这个点，动的是另一个点"（2026-09-11 制作人抓到）。中心与小目标重合时见下面的规则。
    let small = null;
    if (seg && seg.kind === 'manual') {
      const pts = host.effPoints(seg);
      if (world && !(gz && gz.n === 1)) for (let i = pts.length - 1; i >= 0 && !small; i--) { if (host.sel.points.has(i)) { const c = this.toCanvas(pts[i].sx, pts[i].sy); if (Math.abs(c[0] - mx) <= 7 && my >= c[1] - 26 && my <= c[1] - 12) small = { kind: 'height', i }; } }
      for (let i = pts.length - 1; i >= 0 && !small; i--) { const p = this.toCanvas(pts[i].sx, pts[i].sy); if (near(p)) small = { kind: 'point', i }; }
      if (!small) small = slotHit();
    } else if (seg && seg.kind === 'physics') {
      const pi = host.physicsInfo(seg);
      if (pi) {
        if (near(this.toCanvas(pi.tip[0], pi.tip[1]), HIT_R + 2)) small = { kind: 'v0' };
        else if (!pi.grounded && near(this.toCanvas(pi.landing[0], pi.landing[1]), 11)) small = { kind: 'landing' };
        else if (pi.apex && near(this.toCanvas(pi.apex[0], pi.apex[1]), 9)) small = { kind: 'apex' };
        else { const sc = this.toCanvas(pi.start[0], pi.start[1]); if (near(sc, 9)) small = { kind: 'start' }; }
      }
      if (!small) small = slotHit();
    } else small = slotHit();
    if (small) {
      // 整段 / 整条的轴心就压在起点 / 锚点上：中心必须赢（钉住的起点本来也拖不动）；选中点 / 把手时中心让给小目标（同一个操作）
      if (part && Gizmo.isCenter(part) && (host.sel.scope === 'segment' || host.sel.scope === 'all') && !host.sel.handle) return { kind: 'gz', part };
      return small;
    }
    if (part) return { kind: 'gz', part };   // 两点的质心正好躺在控制多边形的边上：gizmo 先于边
    if (seg && seg.kind === 'manual') {
      const pts = host.effPoints(seg);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = this.toCanvas(pts[i].sx, pts[i].sy), b = this.toCanvas(pts[i + 1].sx, pts[i + 1].sy);
        if (distToSeg(mx, my, a, b) <= 6) return { kind: 'edge', i };
      }
      const local = host.localCurve(seg);
      if (local && local.length > 1) for (let i = 0; i < local.length - 1; i++) { const a = this.toCanvas(local[i][0], local[i][1]), b = this.toCanvas(local[i + 1][0], local[i + 1][1]); if (distToSeg(mx, my, a, b) <= 6) return { kind: 'edge', i: host.localEdgeToPointIndex(seg, i) }; }
    }
    // 幽灵 = "那个物体"：点它选整条
    const gr = this._ghostRect();
    if (gr && mx >= gr.x0 && mx <= gr.x1 && my >= gr.y0 && my <= gr.y1) return { kind: 'ghost' };
    // 任一段的烘焙曲线
    for (const sl of host.previewSlices()) {
      for (let k = 0; k < sl.pts.length - 1; k++) {
        const a = this.toCanvas(sl.pts[k][0], sl.pts[k][1]), b = this.toCanvas(sl.pts[k + 1][0], sl.pts[k + 1][1]);
        if (distToSeg(mx, my, a, b) <= 6) return { kind: 'curve', i: sl.i };
      }
    }
    // 地面线最后（贴地滚动的曲线就躺在它上面，不能抢在曲线前面）
    if (seg && seg.kind === 'physics' && !world && typeof seg.groundY === 'number') { const y = this.toCanvas(0, seg.groundY)[1]; if (Math.abs(y - my) <= 7) return { kind: 'ground' }; }
    return null;
  }
  // ------------------------------------------------------------- 交互
  _bind() {
    const c = this.c;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k = Math.exp(-e.deltaY * 0.0012);
      const nz = clamp(this.zoom * k, 0.02, 20);
      this.ox = mx - (mx - this.ox) * (nz / this.zoom); this.oy = my - (my - this.oy) * (nz / this.zoom); this.zoom = nz;
      this.draw();
    }, { passive: false });
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !isTyping(e)) { this.spaceDown = true; e.preventDefault(); } });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.spaceDown = false; });
    c.addEventListener('mousedown', (e) => this._down(e));
    c.addEventListener('dblclick', (e) => this._dbl(e));
    window.addEventListener('mousemove', (e) => this._move(e));
    window.addEventListener('mouseup', (e) => this._up(e));
    c.addEventListener('mouseleave', () => { this.host.onCursor(null); });
  }
  _pos(e) { const r = this.c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  _down(e) {
    const [mx, my] = this._pos(e);
    const host = this.host;
    this.c.focus && this.c.focus();
    if (e.button === 1 || this.spaceDown || host.tool === 'pan' || !host.doc) { this.drag = { kind: 'pan', mx, my, ox: this.ox, oy: this.oy }; return; }
    const s = this.toScene(mx, my);
    const hit = this._hit(mx, my);
    if (e.button === 2) {
      // 右键：点上删点；否则右键拖平移
      this.drag = { kind: 'pan', mx, my, ox: this.ox, oy: this.oy, rightHit: hit, moved: false };
      return;
    }
    if (e.button !== 0) return;
    const tool = host.tool;
    if (tool === 'slot') { host.placeSlotScreen(s[0], s[1]); host.setTool('select'); this.draw(); return; }
    if (tool === 'origin') { host.placeOriginScreen(s[0], s[1]); host.setTool('select'); this.draw(); return; }
    if (hit && hit.kind === 'gz' && (tool === 'select' || tool === 'pen')) { this._gzDown(hit.part, mx, my); return; }
    if (tool === 'pen') { this._penDown(mx, my, s, hit, e); return; }
    if (tool === 'physics') { this._physicsDown(s); return; }
    // select
    if (hit && hit.kind === 'slot') { const sl = Edit.findSlot(host.doc, hit.id); host.selectHandle('slot:' + hit.id); this.drag = { kind: 'slot', id: hit.id, mx, my, s0: [num(sl.x, 0), num(sl.y, 0)] }; host.dragBegin('移动插槽'); this.draw(); return; }
    if (hit && hit.kind === 'origin') { host.selectHandle('origin'); this.drag = { kind: 'origin', mx, my, s0: Edit.originScreen(host).slice() }; host.dragBegin('移动曲线原点'); this.draw(); return; }
    const seg = host.activeSeg();
    if (hit && hit.kind === 'height') { const p = host.effPoints(seg)[hit.i]; this.drag = { kind: 'height', i: hit.i, my, h0: p.h }; host.dragBegin('改离地高度'); return; }
    if (hit && hit.kind === 'point') {
      if (e.shiftKey || e.ctrlKey || e.metaKey) { host.togglePoint(hit.i); this.draw(); return; }
      if (!host.sel.points.has(hit.i)) host.selectPoint(hit.i, false);
      const n = host.effPoints(seg).length;
      if (host.pinned(seg) && host.sel.points.has(0)) {
        if (host.sel.points.size === 1) { host.status('起点被锚住（锚点 / 上一段末点），拖不动；要整段挪切"整段"范围拖 gizmo（会把起点改成"自定"），要自由起点在右栏把起点改成"自定"'); this.draw(); return; }
        if (host.sel.points.size === n) { host.selectSegmentScope(host.segIndex); this._gzDown('c', mx, my); return; }
        host.status('选中的点里有锁定的起点：它不跟着动（要整段挪选"整段"范围）');
      }
      const starts = [...host.sel.points].filter((i) => !(i === 0 && host.pinned(seg))).map((i) => { const p = host.effPoints(seg)[i]; return { i, sx: p.sx, sy: p.sy, h: p.h }; });
      this.drag = { kind: 'points', mx, my, starts, alt: e.altKey, moved: false };
      host.dragBegin(e.altKey ? '改离地高度' : '移动控制点');
      this.draw(); return;
    }
    if (hit && hit.kind === 'v0') { host.selectHandle('v0'); this.drag = { kind: 'v0', alt: e.altKey, my, v0: Object.assign({}, seg.v0 || {}) }; host.dragBegin('改初速'); this.draw(); return; }
    if (hit && hit.kind === 'landing') { host.selectHandle('landing'); const pi = host.physicsInfo(seg); this.drag = { kind: 'landing', my, l0: pi.landing.slice(), gy: seg.groundY }; host.dragBegin('拖落点'); this.draw(); return; }
    if (hit && hit.kind === 'apex') { host.selectHandle('apex'); const pi = host.physicsInfo(seg); this.drag = { kind: 'apex', my, a0: pi.apex.slice() }; host.dragBegin('改最高点'); this.draw(); return; }
    if (hit && hit.kind === 'start') {
      if (host.pinned(seg)) { host.status('起点被锚住（锚点 / 上一段末点）；要自由起点把起点改成"自定"'); host.selectSegmentScope(host.segIndex); this.draw(); return; }
      host.selectHandle('start'); const pi = host.physicsInfo(seg); this.drag = { kind: 'start', mx, my, s0: pi.start.slice() }; host.dragBegin('移动起点'); this.draw(); return;
    }
    if (hit && hit.kind === 'ground') { this.drag = { kind: 'ground', my, gy: seg.groundY }; host.dragBegin('改地面线'); return; }
    if (hit && hit.kind === 'edge') { host.selectSegmentScope(host.segIndex); this.draw(); return; }
    if (hit && hit.kind === 'ghost') { host.setScope('all'); host.status('已选中整条轨迹（幽灵 = 那个物体）：gizmo 在锚点上，移动 = 挪锚点、旋转 / 缩放以锚点为轴'); this.draw(); return; }
    if (hit && hit.kind === 'curve') { host.selectSegmentScope(hit.i); this.draw(); return; }
    // 还没有任何分段：直接在画布上点 = 开始画线（自动建手绘段，进入加点模式）
    if (!Edit.segs(host.doc).length) { host.setTool('pen'); this._penDown(mx, my, s, null, e); return; }
    // 空白：框选
    this.drag = { kind: 'box', mx, my, shift: e.shiftKey };
    this.box = { x0: mx, y0: my, x1: mx, y1: my };
  }
  _penDown(mx, my, s, hit, e) {
    const host = this.host;
    if (hit && hit.kind === 'point') { host.selectPoint(hit.i, false); const seg = host.activeSeg(); const p = host.effPoints(seg)[hit.i]; this.drag = { kind: 'points', mx, my, starts: [{ i: hit.i, sx: p.sx, sy: p.sy, h: p.h }], alt: e.altKey, moved: false }; host.dragBegin('移动控制点'); this.draw(); return; }
    if (hit && hit.kind === 'slot') { const sl = Edit.findSlot(host.doc, hit.id); host.selectHandle('slot:' + hit.id); this.drag = { kind: 'slot', id: hit.id, mx, my, s0: [num(sl.x, 0), num(sl.y, 0)] }; host.dragBegin('移动插槽'); return; }
    if (hit && hit.kind === 'origin') { host.selectHandle('origin'); this.drag = { kind: 'origin', mx, my, s0: Edit.originScreen(host).slice() }; host.dragBegin('移动曲线原点'); return; }
    const r = host.penAdd(s[0], s[1], hit && hit.kind === 'edge' ? hit.i : null, e.altKey);
    if (!r) return;
    const seg = host.activeSeg(); const p = host.effPoints(seg)[r.i];
    this.drag = { kind: 'points', mx, my, starts: [{ i: r.i, sx: p.sx, sy: p.sy, h: p.h }], alt: false, moved: false, fresh: true };
    this.draw();
  }
  _physicsDown(s) {
    const host = this.host;
    const seg = host.physicsBegin();
    if (!seg) return;
    this.drag = { kind: 'landing', l0: null, fresh: true };
    this._dragLanding(s);
  }
  _dbl(e) {
    const [mx, my] = this._pos(e); const host = this.host;
    if (!host.doc || host.tool !== 'select') return;
    const hit = this._hit(mx, my); const s = this.toScene(mx, my);
    if (hit && hit.kind === 'edge') { host.op('插入控制点', () => { const seg = host.activeSeg(); const i = Edit.insertPoint(host, seg, hit.i, host.posFromScreen(s[0], s[1], seg, hit.i)); host.selectPoint(i, false); }); }
    else if (hit && hit.kind === 'curve') { host.selectSegmentScope(hit.i); this.fitCurve(); }
  }
  _move(e) {
    const [mx, my] = this._pos(e);
    const host = this.host;
    const s = this.toScene(mx, my);
    this.mouse = [mx, my];
    if (!this.drag) {
      const inside = mx >= 0 && my >= 0 && mx <= this.c.clientWidth && my <= this.c.clientHeight;
      host.onCursor(inside ? s : null);
      const hit = host.doc && inside ? this._hit(mx, my) : null;
      const hv = hit && hit.kind === 'gz' ? { kind: 'gz', part: hit.part } : null;
      if (JSON.stringify(hv) !== JSON.stringify(this.hover)) { this.hover = hv; this.draw(); }
      const t = host.tool;
      this.c.style.cursor = t === 'pan' ? 'grab' : hit && hit.kind === 'gz' && (t === 'select' || t === 'pen') ? Gizmo.cursor(hit.part) : t === 'slot' || t === 'origin' ? 'crosshair' : t === 'pen' ? (hit && (hit.kind === 'point') ? 'grab' : hit && hit.kind === 'edge' ? 'copy' : 'crosshair')
        : t === 'physics' ? 'crosshair'
          : hit ? (hit.kind === 'height' || hit.kind === 'apex' || hit.kind === 'ground' ? 'ns-resize' : hit.kind === 'curve' || hit.kind === 'edge' || hit.kind === 'ghost' ? 'pointer' : 'grab') : 'default';
      return;
    }
    const d = this.drag;
    if (d.kind === 'pan') { if (Math.hypot(mx - d.mx, my - d.my) > 2) d.moved = true; this.ox = d.ox + (mx - d.mx); this.oy = d.oy + (my - d.my); this.draw(); return; }
    if (d.kind === 'box') { this.box = { x0: Math.min(d.mx, mx), y0: Math.min(d.my, my), x1: Math.max(d.mx, mx), y1: Math.max(d.my, my) }; this.draw(); return; }
    const dxWu = (mx - d.mx) / this.zoom, dyWu = (my - d.my) / this.zoom;
    const seg = host.activeSeg();
    if (d.kind === 'slot') { host.dragTick(() => Edit.setSlot(host, d.id, { x: d.s0[0] + dxWu, y: d.s0[1] + dyWu })); return; }
    if (d.kind === 'origin') { host.dragTick(() => Edit.setOriginScreen(host, [d.s0[0] + dxWu, d.s0[1] + dyWu])); return; }
    if (d.kind === 'points') {
      d.moved = true;
      const alt = d.alt || e.altKey;
      host.dragTick(() => {
        if (alt && host.doc.space === 'world') { for (const st of d.starts) Edit.setPoint(host, seg, st.i, { h: st.h - dyWu / host.cal.cosTheta }); }
        else for (const st of d.starts) Edit.setPoint(host, seg, st.i, host.posFromScreen(st.sx + dxWu, st.sy + dyWu, seg, st.i, st.h));
      });
      return;
    }
    if (d.kind === 'height') { host.dragTick(() => Edit.setPoint(host, seg, d.i, { h: d.h0 - (my - d.my) / this.zoom / host.cal.cosTheta })); return; }
    if (d.kind === 'v0') {
      const alt = d.alt || e.altKey;
      host.dragTick(() => {
        if (host.doc.space === 'world') {
          if (alt) Edit.setV0(host, seg, { y: num(d.v0.y, 0) - (my - d.my) / this.zoom / host.cal.cosTheta / 0.25 });
          else { const st = Edit.segStartWorld(host, seg); const tipY = st[1] + num(seg.v0 && seg.v0.y, 0) * 0.25;
            // 箭尖在它当前高度的水平面上跟鼠标（沿视线与该水平面求交）
            const p = host.cal.sceneToWorldAtHeight(s[0], s[1], tipY); Edit.setTip(host, seg, [p[0], tipY, p[2]]); }
        } else Edit.setTip(host, seg, s);
      });
      return;
    }
    if (d.kind === 'landing') { this._dragLanding(s); return; }
    if (d.kind === 'apex') {
      host.dragTick(() => {
        let r;
        if (host.doc.space === 'world') { const pi = host.physicsInfo(seg); const cur = pi.apexW; r = Edit.setApex(host, seg, (d.aw0 || (d.aw0 = cur[1])) - (my - d.my) / this.zoom / host.cal.cosTheta); }
        else r = Edit.setApex(host, seg, d.a0[1] + dyWu);
        if (r && r.noGravity) host.status('重力为 0，抛体把手无解；先在右栏把重力填成正数', 'err');
      });
      return;
    }
    if (d.kind === 'start') { host.dragTick(() => Edit.setExplicitStart(host, seg, host.posFromScreen(d.s0[0] + dxWu, d.s0[1] + dyWu, seg, 0))); return; }
    if (d.kind === 'ground') { host.dragTick(() => { if (Edit.setGroundY(host, seg, d.gy + dyWu)) host.status('画面空间的地面线不能高于起点（要抛到高处用世界空间）'); }); return; }
    if (d.kind === 'gz') { this._gzMove(d, mx, my, e); return; }
  }
  _dragLanding(s) {
    const host = this.host, seg = host.activeSeg(); if (!seg) return;
    host.dragTick(() => {
      let r;
      if (host.doc.space === 'world') { const g = host.cal.sceneToWorldGround(s[0], s[1]); r = Edit.setLanding(host, seg, [g[0], g[2]]); }
      else r = Edit.setLanding(host, seg, [s[0], s[1]]);
      if (r && r.noGravity) host.status('重力为 0，抛体把手无解；先在右栏把重力填成正数', 'err');
      else if (r && r.clamped) host.status('画面空间的落点不能高于起点（地面是一条水平线）；要抛到高处的桌面用世界空间');
    });
  }
  _up(e) {
    if (!this.drag) return;
    const d = this.drag; this.drag = null; this.readout = null;
    const host = this.host;
    if (d.kind === 'pan') {
      if (d.rightHit && !d.moved) {
        if (d.rightHit.kind === 'point') host.op('删除控制点', () => Edit.deletePoints(host, host.activeSeg(), [d.rightHit.i]) || host.status('至少留一个点', 'err'));
        else if (d.rightHit.kind === 'curve') host.contextSegment(d.rightHit.i, e.clientX, e.clientY);
      }
      return;
    }
    if (d.kind === 'box') {
      const b = this.box; this.box = null;
      if (b && (b.x1 - b.x0 > 3 || b.y1 - b.y0 > 3)) {
        const seg = host.activeSeg(); const inside = [];
        if (seg && seg.kind === 'manual') host.effPoints(seg).forEach((p, i) => { const c = this.toCanvas(p.sx, p.sy); if (c[0] >= b.x0 && c[0] <= b.x1 && c[1] >= b.y0 && c[1] <= b.y1) inside.push(i); });
        if (inside.length) host.selectPoints(inside, d.shift);
        else {
          // 框住了别的段的曲线 → 选那段
          const hitSeg = host.previewSlices().find((sl) => sl.pts.some((p) => { const c = this.toCanvas(p[0], p[1]); return c[0] >= b.x0 && c[0] <= b.x1 && c[1] >= b.y0 && c[1] <= b.y1; }));
          if (hitSeg) host.selectSegmentScope(hitSeg.i); else if (!d.shift) host.clearSelection();
        }
      } else if (!d.shift) host.clearSelection();
      this.draw(); return;
    }
    if (d.kind === 'gz') { if (d.handle) host.dragEnd(); else host.endTransform(Gizmo.label(d.mode)); this.draw(); return; }
    if (d.kind === 'points' && !d.moved && !d.fresh) { host.selectPoint(d.starts[0].i, false); }
    host.dragEnd();
    if (d.fresh && host.tool === 'physics') host.setTool('select');
  }
  /** 键盘微移（画面 wu）：选中点 → 逐点；没选点 / 整段 / 整条 → 按范围整体挪（没选点时当"整段"，并说一句） */
  nudge(dx, dy) {
    const host = this.host, seg = host.activeSeg();
    if (!seg) return;
    if (host.sel.scope === 'points' && host.sel.points.size && seg.kind === 'manual') {
      host.op('微移控制点', () => { for (const i of host.sel.points) { const p = Edit.effPoints(host, seg)[i]; Edit.setPoint(host, seg, i, host.posFromScreen(p.sx + dx, p.sy + dy, seg, i, p.h)); } });
    } else {
      if (host.sel.scope === 'points') { host.setScope('segment'); host.status('没有选中的点：按"整段"微移（要挪单个点先选点）'); }
      host.beginTransform(); host.applyTransform(host.makeTranslate(dx, dy)); host.endTransform('微移');
    }
  }
}

function isTyping(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable); }
