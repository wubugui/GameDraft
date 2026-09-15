'use strict';
/* 地形工作台 · 3D 视图（裸 WebGL2，不引第三方库）。
 *
 * 画什么：深度还原出的场景三角网（贴背景）、**碰撞格**（贴在行走面上的彩色小方片：阻挡红 / 作者改成可走的绿 /
 * 走不到的黄）、多边形区域与高度操作的贴地折线、笔刷光标圈、出生点 / 出口 / 跨点 / NPC 标记。
 * 世界坐标 = M-world wu（+Y 上、XZ 地面），与灯位 / 轨迹 / 回音同一坐标系；网格单位 × wuPerQ = wu。
 *
 * ⚠ M-world 是**左手系**：x 画面右、Y 上、**Z 进画**。相机的 forward / right / camUp / eye 与 `common.js` 的**左手 lookAt**
 * 是同一套（yaw=0 看向 +Z、右 = up × forward、上 = forward × right、机位 = 目标 − forward·dist）。拿右手那套画它整张镜像且不报错
 * （声学 / 轨迹两台各中过一次）。判据钉在自检 S3。
 *
 * 交互按 Unity 场景视图搭（与另外几台同一套手势表）：
 *   相机：右键拖 = 环视（按住时 WASD/QE 飞、Shift ×3、滚轮调速）· Alt+左键 = 环绕 · 中键 / 空格+左键 = 平移 ·
 *        滚轮 = 朝光标缩放 · Alt+右键 = 推拉 · F = 对准选中 · Home = 整场 · 右上角坐标架：点臂 = 正交侧视，点中心 = 透视 ⇄ 正交
 *   工具（语义在 app.js 的 host.toolDown/Move/Up，2D 与 3D 共用一份）：
 *        V 选择（点顶点 / 点区域内部；gizmo 与轨迹台共用 /vendor/gizmo.js，选中立刻出现）
 *        P 多边形 · B 矩形 · K 笔刷（按住拖）· H 高度 · I 检视 · 空格/中键 平移
 * 飞行步进用 setInterval(16ms)：rAF 在隐藏页 / 无头壳里不跑。 */

const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);
const KEY2CODE = { w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', q: 'KeyQ', e: 'KeyE', shift: 'ShiftLeft', ' ': 'Space' };
const PITCH_MAX = Math.PI / 2 - 0.02;
function keyCode3(e) { if (e.code) return e.code; const k = (e.key || '').toLowerCase(); return KEY2CODE[k] || ''; }
function isTyping3(e) { const t = e.target; return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || !!t.isContentEditable); }
const PICK_R = 12;
const PICK_TIE = 1.5;
/** 点物体标记：离光标最近的那个；并列才看选中项（与粒子台同一条） */
function pickObjectAt(objs, project, mx, my, selKey) {
  let best = Infinity; const cand = [];
  for (const o of objs) {
    const c = project(o.pos); if (!c) continue;
    const d = Math.hypot(c[0] - mx, c[1] - my);
    if (d > PICK_R) continue;
    cand.push({ o, d }); if (d < best) best = d;
  }
  if (!cand.length) return null;
  const tied = cand.filter((x) => x.d <= best + PICK_TIE);
  const keep = tied.find((x) => x.o.key === selKey);
  return (keep || tied[0]).o;
}
const TOOL_CURSOR = { select: 'default', polyWalk: 'crosshair', polyBlock: 'crosshair', rectWalk: 'crosshair', rectBlock: 'crosshair',
  brush: 'none', height: 'none', inspect: 'help', pan: 'grab' };

class View3D {
  constructor(canvas, overlay, host) {
    this.c = canvas; this.overlay = overlay; this.host = host;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    this.gl = gl; this.ok = !!gl;
    if (!gl) return;
    this.cam = { yaw: 0.35, pitch: 0.35, dist: 2500, tx: 0, ty: 0, tz: 0, fov: 55, ortho: false, orthoH: 1000, speed: 1 };
    this.mesh = null; this.tex = null; this.gridLines = null;
    this.cells = null;                                   // {vao, posBuf, colBuf, count, colorsRev}
    this.drag = null; this.hover = null; this.readout = null;
    this.fly = null; this.keys = new Set(); this.spaceDown = false;
    this.heldAfterFly = new Set();
    this._timer = 0; this._lastT = 0;
    this.cursorWorld = null;
    this.progMesh = this._prog(MESH_VS3, MESH_FS3);
    this.progLine = this._prog(LINE_VS3, LINE_FS3);
    this.progCell = this._prog(CELL_VS3, CELL_FS3);
    this.lineBuf = gl.createBuffer();
    this._bind();
  }
  resize() {
    const r = this.c.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    this.c.width = Math.max(1, Math.round(r.width * dpr)); this.c.height = Math.max(1, Math.round(r.height * dpr));
    if (this.overlay) { this.overlay.width = this.c.width; this.overlay.height = this.c.height; }
    this.draw();
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
  // ------------------------------------------------------------- 数据
  setMesh(buf) {
    const gl = this.gl;
    if (!buf) { this.mesh = null; this.gridLines = null; return; }
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
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) { const v = verts[i * 5 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
    this.mesh = { vao, count: ni, mn, mx, verts, nv };
    this.gridLines = null;
  }
  setTexture(img) {
    const gl = this.gl;
    this.texSrc = img ? img.src : '';
    if (!img) { this.tex = null; return; }
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex = t;
  }
  /** 碰撞格的几何（位置一场一份；颜色随合成结果换） */
  setCells(positions) {
    const gl = this.gl;
    if (!positions) { this.cells = null; return; }
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const posBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const colBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions.length / 3 * 4), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.cells = { vao, posBuf, colBuf, count: positions.length / 3, colorsRev: -1 };
  }
  _syncCellColors() {
    const c = this.cells; if (!c) return;
    const cc = this.host.cellColors();
    if (!cc || cc.rev === c.colorsRev) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, c.colBuf); gl.bufferData(gl.ARRAY_BUFFER, cc.colors, gl.DYNAMIC_DRAW);
    c.colorsRev = cc.rev;
  }
  // ------------------------------------------------------------- 相机
  _forward(c = this.cam) { return [Math.cos(c.pitch) * Math.sin(c.yaw), -Math.sin(c.pitch), Math.cos(c.pitch) * Math.cos(c.yaw)]; }
  _right(c = this.cam) { const f = this._forward(c); return norm3([f[2], 0, -f[0]]); }
  _camUp(c = this.cam) { return norm3(cross3(this._forward(c), this._right(c))); }
  _eye(c = this.cam) { const f = this._forward(c); return [c.tx - f[0] * c.dist, c.ty - f[1] * c.dist, c.tz - f[2] * c.dist]; }
  eye() { return this._eye(); }
  _mvp() {
    const c = this.cam, W = this.c.width, H = this.c.height, aspect = W / Math.max(H, 1);
    const eye = this._eye(c);
    const view = lookAt(eye, [c.tx, c.ty, c.tz], [0, 1, 0]);
    const far = c.dist * 20 + 1e4;
    const proj = c.ortho ? ortho(c.orthoH, aspect, -far, far) : perspective(c.fov * Math.PI / 180, aspect, Math.max(1, c.dist * 0.01), far);
    return { mvp: mul4(proj, view), eye };
  }
  _worldPerPx(p) {
    const c = this.cam, H = this.c.clientHeight || 1;
    if (c.ortho) return 2 * c.orthoH / H;
    const eye = this._eye(c), f = this._forward(c);
    const depth = Math.max(1, (p[0] - eye[0]) * f[0] + (p[1] - eye[1]) * f[1] + (p[2] - eye[2]) * f[2]);
    return depth / ((H / 2) / Math.tan(c.fov * Math.PI / 360));
  }
  _viewDir(p) { if (this.cam.ortho) return this._forward(); const eye = this._eye(); return norm3([p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]]); }
  _setDist(d) { const c = this.cam; c.dist = clamp(d, 20, 1e6); c.orthoH = c.dist * Math.tan(c.fov * Math.PI / 360); }
  _reach() { return Math.max(200000, this.cam.dist * 40 + 2e4); }
  setOrtho(on) {
    const c = this.cam, t = Math.tan(c.fov * Math.PI / 360);
    if (on && !c.ortho) c.orthoH = c.dist * t;
    else if (!on && c.ortho) c.dist = clamp(c.orthoH / t, 20, 1e6);
    c.ortho = !!on; this.draw();
  }
  snapView(axis, sign) {
    const c = this.cam; sign = sign || 1;
    if (axis === 'x') { c.yaw = -sign * Math.PI / 2; c.pitch = 0; }
    else if (axis === 'z') { c.yaw = sign > 0 ? Math.PI : 0; c.pitch = 0; }
    else c.pitch = sign * PITCH_MAX;
    this.setOrtho(true);
  }
  /** 顶视（正交、从 +Y 看、画面上 = +Z）：碰撞格铺成一张图，最像主编辑器 / 实验室里那张碰撞图 */
  topView() { const c = this.cam; c.yaw = 0; c.pitch = PITCH_MAX; this.setOrtho(true); }
  worldBounds() {
    const m = this.mesh;
    const mn = m ? m.mn.slice() : [-1000, -100, -1000], mx = m ? m.mx.slice() : [1000, 300, 1000];
    return { mn, mx };
  }
  fit(onlyScene) {
    const b = this.worldBounds();
    const cx = (b.mn[0] + b.mx[0]) / 2, cz = (b.mn[2] + b.mx[2]) / 2, cy = (b.mn[1] + b.mx[1]) / 2;
    const ext = Math.max(b.mx[0] - b.mn[0], b.mx[2] - b.mn[2], b.mx[1] - b.mn[1], 200);
    const c = this.cam, cal = this.host.cal;
    const anchor = onlyScene ? null : this.host.anchorWorld();
    const focus = anchor || [cx, cy, cz];
    c.tx = focus[0] * 0.6 + cx * 0.4; c.ty = focus[1] * 0.6 + cy * 0.4; c.tz = focus[2] * 0.6 + cz * 0.4;
    if (cal) { const v = cal.viewDirWorld ? cal.viewDirWorld() : [0, 0, 1]; c.yaw = Math.atan2(v[0], v[2]) + 0.25; } else c.yaw = 0.35;
    c.pitch = 0.5; c.ortho = false;
    this._setDist(ext * 0.9);
    this.draw();
  }
  focus(p, radius) {
    const c = this.cam;
    c.tx = p[0]; c.ty = p[1]; c.tz = p[2];
    this._setDist(Math.max(80, (radius || 120) * 3));
    this.draw();
  }
  // ------------------------------------------------------------- 拾取
  project(p) { const { mvp } = this._mvp(); return projectPoint(mvp, p, this.c.clientWidth, this.c.clientHeight); }
  ray(mx, my) { const { mvp } = this._mvp(); const inv = inv4(mvp); if (!inv) return null; return unprojectRay(inv, mx, my, this.c.clientWidth, this.c.clientHeight); }
  _floorY() { const m = this.mesh; return m ? m.mn[1] : 0; }
  pickGround(mx, my) {
    const cal = this.host.cal, r = this.ray(mx, my); if (!r) return null;
    if (cal && cal.hf) { const g = rayGround(r, cal, this._reach()); if (g) return g; }
    return rayPlane(r, [0, this._floorY(), 0], [0, 1, 0]);
  }
  pickPlane(mx, my, py) { const r = this.ray(mx, my); return r ? rayPlane(r, [0, py, 0], [0, 1, 0]) : null; }
  groundY(x, z) { const cal = this.host.cal; return cal && cal.hf ? cal.groundHeight(x, z) : this._floorY(); }
  // ------------------------------------------------------------- gizmo
  _proj() {
    return {
      dim: 3, project: (p) => this.project(p), worldPerPx: (p) => this._worldPerPx(p),
      axisParam: (mx, my, p0, a) => { const r = this.ray(mx, my); return r ? rayLineParam(r, p0, a) : null; },
      planePoint: (mx, my, p0, a, b) => { const r = this.ray(mx, my); return r ? rayPlane(r, p0, cross3(a, b)) : null; },
      groundPoint: (mx, my, p0) => this.pickGround(mx, my) || this.pickPlane(mx, my, p0[1]),
      viewPlanePoint: (mx, my, p0) => { const r = this.ray(mx, my); return r ? rayPlane(r, p0, this._viewDir(p0)) : null; },
      eyeAbove: (p0) => this._eye()[1] >= p0[1],
    };
  }
  _gizmo() {
    const host = this.host;
    if (!host.doc || host.tool !== 'select') return null;
    const pv = host.gizmoPivot(); if (!pv) return null;
    return Gizmo.geom(this._proj(), GZ_CFG.build(GZ_CFG.world3, pv.kind), pv.pivot, pv.mode || host.gizmoMode, pv.n, pv.label);
  }
  _hotPart() { return this.drag && this.drag.kind === 'gz' ? this.drag.part : (this.hover && this.hover.kind === 'gz' ? this.hover.part : null); }
  _hitGizmo(mx, my) {
    const g = this._gizmo(); if (!g) return null;
    const part = Gizmo.hit(g, mx, my);
    return part ? { kind: 'gz', part } : null;
  }
  _gzDown(part, mx, my) {
    const g = this._gizmo(); if (!g) return;
    const host = this.host;
    const d = Gizmo.dragBegin(this._proj(), g, part, mx, my);
    d.key = host.sel.key; d.base = host.gizmoBase(host.sel.key);
    if (!d.base) return;
    this.drag = d; host.dragBegin(host.gizmoLabel());
  }
  _gzMove(d, mx, my, e) {
    const host = this.host;
    const res = Gizmo.dragUpdate(this._proj(), d, mx, my, e.ctrlKey || e.metaKey); if (!res) return;
    this.readout = { x: mx + 16, y: my + 22, text: res.text };
    host.dragTick(() => host.applyGizmo(d.key, d.base, res));
  }
  // ------------------------------------------------------------- 绘制
  draw() {
    const gl = this.gl; if (!gl) return;
    const host = this.host, cal = host.cal;
    gl.viewport(0, 0, this.c.width, this.c.height);
    gl.clearColor(0.075, 0.085, 0.105, 1); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const { mvp } = this._mvp();
    if (this.mesh && this.tex && host.layers.mesh) {
      gl.useProgram(this.progMesh);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.progMesh, 'uMVP'), false, mvp);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(gl.getUniformLocation(this.progMesh, 'uTex'), 0);
      gl.uniform1f(gl.getUniformLocation(this.progMesh, 'uDim'), host.layers.dimMesh ? 0.45 : 1.0);
      gl.bindVertexArray(this.mesh.vao); gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_INT, 0); gl.bindVertexArray(null);
    }
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // 碰撞格：贴在行走面上、略抬高；不做深度写入（半透明叠色）
    if (this.cells && host.layers.cells) {
      this._syncCellColors();
      gl.depthMask(false);
      gl.useProgram(this.progCell);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.progCell, 'uMVP'), false, mvp);
      gl.bindVertexArray(this.cells.vao); gl.drawArrays(gl.TRIANGLES, 0, this.cells.count); gl.bindVertexArray(null);
      gl.depthMask(true);
      const ol = host.cellOutline();
      if (ol && host.layers.cellLines) { gl.disable(gl.DEPTH_TEST); this._lines(mvp, ol, [1, 1, 1, 0.07], gl.LINES, 1); gl.enable(gl.DEPTH_TEST); }
    }
    if (host.layers.grid && cal && cal.hf) this._groundGrid(mvp);
    // 区域 / 高度操作 / 草稿：贴地折线，不做深度测试（被地形挡住也得看得见）
    gl.disable(gl.DEPTH_TEST);
    for (const l of host.regionLines3()) if (l.pts.length) this._lines(mvp, l.pts, l.color, gl.LINES, l.width || 1);
    const bc = host.brushCursor();
    if (bc && this.cursorWorld && host.tool !== 'select') this._ring(mvp, bc.center, bc.radius, bc.color);
    for (const o of host.objects()) this._marker(mvp, o.pos, o.color, o.size);
    if (host.layers.marks) for (const m of (host.marks || [])) {
      this._marker(mvp, m.world, MARK_COLOR[m.kind] || [0.7, 0.7, 0.8, 0.9], m.kind === 'spawn' ? 9 : 7);
      if (m.range) this._ring(mvp, m.world, m.range, MARK_COLOR[m.kind] || [0.7, 0.7, 0.8, 0.5]);
    }
    gl.enable(gl.DEPTH_TEST);
    this._overlay();
  }
  _groundGrid(mvp) {
    const cal = this.host.cal, hf = cal.hf;
    if (!this.gridLines) {
      const b = cal.groundBounds || [hf.x0, hf.x0 + hf.dx * (hf.n - 1), hf.z0, hf.z0 + hf.dz * (hf.n - 1)];
      const step = 176, arr = [];   // 2 米一格（1 m = 88 wu，角色高 150 wu ≈ 1.7 m）
      for (let x = Math.ceil(b[0] / step) * step; x <= b[1]; x += step) for (let z = b[2]; z < b[3]; z += step / 4) { const z2 = Math.min(b[3], z + step / 4); arr.push(x, cal.groundHeight(x, z) + 0.5, z, x, cal.groundHeight(x, z2) + 0.5, z2); }
      for (let z = Math.ceil(b[2] / step) * step; z <= b[3]; z += step) for (let x = b[0]; x < b[1]; x += step / 4) { const x2 = Math.min(b[1], x + step / 4); arr.push(x, cal.groundHeight(x, z) + 0.5, z, x2, cal.groundHeight(x2, z) + 0.5, z); }
      this.gridLines = new Float32Array(arr);
    }
    this._lines(mvp, this.gridLines, [1, 1, 1, 0.09], this.gl.LINES, 1);
  }
  /** 贴地圆环（笔刷光标 / 出口范围） */
  _ring(mvp, c, r, color) {
    if (!(r > 0)) return;
    const arr = [], n = 40;
    for (let i = 0; i < n; i++) {
      const t0 = i / n * Math.PI * 2, t1 = (i + 1) / n * Math.PI * 2;
      const x0 = c[0] + Math.cos(t0) * r, z0 = c[2] + Math.sin(t0) * r, x1 = c[0] + Math.cos(t1) * r, z1 = c[2] + Math.sin(t1) * r;
      arr.push(x0, this.groundY(x0, z0) + 1.5, z0, x1, this.groundY(x1, z1) + 1.5, z1);
    }
    this._lines(mvp, new Float32Array(arr), color, this.gl.LINES, 1.5);
  }
  _lines(mvp, arr, color, mode, width) {
    const gl = this.gl;
    gl.useProgram(this.progLine);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progLine, 'uMVP'), false, mvp);
    gl.uniform4fv(gl.getUniformLocation(this.progLine, 'uColor'), color);
    gl.uniform1f(gl.getUniformLocation(this.progLine, 'uPointSize'), (width || 1) * (window.devicePixelRatio || 1));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, arr instanceof Float32Array ? arr : new Float32Array(arr), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(1);
    gl.drawArrays(mode, 0, arr.length / 3);
  }
  _marker(mvp, p, color, size) { this._lines(mvp, [p[0], p[1], p[2]], color, this.gl.POINTS, size); }
  // ------------------------------------------------------------- 右上角坐标架
  _sceneGizmoLayout() {
    const ov = this.overlay; const W = ov ? ov.clientWidth : this.c.clientWidth;
    const ox = W - 58, oy = 68, R = 28;
    const f = this._forward(), r = this._right(), u = this._camUp();
    const arms = [];
    for (const [k, a] of [['x', [1, 0, 0]], ['y', [0, 1, 0]], ['z', [0, 0, 1]]]) {
      const sx = dot3(a, r), sy = -dot3(a, u), dz = dot3(a, f);
      arms.push({ axis: k, sign: 1, x: ox + sx * R, y: oy + sy * R, depth: dz });
      arms.push({ axis: k, sign: -1, x: ox - sx * R, y: oy - sy * R, depth: -dz });
    }
    arms.sort((a, b) => b.depth - a.depth);
    return { ox, oy, R, arms };
  }
  _hitSceneGizmo(mx, my) {
    const lay = this._sceneGizmoLayout();
    if (Math.hypot(mx - lay.ox, my - lay.oy) > lay.R + 14) return null;
    if (Math.hypot(mx - lay.ox, my - lay.oy) <= 7) return { kind: 'center' };
    let best = null, bd = 1e9;
    for (const a of lay.arms) { const d = Math.hypot(mx - a.x, my - a.y); const lim = a.sign > 0 ? 9 : 7; if (d <= lim && d < bd) { best = a; bd = d; } }
    return best ? { kind: 'axis', axis: best.axis, sign: best.sign } : null;
  }
  _drawSceneGizmo(g) {
    const lay = this._sceneGizmoLayout(); const hot = this.hover && this.hover.kind === 'scene' ? this.hover.sg : null;
    g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.arc(lay.ox, lay.oy, lay.R + 14, 0, Math.PI * 2); g.fill();
    g.font = 'bold 10px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const a of lay.arms) {
      const isHot = hot && hot.kind === 'axis' && hot.axis === a.axis && hot.sign === a.sign;
      const colr = isHot ? GZ.col.hot : GZ.col[a.axis];
      if (a.sign > 0) {
        g.strokeStyle = colr; g.lineWidth = 2; g.beginPath(); g.moveTo(lay.ox, lay.oy); g.lineTo(a.x, a.y); g.stroke();
        g.fillStyle = colr; g.beginPath(); g.arc(a.x, a.y, 7, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#111'; g.fillText(a.axis.toUpperCase(), a.x, a.y + 0.5);
      } else {
        g.strokeStyle = colr; g.lineWidth = 1.5; g.fillStyle = 'rgba(20,22,26,.9)'; g.beginPath(); g.arc(a.x, a.y, 5, 0, Math.PI * 2); g.fill(); g.stroke();
      }
    }
    const cHot = hot && hot.kind === 'center';
    g.fillStyle = cHot ? GZ.col.hot : 'rgba(230,232,236,.9)'; g.fillRect(lay.ox - 4, lay.oy - 4, 8, 8);
    g.fillStyle = 'rgba(255,255,255,.75)'; g.fillText(this.cam.ortho ? '正交' : '透视', lay.ox, lay.oy + lay.R + 24);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif'; g.lineWidth = 1;
  }
  _overlay() {
    const ov = this.overlay; if (!ov) return;
    const g = ov.getContext('2d'); const dpr = window.devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, ov.clientWidth, ov.clientHeight);
    g.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif'; g.textBaseline = 'alphabetic';
    const host = this.host;
    if (host.layers.marks) for (const m of (host.marks || [])) {
      const c = this.project(m.world); if (!c) continue;
      const col = MARK_COLOR[m.kind] || [0.7, 0.7, 0.8, 0.9];
      g.fillStyle = `rgba(${Math.round(col[0] * 255)},${Math.round(col[1] * 255)},${Math.round(col[2] * 255)},.9)`;
      g.fillText((MARK_LABEL[m.kind] || '') + m.id, c[0] + 9, c[1] - 7);
    }
    for (const o of host.objects()) {
      if (!o.label) continue;
      const c = this.project(o.pos); if (!c) continue;
      g.fillStyle = o.selected ? GZ.col.hot : 'rgba(230,232,236,.85)';
      g.fillText(o.label, c[0] + 9, c[1] - 7);
    }
    for (const t of host.labels3()) { const c = this.project(t.pos); if (!c) continue; g.fillStyle = t.color || 'rgba(230,232,236,.85)'; g.fillText(t.text, c[0] + 4, c[1] - 4); }
    const gz = this._gizmo();
    if (gz) Gizmo.draw(g, gz, this._hotPart());
    if (this.readout) Gizmo.drawReadout(g, this.readout);
    this._drawSceneGizmo(g);
  }
  // ------------------------------------------------------------- 交互
  _bind() {
    const c = this.c;
    c.tabIndex = 0;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.fly) {
        this.cam.speed = clamp(this.cam.speed * Math.exp(-e.deltaY * 0.0015), 0.05, 20); this.host.status(`飞行速度 ×${fmt(this.cam.speed, 2)}`);
        if (this.drag && this.drag.kind === 'look') this.drag.moved = true;
        this.draw(); return;
      }
      // 笔刷 / 高度工具下 Shift+滚轮 = 改半径（与 [ ] 同）
      if (e.shiftKey && this.host.wheelRadius) { this.host.wheelRadius(e.deltaY < 0 ? 1 : -1); return; }
      const [mx, my] = this._pos(e); this._zoomAt(mx, my, Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
    c.addEventListener('mousedown', (e) => { c.focus(); this._down(e); });
    c.addEventListener('dblclick', (e) => this._dbl(e));
    c.addEventListener('mouseleave', () => { this.cursorWorld = null; this.host.onCursorWorld(null); this.draw(); });
    window.addEventListener('mousemove', (e) => this._move(e));
    window.addEventListener('mouseup', (e) => this._up(e));
    window.addEventListener('keydown', (e) => this._keyDown(e), true);
    window.addEventListener('keyup', (e) => this._keyUp(e), true);
    window.addEventListener('blur', () => { this.keys.clear(); this.heldAfterFly.clear(); this.spaceDown = false; });
  }
  _pos(e) { const r = this.c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  capturesKeys() { return !!this.fly; }
  flying() { return !!this.fly; }
  _keyDown(e) {
    const code = keyCode3(e);
    if (code === 'Space' && !isTyping3(e)) this.spaceDown = true;
    if (!this.fly) {
      if (e.repeat && this.heldAfterFly.has(code)) { e.preventDefault(); e.stopImmediatePropagation(); }
      return;
    }
    if (FLY_KEYS.has(code)) {
      this.keys.add(code); e.preventDefault(); e.stopImmediatePropagation();
      if (this.drag && this.drag.kind === 'look') this.drag.moved = true;
    }
  }
  _keyUp(e) {
    const code = keyCode3(e);
    if (code === 'Space') this.spaceDown = false;
    this.keys.delete(code); this.heldAfterFly.delete(code);
    if (code === 'ShiftLeft' || code === 'ShiftRight') { this.keys.delete('ShiftLeft'); this.keys.delete('ShiftRight'); this.heldAfterFly.delete('ShiftLeft'); this.heldAfterFly.delete('ShiftRight'); }
  }
  _orbit(e) { this.drag = { kind: 'orbit', mx: e.clientX, my: e.clientY, cam: Object.assign({}, this.cam), moved: false }; this.c.style.cursor = 'grabbing'; }
  _pan(e) { this.drag = { kind: 'pan', mx: e.clientX, my: e.clientY, cam: Object.assign({}, this.cam), wpp: this._worldPerPx([this.cam.tx, this.cam.ty, this.cam.tz]) }; this.c.style.cursor = 'grabbing'; }
  _zoomAt(mx, my, factor) {
    const c = this.cam, cal = this.host.cal, r = this.ray(mx, my), f = this._forward();
    let P = null;
    if (r && cal && cal.hf) P = rayGround(r, cal, this._reach());
    if (!P && r) P = rayPlane(r, [c.tx, c.ty, c.tz], f);
    if (c.ortho) c.orthoH = clamp(c.orthoH * factor, 5, 2e5); else c.dist = clamp(c.dist * factor, 20, 1e6);
    if (P) { const r2 = this.ray(mx, my); const P2 = r2 && rayPlane(r2, P, f); if (P2) { c.tx += P[0] - P2[0]; c.ty += P[1] - P2[1]; c.tz += P[2] - P2[2]; } }
    this.draw();
  }
  _flyStep(dt) {
    const c = this.cam, k = this.keys; if (!k.size) return false;
    const f = this._forward(c), r = this._right(c), sh = k.has('ShiftLeft') || k.has('ShiftRight');
    const mv = [0, 0, 0]; const add = (v, s) => { mv[0] += v[0] * s; mv[1] += v[1] * s; mv[2] += v[2] * s; };
    let fwd = 0;
    if (k.has('KeyW')) fwd += 1; if (k.has('KeyS')) fwd -= 1;
    if (k.has('KeyD')) add(r, 1); if (k.has('KeyA')) add(r, -1);
    if (k.has('KeyE')) add([0, 1, 0], 1); if (k.has('KeyQ')) add([0, 1, 0], -1);
    const gain = c.speed * (sh ? 3 : 1);
    if (c.ortho && fwd) c.orthoH = clamp(c.orthoH * Math.exp(-fwd * 1.2 * gain * dt), 5, 2e5); else add(f, fwd);
    if (!mv[0] && !mv[1] && !mv[2] && !(c.ortho && fwd)) return false;
    const step = (c.ortho ? c.orthoH * 2 : c.dist) * 0.9 * gain * dt;
    c.tx += mv[0] * step; c.ty += mv[1] * step; c.tz += mv[2] * step;
    if (this.drag && this.drag.kind === 'look') { this.drag.eye = this._eye(c); this.drag.moved = true; }
    return true;
  }
  _flyLoop() {
    if (this._timer) return;
    this._lastT = performance.now();
    this._timer = setInterval(() => {
      if (!this.fly) { clearInterval(this._timer); this._timer = 0; return; }
      const now = performance.now();
      const dt = Math.min(0.05, (now - this._lastT) / 1000); this._lastT = now;
      if (this._flyStep(dt)) this.draw();
    }, 16);
  }
  /** 拾取：顶点标记先于 gizmo 的轴；都没有就问 host 光标下是不是某块区域的内部 */
  _hit(mx, my) {
    const host = this.host;
    const po = pickObjectAt(host.objects(), (p) => this.project(p), mx, my, host.sel.key);
    if (po) return { kind: 'obj', key: po.key };
    const gz = this._hitGizmo(mx, my); if (gz) return gz;
    const g = this.pickGround(mx, my);
    const rk = g ? host.regionAtWorld(g) : null;
    if (rk) return { kind: 'obj', key: rk, area: true };
    return null;
  }
  _dbl(e) {
    if (!this.ok) return;
    const [mx, my] = this._pos(e);
    const host = this.host;
    if (host.tool !== 'select') { host.toolDouble(this.pickGround(mx, my), e); return; }
    const hit = host.doc ? this._hit(mx, my) : null;
    if (hit && hit.kind === 'obj' && !hit.area) {
      host.select(hit.key);
      const o = host.objects().find((x) => x.key === hit.key);
      if (o) this.focus(o.pos, 150);
      return;
    }
    if (!host.doc || !host.cal) return;
    const edge = host.edgeHit((w) => this.project(w), mx, my, 7);
    if (edge) host.insertVertex(edge.key, edge.after, edge.pt);
  }
  _down(e) {
    if (!this.ok) return;
    const [mx, my] = this._pos(e);
    const host = this.host;
    const sg = e.button === 0 ? this._hitSceneGizmo(mx, my) : null;
    if (sg) {
      if (sg.kind === 'center') { this.setOrtho(!this.cam.ortho); host.status(this.cam.ortho ? '正交视图（再点中心回透视）' : '透视视图'); }
      else { this.snapView(sg.axis, sg.sign); host.status(`从 ${sg.sign > 0 ? '+' : '−'}${sg.axis.toUpperCase()} 看（正交）· 点中心回透视`); }
      return;
    }
    const alt = e.altKey;
    if (e.button === 2) {
      if (alt) { this.drag = { kind: 'dolly', mx: e.clientX, my: e.clientY, cam: Object.assign({}, this.cam) }; this.c.style.cursor = 'ns-resize'; return; }
      // 右键没拖动就松开 + 按在顶点上 = 删这个点（拖了就是环视）；工具武装着时右键点一下 = 工具的"取消 / 反手"（app 决定）
      const rh = host.doc && host.tool === 'select' ? this._hit(mx, my) : null;
      this.drag = { kind: 'look', mx: e.clientX, my: e.clientY, cam: Object.assign({}, this.cam), eye: this._eye(), moved: false,
        rightKey: rh && rh.kind === 'obj' && !rh.area ? rh.key : null, rightTool: host.tool !== 'select', rightAt: this.pickGround(mx, my) };
      this.keys.clear(); this.fly = { t: performance.now() }; this._flyLoop();
      this.c.style.cursor = 'move'; this.draw(); return;
    }
    if (e.button === 1) { e.preventDefault(); this._pan(e); return; }
    if (e.button !== 0) return;
    if (alt) return this._orbit(e);
    if (this.spaceDown || !host.doc) return this._pan(e);
    const tool = host.tool;
    if (tool === 'pan') return this._pan(e);
    if (tool !== 'select') {
      const g = this.pickGround(mx, my);
      if (!g) { host.status('点到地面上（光标下拾取不到地面）', 'warn'); return; }
      if (host.toolDown(g, e)) this.drag = { kind: 'tool', last: g };
      return;
    }
    const hit = this._hit(mx, my);
    if (hit && hit.kind === 'gz') { this._gzDown(hit.part, mx, my); return; }
    if (hit && hit.kind === 'obj') {
      host.select(hit.key);
      const base = host.gizmoBase(hit.key);
      if (base) { this.drag = { kind: 'obj', key: hit.key, base, p0: this.pickGround(mx, my), sx: mx, sy: my, moved: false }; host.dragBegin(host.gizmoLabel()); }
      return;
    }
    host.select('');
    this.draw();
  }
  _move(e) {
    if (!this.ok) return;
    const [mx, my] = this._pos(e);
    const host = this.host;
    if (!this.drag) {
      const inside = mx >= 0 && my >= 0 && mx <= this.c.clientWidth && my <= this.c.clientHeight;
      if (!inside) { this.cursorWorld = null; host.onCursorWorld(null); if (this.hover) { this.hover = null; this.draw(); } return; }
      this.cursorWorld = this.pickGround(mx, my);
      host.onCursorWorld(this.cursorWorld);
      const sg = this._hitSceneGizmo(mx, my);
      const hit = sg || !host.doc || host.tool !== 'select' ? null : this._hit(mx, my);
      const hv = sg ? { kind: 'scene', sg } : hit && hit.kind === 'gz' ? { kind: 'gz', part: hit.part } : hit ? { kind: 'obj', key: hit.key } : null;
      if (JSON.stringify(hv) !== JSON.stringify(this.hover)) this.hover = hv;
      let cur = TOOL_CURSOR[host.tool] || 'default';
      if (sg) cur = 'pointer';
      else if (e.altKey || this.spaceDown) cur = 'grab';
      else if (host.tool === 'select' && hit) cur = hit.kind === 'gz' ? Gizmo.cursor(hit.part) : hit.area ? 'pointer' : 'move';
      this.c.style.cursor = cur;
      this.draw();                                          // 笔刷圈 / 草稿橡皮线要跟着光标
      return;
    }
    const d = this.drag;
    if (d.kind === 'orbit') { const dx = e.clientX - d.mx, dy = e.clientY - d.my; if (Math.hypot(dx, dy) > 2) d.moved = true; this.cam.yaw = d.cam.yaw + dx * 0.006; this.cam.pitch = clamp(d.cam.pitch - dy * 0.006, -PITCH_MAX, PITCH_MAX); this.draw(); return; }
    if (d.kind === 'look') {
      const dx = e.clientX - d.mx, dy = e.clientY - d.my; if (Math.hypot(dx, dy) > 2) d.moved = true;
      const c = this.cam; c.yaw = d.cam.yaw + dx * 0.005; c.pitch = clamp(d.cam.pitch + dy * 0.005, -PITCH_MAX, PITCH_MAX);
      const f = this._forward(c); c.tx = d.eye[0] + f[0] * c.dist; c.ty = d.eye[1] + f[1] * c.dist; c.tz = d.eye[2] + f[2] * c.dist;
      this.draw(); return;
    }
    if (d.kind === 'dolly') {
      const dx = e.clientX - d.mx, dy = e.clientY - d.my; const k = Math.exp(-(dx - dy) * 0.004);
      if (d.cam.ortho) this.cam.orthoH = clamp(d.cam.orthoH * k, 5, 2e5); else this.cam.dist = clamp(d.cam.dist * k, 20, 1e6);
      this.draw(); return;
    }
    if (d.kind === 'pan') {
      const dx = e.clientX - d.mx, dy = e.clientY - d.my;
      const rt = this._right(d.cam), upv = this._camUp(d.cam), k = d.wpp;
      this.cam.tx = d.cam.tx - rt[0] * dx * k + upv[0] * dy * k;
      this.cam.ty = d.cam.ty - rt[1] * dx * k + upv[1] * dy * k;
      this.cam.tz = d.cam.tz - rt[2] * dx * k + upv[2] * dy * k;
      this.draw(); return;
    }
    if (d.kind === 'gz') { this._gzMove(d, mx, my, e); return; }
    if (d.kind === 'tool') { const g = this.pickGround(mx, my); this.cursorWorld = g || this.cursorWorld; if (g) { d.last = g; host.toolMove(g, e); } return; }
    if (d.kind === 'obj') {
      if (!d.moved && Math.hypot(mx - d.sx, my - d.sy) < 3) return;
      d.moved = true;
      const g = this.pickGround(mx, my);
      if (g && d.p0) host.dragTick(() => host.applyGizmo(d.key, d.base, { kind: 'move', v: { x: g[0] - d.p0[0], y: 0, z: g[2] - d.p0[2] } }));
      return;
    }
  }
  _up(e) {
    if (!this.drag) return;
    const d = this.drag; this.drag = null; this.readout = null;
    this.c.style.cursor = TOOL_CURSOR[this.host.tool] || 'default';
    if (d.kind === 'look') {
      this.heldAfterFly = new Set(this.keys);
      this.fly = null; this.keys.clear(); this.draw();
      if (!d.moved) {
        if (d.rightKey) void this.host.deleteVertexKey(d.rightKey);
        else if (d.rightTool) this.host.toolRight(d.rightAt, e);
      }
      return;
    }
    if (d.kind === 'orbit' || d.kind === 'dolly' || d.kind === 'pan') { this.draw(); return; }
    if (d.kind === 'tool') { this.host.toolUp(d.last, e); return; }
    this.host.dragEnd();
  }
}

const MARK_COLOR = { spawn: [0.5, 0.92, 0.55, 1], exit: [0.4, 0.85, 1, 1], align: [1, 0.85, 0.35, 1], landing: [1, 0.55, 0.25, 1], npc: [0.75, 0.75, 0.85, 0.9] };
const MARK_LABEL = { spawn: '出生 ', exit: '出口 ', align: '站位 ', landing: '落点 ', npc: '' };

// ---------------------------------------------------------------- shaders
const MESH_VS3 = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUV; uniform mat4 uMVP; out vec2 vUV;
void main(){ vUV = aUV; gl_Position = uMVP * vec4(aPos, 1.0); }`;
const MESH_FS3 = `#version 300 es
precision mediump float; in vec2 vUV; uniform sampler2D uTex; uniform float uDim; out vec4 o;
void main(){ o = vec4(texture(uTex, vUV).rgb * uDim, 1.0); }`;
const LINE_VS3 = `#version 300 es
layout(location=0) in vec3 aPos; uniform mat4 uMVP; uniform float uPointSize;
void main(){ gl_Position = uMVP * vec4(aPos, 1.0); gl_PointSize = uPointSize; }`;
const LINE_FS3 = `#version 300 es
precision mediump float; uniform vec4 uColor; out vec4 o; void main(){ o = uColor; }`;
const CELL_VS3 = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec4 aCol; uniform mat4 uMVP; out vec4 vCol;
void main(){ vCol = aCol; gl_Position = uMVP * vec4(aPos, 1.0); }`;
const CELL_FS3 = `#version 300 es
precision mediump float; in vec4 vCol; out vec4 o; void main(){ if (vCol.a <= 0.001) discard; o = vCol; }`;

if (typeof module !== 'undefined' && module.exports) module.exports = { View3D, pickObjectAt };
