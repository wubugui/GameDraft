/* 光照体实验室 · 页面端到端回归(真 GPU 的 Chrome:`tools/workbench_rhi/chrome_page.mjs --selftest … --no-skip`)。
 *
 * 每条 `ok()` 一行 PASS / FAIL;异常记 EXC;跑完报告写进 window.__selftestResult。只在页内内存里动,不点导出、不写任何文件。
 *
 * L2 记**真工程数据的现状**:新管线烘出来的场景没有 floor_depth_A/B,载入照常、FX 照画(地面项是 NaN),烘焙当场抛错。
 * 其余用一张**合成场景**(900×500 原画 + 按一条已知地面直线编码的深度图 + 一块高出地面的「房顶」,带 floor_depth_A/B):
 * 画布与原画同尺寸 ⇒ 每个像素正好取在纹理中心,FX 的几道算式可以在 CPU 上逐像素复算,与 GPU 回读逐像素比
 * (关全部效果 / 高度雾 / 高度调试视图 / 体积光 / 积水倒影 / 平面积雪 / 雾模拟一步的速度场 / 脚印与积水笔刷 / 预览 quad)。
 * 这份 CPU 复算只在这里、只为验证(着色器仍只有 lightvolFx.wgsl 一份)。拿不到 WebGPU 时着色项记 SKIP 并写明原因。 */
(async () => {
  const log = [];
  const ok = (name, cond, extra) => log.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { try { if (fn()) return true; } catch (e) { /* 还没好 */ } await wait(40); } return false; };
  const $ = (id) => document.getElementById(id);
  const F = () => window.__FX, fxo = () => window.__FX && window.__FX.fx;
  const noGpu = () => !LV.host || !fxo();
  const step = async (name, fn) => {
    if (noGpu()) { log.push(`SKIP ${name} ${JSON.stringify({ why: LV.err || LV.errFx || 'no GPU layer' })}`); return; }
    try { const r = await fn(); ok(name, !!r.ok, r); } catch (e) { log.push(`EXC ${name} ${e && e.stack || e}`); }
  };
  const boxes = (on) => { for (const id of ['enHFog', 'enVFog', 'enGod', 'enPud', 'enSnow', 'enFoot']) $(id).checked = on.includes(id); };
  const setRange = (id, v) => { $(id).value = String(v); };
  const compose = () => { const p = F().compParams(); fxo().composite(p, LVL.S.cfg); return { p, px: fxo().readPixels() }; };
  const readRt = async (w) => fxo().readTarget(w);

  // ---------------------------------------------------------------- CPU 复算(照 lightvolFx.wgsl 逐句)
  const mix = (a, b, t) => a + (b - a) * t;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const q8 = (v) => Math.round(clamp(v, 0, 1) * 255);
  function makeRef(S) {
    const c = S.cfg, W = S.bgW, H = S.bgH;
    const samp = (px, w, h, u, v, out) => {
      const fx = u * w - 0.5, fy = v * h - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const cx = (a) => clamp(a, 0, w - 1), cy = (a) => clamp(a, 0, h - 1);
      const xa = cx(x0), xb = cx(x0 + 1), ya = cy(y0), yb = cy(y0 + 1);
      for (let k = 0; k < 4; k++) {
        const a = px[(ya * w + xa) * 4 + k], b = px[(ya * w + xb) * 4 + k], d = px[(yb * w + xa) * 4 + k], e = px[(yb * w + xb) * 4 + k];
        out[k] = ((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty) / 255;
      }
      return out;
    };
    const tmp = [0, 0, 0, 0];
    const dDepth = (u, v) => { samp(S._depthRGBA, S.dW, S.dH, u, v, tmp); const raw = (tmp[0] * 255 * 256 + tmp[1] * 255) / 65535; return (c.invert > 0.5 ? 1 - raw : raw) * c.scale + c.offset; };
    const bg = (u, v) => { samp(S.bgData, W, H, u, v, tmp); return [tmp[0], tmp[1], tmp[2]]; };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const at = (px, py, d) => [0, 1, 2].map((k) => c.right[k] * px + c.up[k] * py + c.vd[k] * d);
    /** 一个画布像素(x, 自上而下 y)的合成色;wet = 湿度图该像素的字节 */
    function comp(p, x, y, wetByte) {
      const cw = W, ch = H;
      const vUv = [(x + 0.5) / cw, 1 - (y + 0.5) / ch], iuv = [vUv[0], 1 - vUv[1]];
      let col = bg(iuv[0], iuv[1]);
      const sd = dDepth(iuv[0], iuv[1]);
      const sy = iuv[1] * c.H * c.wtpY, sx = iuv[0] * c.W * c.wtpX;
      const px = (sx - c.cx) / c.ppu, py = (c.cy - sy) / c.ppu;
      const P = at(px, py, sd), height = P[1];
      const fl = c.floorA * sy + c.floorB;
      const floorY = at(px, py, fl)[1];
      if (p.dbg > 1.5) { const hh = height - floorY; return [clamp(hh * 0.5 + 0.5, 0, 1), clamp(hh, 0, 1), clamp(-hh, 0, 1)]; }
      const wet = p.enPud > 0.5 ? clamp((wetByte || 0) / 255 * p.pudAmt, 0, 1) : 0;
      if (wet > 0.004) {
        const bgH = c.H * c.wtpY, k = 2 * c.up[1] * c.ppu, rstep = clamp(p.ssrDist, 1, 6);
        let sySrc = sy, refl = p.skyCol.slice();
        for (let s = 1; s <= 256; s++) {
          if (s > p.ssrSteps) break;
          sySrc -= rstep; if (sySrc < 0) break;
          const vSrc = sySrc / bgH, dS = dDepth(iuv[0], vSrc), pyS = (c.cy - sySrc) / c.ppu;
          const h = c.up[1] * pyS + c.vd[1] * dS - floorY;
          if (h <= p.reflMinH) continue;
          if (sySrc + k * h >= sy) { refl = bg(iuv[0], vSrc); break; }   // 涟漪 = 0 ⇒ 横向摇曳 = 0
        }
        const fres = mix(0.5, 1, Math.pow(1 + c.vd[1], 3)), reflW = clamp(p.pudRefl * fres, 0, 1);
        col = col.map((v, i) => mix(v, mix(v * 0.7, refl[i] * 1.06, reflW), wet));
      }
      const prof = Math.exp(-Math.max(height - floorY, 0) * p.fogH), df = clamp(sd * 0.25, 0, 4);
      let fog = 0;
      if (p.enHFog > 0.5) fog += p.fogD * prof;
      fog = clamp(fog * (0.4 + 0.6 * df), 0, 1);
      let shaft = 0;
      if (p.enGod > 0.5 && fog > 0.005) {
        const bias = 0.05 * Math.abs(c.scale) + 1e-3, stp = p.shadowDist / p.shadowSteps, Q = at(px, py, sd);
        for (let k = 1; k <= 96; k++) {
          if (k > p.shadowSteps) break;
          for (let j = 0; j < 3; j++) Q[j] += p.lightW[j] * stp;
          const u = (dot(Q, c.right) * c.ppu + c.cx) / (c.W * c.wtpX), v = (c.cy - dot(Q, c.up) * c.ppu) / (c.H * c.wtpY);
          if (u < 0 || u > 1 || v < 0 || v > 1) break;
          if (dot(Q, c.vd) > dDepth(u, v) + bias) break;
          shaft += Math.exp(-Math.max(Q[1] - floorY, 0) * p.fogH);
        }
        shaft *= 0.05 * fog;
      }
      col = col.map((v, i) => mix(v, p.fogCol[i], fog) + p.fogCol[i] * shaft * p.godInt);
      const dm = Math.hypot(vUv[0] - p.charShow[0], vUv[1] - p.charShow[1]), mk = 0.9 * (1 - smooth(0.007, 0.014, dm));
      const Y = [1, 0.85, 0.2];
      return col.map((v, i) => mix(v, Y[i], mk));
    }
    return { comp, dDepth, bg, W, H };
  }
  /** GPU 画布 vs CPU 复算:像素集合 pts,容差 tol;返回失配数 / 最大差 / 第一个失配 */
  function cmp(px, ref, p, pts, tol, wet) {
    let bad = 0, maxd = 0, first = null;
    for (const [x, y] of pts) {
      const want = ref.comp(p, x, y, wet ? wet[(y * px.width + x) * 4] : 0).map(q8);
      const i = (y * px.width + x) * 4, got = [px.data[i], px.data[i + 1], px.data[i + 2]];
      const d = Math.max(...got.map((v, k) => Math.abs(v - want[k])));
      maxd = Math.max(maxd, d);
      if (d > tol) { bad++; if (!first) first = { x, y, got, want }; }
    }
    return { n: pts.length, bad, maxd, first };
  }
  const grid = (W, H, step, off = 0) => { const a = []; for (let y = off; y < H; y += step) for (let x = off; x < W; x += step) a.push([x, y]); return a; };

  try {
    // ---------------------------------------------------------------- L1 启动
    await until(() => window.__ready === true && window.__lvReady === true, 120000);
    const scripts = [...document.scripts].map((s) => s.textContent).join('\n');
    ok('L1 boot: page ready, the render bundle is the RHI access layer (canvas host + lightvolFx), no WebGL / GLSL in the page',
      !!window.__ready && !!window.__FX && !/getContext\(\s*['"]webgl|#version\s+300\s+es|gl_FragColor|createShader\(/.test(scripts)
      && (noGpu() || (!!LV.rt.lightvolFx && !!LV.rt.workbenchRhi && LV.host.renderer.name === 'webgpu')),
      { err: LV.err || LV.errFx || '' });
    if (F().playing) $('fxPlay').click();          // 冻结动画时钟:之后 time 不动、雾不自己走

    // ---------------------------------------------------------------- L2 真工程数据的现状
    {
      const has = await fetch('/public/assets/scenes/test_room_b.json', { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
      if (!has) log.push('SKIP L2 real data (test_room_b not in this checkout)');
      else {
        const loaded = await LVL.loadByScene('/public', 'test_room_b');
        await until(() => noGpu() || F().ready, 30000);
        const c = LVL.S.cfg;
        let err = '';
        try { await LVL.bake(); } catch (e) { err = String(e && e.message || e); }
        const drawn = noGpu() ? null : (() => { const r = compose(); let n = 0; for (let i = 0; i < r.px.data.length; i += 4) if (r.px.data[i] + r.px.data[i + 1] + r.px.data[i + 2] > 6) n++; return n / (r.px.data.length / 4); })();
        ok('L2 real data (new-pipeline scene): loads, has no floor_depth_A/B, bake refuses with the floor message, FX still draws (floor terms NaN)',
          loaded && c.floorA === undefined && c.floorB === undefined && /floor_depth_A\/B/.test(err) && !LVL.S.vol && (drawn === null || drawn > 0.9),
          { loaded, floorA: c.floorA, err: err.slice(0, 60), drawn });
        baking = false; $('bBake').disabled = false;     // 抛错把烘焙锁留在了 true(数据管线原样,不修)
      }
    }

    // ---------------------------------------------------------------- L3 合成场景
    const SW = 900, SH = 500, FA = -1 / 300, FB = 250 / 300, ROOF = [300, 180, 560, 330], LIFT = 0.35;
    {
      const mk = (fill) => { const cv = document.createElement('canvas'); cv.width = SW; cv.height = SH; const x = cv.getContext('2d'); const im = x.createImageData(SW, SH); fill(im.data); x.putImageData(im, 0, 0); return cv.toDataURL('image/png'); };
      const bgURL = mk((d) => { for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) { const i = (y * SW + x) * 4; d[i] = (x * 13 + y * 7) & 255; d[i + 1] = (x * 5 + y * 11) & 255; d[i + 2] = (x ^ y) & 255; d[i + 3] = 255; } });
      const depthURL = mk((d) => {
        for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
          const i = (y * SW + x) * 4, sy = y + 0.5;
          let dep = FA * sy + FB;
          if (x >= ROOF[0] && x < ROOF[2] && y >= ROOF[1] && y < ROOF[3]) dep -= LIFT;
          const raw = clamp(Math.round((dep + 1) / 2 * 65535), 0, 65535);
          d[i] = raw >> 8; d[i + 1] = raw & 255; d[i + 2] = 0; d[i + 3] = 255;
        }
      });
      const scene = { id: 'lv_selftest', worldWidth: 1000, worldHeight: SH / 0.9,
        depthConfig: { depth_map: 'synthetic', depth_mapping: { invert: false, scale: 2, offset: -1 },
          shader: { floor_depth_A: FA, floor_depth_B: FB }, M: { ppu: 400, cx: 450, cy: 250, R: [[1, 0, 0], [0, 0.8, -0.6], [0, 0.6, 0.8]] } } };
      const [bgI, dI] = await Promise.all([loadImg(bgURL), loadImg(depthURL)]);
      LVL.S.sceneId = 'lv_selftest';
      await finalizeLoad(bgI, dI, scene);
      await until(() => noGpu() || F().ready, 30000);
      const cv = $('fx');
      ok('L3 synthetic scene (with floor_depth_A/B) loads; FX canvas = background size (every pixel samples a texel centre)',
        LVL.S.cfg.floorA === FA && LVL.S.bgW === SW && (noGpu() || (F().ready && cv.width === SW && cv.height === SH)), { w: cv.width, h: cv.height });
    }
    const ref = makeRef(LVL.S);
    window.__reflMinH = 0.1;          // 合成房顶只高出地面 0.21:把倒影阈值放低,让它进倒影
    setRange('pRefl', 0);             // 涟漪 0:倒影不横向摇曳(取样全落在纹理中心,CPU 能逐像素复算)
    setRange('pSsrD', 2);
    F().setChar(0.8, 0.85);

    // ---------------------------------------------------------------- L4..L9 合成(CPU 逐像素复算)
    await step('L4 all effects off: the canvas is the background + the character dot, pixel for pixel', () => {
      boxes([]); const r = compose(); const res = cmp(r.px, ref, r.p, grid(SW, SH, 1), 1);
      return { ok: res.bad === 0, ...res };
    });
    await step('L5 height fog: every pixel = CPU fog formula (depth decode, reconstruction, floor profile) within 1', () => {
      boxes(['enHFog']); const r = compose(); const res = cmp(r.px, ref, r.p, grid(SW, SH, 1), 1);
      return { ok: res.bad === 0, ...res };
    });
    await step('L6 height debug view (dbg 2): relative height to the fitted floor, pixel for pixel', () => {
      boxes([]); F().dbg(2); const r = compose(); F().dbg(0);
      const res = cmp(r.px, ref, r.p, grid(SW, SH, 1), 1);
      const i = (255 * SW + 400) * 4, roof = [r.px.data[i], r.px.data[i + 1], r.px.data[i + 2]];
      return { ok: res.bad === 0 && roof[1] > 40, roof, ...res };
    });
    await step('L7 god rays: light march with depth shadowing matches the CPU march (>= 98% of sampled pixels within 2)', () => {
      boxes(['enHFog', 'enGod']); const r = compose(); const res = cmp(r.px, ref, r.p, grid(SW, SH, 5, 2), 2);
      boxes(['enHFog']); const r0 = compose();
      let diff = 0; for (let i = 0; i < r.px.data.length; i += 4) if (r.px.data[i] !== r0.px.data[i]) diff++;
      return { ok: res.bad <= res.n * 0.02 && diff > 1000, changed: diff, ...res };
    });
    await step('L8 wet brush / footprints: additive paint, reverse-subtract erase and stamp land in the right texels with the gaussian value (within 2)', async () => {
      F().clearWet(); F().clearFoot();
      const C = [0.3, 0.55], R = 0.04, g = (x, y, cx, cy, r, s) => s * Math.exp(-(((x + 0.5) / SW - cx) ** 2 + ((1 - (y + 0.5) / SH) - cy) ** 2) / (r * r));
      setRange('pBrush', R);
      F().paintAt(C[0], C[1], false); F().paintAt(C[0], C[1], false);
      const a = await readRt('wet');
      F().paintAt(C[0], C[1], true);
      const b = await readRt('wet');
      F().setChar(0.7, 0.4); F().stamp();
      const f = await readRt('foot');
      let bad = 0, maxd = 0, first = null;
      for (let y = 0; y < SH; y += 2) for (let x = 0; x < SW; x += 2) {
        const i = (y * SW + x) * 4, v = g(x, y, C[0], C[1], R, 0.5), v1 = Math.round(v * 255), v2 = Math.min(255, Math.round(v1 + v * 255)), v3 = Math.max(0, Math.round(v2 - v * 255));
        const vf = Math.round(g(x, y, 0.7, 0.4, 0.012, 0.7) * 255);
        const d = Math.max(Math.abs(a.data[i] - v2), Math.abs(b.data[i] - v3), Math.abs(f.data[i] - vf));
        // 两次加 / 一次减各量化一回(D3D 的 float→unorm 允许 0.6 ULP 误差,落在 .5 附近的尾巴可能差到 2)
        maxd = Math.max(maxd, d); if (d > 2) { bad++; if (!first) first = { x, y, wet2: a.data[i], want: v2, erased: b.data[i], want3: v3, foot: f.data[i], wantF: vf }; }
      }
      const cx = Math.round(C[0] * SW), cy = Math.round((1 - C[1]) * SH), peak = a.data[(cy * SW + cx) * 4];
      return { ok: bad === 0 && peak > 240, bad, maxd, peak, first };
    });
    await step('L9 puddle mirror: the column scan finds the roof above the water and reflects it (CPU scan, every wet pixel within 2)', async () => {
      F().clearWet();
      setRange('pBrush', 0.08);
      for (const [x, y] of [[0.45, 0.3], [0.52, 0.28], [0.6, 0.3], [0.45, 0.22], [0.55, 0.2]]) F().paintAt(x, y, false);
      const wet = (await readRt('wet')).data;
      boxes(['enPud']); const r = compose();
      const pts = []; for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x += 3) if (wet[(y * SW + x) * 4] * r.p.pudAmt / 255 > 0.004) pts.push([x, y]);
      const res = cmp(r.px, ref, r.p, pts, 2, wet);
      // 倒影里真的有房顶(不是全映天):房顶下方水面取到的源行在房顶里
      const x = 430, y = 360, want = ref.comp(r.p, x, y, wet[(y * SW + x) * 4]).map(q8);
      return { ok: pts.length > 5000 && res.bad === 0, wetPixels: pts.length, sample: want, ...res };
    });
    await step('L10 snow on flat ground / roof: cover = amount (normals from screen derivatives), away from the depth edges', () => {
      boxes(['enSnow']); const r = compose(); const p = r.p;
      let bad = 0, n = 0, first = null;
      for (let y = 4; y < SH - 4; y += 3) for (let x = 4; x < SW - 4; x += 3) {
        const nearEdge = (Math.abs(x - ROOF[0]) < 4 || Math.abs(x - ROOF[2]) < 4) && y > ROOF[1] - 4 && y < ROOF[3] + 4
          || (Math.abs(y - ROOF[1]) < 4 || Math.abs(y - ROOF[3]) < 4) && x > ROOF[0] - 4 && x < ROOF[2] + 4;
        if (nearEdge) continue;
        n++;
        const base = ref.comp({ ...p, enSnow: 0 }, x, y, 0);
        const want = base.map((v, i) => mix(v, p.snowCol[i], p.snowAmt));
        const dm = Math.hypot((x + 0.5) / SW - p.charShow[0], 1 - (y + 0.5) / SH - p.charShow[1]);
        if (dm < 0.02) continue;
        const i = (y * SW + x) * 4, got = [r.px.data[i], r.px.data[i + 1], r.px.data[i + 2]], w = want.map(q8);
        if (Math.max(...got.map((v, k) => Math.abs(v - w[k]))) > 1) { bad++; if (!first) first = { x, y, got, want: w }; }
      }
      return { ok: bad === 0 && n > 10000, n, bad, first };
    });
    await step('L11 fog sim one step from rest: the character wake (velocity field) matches the CPU value in every texel; the roof grows no fog', async () => {
      await F().initFromScene();                        // 渲染目标重建并清成速度中性
      const [w, h] = fxo().simSize, before = await readRt('fog'), c0 = before.data[0], c1 = before.data[1];
      const sim = { time: 0, dt: 0.016, flow: 1.2, dissip: 0.985, src: 1.4, carveR: 0.1, vort: 0.8, charUv: [0.3, 0.6], charVel: [0.5, 0] };
      fxo().simStep(sim, LVL.S.cfg);
      const a = await readRt('fog');
      let bad = 0, maxd = 0, first = null, roofFog = 0, groundFog = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w, v = 1 - (y + 0.5) / h, d0 = c0 / 255 * 2 - 1, d1 = c1 / 255 * 2 - 1;
        const dc = Math.hypot(u - 0.3, v - 0.6), ker = Math.exp(-dc * dc / Math.max(0.01, 1e-4));
        const dx = d0 * 0.9 + 0.5 * ker, dy = d1 * 0.9 + 0.5 * ker * (0.5 + 0.8);   // 速度 (0.5, 0):顺向推 x、垂直分量卷进 y
        const i = (y * w + x) * 4, want = [q8(dx * 0.5 + 0.5), q8(dy * 0.5 + 0.5)];
        const d = Math.max(Math.abs(a.data[i] - want[0]), Math.abs(a.data[i + 1] - want[1]));
        maxd = Math.max(maxd, d); if (d > 1) { bad++; if (!first) first = { x, y, got: [a.data[i], a.data[i + 1]], want }; }
        const bx = u * SW, by = (1 - v) * SH;
        if (bx > ROOF[0] + 8 && bx < ROOF[2] - 8 && by > ROOF[1] + 8 && by < ROOF[3] - 8) roofFog = Math.max(roofFog, a.data[i + 2]);
        else groundFog = Math.max(groundFog, a.data[i + 2]);
      }
      return { ok: bad === 0 && roofFog === 0 && groundFog > 50 && fxo().cur === 1, rest: [c0, c1], bad, maxd, roofFog, groundFog, first };
    });
    await step('L12 pointer: dragging on the FX canvas in paint mode wets the texel under the pointer (event → uv → brush)', async () => {
      F().clearWet(); $('pMode').value = 'paint'; setRange('pBrush', 0.03);
      const cv = $('fx'), rc = cv.getBoundingClientRect(), X = 0.62, Y = 0.35;
      const ev = (type) => new PointerEvent(type, { clientX: rc.left + X * rc.width, clientY: rc.top + Y * rc.height, bubbles: true });
      cv.dispatchEvent(ev('pointerdown')); window.dispatchEvent(ev('pointerup'));
      $('pMode').value = 'char';
      const wet = (await readRt('wet')).data, at = (x, y) => wet[(Math.round(y * SH) * SW + Math.round(x * SW)) * 4];
      return { ok: at(X, Y) > 120 && at(0.2, 0.8) === 0, under: at(X, Y), far: at(0.2, 0.8) };
    });

    // ---------------------------------------------------------------- L13 预览 quad(游戏渲染器)
    await step('L13 preview: after baking, the flat quad is the grey swatch and the tinted quad is the CPU white balance of the volume sample', async () => {
      await LVL.bake();
      const S = LVL.S, c = S.cfg;
      S.foot = { gx: c.W * 0.5, gy: c.H * 0.72 };
      $('mode').value = 'tint'; render();
      const qw = +$('qw').value, qh = +$('qh').value, hqm = +$('hqm').value, tone = +$('tone').value;
      const fsx = S.foot.gx * c.wtpX * bgScale, fsy = S.foot.gy * c.wtpY * bgScale;
      const flatX = Math.round(fsx - qw - 6) + qw / 2, tintX = Math.round(fsx + 6) + qw / 2, py = Math.round(fsy - qh) + Math.floor(qh / 2);
      const flat = LV.host.readPixel(flatX, py), tint = LV.host.readPixel(tintX, py);
      const v = (py - Math.round(fsy - qh)) / (qh - 1), hq = (1 - v) * hqm, amb = LVL.sampleVolume(S.foot.gx, S.foot.gy, hq);
      const l = Math.max(0.2126 * amb[0] + 0.7152 * amb[1] + 0.0722 * amb[2], 0.04);
      const want = [0, 1, 2].map((k) => Math.round(Math.min(255, 0.62 * (1 - tone + clamp(amb[k] / l, 0.5, 1.7) * tone) * 255)));
      const flatOk = flat.slice(0, 3).every((x) => Math.abs(x - 158) <= 1);
      const tintOk = tint.slice(0, 3).every((x, k) => Math.abs(x - want[k]) <= 2);
      return { ok: flatOk && tintOk && !LV.host.lastError, flat, tint, want };
    });
  } catch (e) {
    log.push('EXC ' + (e && e.stack || e));
  }
  window.__reflMinH = null;
  const pass = log.filter((l) => l.startsWith('PASS')).length;
  const fail = log.filter((l) => l.startsWith('FAIL') || l.startsWith('EXC')).length;
  const skip = log.filter((l) => l.startsWith('SKIP')).length;
  log.push(`[selftest] ${pass} passed, ${fail} failed, ${skip} skipped`);
  window.__selftestResult = log.join('\n');
})();
