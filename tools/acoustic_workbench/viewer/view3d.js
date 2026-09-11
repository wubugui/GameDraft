'use strict';
/* 声学工作台 · 3D 视图（裸 WebGL2，不引第三方库）。
 *
 * 画什么：深度还原出的场景三角网（贴背景）、地面网格、反射面（竖直墙 = 半透明四边形，水平面 = 平躺矩形）、
 * 听者 / 声源、抽头路径（耳朵 → 反射点）、游戏里真实听者的位置、出生点与 NPC 标记、把手与文字叠加。
 * 世界坐标 = M-world wu（+Y 上、XZ 地面），与灯位 / 轨迹同一坐标系。
 * ⚠ M-world 是**左手系**：x 画面右、Y 上、**Z 进画**。相机的 forward / right 与 mathx.js 的 lookAt 全按左手系搭
 * （yaw=0 看向 +Z，右 = up × forward，上 = forward × right）；拿 OpenGL 右手那套画它，整张画面镜像、所有左右操作全反。
 * 页面装场景后有一道对齐自证（app.js checkAlignment）：同一批画面点分别过运行时打包来的 sceneSpace 与这里的 SceneCal。
 *
 * 交互按 Unity 场景视图的习惯搭（与轨迹工作台 view3d.js 同一套；2026-09-10 制作人定死，2026-09-11 这里跟上）：
 *   相机（任何工具下）
 *     右键拖 = 环视（相机原地转头）；按住右键时 W/A/S/D 前左后右、Q/E 下上飞行，Shift ×3，滚轮调飞行速度
 *     Alt+左键拖 = 环绕（绕目标点转）· 中键 / 空格+左键 = 平移 · 滚轮 = 朝光标处缩放 · Alt+右键拖 = 推拉
 *     F = 对准选中 · Home = 整个场景 · 双击物体 = 选中并对准它
 *     右上角坐标架：点 X/Y/Z 臂 = 从那一侧正交看（顶视 / 侧视摆面）；点中心 = 透视 ⇄ 正交
 *   选择（Q，以及任何工具下点到物体）
 *     点物体 = 选；Shift / Ctrl+点 = 加减选；左键空白拖 = 框选（Shift 追加 / Ctrl 剔除）；点空白 = 清选择
 *   变换 gizmo（选中反射面 / 听者 / 声源时出现在轴心：单面 = 面中心，多选 = 包围盒中心，点 = 点本身）
 *     W 移动：红 X / 蓝 Z 箭头 = 沿轴（a、b 端点一起走）；绿 Y 箭头 = 高程（墙的底高程 / 水平面的高度 / 听者声源的 y）；
 *             三个小方块 = 在该平面里挪；中心 = 贴地挪（听者 / 声源跟着地面走）
 *     E 旋转：绿色圆环 = 绕竖直轴（单面绕面中心，多选绕包围盒中心）——听者 / 声源是一个点，旋转 / 缩放没意义，只给移动
 *     R 缩放：轴末端方块 = 单轴（X / Z 拉伸端点，Y = 面高，底不动）；中心方块 = 等比（长度与面高一起）
 *     拖动时按住 Ctrl = 吸附（10 wu / 15° / ×0.1）；读数跟在光标旁；松手即入历史（3px 死区，纯点一下不算编辑）
 *   直接操纵（不经 gizmo）：拖反射面本体 = 按当前工具移动 / 旋转 / 缩放；拖听者 / 声源 = 贴地走（Alt 或没行走面场时在水平面走）；
 *     单选一面时还有端点 A/B（改形状）与 ▲（墙的面高）把手
 *   B 加崖壁 = 在场景表面上按下拖到另一点；N 加水平面 = 在地面上拖一条边；L / P 放听者 / 放声源 = 点地面
 *
 * 飞行步进用 setInterval(16ms)：rAF 在隐藏页 / 无头壳里不跑，改回 rAF 自检会"卡住"。
 * ⚠ 相机的上向量叫 _camUp，别叫 _up——mouseup 处理器已经是 _up(e)，后定义的会静默盖掉前者。 */

const GZ = {
  len: 84, planeOff: 0.34, planeSize: 0.22, ring: 0.9, pick: 9,
  snapMove: 10, snapRot: 15, snapScale: 0.1,
  col: { x: '#ff5b5b', y: '#7ed492', z: '#5aa9ff', c: '#e6e8ec', hot: '#ffe44d' },
};
const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);
// 合成事件可能只带 key 不带 code（自检 / 旧浏览器）：按 key 补一个 code
const KEY2CODE = { w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', q: 'KeyQ', e: 'KeyE', shift: 'ShiftLeft', ' ': 'Space' };
const PITCH_MAX = Math.PI / 2 - 0.02;
function keyCode(e) { if (e.code) return e.code; const k = (e.key || '').toLowerCase(); return KEY2CODE[k] || ''; }
function isTyping(e) { const t = e.target; return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || !!t.isContentEditable); }

class View3D {
  constructor(canvas, overlay, host) {
    this.c = canvas; this.overlay = overlay; this.host = host;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    this.gl = gl; this.ok = !!gl;
    if (!gl) return;
    // 目标点 + 距离 + 朝向：机位 = 目标 − forward·dist。画的内容在 +Z（进画）一侧，初始机位落在 −Z（画家站的地方）往画里看
    this.cam = { yaw: 0.35, pitch: 0.35, dist: 2500, tx: 0, ty: 0, tz: 0, fov: 55, ortho: false, orthoH: 1000, speed: 1 };
    this.mesh = null; this.tex = null; this.gridLines = null;
    this.drag = null; this.box = null; this.hover = null; this.readout = null;
    this.fly = null; this.keys = new Set(); this.spaceDown = false;
    this._timer = 0; this._lastT = 0;
    this.progMesh = this._prog(MESH_VS, MESH_FS);
    this.progLine = this._prog(LINE_VS, LINE_FS);
    this.lineBuf = gl.createBuffer();
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
    // verts 留一份 CPU 引用：对齐自证要拿顶点世界坐标经运行时 worldToScene 投回画面、对它的 uv
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
  /** 世界包围盒：场景网格 ∪ 反射面 ∪ 听者 ∪ 声源 */
  worldBounds() {
    const m = this.mesh;
    let mn = m ? m.mn.slice() : [-1000, -100, -1000], mx = m ? m.mx.slice() : [1000, 300, 1000];
    const def = this.host.doc && this.host.doc.def;
    if (def) {
      for (const r of def.reflectors) for (const q of Geo.quad(r)) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], q[k]); mx[k] = Math.max(mx[k], q[k]); }
      const pts = [def.listener, ...(def.sources || [])];
      for (const p of pts) { mn[0] = Math.min(mn[0], p.x); mx[0] = Math.max(mx[0], p.x); mn[2] = Math.min(mn[2], p.z); mx[2] = Math.max(mx[2], p.z); }
    }
    return { mn, mx };
  }
  /**
   * 看全景：**按游戏相机的朝向**站到能看见整个场景网格的机位（略抬高、稍偏一点），
   * 第一眼就是玩家熟悉的那个角度，只是变成了 3D；目标点放在听者 / 出生点（那是人站的地方），没有就放网格中心。
   */
  fit(onlyScene) {
    const b = onlyScene && this.mesh ? { mn: this.mesh.mn, mx: this.mesh.mx } : this.worldBounds();
    const cx = (b.mn[0] + b.mx[0]) / 2, cz = (b.mn[2] + b.mx[2]) / 2, cy = (b.mn[1] + b.mx[1]) / 2;
    const ext = Math.max(b.mx[0] - b.mn[0], b.mx[2] - b.mn[2], b.mx[1] - b.mn[1], 200);
    const c = this.cam, cal = this.host.cal, def = this.host.doc && this.host.doc.def;
    const spawn = (this.host.marks || []).find((m) => m.kind === 'spawn');
    const focus = def ? [def.listener.x, def.listener.y || 0, def.listener.z] : spawn ? spawn.world.slice() : [cx, cy, cz];
    c.tx = focus[0] * 0.6 + cx * 0.4; c.ty = focus[1] * 0.6 + cy * 0.4; c.tz = focus[2] * 0.6 + cz * 0.4;
    if (cal) {
      const v = cal.viewDirWorld();           // 游戏相机看向的方向（世界）：q 的 +z，基本就是 +Z 进画
      c.yaw = Math.atan2(v[0], v[2]) + 0.25;  // forward(yaw) = (sin, ·, cos)，先对准它再稍偏一点，看得出立体
    } else c.yaw = 0.35;
    c.pitch = 0.38; c.ortho = false;
    this._setDist(ext * 0.95);
    this.draw();
  }
  /** 对准一个世界点（保持朝向，拉到合适距离）——F / 双击 / 检视器按钮都走这里 */
  focus(p, radius) {
    const c = this.cam;
    c.tx = p[0]; c.ty = p[1]; c.tz = p[2];
    this._setDist(Math.max(80, (radius || 120) * 3));
    this.draw();
  }
  resize() {
    const r = this.c.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    this.c.width = Math.max(1, Math.round(r.width * dpr)); this.c.height = Math.max(1, Math.round(r.height * dpr));
    if (this.overlay) { this.overlay.width = this.c.width; this.overlay.height = this.c.height; }
    this.draw();
  }
  // ------------------------------------------------------------- 相机
  /**
   * 左手系：yaw=0 看向 +Z（进画），yaw 增大 = 向右转（朝 +X）；pitch 增大 = 低头。
   * 相机右 = up × forward，相机上 = forward × right；机位 = 目标点减去 forward·dist。
   * ⚠ 这里的 X 项符号与 mathx.js 的左手 lookAt 是**一套**，单独改一边就是整张画面镜像（自检 S1b 钉住）。
   */
  _forward(c = this.cam) { return [Math.cos(c.pitch) * Math.sin(c.yaw), -Math.sin(c.pitch), Math.cos(c.pitch) * Math.cos(c.yaw)]; }
  /** 相机右（世界）= up × forward；yaw=0 时是 +X = 画面右。 */
  _right(c = this.cam) { const f = this._forward(c); return norm3([f[2], 0, -f[0]]); }
  /** 相机上（世界）= forward × right。（名字别改成 _up：那是 mouseup 处理器） */
  _camUp(c = this.cam) { return norm3(cross3(this._forward(c), this._right(c))); }
  _eye(c = this.cam) { const f = this._forward(c); return [c.tx - f[0] * c.dist, c.ty - f[1] * c.dist, c.tz - f[2] * c.dist]; }
  eye() { return this._eye(); }
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
  /** 拾取射线要走多远：正交时射线起点在机位背后 far 处，得够得着目标那一侧的地面 */
  _reach() { return Math.max(200000, this.cam.dist * 40 + 2e4); }
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
  // ------------------------------------------------------------- 拾取
  project(p) { const { mvp } = this._mvp(); return projectPoint(mvp, p, this.c.clientWidth, this.c.clientHeight); }
  ray(mx, my) { const { mvp } = this._mvp(); const inv = inv4(mvp); if (!inv) return null; return unprojectRay(inv, mx, my, this.c.clientWidth, this.c.clientHeight); }
  pickGround(mx, my) { const cal = this.host.cal; const r = this.ray(mx, my); if (!r) return null; if (cal && cal.hf) { const g = rayGround(r, cal, this._reach()); if (g) return g; } return rayPlane(r, [0, this._floorY(), 0], [0, 1, 0]); }
  /** 场景表面：深度壳优先（崖壁本身），打不到退地面 */
  pickSurface(mx, my) {
    const cal = this.host.cal, r = this.ray(mx, my); if (!r) return null;
    const g = cal && cal.hf ? rayGround(r, cal, this._reach()) : null;
    const s = cal && cal.shell ? rayShell(r, cal, this._reach()) : null;
    if (s && g) { const ds = Math.hypot(s[0] - r.o[0], s[1] - r.o[1], s[2] - r.o[2]), dg = Math.hypot(g[0] - r.o[0], g[1] - r.o[1], g[2] - r.o[2]); return ds <= dg + 1 ? { p: s, onShell: true } : { p: g, onShell: false }; }
    if (s) return { p: s, onShell: true };
    if (g) return { p: g, onShell: false };
    const p = rayPlane(r, [0, this._floorY(), 0], [0, 1, 0]);
    return p ? { p, onShell: false } : null;
  }
  pickPlane(mx, my, py) { const r = this.ray(mx, my); return r ? rayPlane(r, [0, py, 0], [0, 1, 0]) : null; }
  /** 鼠标 → 过 p 的、面朝相机的竖直平面上的点的 y；顶视（面退化）返回 null */
  pickVertical(mx, my, p) {
    const r = this.ray(mx, my); if (!r) return null;
    const v = this._viewDir(p); const l = Math.hypot(v[0], v[2]); if (l < 1e-6) return null;
    const q = rayPlane(r, p, [v[0] / l, 0, v[2] / l]); return q ? q[1] : null;
  }
  _floorY() { const cal = this.host.cal; const def = this.host.doc && this.host.doc.def; if (def) return def.listener.y || 0; if (cal && this.mesh) return this.mesh.mn[1]; return 0; }
  groundY(x, z) { const cal = this.host.cal; return cal && cal.hf ? cal.groundHeight(x, z) : this._floorY(); }
  // ------------------------------------------------------------- 绘制
  draw() {
    const gl = this.gl; if (!gl) return;
    const host = this.host, cal = host.cal, def = host.doc && host.doc.def;
    gl.viewport(0, 0, this.c.width, this.c.height);
    gl.clearColor(0.075, 0.085, 0.105, 1); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const { mvp } = this._mvp();
    if (this.mesh && this.tex && host.layers.mesh) {
      gl.useProgram(this.progMesh);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.progMesh, 'uMVP'), false, mvp);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(gl.getUniformLocation(this.progMesh, 'uTex'), 0);
      gl.uniform1f(gl.getUniformLocation(this.progMesh, 'uDim'), host.layers.dimMesh ? 0.55 : 1.0);
      gl.bindVertexArray(this.mesh.vao); gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_INT, 0); gl.bindVertexArray(null);
    }
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (host.layers.grid && cal && cal.hf) this._groundGrid(mvp);
    if (def) {
      const L = this._ear(def);
      // 反射面：体 + 边 + 竖直辅助线
      def.reflectors.forEach((r, i) => {
        const on = host.sel.kind === 'reflector' && host.sel.ids.has(i);
        const hov = this.hover && this.hover.kind === 'body' && this.hover.i === i;
        const q = Geo.quad(r);
        const horiz = Geo.isHorizontal(r);
        const shade = 0.35 + 0.55 * (1 - clamp(r.absorb, 0, 1));
        const col = on ? [0.42, 0.72, 1, 0.42] : horiz ? [0.35, 0.85, 0.9, 0.28] : [shade, shade * 0.82, shade * 0.45, hov ? 0.42 : 0.3];
        this._quad(mvp, q, col);
        const edge = on ? [0.6, 0.85, 1, 1] : horiz ? [0.4, 0.9, 0.95, 0.9] : [1, 0.85, 0.5, 0.8];
        this._lines(mvp, [...q[0], ...q[1], ...q[1], ...q[2], ...q[2], ...q[3], ...q[3], ...q[0]], edge, gl.LINES, 1);
        if (!horiz && cal && cal.hf) {
          // 底边到地面的落脚线：看得出墙是不是悬空 / 埋地
          const ga = this.groundY(r.a[0], r.a[1]), gb = this.groundY(r.b[0], r.b[1]);
          this._lines(mvp, [r.a[0], r.y || 0, r.a[1], r.a[0], ga, r.a[1], r.b[0], r.y || 0, r.b[1], r.b[0], gb, r.b[1]], [1, 1, 1, 0.25], gl.LINES, 1);
        }
      });
      // 抽头路径：耳朵 → 反射点（一阶橙、二阶紫、被挡红）
      if (host.layers.taps && host.taps && host.taps.length) {
        const arr1 = [], arr2 = [], arrO = [];
        for (const t of host.taps) {
          if (!t.hit) continue;
          const seg = [L[0], L[1], L[2], t.hit[0], t.hit[1], t.hit[2]];
          if (t.occluded) arrO.push(...seg); else if (t.order === 1) arr1.push(...seg); else arr2.push(...seg);
        }
        if (arr2.length) this._lines(mvp, arr2, [0.78, 0.57, 0.92, 0.35], gl.LINES, 1);
        if (arrO.length) this._lines(mvp, arrO, [1, 0.42, 0.42, 0.55], gl.LINES, 1);
        if (arr1.length) this._lines(mvp, arr1, [1, 0.7, 0.33, 0.85], gl.LINES, 1);
        for (const t of host.taps) if (t.hit && t.order === 1) this._marker(mvp, t.hit, t.occluded ? [1, 0.42, 0.42, 0.9] : [1, 0.7, 0.33, 0.95], 6);
      }
      // 听者：脚点 + 耳朵 + 竖线
      const Lf = [def.listener.x, def.listener.y || 0, def.listener.z];
      const onL = host.sel.kind === 'listener';
      this._lines(mvp, [...Lf, ...L], [0.42, 0.72, 1, 0.9], gl.LINES, 1);
      this._marker(mvp, Lf, onL ? [0.6, 0.85, 1, 1] : [0.42, 0.72, 1, 1], onL ? 12 : 9);
      this._marker(mvp, L, [0.42, 0.72, 1, 1], 7);
      // 有位置的声源：脚点 + 发声点 + 竖线；试听正从哪个发出就画它的直达线（发声点 → 耳）与它到各反射点的那半段
      const ps = host.probeSource;
      (def.sources || []).forEach((sp, i) => {
        const Sf = [sp.x, sp.y || 0, sp.z];
        const hgt = sp.height != null ? sp.height : (def.earHeight != null ? def.earHeight : 141);
        const Se = [Sf[0], Sf[1] + hgt, Sf[2]];
        const on = host.sel.kind === 'source' && host.sel.ids.has(i);
        const active = host.probeFrom === i;
        this._lines(mvp, [...Sf, ...Se], [1, 0.55, 0.85, 0.9], gl.LINES, 1);
        this._marker(mvp, Sf, on ? [1, 0.75, 0.9, 1] : active ? [1, 0.6, 0.88, 1] : [0.85, 0.45, 0.7, 0.9], on ? 12 : active ? 10 : 8);
        this._marker(mvp, Se, [1, 0.55, 0.85, 1], 6);
      });
      if (ps && host.layers.taps) {
        this._lines(mvp, [ps.x, ps.y, ps.z, ...L], [0.4, 0.9, 0.95, 0.9], gl.LINES, 1);
        const arrS = [];
        for (const t of host.taps) if (t.hit && t.order === 1) arrS.push(ps.x, ps.y, ps.z, t.hit[0], t.hit[1], t.hit[2]);
        if (arrS.length) this._lines(mvp, arrS, [1, 0.7, 0.33, 0.5], gl.LINES, 1);
      }
      // 把手（端点 A/B、▲ 面高）
      this._drawHandles(mvp);
    }
    // 游戏里的真实听者
    const gL = host.gameListener;
    if (gL && host.layers.gameListener) {
      const p = gL.world, e = gL.ear || [p[0], p[1] + 141, p[2]];
      this._marker(mvp, p, [0.5, 0.9, 0.55, 1], 13);
      this._lines(mvp, [...p, ...e], [0.5, 0.9, 0.55, 0.8], gl.LINES, 1);
      this._marker(mvp, e, [0.5, 0.9, 0.55, 1], 8);
      // 场景配了透视线时，参与计算的听者(实心)已按 f 重整过，与这张 3D 展开(正交)不重合。
      // 淡点画的是他在**画面上**站的地方，连线的长度就是"透视把听者推了多远"——
      // 不画的话作者只会看见听者莫名飘走，还以为是自己摆错了。
      if (gL.worldOrtho) {
        this._marker(mvp, gL.worldOrtho, [0.5, 0.9, 0.55, 0.35], 9);
        this._lines(mvp, [...gL.worldOrtho, ...p], [0.5, 0.9, 0.55, 0.3], gl.LINES, 1);
      }
    }
    // 出生点 / NPC
    if (host.layers.marks && host.marks) for (const m of host.marks) this._marker(mvp, m.world, m.kind === 'spawn' ? [1, 1, 1, 0.9] : [0.85, 0.85, 0.85, 0.7], m.kind === 'spawn' ? 8 : 6);
    gl.disable(gl.BLEND);
    this._overlay();
  }
  /** 画路径用的耳点：游戏在这个场景时用它活的耳点（抽头就是按它算的），否则作者态听者 + 耳高 */
  _ear(def) {
    const gL = this.host.gameListener;
    if (gL && gL.ear && this.host.liveEarActive) return [gL.ear[0], gL.ear[1], gL.ear[2]];
    return [def.listener.x, (def.listener.y || 0) + (def.earHeight != null ? def.earHeight : 141), def.listener.z];
  }
  /** 直接操纵的把手（世界）：只在单选一面反射面时有——端点 A/B 改形状、▲ 改墙的面高。移动 / 高程 / 旋转 / 缩放全归 gizmo。
   *  ▲ 放在顶边靠 A 那侧四分之一处，不放正中：正中的那条竖线正是 gizmo 的 Y 轴，两者叠着谁也点不到谁。 */
  _handles() {
    const host = this.host, def = host.doc && host.doc.def;
    if (!def || host.sel.kind !== 'reflector' || host.sel.ids.size !== 1) return [];
    const i = [...host.sel.ids][0], r = def.reflectors[i]; if (!r) return [];
    const y = r.y || 0, horiz = Geo.isHorizontal(r), out = [];
    out.push({ kind: 'end', i, end: 'a', p: [r.a[0], y, r.a[1]], size: 9 });
    out.push({ kind: 'end', i, end: 'b', p: [r.b[0], y, r.b[1]], size: 9 });
    if (!horiz) out.push({ kind: 'height', i, p: [r.a[0] + (r.b[0] - r.a[0]) * 0.25, y + r.height, r.a[1] + (r.b[1] - r.a[1]) * 0.25], size: 9 });
    return out;
  }
  _drawHandles(mvp) {
    for (const hd of this._handles()) this._marker(mvp, hd.p, hd.kind === 'height' ? [1, 0.7, 0.33, 1] : [1, 1, 1, 1], hd.size);
  }
  _groundGrid(mvp) {
    const cal = this.host.cal, hf = cal.hf;
    if (!this.gridLines) {
      const b = cal.groundBounds || [hf.x0, hf.x0 + hf.dx * (hf.n - 1), hf.z0, hf.z0 + hf.dz * (hf.n - 1)];
      const step = 176, arr = [];   // 2 米一格
      for (let x = Math.ceil(b[0] / step) * step; x <= b[1]; x += step) for (let z = b[2]; z < b[3]; z += step / 4) { const z2 = Math.min(b[3], z + step / 4); arr.push(x, cal.groundHeight(x, z) + 0.5, z, x, cal.groundHeight(x, z2) + 0.5, z2); }
      for (let z = Math.ceil(b[2] / step) * step; z <= b[3]; z += step) for (let x = b[0]; x < b[1]; x += step / 4) { const x2 = Math.min(b[1], x + step / 4); arr.push(x, cal.groundHeight(x, z) + 0.5, z, x2, cal.groundHeight(x2, z) + 0.5, z); }
      this.gridLines = new Float32Array(arr);
    }
    this._lines(mvp, this.gridLines, [1, 1, 1, 0.1], this.gl.LINES, 1);
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
    gl.drawArrays(mode, 0, arr.length / 3);
  }
  _quad(mvp, q, color) {
    const gl = this.gl;
    gl.depthMask(false);
    this._lines(mvp, [...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]], color, gl.TRIANGLES, 1);
    gl.depthMask(true);
  }
  _marker(mvp, p, color, size) { this.gl.disable(this.gl.DEPTH_TEST); this._lines(mvp, [p[0], p[1], p[2]], color, this.gl.POINTS, size); this.gl.enable(this.gl.DEPTH_TEST); }
  /** 2D 叠加：文字标签、把手符号、变换 gizmo、框选、读数、坐标架、两行提示（在 canvas 2D 上画，与 3D 同尺寸） */
  _overlay() {
    const ov = this.overlay; if (!ov) return;
    const g = ov.getContext('2d'); const dpr = window.devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, ov.clientWidth, ov.clientHeight);
    const host = this.host, def = host.doc && host.doc.def, H = ov.clientHeight;
    g.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
    if (def) {
      const k = host.metersPerWu();
      const L = this._ear(def);
      def.reflectors.forEach((r, i) => {
        const m = Geo.mid(r), y = (r.y || 0) + (Geo.isHorizontal(r) ? 0 : r.height);
        const c = this.project([m[0], y, m[1]]); if (!c) return;
        const on = host.sel.kind === 'reflector' && host.sel.ids.has(i);
        const dist = Math.hypot(m[0] - L[0], m[1] - L[2]) * k;
        g.fillStyle = on ? '#fff' : 'rgba(255,255,255,.75)';
        g.fillText(`${r.id || '#' + i}  ${fmt(dist, 0)}m`, c[0] + 6, c[1] - 4);
      });
      const lc = this.project([def.listener.x, def.listener.y || 0, def.listener.z]);
      if (lc) { g.fillStyle = '#9fd0ff'; g.fillText(host.gameListener && host.gameListener.stale === false ? '听者（作者态）' : '听者', lc[0] + 9, lc[1] + 4); }
      (def.sources || []).forEach((sp, i) => { const sc = this.project([sp.x, sp.y || 0, sp.z]); if (sc) { g.fillStyle = '#ff9ad6'; g.fillText(sp.id + (host.probeFrom === i ? ' ▶' : ''), sc[0] + 9, sc[1] + 4); } });
      for (const hd of this._handles()) {
        const c = this.project(hd.p); if (!c) continue;
        if (hd.kind === 'height') { g.fillStyle = '#ffb454'; g.beginPath(); g.moveTo(c[0], c[1] - 9); g.lineTo(c[0] - 5, c[1] - 1); g.lineTo(c[0] + 5, c[1] - 1); g.closePath(); g.fill(); }
        else if (hd.kind === 'end') { g.fillStyle = '#fff'; g.fillText(hd.end.toUpperCase(), c[0] + 7, c[1] - 6); }
      }
    }
    const gL = host.gameListener;
    if (gL && host.layers.gameListener) {
      const c = this.project(gL.ear || gL.world);
      const who = gL.mode === 'camera' ? '相机' : gL.mode === 'entity' ? (gL.entityId || '实体') : gL.mode === 'fixed' ? '固定点' : '玩家';
      const persp = gL.perspF ? `（透视 f=${gL.perspF.toFixed(2)}）` : '';
      if (c) { g.fillStyle = '#7ed492'; g.fillText(`游戏听者·${who}${gL.targetMissing ? '（实体不在场→玩家）' : ''}${gL.grounded ? '' : '（平面映射）'}${persp}`, c[0] + 8, c[1] - 2); }
      if (gL.worldOrtho) {
        const co = this.project(gL.worldOrtho);
        if (co) { g.fillStyle = 'rgba(126,212,146,.55)'; g.fillText('画面位置（未含透视）', co[0] + 8, co[1] + 12); }
      }
    }
    if (host.layers.marks && host.marks) for (const m of host.marks) { const c = this.project(m.world); if (c) { g.fillStyle = m.kind === 'spawn' ? 'rgba(255,255,255,.85)' : 'rgba(220,220,220,.6)'; g.fillText(m.id, c[0] + 7, c[1] + 4); } }
    const gz = this._gizmo(); if (gz) this._drawGizmo(g, gz);
    if (this.box) { const b = this.box; g.strokeStyle = 'rgba(108,180,255,.9)'; g.fillStyle = 'rgba(108,180,255,.12)'; g.setLineDash([4, 3]); g.lineWidth = 1; g.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.setLineDash([]); }
    if (this.drag && (this.drag.kind === 'addWall' || this.drag.kind === 'addPlane') && this.drag.b) {
      const a = this.project(this.drag.a), b = this.project(this.drag.b);
      if (a && b) { g.strokeStyle = '#ffb454'; g.lineWidth = 2; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); g.lineWidth = 1; }
    }
    if (this.readout) { const r = this.readout; g.font = 'bold 12px sans-serif'; const w = g.measureText(r.text).width + 12; g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(r.x, r.y - 13, w, 18); g.fillStyle = GZ.col.hot; g.fillText(r.text, r.x + 6, r.y); g.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif'; }
    this._drawSceneGizmo(g);
    // 两行提示都摞在左下坐标读数（#coords，占 H-31..H-8）之上：工具一行在 H-38，相机一行在 H-52
    const tips = { addWall: '加崖壁：在崖壁 / 地面上按下拖到另一点 = 一面新崖壁（Esc 退出）', addPlane: '加水平面：在地面上按下拖出一条边 = 一片水平面（水面 / 岩檐）', placeListener: '点地面放听者', placeSource: '点地面放一个有位置的声源（可放多个；试听从选中的声源发出）',
      move: gz ? (gz.kind === 'reflector' ? '移动（W）：红 X / 蓝 Z 箭头 沿轴 · 绿 Y 箭头 高程 · 小方块 沿面 · 中心 / 拖本体 贴地挪 · 拖 A/B 改端点 · 拖 ▲ 改面高 · 按住 Ctrl 吸附 10 wu' : '移动（W）：红 X / 蓝 Z 箭头 沿轴 · 绿 Y 箭头 改高程 · 中心 / 拖本体 = 贴着地面走 · 按住 Ctrl 吸附 10 wu') : '移动（W）：点物体选中后出现 gizmo · 左键空白拖 框选',
      rotate: gz ? (gz.mode === 'rotate' ? '旋转（E）：拖绿环 绕竖直轴（多选绕包围盒中心）· 拖本体 也是旋转 · 按住 Ctrl 吸附 15°' : '旋转（E）：听者 / 声源是一个点，只有移动 gizmo') : '旋转（E）：选中反射面后拖绿环',
      scale: gz ? (gz.mode === 'scale' ? '缩放（R）：轴末端方块 单轴（Y = 面高，底不动）· 中心方块 等比 · 拖本体 缩放长度 · 按住 Ctrl 吸附 ×0.1' : '缩放（R）：听者 / 声源是一个点，只有移动 gizmo') : '缩放（R）：选中反射面后拖轴末端 / 中心',
      select: '选择（Q）：点选 · 左键空白拖 框选 · Shift / Ctrl+点 加减选 · 双击 对准' };
    g.fillStyle = 'rgba(255,255,255,.55)'; g.fillText(tips[host.tool] || '', 12, H - 38);
    const camHint = this.fly ? `飞行中：W/A/S/D 前左后右 · Q/E 下上 · Shift ×3 · 滚轮调速（×${fmt(this.cam.speed, 2)}）` : '相机：右键拖 环视 · 右键+WASD/QE 飞行 · Alt+左键 环绕 · 中键/空格+左键 平移 · 滚轮 缩放到光标 · Alt+右键 推拉 · F 对准选中 · Home 整场';
    g.fillStyle = 'rgba(255,255,255,.5)'; g.fillText(camHint, 12, H - 52);
  }
  // ------------------------------------------------------------- 变换 gizmo
  /**
   * gizmo 几何（世界 + 屏幕）。null = 不显示（没选中、或不在 W/E/R 工具下）。
   * 轴心：单面 → 面中心（墙在半高，水平面在面上）；多选 → 包围盒中心；听者 / 声源 → 点本身。
   * 模式跟工具走（W/E/R）；听者 / 声源是一个点，旋转 / 缩放没意义，一律给移动。
   */
  _gizmo() {
    const host = this.host, def = host.doc && host.doc.def; if (!def) return null;
    const tool = host.tool; if (tool !== 'move' && tool !== 'rotate' && tool !== 'scale') return null;
    const sel = host.sel; let pivot, kind, ids = [], noY = false;
    if (sel.kind === 'reflector' && sel.ids.size) {
      ids = [...sel.ids].filter((i) => def.reflectors[i]); if (!ids.length) return null;
      const rs = ids.map((i) => def.reflectors[i]);
      if (rs.length === 1) { const r = rs[0], m = Geo.mid(r), y = r.y || 0; pivot = [m[0], y + (Geo.isHorizontal(r) ? 0 : r.height / 2), m[1]]; }
      else { const b = Geo.bounds(rs); pivot = [b.cx, b.cy, b.cz]; }
      kind = 'reflector'; noY = rs.every((r) => Geo.isHorizontal(r));
    } else if (sel.kind === 'listener') { const L = def.listener; pivot = [L.x, L.y || 0, L.z]; kind = 'listener'; ids = [0]; }
    else if (sel.kind === 'source' && sel.ids.size) { const i = [...sel.ids][0], sp = (def.sources || [])[i]; if (!sp) return null; pivot = [sp.x, sp.y || 0, sp.z]; kind = 'source'; ids = [i]; }
    else return null;
    const mode = kind === 'reflector' ? tool : 'move';
    const c = this.project(pivot); if (!c) return null;
    const L = GZ.len * this._worldPerPx(pivot);
    const ax = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const axes = mode === 'scale' && noY ? ['x', 'z'] : ['x', 'z', 'y'];   // 水平面没有竖直尺寸：缩放模式不给 Y
    const at = (u, a, v, b) => [pivot[0] + a[0] * u + (b ? b[0] * v : 0), pivot[1] + a[1] * u + (b ? b[1] * v : 0), pivot[2] + a[2] * u + (b ? b[2] * v : 0)];
    const tip = {}; for (const k of axes) tip[k] = this.project(at(L, ax[k]));
    const out = { pivot, kind, ids, n: ids.length, mode, L, c, ax, axes, tip, planes: {}, ring: null };
    if (mode === 'move') {
      const o = GZ.planeOff * L, s = GZ.planeSize * L;
      for (const [k, a, b] of [['xz', ax.x, ax.z], ['xy', ax.x, ax.y], ['yz', ax.z, ax.y]]) {
        const poly = [this.project(at(o, a, o, b)), this.project(at(o + s, a, o, b)), this.project(at(o + s, a, o + s, b)), this.project(at(o, a, o + s, b))];
        if (poly.every(Boolean)) out.planes[k] = poly;
      }
    } else if (mode === 'rotate') {
      const R = GZ.ring * L, pts = [];
      for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2; const p = this.project([pivot[0] + Math.cos(a) * R, pivot[1], pivot[2] + Math.sin(a) * R]); if (!p) { pts.length = 0; break; } pts.push(p); }
      if (pts.length) out.ring = pts;
    }
    return out;
  }
  _hitGizmo(mx, my) {
    const g = this._gizmo(); if (!g) return null;
    const near = (p, r) => !!p && Math.hypot(p[0] - mx, p[1] - my) <= r;
    // 轴几乎对着视线（投影成一个点）时不给抓：抓到也算不出位移
    const axisHit = (k) => { const t = g.tip[k]; return !!t && Math.hypot(t[0] - g.c[0], t[1] - g.c[1]) >= 14 && distToSeg(mx, my, g.c, t) <= GZ.pick; };
    const order = ['y', 'x', 'z'].filter((k) => g.axes.includes(k));
    if (g.mode === 'move') {
      if (near(g.c, 8)) return { kind: 'gz', part: 'c', g };
      for (const k in g.planes) if (pointInPoly(mx, my, g.planes[k])) return { kind: 'gz', part: k, g };
      for (const k of order) if (axisHit(k)) return { kind: 'gz', part: k, g };
    } else if (g.mode === 'rotate') {
      if (g.ring) for (let i = 0; i < g.ring.length; i++) { const a = g.ring[i], b = g.ring[(i + 1) % g.ring.length]; if (distToSeg(mx, my, a, b) <= GZ.pick) return { kind: 'gz', part: 'ring', g }; }
    } else {
      if (near(g.c, 9)) return { kind: 'gz', part: 'sc', g };
      for (const k of order) if (near(g.tip[k], 9) || axisHit(k)) return { kind: 'gz', part: 's' + k, g };
    }
    return null;
  }
  _drawGizmo(g, gz) {
    const hot = this.drag && this.drag.kind === 'gz' ? this.drag.part : (this.hover && this.hover.kind === 'gz' ? this.hover.part : null);
    const col = (part, base) => (hot === part ? GZ.col.hot : base);
    const c = gz.c;
    g.lineWidth = 2; g.font = 'bold 11px sans-serif';
    const axisSeg = (k) => { const t = gz.tip[k]; if (!t) return null; const dx = t[0] - c[0], dy = t[1] - c[1], l = Math.hypot(dx, dy); if (l < 14) return null; return { t, d: [dx / l, dy / l], l }; };
    const label = { x: 'X', y: 'Y', z: 'Z' };
    const order = ['x', 'z', 'y'].filter((k) => gz.axes.includes(k));
    if (gz.mode === 'move') {
      for (const k of order) {
        const s = axisSeg(k); if (!s) continue;
        g.strokeStyle = g.fillStyle = col(k, GZ.col[k]);
        g.beginPath(); g.moveTo(c[0], c[1]); g.lineTo(s.t[0], s.t[1]); g.stroke();
        const px = -s.d[1], py = s.d[0];
        g.beginPath(); g.moveTo(s.t[0], s.t[1]); g.lineTo(s.t[0] - s.d[0] * 12 + px * 5, s.t[1] - s.d[1] * 12 + py * 5); g.lineTo(s.t[0] - s.d[0] * 12 - px * 5, s.t[1] - s.d[1] * 12 - py * 5); g.closePath(); g.fill();
        g.fillText(label[k], s.t[0] + s.d[0] * 10 + 3, s.t[1] + s.d[1] * 10 + 4);
      }
      for (const k in gz.planes) {
        const poly = gz.planes[k], base = GZ.col[k === 'xz' ? 'y' : k === 'xy' ? 'z' : 'x'];
        g.beginPath(); poly.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath();
        g.fillStyle = hot === k ? 'rgba(255,228,77,.55)' : base + '55'; g.fill(); g.strokeStyle = col(k, base); g.lineWidth = 1; g.stroke(); g.lineWidth = 2;
      }
      g.fillStyle = col('c', GZ.col.c); g.fillRect(c[0] - 5, c[1] - 5, 10, 10); g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1; g.strokeRect(c[0] - 5.5, c[1] - 5.5, 11, 11); g.lineWidth = 2;
    } else if (gz.mode === 'rotate') {
      if (gz.ring) { g.strokeStyle = col('ring', GZ.col.y); g.beginPath(); gz.ring.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.stroke(); }
      g.fillStyle = GZ.col.c; g.beginPath(); g.arc(c[0], c[1], 3, 0, Math.PI * 2); g.fill();
      g.fillStyle = col('ring', GZ.col.y); g.fillText('Y', c[0] + 8, c[1] - 8);
    } else {
      for (const k of order) {
        const s = axisSeg(k); if (!s) continue;
        g.strokeStyle = g.fillStyle = col('s' + k, GZ.col[k]);
        g.beginPath(); g.moveTo(c[0], c[1]); g.lineTo(s.t[0], s.t[1]); g.stroke();
        g.fillRect(s.t[0] - 5, s.t[1] - 5, 10, 10);
        g.fillText(k === 'y' ? 'Y(高)' : label[k], s.t[0] + s.d[0] * 10 + 3, s.t[1] + s.d[1] * 10 + 4);
      }
      g.fillStyle = col('sc', GZ.col.c); g.fillRect(c[0] - 6, c[1] - 6, 12, 12); g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1; g.strokeRect(c[0] - 6.5, c[1] - 6.5, 13, 13); g.lineWidth = 2;
    }
    g.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif'; g.lineWidth = 1;
  }
  /** 手势开始时选中物的字段快照：每 tick 从这里重来再套累计量，零位移就真的什么都不变（纯点一下不入历史） */
  _snapSel(g) {
    const host = this.host, def = host.doc.def;
    if (g.kind === 'reflector') return { kind: 'reflector', items: g.ids.map((i) => { const r = def.reflectors[i]; return { i, a: r.a.slice(), b: r.b.slice(), y: r.y || 0, hasY: r.y != null, h: r.height }; }) };
    const pt = host.pointOf(g.kind, g.ids[0]);
    return { kind: g.kind, idx: g.ids[0], x: pt.x, y: pt.y || 0, hasY: pt.y != null, z: pt.z };
  }
  _gzDown(part, mx, my, e) {
    const host = this.host, g = this._gizmo(); if (!g) return;
    const r = this.ray(mx, my); if (!r) return;
    const p0 = g.pivot.slice();
    const d = { kind: 'gz', part, p0, pv: [p0[0], p0[2]], L: g.L, c: g.c, sx: mx, sy: my, moved: false, mode: g.mode, snap: this._snapSel(g) };
    if (/^s?[xyz]$/.test(part)) {
      const k = part.slice(-1); d.axis = g.ax[k]; d.t0 = rayLineParam(r, p0, d.axis);
      const t = g.tip[k]; if (t) { const l = Math.hypot(t[0] - g.c[0], t[1] - g.c[1]); if (l > 1) { d.sdir = [(t[0] - g.c[0]) / l, (t[1] - g.c[1]) / l]; d.sk = g.L / l; } }
    } else if (part === 'ring') {
      const q = rayPlane(r, p0, [0, 1, 0]);
      d.a0 = q ? Math.atan2(q[2] - p0[2], q[0] - p0[0]) : null;
      d.sa0 = Math.atan2(-(my - g.c[1]), mx - g.c[0]); d.sign = this._eye()[1] >= p0[1] ? 1 : -1; d.acc = 0; d.last = null;
    } else if (part !== 'sc') {
      d.n = part === 'xy' ? [0, 0, 1] : part === 'yz' ? [1, 0, 0] : [0, 1, 0];
      d.q0 = rayPlane(r, p0, d.n);
      if (!d.q0) { d.n = this._viewDir(p0); d.q0 = rayPlane(r, p0, d.n); d.cam = true; }   // 面对着视线（顶视拖 XY 面）：退到相机平面
    }
    this.drag = d; host.dragBegin({ move: '移动', rotate: '旋转', scale: '缩放' }[g.mode]);
  }
  _gzMove(d, mx, my, e) {
    const host = this.host, r = this.ray(mx, my); if (!r) return;
    if (!d.moved && Math.hypot(mx - d.sx, my - d.sy) < 3) return;   // 3px 死区：纯点一下不算编辑
    d.moved = true;
    const ctrl = e.ctrlKey || e.metaKey;
    const snap = (v, s) => (ctrl ? Math.round(v / s) * s : v);
    const part = d.part; let T = null, txt = '';
    const tr = (dx, dy, dz, ground) => ({ op: 'translate', dx, dy, dz, ground: !!ground });
    if (d.axis) {
      let dd;
      const t = d.t0 != null ? rayLineParam(r, d.p0, d.axis) : null;
      if (t != null) dd = t - d.t0;
      else if (d.sdir) dd = ((mx - d.sx) * d.sdir[0] + (my - d.sy) * d.sdir[1]) * d.sk;
      else return;
      const k = part.slice(-1);
      if (d.mode === 'move') { dd = snap(dd, GZ.snapMove); T = tr(k === 'x' ? dd : 0, k === 'y' ? dd : 0, k === 'z' ? dd : 0); txt = `Δ${k} ${fmt(dd)}`; }
      else { const kk = Math.max(0.05, snap(1 + dd / d.L, GZ.snapScale)); T = { op: 'scale', kx: k === 'x' ? kk : 1, ky: k === 'y' ? kk : 1, kz: k === 'z' ? kk : 1 }; txt = `×${fmt(kk, 2)} ${k === 'y' ? '高' : k}`; }
    } else if (part === 'sc') {
      const kk = Math.max(0.05, snap(Math.exp(((mx - d.sx) - (my - d.sy)) / 150), GZ.snapScale));
      T = { op: 'scale', kx: kk, ky: kk, kz: kk, uniform: true }; txt = `×${fmt(kk, 2)}`;
    } else if (part === 'ring') {
      const q = rayPlane(r, d.p0, [0, 1, 0]);
      const a = q && d.a0 != null ? Math.atan2(q[2] - d.p0[2], q[0] - d.p0[0]) - d.a0 : (Math.atan2(-(my - d.c[1]), mx - d.c[0]) - d.sa0) * d.sign;
      if (d.last == null) { let a0 = a; while (a0 > Math.PI) a0 -= 2 * Math.PI; while (a0 < -Math.PI) a0 += 2 * Math.PI; d.acc = a0; }
      else { let dl = a - d.last; while (dl > Math.PI) dl -= 2 * Math.PI; while (dl < -Math.PI) dl += 2 * Math.PI; d.acc += dl; }
      d.last = a;
      const deg = snap(d.acc * 180 / Math.PI, GZ.snapRot);
      T = { op: 'rotate', deg }; txt = `${fmt(deg)}°`;
    } else {
      const q = rayPlane(r, d.p0, d.n); if (!q || !d.q0) return;
      const dx = snap(q[0] - d.q0[0], GZ.snapMove), dy = snap(q[1] - d.q0[1], GZ.snapMove), dz = snap(q[2] - d.q0[2], GZ.snapMove);
      if (part === 'xy') { T = tr(dx, dy, 0); txt = `Δx ${fmt(dx)}  Δy ${fmt(dy)}`; }
      else if (part === 'yz') { T = tr(0, dy, dz); txt = `Δz ${fmt(dz)}  Δy ${fmt(dy)}`; }
      else if (d.cam) { T = tr(dx, dy, dz); txt = `Δx ${fmt(dx)}  Δz ${fmt(dz)}  Δy ${fmt(dy)}`; }
      else { T = tr(dx, 0, dz, true); txt = `Δx ${fmt(dx)}  Δz ${fmt(dz)}`; }   // XZ 面与中心：贴地挪
    }
    if (!T) return;
    this.readout = { x: mx + 16, y: my + 22, text: txt + (ctrl ? '  [吸附]' : '') };
    host.dragTick(() => this._gzApply(d, T));
  }
  /** 把 gizmo 的累计量套到选中物自己的字段上：反射面 = a / b / y / height，听者 / 声源 = x / y / z */
  _gzApply(d, T) {
    const host = this.host, def = host.doc && host.doc.def; if (!def) return;
    const s = d.snap;
    if (s.kind === 'reflector') {
      const px = d.pv[0], pz = d.pv[1];
      for (const st of s.items) {
        const r = def.reflectors[st.i]; if (!r) continue;
        r.a = st.a.slice(); r.b = st.b.slice(); r.height = st.h; if (st.hasY) r.y = st.y; else delete r.y;
        if (T.op === 'translate') {
          if (T.dx || T.dz) Geo.translate(r, T.dx, T.dz, 0);
          if (T.dy) r.y = round3(st.y + T.dy);
        } else if (T.op === 'rotate') {
          if (T.deg) Geo.rotate(r, T.deg * Math.PI / 180, d.pv);
        } else if (T.uniform) {
          Geo.scaleLength(r, T.kx, d.pv); r.height = round3(Math.max(1, st.h * T.kx));
        } else {
          if (T.kx !== 1) { r.a[0] = px + (r.a[0] - px) * T.kx; r.b[0] = px + (r.b[0] - px) * T.kx; }
          if (T.kz !== 1) { r.a[1] = pz + (r.a[1] - pz) * T.kz; r.b[1] = pz + (r.b[1] - pz) * T.kz; }
          if (T.ky !== 1 && !Geo.isHorizontal(r)) r.height = round3(Math.max(1, st.h * T.ky));   // 面高：底不动、顶走
        }
        r.a = [round3(r.a[0]), round3(r.a[1])]; r.b = [round3(r.b[0]), round3(r.b[1])];
      }
    } else {
      const pt = host.pointOf(s.kind, s.idx); if (!pt) return;
      pt.x = s.x; pt.z = s.z; if (s.hasY) pt.y = s.y; else delete pt.y;
      if (T.op !== 'translate') return;
      let x = s.x + T.dx, z = s.z + T.dz, y = s.y + T.dy;
      if (T.ground && host.cal && host.cal.hf) y = host.cal.groundHeight(x, z);   // 贴地挪：跟着行走面走
      host.setPoint(s.kind, { x, y, z }, s.idx);
    }
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
    g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif'; g.lineWidth = 1;
  }
  // ------------------------------------------------------------- 拾取（把手 / gizmo / 物体）
  /** 优先级：把手（端点 / ▲，小目标）> 变换 gizmo > 声源 > 听者 > 反射面本体 > 反射面边线 */
  _hit(mx, my) {
    const host = this.host, def = host.doc && host.doc.def;
    if (!def) return null;
    const near = (p, r) => { const c = this.project(p); return c && Math.hypot(c[0] - mx, c[1] - my) <= (r || 9); };
    // ⚠ hd 自己带 kind（end/height），必须放在 kind:'handle' 之前，否则把 'handle' 盖掉——第一版就是这么让所有把手都拖不动的
    for (const hd of this._handles()) if (near(hd.p, hd.size + 3)) return Object.assign({}, hd, { kind: 'handle', hkind: hd.kind });
    const gz = this._hitGizmo(mx, my); if (gz) return gz;
    for (let i = 0; i < (def.sources || []).length; i++) { const sp = def.sources[i]; if (near([sp.x, sp.y || 0, sp.z], 11)) return { kind: 'source', idx: i }; }
    if (near([def.listener.x, def.listener.y || 0, def.listener.z], 11)) return { kind: 'listener' };
    const ray = this.ray(mx, my); if (!ray) return null;
    let best = null;
    def.reflectors.forEach((r, i) => {
      const q = Geo.quad(r);
      const t = rayQuad(ray, q[0], q[1], q[2], q[3]);
      if (t != null && (!best || t < best.t)) best = { kind: 'body', i, t };
    });
    if (best) return best;
    // 边线也能点（薄的水平面正面看是一条线）
    def.reflectors.forEach((r, i) => {
      const q = Geo.quad(r);
      for (let e = 0; e < 4; e++) { const a = this.project(q[e]), b = this.project(q[(e + 1) % 4]); if (a && b && distToSeg(mx, my, a, b) <= 5) { if (!best) best = { kind: 'body', i, t: 1e9 }; } }
    });
    return best;
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
    // 捕获阶段：飞行键在到达 app 的快捷键表之前就被吃掉（按住右键时 W 是"前进"，不是"移动工具"；E 是"上升"，不是"旋转"）
    window.addEventListener('keydown', (e) => this._keyDown(e), true);
    window.addEventListener('keyup', (e) => this._keyUp(e), true);
    window.addEventListener('blur', () => { this.keys.clear(); this.spaceDown = false; });
  }
  _pos(e) { const r = this.c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  /** 按住右键期间：键盘归相机（app 的 onKey 也会据此让路） */
  capturesKeys() { return !!this.fly; }
  /** 旧名：按着右键 = 飞行中（app.js 的工具键表按它让路） */
  flying() { return !!this.fly; }
  _keyDown(e) {
    const code = keyCode(e);
    if (code === 'Space' && !isTyping(e)) this.spaceDown = true;
    if (!this.fly) return;
    if (FLY_KEYS.has(code)) { this.keys.add(code); e.preventDefault(); e.stopImmediatePropagation(); }
  }
  _keyUp(e) {
    const code = keyCode(e);
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
  /** 飞一帧：按当前按键把相机挪 dt 秒（正交下 W/S 是缩放）。返回是否动了。 */
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
  /** 按住右键期间以 16ms 定时步进（不用 rAF：页面不可见 / 无头时 rAF 不跑，飞行就"卡住"）；松开右键即停。 */
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
  /** 双击物体 = 选中并对准它 */
  _dbl(e) {
    if (!this.ok) return;
    const [mx, my] = this._pos(e); const host = this.host, def = host.doc && host.doc.def; if (!def) return;
    const hit = this._hit(mx, my); if (!hit) return;
    if (hit.kind === 'body') { host.select('reflector', hit.i, false); const b = Geo.bounds([def.reflectors[hit.i]]); this.focus([b.cx, b.cy, b.cz], Math.max(b.x1 - b.x0, b.z1 - b.z0, b.y1 - b.y0)); }
    else if (hit.kind === 'listener' || hit.kind === 'source') { host.select(hit.kind, hit.idx || 0, false); const pt = host.pointOf(hit.kind, hit.idx || 0); if (pt) this.focus([pt.x, pt.y || 0, pt.z], 150); }
  }
  _down(e) {
    if (!this.ok) return;
    const [mx, my] = this._pos(e);
    const host = this.host, def = host.doc && host.doc.def;
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
      this.drag = { kind: 'look', mx: e.clientX, my: e.clientY, cam: Object.assign({}, this.cam), eye: this._eye(), moved: false };
      this.keys.clear(); this.fly = { t: performance.now() }; this._flyLoop();
      this.c.style.cursor = 'move'; this.draw(); return;
    }
    if (e.button === 1) { e.preventDefault(); this._pan(e); return; }
    if (e.button !== 0) return;
    if (alt) return this._orbit(e);
    if (this.spaceDown || !def) return this._pan(e);
    const tool = host.tool;
    if (tool === 'addWall') { const s = this.pickSurface(mx, my); if (!s) return; this.drag = { kind: 'addWall', a: s.p, b: null, onShell: s.onShell }; return; }
    if (tool === 'addPlane') { const g = this.pickGround(mx, my); if (!g) return; this.drag = { kind: 'addPlane', a: g, b: null }; return; }
    if (tool === 'placeListener' || tool === 'placeSource') {
      const g = this.pickGround(mx, my); if (!g) return;
      if (tool === 'placeListener') host.op('放听者', () => host.setPoint('listener', { x: g[0], y: g[1], z: g[2] }));
      else host.op('放声源', () => host.addSource({ x: g[0], y: g[1], z: g[2] }));
      host.setTool('move'); return;
    }
    const hit = this._hit(mx, my);
    if (hit && hit.kind === 'gz') { this._gzDown(hit.part, mx, my, e); return; }
    if (hit && hit.kind === 'handle') {
      if (hit.hkind === 'end') { const r = def.reflectors[hit.i]; host.select('reflector', hit.i, false); this.drag = { kind: 'end', i: hit.i, end: hit.end, y: r.y || 0, a0: r.a.slice(), b0: r.b.slice(), p0: this.pickPlane(mx, my, r.y || 0) }; host.dragBegin('改端点'); return; }
      if (hit.hkind === 'height') { const r = def.reflectors[hit.i]; this.drag = { kind: 'height', i: hit.i, h0: r.height, p: hit.p, y0: this.pickVertical(mx, my, hit.p) }; host.dragBegin('改面高'); return; }
    }
    if (hit && (hit.kind === 'listener' || hit.kind === 'source')) {
      host.select(hit.kind, hit.idx || 0, false);
      const pt = host.pointOf(hit.kind, hit.idx);
      if (!pt) return;
      this.drag = { kind: 'point', who: hit.kind, idx: hit.idx || 0, p0: this.pickPlane(mx, my, pt.y || 0), x0: pt.x, z0: pt.z, y: pt.y || 0, sx: mx, sy: my, moved: false };
      host.dragBegin(hit.kind === 'listener' ? '移动听者' : '移动声源'); return;
    }
    if (hit && hit.kind === 'body') {
      if (e.shiftKey || e.ctrlKey || e.metaKey) { host.select('reflector', hit.i, true); this.draw(); return; }
      if (!(host.sel.kind === 'reflector' && host.sel.ids.has(hit.i))) host.select('reflector', hit.i, false);
      if (tool === 'select') { this.draw(); return; }
      this._beginBodyDrag(mx, my, e); return;
    }
    // 空白：左键拖 = 框选（Shift 追加 / Ctrl 剔除）；没拖动 = 点空白清选择
    this.drag = { kind: 'box', mx, my, add: e.shiftKey, sub: e.ctrlKey || e.metaKey, moved: false }; this.box = null;
  }
  /** 拖反射面本体：按当前工具移动（贴地 XZ）/ 绕轴心旋转 / 以轴心缩放长度——gizmo 之外的"直接上手" */
  _beginBodyDrag(mx, my, e) {
    const host = this.host, def = host.doc.def, tool = host.tool;
    const ids = [...host.sel.ids].filter((i) => def.reflectors[i]);
    if (!ids.length) return;
    const b = Geo.bounds(ids.map((i) => def.reflectors[i]));
    const planeY = ids.length === 1 ? (def.reflectors[ids[0]].y || 0) : b.y0;
    const p0 = this.pickPlane(mx, my, planeY);
    const start = ids.map((i) => ({ i, a: def.reflectors[i].a.slice(), b: def.reflectors[i].b.slice(), y: def.reflectors[i].y || 0, h: def.reflectors[i].height }));
    const mode = tool === 'rotate' ? 'rotate' : tool === 'scale' ? 'scale' : 'move';
    this.drag = { kind: mode, ids, start, pivot: [b.cx, b.cz], planeY, p0, sx: mx, sy: my, moved: false };
    host.dragBegin(mode === 'rotate' ? '旋转' : mode === 'scale' ? '缩放' : '移动');
  }
  _move(e) {
    if (!this.ok) return;
    const [mx, my] = this._pos(e);
    const host = this.host, def = host.doc && host.doc.def;
    if (!this.drag) {
      const inside = mx >= 0 && my >= 0 && mx <= this.c.clientWidth && my <= this.c.clientHeight;
      if (!inside) { host.onCursorWorld(null); if (this.hover) { this.hover = null; this.draw(); } return; }
      host.onCursorWorld(this.pickGround(mx, my));
      const sg = this._hitSceneGizmo(mx, my);
      const hit = sg || !def ? null : this._hit(mx, my);
      const hv = sg ? { kind: 'scene', sg } : hit && hit.kind === 'gz' ? { kind: 'gz', part: hit.part } : hit && hit.kind === 'body' ? { kind: 'body', i: hit.i } : null;
      if (JSON.stringify(hv) !== JSON.stringify(this.hover)) { this.hover = hv; this.draw(); }
      const t = host.tool;
      let cur = 'default';
      if (sg) cur = 'pointer';
      else if (e.altKey || this.spaceDown) cur = 'grab';
      else if (t === 'addWall' || t === 'addPlane' || t === 'placeListener' || t === 'placeSource') cur = 'crosshair';
      else if (hit) cur = hit.kind === 'gz' ? (hit.part === 'ring' ? 'crosshair' : hit.part[0] === 's' ? 'nwse-resize' : 'move') : hit.kind === 'handle' ? (hit.hkind === 'height' ? 'ns-resize' : 'move') : t === 'select' ? 'pointer' : t === 'rotate' ? 'ew-resize' : 'move';
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
    if (d.kind === 'addWall') { const s = this.pickSurface(mx, my); if (s) d.b = s.p; this.draw(); return; }
    if (d.kind === 'addPlane') { const g = this.pickPlane(mx, my, d.a[1]); if (g) d.b = g; this.draw(); return; }
    if (!def) return;
    if (d.kind === 'point') {
      if (!d.moved && Math.hypot(mx - d.sx, my - d.sy) < 3) return;
      d.moved = true;
      host.dragTick(() => {
        if (e.altKey || !(host.cal && host.cal.hf)) { const p = this.pickPlane(mx, my, d.y); if (!p || !d.p0) return; host.setPoint(d.who, { x: d.x0 + (p[0] - d.p0[0]), y: d.y, z: d.z0 + (p[2] - d.p0[2]) }, d.idx); }
        else { const g = this.pickGround(mx, my); if (!g) return; host.setPoint(d.who, { x: g[0], y: g[1], z: g[2] }, d.idx); }
      });
      return;
    }
    if (d.kind === 'end') {
      host.dragTick(() => {
        const p = this.pickPlane(mx, my, d.y); if (!p || !d.p0) return;
        const r = def.reflectors[d.i]; if (!r) return;
        const dx = p[0] - d.p0[0], dz = p[2] - d.p0[2];
        if (d.end === 'a') r.a = [round3(d.a0[0] + dx), round3(d.a0[1] + dz)]; else r.b = [round3(d.b0[0] + dx), round3(d.b0[1] + dz)];
      });
      return;
    }
    if (d.kind === 'height') { const y = this.pickVertical(mx, my, d.p); if (y == null || d.y0 == null) return; host.dragTick(() => { const r = def.reflectors[d.i]; if (r) r.height = round3(Math.max(1, d.h0 + (y - d.y0))); }); return; }
    if (d.kind === 'move' || d.kind === 'rotate' || d.kind === 'scale') {
      const p = this.pickPlane(mx, my, d.planeY); if (!p || !d.p0) return;
      if (!d.moved && Math.hypot(mx - d.sx, my - d.sy) < 3) return;
      d.moved = true;
      const ctrl = e.ctrlKey || e.metaKey;
      host.dragTick(() => {
        for (const st of d.start) {
          const r = def.reflectors[st.i]; if (!r) continue;
          r.a = st.a.slice(); r.b = st.b.slice();
          if (d.kind === 'move') { const dx = p[0] - d.p0[0], dz = p[2] - d.p0[2]; Geo.translate(r, ctrl ? Math.round(dx / GZ.snapMove) * GZ.snapMove : dx, ctrl ? Math.round(dz / GZ.snapMove) * GZ.snapMove : dz, 0); }
          else if (d.kind === 'rotate') {
            const a0 = Math.atan2(d.p0[2] - d.pivot[1], d.p0[0] - d.pivot[0]), a1 = Math.atan2(p[2] - d.pivot[1], p[0] - d.pivot[0]);
            let da = a1 - a0; if (ctrl) { const s = GZ.snapRot * Math.PI / 180; da = Math.round(da / s) * s; }
            Geo.rotate(r, da, d.pivot);
          } else {
            const r0 = Math.hypot(d.p0[0] - d.pivot[0], d.p0[2] - d.pivot[1]) || 1, r1 = Math.hypot(p[0] - d.pivot[0], p[2] - d.pivot[1]);
            let k = clamp(r1 / r0, 0.05, 50); if (ctrl) k = Math.max(GZ.snapScale, Math.round(k / GZ.snapScale) * GZ.snapScale);
            Geo.scaleLength(r, k, d.pivot);
          }
          r.a = [round3(r.a[0]), round3(r.a[1])]; r.b = [round3(r.b[0]), round3(r.b[1])];
        }
      });
    }
  }
  _up(e) {
    if (!this.drag) return;
    const d = this.drag; this.drag = null; this.readout = null;
    const host = this.host, def = host.doc && host.doc.def;
    this.c.style.cursor = 'default';
    if (d.kind === 'look') { this.fly = null; this.keys.clear(); this.draw(); return; }
    if (d.kind === 'orbit' || d.kind === 'dolly' || d.kind === 'pan') { this.draw(); return; }
    if (d.kind === 'box') {
      const b = this.box; this.box = null;
      if (!d.moved || !b) { if (!d.add && !d.sub) host.clearSelection(); this.draw(); return; }
      if (def) {
        const inside = [];
        def.reflectors.forEach((r, i) => { const m = Geo.mid(r); const c = this.project([m[0], (r.y || 0) + (Geo.isHorizontal(r) ? 0 : r.height / 2), m[1]]); if (c && c[0] >= b.x0 && c[0] <= b.x1 && c[1] >= b.y0 && c[1] <= b.y1) inside.push(i); });
        if (d.sub) { for (const i of inside) if (host.sel.kind === 'reflector' && host.sel.ids.has(i)) host.select('reflector', i, true); }
        else if (inside.length) host.selectMany(inside, d.add);
        else if (!d.add) host.clearSelection();
      }
      this.draw(); return;
    }
    if (d.kind === 'addWall') {
      if (d.b && Math.hypot(d.b[0] - d.a[0], d.b[2] - d.a[2]) > 4) host.addWall(d.a, d.b); else host.status('拖出一段长度才是一面墙（按下后拖到另一点）');
      this.draw(); return;
    }
    if (d.kind === 'addPlane') {
      if (d.b && Math.hypot(d.b[0] - d.a[0], d.b[2] - d.a[2]) > 4) host.addPlane(d.a, d.b); else host.status('拖出一条边才是一片水平面');
      this.draw(); return;
    }
    host.dragEnd();
    if (d.kind === 'point' && !d.moved) host.select(d.who, d.idx || 0, false);
  }
  /** 键盘微移（世界 x / z，wu） */
  nudge(dx, dz) {
    const host = this.host, def = host.doc && host.doc.def; if (!def) return;
    if (host.sel.kind === 'reflector' && host.sel.ids.size) host.op('微移', () => { for (const i of host.sel.ids) { const r = def.reflectors[i]; if (r) Geo.translate(r, dx, dz, 0); } });
    else if (host.sel.kind === 'listener' || host.sel.kind === 'source') host.op('微移', () => { const p = host.pointOf(host.sel.kind, [...host.sel.ids][0]); if (p) { p.x += dx; p.z += dz; if (host.cal && host.cal.hf) p.y = round3(host.cal.groundHeight(p.x, p.z)); } });
  }
}

// ---------------------------------------------------------------- shaders
const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUV; uniform mat4 uMVP; out vec2 vUV;
void main(){ vUV = aUV; gl_Position = uMVP * vec4(aPos, 1.0); }`;
const MESH_FS = `#version 300 es
precision mediump float; in vec2 vUV; uniform sampler2D uTex; uniform float uDim; out vec4 o;
void main(){ o = vec4(texture(uTex, vUV).rgb * uDim, 1.0); }`;
const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos; uniform mat4 uMVP; uniform float uPointSize;
void main(){ gl_Position = uMVP * vec4(aPos, 1.0); gl_PointSize = uPointSize; }`;
const LINE_FS = `#version 300 es
precision mediump float; uniform vec4 uColor; out vec4 o; void main(){ o = uColor; }`;

if (typeof module !== 'undefined' && module.exports) module.exports = { View3D };
