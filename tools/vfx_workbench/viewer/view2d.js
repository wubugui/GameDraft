'use strict';
/* 粒子工作台 · 2D 原画视图（canvas 2D）。
 *
 * 画什么：时段背景原画 + **本地预览的粒子投影到画面的点**（`worldToScene`，与运行时同一份换算）、
 * 发射器原点 / 群体三个半径圈 / 预览锚点 / 玩家标记 / 刺激点，以及与 3D 共用的那份变换 gizmo。
 * 这一页回答的是"作者在原画上看到的位置"，3D 那页回答"它在世界里的位置"——两页必须一致，
 * 靠的是同一份 `SceneCal` 与运行时 bundle 的对齐自证（app.js `checkAlignment`）。
 *
 * ⚠ 原画里 Y 与 Z 的投影重叠（2.5D 的固有歧义），gizmo 会把朝上的那根轴错开 16px 画成虚线，
 * 拖拽数学仍按真实轴向（`/vendor/gizmo.js` 里的 `axisParam` 用投影后的轴方向做点积）。
 * 手势：中键 / 空格+左键 / 右键拖 = 平移，滚轮 = 朝光标缩放，Home 复位，F 对准选中。 */

class View2D {
  constructor(canvas, host) {
    this.c = canvas; this.host = host;
    this.zoom = 0.5; this.ox = 0; this.oy = 0;
    this.bg = null;
    this.drag = null; this.hover = null; this.readout = null;
    this.spaceDown = false;
    this._bind();
  }
  setBackground(img) { this.bg = img; this.draw(); }
  resize() {
    const r = this.c.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    this.c.width = Math.max(1, Math.round(r.width * dpr));
    this.c.height = Math.max(1, Math.round(r.height * dpr));
    this.draw();
  }
  // ------------------------------------------------------------- 换算
  toCanvas(sx, sy) { return [sx * this.zoom + this.ox, sy * this.zoom + this.oy]; }
  toScene(mx, my) { return [(mx - this.ox) / this.zoom, (my - this.oy) / this.zoom]; }
  fit() {
    const cal = this.host.cal;
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
  /** 世界点 → 画布 px（经 SceneCal，与运行时 worldToScene 同一份） */
  projectWorld(w) {
    const cal = this.host.cal; if (!cal) return null;
    const s = cal.worldToScene(w[0], w[1], w[2]);
    return this.toCanvas(s[0], s[1]);
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
        if (Math.abs(det) < 1e-3) return null;   // 面对着视线（原画里的 YZ 面是一条线）
        const dx = mx - c[0], dy = my - c[1];
        const u = (dx * B[1] - dy * B[0]) / det, w = (A[0] * dy - A[1] * dx) / det;
        return [p0[0] + a[0] * u + b[0] * w, p0[1] + a[1] * u + b[1] * w, p0[2] + a[2] * u + b[2] * w];
      },
      groundPoint: (mx, my) => { const s = v.toScene(mx, my); return cal.inScene(s[0], s[1]) ? cal.sceneToWorldGround(s[0], s[1]) : null; },
      viewPlanePoint: (mx, my, p0) => {
        const c = project(p0); if (!c) return null;
        const r = cal.screenRightWorld(), u = cal.screenUpWorld();
        const dx = (mx - c[0]) / v.zoom, dy = -(my - c[1]) / v.zoom;
        return [p0[0] + r[0] * dx + u[0] * dy, p0[1] + r[1] * dx + u[1] * dy, p0[2] + r[2] * dx + u[2] * dy];
      },
      eyeAbove: () => cal.rows[5] < 0,   // 视线（q 的 +z 过 R）朝下 = 相机在上
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
  /** 拾取：小目标先于 gizmo 的轴（与 3D 同序） */
  _hit(mx, my) {
    const host = this.host;
    const near = (p, r) => { const c = this.projectWorld(p); return c && Math.hypot(c[0] - mx, c[1] - my) <= (r || 9); };
    const cand = host.objects().filter((o) => near(o.pos, (o.size || 8) + 3));
    if (cand.length) {
      const keep = cand.find((o) => o.key === host.sel.key);
      return { kind: 'obj', key: (keep || cand[0]).key };
    }
    const gz = this._hitGizmo(mx, my); if (gz) return gz;
    for (const s of host.spheres()) {
      const c = this.projectWorld(s.center); if (!c) continue;
      const e = this.projectWorld([s.center[0] + s.radius, s.center[1], s.center[2]]); if (!e) continue;
      const rpx = Math.hypot(e[0] - c[0], e[1] - c[1]);
      if (Math.abs(Math.hypot(mx - c[0], my - c[1]) - rpx) <= 5) return { kind: 'obj', key: s.key };
    }
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
    if (this.bg && w > 0) {
      const a = this.toCanvas(0, 0), b = this.toCanvas(w, h);
      g.globalAlpha = host.layers.dimMesh ? 0.5 : 1;
      g.drawImage(this.bg, a[0], a[1], b[0] - a[0], b[1] - a[1]);
      g.globalAlpha = 1;
    }
    if (w > 0) { const a = this.toCanvas(0, 0), b = this.toCanvas(w, h); g.strokeStyle = 'rgba(255,255,255,.15)'; g.lineWidth = 1; g.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
    if (!cal) {
      g.fillStyle = '#9aa1ad'; g.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
      g.fillText('这个场景没有深度载荷：装不出 3D 伪世界，也跑不了本地预览', 14, 24);
      return;
    }
    // 粒子（投影到画面）
    if (host.layers.particles) {
      for (const grp of host.particlePoints(true)) {
        g.fillStyle = grp.css;
        for (let i = 0; i + 2 < grp.pts.length; i += 3) {
          const c = this.projectWorld([grp.pts[i], grp.pts[i + 1], grp.pts[i + 2]]);
          if (!c) continue;
          const r = Math.max(1, (grp.sizeWu || 4) * 0.5 * this.zoom);
          g.beginPath(); g.arc(c[0], c[1], r, 0, Math.PI * 2); g.fill();
        }
      }
    }
    // 半径圈（原画里是圆）
    if (host.layers.rings) for (const s of host.spheres()) {
      const c = this.projectWorld(s.center); if (!c) continue;
      const e = this.projectWorld([s.center[0] + s.radius, s.center[1], s.center[2]]); if (!e) continue;
      g.strokeStyle = s.hot ? GZ.col.hot : `rgba(${Math.round(s.color[0] * 255)},${Math.round(s.color[1] * 255)},${Math.round(s.color[2] * 255)},${s.color[3]})`;
      g.lineWidth = s.hot ? 2 : 1;
      g.beginPath(); g.arc(c[0], c[1], Math.hypot(e[0] - c[0], e[1] - c[1]), 0, Math.PI * 2); g.stroke();
    }
    for (const f of host.fieldMarks()) {
      const c = this.projectWorld(f.at); if (!c) continue;
      const e = this.projectWorld([f.at[0] + f.radius, f.at[1], f.at[2]]); if (!e) continue;
      g.strokeStyle = `rgba(${Math.round(f.color[0] * 255)},${Math.round(f.color[1] * 255)},${Math.round(f.color[2] * 255)},.5)`;
      g.setLineDash([4, 3]); g.lineWidth = 1;
      g.beginPath(); g.arc(c[0], c[1], Math.hypot(e[0] - c[0], e[1] - c[1]), 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
    }
    if (host.layers.marks) for (const m of (host.marks || [])) {
      const c = this.toCanvas(m.scene[0], m.scene[1]); if (!c) continue;
      g.fillStyle = m.kind === 'spawn' ? 'rgba(128,230,140,.9)' : 'rgba(180,180,205,.8)';
      g.beginPath(); g.arc(c[0], c[1], 4, 0, Math.PI * 2); g.fill();
    }
    // 物体标记 + 名字
    g.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
    for (const o of host.objects()) {
      const c = this.projectWorld(o.pos); if (!c) continue;
      g.fillStyle = `rgba(${Math.round(o.color[0] * 255)},${Math.round(o.color[1] * 255)},${Math.round(o.color[2] * 255)},${o.color[3]})`;
      const r = o.selected ? 7 : 5;
      g.beginPath(); g.arc(c[0], c[1], r, 0, Math.PI * 2); g.fill();
      if (o.selected) { g.strokeStyle = GZ.col.hot; g.lineWidth = 1.5; g.stroke(); }
      if (o.label) { g.fillStyle = o.selected ? GZ.col.hot : 'rgba(230,232,236,.8)'; g.fillText(o.label, c[0] + 9, c[1] - 7); }
    }
    const gz = this._gizmo();
    if (gz) Gizmo.draw(g, gz, this._hotPart());
    if (this.readout) Gizmo.drawReadout(g, this.readout);
  }
  // ------------------------------------------------------------- 交互
  _bind() {
    const c = this.c;
    c.tabIndex = 0;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => { e.preventDefault(); const [mx, my] = this._pos(e); this._zoomAt(mx, my, Math.exp(-e.deltaY * 0.0012)); }, { passive: false });
    c.addEventListener('mousedown', (e) => { c.focus(); this._down(e); });
    window.addEventListener('mousemove', (e) => this._move(e));
    window.addEventListener('mouseup', (e) => this._up(e));
    window.addEventListener('keydown', (e) => { if ((e.code || e.key) === 'Space' || e.key === ' ') this.spaceDown = true; }, true);
    window.addEventListener('keyup', (e) => { if ((e.code || e.key) === 'Space' || e.key === ' ') this.spaceDown = false; }, true);
  }
  _pos(e) { const r = this.c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  _down(e) {
    const [mx, my] = this._pos(e);
    const host = this.host;
    if (e.button === 1 || e.button === 2 || this.spaceDown || host.tool === 'pan' || !host.cal) {
      if (e.button === 1) e.preventDefault();
      this.drag = { kind: 'pan', mx, my, ox: this.ox, oy: this.oy }; this.c.style.cursor = 'grabbing'; return;
    }
    if (e.button !== 0 || !host.doc) return;
    const sc = this.toScene(mx, my);
    if (host.tool === 'anchor') { host.setAnchorScene(sc[0], sc[1]); return; }
    if (host.tool === 'player') { const w = host.cal.sceneToWorldGround(sc[0], sc[1]); host.setPlayerAt(w); return; }
    if (host.tool === 'field') { const w = host.cal.sceneToWorldGround(sc[0], sc[1]); host.addFieldAt([w[0], w[1] + 80, w[2]]); return; }
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
      if (base) { this.drag = { kind: 'obj', key: hit.key, base, sx: mx, sy: my, moved: false }; host.dragBegin(host.gizmoLabel()); }
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
      if (!inside) { if (this.hover) { this.hover = null; this.draw(); } return; }
      if (host.cal) { const s = this.toScene(mx, my); host.onCursorScene(s); }
      const hit = !host.doc || !host.cal ? null : this._hit(mx, my);
      const hv = hit && hit.kind === 'gz' ? { kind: 'gz', part: hit.part } : hit ? { kind: 'obj', key: hit.key } : null;
      if (JSON.stringify(hv) !== JSON.stringify(this.hover)) { this.hover = hv; this.draw(); }
      this.c.style.cursor = this.spaceDown || host.tool === 'pan' ? 'grab'
        : host.tool === 'anchor' || host.tool === 'player' || host.tool === 'field' ? 'crosshair'
          : hit ? (hit.kind === 'gz' ? Gizmo.cursor(hit.part) : 'move') : 'default';
      return;
    }
    const d = this.drag;
    if (d.kind === 'pan') { this.ox = d.ox + (mx - d.mx); this.oy = d.oy + (my - d.my); this.draw(); return; }
    if (d.kind === 'gz') {
      const res = Gizmo.dragUpdate(this._proj(), d, mx, my, e.ctrlKey || e.metaKey); if (!res) return;
      this.readout = { x: mx + 16, y: my + 22, text: res.text };
      host.dragTick(() => host.applyGizmo(d.key, d.base, res));
      return;
    }
    if (d.kind === 'obj') {
      if (!d.moved && Math.hypot(mx - d.sx, my - d.sy) < 3) return;
      d.moved = true;
      const s = this.toScene(mx, my);
      host.dragTick(() => host.dragObjectToScene(d.key, d.base, s));
      return;
    }
  }
  _up() {
    if (!this.drag) return;
    const d = this.drag; this.drag = null; this.readout = null;
    this.c.style.cursor = 'default';
    if (d.kind === 'pan') { this.draw(); return; }
    this.host.dragEnd();
  }
  nudge(dx, dz) { this.host.nudgeSelected(dx, 0, dz); }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { View2D };
