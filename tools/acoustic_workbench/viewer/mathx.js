'use strict';
/* 声学工作台 · 数学与场景标定（不依赖 DOM；末尾对 node 导出给 tests/math.test.cjs）。
 *
 * SceneCal 与轨迹工作台 `common.js` 的 SceneCal 同一份数学（画面 ↔ work px ↔ q ↔ 世界），
 * 只保留 3D 拾取要用的那部分：地面高度场、深度壳、q ↔ 世界。声学本身的数学（抽头 / IR）
 * **不在这里**——那是运行时 `src/audio/acousticSpace.ts` 打成的包，工作台 import 同一份。 */

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
    this.ground = null; this.shell = null; this.hf = null;
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
    this.hf = { n, x0: dv.getFloat64(4, true), z0: dv.getFloat64(12, true), dx: dv.getFloat64(20, true), dz: dv.getFloat64(28, true), data: new Float32Array(buf, 36, n * n) };
  }
  sceneToWorkPx(sx, sy) { return [sx / Math.max(this.worldW, 1e-6) * this.work.w, sy / Math.max(this.worldH, 1e-6) * this.work.h]; }
  workPxToScene(px, py) { return [px / this.work.w * this.worldW, py / this.work.h * this.worldH]; }
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
  /** 画面点 → 脚下地面世界点（wu）。与 geometry.scene_to_world_ground 同式。 */
  sceneToWorldGround(sx, sy) {
    const [px, py] = this.sceneToWorkPx(sx, sy);
    const d = SceneCal.bilinear(this.ground.data, this.ground.w, this.ground.h, px, py);
    return this.qToWorld(...this.workPxToQ(px, py, d));
  }
  worldToScene(wx, wy, wz) { const q = this.worldToQ(wx, wy, wz); return this.workPxToScene(...this.qToWorkPx(q[0], q[1])); }
  groundHeight(wx, wz) {
    const hf = this.hf; if (!hf) return 0;
    return SceneCal.bilinear(hf.data, hf.n, hf.n, (wx - hf.x0) / hf.dx, (wz - hf.z0) / hf.dz);
  }
  inGroundBounds(wx, wz) { const b = this.groundBounds; if (!b) return true; return wx >= b[0] && wx <= b[1] && wz >= b[2] && wz <= b[3]; }
  /** 世界坐标里"画面右"与"画面上"的单位向量（R 的列）。 */
  screenRightWorld() { const r = this.rows; return [r[0], r[3], r[6]]; }
  screenUpWorld() { const r = this.rows; return [r[1], r[4], r[7]]; }
  /** 视线方向（世界）：q 的 +z 轴。 */
  viewDirWorld() { const r = this.rows; return [r[2], r[5], r[8]]; }
}

// ---------------------------------------------------------------- 4x4（列主序，与 gl 一致）
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
/** 正交投影（3D 视图的"正交"模式：顶视 / 侧视摆面用；与轨迹工作台 common.js 同一份）。halfH = 画面半高对应的世界长度。 */
function ortho(halfH, aspect, near, far) {
  const r = halfH * aspect, t = halfH;
  return new Float32Array([1 / r, 0, 0, 0, 0, 1 / t, 0, 0, 0, 0, -2 / (far - near), 0, 0, 0, -(far + near) / (far - near), 1]);
}
/**
 * **左手系** lookAt。M-world 是 x 右、Y 上、**Z 进画**（q 翻过 Y 之后 z 仍是纵深，R det=+1 保手性），
 * 也就是 DirectX / Unity 那种左手系。用 OpenGL 的右手 lookAt（x = up × z）画它，整张画面左右镜像、
 * 转头 / 平移 / 飞行全反（2026-09-08 制作人抓到）。这里 x = z × up，基的 det = −1，正好把左手世界摆正到屏幕上。
 * 投影与拾取都经同一个 mvp 及其逆，所以只改这一处；相机的 forward / right 见 view3d.js。
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
/** 世界点 → 画布像素（[x,y,depthNdc] 或 null 在相机后面）。 */
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
/** 射线 vs 高度场地面：沿射线步进找首次 y ≤ 地面，再二分。 */
function rayGround(ray, cal, maxDist) {
  const hf = cal.hf; if (!hf) return null;
  const b = cal.groundBounds || [hf.x0, hf.x0 + hf.dx * (hf.n - 1), hf.z0, hf.z0 + hf.dz * (hf.n - 1)];
  const gap = (t) => { const p = [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, ray.o[2] + ray.d[2] * t]; return p[1] - cal.groundHeight(p[0], p[2]); };
  const far = maxDist || 200000;
  const step = Math.max(2, far / 4000);
  let prev = gap(0);
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
    prev = g;
  }
  return null;
}
/** 射线 vs 深度壳：换到 q 空间，壳是 z=D(px,py) 的高度图；沿像素步进找首次从壳前到壳后。 */
function rayShell(ray, cal, maxDist) {
  const sh = cal.shell; if (!sh) return null;
  const o = cal.worldToQ(ray.o[0], ray.o[1], ray.o[2]);
  const e = cal.worldToQ(ray.o[0] + ray.d[0], ray.o[1] + ray.d[1], ray.o[2] + ray.d[2]);
  const d = [e[0] - o[0], e[1] - o[1], e[2] - o[2]];
  const far = (maxDist || 200000);
  const pxStep = 1 / cal.ppu;
  const lateral = Math.hypot(d[0], d[1]);
  const step = lateral > 1e-9 ? pxStep / lateral * 0.75 : far / 2000;
  const depthAt = (t) => {
    const q = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    const [px, py] = cal.qToWorkPx(q[0], q[1]);
    if (px < 0 || py < 0 || px > sh.w - 1 || py > sh.h - 1) return null;
    return q[2] - SceneCal.bilinear(sh.data, sh.w, sh.h, px, py);
  };
  let prev = null;
  for (let t = 0; t <= far; t += step) {
    const g = depthAt(t);
    if (g == null) { prev = null; continue; }
    if (prev != null && prev < 0 && g >= 0) {
      let lo = t - step, hi = t;
      for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; const gm = depthAt(mid); if (gm == null || gm < 0) lo = mid; else hi = mid; }
      return [ray.o[0] + ray.d[0] * hi, ray.o[1] + ray.d[1] * hi, ray.o[2] + ray.d[2] * hi];
    }
    prev = g;
  }
  return null;
}
/** 射线到线段 ab 的最近距离（世界）与参数 —— 3D 里点选一面墙的底边 / 顶边用。 */
function raySegmentDistance(ray, a, b) {
  const u = ray.d, v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w0 = [ray.o[0] - a[0], ray.o[1] - a[1], ray.o[2] - a[2]];
  const aa = dot3(u, u), bb = dot3(u, v), cc = dot3(v, v), dd = dot3(u, w0), ee = dot3(v, w0);
  const den = aa * cc - bb * bb;
  let s, t;
  if (den < 1e-9) { s = 0; t = clamp(ee / Math.max(cc, 1e-9), 0, 1); }
  else { s = (bb * ee - cc * dd) / den; t = clamp((aa * ee - bb * dd) / den, 0, 1); s = Math.max(0, s); }
  const p = [ray.o[0] + u[0] * s, ray.o[1] + u[1] * s, ray.o[2] + u[2] * s];
  const q = [a[0] + v[0] * t, a[1] + v[1] * t, a[2] + v[2] * t];
  return { dist: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]), t, s, p: q };
}
/** 射线 vs 四边形（两三角）；返回 t 或 null。 */
function rayQuad(ray, p0, p1, p2, p3) {
  const t1 = rayTri(ray, p0, p1, p2), t2 = rayTri(ray, p0, p2, p3);
  if (t1 == null) return t2; if (t2 == null) return t1; return Math.min(t1, t2);
}
function rayTri(ray, a, b, c) {
  const e1 = sub3(b, a), e2 = sub3(c, a), p = cross3(ray.d, e2), det = dot3(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det, s = sub3(ray.o, a), u = dot3(s, p) * inv;
  if (u < 0 || u > 1) return null;
  const q = cross3(s, e1), v = dot3(ray.d, q) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = dot3(e2, q) * inv;
  return t > 0 ? t : null;
}
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function norm3(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

// ---------------------------------------------------------------- 几何编辑（纯函数，node 测试钉住）
const Geo = {
  /** 反射面中点（XZ） */
  mid(r) { return [(r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2]; },
  len(r) { return Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]); },
  /** 平面朝向角（弧度，atan2(dz, dx)） */
  angle(r) { return Math.atan2(r.b[1] - r.a[1], r.b[0] - r.a[0]); },
  isHorizontal(r) { return (r.tiltDeg || 0) >= 45; },
  /** 竖直墙的四角（世界）：底边 a→b 在 y，顶边在 y+height */
  wallQuad(r) {
    const y0 = r.y || 0, y1 = y0 + r.height;
    return [[r.a[0], y0, r.a[1]], [r.b[0], y0, r.b[1]], [r.b[0], y1, r.b[1]], [r.a[0], y1, r.a[1]]];
  },
  /** 水平面的四角（世界）：a→b 是长边，`height` 当作宽，居中向两侧展开，在高度 y */
  planeQuad(r) {
    const y = r.y || 0, dx = r.b[0] - r.a[0], dz = r.b[1] - r.a[1], l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l * r.height / 2, nz = dx / l * r.height / 2;
    return [[r.a[0] - nx, y, r.a[1] - nz], [r.b[0] - nx, y, r.b[1] - nz], [r.b[0] + nx, y, r.b[1] + nz], [r.a[0] + nx, y, r.a[1] + nz]];
  },
  quad(r) { return Geo.isHorizontal(r) ? Geo.planeQuad(r) : Geo.wallQuad(r); },
  /** 平移（XZ 与 y） */
  translate(r, dx, dz, dy) {
    r.a = [r.a[0] + dx, r.a[1] + dz]; r.b = [r.b[0] + dx, r.b[1] + dz];
    if (dy) r.y = (r.y || 0) + dy;
    return r;
  },
  /** 绕中点（或给定枢轴）在 XZ 里旋转 */
  rotate(r, rad, pivot) {
    const p = pivot || Geo.mid(r), c = Math.cos(rad), s = Math.sin(rad);
    const rot = (q) => [p[0] + (q[0] - p[0]) * c - (q[1] - p[1]) * s, p[1] + (q[0] - p[0]) * s + (q[1] - p[1]) * c];
    r.a = rot(r.a); r.b = rot(r.b);
    return r;
  },
  /** 以中点（或枢轴）为中心缩放长度；k>0 */
  scaleLength(r, k, pivot) {
    const p = pivot || Geo.mid(r);
    r.a = [p[0] + (r.a[0] - p[0]) * k, p[1] + (r.a[1] - p[1]) * k];
    r.b = [p[0] + (r.b[0] - p[0]) * k, p[1] + (r.b[1] - p[1]) * k];
    return r;
  },
  /** 让反射面的"正面"朝向听者：竖直墙是双面的，没有朝向；这里只是把 a→b 摆成从听者看去左→右，便于读 */
  orientToward(r, L) {
    const m = Geo.mid(r), dx = r.b[0] - r.a[0], dz = r.b[1] - r.a[1];
    const toL = [L.x - m[0], L.z - m[1]];
    if (dx * toL[1] - dz * toL[0] < 0) { const t = r.a; r.a = r.b; r.b = t; }
    return r;
  },
  /** 选择集包围盒（世界 XZ + y 范围） */
  bounds(rs) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const r of rs) for (const q of Geo.quad(r)) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
    return rs.length ? { x0, x1, z0, z1, y0, y1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, cy: (y0 + y1) / 2 } : null;
  },
};

// ---------------------------------------------------------------- 小工具
function num(v, d) { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : d; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function round3(v) { return Math.round(v * 1000) / 1000; }
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
  module.exports = { SceneCal, Geo, perspective, ortho, lookAt, mul4, inv4, xform4, projectPoint, unprojectRay, rayPlane, rayLineParam, pointInPoly, rayGround, rayShell,
    raySegmentDistance, rayQuad, cross3, dot3, sub3, norm3, num, clamp, round3, fmt, deepClone, distToSeg };
}
