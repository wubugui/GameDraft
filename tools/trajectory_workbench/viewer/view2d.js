'use strict';
/* 2D 画面视图：背景 + 参考层 + 全部段的烘焙曲线 + 活动段的把手 + gizmo + 幽灵。
 * 作者面主入口。工具模式（host.tool）：
 *   select  左键：点/把手拖动、点曲线选段、框选、Shift 多选；双击曲线插点；Delete 删点
 *   pen     左键：给活动手绘段追加点（按下即可拖动定位）；点线上插点；Esc/Enter 回 select
 *   physics 左键按下拖动：拖落点（活动段不是抛体就新建一段）
 *   anchor  左键：放锚点（放完回 select）
 *   pan     左键拖平移
 *   任何模式：中键 / 空格+左键 / 右键拖 = 平移；滚轮 = 缩放；右键点在控制点上 = 删点
 *   世界空间：拖点 = 沿地面挪（射线打地面场）；点上方的 ▲ 把手 / Alt+拖 = 改离地高度
 * 视图不写数据：一切改动经 host（app.js）落进 doc、进历史栈、触发重烘。 */

const HIT_R = 9;

class View2D {
  constructor(canvas, host) {
    this.c = canvas; this.g = canvas.getContext('2d'); this.host = host;
    this.zoom = 0.5; this.ox = 0; this.oy = 0;           // 画面 wu → 画布 px：cx = ox + sx*zoom
    this.drag = null; this.spaceDown = false; this.box = null;
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
    const b = Edit.bounds(host, 'all') || (host.doc ? { x0: host.doc.authoring.anchor.x - 100, y0: host.doc.authoring.anchor.y - 100, x1: host.doc.authoring.anchor.x + 100, y1: host.doc.authoring.anchor.y + 100 } : null);
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
    this._activeSegment();
    this._gizmo();
    this._anchor();
    if (L.ghost) { const prev = host.bake && host.bake.preview && host.bake.preview.screen; if (prev && prev.length) { const pose = sampleScreen(prev, host.tMs); if (pose) this._ghost(pose); } }
    if (this.box) { const b = this.box; g.strokeStyle = 'rgba(108,180,255,.9)'; g.fillStyle = 'rgba(108,180,255,.12)'; g.lineWidth = 1; g.setLineDash([4, 3]); g.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.setLineDash([]); }
    if (host.tool === 'anchor') { g.fillStyle = '#7ed492'; g.font = '12px sans-serif'; g.fillText('点击画面放置锚点（Esc 取消）', 12, H - 30); }
    else if (host.tool === 'pen') { g.fillStyle = '#6cb4ff'; g.font = '12px sans-serif'; g.fillText('点击追加控制点 · 点在线上插点 · Enter/Esc 结束', 12, H - 30); }
    else if (host.tool === 'physics') { g.fillStyle = '#ffb454'; g.font = '12px sans-serif'; g.fillText('按住拖动：把抛体落点拖到目标处', 12, H - 30); }
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
  /** 全部段的烘焙曲线（按段切片；活动段粗、其余细），落点线，硬帧刻度，时间刻度。 */
  _curves() {
    const g = this.g, host = this.host;
    const slices = host.previewSlices();
    for (const sl of slices) {
      const on = sl.i === host.segIndex;
      if (!on && !host.layers.allCurves) continue;
      g.lineWidth = on ? 2.5 : 1.5; g.strokeStyle = on ? '#6cb4ff' : 'rgba(108,180,255,.45)'; g.beginPath();
      sl.pts.forEach((p, k) => { const c = this.toCanvas(p[0], p[1]); if (k) g.lineTo(c[0], c[1]); else g.moveTo(c[0], c[1]); });
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
  _activeSegment() {
    const g = this.g, host = this.host;
    const seg = host.activeSeg(); if (!seg) return;
    const world = host.doc.space === 'world';
    if (seg.kind === 'manual') {
      const pts = host.effPoints(seg);
      // 本地即时曲线（烘焙没回来之前就能看到形状）
      const local = host.localCurve(seg);
      if (local && local.length > 1) {
        g.strokeStyle = 'rgba(108,180,255,.55)'; g.lineWidth = 1.5; g.setLineDash([6, 4]); g.beginPath();
        local.forEach((p, k) => { const c = this.toCanvas(p[0], p[1]); if (k) g.lineTo(c[0], c[1]); else g.moveTo(c[0], c[1]); });
        g.stroke(); g.setLineDash([]);
      }
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
        if (world && sel) { // 高度把手 ▲
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
  _gizmoGeom() {
    const host = this.host, gz = host.gizmo();
    if (!gz) return null;
    const p0 = this.toCanvas(gz.box.x0, gz.box.y0), p1 = this.toCanvas(gz.box.x1, gz.box.y1);
    const x0 = Math.min(p0[0], p1[0]) - 14, y0 = Math.min(p0[1], p1[1]) - 14, x1 = Math.max(p0[0], p1[0]) + 14, y1 = Math.max(p0[1], p1[1]) + 14;
    const pv = this.toCanvas(gz.pivot[0], gz.pivot[1]);
    const cx = (x0 + x1) / 2;
    return { x0, y0, x1, y1, pivot: pv, rot: [cx, y0 - 26], move: [cx, (y0 + y1) / 2], corners: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], scope: gz.scope };
  }
  _gizmo() {
    const gg = this._gizmoGeom(); if (!gg) return;
    const g = this.g;
    g.strokeStyle = 'rgba(108,180,255,.8)'; g.lineWidth = 1; g.setLineDash([5, 4]); g.strokeRect(gg.x0, gg.y0, gg.x1 - gg.x0, gg.y1 - gg.y0); g.setLineDash([]);
    for (const c of gg.corners) { g.fillStyle = '#fff'; g.fillRect(c[0] - 4, c[1] - 4, 8, 8); g.strokeStyle = '#000'; g.strokeRect(c[0] - 4, c[1] - 4, 8, 8); }
    g.strokeStyle = 'rgba(108,180,255,.8)'; g.beginPath(); g.moveTo((gg.x0 + gg.x1) / 2, gg.y0); g.lineTo(gg.rot[0], gg.rot[1] + 6); g.stroke();
    g.fillStyle = '#6cb4ff'; g.beginPath(); g.arc(gg.rot[0], gg.rot[1], 6, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#000'; g.stroke();
    g.fillStyle = 'rgba(108,180,255,.9)'; g.fillRect(gg.move[0] - 5, gg.move[1] - 5, 10, 10); g.strokeStyle = '#000'; g.strokeRect(gg.move[0] - 5, gg.move[1] - 5, 10, 10);
    g.strokeStyle = '#ffb454'; g.lineWidth = 1.5; g.beginPath(); g.arc(gg.pivot[0], gg.pivot[1], 7, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(gg.pivot[0] - 10, gg.pivot[1]); g.lineTo(gg.pivot[0] + 10, gg.pivot[1]); g.moveTo(gg.pivot[0], gg.pivot[1] - 10); g.lineTo(gg.pivot[0], gg.pivot[1] + 10); g.stroke();
    g.fillStyle = '#9fd0ff'; g.font = '11px sans-serif';
    g.fillText(gg.scope === 'all' ? '整条轨迹' : gg.scope === 'segment' ? '整段' : '选中的点', gg.x0, gg.y0 - 5);
    g.fillText('↻', gg.rot[0] - 4, gg.rot[1] - 9);
  }
  _anchor() {
    const g = this.g, host = this.host, an = host.doc.authoring.anchor, c = this.toCanvas(an.x, an.y);
    // 首段起点不在锚点上（自定起点）：把"播放偏移"画出来，别让作者以为曲线从锚点起
    const first = Edit.segs(host.doc)[0];
    if (first && !host.pinned(first)) {
      const st = host.segStartScreen(first); const s = this.toCanvas(st[0], st[1]);
      if (Math.hypot(s[0] - c[0], s[1] - c[1]) > 4) {
        g.strokeStyle = 'rgba(126,212,146,.7)'; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(c[0], c[1]); g.lineTo(s[0], s[1]); g.stroke(); g.setLineDash([]);
        g.fillStyle = 'rgba(126,212,146,.9)'; g.font = '10px sans-serif'; g.fillText(`起点偏移 ${fmt(st[0] - an.x, 0)}, ${fmt(st[1] - an.y, 0)}`, (c[0] + s[0]) / 2 + 4, (c[1] + s[1]) / 2 - 3);
      }
    }
    g.strokeStyle = '#7ed492'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(c[0] - 10, c[1]); g.lineTo(c[0] + 10, c[1]); g.moveTo(c[0], c[1] - 10); g.lineTo(c[0], c[1] + 10); g.stroke();
    g.beginPath(); g.arc(c[0], c[1], 6, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#7ed492'; g.font = '11px sans-serif'; g.fillText('锚点（播放位置）', c[0] + 12, c[1] - 6);
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
  /** 返回 {kind, ...}。优先级：gizmo 把手 > 锚点 > 活动段把手 > 任一段曲线。 */
  _hit(mx, my) {
    const host = this.host, seg = host.activeSeg();
    if (!host.doc) return null;
    const near = (p, r) => Math.hypot(p[0] - mx, p[1] - my) <= (r || HIT_R);
    if (host.tool === 'select') {
      const gg = this._gizmoGeom();
      if (gg) {
        if (near(gg.rot, 9)) return { kind: 'gz-rot', gg };
        for (let i = 0; i < 4; i++) if (near(gg.corners[i], 7)) return { kind: 'gz-scale', corner: i, gg };
        if (near(gg.move, 8)) return { kind: 'gz-move', gg };
      }
    }
    const an = this.toCanvas(host.doc.authoring.anchor.x, host.doc.authoring.anchor.y);
    const world = host.doc.space === 'world';
    // 地面线左缘把手（画面空间抛体段）：优先级最高，曲线躺在线上也抓得到
    if (seg && seg.kind === 'physics' && !world && typeof seg.groundY === 'number') { const y = this.toCanvas(0, seg.groundY)[1]; if (mx >= 10 && mx <= 44 && Math.abs(my - y) <= 9) return { kind: 'ground' }; }
    if (seg && seg.kind === 'manual') {
      const pts = host.effPoints(seg);
      if (world) for (let i = pts.length - 1; i >= 0; i--) { if (host.sel.points.has(i)) { const c = this.toCanvas(pts[i].sx, pts[i].sy); if (Math.abs(c[0] - mx) <= 7 && my >= c[1] - 26 && my <= c[1] - 12) return { kind: 'height', i }; } }
      // 控制点先于锚点（锚点常压在 0 号点上；可拖的点不能被它挡住）；0 号点与锚点重合时让给锚点（拖锚点会带着它走）
      for (let i = pts.length - 1; i >= 0; i--) { const p = this.toCanvas(pts[i].sx, pts[i].sy); if (near(p) && !(i === 0 && near(an, 10) && Math.hypot(p[0] - an[0], p[1] - an[1]) <= 6)) return { kind: 'point', i }; }
      if (near(an, 10)) return { kind: 'anchor' };
      for (let i = 0; i < pts.length - 1; i++) {
        const a = this.toCanvas(pts[i].sx, pts[i].sy), b = this.toCanvas(pts[i + 1].sx, pts[i + 1].sy);
        if (distToSeg(mx, my, a, b) <= 6) return { kind: 'edge', i };
      }
      const local = host.localCurve(seg);
      if (local && local.length > 1) for (let i = 0; i < local.length - 1; i++) { const a = this.toCanvas(local[i][0], local[i][1]), b = this.toCanvas(local[i + 1][0], local[i + 1][1]); if (distToSeg(mx, my, a, b) <= 6) return { kind: 'edge', i: host.localEdgeToPointIndex(seg, i) }; }
    } else if (seg && seg.kind === 'physics') {
      const pi = host.physicsInfo(seg);
      if (pi) {
        if (near(this.toCanvas(pi.tip[0], pi.tip[1]), HIT_R + 2)) return { kind: 'v0' };
        if (!pi.grounded && near(this.toCanvas(pi.landing[0], pi.landing[1]), 11)) return { kind: 'landing' };
        if (pi.apex && near(this.toCanvas(pi.apex[0], pi.apex[1]), 9)) return { kind: 'apex' };
        { const sc = this.toCanvas(pi.start[0], pi.start[1]); if (near(sc, 9) && !(near(an, 10) && Math.hypot(sc[0] - an[0], sc[1] - an[1]) <= 6)) return { kind: 'start' }; }
      }
      if (near(an, 10)) return { kind: 'anchor' };
    } else if (near(an, 10)) return { kind: 'anchor' };
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
    if (tool === 'anchor') { host.op('放置锚点', () => Edit.setAnchorScreen(host, s[0], s[1])); host.setTool('select'); return; }
    if (tool === 'pen') { this._penDown(mx, my, s, hit, e); return; }
    if (tool === 'physics') { this._physicsDown(s); return; }
    // select
    if (hit && hit.kind === 'gz-rot') { this.drag = { kind: 'gz-rot', pivot: hit.gg.pivot, a0: Math.atan2(my - hit.gg.pivot[1], mx - hit.gg.pivot[0]), mx, my }; host.beginTransform(); return; }
    if (hit && hit.kind === 'gz-scale') { const gg = hit.gg; this.drag = { kind: 'gz-scale', pivot: gg.pivot, d0: Math.max(4, Math.hypot(mx - gg.pivot[0], my - gg.pivot[1])), shift: e.shiftKey, mx, my }; host.beginTransform(); return; }
    if (hit && hit.kind === 'gz-move') { this.drag = { kind: 'gz-move', mx, my }; host.beginTransform(); return; }
    if (hit && hit.kind === 'anchor') { this.drag = { kind: 'anchor', mx, my, a0: [host.doc.authoring.anchor.x, host.doc.authoring.anchor.y] }; host.dragBegin('移动锚点'); return; }
    const seg = host.activeSeg();
    if (hit && hit.kind === 'height') { const p = host.effPoints(seg)[hit.i]; this.drag = { kind: 'height', i: hit.i, my, h0: p.h }; host.dragBegin('改离地高度'); return; }
    if (hit && hit.kind === 'point') {
      if (e.shiftKey) { host.togglePoint(hit.i); this.draw(); return; }
      if (!host.sel.points.has(hit.i)) host.selectPoint(hit.i, false);
      const n = host.effPoints(seg).length;
      if (host.pinned(seg) && host.sel.points.has(0)) {
        if (host.sel.points.size === 1) { host.status('起点被锚住（锚点 / 上一段末点），拖不动；要整段挪用变换框（会把起点改成"自定"），要自由起点在右栏把起点改成"自定"'); this.draw(); return; }
        if (host.sel.points.size === n) { host.selectSegmentScope(host.segIndex); const gg = this._gizmoGeom(); if (gg) { this.drag = { kind: 'gz-move', mx, my }; host.beginTransform(); } return; }
        host.status('选中的点里有锁定的起点：它不跟着动（要整段挪选"整段"范围）');
      }
      const starts = [...host.sel.points].filter((i) => !(i === 0 && host.pinned(seg))).map((i) => { const p = host.effPoints(seg)[i]; return { i, sx: p.sx, sy: p.sy, h: p.h }; });
      this.drag = { kind: 'points', mx, my, starts, alt: e.altKey, moved: false };
      host.dragBegin(e.altKey ? '改离地高度' : '移动控制点');
      this.draw(); return;
    }
    if (hit && hit.kind === 'v0') { this.drag = { kind: 'v0', alt: e.altKey, my, v0: Object.assign({}, seg.v0 || {}) }; host.dragBegin('改初速'); return; }
    if (hit && hit.kind === 'landing') { const pi = host.physicsInfo(seg); this.drag = { kind: 'landing', my, l0: pi.landing.slice(), gy: seg.groundY }; host.dragBegin('拖落点'); return; }
    if (hit && hit.kind === 'apex') { const pi = host.physicsInfo(seg); this.drag = { kind: 'apex', my, a0: pi.apex.slice() }; host.dragBegin('改最高点'); return; }
    if (hit && hit.kind === 'start') {
      if (host.pinned(seg)) { host.status('起点被锚住（锚点 / 上一段末点）；要自由起点把起点改成"自定"'); host.selectSegment(host.segIndex); this.draw(); return; }
      const pi = host.physicsInfo(seg); this.drag = { kind: 'start', mx, my, s0: pi.start.slice() }; host.dragBegin('移动起点'); return;
    }
    if (hit && hit.kind === 'ground') { this.drag = { kind: 'ground', my, gy: seg.groundY }; host.dragBegin('改地面线'); return; }
    if (hit && hit.kind === 'edge') { host.selectSegmentScope(host.segIndex); this.draw(); return; }
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
    if (hit && hit.kind === 'anchor') { this.drag = { kind: 'anchor', mx, my, a0: [host.doc.authoring.anchor.x, host.doc.authoring.anchor.y] }; host.dragBegin('移动锚点'); return; }
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
      const t = host.tool;
      this.c.style.cursor = t === 'pan' ? 'grab' : t === 'anchor' ? 'crosshair' : t === 'pen' ? (hit && (hit.kind === 'point') ? 'grab' : hit && hit.kind === 'edge' ? 'copy' : 'crosshair')
        : t === 'physics' ? 'crosshair'
          : hit ? (hit.kind === 'gz-rot' ? 'alias' : hit.kind === 'gz-scale' ? 'nwse-resize' : hit.kind === 'height' || hit.kind === 'apex' || hit.kind === 'ground' ? 'ns-resize' : hit.kind === 'curve' || hit.kind === 'edge' ? 'pointer' : 'grab') : 'default';
      return;
    }
    const d = this.drag;
    if (d.kind === 'pan') { if (Math.hypot(mx - d.mx, my - d.my) > 2) d.moved = true; this.ox = d.ox + (mx - d.mx); this.oy = d.oy + (my - d.my); this.draw(); return; }
    if (d.kind === 'box') { this.box = { x0: Math.min(d.mx, mx), y0: Math.min(d.my, my), x1: Math.max(d.mx, mx), y1: Math.max(d.my, my) }; this.draw(); return; }
    const dxWu = (mx - d.mx) / this.zoom, dyWu = (my - d.my) / this.zoom;
    const seg = host.activeSeg();
    if (d.kind === 'anchor') { host.dragTick(() => Edit.setAnchorScreen(host, d.a0[0] + dxWu, d.a0[1] + dyWu)); return; }
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
    if (d.kind === 'gz-move') { if (!d.moved && Math.hypot(mx - d.mx, my - d.my) < 3) return; d.moved = true; host.applyTransform(host.makeTranslate(dxWu, dyWu)); return; }   // 3px 死区：点一下不算挪
    if (d.kind === 'gz-rot') { if (!d.moved && Math.hypot(mx - d.mx, my - d.my) < 3) return; d.moved = true; const a1 = Math.atan2(my - d.pivot[1], mx - d.pivot[0]); let deg = (a1 - d.a0) * 180 / Math.PI; if (e.shiftKey) deg = Math.round(deg / 15) * 15; host.applyTransform(host.makeRotate(deg)); return; }
    if (d.kind === 'gz-scale') { if (!d.moved && Math.hypot(mx - d.mx, my - d.my) < 3) return; d.moved = true; const d1 = Math.hypot(mx - d.pivot[0], my - d.pivot[1]); let k = d1 / d.d0; if (e.shiftKey) k = Math.round(k * 4) / 4; k = clamp(k, 0.05, 20); host.applyTransform(host.makeScale(k)); return; }
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
    const d = this.drag; this.drag = null;
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
    if (d.kind === 'gz-move' || d.kind === 'gz-rot' || d.kind === 'gz-scale') { host.endTransform(d.kind === 'gz-move' ? '移动' : d.kind === 'gz-rot' ? '旋转' : '缩放'); return; }
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
