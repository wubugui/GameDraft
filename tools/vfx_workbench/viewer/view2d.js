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
 * 手势：中键 / 空格+左键 / 右键拖 = 平移，滚轮 = 朝光标缩放，Home 复位，F 对准选中。
 *
 * 粒子区域（活动布置的两块）：发射区域青色虚线、范围区域黄色实线 + 边带内沿（与主编辑器画布 / F2 同色）。
 * 「拉发射区域 / 拉范围区域」工具按住拖一个框 = 那块区域（直接画面坐标）；顶点是可选对象（一选中立刻出 gizmo）、
 * 可直接拖；双击边线加点；Delete / 右键（没拖动）删点。 */

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
    // 藏着的时候要过一次整场（`fit` 记下了）：第一次亮出来、有了尺寸就补上
    if (this._needFit && this.c.clientWidth > 0) { this._needFit = false; this.fit(); return; }
    this.draw();
  }
  // ------------------------------------------------------------- 换算
  toCanvas(sx, sy) { return [sx * this.zoom + this.ox, sy * this.zoom + this.oy]; }
  toScene(mx, my) { return [(mx - this.ox) / this.zoom, (my - this.oy) / this.zoom]; }
  fit() {
    const cal = this.host.cal;
    // 视图藏着（开页默认 3D，装场景时 2D 是 display:none）：clientWidth = 0，按 1×1 算出来的缩放把整张原画缩成一个像素，
    // 切到 2D 只 resize 不 fit，作者看到一块空的暗画布、得猜着按 Home。记下来，亮出来时（resize）再整场
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
    // 选中的是半径：缩放 gizmo 的轴心叠在发射器 / 锚点标记上，gizmo 先拾（与 3D 同）
    if (host.radiusSelected()) { const gz0 = this._hitGizmo(mx, my); if (gz0) return gz0; }
    // 最近的标记，并列才看选中项 / objects() 序（与 3D 同一个 pickObjectAt，定义在 view3d.js）
    const po = pickObjectAt(host.objects(), (p) => this.projectWorld(p), mx, my, host.sel.key);
    if (po) return { kind: 'obj', key: po.key };
    const gz = this._hitGizmo(mx, my); if (gz) return gz;
    // 图层藏起来的半径圈不拾（与画的同一个开关）
    if (host.layers.rings) for (const s of host.spheres()) {
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
    // 图层「场景」去勾 = 原画不画（只看粒子 / 区域；与 3D 同一个开关——原来 2D 只读「压暗」，去勾什么都不变也不说为什么）
    if (this.bg && w > 0 && host.layers.mesh) {
      const a = this.toCanvas(0, 0), b = this.toCanvas(w, h);
      g.globalAlpha = host.layers.dimMesh ? 0.5 : 1;
      g.drawImage(this.bg, a[0], a[1], b[0] - a[0], b[1] - a[1]);
      g.globalAlpha = 1;
    }
    if (w > 0) { const a = this.toCanvas(0, 0), b = this.toCanvas(w, h); g.strokeStyle = 'rgba(255,255,255,.15)'; g.lineWidth = 1; g.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
    if (!cal) {
      g.fillStyle = '#9aa1ad'; g.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
      g.fillText('还没装场景', 14, 24);
      return;
    }
    if (cal.planar) {
      g.fillStyle = 'rgba(255,180,84,.9)'; g.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
      g.fillText('没有深度载荷：平面近似（2D 光带与原画上的位置是真的；3D 光柱 / 地形判据都不真）', 14, 22);
    }
    // 光柱：运行时那段 GLSL 编译出来的真实预览（按各自的混合合成到原画上），画在粒子与标记下面
    if (host.layers.beams) host.drawBeams2d(g, { zoom: this.zoom, ox: this.ox, oy: this.oy, cssW: this.c.clientWidth, cssH: this.c.clientHeight, dpr });
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
    this._drawAreas(g);
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
    // 角色代理的身体线（尺度参考：角色高 150 wu）+ 挂点横杆
    for (const b of host.bodyLines()) {
      g.strokeStyle = `rgba(${Math.round(b.color[0] * 255)},${Math.round(b.color[1] * 255)},${Math.round(b.color[2] * 255)},${b.color[3]})`;
      g.lineWidth = 1.5;
      for (let i = 0; i + 5 < b.pts.length; i += 6) {
        const p = this.projectWorld([b.pts[i], b.pts[i + 1], b.pts[i + 2]]);
        const q = this.projectWorld([b.pts[i + 3], b.pts[i + 4], b.pts[i + 5]]);
        if (!p || !q) continue;
        g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke();
      }
    }
    // 预览标记（外部给点的假点 / 调试火焰）：不可选中、不进 doc
    g.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
    for (const m of host.previewMarks()) {
      const c = this.projectWorld(m.pos); if (!c) continue;
      const css = `rgba(${Math.round(m.color[0] * 255)},${Math.round(m.color[1] * 255)},${Math.round(m.color[2] * 255)},${m.color[3]})`;
      if (m.top) { const t = this.projectWorld(m.top); if (t) { g.strokeStyle = css; g.lineWidth = 2; g.beginPath(); g.moveTo(c[0], c[1]); g.lineTo(t[0], t[1]); g.stroke(); } }
      g.fillStyle = css; g.beginPath(); g.arc(c[0], c[1], m.size / 2, 0, Math.PI * 2); g.fill();
      if (m.label) { g.fillStyle = 'rgba(255,170,90,.95)'; g.fillText(m.label, c[0] + 8, c[1] + 14); }
    }
    // 物体标记 + 名字
    g.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
    for (const o of host.objects()) {
      const c = this.projectWorld(o.pos); if (!c) continue;
      g.fillStyle = `rgba(${Math.round(o.color[0] * 255)},${Math.round(o.color[1] * 255)},${Math.round(o.color[2] * 255)},${o.color[3]})`;
      if (o.vertex) {
        // 区域顶点画成描黑边的小方块：粒子也是蓝点，圆点混在纸钱里找不到把手
        const s = o.selected ? 6 : 4.5;
        g.fillRect(c[0] - s, c[1] - s, s * 2, s * 2);
        g.strokeStyle = o.selected ? GZ.col.hot : 'rgba(10,12,16,.95)'; g.lineWidth = 1.5;
        g.strokeRect(c[0] - s, c[1] - s, s * 2, s * 2);
        continue;
      }
      const r = o.selected ? 7 : 5;
      g.beginPath(); g.arc(c[0], c[1], r, 0, Math.PI * 2); g.fill();
      if (o.selected) { g.strokeStyle = GZ.col.hot; g.lineWidth = 1.5; g.stroke(); }
      if (o.label) { g.fillStyle = o.selected ? GZ.col.hot : 'rgba(230,232,236,.8)'; g.fillText(o.label, c[0] + 9, c[1] - 7); }
    }
    const gz = this._gizmo();
    if (gz) Gizmo.draw(g, gz, this._hotPart());
    if (this.readout) Gizmo.drawReadout(g, this.readout);
  }
  /** 活动布置的区域：画面坐标多边形直接画（边带内沿是运行时 `confineDistanceContour` 的线段） */
  _drawAreas(g) {
    const sh = this.host.areaShapes();
    const rgb = { emit: '110,205,255', range: '255,209,102' };
    const poly = (pts, css, dash, width) => {
      g.strokeStyle = css; g.lineWidth = width; g.setLineDash(dash || []);
      g.beginPath();
      pts.forEach((p, i) => { const c = this.toCanvas(p[0], p[1]); if (i) g.lineTo(c[0], c[1]); else g.moveTo(c[0], c[1]); });
      g.closePath(); g.stroke(); g.setLineDash([]);
    };
    for (const s of sh.polys) {
      if (s.role === 'range') { g.fillStyle = `rgba(${rgb.range},0.06)`; g.beginPath(); s.poly.forEach((p, i) => { const c = this.toCanvas(p[0], p[1]); if (i) g.lineTo(c[0], c[1]); else g.moveTo(c[0], c[1]); }); g.closePath(); g.fill(); }
      poly(s.poly, `rgba(${rgb[s.role]},0.95)`, s.role === 'emit' ? [8, 5] : null, 2);
    }
    if (sh.contour && sh.contour.segs.length) {
      g.strokeStyle = `rgba(${rgb.range},0.5)`; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath();
      const c = sh.contour.segs;
      for (let i = 0; i + 3 < c.length; i += 4) { const a = this.toCanvas(c[i], c[i + 1]), b = this.toCanvas(c[i + 2], c[i + 3]); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
      g.stroke(); g.setLineDash([]);
    }
    if (sh.draft) poly(sh.draft.poly, `rgba(${rgb[sh.draft.role]},0.85)`, [6, 4], 1.5);
  }
  // ------------------------------------------------------------- 交互
  _bind() {
    const c = this.c;
    c.tabIndex = 0;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => { e.preventDefault(); const [mx, my] = this._pos(e); this._zoomAt(mx, my, Math.exp(-e.deltaY * 0.0012)); }, { passive: false });
    c.addEventListener('mousedown', (e) => { c.focus(); this._down(e); });
    c.addEventListener('dblclick', (e) => this._dbl(e));
    window.addEventListener('mousemove', (e) => this._move(e));
    window.addEventListener('mouseup', (e) => this._up(e));
    window.addEventListener('keydown', (e) => { if ((e.code || e.key) === 'Space' || e.key === ' ') this.spaceDown = true; }, true);
    window.addEventListener('keyup', (e) => { if ((e.code || e.key) === 'Space' || e.key === ' ') this.spaceDown = false; }, true);
  }
  _pos(e) { const r = this.c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  /** 双击：物体 = 选中并对准；否则双击在活动布置的边线上 = 插一个顶点 */
  _dbl(e) {
    const host = this.host;
    if (!host.doc || !host.cal) return;
    const [mx, my] = this._pos(e);
    const hit = this._hit(mx, my);
    if (hit && hit.kind === 'obj') {
      host.select(hit.key);
      const o = host.objects().find((x) => x.key === hit.key);
      if (o && !o.vertex) this.focus(host.cal.worldToScene(o.pos[0], o.pos[1], o.pos[2]), 400);
      return;
    }
    const edge = host.areaEdgeHit((sx, sy) => this.toCanvas(sx, sy), mx, my, 7);
    if (edge) host.insertAreaVertex(edge.role, edge.after, edge.pt);
  }
  _down(e) {
    const [mx, my] = this._pos(e);
    const host = this.host;
    if (e.button === 1 || e.button === 2 || this.spaceDown || host.tool === 'pan' || !host.cal) {
      if (e.button === 1) e.preventDefault();
      // 右键没拖动就松开 + 按在区域顶点上 = 删这个点（拖了就是平移）
      const rh = e.button === 2 && host.doc && host.cal ? this._hit(mx, my) : null;
      this.drag = { kind: 'pan', mx, my, ox: this.ox, oy: this.oy, rightKey: rh && rh.kind === 'obj' && /^area:/.test(rh.key) ? rh.key : null };
      this.c.style.cursor = 'grabbing'; return;
    }
    if (e.button !== 0 || !host.doc) return;
    const sc = this.toScene(mx, my);
    if (host.tool === 'areaEmit' || host.tool === 'areaRange') {
      const role = host.tool === 'areaEmit' ? 'emit' : 'range';
      if (!host.areaToolBegin(role)) return;
      this.drag = { kind: 'area', role, a: sc };
      host.setAreaDraft(role, sc, sc);
      return;
    }
    if (host.tool === 'anchor') { host.setAnchorScene(sc[0], sc[1]); return; }
    if (host.tool === 'player') { const w = host.cal.sceneToWorldGround(sc[0], sc[1]); host.setPlayerAt(w); return; }
    if (host.tool === 'field') { const w = host.cal.sceneToWorldGround(sc[0], sc[1]); host.addFieldAt([w[0], w[1] + 80, w[2]]); return; }
    if (host.tool === 'fire') { host.addFireAt(host.cal.sceneToWorldGround(sc[0], sc[1])); return; }
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
      if (base) {
        // 相对拖要的起点：按下处的画面点、地面点（发射器 / 玩家 / 刺激点的世界位移）、到圈心的像素距离（半径按比例缩放）
        const cpx = base.pos ? this.projectWorld(base.pos) : null;
        this.drag = { kind: 'obj', key: hit.key, base, sx: mx, sy: my, moved: false, s0: sc,
          g0: this._proj().groundPoint(mx, my), r0: cpx ? Math.hypot(mx - cpx[0], my - cpx[1]) : 0, cpx };
        host.dragBegin(host.gizmoLabel());
      }
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
        : host.tool === 'anchor' || host.tool === 'player' || host.tool === 'field' || host.tool === 'fire' || /^area/.test(host.tool) ? 'crosshair'
          : hit ? (hit.kind === 'gz' ? Gizmo.cursor(hit.part) : 'move') : 'default';
      return;
    }
    const d = this.drag;
    if (d.kind === 'pan') {
      if (Math.hypot(mx - d.mx, my - d.my) >= 3) d.moved = true;
      this.ox = d.ox + (mx - d.mx); this.oy = d.oy + (my - d.my); this.draw(); return;
    }
    if (d.kind === 'area') { host.setAreaDraft(d.role, d.a, this.toScene(mx, my)); return; }
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
      // Alt = 显式"扔到光标这一点"；平常 = 相对位移（锚点标记画在离面 h 高处，按绝对画面点写会一按就往下跳 h 的投影）
      if (e.altKey) { host.dragTick(() => host.dragObjectToScene(d.key, d.base, s)); return; }
      const ds = [s[0] - d.s0[0], s[1] - d.s0[1]];
      const g = this._proj().groundPoint(mx, my);
      const gv = g && d.g0 ? [g[0] - d.g0[0], 0, g[2] - d.g0[2]] : null;
      const ratio = d.cpx && d.r0 > 1 ? Math.hypot(mx - d.cpx[0], my - d.cpx[1]) / d.r0 : null;
      host.dragTick(() => host.dragObjectByScene(d.key, d.base, ds, gv, ratio));
      return;
    }
  }
  _up() {
    if (!this.drag) return;
    const d = this.drag; this.drag = null; this.readout = null;
    this.c.style.cursor = 'default';
    if (d.kind === 'pan') {
      if (d.rightKey && !d.moved) void this.host.deleteAreaVertexKey(d.rightKey);
      this.draw(); return;
    }
    // 拉区域：Esc 退出过区域工具就不提交（草稿作废）
    if (d.kind === 'area') { if (/^area/.test(this.host.tool)) this.host.commitAreaDraft(); else this.host.setAreaDraft(d.role, null, null); return; }
    this.host.dragEnd();
  }
  nudge(dx, dz) { this.host.nudgeSelected(dx, 0, dz); }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { View2D };
