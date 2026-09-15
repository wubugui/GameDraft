'use strict';
/* 地形工作台 · 2D 原画视图（canvas 2D）。
 *
 * 画什么：背景原画 + **碰撞格投到画面上的四边形**（每格四角按行走面高度 `worldToScene`，与运行时同一份换算；
 * 一场算一次缓存）、区域 / 高度操作多边形（贴地折线投影）、笔刷光标（贴地圆投影成椭圆）、标记点、共用的 gizmo。
 * 这一页回答"作者在原画上看到的位置"，3D 那页回答"它在世界里的位置"——两页必须一致，靠同一份 `SceneCal`。
 * 工具语义全在 app.js 的 host.toolDown/Move/Up（与 3D 共用）；这里只把画面点换成脚下世界点递过去。
 * 手势：中键 / 空格+左键 / 右键拖 = 平移，滚轮 = 朝光标缩放，Home 复位，F 对准选中。 */

class View2D {
  constructor(canvas, host) {
    this.c = canvas; this.host = host;
    this.zoom = 0.5; this.ox = 0; this.oy = 0;
    this.bg = null;
    this.drag = null; this.hover = null; this.readout = null;
    this.spaceDown = false;
    this.cursorScene = null;
    this._bind();
  }
  setBackground(img) { this.bg = img; this.draw(); }
  resize() {
    const r = this.c.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    this.c.width = Math.max(1, Math.round(r.width * dpr));
    this.c.height = Math.max(1, Math.round(r.height * dpr));
    if (this._needFit && this.c.clientWidth > 0) { this._needFit = false; this.fit(); return; }
    this.draw();
  }
  toCanvas(sx, sy) { return [sx * this.zoom + this.ox, sy * this.zoom + this.oy]; }
  toScene(mx, my) { return [(mx - this.ox) / this.zoom, (my - this.oy) / this.zoom]; }
  fit() {
    const cal = this.host.cal;
    if (!this.c.clientWidth || !this.c.clientHeight) { this._needFit = true; return; }
    this._needFit = false;
    const W = this.c.clientWidth || 1, H = this.c.clientHeight || 1;
    const w = cal ? cal.worldW : (this.host.scene ? this.host.scene.worldWidth : 2000);
    const h = cal ? cal.worldH : (this.host.scene ? this.host.scene.worldHeight : 1200);
    this.zoom = Math.min(W / Math.max(w, 1), H / Math.max(h, 1)) * 0.96;
    this.ox = (W - w * this.zoom) / 2; this.oy = (H - h * this.zoom) / 2;
    this.draw();
  }
  focus(scene, radiusWu) {
    const W = this.c.clientWidth || 1, H = this.c.clientHeight || 1;
    if (radiusWu) this.zoom = clamp(Math.min(W, H) / (radiusWu * 4), 0.05, 8);
    this.ox = W / 2 - scene[0] * this.zoom; this.oy = H / 2 - scene[1] * this.zoom;
    this.draw();
  }
  _zoomAt(mx, my, factor) {
    const s = this.toScene(mx, my);
    this.zoom = clamp(this.zoom * factor, 0.03, 12);
    this.ox = mx - s[0] * this.zoom; this.oy = my - s[1] * this.zoom;
    this.draw();
  }
  projectWorld(w) {
    const cal = this.host.cal; if (!cal) return null;
    const s = cal.worldToScene(w[0], w[1], w[2]);
    return this.toCanvas(s[0], s[1]);
  }
  groundAt(mx, my) {
    const cal = this.host.cal; if (!cal) return null;
    const s = this.toScene(mx, my);
    if (!cal.inScene(s[0], s[1])) return null;
    return cal.sceneToWorldGround(s[0], s[1]);
  }
  // ------------------------------------------------------------- gizmo
  _proj() {
    const cal = this.host.cal, v = this;
    const project = (p) => v.projectWorld(p);
    const axisPx = (a) => { const o = cal.projectOffset(a[0], a[1], a[2]); return [o[0] * v.zoom, o[1] * v.zoom]; };
    return {
      dim: 3, project, worldPerPx: () => 1 / v.zoom,
      axisParam: (mx, my, p0, a) => { const c = project(p0), s = axisPx(a), l2 = s[0] * s[0] + s[1] * s[1]; return !c || l2 < 1e-6 ? null : ((mx - c[0]) * s[0] + (my - c[1]) * s[1]) / l2; },
      planePoint: (mx, my, p0, a, b) => {
        const c = project(p0); if (!c) return null;
        const A = axisPx(a), B = axisPx(b), det = A[0] * B[1] - A[1] * B[0];
        if (Math.abs(det) < 1e-3) return null;
        const dx = mx - c[0], dy = my - c[1];
        const u = (dx * B[1] - dy * B[0]) / det, w = (A[0] * dy - A[1] * dx) / det;
        return [p0[0] + a[0] * u + b[0] * w, p0[1] + a[1] * u + b[1] * w, p0[2] + a[2] * u + b[2] * w];
      },
      groundPoint: (mx, my) => v.groundAt(mx, my),
      viewPlanePoint: (mx, my, p0) => {
        const c = project(p0); if (!c) return null;
        const r = cal.screenRightWorld(), u = cal.screenUpWorld();
        const dx = (mx - c[0]) / v.zoom, dy = -(my - c[1]) / v.zoom;
        return [p0[0] + r[0] * dx + u[0] * dy, p0[1] + r[1] * dx + u[1] * dy, p0[2] + r[2] * dx + u[2] * dy];
      },
      eyeAbove: () => cal.rows[5] < 0,
    };
  }
  _gizmo() {
    const host = this.host;
    if (!host.doc || !host.cal || host.tool !== 'select') return null;
    const pv = host.gizmoPivot(); if (!pv) return null;
    return Gizmo.geom(this._proj(), GZ_CFG.build(GZ_CFG.world2, pv.kind), pv.pivot, pv.mode || host.gizmoMode, pv.n, pv.label);
  }
  _hotPart() { return this.drag && this.drag.kind === 'gz' ? this.drag.part : (this.hover && this.hover.kind === 'gz' ? this.hover.part : null); }
  _hitGizmo(mx, my) {
    const g = this._gizmo(); if (!g) return null;
    const part = Gizmo.hit(g, mx, my);
    return part ? { kind: 'gz', part } : null;
  }
  _hit(mx, my) {
    const host = this.host;
    const po = pickObjectAt(host.objects(), (p) => this.projectWorld(p), mx, my, host.sel.key);
    if (po) return { kind: 'obj', key: po.key };
    const gz = this._hitGizmo(mx, my); if (gz) return gz;
    const g = this.groundAt(mx, my);
    const rk = g ? host.regionAtWorld(g) : null;
    if (rk) return { kind: 'obj', key: rk, area: true };
    return null;
  }
  // ------------------------------------------------------------- 绘制
  draw() {
    const g = this.c.getContext('2d'); const dpr = window.devicePixelRatio || 1;
    const host = this.host, cal = host.cal;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.c.clientWidth, this.c.clientHeight);
    g.fillStyle = '#111318'; g.fillRect(0, 0, this.c.clientWidth, this.c.clientHeight);
    const w = cal ? cal.worldW : (host.scene ? host.scene.worldWidth : 0);
    const h = cal ? cal.worldH : (host.scene ? host.scene.worldHeight : 0);
    if (this.bg && w > 0 && host.layers.mesh) {
      const a = this.toCanvas(0, 0), b = this.toCanvas(w, h);
      g.globalAlpha = host.layers.dimMesh ? 0.5 : 1;
      g.drawImage(this.bg, a[0], a[1], b[0] - a[0], b[1] - a[1]);
      g.globalAlpha = 1;
    }
    if (w > 0) { const a = this.toCanvas(0, 0), b = this.toCanvas(w, h); g.strokeStyle = 'rgba(255,255,255,.15)'; g.lineWidth = 1; g.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
    if (!cal) {
      g.fillStyle = '#9aa1ad'; g.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
      g.fillText('这个场景没有深度载荷：装不出 3D 伪世界，也没有碰撞网格可编辑', 14, 24);
      return;
    }
    // 碰撞格：四角画面坐标一场一份缓存（`cellScene`），颜色随合成结果换
    if (host.layers.cells) {
      const cs = host.cellScene(), cc = host.cellColors();
      if (cs && cc) {
        const n = cs.n, q = cs.quads, col = cc.colors;
        // 太小的格子（缩放很远）只画阻挡的，省得整张画面糊成一片
        const px = cs.cellPx * this.zoom;
        for (let k = 0; k < n; k++) {
          const a = col[k * 24 + 3]; if (a <= 0.001) continue;
          if (px < 2.5 && a < 0.3) continue;
          g.fillStyle = `rgba(${Math.round(col[k * 24] * 255)},${Math.round(col[k * 24 + 1] * 255)},${Math.round(col[k * 24 + 2] * 255)},${a})`;
          const o = k * 8;
          g.beginPath();
          g.moveTo(q[o] * this.zoom + this.ox, q[o + 1] * this.zoom + this.oy);
          g.lineTo(q[o + 2] * this.zoom + this.ox, q[o + 3] * this.zoom + this.oy);
          g.lineTo(q[o + 4] * this.zoom + this.ox, q[o + 5] * this.zoom + this.oy);
          g.lineTo(q[o + 6] * this.zoom + this.ox, q[o + 7] * this.zoom + this.oy);
          g.closePath(); g.fill();
        }
      }
    }
    // 区域 / 高度操作 / 草稿（贴地折线 → 逐点投影）
    for (const l of host.regionLines2()) {
      g.strokeStyle = l.css; g.lineWidth = l.width || 1.5; g.setLineDash(l.dash || []);
      g.beginPath();
      let first = true;
      for (const p of l.pts) { const c = this.projectWorld(p); if (!c) continue; if (first) { g.moveTo(c[0], c[1]); first = false; } else g.lineTo(c[0], c[1]); }
      if (l.close) g.closePath();
      g.stroke(); g.setLineDash([]);
      if (l.fill) { g.fillStyle = l.fill; g.fill(); }
    }
    const bc = host.brushCursor();
    if (bc && this.cursorScene && host.tool !== 'select') {
      g.strokeStyle = `rgba(${Math.round(bc.color[0] * 255)},${Math.round(bc.color[1] * 255)},${Math.round(bc.color[2] * 255)},${bc.color[3]})`; g.lineWidth = 1.5;
      g.beginPath();
      for (let i = 0; i <= 40; i++) {
        const t = i / 40 * Math.PI * 2; const x = bc.center[0] + Math.cos(t) * bc.radius, z = bc.center[2] + Math.sin(t) * bc.radius;
        const c = this.projectWorld([x, cal.groundHeight(x, z), z]); if (!c) continue;
        if (i === 0) g.moveTo(c[0], c[1]); else g.lineTo(c[0], c[1]);
      }
      g.stroke();
    }
    if (host.layers.marks) for (const m of (host.marks || [])) {
      const c = this.toCanvas(m.scene[0], m.scene[1]); if (!c) continue;
      const col = MARK_COLOR[m.kind] || [0.7, 0.7, 0.8, 0.9];
      const css = `rgba(${Math.round(col[0] * 255)},${Math.round(col[1] * 255)},${Math.round(col[2] * 255)},.9)`;
      g.fillStyle = css;
      g.beginPath(); g.arc(c[0], c[1], m.kind === 'spawn' ? 5 : 4, 0, Math.PI * 2); g.fill();
      if (m.range) {
        g.strokeStyle = css; g.lineWidth = 1; g.setLineDash([3, 3]);
        g.beginPath();
        for (let i = 0; i <= 40; i++) {
          const t = i / 40 * Math.PI * 2; const x = m.world[0] + Math.cos(t) * m.range, z = m.world[2] + Math.sin(t) * m.range;
          const p = this.projectWorld([x, cal.groundHeight(x, z), z]); if (!p) continue;
          if (i === 0) g.moveTo(p[0], p[1]); else g.lineTo(p[0], p[1]);
        }
        g.stroke(); g.setLineDash([]);
      }
      g.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
      g.fillText((MARK_LABEL[m.kind] || '') + m.id, c[0] + 8, c[1] - 6);
    }
    g.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
    for (const o of host.objects()) {
      const c = this.projectWorld(o.pos); if (!c) continue;
      g.fillStyle = `rgba(${Math.round(o.color[0] * 255)},${Math.round(o.color[1] * 255)},${Math.round(o.color[2] * 255)},${o.color[3]})`;
      const s = o.selected ? 6 : 4.5;
      g.fillRect(c[0] - s, c[1] - s, s * 2, s * 2);
      g.strokeStyle = o.selected ? GZ.col.hot : 'rgba(10,12,16,.95)'; g.lineWidth = 1.5;
      g.strokeRect(c[0] - s, c[1] - s, s * 2, s * 2);
      if (o.label) { g.fillStyle = o.selected ? GZ.col.hot : 'rgba(230,232,236,.85)'; g.fillText(o.label, c[0] + 9, c[1] - 7); }
    }
    for (const t of host.labels3()) { const c = this.projectWorld(t.pos); if (!c) continue; g.fillStyle = t.color || 'rgba(230,232,236,.85)'; g.fillText(t.text, c[0] + 4, c[1] - 4); }
    const gz = this._gizmo();
    if (gz) Gizmo.draw(g, gz, this._hotPart());
    if (this.readout) Gizmo.drawReadout(g, this.readout);
  }
  // ------------------------------------------------------------- 交互
  _bind() {
    const c = this.c;
    c.tabIndex = 0;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey && this.host.wheelRadius) { this.host.wheelRadius(e.deltaY < 0 ? 1 : -1); return; }
      const [mx, my] = this._pos(e); this._zoomAt(mx, my, Math.exp(-e.deltaY * 0.0012));
    }, { passive: false });
    c.addEventListener('mousedown', (e) => { c.focus(); this._down(e); });
    c.addEventListener('dblclick', (e) => this._dbl(e));
    c.addEventListener('mouseleave', () => { this.cursorScene = null; this.host.onCursorWorld(null); this.draw(); });
    window.addEventListener('mousemove', (e) => this._move(e));
    window.addEventListener('mouseup', (e) => this._up(e));
    window.addEventListener('keydown', (e) => { if ((e.code || e.key) === 'Space' || e.key === ' ') this.spaceDown = true; }, true);
    window.addEventListener('keyup', (e) => { if ((e.code || e.key) === 'Space' || e.key === ' ') this.spaceDown = false; }, true);
  }
  _pos(e) { const r = this.c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  _dbl(e) {
    const host = this.host;
    if (!host.doc || !host.cal) return;
    const [mx, my] = this._pos(e);
    if (host.tool !== 'select') { host.toolDouble(this.groundAt(mx, my), e); return; }
    const hit = this._hit(mx, my);
    if (hit && hit.kind === 'obj' && !hit.area) {
      host.select(hit.key);
      const o = host.objects().find((x) => x.key === hit.key);
      if (o) this.focus(host.cal.worldToScene(o.pos[0], o.pos[1], o.pos[2]), 300);
      return;
    }
    const edge = host.edgeHit((w) => this.projectWorld(w), mx, my, 7);
    if (edge) host.insertVertex(edge.key, edge.after, edge.pt);
  }
  _down(e) {
    const [mx, my] = this._pos(e);
    const host = this.host;
    if (e.button === 1 || e.button === 2 || this.spaceDown || host.tool === 'pan' || !host.cal) {
      if (e.button === 1) e.preventDefault();
      const rh = e.button === 2 && host.doc && host.cal && host.tool === 'select' ? this._hit(mx, my) : null;
      this.drag = { kind: 'pan', mx, my, ox: this.ox, oy: this.oy, rightKey: rh && rh.kind === 'obj' && !rh.area ? rh.key : null,
        rightTool: e.button === 2 && host.tool !== 'select', rightAt: this.groundAt(mx, my) };
      this.c.style.cursor = 'grabbing'; return;
    }
    if (e.button !== 0 || !host.doc) return;
    if (host.tool !== 'select') {
      const g = this.groundAt(mx, my);
      if (!g) { host.status('点到原画里面', 'warn'); return; }
      if (host.toolDown(g, e)) this.drag = { kind: 'tool', last: g };
      return;
    }
    const hit = this._hit(mx, my);
    if (hit && hit.kind === 'gz') {
      const g = this._gizmo(); if (!g) return;
      const d = Gizmo.dragBegin(this._proj(), g, hit.part, mx, my);
      d.key = host.sel.key; d.base = host.gizmoBase(host.sel.key);
      if (!d.base) return;
      this.drag = d; host.dragBegin(host.gizmoLabel());
      return;
    }
    if (hit && hit.kind === 'obj') {
      host.select(hit.key);
      const base = host.gizmoBase(hit.key);
      if (base) { this.drag = { kind: 'obj', key: hit.key, base, sx: mx, sy: my, moved: false, g0: this.groundAt(mx, my) }; host.dragBegin(host.gizmoLabel()); }
      return;
    }
    host.select('');
    this.draw();
  }
  _move(e) {
    const [mx, my] = this._pos(e);
    const host = this.host;
    if (!this.drag) {
      const inside = mx >= 0 && my >= 0 && mx <= this.c.clientWidth && my <= this.c.clientHeight;
      if (!inside) { if (this.hover) { this.hover = null; } this.cursorScene = null; host.onCursorWorld(null); this.draw(); return; }
      this.cursorScene = this.toScene(mx, my);
      host.onCursorWorld(this.groundAt(mx, my));
      const hit = !host.doc || !host.cal || host.tool !== 'select' ? null : this._hit(mx, my);
      const hv = hit && hit.kind === 'gz' ? { kind: 'gz', part: hit.part } : hit ? { kind: 'obj', key: hit.key } : null;
      if (JSON.stringify(hv) !== JSON.stringify(this.hover)) this.hover = hv;
      this.c.style.cursor = this.spaceDown || host.tool === 'pan' ? 'grab'
        : host.tool !== 'select' ? (TOOL_CURSOR[host.tool] || 'crosshair')
          : hit ? (hit.kind === 'gz' ? Gizmo.cursor(hit.part) : hit.area ? 'pointer' : 'move') : 'default';
      this.draw();
      return;
    }
    const d = this.drag;
    if (d.kind === 'pan') {
      if (Math.hypot(mx - d.mx, my - d.my) >= 3) d.moved = true;
      this.ox = d.ox + (mx - d.mx); this.oy = d.oy + (my - d.my); this.draw(); return;
    }
    if (d.kind === 'tool') { const g = this.groundAt(mx, my); if (g) { d.last = g; host.toolMove(g, e); } return; }
    if (d.kind === 'gz') {
      const res = Gizmo.dragUpdate(this._proj(), d, mx, my, e.ctrlKey || e.metaKey); if (!res) return;
      this.readout = { x: mx + 16, y: my + 22, text: res.text };
      host.dragTick(() => host.applyGizmo(d.key, d.base, res));
      return;
    }
    if (d.kind === 'obj') {
      if (!d.moved && Math.hypot(mx - d.sx, my - d.sy) < 3) return;
      d.moved = true;
      const g = this.groundAt(mx, my);
      if (g && d.g0) host.dragTick(() => host.applyGizmo(d.key, d.base, { kind: 'move', v: { x: g[0] - d.g0[0], y: 0, z: g[2] - d.g0[2] } }));
      return;
    }
  }
  _up(e) {
    if (!this.drag) return;
    const d = this.drag; this.drag = null; this.readout = null;
    this.c.style.cursor = 'default';
    if (d.kind === 'pan') {
      if (!d.moved) { if (d.rightKey) void this.host.deleteVertexKey(d.rightKey); else if (d.rightTool) this.host.toolRight(d.rightAt, e); }
      this.draw(); return;
    }
    if (d.kind === 'tool') { this.host.toolUp(d.last, e); return; }
    this.host.dragEnd();
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { View2D };
