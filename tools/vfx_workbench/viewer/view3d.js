'use strict';
/* 粒子工作台 · 3D 视图（裸 WebGL2，不引第三方库）。
 *
 * 画什么：深度还原出的场景三角网（贴背景）、2 米地面网格、**本地预览跑出来的粒子**（按发射器给不同颜色的
 * 小方片）、发射器原点、群体的三个线框球（巢 / 活动域 / 惊起）、预览锚点、玩家标记、刺激点与作用半径、
 * 出生点与 NPC 标记。世界坐标 = M-world wu（+Y 上、XZ 地面），与灯位 / 轨迹 / 回音同一坐标系。
 *
 * ⚠ M-world 是**左手系**：x 画面右、Y 上、**Z 进画**。相机的 forward / right / camUp / eye 与
 * `common.js` 的**左手 lookAt** 是同一套（yaw=0 看向 +Z、右 = up × forward、上 = forward × right、
 * 机位 = 目标 − forward·dist）。拿 OpenGL 右手那套画它，整张画面左右镜像、转头 / 平移 / 飞行全反，
 * 而且**一处都不报错**（2026-09-08 声学工作台、2026-09-10 轨迹工作台各中过一次）。判据钉在自检 S2。
 *
 * 交互按 Unity 场景视图搭（与轨迹 / 声学两台同一套手势表，制作人 2026-09-10 定死）：
 *   相机（任何工具下）
 *     右键拖 = 环视（机位不动转头）；按住右键时 W/A/S/D 前左后右、Q/E 下上飞行，Shift ×3，滚轮调速
 *     Alt+左键 = 环绕（绕目标点）· 中键 / 空格+左键 = 平移 · 滚轮 = 朝光标缩放 · Alt+右键 = 推拉
 *     F = 对准选中 · Home = 整场 · 双击物体 = 选中并对准
 *     右上角坐标架：点 X/Y/Z 臂 = 从那一侧正交看；点中心 = 透视 ⇄ 正交
 *   选择（V）：点物体 = 选；左键空白拖 = 框选不做（本台的物体很少，点选足够）；点空白 = 清选择
 *   变换 gizmo = 与轨迹工作台共用的 `/vendor/gizmo.js`（W 移动 / E 旋转 / R 缩放，拖动 Ctrl 吸附）：
 *     **选中任何东西立刻出现在轴心上、旁边写着选中了什么**（制作人打回三轮的那条）
 *   工具：A 放预览锚点（点场景表面）· M 放玩家（点地面）· K 发刺激（点任意处）· H 平移
 *
 * 飞行步进用 setInterval(16ms)：rAF 在隐藏页 / 无头壳里不跑，改回 rAF 自检会"卡住"。
 * ⚠ 相机的上向量叫 `_camUp`，别叫 `_up`——mouseup 处理器已经是 `_up(e)`，后定义的会静默盖掉前者。 */

const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);
// 合成事件可能只带 key 不带 code（自检 / 旧浏览器）：按 key 补一个 code
const KEY2CODE = { w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', q: 'KeyQ', e: 'KeyE', shift: 'ShiftLeft', ' ': 'Space' };
const PITCH_MAX = Math.PI / 2 - 0.02;
function keyCode3(e) { if (e.code) return e.code; const k = (e.key || '').toLowerCase(); return KEY2CODE[k] || ''; }
function isTyping3(e) { const t = e.target; return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || !!t.isContentEditable); }

class View3D {
  constructor(canvas, overlay, host) {
    this.c = canvas; this.overlay = overlay; this.host = host;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    this.gl = gl; this.ok = !!gl;
    if (!gl) return;
    // 目标点 + 距离 + 朝向：机位 = 目标 − forward·dist。画的内容在 +Z（进画）一侧，初始机位落在 −Z（画家站的地方）
    this.cam = { yaw: 0.35, pitch: 0.35, dist: 2500, tx: 0, ty: 0, tz: 0, fov: 55, ortho: false, orthoH: 1000, speed: 1 };
    this.mesh = null; this.tex = null; this.gridLines = null;
    this.drag = null; this.hover = null; this.readout = null;
    this.fly = null; this.keys = new Set(); this.spaceDown = false;
    this._timer = 0; this._lastT = 0;
    this.progMesh = this._prog(MESH_VS3, MESH_FS3);
    this.progLine = this._prog(LINE_VS3, LINE_FS3);
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
    if (!img) { this.tex = null; return; }
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex = t;
  }
  // ------------------------------------------------------------- 相机
  /**
   * 左手系：yaw=0 看向 +Z（进画），yaw 增大 = 向右转（朝 +X）；pitch 增大 = 低头。
   * 相机右 = up × forward，相机上 = forward × right；机位 = 目标点减去 forward·dist。
   * ⚠ 这里的 X 项符号与 common.js 的左手 lookAt 是**一套**，单独改一边就是整张画面镜像（自检 S2 钉住）。
   */
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
    // 正交：near 取负，机位背后的东西也画（平行投影没有"背后"）
    const proj = c.ortho ? ortho(c.orthoH, aspect, -far, far) : perspective(c.fov * Math.PI / 180, aspect, Math.max(1, c.dist * 0.01), far);
    return { mvp: mul4(proj, view), eye };
  }
  /** 世界点 p 所在深度上 1 个 css 像素对应的世界长度（gizmo 常显同一屏幕尺寸、平移按像素走都靠它） */
  _worldPerPx(p) {
    const c = this.cam, H = this.c.clientHeight || 1;
    if (c.ortho) return 2 * c.orthoH / H;
    const eye = this._eye(c), f = this._forward(c);
    const depth = Math.max(1, (p[0] - eye[0]) * f[0] + (p[1] - eye[1]) * f[1] + (p[2] - eye[2]) * f[2]);
    return depth / ((H / 2) / Math.tan(c.fov * Math.PI / 360));
  }
  _viewDir(p) { if (this.cam.ortho) return this._forward(); const eye = this._eye(); return norm3([p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]]); }
  _setDist(d) { const c = this.cam; c.dist = clamp(d, 20, 1e6); c.orthoH = c.dist * Math.tan(c.fov * Math.PI / 360); }
  /** 拾取射线要走多远：正交时射线起点在机位背后 far 处，得够得着目标那一侧的地面 */
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
  worldBounds() {
    const m = this.mesh;
    const mn = m ? m.mn.slice() : [-1000, -100, -1000], mx = m ? m.mx.slice() : [1000, 300, 1000];
    for (const o of this.host.objects()) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], o.pos[k]); mx[k] = Math.max(mx[k], o.pos[k]); }
    return { mn, mx };
  }
  /** 看全景：**按游戏相机的朝向**站到能看见整个场景的机位（略抬高、稍偏一点），目标放锚点 / 出生点 */
  fit(onlyScene) {
    const b = onlyScene && this.mesh ? { mn: this.mesh.mn, mx: this.mesh.mx } : this.worldBounds();
    const cx = (b.mn[0] + b.mx[0]) / 2, cz = (b.mn[2] + b.mx[2]) / 2, cy = (b.mn[1] + b.mx[1]) / 2;
    const ext = Math.max(b.mx[0] - b.mn[0], b.mx[2] - b.mn[2], b.mx[1] - b.mn[1], 200);
    const c = this.cam, cal = this.host.cal;
    const anchor = this.host.anchorWorld();
    const focus = anchor || [cx, cy, cz];
    c.tx = focus[0] * 0.6 + cx * 0.4; c.ty = focus[1] * 0.6 + cy * 0.4; c.tz = focus[2] * 0.6 + cz * 0.4;
    if (cal) {
      const v = cal.viewDirWorld ? cal.viewDirWorld() : [0, 0, 1];
      c.yaw = Math.atan2(v[0], v[2]) + 0.25;
    } else c.yaw = 0.35;
    c.pitch = 0.38; c.ortho = false;
    this._setDist(ext * 0.95);
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
  /** 场景表面：深度壳优先（画里的崖壁 / 桌面本身），打不到退地面 */
  pickSurface(mx, my) {
    const cal = this.host.cal, r = this.ray(mx, my); if (!r) return null;
    const g = cal && cal.hf ? rayGround(r, cal, this._reach()) : null;
    const s = cal && cal.shell ? rayShell(r, cal, this._reach()) : null;
    if (s && g) {
      const ds = Math.hypot(s[0] - r.o[0], s[1] - r.o[1], s[2] - r.o[2]);
      const dg = Math.hypot(g[0] - r.o[0], g[1] - r.o[1], g[2] - r.o[2]);
      return ds <= dg + 1 ? { p: s, onShell: true } : { p: g, onShell: false };
    }
    if (s) return { p: s, onShell: true };
    if (g) return { p: g, onShell: false };
    const p = rayPlane(r, [0, this._floorY(), 0], [0, 1, 0]);
    return p ? { p, onShell: false } : null;
  }
  pickPlane(mx, my, py) { const r = this.ray(mx, my); return r ? rayPlane(r, [0, py, 0], [0, 1, 0]) : null; }
  groundY(x, z) { const cal = this.host.cal; return cal && cal.hf ? cal.groundHeight(x, z) : this._floorY(); }
  // ------------------------------------------------------------- gizmo
  _proj() {
    return {
      dim: 3, project: (p) => this.project(p), worldPerPx: (p) => this._worldPerPx(p),
      axisParam: (mx, my, p0, a) => { const r = this.ray(mx, my); return r ? rayLineParam(r, p0, a) : null; },
      planePoint: (mx, my, p0, a, b) => { const r = this.ray(mx, my); return r ? rayPlane(r, p0, cross3(a, b)) : null; },
      groundPoint: (mx, my, p0) => this.pickPlane(mx, my, p0[1]),
      viewPlanePoint: (mx, my, p0) => { const r = this.ray(mx, my); return r ? rayPlane(r, p0, this._viewDir(p0)) : null; },
      eyeAbove: (p0) => this._eye()[1] >= p0[1],
    };
  }
  /** gizmo 几何；null = 没选中 / 不在选择工具 */
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
    return part ? { kind: 'gz', part, center: Gizmo.isCenter(part) } : null;
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
    if (host.layers.grid && cal && cal.hf) this._groundGrid(mvp);
    // 粒子（本地预览 = 运行时那份模拟）
    if (host.layers.particles) {
      const per = host.particlePoints();
      for (const grp of per) if (grp.pts.length) this._lines(mvp, grp.pts, grp.color, gl.POINTS, grp.size);
    }
    // 线框球：巢 / 活动域 / 惊起
    if (host.layers.rings) for (const s of host.spheres()) this._circle(mvp, s.center, s.radius, s.color, s.hot);
    // 刺激场作用半径
    for (const f of host.fieldMarks()) this._circle(mvp, f.at, f.radius, f.color, false);
    // 物体标记
    for (const o of host.objects()) this._marker(mvp, o.pos, o.color, o.size);
    if (host.layers.marks) for (const m of (host.marks || [])) this._marker(mvp, m.world, m.kind === 'spawn' ? [0.5, 0.9, 0.55, 1] : [0.7, 0.7, 0.8, 0.9], 7);
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
  /** 线框球：三个正交大圆（够看清半径，不铺满线） */
  _circle(mvp, c, r, color, hot) {
    if (!(r > 0)) return;
    const arr = [];
    const ring = (ax, az) => {
      for (let i = 0; i < 48; i++) {
        const t0 = i / 48 * Math.PI * 2, t1 = (i + 1) / 48 * Math.PI * 2;
        arr.push(c[0] + ax[0] * Math.cos(t0) * r + az[0] * Math.sin(t0) * r,
                 c[1] + ax[1] * Math.cos(t0) * r + az[1] * Math.sin(t0) * r,
                 c[2] + ax[2] * Math.cos(t0) * r + az[2] * Math.sin(t0) * r,
                 c[0] + ax[0] * Math.cos(t1) * r + az[0] * Math.sin(t1) * r,
                 c[1] + ax[1] * Math.cos(t1) * r + az[1] * Math.sin(t1) * r,
                 c[2] + ax[2] * Math.cos(t1) * r + az[2] * Math.sin(t1) * r);
      }
    };
    ring([1, 0, 0], [0, 0, 1]); ring([1, 0, 0], [0, 1, 0]); ring([0, 0, 1], [0, 1, 0]);
    const col = hot ? [1, 0.9, 0.3, 0.9] : color;
    this._lines(mvp, new Float32Array(arr), col, this.gl.LINES, 1);
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
  _marker(mvp, p, color, size) {
    this.gl.disable(this.gl.DEPTH_TEST);
    this._lines(mvp, [p[0], p[1], p[2]], color, this.gl.POINTS, size);
    this.gl.enable(this.gl.DEPTH_TEST);
  }
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
  /** 2D 叠加：物体名字、变换 gizmo、读数、坐标架 */
  _overlay() {
    const ov = this.overlay; if (!ov) return;
    const g = ov.getContext('2d'); const dpr = window.devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, ov.clientWidth, ov.clientHeight);
    g.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif'; g.textBaseline = 'alphabetic';
    for (const o of this.host.objects()) {
      if (!o.label) continue;
      const c = this.project(o.pos); if (!c) continue;
      g.fillStyle = o.selected ? GZ.col.hot : 'rgba(230,232,236,.8)';
      g.fillText(o.label, c[0] + 9, c[1] - 7);
    }
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
      if (this.fly) { this.cam.speed = clamp(this.cam.speed * Math.exp(-e.deltaY * 0.0015), 0.05, 20); this.host.status(`飞行速度 ×${fmt(this.cam.speed, 2)}`); this.draw(); return; }
      const [mx, my] = this._pos(e); this._zoomAt(mx, my, Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
    c.addEventListener('mousedown', (e) => { c.focus(); this._down(e); });
    c.addEventListener('dblclick', (e) => this._dbl(e));
    window.addEventListener('mousemove', (e) => this._move(e));
    window.addEventListener('mouseup', (e) => this._up(e));
    // 捕获阶段：飞行键在到达 app 的快捷键表之前就被吃掉（按住右键时 W 是"前进"，不是"移动工具"）
    window.addEventListener('keydown', (e) => this._keyDown(e), true);
    window.addEventListener('keyup', (e) => this._keyUp(e), true);
    window.addEventListener('blur', () => { this.keys.clear(); this.spaceDown = false; });
  }
  _pos(e) { const r = this.c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  /** 按住右键期间：键盘归相机（app 的 onKey 也会据此让路） */
  capturesKeys() { return !!this.fly; }
  flying() { return !!this.fly; }
  _keyDown(e) {
    const code = keyCode3(e);
    if (code === 'Space' && !isTyping3(e)) this.spaceDown = true;
    if (!this.fly) return;
    if (FLY_KEYS.has(code)) { this.keys.add(code); e.preventDefault(); e.stopImmediatePropagation(); }
  }
  _keyUp(e) {
    const code = keyCode3(e);
    if (code === 'Space') this.spaceDown = false;
    this.keys.delete(code);
    if (code === 'ShiftLeft' || code === 'ShiftRight') { this.keys.delete('ShiftLeft'); this.keys.delete('ShiftRight'); }
  }
  _orbit(e) { this.drag = { kind: 'orbit', mx: e.clientX, my: e.clientY, cam: Object.assign({}, this.cam), moved: false }; this.c.style.cursor = 'grabbing'; }
  _pan(e) { this.drag = { kind: 'pan', mx: e.clientX, my: e.clientY, cam: Object.assign({}, this.cam), wpp: this._worldPerPx([this.cam.tx, this.cam.ty, this.cam.tz]) }; this.c.style.cursor = 'grabbing'; }
  /** 朝光标处缩放：光标下那个点（地面 / 壳 / 目标深度）在屏幕上不动 */
  _zoomAt(mx, my, factor) {
    const c = this.cam, cal = this.host.cal, r = this.ray(mx, my), f = this._forward();
    let P = null;
    if (r && cal && cal.hf) { P = rayGround(r, cal, this._reach()); if (!P && cal.shell) P = rayShell(r, cal, this._reach()); }
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
    if (this.drag && this.drag.kind === 'look') this.drag.eye = this._eye(c);   // 飞行中转头：圆心跟着机位走
    return true;
  }
  /** 按住右键期间以 16ms 定时步进（不用 rAF：页面不可见 / 无头时 rAF 不跑，飞行就"卡住"）；松开即停 */
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
  /** 拾取：小目标（物体标记 / 线框球）**先于** gizmo 的轴 / 面（别的东西正好躺在轴线上时点它得选它） */
  _hit(mx, my) {
    const host = this.host;
    const near = (p, r) => { const c = this.project(p); return c && Math.hypot(c[0] - mx, c[1] - my) <= (r || 9); };
    // 叠在一起的物体（偏移 0 时锚点与发射器同点）：当前选中的那个优先，否则按 objects() 的序
    const cand = host.objects().filter((o) => near(o.pos, (o.size || 8) + 3));
    if (cand.length) {
      const keep = cand.find((o) => o.key === host.sel.key);
      return { kind: 'obj', key: (keep || cand[0]).key };
    }
    const gz = this._hitGizmo(mx, my); if (gz) return gz;
    // 线框球：点它的三个大圆
    for (const s of host.spheres()) {
      for (const [ax, az] of [[[1, 0, 0], [0, 0, 1]], [[1, 0, 0], [0, 1, 0]], [[0, 0, 1], [0, 1, 0]]]) {
        for (let i = 0; i < 48; i++) {
          const t0 = i / 48 * Math.PI * 2, t1 = (i + 1) / 48 * Math.PI * 2;
          const P = (t) => this.project([s.center[0] + ax[0] * Math.cos(t) * s.radius + az[0] * Math.sin(t) * s.radius,
                                         s.center[1] + ax[1] * Math.cos(t) * s.radius + az[1] * Math.sin(t) * s.radius,
                                         s.center[2] + ax[2] * Math.cos(t) * s.radius + az[2] * Math.sin(t) * s.radius]);
          const a = P(t0), b = P(t1);
          if (a && b && distToSeg(mx, my, a, b) <= 5) return { kind: 'obj', key: s.key };
        }
      }
    }
    return null;
  }
  _dbl(e) {
    if (!this.ok) return;
    const [mx, my] = this._pos(e);
    const hit = this._hit(mx, my); if (!hit || hit.kind !== 'obj') return;
    this.host.select(hit.key);
    const o = this.host.objects().find((x) => x.key === hit.key) || this.host.spheres().find((x) => x.key === hit.key);
    if (o) this.focus(o.pos || o.center, o.radius || 150);
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
      this.drag = { kind: 'look', mx: e.clientX, my: e.clientY, cam: Object.assign({}, this.cam), eye: this._eye(), moved: false };
      this.keys.clear(); this.fly = { t: performance.now() }; this._flyLoop();
      this.c.style.cursor = 'move'; this.draw(); return;
    }
    if (e.button === 1) { e.preventDefault(); this._pan(e); return; }
    if (e.button !== 0) return;
    if (alt) return this._orbit(e);
    if (this.spaceDown || !host.doc) return this._pan(e);
    const tool = host.tool;
    if (tool === 'pan') return this._pan(e);
    if (tool === 'anchor') { const s = this.pickSurface(mx, my); if (s) host.setAnchorAt(s); return; }
    if (tool === 'player') { const g = this.pickGround(mx, my); if (g) host.setPlayerAt(g); return; }
    if (tool === 'field') { const s = this.pickSurface(mx, my); if (s) host.addFieldAt(s.p); return; }
    const hit = this._hit(mx, my);
    if (hit && hit.kind === 'gz') { this._gzDown(hit.part, mx, my); return; }
    if (hit && hit.kind === 'obj') {
      host.select(hit.key);
      // 直接拖物体本身（不经 gizmo）：与 gizmo 中心同语义（贴地 / 沿表面）
      const base = host.gizmoBase(hit.key);
      if (base) { this.drag = { kind: 'obj', key: hit.key, base, p0: this.pickPlane(mx, my, base.pos ? base.pos[1] : 0), sx: mx, sy: my, moved: false }; host.dragBegin(host.gizmoLabel()); }
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
      if (!inside) { host.onCursorWorld(null); if (this.hover) { this.hover = null; this.draw(); } return; }
      host.onCursorWorld(this.pickGround(mx, my));
      const sg = this._hitSceneGizmo(mx, my);
      const hit = sg || !host.doc ? null : this._hit(mx, my);
      const hv = sg ? { kind: 'scene', sg } : hit && hit.kind === 'gz' ? { kind: 'gz', part: hit.part } : hit ? { kind: 'obj', key: hit.key } : null;
      if (JSON.stringify(hv) !== JSON.stringify(this.hover)) { this.hover = hv; this.draw(); }
      let cur = 'default';
      if (sg) cur = 'pointer';
      else if (e.altKey || this.spaceDown || host.tool === 'pan') cur = 'grab';
      else if (host.tool === 'anchor' || host.tool === 'player' || host.tool === 'field') cur = 'crosshair';
      else if (hit) cur = hit.kind === 'gz' ? Gizmo.cursor(hit.part) : 'move';
      this.c.style.cursor = cur;
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
    if (d.kind === 'obj') {
      if (!d.moved && Math.hypot(mx - d.sx, my - d.sy) < 3) return;
      d.moved = true;
      const base = d.base;
      const surf = this.pickSurface(mx, my);
      host.dragTick(() => host.dragObjectTo(d.key, base, surf, e.altKey));
      return;
    }
  }
  _up(e) {
    if (!this.drag) return;
    const d = this.drag; this.drag = null; this.readout = null;
    this.c.style.cursor = 'default';
    if (d.kind === 'look') { this.fly = null; this.keys.clear(); this.draw(); return; }
    if (d.kind === 'orbit' || d.kind === 'dolly' || d.kind === 'pan') { this.draw(); return; }
    this.host.dragEnd();
  }
  /** 键盘微移（世界 x / z，wu） */
  nudge(dx, dz) { this.host.nudgeSelected(dx, 0, dz); }
}

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

if (typeof module !== 'undefined' && module.exports) module.exports = { View3D };
