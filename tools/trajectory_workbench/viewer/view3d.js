'use strict';
/* 3D 世界视图（裸 WebGL2，不引第三方库）：深度还原出的场景三角网（贴背景）、地面网格、曲线、控制点、
 * 把手、幽灵卡片。世界坐标 = M-world wu（+Y 上、XZ 地面）。
 * 世界空间资产在这里**可以直接编辑**（与 2D 同一套工具模式）：
 *   select  左键拖点 = 沿水平面挪（再贴回地面，h 不变）；点上方 ▲ / Alt+拖 = 改离地高度；
 *           拖箭尖 / 落点 / 最高点 / 自定起点 / 锚点；整段 / 整条范围有蓝色移动把手（沿地面平移）；
 *           Shift+空白拖 = 框选；左键空白拖 = 环绕（没拖动才清选择）；右键拖 = 平移；滚轮 = 远近；方向键 = 沿 x/z 微移
 *   pen     点击 = 射线打到深度壳（桌面/台阶）或地面，加一个点
 *   physics 按下拖动 = 拖落点
 *   anchor  点击地面 = 放锚点
 * 画面空间资产：只看（曲线按落点反投影贴到地面）。 */

class View3D {
  constructor(canvas, host) {
    this.c = canvas; this.host = host;
    const gl = canvas.getContext('webgl2', { antialias: true });
    this.gl = gl; this.ok = !!gl;
    if (!gl) return;
    this.cam = { yaw: 0.35, pitch: 0.45, dist: 3000, tx: 0, ty: 0, tz: 0, fov: 45 };
    this.mesh = null; this.tex = null; this.ghostTex = null; this.gridLines = null;
    this.drag = null; this.box = null;
    this.progMesh = this._prog(MESH_VS, MESH_FS);
    this.progLine = this._prog(LINE_VS, LINE_FS);
    this.progBill = this._prog(BILL_VS, BILL_FS);
    this.lineBuf = gl.createBuffer();
    this.billBuf = gl.createBuffer();
    this.overlay = null;   // 2D 叠加层（把手/文字），由 app 传进来
    this._bind();
  }
  _sh(type, src) {
    const gl = this.gl, s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  _prog(vs, fs) {
    const gl = this.gl, p = gl.createProgram();
    gl.attachShader(p, this._sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, this._sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  setMesh(buf) {
    const gl = this.gl;
    const dv = new DataView(buf);
    const nv = dv.getUint32(0, true), ni = dv.getUint32(4, true);
    const verts = new Float32Array(buf, 8, nv * 5);
    const idx = new Uint32Array(buf, 8 + nv * 20, ni);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) { const v = verts[i * 5 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
    this.mesh = { vao, count: ni, mn, mx };
    this.gridLines = null;
  }
  _tex(img) {
    const gl = this.gl;
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  setTexture(img) { this.tex = this._tex(img); }
  setGhostTexture(img) { this.ghostTex = img ? this._tex(img) : null; }
  fit() {
    const m = this.mesh; if (!m) return;
    const cx = (m.mn[0] + m.mx[0]) / 2, cz = (m.mn[2] + m.mx[2]) / 2, cy = (m.mn[1] + m.mx[1]) / 2;
    const ext = Math.max(m.mx[0] - m.mn[0], m.mx[2] - m.mn[2], m.mx[1] - m.mn[1]);
    Object.assign(this.cam, { tx: cx, ty: cy, tz: cz, dist: ext * 1.1, yaw: 0.35, pitch: 0.45 });
    this.draw();
  }
  /** 把镜头对准锚点 / 轨迹 */
  fitCurve() {
    const host = this.host, cal = host.cal;
    if (!cal || !host.doc) return this.fit();
    const aw = Edit.anchorWorld(host);
    const prev = host.bake && host.bake.preview && host.bake.preview.world;
    let mn = aw ? aw.slice() : [0, 0, 0], mx = aw ? aw.slice() : [0, 0, 0];
    if (prev && prev.length) for (const w of prev) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], w[k + 1]); mx[k] = Math.max(mx[k], w[k + 1]); }
    const ext = Math.max(200, mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
    Object.assign(this.cam, { tx: (mn[0] + mx[0]) / 2, ty: (mn[1] + mx[1]) / 2, tz: (mn[2] + mx[2]) / 2, dist: ext * 2.2 });
    this.draw();
  }
  resize() {
    const r = this.c.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    this.c.width = Math.max(1, Math.round(r.width * dpr)); this.c.height = Math.max(1, Math.round(r.height * dpr));
    if (this.overlay) { this.overlay.width = this.c.width; this.overlay.height = this.c.height; }
    this.draw();
  }
  // ------------------------------------------------------------- 矩阵 / 拾取
  _mvp() {
    const c = this.cam, W = this.c.width, H = this.c.height;
    const eye = [
      c.tx + c.dist * Math.cos(c.pitch) * Math.sin(c.yaw),
      c.ty + c.dist * Math.sin(c.pitch),
      c.tz - c.dist * Math.cos(c.pitch) * Math.cos(c.yaw),
    ];
    const view = lookAt(eye, [c.tx, c.ty, c.tz], [0, 1, 0]);
    const proj = perspective(c.fov * Math.PI / 180, W / Math.max(H, 1), Math.max(1, c.dist * 0.01), c.dist * 20 + 1e4);
    return { mvp: mul4(proj, view), eye };
  }
  project(p) { const { mvp } = this._mvp(); return projectPoint(mvp, p, this.c.clientWidth, this.c.clientHeight); }
  ray(mx, my) { const { mvp } = this._mvp(); const inv = inv4(mvp); if (!inv) return null; return unprojectRay(inv, mx, my, this.c.clientWidth, this.c.clientHeight); }
  /** 鼠标 → 地面点（世界）；打不到返回 null */
  pickGround(mx, my) { const r = this.ray(mx, my); return r ? rayGround(r, this.host.cal) : null; }
  /** 鼠标 → 表面点（壳优先，太高就退地面） */
  pickSurface(mx, my) {
    const cal = this.host.cal, r = this.ray(mx, my); if (!r) return null;
    const g = rayGround(r, cal);
    const s = rayShell(r, cal);
    if (s) {
      const hh = s[1] - cal.groundHeight(s[0], s[2]);
      if (hh > 1.5 && hh <= 260) { if (!g) return { x: s[0], z: s[2], h: hh, onShell: true }; const dg = Math.hypot(g[0] - r.o[0], g[1] - r.o[1], g[2] - r.o[2]), ds = Math.hypot(s[0] - r.o[0], s[1] - r.o[1], s[2] - r.o[2]); if (ds <= dg + 1) return { x: s[0], z: s[2], h: hh, onShell: true }; }
    }
    if (!g) return null;
    return { x: g[0], z: g[2], h: 0, onShell: false };
  }
  /** 鼠标 → 水平面 y=py 上的点 */
  pickPlane(mx, my, py) { const r = this.ray(mx, my); return r ? rayPlane(r, [0, py, 0], [0, 1, 0]) : null; }
  /** 鼠标 → 过 p 的竖直平面（面朝相机）上的点，返回 y */
  pickVertical(mx, my, p) {
    const r = this.ray(mx, my); if (!r) return null;
    const { eye } = this._mvp(); const n = norm3([p[0] - eye[0], 0, p[2] - eye[2]]);
    const q = rayPlane(r, p, n); return q ? q[1] : null;
  }
  // ------------------------------------------------------------- 绘制
  draw() {
    const gl = this.gl; if (!gl) return;
    const host = this.host, cal = host.cal;
    gl.viewport(0, 0, this.c.width, this.c.height);
    gl.clearColor(0.08, 0.09, 0.11, 1); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const { mvp } = this._mvp();
    if (this.mesh && this.tex) {
      gl.useProgram(this.progMesh);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.progMesh, 'uMVP'), false, mvp);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(gl.getUniformLocation(this.progMesh, 'uTex'), 0);
      gl.bindVertexArray(this.mesh.vao); gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_INT, 0); gl.bindVertexArray(null);
    }
    gl.disable(gl.DEPTH_TEST);
    if (host.layers.grid && cal && cal.hf) this._groundGrid(mvp);
    const prev = host.bake && host.bake.preview;
    const world = host.doc && host.doc.space === 'world';
    if (host.doc && prev && prev.world && prev.world.length > 1) {
      for (const sl of host.previewSlicesWorld()) {
        const on = sl.i === host.segIndex;
        if (!on && !host.layers.allCurves) continue;
        this._lines(mvp, sl.pos, on ? [0.42, 0.7, 1, 1] : [0.42, 0.7, 1, 0.45], gl.LINE_STRIP, on ? 2 : 1);
        this._lines(mvp, sl.foot, on ? [1, 0.7, 0.33, 0.9] : [1, 0.7, 0.33, 0.35], gl.LINE_STRIP, 1);
      }
    } else if (host.doc && prev && prev.screen && prev.screen.length > 1 && cal && !world) {
      const pos = [];
      for (const s of prev.screen) { const g = cal.sceneToWorldGround(s[1], s[3]); pos.push(g[0], g[1] + (s[3] - s[2]) / cal.cosTheta, g[2]); }
      this._lines(mvp, pos, [0.42, 0.7, 1, 0.8], gl.LINE_STRIP, 2);
    }
    if (cal && host.doc) {
      const aw = Edit.anchorWorld(host);
      if (aw) { this._marker(mvp, aw, [0.5, 0.83, 0.57, 1], 12); this._lines(mvp, [aw[0], aw[1], aw[2], aw[0], cal.groundHeight(aw[0], aw[2]), aw[2]], [0.5, 0.83, 0.57, 0.7], gl.LINES, 1); }
      // 整段 / 整条范围：变换轴上的移动把手（拖 = 沿地面平移）
      const mv = this._moveHandleWorld();
      if (mv) { this._marker(mvp, mv, [0.42, 0.7, 1, 1], 16); this._lines(mvp, [mv[0], mv[1], mv[2], mv[0], cal.groundHeight(mv[0], mv[2]), mv[2]], [0.42, 0.7, 1, 0.6], gl.LINES, 1); }
    }
    const seg = host.activeSeg();
    if (seg && cal && world) {
      if (seg.kind === 'manual') {
        const pts = host.effPoints(seg);
        const local = host.localCurveWorld(seg);
        if (local && local.length > 1) { const arr = []; for (const p of local) arr.push(p[0], p[1], p[2]); this._lines(mvp, arr, [0.42, 0.7, 1, 0.5], gl.LINE_STRIP, 1); }
        const poly = [], stems = [];
        pts.forEach((p) => { poly.push(p.pos[0], p.pos[1], p.pos[2]); stems.push(p.pos[0], p.pos[1], p.pos[2], p.pos[0], p.pos[1] - p.h, p.pos[2]); });
        if (poly.length > 3) this._lines(mvp, poly, [1, 1, 1, 0.3], gl.LINE_STRIP, 1);
        if (stems.length) this._lines(mvp, stems, [1, 1, 1, 0.5], gl.LINES, 1);
        pts.forEach((p, i) => this._marker(mvp, p.pos, host.sel.points.has(i) ? [0.42, 0.7, 1, 1] : (i === 0 && host.pinned(seg) ? [0.6, 0.6, 0.6, 1] : [1, 1, 1, 1]), host.sel.points.has(i) ? 11 : 8));
      } else if (seg.kind === 'physics') {
        const pi = host.physicsInfo(seg);
        if (pi) {
          const st = pi.startW, tip = pi.tipW;
          this._lines(mvp, [st[0], st[1], st[2], tip[0], tip[1], tip[2]], [1, 0.7, 0.33, 1], gl.LINES, 2);
          if (pi.arcW && pi.arcW.length > 1) { const arr = []; for (const p of pi.arcW) arr.push(p[0], p[1], p[2]); this._lines(mvp, arr, [1, 0.7, 0.33, 0.5], gl.LINE_STRIP, 1); }
          this._marker(mvp, st, host.pinned(seg) ? [0.6, 0.6, 0.6, 1] : [1, 1, 1, 1], 9);
          this._marker(mvp, tip, [1, 0.7, 0.33, 1], 10);
          if (!pi.grounded) this._marker(mvp, pi.landingW, [0.5, 0.83, 0.57, 1], 12);
          if (pi.apexW) this._marker(mvp, pi.apexW, [0.78, 0.57, 0.92, 1], 10);
        }
      }
    }
    if (host.layers.ghost && prev && prev.world && prev.world.length && cal) {
      const p = sampleWorld(prev.world, host.tMs);
      const pose = sampleScreen(prev.screen, host.tMs);
      if (p && pose) this._ghost(mvp, p, pose);
    }
    gl.enable(gl.DEPTH_TEST);
    this._overlay();
  }
  /** 整段 / 整条范围下的移动把手位置（世界）：变换轴抬到锚点高度 + 24 wu，别跟起点标记叠在一起 */
  _moveHandleWorld() {
    const host = this.host, cal = host.cal;
    if (!cal || !host.doc || host.doc.space !== 'world' || host.tool !== 'select') return null;
    const scope = host.sel.scope, seg = host.activeSeg();
    if (scope === 'points' || (scope === 'segment' && !seg)) return null;
    const pv = host._pivotNative(); if (!pv) return null;
    return [pv[0], cal.groundHeight(pv[0], pv[1]) + host.restH() + 24, pv[1]];
  }
  /** 2D 叠加：把手符号、编号、h 标签、提示（在 canvas 2D 上画，与 3D 同尺寸） */
  _overlay() {
    const ov = this.overlay; if (!ov) return;
    const g = ov.getContext('2d'); const dpr = window.devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, ov.clientWidth, ov.clientHeight);
    const host = this.host, cal = host.cal;
    if (!host.doc) return;
    g.font = '11px sans-serif';
    const world = host.doc.space === 'world';
    if (!world) { g.fillStyle = 'rgba(255,255,255,.6)'; g.fillText('画面空间资产：3D 视图只看不改（曲线按落点贴地估算）', 12, ov.clientHeight - 30); return; }
    if (!cal) return;
    const seg = host.activeSeg();
    if (seg && seg.kind === 'manual') {
      host.effPoints(seg).forEach((p, i) => {
        const c = this.project(p.pos); if (!c) return;
        g.fillStyle = host.sel.points.has(i) ? '#fff' : '#bbb'; g.fillText(`${i}  h ${fmt(p.h)}`, c[0] + 8, c[1] - 6);
        if (host.sel.points.has(i)) { const hy = c[1] - 18; g.fillStyle = '#ffb454'; g.beginPath(); g.moveTo(c[0], hy - 6); g.lineTo(c[0] - 5, hy + 3); g.lineTo(c[0] + 5, hy + 3); g.closePath(); g.fill(); }
      });
    } else if (seg && seg.kind === 'physics') {
      const pi = host.physicsInfo(seg);
      if (pi) {
        const t = this.project(pi.tipW); const v = seg.v0 || {};
        if (t) { g.fillStyle = '#ffb454'; g.fillText(`v0 (${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)})`, t[0] + 9, t[1] + 4); }
        if (!pi.grounded) { const l = this.project(pi.landingW); if (l) { g.fillStyle = '#7ed492'; g.fillText(`落点 ${fmt(pi.t * 1000, 0)}ms`, l[0] + 10, l[1] + 4); } }
        if (pi.apexW) { const a = this.project(pi.apexW); if (a) { g.fillStyle = '#c792ea'; g.fillText('最高点 ⇅', a[0] + 8, a[1] - 6); } }
      }
    }
    const aw = Edit.anchorWorld(host); const ac = aw ? this.project(aw) : null;
    if (ac) { g.fillStyle = '#7ed492'; g.fillText('锚点', ac[0] + 10, ac[1] - 6); }
    const mv = this._moveHandleWorld(); const mc = mv ? this.project(mv) : null;
    if (mc) { g.fillStyle = '#9fd0ff'; g.fillText(host.sel.scope === 'all' ? '整条：拖动平移' : '整段：拖动平移（旋转/缩放用右栏）', mc[0] + 12, mc[1] + 4); }
    if (this.box) { const b = this.box; g.strokeStyle = 'rgba(108,180,255,.9)'; g.fillStyle = 'rgba(108,180,255,.12)'; g.setLineDash([4, 3]); g.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.setLineDash([]); }
    if (host.tool === 'pen') { g.fillStyle = '#6cb4ff'; g.fillText('点击场景表面加点（桌面/台阶会落在其上）· Enter/Esc 结束', 12, ov.clientHeight - 30); }
    else if (host.tool === 'physics') { g.fillStyle = '#ffb454'; g.fillText('按住拖动：把落点拖到目标地面处', 12, ov.clientHeight - 30); }
    else if (host.tool === 'anchor') { g.fillStyle = '#7ed492'; g.fillText('点击地面放置锚点', 12, ov.clientHeight - 30); }
  }
  _groundGrid(mvp) {
    const cal = this.host.cal, hf = cal.hf;
    if (!this.gridLines) {
      const b = cal.groundBounds || [hf.x0, hf.x0 + hf.dx * (hf.n - 1), hf.z0, hf.z0 + hf.dz * (hf.n - 1)];
      const step = 100, arr = [];
      for (let x = Math.ceil(b[0] / step) * step; x <= b[1]; x += step) for (let z = b[2]; z < b[3]; z += step / 4) { const z2 = Math.min(b[3], z + step / 4); arr.push(x, cal.groundHeight(x, z) + 0.5, z, x, cal.groundHeight(x, z2) + 0.5, z2); }
      for (let z = Math.ceil(b[2] / step) * step; z <= b[3]; z += step) for (let x = b[0]; x < b[1]; x += step / 4) { const x2 = Math.min(b[1], x + step / 4); arr.push(x, cal.groundHeight(x, z) + 0.5, z, x2, cal.groundHeight(x2, z) + 0.5, z); }
      this.gridLines = new Float32Array(arr);
    }
    this._lines(mvp, this.gridLines, [1, 1, 1, 0.13], this.gl.LINES, 1);
  }
  _lines(mvp, arr, color, mode, width) {
    const gl = this.gl;
    gl.useProgram(this.progLine);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progLine, 'uMVP'), false, mvp);
    gl.uniform4fv(gl.getUniformLocation(this.progLine, 'uColor'), color);
    gl.uniform1f(gl.getUniformLocation(this.progLine, 'uPointSize'), (width || 1) * (window.devicePixelRatio || 1));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf); gl.bufferData(gl.ARRAY_BUFFER, arr instanceof Float32Array ? arr : new Float32Array(arr), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(1);
    // WebGL 的 lineWidth 在 Chrome 恒为 1：线条粗细只能靠颜色/透明度区分，`width` 只用于 POINTS 的点径
    gl.drawArrays(mode, 0, arr.length / 3);
  }
  _marker(mvp, p, color, size) {
    this.gl.enable(this.gl.BLEND); this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    this._lines(mvp, [p[0], p[1], p[2]], color, this.gl.POINTS, size);
  }
  _ghost(mvp, p, pose) {
    const gl = this.gl, host = this.host, cal = host.cal, ent = host.entity;
    const persp = host.layers.persp ? perspectiveScaleAt(host.scene.perspectiveScale, pose.x, pose.sortY) : 1;
    const w = (ent ? ent.meta.worldWidth * ent.meta.scale : 16) * persp * pose.sx;
    const hh = (ent ? ent.meta.worldHeight * ent.meta.scale : 16) * persp * pose.sy;
    const ax = ent ? ent.meta.anchor.x : 0.5, ay = ent ? ent.meta.anchor.y : 0.5;
    const right = cal.screenRightWorld(), up = cal.screenUpWorld();
    const rot = pose.rot * Math.PI / 180, cs = Math.cos(rot), sn = Math.sin(rot);
    const ux = [right[0] * cs - up[0] * sn, right[1] * cs - up[1] * sn, right[2] * cs - up[2] * sn];
    const uy = [right[0] * sn + up[0] * cs, right[1] * sn + up[1] * cs, right[2] * sn + up[2] * cs];
    const o = [p[0], p[1], p[2]];
    const corner = (fx, fy) => [o[0] + ux[0] * fx + uy[0] * fy, o[1] + ux[1] * fx + uy[1] * fy, o[2] + ux[2] * fx + uy[2] * fy];
    const x0 = -ax * w, x1 = (1 - ax) * w, y0 = -ay * hh, y1 = (1 - ay) * hh;
    const q = [corner(x0, -y0), corner(x1, -y0), corner(x1, -y1), corner(x0, -y1)];
    const data = new Float32Array([...q[0], 0, 0, ...q[1], 1, 0, ...q[2], 1, 1, ...q[0], 0, 0, ...q[2], 1, 1, ...q[3], 0, 1]);
    gl.useProgram(this.progBill);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progBill, 'uMVP'), false, mvp);
    gl.uniform1f(gl.getUniformLocation(this.progBill, 'uAlpha'), clamp(pose.alpha, 0, 1));
    gl.uniform1i(gl.getUniformLocation(this.progBill, 'uHas'), this.ghostTex ? 1 : 0);
    if (this.ghostTex) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.ghostTex); gl.uniform1i(gl.getUniformLocation(this.progBill, 'uTex'), 1); }
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.billBuf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
    this._lines(mvp, [p[0], p[1], p[2], p[0], p[1] - p[3], p[2]], [1, 0.7, 0.33, 1], gl.LINES, 1);
    this._marker(mvp, [p[0], p[1] - p[3], p[2]], [1, 0.7, 0.33, 1], 9);
  }
  // ------------------------------------------------------------- 拾取
  _hit(mx, my) {
    const host = this.host, cal = host.cal, seg = host.activeSeg();
    if (!host.doc || !cal || host.doc.space !== 'world') return null;
    const near = (p, r) => { const c = this.project(p); return c && Math.hypot(c[0] - mx, c[1] - my) <= (r || 9); };
    const mv = this._moveHandleWorld();
    if (mv && near(mv, 11)) return { kind: 'gz-move' };
    const aw = Edit.anchorWorld(host);
    if (aw && near(aw, 10)) return { kind: 'anchor' };
    if (seg && seg.kind === 'manual') {
      const pts = host.effPoints(seg);
      for (let i = pts.length - 1; i >= 0; i--) if (host.sel.points.has(i)) { const c = this.project(pts[i].pos); if (c && Math.abs(c[0] - mx) <= 7 && my >= c[1] - 26 && my <= c[1] - 12) return { kind: 'height', i }; }
      for (let i = pts.length - 1; i >= 0; i--) if (near(pts[i].pos)) return { kind: 'point', i };
    } else if (seg && seg.kind === 'physics') {
      const pi = host.physicsInfo(seg);
      if (pi) {
        if (near(pi.tipW, 11)) return { kind: 'v0' };
        if (!pi.grounded && near(pi.landingW, 11)) return { kind: 'landing' };
        if (pi.apexW && near(pi.apexW, 9)) return { kind: 'apex' };
        if (near(pi.startW, 9)) return { kind: 'start' };
      }
    }
    for (const sl of host.previewSlicesWorld()) {
      let prevC = null;
      for (let k = 0; k < sl.pos.length; k += 3) {
        const c = this.project([sl.pos[k], sl.pos[k + 1], sl.pos[k + 2]]);
        if (c && prevC && distToSeg(mx, my, prevC, c) <= 6) return { kind: 'curve', i: sl.i };
        prevC = c;
      }
    }
    return null;
  }
  // ------------------------------------------------------------- 交互
  _bind() {
    const c = this.c;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.cam.dist = clamp(this.cam.dist * Math.exp(e.deltaY * 0.0012), 20, 1e6); this.draw(); }, { passive: false });
    c.addEventListener('mousedown', (e) => this._down(e));
    window.addEventListener('mousemove', (e) => this._move(e));
    window.addEventListener('mouseup', (e) => this._up(e));
  }
  _pos(e) { const r = this.c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  _orbit(e, mx, my) { this.drag = { kind: 'orbit', b: e.button, mx: e.clientX, my: e.clientY, cam: Object.assign({}, this.cam) }; }
  _down(e) {
    if (!this.ok) return;
    const [mx, my] = this._pos(e);
    const host = this.host, cal = host.cal;
    if (e.button === 2 || e.button === 1) { this.drag = { kind: 'pan', mx: e.clientX, my: e.clientY, cam: Object.assign({}, this.cam), hit: e.button === 2 ? this._hit(mx, my) : null, moved: false }; return; }
    if (e.button !== 0) return;
    const editable = host.doc && cal && host.doc.space === 'world';
    if (!editable || host.tool === 'pan') return this._orbit(e, mx, my);
    const tool = host.tool;
    const hit = this._hit(mx, my);
    if (tool === 'anchor') { const g = this.pickGround(mx, my); if (g) { host.op('放置锚点', () => host.setAnchorFromGround(g)); host.setTool('select'); } return; }
    if (tool === 'pen') {
      if (hit && hit.kind === 'point') { host.selectPoint(hit.i, false); this.drag = this._pointDrag([hit.i], mx, my, e.altKey); host.dragBegin('移动控制点'); return; }
      const sp = this.pickSurface(mx, my); if (!sp) return;
      const r = host.penAddXZH(sp);
      if (!r) return;
      this.drag = this._pointDrag([r.i], mx, my, false); this.drag.fresh = true;
      return;
    }
    if (tool === 'physics') { const seg = host.physicsBegin(); if (!seg) return; this.drag = { kind: 'landing', fresh: true }; this._dragLanding(mx, my); return; }
    const seg = host.activeSeg();
    if (hit && hit.kind === 'gz-move') { const mv = this._moveHandleWorld(); this.drag = { kind: 'gz-move', plane: mv[1], p0: this.pickPlane(mx, my, mv[1]), sx: mx, sy: my, moved: false }; host.beginTransform(); return; }
    if (hit && hit.kind === 'anchor') { const aw = Edit.anchorWorld(host); this.drag = { kind: 'anchor', y: aw[1] }; host.dragBegin('移动锚点'); return; }
    if (hit && hit.kind === 'height') { const p = host.effPoints(seg)[hit.i]; this.drag = { kind: 'height', i: hit.i, p: p.pos.slice(), h0: p.h, y0: this.pickVertical(mx, my, p.pos) }; host.dragBegin('改离地高度'); return; }
    if (hit && hit.kind === 'point') {
      if (e.shiftKey) { host.togglePoint(hit.i); this.draw(); return; }
      if (!host.sel.points.has(hit.i)) host.selectPoint(hit.i, false);
      if (host.pinned(seg) && hit.i === 0 && host.sel.points.size === 1) { host.status('起点被锚住（锚点 / 上一段末点），拖不动；要自由起点把起点改成"自定"'); this.draw(); return; }
      this.drag = this._pointDrag([...host.sel.points], mx, my, e.altKey); host.dragBegin(e.altKey ? '改离地高度' : '移动控制点'); this.draw(); return;
    }
    if (hit && hit.kind === 'v0') { const pi = host.physicsInfo(seg); this.drag = { kind: 'v0', alt: e.altKey, tip: pi.tipW.slice(), y0: this.pickVertical(mx, my, pi.tipW) }; host.dragBegin('改初速'); return; }
    if (hit && hit.kind === 'landing') { this.drag = { kind: 'landing' }; host.dragBegin('拖落点'); return; }
    if (hit && hit.kind === 'apex') { const pi = host.physicsInfo(seg); this.drag = { kind: 'apex', p: pi.apexW.slice(), y0: this.pickVertical(mx, my, pi.apexW) }; host.dragBegin('改最高点'); return; }
    if (hit && hit.kind === 'start') {
      if (host.pinned(seg)) { host.status('起点被锚住（锚点 / 上一段末点）；要自由起点把起点改成"自定"'); host.selectSegment(host.segIndex); return; }
      const pi = host.physicsInfo(seg); this.drag = { kind: 'start', p: pi.startW.slice(), h: cal.worldToXZH(pi.startW[0], pi.startW[1], pi.startW[2]).h }; host.dragBegin('移动起点'); return;
    }
    if (hit && hit.kind === 'curve') { host.selectSegmentScope(hit.i); this.draw(); return; }
    // Shift+空白拖 = 框选（投影到屏幕）；普通空白拖 = 环绕（松手没拖动才算"点空白"清选择）
    if (e.shiftKey) { this.drag = { kind: 'box', mx, my }; this.box = { x0: mx, y0: my, x1: mx, y1: my }; return; }
    this._orbit(e, mx, my); this.drag.clearOnUp = true;
  }
  _pointDrag(indices, mx, my, alt) {
    const host = this.host, seg = host.activeSeg();
    const pts = host.effPoints(seg);
    const starts = indices.map((i) => ({ i, x: pts[i].x, z: pts[i].z, h: pts[i].h, pos: pts[i].pos.slice() }));
    const ref = starts[0];
    return { kind: 'points', starts, alt, plane: ref.pos[1], p0: this.pickPlane(mx, my, ref.pos[1]), y0: this.pickVertical(mx, my, ref.pos), moved: false };
  }
  _dragLanding(mx, my) {
    const host = this.host, seg = host.activeSeg(); if (!seg) return;
    const g = this.pickGround(mx, my); if (!g) return;
    host.dragTick(() => Edit.setLanding(host, seg, [g[0], g[2]]));
  }
  _move(e) {
    if (!this.ok) return;
    const [mx, my] = this._pos(e);
    const host = this.host, cal = host.cal;
    if (!this.drag) {
      const inside = mx >= 0 && my >= 0 && mx <= this.c.clientWidth && my <= this.c.clientHeight;
      if (inside && cal) { const g = this.pickGround(mx, my); host.onCursorWorld(g); } else host.onCursorWorld(null);
      const hit = inside ? this._hit(mx, my) : null;
      const t = host.tool;
      this.c.style.cursor = t === 'pan' ? 'grab' : t === 'anchor' || t === 'pen' || t === 'physics' ? 'crosshair' : hit ? (hit.kind === 'height' || hit.kind === 'apex' ? 'ns-resize' : hit.kind === 'curve' ? 'pointer' : hit.kind === 'gz-move' ? 'move' : 'grab') : 'default';
      return;
    }
    const d = this.drag;
    if (d.kind === 'orbit') { const dx = e.clientX - d.mx, dy = e.clientY - d.my; if (Math.hypot(dx, dy) > 2) d.moved = true; this.cam.yaw = d.cam.yaw + dx * 0.006; this.cam.pitch = clamp(d.cam.pitch - dy * 0.006, -1.5, 1.5); this.draw(); return; }
    if (d.kind === 'box') { this.box = { x0: Math.min(d.mx, mx), y0: Math.min(d.my, my), x1: Math.max(d.mx, mx), y1: Math.max(d.my, my) }; this.draw(); return; }
    if (d.kind === 'gz-move') {
      if (!d.moved) { if (d.sx == null) { d.sx = mx; d.sy = my; } if (Math.hypot(mx - d.sx, my - d.sy) < 3) return; d.moved = true; }   // 3px 死区
      const p = this.pickPlane(mx, my, d.plane); if (!p || !d.p0) return; host.applyTransform(Edit.T.translate3(p[0] - d.p0[0], p[2] - d.p0[2], 0)); return;
    }
    if (d.kind === 'pan') {
      const dx = e.clientX - d.mx, dy = e.clientY - d.my; if (Math.hypot(dx, dy) > 2) d.moved = true;
      const { eye } = this._mvp();
      const f = [d.cam.tx - eye[0], d.cam.ty - eye[1], d.cam.tz - eye[2]];
      const rt = norm3(cross3(f, [0, 1, 0])), upv = norm3(cross3(rt, f));
      const k = d.cam.dist * 0.0012;
      this.cam.tx = d.cam.tx - rt[0] * dx * k + upv[0] * dy * k; this.cam.ty = d.cam.ty - rt[1] * dx * k + upv[1] * dy * k; this.cam.tz = d.cam.tz - rt[2] * dx * k + upv[2] * dy * k;
      this.draw(); return;
    }
    const seg = host.activeSeg();
    if (d.kind === 'anchor') { const g = this.pickGround(mx, my); if (g) host.dragTick(() => host.setAnchorFromGround(g)); return; }
    if (d.kind === 'points') {
      d.moved = true;
      const alt = d.alt || e.altKey;
      host.dragTick(() => {
        if (alt) { const y = this.pickVertical(mx, my, d.starts[0].pos); if (y == null || d.y0 == null) return; const dh = y - d.y0; for (const st of d.starts) Edit.setPoint(host, seg, st.i, { h: st.h + dh }); }
        else { const p = this.pickPlane(mx, my, d.plane); if (!p || !d.p0) return; const dx = p[0] - d.p0[0], dz = p[2] - d.p0[2]; for (const st of d.starts) Edit.setPoint(host, seg, st.i, { x: st.x + dx, z: st.z + dz }); }
      });
      return;
    }
    if (d.kind === 'height') { const y = this.pickVertical(mx, my, d.p); if (y == null || d.y0 == null) return; host.dragTick(() => Edit.setPoint(host, seg, d.i, { h: d.h0 + (y - d.y0) })); return; }
    if (d.kind === 'v0') {
      const alt = d.alt || e.altKey;
      host.dragTick(() => {
        if (alt) { const y = this.pickVertical(mx, my, d.tip); if (y == null || d.y0 == null) return; Edit.setTip(host, seg, [d.tip[0], d.tip[1] + (y - d.y0), d.tip[2]]); }
        else { const p = this.pickPlane(mx, my, d.tip[1]); if (!p) return; Edit.setTip(host, seg, [p[0], d.tip[1], p[2]]); }
      });
      return;
    }
    if (d.kind === 'landing') { this._dragLanding(mx, my); return; }
    if (d.kind === 'apex') { const y = this.pickVertical(mx, my, d.p); if (y == null || d.y0 == null) return; host.dragTick(() => Edit.setApex(host, seg, d.p[1] + (y - d.y0))); return; }
    if (d.kind === 'start') { const p = this.pickPlane(mx, my, d.p[1]); if (!p) return; host.dragTick(() => Edit.setExplicitStart(host, seg, { x: p[0], z: p[2], h: d.h })); return; }
  }
  _up(e) {
    if (!this.drag) return;
    const d = this.drag; this.drag = null;
    const host = this.host;
    if (d.kind === 'orbit') { if (d.clearOnUp && !d.moved) { host.clearSelection(); } return; }
    if (d.kind === 'box') {
      const b = this.box; this.box = null;
      const seg = host.activeSeg();
      if (b && (b.x1 - b.x0 > 3 || b.y1 - b.y0 > 3) && seg && seg.kind === 'manual') {
        const inside = [];
        host.effPoints(seg).forEach((p, i) => { const c = this.project(p.pos); if (c && c[0] >= b.x0 && c[0] <= b.x1 && c[1] >= b.y0 && c[1] <= b.y1) inside.push(i); });
        if (inside.length) host.selectPoints(inside, false);
      }
      this.draw(); return;
    }
    if (d.kind === 'gz-move') { host.endTransform('移动'); return; }
    if (d.kind === 'pan') { if (d.hit && !d.moved && d.hit.kind === 'point') { host.op('删除控制点', () => Edit.deletePoints(host, host.activeSeg(), [d.hit.i]) || host.status('至少留一个点', 'err')); } return; }
    if (d.kind === 'points' && !d.moved && !d.fresh) host.selectPoint(d.starts[0].i, false);
    host.dragEnd();
    if (d.fresh && host.tool === 'physics') host.setTool('select');
  }
  /** 键盘微移（世界 x / z，wu）：选中点 → 逐点；整段 / 整条 → 变换 */
  nudge(dx, dz) {
    const host = this.host, seg = host.activeSeg();
    if (!seg || !host.cal || host.doc.space !== 'world') return;
    if (host.sel.scope === 'points' && host.sel.points.size && seg.kind === 'manual') {
      host.op('微移控制点', () => { for (const i of host.sel.points) { const p = Edit.effPoints(host, seg)[i]; Edit.setPoint(host, seg, i, { x: p.x + dx, z: p.z + dz }); } });
    } else {
      if (host.sel.scope === 'points') { host.setScope('segment'); host.status('没有选中的点：按"整段"微移（要挪单个点先选点）'); }
      host.beginTransform(); host.applyTransform(Edit.T.translate3(dx, dz, 0)); host.endTransform('微移');
    }
  }
}

// ---------------------------------------------------------------- shaders
const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUV; uniform mat4 uMVP; out vec2 vUV;
void main(){ vUV = aUV; gl_Position = uMVP * vec4(aPos, 1.0); }`;
const MESH_FS = `#version 300 es
precision mediump float; in vec2 vUV; uniform sampler2D uTex; out vec4 o;
void main(){ o = vec4(texture(uTex, vUV).rgb, 1.0); }`;
const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos; uniform mat4 uMVP; uniform float uPointSize;
void main(){ gl_Position = uMVP * vec4(aPos, 1.0); gl_PointSize = uPointSize; }`;
const LINE_FS = `#version 300 es
precision mediump float; uniform vec4 uColor; out vec4 o; void main(){ o = uColor; }`;
const BILL_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUV; uniform mat4 uMVP; out vec2 vUV;
void main(){ vUV = aUV; gl_Position = uMVP * vec4(aPos, 1.0); }`;
const BILL_FS = `#version 300 es
precision mediump float; in vec2 vUV; uniform sampler2D uTex; uniform float uAlpha; uniform int uHas; out vec4 o;
void main(){ vec4 c = uHas == 1 ? texture(uTex, vUV) : vec4(0.42, 0.7, 1.0, 0.6); o = vec4(c.rgb, c.a * uAlpha); }`;
