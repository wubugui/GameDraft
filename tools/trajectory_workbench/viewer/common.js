'use strict';
/* 轨迹工作台 · 共用：API、几何换算（服务端 geometry.py 的 JS 镜像）、采样、透视缩放、
 * 样条（bake.py / bake3d.py 的镜像，只做本地即时预览）、抛体解析解（落点 / 最高点把手的正反解）、
 * 3D 射线工具。
 * 一切数学都与服务端同式：画面 ↔ work px ↔ q ↔ 世界。JS 侧只做**交互**（拾取、拖点、预览），
 * 真相（烘焙、投影落盘）永远在 Python 侧。
 * 本文件不依赖 DOM（末尾对 node 导出，`tests/test_viewer_math.py` 跑它）。 */

const API = {
  async json(path, opts) {
    const r = await fetch(path, Object.assign({ cache: 'no-store' }, opts || {}));
    let j;
    try { j = await r.json(); } catch (e) { throw new Error(`${path}: 非 JSON 响应 (${r.status})`); }
    if (!j.ok) throw new Error(j.err || `${path}: ${r.status}`);
    return j;
  },
  post(path, body) {
    return API.json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  },
  async bin(path) {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.arrayBuffer();
  },
  image(path) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('图片装不上: ' + path));
      img.src = path + (path.includes('?') ? '&' : '?') + 't=' + Date.now();
    });
  },
};

/** 场景标定（有深度的场景才有）。字段与 geometry.SceneGeometry.summary().cal 同名。 */
class SceneCal {
  constructor(cal, worldW, worldH) {
    this.rows = cal.R.flat();
    this.ppu = cal.ppuWork; this.cx = cal.cxWork; this.cy = cal.cyWork;
    this.work = cal.work;
    this.wuPerQ = cal.wuPerQUnit;
    this.cosTheta = cal.cosTheta;
    this.worldW = worldW; this.worldH = worldH;
    this.groundBounds = cal.groundBounds || null;
    this.ground = null;       // {w,h,data} 行走面深度（q）
    this.shell = null;        // {w,h,data} 深度壳深度（q）
    this.hf = null;           // {n, x0, z0, dx, dz, data} 世界 XZ 高度场
  }
  static _field(buf) {
    const dv = new DataView(buf);
    const w = dv.getUint32(0, true), h = dv.getUint32(4, true);
    return { w, h, data: new Float32Array(buf, 8, w * h) };
  }
  setGround(buf) { this.ground = SceneCal._field(buf); }
  setShell(buf) { this.shell = SceneCal._field(buf); }
  setHeightfield(buf) {
    const dv = new DataView(buf);
    const n = dv.getUint32(0, true);
    this.hf = {
      n, x0: dv.getFloat64(4, true), z0: dv.getFloat64(12, true), dx: dv.getFloat64(20, true), dz: dv.getFloat64(28, true),
      data: new Float32Array(buf, 36, n * n),
    };
  }
  sceneToWorkPx(sx, sy) { return [sx / Math.max(this.worldW, 1e-6) * this.work.w, sy / Math.max(this.worldH, 1e-6) * this.work.h]; }
  workPxToScene(px, py) { return [px / this.work.w * this.worldW, py / this.work.h * this.worldH]; }
  inScene(sx, sy) { return sx >= 0 && sy >= 0 && sx <= this.worldW && sy <= this.worldH; }
  static bilinear(data, w, h, px, py) {
    const xi = Math.min(Math.max(px, 0), w - 1.001), yi = Math.min(Math.max(py, 0), h - 1.001);
    const x0 = Math.floor(xi), y0 = Math.floor(yi), fx = xi - x0, fy = yi - y0;
    const i = y0 * w + x0;
    return data[i] * (1 - fx) * (1 - fy) + data[i + 1] * fx * (1 - fy) + data[i + w] * (1 - fx) * fy + data[i + w + 1] * fx * fy;
  }
  qToWorld(qx, qy, qz) {
    const r = this.rows, k = this.wuPerQ;
    return [(r[0] * qx + r[1] * qy + r[2] * qz) * k, (r[3] * qx + r[4] * qy + r[5] * qz) * k, (r[6] * qx + r[7] * qy + r[8] * qz) * k];
  }
  worldToQ(wx, wy, wz) {
    const r = this.rows, k = 1 / this.wuPerQ, x = wx * k, y = wy * k, z = wz * k;
    return [r[0] * x + r[3] * y + r[6] * z, r[1] * x + r[4] * y + r[7] * z, r[2] * x + r[5] * y + r[8] * z];
  }
  qToWorkPx(qx, qy) { return [this.cx + qx * this.ppu, this.cy - qy * this.ppu]; }
  workPxToQ(px, py, d) { return [(px - this.cx) / this.ppu, (this.cy - py) / this.ppu, d]; }
  groundDepthAt(sx, sy) { const [px, py] = this.sceneToWorkPx(sx, sy); return SceneCal.bilinear(this.ground.data, this.ground.w, this.ground.h, px, py); }
  shellDepthAt(sx, sy) { if (!this.shell) return null; const [px, py] = this.sceneToWorkPx(sx, sy); return SceneCal.bilinear(this.shell.data, this.shell.w, this.shell.h, px, py); }
  /** 画面点 → 脚下地面世界点（wu）。与 geometry.scene_to_world_ground 同式。 */
  sceneToWorldGround(sx, sy) {
    const [px, py] = this.sceneToWorkPx(sx, sy);
    const d = SceneCal.bilinear(this.ground.data, this.ground.w, this.ground.h, px, py);
    return this.qToWorld(...this.workPxToQ(px, py, d));
  }
  /** 画面点 → 深度壳（可见表面）上的世界点。没有壳数据时退回地面。 */
  sceneToWorldShell(sx, sy) {
    if (!this.shell) return this.sceneToWorldGround(sx, sy);
    const [px, py] = this.sceneToWorkPx(sx, sy);
    const d = SceneCal.bilinear(this.shell.data, this.shell.w, this.shell.h, px, py);
    return this.qToWorld(...this.workPxToQ(px, py, d));
  }
  /** 画面点是不是"立在地面上的东西"（壳比行走面近超过 `minWu`）。 */
  isObstacleAt(sx, sy, minWu) {
    if (!this.shell) return false;
    const [px, py] = this.sceneToWorkPx(sx, sy);
    const g = SceneCal.bilinear(this.ground.data, this.ground.w, this.ground.h, px, py);
    const s = SceneCal.bilinear(this.shell.data, this.shell.w, this.shell.h, px, py);
    return (g - s) * this.wuPerQ > (minWu == null ? 3 : minWu);
  }
  /** 作者面拾取：画面点 → {x,z,h} 控制点。
   *  `preferShell`：壳比地面近（有东西立着）就落到那个表面上（桌面 / 台阶 / 箱顶），否则落地面。
   *  h 上限保护：壳比地面高出太多（前景大物件 / 墙）也不去，只用地面（那不是能站的面）。 */
  pickSurface(sx, sy, preferShell, maxH) {
    const g = this.sceneToWorldGround(sx, sy);
    const out = { pos: g, x: g[0], z: g[2], h: 0, onShell: false };
    if (!preferShell || !this.shell) return out;
    const s = this.sceneToWorldShell(sx, sy);
    const gh = this.groundHeight(s[0], s[2]);
    const h = s[1] - gh;
    const lim = maxH == null ? 260 : maxH;
    if (h > 1.5 && h <= lim) return { pos: [s[0], gh + h, s[2]], x: s[0], z: s[2], h, onShell: true };
    return out;
  }
  worldToScene(wx, wy, wz) {
    const q = this.worldToQ(wx, wy, wz);
    return this.workPxToScene(...this.qToWorkPx(q[0], q[1]));
  }
  /** 画面点沿视线（q.z 轴）与水平面 y=wy 的交点（世界）。俯角为 0 时退回地面点。 */
  sceneToWorldAtHeight(sx, sy, wy) {
    const r = this.rows;
    if (Math.abs(r[5]) < 1e-6) return this.sceneToWorldGround(sx, sy);
    const [px, py] = this.sceneToWorkPx(sx, sy);
    const qx = (px - this.cx) / this.ppu, qy = (this.cy - py) / this.ppu;
    const qz = (wy / this.wuPerQ - r[3] * qx - r[4] * qy) / r[5];
    return this.qToWorld(qx, qy, qz);
  }
  groundHeight(wx, wz) {
    const hf = this.hf;
    if (!hf) return 0;
    return SceneCal.bilinear(hf.data, hf.n, hf.n, (wx - hf.x0) / hf.dx, (wz - hf.z0) / hf.dz);
  }
  /** 世界 XZ 是否落在行走面场覆盖范围内（越界时 groundHeight 只是边缘钳位，不可信）。 */
  inGroundBounds(wx, wz) {
    const b = this.groundBounds; if (!b) return true;
    return wx >= b[0] && wx <= b[1] && wz >= b[2] && wz <= b[3];
  }
  /** {x,z,h} → 世界 xyz */
  xzhToWorld(x, z, h) { return [x, this.groundHeight(x, z) + h, z]; }
  /** 世界 xyz → {x,z,h}（h 钳 ≥ 0，与 bake3d._world_to_xzh 同口径） */
  worldToXZH(wx, wy, wz) { return { x: wx, z: wz, h: Math.max(0, wy - this.groundHeight(wx, wz)) }; }
  /** {x,z,h} → 画面 */
  xzhToScene(x, z, h) { const w = this.xzhToWorld(x, z, h); return this.worldToScene(w[0], w[1], w[2]); }
  /** 相对 3D 位移 → 画面相对偏移（与运行时投影同式：只用 R）。 */
  projectOffset(dx, dy, dz) {
    const r = this.rows;
    return [r[0] * dx + r[3] * dy + r[6] * dz, -(r[1] * dx + r[4] * dy + r[7] * dz)];
  }
  /** 世界坐标里"画面右"与"画面上"的单位向量（R 的列）。 */
  screenRightWorld() { const r = this.rows; return [r[0], r[3], r[6]]; }
  screenUpWorld() { const r = this.rows; return [r[1], r[4], r[7]]; }
}

/** 预览采样（服务端 preview.screen：[atMs,x,y,sortY,rot,sx,sy,alpha,hard]）在 t 处线性插值。 */
function sampleScreen(samples, tMs) {
  if (!samples || samples.length === 0) return null;
  if (tMs <= samples[0][0]) return toPose(samples[0]);
  const last = samples[samples.length - 1];
  if (tMs >= last[0]) return toPose(last);
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid][0] <= tMs) lo = mid; else hi = mid; }
  const a = samples[lo], b = samples[hi];
  const span = b[0] - a[0];
  const f = span > 0 ? (tMs - a[0]) / span : 0;
  const o = [];
  for (let i = 0; i < 8; i++) o.push(a[i] + (b[i] - a[i]) * f);
  return toPose(o);
}
function toPose(s) { return { x: s[1], y: s[2], sortY: s[3], rot: s[4], sx: s[5], sy: s[6], alpha: s[7] }; }

function sampleWorld(samples, tMs) {
  if (!samples || samples.length === 0) return null;
  if (tMs <= samples[0][0]) return samples[0].slice(1);
  const last = samples[samples.length - 1];
  if (tMs >= last[0]) return last.slice(1);
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid][0] <= tMs) lo = mid; else hi = mid; }
  const a = samples[lo], b = samples[hi];
  const span = b[0] - a[0];
  const f = span > 0 ? (tMs - a[0]) / span : 0;
  return [1, 2, 3, 4].map((i) => a[i] + (b[i] - a[i]) * f);   // x,y,z,h
}

/** 场景透视缩放（src/utils/perspectiveScale.ts 的镜像）：脚点 → 系数。 */
function perspectiveScaleAt(cfg, fx, fy) {
  if (!cfg || !cfg.near || !cfg.far) return 1;
  const n = cfg.near, f = cfg.far;
  const ax = f.x - n.x, ay = f.y - n.y, lenSq = ax * ax + ay * ay;
  if (!(lenSq > 1e-6) || !(n.scale > 0) || !(f.scale > 0)) return 1;
  const stops = [{ pos: 0, scale: n.scale }];
  for (const m of cfg.midStops || []) if (m && m.pos > 0 && m.pos < 1 && m.scale > 0) stops.push({ pos: m.pos, scale: m.scale });
  stops.push({ pos: 1, scale: f.scale });
  stops.sort((a, b) => a.pos - b.pos);
  const raw = ((fx - n.x) * ax + (fy - n.y) * ay) / lenSq;
  const t = raw <= 0 ? 0 : raw >= 1 ? 1 : raw;
  if (t <= stops[0].pos) return Math.max(0.01, stops[0].scale);
  const last = stops[stops.length - 1];
  if (t >= last.pos) return Math.max(0.01, last.scale);
  for (let i = 1; i < stops.length; i++) {
    const lo = stops[i - 1], hi = stops[i];
    if (t <= hi.pos) {
      if (hi.pos === lo.pos) return Math.max(0.01, hi.scale);
      const k = (t - lo.pos) / (hi.pos - lo.pos);
      return Math.max(0.01, lo.scale + (hi.scale - lo.scale) * k);
    }
  }
  return Math.max(0.01, last.scale);
}

// ---------------------------------------------------------------- 样条（bake.py 镜像，只做本地预览）
/** 均匀 Catmull-Rom（tau=0.5），任意维数组。 */
function catmullRom(p0, p1, p2, p3, u) {
  const u2 = u * u, u3 = u2 * u, out = [];
  for (let i = 0; i < p1.length; i++) {
    const a = p0[i], b = p1[i], c = p2[i], d = p3[i];
    out.push(0.5 * ((2 * b) + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3));
  }
  return out;
}
/** 控制点（数组的数组）→ 密点折线。smooth 时端点重复当虚拟邻居，每段 16 份（与烘焙机同）。 */
function densePath(pts, smooth, perSpan) {
  const steps = perSpan || 16;
  const ctrl = [];
  for (const p of pts) { if (!ctrl.length || ctrl[ctrl.length - 1].some((v, i) => v !== p[i])) ctrl.push(p.slice()); }
  if (ctrl.length < 2) return ctrl;
  if (!smooth || ctrl.length < 3) return ctrl;
  const ext = [ctrl[0]].concat(ctrl, [ctrl[ctrl.length - 1]]);
  const out = [ctrl[0]];
  for (let i = 0; i < ctrl.length - 1; i++) {
    for (let j = 1; j <= steps; j++) out.push(catmullRom(ext[i], ext[i + 1], ext[i + 2], ext[i + 3], j / steps));
  }
  return out;
}
/** 世界空间手绘段的本地曲线（bake3d.py `_arc_lut3` + `_point_at3` 的**逐位镜像**，`tests/test_spline_parity.py` 钉住）：
 *  控制点 [{x,z,h}]（h 是存储的绝对离地高）。密点表在 (x, z, h) 三元组上做 Catmull-Rom / 折线（不去重、每段 16 份、
 *  控制点 i 在 i*16），弧长按三元组距离累计；取点时 x/z 来自密点，**h 按归一弧长在控制点之间线性插值**（不走样条）。
 *  返回 [{x,z,h,s01}]（调用方再 y = 地面(x,z) + h）。 */
function worldCurveSamples(pts, smooth) {
  const ctrl = pts.map((p) => [num(p.x, 0), num(p.z, 0), num(p.h, 0)]);
  if (ctrl.length < 2) return ctrl.map((c) => ({ x: c[0], z: c[1], h: c[2], s01: 0 }));
  const useSmooth = smooth && ctrl.length >= 3;
  const dense = [];
  const per = useSmooth ? 16 : 1;
  if (useSmooth) {
    const ext = [ctrl[0]].concat(ctrl, [ctrl[ctrl.length - 1]]);
    for (let i = 0; i < ctrl.length - 1; i++) for (let k = 0; k < 16; k++) dense.push(catmullRom(ext[i], ext[i + 1], ext[i + 2], ext[i + 3], k / 16));
    dense.push(ctrl[ctrl.length - 1]);
  } else for (const p of ctrl) dense.push(p);
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1], dense[i][2] - dense[i - 1][2]));
  const total = cum[cum.length - 1];
  const vIdx = []; for (let i = 0; i < ctrl.length; i++) vIdx.push(Math.min(dense.length - 1, i * per));
  const vs = vIdx.map((i) => (total > 0 ? cum[i] / total : 0));
  const vh = ctrl.map((c) => c[2]);
  const hAt = (s01) => {
    if (vh.length === 1 || s01 <= vs[0]) return vh[0];
    if (s01 >= vs[vs.length - 1]) return vh[vh.length - 1];
    let j = 0; while (j < vs.length - 2 && vs[j + 1] <= s01) j++;
    const span = vs[j + 1] - vs[j]; const f = span > 0 ? (s01 - vs[j]) / span : 0;
    return vh[j] + (vh[j + 1] - vh[j]) * f;
  };
  return dense.map((d, i) => { const s01 = total > 0 ? cum[i] / total : 0; return { x: d[0], z: d[1], h: Math.max(0, hAt(s01)), s01 }; });
}

// ---------------------------------------------------------------- 抛体解析（把手用；真相仍是服务端定步长积分）
/** 画面空间（y 向下、g>0 向下、地面是水平线 groundY）。返回 {t, landing:[x,y], apex:[x,y]|null, arc:[[x,y]...], grounded} */
function flight2D(start, v0, g, groundY, maxT) {
  const x0 = start[0], vx = num(v0.x, 0), vy = num(v0.y, 0);
  // 起点在地面线之下：烘焙机会先把它抬到地面线（bake.simulate_physics_nodes 的 y = min(y, groundY)），这里同式
  const lifted = start[1] > groundY;
  const y0 = lifted ? groundY : start[1];
  const T = maxT || 6;
  if (y0 >= groundY - 1e-9 && vy >= 0) return { t: 0, landing: [x0, groundY], apex: null, arc: [[x0, y0]], grounded: true, lifted };
  let t;
  if (g > 1e-9) {
    const disc = vy * vy - 2 * g * (y0 - groundY);
    t = disc >= 0 ? (-vy + Math.sqrt(disc)) / g : T;
  } else t = vy > 0 ? (groundY - y0) / vy : T;
  t = clamp(t, 0, T);
  const arc = [];
  const n = 40;
  for (let i = 0; i <= n; i++) { const s = t * i / n; arc.push([x0 + vx * s, y0 + vy * s + 0.5 * g * s * s]); }
  let apex = null;
  if (g > 1e-9 && vy < 0) { const ta = -vy / g; if (ta < t) apex = [x0 + vx * ta, y0 - vy * vy / (2 * g)]; }
  return { t, landing: [x0 + vx * t, y0 + vy * t + 0.5 * g * t * t], apex, arc, grounded: false, lifted };
}
/** 画面空间反解：落点 x 改到 lx（y 恒 = groundY），保持竖直初速（=保持最高点高度）。
 *  g ≤ 0 无解：原样返回 v0（调用方报状态）。任何非有限结果都不会返回。 */
function solveLanding2D(start, v0, g, groundY, lx) {
  const x0 = start[0], y0 = Math.min(start[1], groundY);   // 起点在地面线之下按抬到地面线算（与烘焙机同式）
  const cur = { x: num(v0.x, 0), y: num(v0.y, 0) };
  if (!(g > 1e-9)) return cur;
  let vy = cur.y;
  const flightT = (vyy) => { const disc = vyy * vyy - 2 * g * (y0 - groundY); return disc >= 0 ? (-vyy + Math.sqrt(disc)) / g : 0; };
  let t = flightT(vy);
  if (!(t > 1e-4)) {
    // 起点贴地又不往上抛 / 地面线在起点上方够不着：给一个够飞过去的最高点（水平距离的 1/4，再高过地面线 30）
    const H = Math.max(40, Math.abs(lx - x0) * 0.25, groundY < y0 ? y0 - groundY + 30 : 0);
    vy = -Math.sqrt(2 * g * H);
    t = flightT(vy);
  }
  if (!(t > 1e-4)) return cur;
  const out = { x: round2((lx - x0) / t), y: round2(vy) };
  return Number.isFinite(out.x) && Number.isFinite(out.y) ? out : cur;
}
/** 画面空间：把最高点改到 y=ay（保持落点 x）。 */
function solveApex2D(start, v0, g, groundY, ay) {
  const x0 = start[0], y0 = Math.min(start[1], groundY);
  const cur = { x: num(v0.x, 0), y: num(v0.y, 0) };
  if (!(g > 1e-9)) return cur;
  const f = flight2D(start, v0, g, groundY);
  const lx = f.landing[0];
  const H = Math.max(1, y0 - ay);
  const vy = -Math.sqrt(2 * g * H);
  const disc = vy * vy - 2 * g * (y0 - groundY);
  const t = (-vy + Math.sqrt(Math.max(0, disc))) / g;
  const out = { x: round2((lx - x0) / Math.max(t, 1e-4)), y: round2(vy) };
  return Number.isFinite(out.x) && Number.isFinite(out.y) ? out : cur;
}
/** 世界空间（y 向上、g>0 向下）。restY(x,z) = 地面(x,z) + 静止离地高。定步长扫描 + 二分找首次触地。 */
function flight3D(start, v0, g, restY, maxT) {
  const [x0, y0, z0] = start; const vx = num(v0.x, 0), vy = num(v0.y, 0), vz = num(v0.z, 0);
  const T = maxT || 6;
  const yAt = (t) => y0 + vy * t - 0.5 * g * t * t;
  const posAt = (t) => [x0 + vx * t, yAt(t), z0 + vz * t];
  const gap = (t) => { const p = posAt(t); return p[1] - restY(p[0], p[2]); };
  if (gap(0) <= 1e-6 && vy <= 0) return { t: 0, landing: [x0, restY(x0, z0), z0], apex: null, arc: [[x0, y0, z0]], grounded: true };
  const dt = 1 / 120;
  let t = 0, prev = gap(0), hit = -1;
  // 起点若在地下（手滑）也得先离开地面再算触地
  for (let s = dt; s <= T + 1e-9; s += dt) {
    const gp = gap(s);
    if (prev > 0 && gp <= 0) { hit = s; break; }
    prev = gp; t = s;
  }
  if (hit < 0) t = T;
  else {
    let lo = hit - dt, hi = hit;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (gap(mid) > 0) lo = mid; else hi = mid; }
    t = hi;
  }
  const arc = [];
  const n = 48;
  for (let i = 0; i <= n; i++) arc.push(posAt(t * i / n));
  let apex = null;
  if (g > 1e-9 && vy > 0) { const ta = vy / g; if (ta < t) apex = posAt(ta); }
  const L = posAt(t);
  return { t, landing: [L[0], restY(L[0], L[2]), L[2]], apex, arc, grounded: false };
}
/** 世界空间反解：落点改到地面 (lx, lz)，保持竖直初速；够不着时把最高点抬到落点之上再解。g ≤ 0 原样返回。 */
function solveLanding3D(start, v0, g, restY, lx, lz) {
  const [x0, y0, z0] = start;
  const cur = { x: num(v0.x, 0), y: num(v0.y, 0), z: num(v0.z, 0) };
  if (!(g > 1e-9)) return cur;
  const rY = restY(lx, lz);
  let vy = cur.y;
  const flightT = (vyy) => { const disc = vyy * vyy + 2 * g * (y0 - rY); return disc >= 0 ? (vyy + Math.sqrt(disc)) / g : 0; };
  let t = flightT(vy);
  if (!(t > 1e-4) || vy <= 0 && y0 - rY <= 1e-6) {
    const H = Math.max(30, Math.hypot(lx - x0, lz - z0) * 0.25, rY - y0 + 30);
    vy = Math.sqrt(2 * g * H);
    t = flightT(vy);
  }
  if (!(t > 1e-4)) return cur;
  const out = { x: round2((lx - x0) / t), y: round2(vy), z: round2((lz - z0) / t) };
  return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z) ? out : cur;
}
/** 世界空间：最高点改到世界 y=ay（保持落点）。 */
function solveApex3D(start, v0, g, restY, ay) {
  const [x0, y0, z0] = start;
  const cur = { x: num(v0.x, 0), y: num(v0.y, 0), z: num(v0.z, 0) };
  if (!(g > 1e-9)) return cur;
  const f = flight3D(start, v0, g, restY);
  const L = f.landing;
  const H = Math.max(1, ay - y0);
  const vy = Math.sqrt(2 * g * H);
  const rY = restY(L[0], L[2]);
  const disc = vy * vy + 2 * g * (y0 - rY);
  const t = Math.max(1e-4, (vy + Math.sqrt(Math.max(0, disc))) / g);
  const out = { x: round2((L[0] - x0) / t), y: round2(vy), z: round2((L[2] - z0) / t) };
  return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z) ? out : cur;
}

// ---------------------------------------------------------------- 4x4（列主序，与 gl 一致）
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
/** 正交投影（3D 视图的"正交"模式：顶视 / 侧视摆点用）。halfH = 画面半高对应的世界长度。 */
function ortho(halfH, aspect, near, far) {
  const r = halfH * aspect, t = halfH;
  return new Float32Array([1 / r, 0, 0, 0, 0, 1 / t, 0, 0, 0, 0, -2 / (far - near), 0, 0, 0, -(far + near) / (far - near), 1]);
}
/**
 * **左手系** lookAt。M-world 是 x 画面右、Y 上、**Z 进画**（q 翻过 Y 之后 z 仍是纵深，
 * `depthConfig.M.R` det=+1 保手性），也就是 DirectX / Unity 那种左手系。用 OpenGL 的
 * 右手 lookAt（x = up × z）画它，整张画面**左右镜像**、环绕 / 平移全反，而且**一处都不报错**：
 * 投影与拾取都经同一个 mvp 及其逆，所以自洽，只有拿原画对着看才发现（2026-09-08 制作人在
 * 声学工作台抓到，2026-09-10 在这里抓到第二次）。这里 x = z × up，基的 det = −1，
 * 正好把左手世界摆正到屏幕上。相机的 forward / right 见 view3d.js。
 */
function lookAt(eye, target, up) {
  const z = norm3([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = norm3(cross3(z, up)), y = cross3(x, z);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]), -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]), -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]), 1]);
}
function mul4(a, b) {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; }
  return o;
}
function inv4(m) {
  const a = Array.from(m), o = new Float64Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = a;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return o;
}
function xform4(m, v) {
  const x = v[0], y = v[1], z = v[2], w = v.length > 3 ? v[3] : 1;
  return [m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w, m[3] * x + m[7] * y + m[11] * z + m[15] * w];
}
/** 世界点 → 画布像素（[x,y,depthNdc] 或 null 在相机后面）。W/H 是画布 css 像素。 */
function projectPoint(mvp, p, W, H) {
  const c = xform4(mvp, p);
  if (c[3] <= 1e-9) return null;
  return [(c[0] / c[3] * 0.5 + 0.5) * W, (1 - (c[1] / c[3] * 0.5 + 0.5)) * H, c[2] / c[3]];
}
/** 画布像素 → 世界射线 {o, d}（单位方向）。 */
function unprojectRay(invMvp, mx, my, W, H) {
  const nx = mx / W * 2 - 1, ny = 1 - my / H * 2;
  const a = xform4(invMvp, [nx, ny, -1, 1]), b = xform4(invMvp, [nx, ny, 1, 1]);
  const o = [a[0] / a[3], a[1] / a[3], a[2] / a[3]], f = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
  return { o, d: norm3([f[0] - o[0], f[1] - o[1], f[2] - o[2]]) };
}
function rayPlane(ray, p0, n) {
  const dn = dot3(ray.d, n);
  if (Math.abs(dn) < 1e-9) return null;
  const t = dot3([p0[0] - ray.o[0], p0[1] - ray.o[1], p0[2] - ray.o[2]], n) / dn;
  if (t < 0) return null;
  return [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, ray.o[2] + ray.d[2] * t];
}
/** 射线与直线 p0 + a·t 的最近点参数 t（沿轴拖 gizmo 用：鼠标射线离轴最近处就是手指到的位置）。
 *  轴几乎与视线平行时（两线夹角 < ~0.6°）无解返回 null，调用方退回屏幕投影法。 */
function rayLineParam(ray, p0, a) {
  const w0 = [p0[0] - ray.o[0], p0[1] - ray.o[1], p0[2] - ray.o[2]];
  const A = dot3(a, a), B = dot3(a, ray.d), C = dot3(ray.d, ray.d), D = dot3(a, w0), E = dot3(ray.d, w0);
  const denom = A * C - B * B;
  if (denom <= 1e-4 * A * C) return null;
  return (B * E - C * D) / denom;
}
/** 四边形（屏幕多边形）内含判定，偶奇法。 */
function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
/** 射线 vs 高度场地面：沿射线步进找首次 y ≤ 地面，再二分。bounds=[x0,x1,z0,z1]。 */
function rayGround(ray, cal, maxDist) {
  const hf = cal.hf; if (!hf) return null;
  const b = cal.groundBounds || [hf.x0, hf.x0 + hf.dx * (hf.n - 1), hf.z0, hf.z0 + hf.dz * (hf.n - 1)];
  const gap = (t) => { const p = [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, ray.o[2] + ray.d[2] * t]; return p[1] - cal.groundHeight(p[0], p[2]); };
  const far = maxDist || 200000;
  const step = Math.max(2, far / 4000);
  let prev = gap(0), t = 0;
  for (let s = step; s <= far; s += step) {
    const g = gap(s);
    if (prev > 0 && g <= 0) {
      let lo = s - step, hi = s;
      for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (gap(mid) > 0) lo = mid; else hi = mid; }
      const p = [ray.o[0] + ray.d[0] * hi, 0, ray.o[2] + ray.d[2] * hi];
      p[1] = cal.groundHeight(p[0], p[2]);
      if (p[0] < b[0] || p[0] > b[1] || p[2] < b[2] || p[2] > b[3]) return null;
      return p;
    }
    prev = g; t = s;
  }
  return null;
}
/** 射线 vs 深度壳：换到 q 空间，壳是 z=D(px,py) 的高度图；沿像素步进找首次从壳前到壳后。 */
function rayShell(ray, cal, maxDist) {
  const sh = cal.shell; if (!sh) return null;
  const k = 1 / cal.wuPerQ;
  const o = cal.worldToQ(ray.o[0], ray.o[1], ray.o[2]);
  const e = cal.worldToQ(ray.o[0] + ray.d[0], ray.o[1] + ray.d[1], ray.o[2] + ray.d[2]);
  const d = [e[0] - o[0], e[1] - o[1], e[2] - o[2]];   // q 单位 / wu
  const far = (maxDist || 200000);
  const pxStep = 1 / cal.ppu;                            // 1 个 work 像素对应的 q 距离
  const lateral = Math.hypot(d[0], d[1]);
  const step = lateral > 1e-9 ? pxStep / lateral * 0.75 : far / 2000;   // wu
  const depthAt = (t) => {
    const q = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    const [px, py] = cal.qToWorkPx(q[0], q[1]);
    if (px < 0 || py < 0 || px > sh.w - 1 || py > sh.h - 1) return null;
    return q[2] - SceneCal.bilinear(sh.data, sh.w, sh.h, px, py);
  };
  let prev = null;
  for (let t = 0; t <= far; t += step) {
    const g = depthAt(t);
    if (g == null) { prev = null; continue; }            // 出画：继续走，射线可能再进画
    if (prev != null && prev < 0 && g >= 0) {
      let lo = t - step, hi = t;
      for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; const gm = depthAt(mid); if (gm == null || gm < 0) lo = mid; else hi = mid; }
      return [ray.o[0] + ray.d[0] * hi, ray.o[1] + ray.d[1] * hi, ray.o[2] + ray.d[2] * hi];
    }
    prev = g;
  }
  return null;
}
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm3(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

// ---------------------------------------------------------------- 小工具
function num(v, d) { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : d; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function round2(v) { return Math.round(v * 100) / 100; }
function fmt(v, n = 1) { return Number.isFinite(v) ? v.toFixed(n).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') : '—'; }
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
function el(id) { return document.getElementById(id); }
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = !!v;
    else if (k === 'disabled') e.disabled = !!v;
    else e.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
}
function distToSeg(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1]; const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0; t = clamp(t, 0, 1);
  return Math.hypot(px - (a[0] + dx * t), py - (a[1] + dy * t));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SceneCal, sampleScreen, sampleWorld, perspectiveScaleAt, catmullRom, densePath, worldCurveSamples,
    flight2D, solveLanding2D, solveApex2D, flight3D, solveLanding3D, solveApex3D,
    perspective, ortho, lookAt, mul4, inv4, xform4, projectPoint, unprojectRay, rayPlane, rayLineParam, pointInPoly, rayGround, rayShell,
    num, clamp, round2, fmt, deepClone, distToSeg };
}
