'use strict';
/* 3D 世界视图（裸 WebGL2，不引第三方库）：深度还原出的场景三角网（贴背景）、地面网格、曲线、控制点、
 * 把手、幽灵卡片。世界坐标 = M-world wu（+Y 上、XZ 地面、**左手系**，见 common.js lookAt 注释）。
 *
 * 交互按 Unity 场景视图的习惯搭（2026-09-10 制作人打回"怎么移动相机 / 怎么自由挪点"后重做）：
 *   相机（任何工具下）
 *     右键拖 = 环视（相机原地转头）；按住右键时 W/A/S/D 前左后右、Q/E 下上飞行，Shift ×3，滚轮调飞行速度
 *     Alt+左键拖 = 环绕（绕目标点转）· 中键 / 空格+左键 / Alt+中键 = 平移 · 滚轮 = 朝光标处缩放 · Alt+右键拖 = 推拉
 *     F = 对准选中（选中点 / 整段 / 整条）· Home = 整个场景 · 双击点 = 对准它
 *     右上角坐标架：点 X/Y/Z 臂 = 从那一侧正交看（顶视 / 侧视摆点）；点中心 = 透视 ⇄ 正交
 *   选择（V）
 *     点点 = 选；Shift / Ctrl+点 = 加减选；左键空白拖 = 框选（Shift 追加）；点空白 = 清选择；点曲线 = 选整段；
 *     点幽灵（预览实体）= 选整条（幽灵就是"那个物体"）
 *   变换 gizmo（gizmo.js，与 2D 视图共用；选中 ≥1 点、或范围是整段 / 整条时立刻出现在轴心，加点模式下也在）
 *     W 移动：红 X / 蓝 Z 箭头 = 沿轴；绿 Y 箭头 = 离地高度；三个小方块 = 在该平面里挪（XZ = 贴地走）；中心 = 贴地走
 *     E 旋转：绿色圆环 = 绕竖直轴转（≥2 点 / 整段 / 整条）
 *     R 缩放：轴末端方块 = 单轴；中心方块 = 等比
 *     拖动时按住 Ctrl = 吸附（10 wu / 15° / ×0.1）；读数跟在光标旁；松手即入历史（没拖动不算编辑）
 *   直接操纵（不经 gizmo）：拖点 = 贴地走（h 不变）；点上方 ▲（多选时）/ Alt+拖 = 改离地高度；
 *     抛体的箭尖 / 落点 / 最高点 / 自定起点、插槽都可直接拖；右键点点 = 删点（没拖动才算）
 *   pen     点击 = 射线打到深度壳（桌面/台阶）或地面，加一个点（gizmo 把手优先）
 *   physics 按下拖动 = 拖落点
 *   slot    点击地面 = 放一个命名插槽（曲线暴露给场景的位置）
 * 画面空间资产：只看（曲线按落点反投影贴到地面），左键拖 = 环绕。 */

const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);
const PITCH_MAX = Math.PI / 2 - 0.02;

class View3D {
  constructor(canvas, host) {
    this.c = canvas; this.host = host;
    const gl = canvas.getContext('webgl2', { antialias: true });
    this.gl = gl; this.ok = !!gl;
    if (!gl) return;
    this.cam = { yaw: 0.35, pitch: 0.45, dist: 3000, tx: 0, ty: 0, tz: 0, fov: 45, ortho: false, orthoH: 1000, speed: 1 };
    this.mesh = null; this.tex = null; this.ghostTex = null; this.gridLines = null;
    this.drag = null; this.box = null; this.hover = null; this.readout = null;
    this.fly = null; this.keys = new Set(); this.spaceDown = false;
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
  // ------------------------------------------------------------- 相机
  /**
   * 左手系：yaw=0 看向 +Z（进画），yaw 增大 = 向右转（朝 +X）；相机右 = up × forward，相机上 = forward × right。
   * 机位 = 目标点减去 forward·dist。⚠ 这里的 X 项符号与 common.js 的左手 lookAt 是**一套**，
   * 单独改一边就是整张画面镜像（见 lookAt 的注释；自检 S11 钉住）。
   */
  _forward(c = this.cam) { return [Math.cos(c.pitch) * Math.sin(c.yaw), -Math.sin(c.pitch), Math.cos(c.pitch) * Math.cos(c.yaw)]; }
  /** 相机右（世界）= up × forward；yaw=0 时是 +X = 画面右。 */
  _right(c = this.cam) { const f = this._forward(c); return norm3([f[2], 0, -f[0]]); }
  /** 相机上 = forward × right（⚠ 别叫 `_up`：那是 mouseup 处理器，后定义的会静默盖掉前者）。 */
  _camUp(c = this.cam) { return norm3(cross3(this._forward(c), this._right(c))); }
  _eye(c = this.cam) { const f = this._forward(c); return [c.tx - f[0] * c.dist, c.ty - f[1] * c.dist, c.tz - f[2] * c.dist]; }
  _mvp() {
    const c = this.cam, W = this.c.width, H = this.c.height, aspect = W / Math.max(H, 1);
    const eye = this._eye(c);
    const view = lookAt(eye, [c.tx, c.ty, c.tz], [0, 1, 0]);
    const far = c.dist * 20 + 1e4;
    // 正交：near 取负，机位背后的东西也画（平行投影没有"背后"；侧视时场景比 dist 宽是常态）
    const proj = c.ortho ? ortho(c.orthoH, aspect, -far, far) : perspective(c.fov * Math.PI / 180, aspect, Math.max(1, c.dist * 0.01), far);
    return { mvp: mul4(proj, view), eye };
  }
  /** 世界点 p 所在深度上，1 个 css 像素对应的世界长度（gizmo 常显同一屏幕尺寸、平移按像素走都靠它） */
  _worldPerPx(p) {
    const c = this.cam, H = this.c.clientHeight || 1;
    if (c.ortho) return 2 * c.orthoH / H;
    const eye = this._eye(c), f = this._forward(c);
    const depth = Math.max(1, (p[0] - eye[0]) * f[0] + (p[1] - eye[1]) * f[1] + (p[2] - eye[2]) * f[2]);
    return depth / ((H / 2) / Math.tan(c.fov * Math.PI / 360));
  }
  /** 从相机看向 p 的方向（正交 = forward） */
  _viewDir(p) { if (this.cam.ortho) return this._forward(); const eye = this._eye(); return norm3([p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]]); }
  _setDist(d) { const c = this.cam; c.dist = clamp(d, 20, 1e6); c.orthoH = c.dist * Math.tan(c.fov * Math.PI / 360); }
  /** 透视 ⇄ 正交：切换时目标点深度上的画面尺寸不变 */
  setOrtho(on) {
    const c = this.cam, t = Math.tan(c.fov * Math.PI / 360);
    if (on && !c.ortho) c.orthoH = c.dist * t;
    else if (!on && c.ortho) c.dist = clamp(c.orthoH / t, 20, 1e6);
    c.ortho = !!on; this.draw();
  }
  /** 坐标架一键视角：从 ±axis 那一侧看向目标（Unity：点 X 臂 = 从 +X 看），并切成正交 */
  snapView(axis, sign) {
    const c = this.cam; sign = sign || 1;
    if (axis === 'x') { c.yaw = -sign * Math.PI / 2; c.pitch = 0; }
    else if (axis === 'z') { c.yaw = sign > 0 ? Math.PI : 0; c.pitch = 0; }
    else c.pitch = sign * PITCH_MAX;
    this.setOrtho(true);
  }
  fit() {
    const m = this.mesh; if (!m) return;
    const cx = (m.mn[0] + m.mx[0]) / 2, cz = (m.mn[2] + m.mx[2]) / 2, cy = (m.mn[1] + m.mx[1]) / 2;
    const ext = Math.max(m.mx[0] - m.mn[0], m.mx[2] - m.mn[2], m.mx[1] - m.mn[1]);
    Object.assign(this.cam, { tx: cx, ty: cy, tz: cz, yaw: 0.35, pitch: 0.45, ortho: false });
    this._setDist(ext * 1.1);
    this.draw();
  }
  /** 把镜头对准锚点 / 整条轨迹 */
  fitCurve() {
    const host = this.host, cal = host.cal;
    if (!cal || !host.doc) return this.fit();
    const aw = Edit.originWorld(host);   // 曲线原点（播放位置对齐的那个点）也要进取景框
    const prev = host.bake && host.bake.preview && host.bake.preview.world;
    const pts = aw ? [aw.slice()] : [[0, 0, 0]];
    for (const sl of Edit.slots(host.doc)) { const w = Edit.slotWorld(host, sl); if (w) pts.push(w); }
    if (prev && prev.length) for (const w of prev) pts.push([w[1], w[2], w[3]]);
    this._frame(pts, 2.2, 200);
  }
  /** F：对准选中——选中点 → 那几个点；整段 → 该段曲线；整条 / 没选 → 整条轨迹 */
  frameSelection() {
    const host = this.host, cal = host.cal, seg = host.activeSeg();
    if (!cal || !host.doc || host.doc.space !== 'world') return this.fitCurve();
    const scope = host.sel.scope, pts = [];
    if (scope === 'points' && seg && seg.kind === 'manual' && host.sel.points.size) {
      const eff = host.effPoints(seg); for (const i of host.sel.points) if (eff[i]) pts.push(eff[i].pos);
    } else if (scope === 'segment' && seg) {
      const sl = host.previewSlicesWorld().find((s) => s.i === host.segIndex);
      if (sl && sl.pos.length >= 6) for (let k = 0; k < sl.pos.length; k += 3) pts.push([sl.pos[k], sl.pos[k + 1], sl.pos[k + 2]]);
      else if (seg.kind === 'manual') for (const p of host.effPoints(seg)) pts.push(p.pos);
      else { const pi = host.physicsInfo(seg); if (pi) { pts.push(pi.startW, pi.tipW); if (pi.arcW) for (const p of pi.arcW) pts.push(p); } }
    }
    if (!pts.length) return this.fitCurve();
    this._frame(pts, 2.6, 120);
  }
  _frame(pts, k, minExt) {
    const mn = pts[0].slice(), mx = pts[0].slice();
    for (const p of pts) for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i]); mx[i] = Math.max(mx[i], p[i]); }
    const ext = Math.max(minExt, mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
    Object.assign(this.cam, { tx: (mn[0] + mx[0]) / 2, ty: (mn[1] + mx[1]) / 2, tz: (mn[2] + mx[2]) / 2 });
    this._setDist(ext * k); this.draw();
  }
  resize() {
    const r = this.c.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    this.c.width = Math.max(1, Math.round(r.width * dpr)); this.c.height = Math.max(1, Math.round(r.height * dpr));
    if (this.overlay) { this.overlay.width = this.c.width; this.overlay.height = this.c.height; }
    this.draw();
  }
  // ------------------------------------------------------------- 拾取
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
  /** 鼠标 → 过 p 的竖直平面（面朝相机）上的点，返回 y；顶视（面退化）返回 null */
  pickVertical(mx, my, p) {
    const r = this.ray(mx, my); if (!r) return null;
    const v = this._viewDir(p); const l = Math.hypot(v[0], v[2]); if (l < 1e-6) return null;
    const q = rayPlane(r, p, [v[0] / l, 0, v[2] / l]); return q ? q[1] : null;
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
    if (host.doc && world && cal) {
      // 手绘段画几何路径（不吃烘焙、不随时间曲线切角）；抛体段画烘焙采样（位置本来就是时间积分出来的）；落点线仍按采样
      const slices = host.previewSlicesWorld(); const segsAll = Edit.segs(host.doc);
      for (let i = 0; i < segsAll.length; i++) {
        const on = i === host.segIndex;
        if (!on && !host.layers.allCurves) continue;
        const segI = segsAll[i], sl = slices.find((s) => s.i === i);
        if (segI.kind === 'manual') { const geo = host.localCurveWorld(segI); if (geo.length > 1) { const arr = []; for (const p of geo) arr.push(p[0], p[1], p[2]); this._lines(mvp, arr, on ? [0.42, 0.7, 1, 1] : [0.42, 0.7, 1, 0.45], gl.LINE_STRIP, on ? 2 : 1); } }
        else if (sl && sl.pos.length > 3) this._lines(mvp, sl.pos, on ? [0.42, 0.7, 1, 1] : [0.42, 0.7, 1, 0.45], gl.LINE_STRIP, on ? 2 : 1);
        if (sl && sl.foot.length > 3) this._lines(mvp, sl.foot, on ? [1, 0.7, 0.33, 0.9] : [1, 0.7, 0.33, 0.35], gl.LINE_STRIP, 1);
      }
    } else if (host.doc && prev && prev.screen && prev.screen.length > 1 && cal && !world) {
      const pos = [];
      for (const s of prev.screen) { const g = cal.sceneToWorldGround(s[1], s[3]); pos.push(g[0], g[1] + (s[3] - s[2]) / cal.cosTheta, g[2]); }
      this._lines(mvp, pos, [0.42, 0.7, 1, 0.8], gl.LINE_STRIP, 2);
    }
    if (cal && host.doc) {
      // 曲线原点：橙色标记 + 落地竖线（可以离地，所以竖线从脚下地面拉上来）
      const ow = Edit.originWorld(host);
      if (ow) {
        const onO = host.sel.handle === 'origin';
        const col = onO ? [1, 0.9, 0.3, 1] : [1, 0.71, 0.33, 1];
        this._marker(mvp, ow, col, onO ? 15 : 12);
        this._lines(mvp, [ow[0], cal.groundHeight(ow[0], ow[2]), ow[2], ow[0], ow[1], ow[2]], [col[0], col[1], col[2], 0.6], gl.LINES, 1);
      }
      // 命名插槽：地面上的站位（青绿菱形 + 竖线）；曲线没有锚点了
      for (const sl of Edit.slots(host.doc)) {
        const g = Edit.slotWorld(host, sl); if (!g) continue;
        const on = host.sel.handle === 'slot:' + sl.id;
        this._marker(mvp, [g[0], g[1] + 2, g[2]], on ? [1, 0.9, 0.3, 1] : [0.35, 0.85, 0.8, 1], on ? 14 : 11);
        this._lines(mvp, [g[0], g[1], g[2], g[0], g[1] + 40, g[2]], on ? [1, 0.9, 0.3, 0.8] : [0.35, 0.85, 0.8, 0.6], gl.LINES, 1);
      }
    }
    const seg = host.activeSeg();
    if (seg && cal && world) {
      if (seg.kind === 'manual') {
        const pts = host.effPoints(seg);
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
  /** 2D 叠加：编号 / h 标签 / 把手符号、变换 gizmo、框选、坐标架、提示、读数（在 canvas 2D 上画，与 3D 同尺寸） */
  _overlay() {
    const ov = this.overlay; if (!ov) return;
    const g = ov.getContext('2d'); const dpr = window.devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, ov.clientWidth, ov.clientHeight);
    const host = this.host, cal = host.cal, W = ov.clientWidth, H = ov.clientHeight;
    if (!host.doc) return;
    g.font = '11px sans-serif';
    const world = host.doc.space === 'world';
    // 两行提示都摞在左下坐标读数（#coords，占 H-28..H-8）之上：相机一行在 H-44，工具一行在 H-30
    const hintR = (t, y) => { g.fillStyle = 'rgba(255,255,255,.5)'; g.fillText(t, 12, y); };
    const camHint = this.fly ? `飞行中：W/A/S/D 前左后右 · Q/E 下上 · Shift ×3 · 滚轮调速（×${fmt(this.cam.speed, 2)}）` : '相机：右键拖 环视 · 右键+WASD/QE 飞行 · Alt+左键 环绕 · 中键/空格+左键 平移 · 滚轮 缩放到光标 · Alt+右键 推拉 · F 对准选中 · Home 整场';
    if (cal) this._drawSceneGizmo(g);
    if (!world) { g.fillStyle = 'rgba(255,255,255,.6)'; g.fillText('画面空间资产：3D 视图只看不改（曲线按落点贴地估算）· 左键拖 = 环绕 · 要在 3D 里编辑把顶栏「空间」切到世界空间', 12, H - 30); hintR(camHint, H - 44); return; }
    if (!cal) return;
    const gz = this._gizmo();
    const seg = host.activeSeg();
    if (seg && seg.kind === 'manual') {
      host.effPoints(seg).forEach((p, i) => {
        const c = this.project(p.pos); if (!c) return;
        g.fillStyle = host.sel.points.has(i) ? '#fff' : '#bbb'; g.fillText(`${i}  h ${fmt(p.h)}`, c[0] + 8, c[1] - 6);
        // 高度把手 ▲：单选时 gizmo 的 Y 箭头就在同一位置，不重复画
        if (host.sel.points.has(i) && !(gz && gz.n === 1)) { const hy = c[1] - 18; g.fillStyle = '#ffb454'; g.beginPath(); g.moveTo(c[0], hy - 6); g.lineTo(c[0] - 5, hy + 3); g.lineTo(c[0] + 5, hy + 3); g.closePath(); g.fill(); }
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
    for (const sl of Edit.slots(host.doc)) { const w = Edit.slotWorld(host, sl); const c = w ? this.project([w[0], w[1] + 40, w[2]]) : null; if (c) { g.fillStyle = host.sel.handle === 'slot:' + sl.id ? '#ffe44d' : '#5ad9cc'; g.fillText('插槽 ' + (sl.label || sl.id), c[0] + 6, c[1] - 4); } }
    { const ow = Edit.originWorld(host); const c = ow ? this.project(ow) : null; if (c) { g.fillStyle = host.sel.handle === 'origin' ? '#ffe44d' : '#ffb454'; g.fillText(Edit.hasOrigin(host) ? '原点' : '原点（跟着起点）', c[0] + 8, c[1] + 14); } }
    if (gz) Gizmo.draw(g, gz, this._hotPart());
    if (this.box) { const b = this.box; g.strokeStyle = 'rgba(108,180,255,.9)'; g.fillStyle = 'rgba(108,180,255,.12)'; g.setLineDash([4, 3]); g.lineWidth = 1; g.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.setLineDash([]); }
    Gizmo.drawReadout(g, this.readout); g.font = '11px sans-serif';
    if (host.tool === 'pen') { g.fillStyle = '#6cb4ff'; g.fillText('点击场景表面加点（桌面/台阶会落在其上）· 刚加的点带着 gizmo，可直接拖轴 · Enter/Esc 结束', 12, H - 30); }
    else if (host.tool === 'physics') { g.fillStyle = '#ffb454'; g.fillText('按住拖动：把落点拖到目标地面处', 12, H - 30); }
    else if (host.tool === 'slot') { g.fillStyle = '#5ad9cc'; g.fillText('点击地面放置一个命名插槽（曲线暴露给场景的位置）· Enter/Esc 结束', 12, H - 30); }
    else if (host.tool === 'pan') { g.fillStyle = 'rgba(255,255,255,.6)'; g.fillText('手形工具：左键拖 = 平移', 12, H - 30); }
    else if (gz) { g.fillStyle = 'rgba(255,255,255,.6)'; g.fillText({ move: '移动（W）：箭头 = 沿轴 · 小方块 = 沿面 · 中心 = 贴地走 · 拖点 = 贴地走 · Alt+拖点 = 离地高度', rotate: '旋转（E）：拖圆环 = 绕竖直轴', scale: '缩放（R）：轴末端 = 单轴 · 中心 = 等比' }[gz.mode] + ' · 按住 Ctrl 吸附 · E/R/W 切模式', 12, H - 30); }
    else if (host.tool === 'select') { g.fillStyle = 'rgba(255,255,255,.45)'; g.fillText('点点 / 框选 = 选点 · 点曲线 = 选整段 · 点幽灵 = 选整条 · 点插槽 = 选它 · 选中即出现 gizmo（W/E/R 移动/旋转/缩放）', 12, H - 30); }
    hintR(camHint, H - 44);
  }
  // ------------------------------------------------------------- 变换 gizmo（gizmo.js 共用；这里只提供 projector）
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
  /** gizmo 几何；null = 不显示（画面空间资产 / 没选中 / 不在选择、加点工具） */
  _gizmo() {
    const host = this.host;
    if (!host.cal || !host.doc || host.doc.space !== 'world' || (host.tool !== 'select' && host.tool !== 'pen')) return null;
    const pv = host.gizmoPivot(); if (!pv) return null;
    return Gizmo.geom(this._proj(), GZ_CFG.build(GZ_CFG.world3, pv.kind), pv.pivot, host.gizmoMode, pv.n, pv.label);
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
    const T = Gizmo.toTransform(res, true, host._pivotNative()); if (!T) return;
    host.applyTransform(T);
  }
  // ------------------------------------------------------------- 场景坐标架（右上角）
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
    arms.sort((a, b) => b.depth - a.depth);   // 指向远处的先画（被近的盖住）
    return { ox, oy, R, arms };
  }
  _hitSceneGizmo(mx, my) {
    if (!this.host.cal) return null;
    const lay = this._sceneGizmoLayout();
    if (Math.hypot(mx - lay.ox, my - lay.oy) > lay.R + 14) return null;
    // 中心方块优先（Unity 同）：正对视线的那根臂会缩到中心，不然顶视时点中心永远回不到透视
    if (Math.hypot(mx - lay.ox, my - lay.oy) <= 7) return { kind: 'center' };
    let best = null, bd = 1e9;
    for (const a of lay.arms) { const d = Math.hypot(mx - a.x, my - a.y); const lim = a.sign > 0 ? 9 : 7; if (d <= lim && d < bd) { best = a; bd = d; } }
    if (best) return { kind: 'axis', axis: best.axis, sign: best.sign };
    return null;
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
    g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.font = '11px sans-serif'; g.lineWidth = 1;
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
  /** 幽灵卡片的四个世界角（画幽灵与"点幽灵选整条"共用同一份几何） */
  _ghostCorners(p, pose) {
    const host = this.host, cal = host.cal, ent = host.entity;
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
    return [corner(x0, -y0), corner(x1, -y0), corner(x1, -y1), corner(x0, -y1)];
  }
  /** 幽灵在屏幕上的四边形（点它 = 选整条）；没画幽灵时 null */
  _ghostQuad() {
    const host = this.host, prev = host.bake && host.bake.preview;
    if (!host.layers.ghost || !prev || !prev.world || !prev.world.length || !host.cal) return null;
    const p = sampleWorld(prev.world, host.tMs), pose = sampleScreen(prev.screen, host.tMs);
    if (!p || !pose) return null;
    const q = this._ghostCorners(p, pose).map((c) => this.project(c));
    return q.every(Boolean) ? q : null;
  }
  _ghost(mvp, p, pose) {
    const gl = this.gl;
    const q = this._ghostCorners(p, pose);
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
  // ------------------------------------------------------------- 拾取（把手）
  /** 优先级：gizmo 轴 / 面 / 环 > 锚点 > 活动段把手 > gizmo 中心（单点选中时它压在点上，拖点得还是拖点）> 幽灵 > 任一段曲线 */
  _hit(mx, my) {
    const host = this.host, cal = host.cal, seg = host.activeSeg();
    if (!host.doc || !cal || host.doc.space !== 'world') return null;
    const near = (p, r) => { const c = this.project(p); return c && Math.hypot(c[0] - mx, c[1] - my) <= (r || 9); };
    const g = this._gizmo(); const part = g ? Gizmo.hit(g, mx, my) : null;
    // 1. 小目标（锚点 / 控制点 / 抛体把手）先于 gizmo 的轴、面：别的点正好躺在轴线上时点它得选它——
    //    不然"选这个点，动的是另一个点"（2026-09-11 制作人抓到：铜钱那条的点挤在几 wu 内，全在上一个点的轴上）
    let small = null;
    for (const sl of Edit.slots(host.doc)) { const w = Edit.slotWorld(host, sl); if (w && (near([w[0], w[1] + 2, w[2]], 10) || near([w[0], w[1] + 40, w[2]], 8))) { small = { kind: 'slot', id: sl.id }; break; } }
    if (!small) { const ow = Edit.originWorld(host); if (ow && near(ow, 11)) small = { kind: 'origin' }; }
    if (!small && seg && seg.kind === 'manual') {
      const pts = host.effPoints(seg);
      if (!(g && g.n === 1)) for (let i = pts.length - 1; i >= 0 && !small; i--) if (host.sel.points.has(i)) { const c = this.project(pts[i].pos); if (c && Math.abs(c[0] - mx) <= 7 && my >= c[1] - 26 && my <= c[1] - 12) small = { kind: 'height', i }; }
      for (let i = pts.length - 1; i >= 0 && !small; i--) if (near(pts[i].pos)) small = { kind: 'point', i };
    } else if (!small && seg && seg.kind === 'physics') {
      const pi = host.physicsInfo(seg);
      if (pi) {
        if (near(pi.tipW, 11)) small = { kind: 'v0' };
        else if (!pi.grounded && near(pi.landingW, 11)) small = { kind: 'landing' };
        else if (pi.apexW && near(pi.apexW, 9)) small = { kind: 'apex' };
        else if (near(pi.startW, 9)) small = { kind: 'start' };
      }
    }
    if (small) {
      // 整段 / 整条的轴心就压在起点 / 锚点上：中心必须赢（钉住的起点本来也拖不动）；选中点 / 把手时中心让给小目标（同一个操作）
      if (part && Gizmo.isCenter(part) && (host.sel.scope === 'segment' || host.sel.scope === 'all') && !host.sel.handle) return { kind: 'gz', part };
      return small;
    }
    if (part) return { kind: 'gz', part };
    const gq = this._ghostQuad();
    if (gq && pointInPoly(mx, my, gq)) return { kind: 'ghost' };
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
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.fly) { this.cam.speed = clamp(this.cam.speed * Math.exp(-e.deltaY * 0.0015), 0.05, 20); this.host.status(`飞行速度 ×${fmt(this.cam.speed, 2)}`); this.draw(); return; }
      const [mx, my] = this._pos(e); this._zoomAt(mx, my, Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
    c.addEventListener('mousedown', (e) => this._down(e));
    c.addEventListener('dblclick', (e) => this._dbl(e));
    window.addEventListener('mousemove', (e) => this._move(e));
    window.addEventListener('mouseup', (e) => this._up(e));
    // 捕获阶段：飞行键在到达 app 的快捷键表之前就被吃掉（按住右键时 W 是"前进"，不是"移动 gizmo"）
    window.addEventListener('keydown', (e) => this._keyDown(e), true);
    window.addEventListener('keyup', (e) => this._keyUp(e), true);
    window.addEventListener('blur', () => { this.keys.clear(); this.spaceDown = false; });
  }
  _pos(e) { const r = this.c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  /** 按住右键期间：键盘归相机（app 的 onKey 也会据此让路） */
  capturesKeys() { return !!this.fly; }
  _keyDown(e) {
    if (e.code === 'Space' && !isTyping(e)) this.spaceDown = true;
    if (!this.fly) return;
    if (FLY_KEYS.has(e.code)) { this.keys.add(e.code); e.preventDefault(); e.stopImmediatePropagation(); }
  }
  _keyUp(e) { if (e.code === 'Space') this.spaceDown = false; this.keys.delete(e.code); }
  _orbit(e) { this.drag = { kind: 'orbit', mx: e.clientX, my: e.clientY, cam: Object.assign({}, this.cam), moved: false }; this.c.style.cursor = 'grabbing'; }
  _pan(e) { this.drag = { kind: 'pan', mx: e.clientX, my: e.clientY, cam: Object.assign({}, this.cam), wpp: this._worldPerPx([this.cam.tx, this.cam.ty, this.cam.tz]) }; this.c.style.cursor = 'grabbing'; }
  /** 朝光标处缩放：光标下那个点（地面 / 壳 / 目标深度）在屏幕上不动 */
  _zoomAt(mx, my, factor) {
    const c = this.cam, cal = this.host.cal, r = this.ray(mx, my), f = this._forward();
    let P = null;
    if (r && cal && cal.hf) { P = rayGround(r, cal, c.dist * 40); if (!P && cal.shell) P = rayShell(r, cal, c.dist * 40); }
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
  _flyLoop() {
    if (!this.fly) return;
    const now = performance.now(); const dt = Math.min(0.05, (now - this.fly.t) / 1000); this.fly.t = now;
    if (this._flyStep(dt)) this.draw();
    requestAnimationFrame(() => this._flyLoop());
  }
  _dbl(e) {
    if (!this.ok) return;
    const [mx, my] = this._pos(e); const host = this.host;
    const hit = this._hit(mx, my); if (!hit) return;
    if (hit.kind === 'point') { host.selectPoint(hit.i, false); this.frameSelection(); }
    else if (hit.kind === 'curve') { host.selectSegmentScope(hit.i); this.frameSelection(); }
    else if (hit.kind === 'ghost') { host.setScope('all'); this.frameSelection(); }
  }
  _down(e) {
    if (!this.ok) return;
    const [mx, my] = this._pos(e);
    const host = this.host, cal = host.cal;
    // 右上角坐标架
    const sg = e.button === 0 ? this._hitSceneGizmo(mx, my) : null;
    if (sg) {
      if (sg.kind === 'center') { this.setOrtho(!this.cam.ortho); host.status(this.cam.ortho ? '正交视图（再点中心回透视）' : '透视视图'); }
      else { this.snapView(sg.axis, sg.sign); host.status(`从 ${sg.sign > 0 ? '+' : '−'}${sg.axis.toUpperCase()} 看（正交）· 点中心回透视`); }
      return;
    }
    const alt = e.altKey;
    if (e.button === 2) {
      if (alt) { this.drag = { kind: 'dolly', mx: e.clientX, my: e.clientY, cam: Object.assign({}, this.cam) }; this.c.style.cursor = 'ns-resize'; return; }
      this.drag = { kind: 'look', mx: e.clientX, my: e.clientY, cam: Object.assign({}, this.cam), eye: this._eye(), hit: this._hit(mx, my), moved: false };
      this.keys.clear(); this.fly = { t: performance.now() }; requestAnimationFrame(() => this._flyLoop());
      this.c.style.cursor = 'move'; this.draw(); return;
    }
    if (e.button === 1) { this._pan(e); return; }
    if (e.button !== 0) return;
    if (alt) return this._orbit(e);
    if (this.spaceDown || host.tool === 'pan' || !host.doc) return this._pan(e);
    const editable = host.doc && cal && host.doc.space === 'world';
    if (!editable) return this._orbit(e);   // 画面空间资产：3D 只看，左键拖 = 环绕
    const tool = host.tool;
    const hit = this._hit(mx, my);
    if (tool === 'slot') { const g = this.pickGround(mx, my); if (g) { host.placeSlotFromGround(g); host.setTool('select'); } return; }
    if (tool === 'origin') { const g = this.pickGround(mx, my); if (g) { host.placeOriginFromGround(g); host.setTool('select'); } return; }
    if (hit && hit.kind === 'gz' && (tool === 'select' || tool === 'pen')) { this._gzDown(hit.part, mx, my); return; }
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
    if (hit && hit.kind === 'slot') { host.selectHandle('slot:' + hit.id); this.drag = { kind: 'slot', id: hit.id }; host.dragBegin('移动插槽'); this.draw(); return; }
    if (hit && hit.kind === 'origin') { host.selectHandle('origin'); this.drag = { kind: 'origin', h: Edit.originHeight(host) }; host.dragBegin('移动曲线原点'); this.draw(); return; }
    if (hit && hit.kind === 'height') { const p = host.effPoints(seg)[hit.i]; this.drag = { kind: 'height', i: hit.i, p: p.pos.slice(), h0: p.h, y0: this.pickVertical(mx, my, p.pos) }; host.dragBegin('改离地高度'); return; }
    if (hit && hit.kind === 'point') {
      if (e.shiftKey || e.ctrlKey || e.metaKey) { host.togglePoint(hit.i); this.draw(); return; }
      if (!host.sel.points.has(hit.i)) host.selectPoint(hit.i, false);
      if (host.pinned(seg) && hit.i === 0 && host.sel.points.size === 1) { host.status('起点被锚住（锚点 / 上一段末点），拖不动；要自由起点把起点改成"自定"'); this.draw(); return; }
      this.drag = this._pointDrag([...host.sel.points], mx, my, e.altKey); host.dragBegin(e.altKey ? '改离地高度' : '移动控制点'); this.draw(); return;
    }
    if (hit && hit.kind === 'v0') { host.selectHandle('v0'); const pi = host.physicsInfo(seg); this.drag = { kind: 'v0', alt: e.altKey, tip: pi.tipW.slice(), y0: this.pickVertical(mx, my, pi.tipW) }; host.dragBegin('改初速'); this.draw(); return; }
    if (hit && hit.kind === 'landing') { host.selectHandle('landing'); this.drag = { kind: 'landing' }; host.dragBegin('拖落点'); this.draw(); return; }
    if (hit && hit.kind === 'apex') { host.selectHandle('apex'); const pi = host.physicsInfo(seg); this.drag = { kind: 'apex', p: pi.apexW.slice(), y0: this.pickVertical(mx, my, pi.apexW) }; host.dragBegin('改最高点'); this.draw(); return; }
    if (hit && hit.kind === 'start') {
      if (host.pinned(seg)) { host.status('起点被锚住（锚点 / 上一段末点）；要自由起点把起点改成"自定"'); host.selectSegmentScope(host.segIndex); return; }
      host.selectHandle('start'); const pi = host.physicsInfo(seg); this.drag = { kind: 'start', p: pi.startW.slice(), h: cal.worldToXZH(pi.startW[0], pi.startW[1], pi.startW[2]).h }; host.dragBegin('移动起点'); this.draw(); return;
    }
    if (hit && hit.kind === 'ghost') { host.setScope('all'); host.status('已选中整条轨迹（幽灵 = 那个物体）：gizmo 在锚点上，移动 = 挪锚点、旋转 / 缩放以锚点为轴'); this.draw(); return; }
    if (hit && hit.kind === 'curve') { host.selectSegmentScope(hit.i); this.draw(); return; }
    // 空白：左键拖 = 框选（Shift 追加 / Ctrl 剔除）；没拖动 = 点空白清选择
    this.drag = { kind: 'box', mx, my, add: e.shiftKey, sub: e.ctrlKey || e.metaKey, moved: false }; this.box = null;
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
      if (!inside) { host.onCursorWorld(null); if (this.hover) { this.hover = null; this.draw(); } return; }
      if (cal) host.onCursorWorld(this.pickGround(mx, my));
      const sg = this._hitSceneGizmo(mx, my);
      const hit = sg ? null : this._hit(mx, my);
      const hv = sg ? { kind: 'scene', sg } : hit && hit.kind === 'gz' ? { kind: 'gz', part: hit.part } : null;
      if (JSON.stringify(hv) !== JSON.stringify(this.hover)) { this.hover = hv; this.draw(); }
      const t = host.tool;
      let cur = 'default';
      if (sg) cur = 'pointer';
      else if (e.altKey) cur = 'grab';
      else if (t === 'pan' || this.spaceDown) cur = 'grab';
      else if (hit && hit.kind === 'gz') cur = Gizmo.cursor(hit.part);
      else if (t === 'slot' || t === 'pen' || t === 'physics') cur = 'crosshair';
      else if (hit) cur = hit.kind === 'height' || hit.kind === 'apex' ? 'ns-resize' : hit.kind === 'curve' || hit.kind === 'ghost' ? 'pointer' : hit.kind === 'slot' || hit.kind === 'origin' ? 'move' : 'grab';
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
      this.cam.tx = d.cam.tx - rt[0] * dx * k + upv[0] * dy * k; this.cam.ty = d.cam.ty - rt[1] * dx * k + upv[1] * dy * k; this.cam.tz = d.cam.tz - rt[2] * dx * k + upv[2] * dy * k;
      this.draw(); return;
    }
    if (d.kind === 'box') {
      if (!d.moved && Math.hypot(mx - d.mx, my - d.my) < 3) return;
      d.moved = true; this.box = { x0: Math.min(d.mx, mx), y0: Math.min(d.my, my), x1: Math.max(d.mx, mx), y1: Math.max(d.my, my) }; this.draw(); return;
    }
    if (d.kind === 'gz') { this._gzMove(d, mx, my, e); return; }
    const seg = host.activeSeg();
    if (d.kind === 'slot') { const g = this.pickGround(mx, my); if (g) { const f = cal.worldToScene(g[0], g[1], g[2]); host.dragTick(() => Edit.setSlot(host, d.id, { x: f[0], y: f[1] })); } return; }
    if (d.kind === 'origin') { const g = this.pickGround(mx, my); if (g) host.dragTick(() => Edit.setOriginWorld(host, [g[0], g[1] + d.h, g[2]])); return; }
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
    const d = this.drag; this.drag = null; this.readout = null;
    const host = this.host;
    this.c.style.cursor = 'default';
    if (d.kind === 'orbit' || d.kind === 'dolly' || d.kind === 'pan') { this.draw(); return; }
    if (d.kind === 'look') {
      this.fly = null; this.keys.clear();
      // 右键点一下（没拖动）控制点 = 删点（与 2D 同）
      if (d.hit && !d.moved && d.hit.kind === 'point') host.op('删除控制点', () => Edit.deletePoints(host, host.activeSeg(), [d.hit.i]) || host.status('至少留一个点', 'err'));
      this.draw(); return;
    }
    if (d.kind === 'box') {
      const b = this.box; this.box = null;
      const seg = host.activeSeg();
      if (!d.moved || !b) { if (!d.add && !d.sub) host.clearSelection(); this.draw(); return; }
      if (seg && seg.kind === 'manual') {
        const inside = [];
        host.effPoints(seg).forEach((p, i) => { const c = this.project(p.pos); if (c && c[0] >= b.x0 && c[0] <= b.x1 && c[1] >= b.y0 && c[1] <= b.y1) inside.push(i); });
        if (d.sub) { for (const i of inside) if (host.sel.points.has(i)) host.togglePoint(i); }
        else if (inside.length) host.selectPoints(inside, d.add);
        else if (!d.add) host.clearSelection();
      }
      this.draw(); return;
    }
    if (d.kind === 'gz') { if (d.handle) host.dragEnd(); else host.endTransform(Gizmo.label(d.mode)); this.draw(); return; }
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
