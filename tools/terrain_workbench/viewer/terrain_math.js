'use strict';
/* 地形工作台 · 纯数学（不碰 DOM；末尾对 node 导出，`tests/test_terrain_workbench.py` 拿它与 Python 合成器对账）。
 *
 * 这是 `tools/character_lighting_lab/terrain_compose.py` 的 JS 镜像，**只为页面即时反馈**：
 * 真相（存盘 / 推给游戏 / 导出）永远在 Python 侧。自检 S2 把页面的合成结果与 `/api/compose` 逐格对比。
 *
 * 单位：一律**网格单位**（= 运行时 `isCollision` 里没乘 wu/q 的 M-world；与 `collision.json` 的 x_min / cell_size 同单位）。
 * 页面显示 wu = 网格单位 × `SceneCal.wuPerQ`。格子判定与运行时同式：gx = floor((x − x_min) / cell)；
 * 格心 = x_min + (i + 0.5)·cell；多边形按**格心在不在多边形内**栅格化（与 Python `points_in_polygon` 同一条射线法）。 */

class Grid {
  constructor(d) {
    this.x_min = +d.x_min; this.z_min = +d.z_min; this.cell = +d.cell_size;
    this.w = d.grid_width | 0; this.h = d.grid_height | 0;
  }
  get n() { return this.w * this.h; }
  toDict() { return { x_min: this.x_min, z_min: this.z_min, cell_size: this.cell, grid_width: this.w, grid_height: this.h }; }
  cellOf(x, z) { return [Math.floor((x - this.x_min) / this.cell), Math.floor((z - this.z_min) / this.cell)]; }
  inside(gx, gz) { return gx >= 0 && gx < this.w && gz >= 0 && gz < this.h; }
  /** 格心（与 Python `centers()` 逐位同式：x_min + (i + 0.5) * cell） */
  centerX(gx) { return this.x_min + (gx + 0.5) * this.cell; }
  centerZ(gz) { return this.z_min + (gz + 0.5) * this.cell; }
  same(o) {
    return !!o && Math.abs(this.x_min - o.x_min) < 1e-9 && Math.abs(this.z_min - o.z_min) < 1e-9
      && Math.abs(this.cell - o.cell) < 1e-12 && this.w === o.w && this.h === o.h;
  }
  idx(gx, gz) { return gz * this.w + gx; }
}

/** 射线法（与 Python `points_in_polygon` 同一条式子：(zi > z) != (zj > z) 且 x < xcross） */
function pointInPolygon(x, z, pts) {
  if (!pts || pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
    if ((zi > z) !== (zj > z)) {
      const xcross = (xj - xi) * (z - zi) / (zj - zi) + xi;
      if (x < xcross) inside = !inside;
    }
  }
  return inside;
}

/** 多边形 → 格心掩码（Uint8Array，1 = 格心在内）。只扫多边形包围盒里的格子。 */
function rasterizePolygon(pts, grid, out) {
  const m = out || new Uint8Array(grid.n);
  if (!pts || pts.length < 3) return m;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1]; }
  const [ga, gb] = grid.cellOf(x0, z0), [gc, gd] = grid.cellOf(x1, z1);
  const ia = Math.max(0, ga - 1), ib = Math.min(grid.w - 1, gc + 1), ja = Math.max(0, gb - 1), jb = Math.min(grid.h - 1, gd + 1);
  for (let j = ja; j <= jb; j++) {
    const cz = grid.centerZ(j);
    for (let i = ia; i <= ib; i++) if (pointInPolygon(grid.centerX(i), cz, pts)) m[j * grid.w + i] = 1;
  }
  return m;
}

/** 合成来源位（与 Python SRC_* 同值） */
const SRC = { AUTO_WALK: 0, AUTO_BLOCK: 1, BRUSH_WALK: 2, BRUSH_BLOCK: 3, REGION_WALK: 4, REGION_BLOCK: 5, OUTSIDE: 6 };
const SRC_NAME = ['自动·可走', '自动·阻挡', '笔刷·可走', '笔刷·阻挡', '多边形·可走', '多边形·阻挡', '自动网格外（按可走）'];
const BRUSH = { AUTO: 0, WALK: 1, BLOCK: 2 };

/**
 * 碰撞合成（Python `compose_collision` 的镜像）：
 *   可走 = (auto可走 ∪ 笔刷可走 ∪ 多边形可走) − (笔刷阻挡 ∪ 多边形阻挡)；阻挡压过可走，与顺序无关。
 * @param grid Grid（doc.grid）
 * @param auto {grid: Grid, data: Uint8Array(1 = 阻挡)} | null —— 烘焙器的自动结果（按目标格心最近邻重采样，网格外 = 没数据 = 可走）
 * @param brush Uint8Array | null（0 自动 / 1 可走 / 2 阻挡，与 grid 同网格）
 * @param regions [{kind:'walk'|'block', points:[[x,z],…]}]
 * @returns {blocked: Uint8Array(1 = 阻挡), src: Uint8Array}
 */
function composeCollision(grid, auto, brush, regions) {
  const n = grid.n;
  const blocked = new Uint8Array(n), src = new Uint8Array(n);
  const walk = new Uint8Array(n);
  if (!auto) {
    src.fill(SRC.OUTSIDE); walk.fill(1);
  } else {
    const ag = auto.grid, ad = auto.data;
    for (let j = 0; j < grid.h; j++) {
      const cz = grid.centerZ(j);
      for (let i = 0; i < grid.w; i++) {
        const k = j * grid.w + i;
        const [gx, gz] = ag.cellOf(grid.centerX(i), cz);
        if (!ag.inside(gx, gz)) { src[k] = SRC.OUTSIDE; walk[k] = 1; continue; }
        const b = ad[gz * ag.w + gx] ? 1 : 0;
        src[k] = b ? SRC.AUTO_BLOCK : SRC.AUTO_WALK; walk[k] = b ? 0 : 1;
      }
    }
  }
  const rw = new Uint8Array(n), rb = new Uint8Array(n);
  for (const r of regions || []) rasterizePolygon(r.points, grid, r.kind === 'walk' ? rw : rb);
  for (let k = 0; k < n; k++) {
    const bw = brush ? brush[k] === BRUSH.WALK : false, bb = brush ? brush[k] === BRUSH.BLOCK : false;
    const w = (walk[k] || bw || rw[k]) && !(bb || rb[k]);
    blocked[k] = w ? 0 : 1;
    if (bw) src[k] = SRC.BRUSH_WALK;
    if (rw[k]) src[k] = SRC.REGION_WALK;
    if (bb) src[k] = SRC.BRUSH_BLOCK;
    if (rb[k]) src[k] = SRC.REGION_BLOCK;
  }
  return { blocked, src };
}

/**
 * 连通性：从若干种子格 flood-fill 可走格（4 邻域）。种子落在阻挡格时从最近的可走格起算（螺旋外扩，最多 60 格）。
 * @returns Uint8Array(1 = 从某个种子走得到)
 */
function floodReach(blocked, grid, seeds) {
  const n = grid.n, seen = new Uint8Array(n);
  const q = new Int32Array(n);
  for (const s of seeds) {
    let [gx, gz] = grid.cellOf(s[0], s[1]);
    if (!grid.inside(gx, gz) || blocked[grid.idx(gx, gz)]) {
      const near = nearestWalkableCell(blocked, grid, gx, gz, 60);
      if (!near) continue;
      gx = near[0]; gz = near[1];
    }
    let head = 0, tail = 0;
    const k0 = grid.idx(gx, gz);
    if (seen[k0]) continue;
    seen[k0] = 1; q[tail++] = k0;
    while (head < tail) {
      const k = q[head++];
      const i = k % grid.w, j = (k / grid.w) | 0;
      if (i > 0) { const t = k - 1; if (!seen[t] && !blocked[t]) { seen[t] = 1; q[tail++] = t; } }
      if (i < grid.w - 1) { const t = k + 1; if (!seen[t] && !blocked[t]) { seen[t] = 1; q[tail++] = t; } }
      if (j > 0) { const t = k - grid.w; if (!seen[t] && !blocked[t]) { seen[t] = 1; q[tail++] = t; } }
      if (j < grid.h - 1) { const t = k + grid.w; if (!seen[t] && !blocked[t]) { seen[t] = 1; q[tail++] = t; } }
    }
  }
  return seen;
}

function nearestWalkableCell(blocked, grid, gx, gz, maxR) {
  for (let r = 1; r <= maxR; r++) {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const x = gx + dx, z = gz + dz;
      if (grid.inside(x, z) && !blocked[grid.idx(x, z)]) return [x, z];
    }
  }
  return null;
}

/** 圆形笔刷：格心落在圆内的格子写 value（网格单位；radius ≥ 半格保证至少点到一格） */
function stampCircle(arr, grid, cx, cz, radius, value, cb) {
  const r = Math.max(radius, grid.cell * 0.5);
  const [ga, gb] = grid.cellOf(cx - r, cz - r), [gc, gd] = grid.cellOf(cx + r, cz + r);
  let n = 0;
  for (let j = Math.max(0, gb); j <= Math.min(grid.h - 1, gd); j++) {
    const dz = grid.centerZ(j) - cz;
    for (let i = Math.max(0, ga); i <= Math.min(grid.w - 1, gc); i++) {
      const dx = grid.centerX(i) - cx;
      if (dx * dx + dz * dz > r * r) continue;
      const k = j * grid.w + i;
      if (cb) cb(k, Math.sqrt(dx * dx + dz * dz) / r); else if (arr[k] !== value) { arr[k] = value; n++; }
    }
  }
  return n;
}

/**
 * 高度雕刻（写高度增量栅格，网格单位）：
 *   raise / lower：中心最强、边缘归零的钟形；smooth：向邻域均值靠；flatten：向 target（Δ 目标）靠。
 * `strength` 是这一笔中心处的增量（网格单位）。
 */
function sculptHeight(height, grid, cx, cz, radius, mode, strength, target) {
  const changed = [];
  stampCircle(null, grid, cx, cz, radius, 0, (k, t) => {
    const w = (1 - t * t) * (1 - t * t);     // 钟形（t = 归一距离）
    const i = k % grid.w, j = (k / grid.w) | 0;
    let v = height[k];
    if (mode === 'raise') v += strength * w;
    else if (mode === 'lower') v -= strength * w;
    else if (mode === 'smooth') {
      let s = 0, c = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const x = i + di, z = j + dj; if (!grid.inside(x, z)) continue; s += height[grid.idx(x, z)]; c++;
      }
      v += (s / Math.max(c, 1) - v) * Math.min(1, w * 0.6);
    } else if (mode === 'flatten') v += ((target || 0) - v) * Math.min(1, w);
    if (v !== height[k]) { height[k] = v; changed.push(k); }
  });
  return changed;
}

function polygonEdgeDistance(x, z, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const abx = b[0] - a[0], abz = b[1] - a[1], l2 = abx * abx + abz * abz;
    let t = l2 < 1e-12 ? 0 : ((x - a[0]) * abx + (z - a[1]) * abz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (a[0] + t * abx), dz = z - (a[1] + t * abz);
    const d2 = dx * dx + dz * dz; if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/** 高度增量 Δ（网格单位）在一点的值：栅格双线性 + 多边形操作（flatten 要基底高度 baseY(x, z)，网格单位） */
function heightDeltaAt(x, z, height, grid, ops, baseY) {
  let d = 0;
  if (height) {
    const px = (x - grid.x_min) / grid.cell - 0.5, pz = (z - grid.z_min) / grid.cell - 0.5;
    if (px > -0.5 && px < grid.w - 0.5 && pz > -0.5 && pz < grid.h - 0.5) {
      const xi = Math.min(Math.max(px, 0), grid.w - 1.001), zi = Math.min(Math.max(pz, 0), grid.h - 1.001);
      const x0 = Math.floor(xi), z0 = Math.floor(zi), fx = xi - x0, fz = zi - z0, i = z0 * grid.w + x0;
      d = height[i] * (1 - fx) * (1 - fz) + height[i + 1] * fx * (1 - fz) + height[i + grid.w] * (1 - fx) * fz + height[i + grid.w + 1] * fx * fz;
    }
  }
  for (const op of ops || []) {
    if (!pointInPolygon(x, z, op.points)) continue;
    const f = +op.feather || 0;
    const w = f > 0 ? Math.min(1, polygonEdgeDistance(x, z, op.points) / f) : 1;
    if (op.kind === 'flatten') d += ((+op.value) - ((baseY ? baseY(x, z) : 0) + d)) * w;
    else d += (+op.value) * w;
  }
  return d;
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a) / 2;
}
function polygonCentroid(pts) {
  let x = 0, z = 0; for (const p of pts) { x += p[0]; z += p[1]; }
  return [x / Math.max(pts.length, 1), z / Math.max(pts.length, 1)];
}

// ---------------------------------------------------------------- base64（与服务端 numpy tobytes 同布局：行优先、小端）
function b64ToU8(s) { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
function u8ToB64(a) { let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); }
function b64ToF32(s) { const u = b64ToU8(s); return new Float32Array(u.buffer, u.byteOffset, u.length >> 2); }
function f32ToB64(f) { return u8ToB64(new Uint8Array(f.buffer, f.byteOffset, f.byteLength)); }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Grid, pointInPolygon, rasterizePolygon, composeCollision, floodReach, nearestWalkableCell, stampCircle,
    sculptHeight, polygonEdgeDistance, heightDeltaAt, polygonArea, polygonCentroid, SRC, SRC_NAME, BRUSH };
}
