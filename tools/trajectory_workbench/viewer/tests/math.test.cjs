'use strict';
/* 前端纯逻辑的 node 测试（无 DOM）：common.js 的样条 / 抛体正反解 / 射线，edit.js 的文档操作与
 * 规范化，history.js 的撤销重做。三个文件在同一个 vm 上下文里按浏览器的顺序装载。
 * 跑法：node tools/trajectory_workbench/viewer/tests/math.test.cjs（pytest 的 test_viewer.py 会代跑）。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const dir = path.join(__dirname, '..');
// class / const 在 vm 脚本顶层不会挂到上下文对象上，各文件末尾的 module.exports 才是取用口；
// 三个文件共享同一上下文（edit.js 直接用 common.js 的全局函数）。
const ctx = { console, module: { exports: {} }, window: undefined, document: undefined };
vm.createContext(ctx);
const ex = {};
for (const f of ['common.js', 'history.js', 'edit.js']) {
  ctx.module = { exports: {} };
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  Object.assign(ex, ctx.module.exports);
}
const { SceneCal, densePath, worldCurveSamples, flight2D, solveLanding2D, solveApex2D, flight3D, solveLanding3D, solveApex3D, inv4, xform4, projectPoint, unprojectRay, rayPlane, rayGround, rayShell, perspective, lookAt, mul4, History, Edit } = ex;
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

const eqJ = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);   // vm 上下文的 Array 原型不同，deepStrictEqual 会误判
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps == null ? 1e-6 : eps), `${msg || ''} expected ${b} got ${a}`);
let passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; } }

// ---------------------------------------------------------------- 样条
test('densePath: 折线原样 / 平滑 16 份每段 / 端点不动 / 去连续重复', () => {
  eqJ(densePath([[0, 0], [10, 0]], true), [[0, 0], [10, 0]]);
  const d = densePath([[0, 0], [10, 0], [10, 10]], true);
  assert.strictEqual(d.length, 1 + 2 * 16);
  eqJ(d[0], [0, 0]); eqJ(d[d.length - 1], [10, 10]);
  assert.strictEqual(densePath([[0, 0], [0, 0], [5, 5]], false).length, 2);
});

// ---------------------------------------------------------------- 抛体（画面）
test('flight2D: 解析落点 / 最高点', () => {
  const f = flight2D([0, 0], { x: 100, y: -200 }, 1000, 0);
  near(f.t, 0.4, 1e-9, 't'); near(f.landing[0], 40, 1e-9, 'lx'); near(f.landing[1], 0, 1e-9, 'ly'); near(f.apex[1], -20, 1e-9, 'apex y');
  assert.strictEqual(flight2D([0, 0], { x: 100, y: 0 }, 1000, 0).grounded, true);
  const g = flight2D([0, 0], { x: 100, y: -200 }, 1000, 60);   // 地面在起点下方 60
  near(g.landing[1], 60, 1e-9);
});
test('solveLanding2D: 保竖直初速改落点；贴地起点自动给弧高', () => {
  const v = solveLanding2D([0, 0], { x: 100, y: -200 }, 1000, 0, 80);
  near(v.x, 200, 1e-6); near(v.y, -200, 1e-6);
  const w = solveLanding2D([0, 0], { x: 0, y: 0 }, 1000, 0, 100);
  assert.ok(w.y < 0 && w.x > 0);
  const f = flight2D([0, 0], w, 1000, 0); near(f.landing[0], 100, 0.05, '贴地起点解出来的落点');
});
test('solveApex2D: 改弧高保落点', () => {
  const v = solveApex2D([0, 0], { x: 100, y: -200 }, 1000, 0, -45);
  near(v.y, -300, 1e-6); const f = flight2D([0, 0], v, 1000, 0); near(f.landing[0], 40, 0.05); near(f.apex[1], -45, 1e-6);
});

// ---------------------------------------------------------------- 抛体（世界，平地）
const flat = () => 0;
test('flight3D 平地：与解析一致', () => {
  const f = flight3D([0, 0, 0], { x: 100, y: 200, z: 50 }, 1000, flat);
  near(f.t, 0.4, 1e-6); near(f.landing[0], 40, 1e-3); near(f.landing[2], 20, 1e-3); near(f.apex[1], 20, 1e-6);
  assert.strictEqual(flight3D([0, 0, 0], { x: 1, y: 0, z: 0 }, 1000, flat).grounded, true);
});
test('flight3D 地形：落在高台上', () => {
  const step = (x, z) => (x > 20 ? 10 : 0);
  const f = flight3D([0, 0, 0], { x: 100, y: 200, z: 0 }, 1000, step);
  assert.ok(f.t < 0.4 && f.t > 0.2); near(f.landing[1], 10, 1e-6);
});
test('solveLanding3D / solveApex3D', () => {
  const v = solveLanding3D([0, 0, 0], { x: 100, y: 200, z: 50 }, 1000, flat, 80, 40);
  near(v.x, 200, 1e-6); near(v.z, 100, 1e-6); near(v.y, 200, 1e-6);
  const hi = solveLanding3D([0, 0, 0], { x: 100, y: 200, z: 50 }, 1000, (x, z) => 100, 80, 40);   // 落点比最高点还高：抬 vy
  assert.ok(hi.y > 200);
  const f = flight3D([0, 0, 0], hi, 1000, () => 100); near(f.landing[0], 80, 0.5); near(f.landing[2], 40, 0.5);
  const a = solveApex3D([0, 0, 0], { x: 100, y: 200, z: 50 }, 1000, flat, 45);
  near(a.y, 300, 1e-6); const g = flight3D([0, 0, 0], a, 1000, flat); near(g.landing[0], 40, 0.05); near(g.landing[2], 20, 0.05);
});

// ---------------------------------------------------------------- 矩阵 / 射线
test('inv4 / project / unproject 自洽', () => {
  const eye = [100, 200, -300], view = lookAt(eye, [0, 0, 0], [0, 1, 0]), proj = perspective(0.8, 1.5, 1, 5000);
  const mvp = mul4(proj, view), inv = inv4(mvp);
  const p = [10, 20, 30]; const c = projectPoint(mvp, p, 800, 600);
  const r = unprojectRay(inv, c[0], c[1], 800, 600);
  // 射线过 p：p − o 与 d 平行
  const v = [p[0] - r.o[0], p[1] - r.o[1], p[2] - r.o[2]]; const L = Math.hypot(...v);
  near(v[0] / L, r.d[0], 1e-4); near(v[1] / L, r.d[1], 1e-4); near(v[2] / L, r.d[2], 1e-4);
  const q = rayPlane({ o: [0, 10, 0], d: [0, -1, 0] }, [0, 0, 0], [0, 1, 0]); eqJ(q, [0, 0, 0]);
});

/** 假标定：R = 绕 x 轴俯角 θ（det=+1），ppu=1，work 100×100，wuPerQ=1；行走面深度常数 10；地面高度场平的 0。 */
function fakeCal(theta, groundY) {
  const c = Math.cos(theta), s = Math.sin(theta);
  const R = [[1, 0, 0], [0, c, -s], [0, s, c]];
  const cal = new SceneCal({ R, ppuWork: 1, cxWork: 50, cyWork: 50, work: { w: 100, h: 100 }, wuPerQUnit: 1, cosTheta: c, groundBounds: [-1e4, 1e4, -1e4, 1e4] }, 100, 100);
  const ground = new ArrayBuffer(8 + 100 * 100 * 4); const dv = new DataView(ground); dv.setUint32(0, 100, true); dv.setUint32(4, 100, true);
  const gd = new Float32Array(ground, 8);
  // 行走面：让每个像素的地面世界 y == groundY —— 反解深度 d：world.y = (r3 qx + r4 qy + r5 d)  → d = (groundY − c·qy)/(−s)
  for (let py = 0; py < 100; py++) for (let px = 0; px < 100; px++) { const qy = (50 - py) / 1; gd[py * 100 + px] = Math.abs(s) > 1e-9 ? ((groundY || 0) - c * qy) / (-s) : 10; }
  cal.setGround(ground);
  const hf = new ArrayBuffer(36 + 2 * 2 * 4); const hv = new DataView(hf); hv.setUint32(0, 2, true); hv.setFloat64(4, -1e4, true); hv.setFloat64(12, -1e4, true); hv.setFloat64(20, 2e4, true); hv.setFloat64(28, 2e4, true);
  const hd = new Float32Array(hf, 36); hd.fill(groundY || 0);
  cal.setHeightfield(hf);
  return cal;
}
test('SceneCal：画面→地面→画面 往返；sceneToWorldAtHeight 落在给定高度', () => {
  const cal = fakeCal(Math.PI / 4, 0);
  const g = cal.sceneToWorldGround(60, 70); near(g[1], 0, 1e-6, '地面 y');
  const s = cal.worldToScene(g[0], g[1], g[2]); near(s[0], 60, 1e-6); near(s[1], 70, 1e-6);
  const p = cal.sceneToWorldAtHeight(60, 70, 25); near(p[1], 25, 1e-6); const s2 = cal.worldToScene(p[0], p[1], p[2]); near(s2[0], 60, 1e-6); near(s2[1], 70, 1e-6);
  const xzh = cal.worldToXZH(p[0], p[1], p[2]); near(xzh.h, 25, 1e-6);
});
test('rayGround 打到平地', () => {
  const cal = fakeCal(Math.PI / 4, 0);
  const p = rayGround({ o: [0, 100, 0], d: norm3([0, -1, 1]) }, cal);
  near(p[1], 0, 1e-3); near(p[2], 100, 0.5);
});
test('rayShell：壳 = 平面时与地面同解', () => {
  const cal = fakeCal(Math.PI / 4, 0);
  cal.setShell(cal.ground.data.buffer.slice(0));
  // 壳缓冲要带头：重新拼一份
  const buf = new ArrayBuffer(8 + 100 * 100 * 4); const dv = new DataView(buf); dv.setUint32(0, 100, true); dv.setUint32(4, 100, true); new Float32Array(buf, 8).set(cal.ground.data); cal.setShell(buf);
  const eye = [0, 100, -50]; const target = cal.sceneToWorldGround(55, 60);
  const d = norm3([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  const hit = rayShell({ o: eye, d }, cal);
  assert.ok(hit, '应命中'); near(hit[0], target[0], 0.6); near(hit[2], target[2], 0.6);
});

// ---------------------------------------------------------------- Edit（画面空间）
function screenHost(doc) {
  return { doc, cal: null, bakeSegment: () => null, restH: () => 0, entityRadius: () => 7 };
}
function blank(space) { return { id: 't', space: space || 'screen', keyframes: [], source: { segments: [] }, authoring: { sceneId: 's', anchor: { x: 100, y: 200 }, contactOffsetY: 0 } }; }
test('Edit 画面：新段起点钉在锚点；追加点；锚点一动整条跟着走；规范化后存储 == 有效', () => {
  const host = screenHost(blank());
  const i = Edit.addSegment(host, 'manual'); const seg = host.doc.source.segments[i];
  eqJ(seg.path.points, [{ x: 100, y: 200 }]);
  Edit.appendPoint(host, seg, [150, 220]); Edit.appendPoint(host, seg, [200, 200]);
  Edit.setAnchorScreen(host, 110, 210);
  const eff = Edit.effPoints(host, seg);
  near(eff[0].sx, 110); near(eff[1].sx, 160); near(eff[2].sy, 210);
  Edit.setPoint(host, seg, 1, [170, 230]);
  eqJ(seg.path.points[0], { x: 110, y: 210 }, '写点前规范化：0 号点 = 锚点');
  eqJ(seg.path.points[1], { x: 170, y: 230 });
  Edit.setPoint(host, seg, 0, [0, 0]); eqJ(seg.path.points[0], { x: 110, y: 210 }, '钉住的起点写不动');
  assert.strictEqual(Edit.deletePoints(host, seg, [0, 2]), 1, '钉住的 0 号不删');
  assert.strictEqual(seg.path.points.length, 2);
});
test('Edit 画面：钉住段的旋转以起点为轴；整条镜像翻初速', () => {
  const host = screenHost(blank());
  const seg = host.doc.source.segments[Edit.addSegment(host, 'manual')];
  Edit.appendPoint(host, seg, [200, 200]);
  Edit.transformSegment(host, seg, Edit.T.rotate2([150, 200], 90), null);   // 轴给在中点，但钉住 → 实际绕起点
  const eff = Edit.effPoints(host, seg);
  near(eff[0].sx, 100); near(eff[0].sy, 200); near(eff[1].sx, 100, 1e-6); near(eff[1].sy, 300, 1e-6);
  const p = host.doc.source.segments[Edit.addSegment(host, 'physics')];
  p.v0 = { x: -120, y: -260 };
  Edit.transformAll(host, Edit.T.mirror2([100, 200], 'x'));
  eqJ(p.v0, { x: 120, y: -260 });
  near(Edit.effPoints(host, seg)[1].sx, 100);
});
test('Edit 画面：抛体落点 / 最高点把手反解与 physicsInfo 自洽', () => {
  const host = screenHost(blank());
  const seg = host.doc.source.segments[Edit.addSegment(host, 'physics')];
  seg.groundY = 260; seg.gravity = 1000; seg.v0 = { x: 100, y: -200 };
  Edit.setLanding(host, seg, [300, 300]);
  assert.strictEqual(seg.groundY, 300);
  const pi = Edit.physicsInfo(host, seg); near(pi.landing[0], 300, 0.05); near(pi.landing[1], 300, 1e-6);
  Edit.setApex(host, seg, 150); const pi2 = Edit.physicsInfo(host, seg); near(pi2.apex[1], 150, 0.05); near(pi2.landing[0], 300, 0.1);
  Edit.setLanding(host, seg, [400, 250]); assert.strictEqual(seg.groundY, 250, '地面线不能高过起点以上？——起点 y=200，250 在其下方合法');
});

// ---------------------------------------------------------------- Edit（世界空间，restH）
function worldHost(doc, cal, restH) {
  return { doc, cal, bakeSegment: () => null, restH: () => restH, entityRadius: () => 7 };
}
test('Edit 世界：新点存储 h = 离地高度 + restH；显示 h 为离地高度；变换不放大 restH', () => {
  const cal = fakeCal(Math.PI / 4, 0);
  const doc = blank('world'); doc.authoring.anchor = { x: 50, y: 60 }; doc.authoring.contactOffsetY = 7;
  const host = worldHost(doc, cal, 10);
  const seg = doc.source.segments[Edit.addSegment(host, 'manual')];
  near(seg.path.points[0].h, 10, 1e-6, '起点存储 h = restH');
  const i = Edit.appendPoint(host, seg, { x: 20, z: 30, h: 0 });
  near(seg.path.points[i].h, 10, 1e-6);
  const eff = Edit.effPoints(host, seg); near(eff[i].h, 0, 1e-6); near(eff[i].pos[1], 10, 1e-6);
  Edit.setPoint(host, seg, i, { h: 5 }); near(seg.path.points[i].h, 15, 1e-6); near(Edit.effPoints(host, seg)[i].h, 5, 1e-6);
  Edit.transformSegment(host, seg, Edit.T.scale3([0, 0], 2, 2, 2), null);
  near(Edit.effPoints(host, seg)[i].h, 10, 1e-6, '离地高度 ×2，restH 不变');
  const st = Edit.segStartXZH(host, seg); near(st.h, 10, 1e-6);
});
test('Edit 世界：换实体 restH 变化整体平移绝对 h；相对锚点换算', () => {
  const cal = fakeCal(Math.PI / 4, 0);
  const doc = blank('world'); doc.authoring.anchor = { x: 50, y: 60 };
  const host = worldHost(doc, cal, 10);
  const seg = doc.source.segments[Edit.addSegment(host, 'manual')];
  Edit.appendPoint(host, seg, { x: 20, z: 30, h: 3 });
  Edit.shiftRestHeight(host, -4);
  near(seg.path.points[1].h, 9, 1e-6);
  const cap = Edit.captureRelative(host);
  doc.authoring.anchor = { x: 60, y: 60 };
  Edit.applyRelative(host, cap);
  const a = Edit.anchorWorld(host);
  near(seg.path.points[0].x, a[0], 1e-6, '0 号点跟到新锚点');
});

// ---------------------------------------------------------------- History
test('History：提交 / 拖拽合并 / 撤销重做 / 改标签', () => {
  let doc = { a: 1 };
  const H = new History({ get: () => doc, set: (d) => { doc = d; } });
  assert.strictEqual(H.commit('x', () => { doc.a = 2; }), true);
  assert.strictEqual(H.commit('noop', () => {}), false);
  H.beginDrag('drag'); doc.a = 3; H.commit('inner', () => { doc.a = 4; }); H.relabel('拖拽'); assert.strictEqual(H.endDrag(), true);
  assert.strictEqual(H.undoStack.length, 2); assert.strictEqual(H.peekUndo(), '拖拽');
  assert.strictEqual(H.undo(), '拖拽'); assert.strictEqual(doc.a, 2);
  assert.strictEqual(H.undo(), 'x'); assert.strictEqual(doc.a, 1);
  assert.strictEqual(H.redo(), 'x'); assert.strictEqual(doc.a, 2);
  H.beginDrag('c'); doc.a = 9; H.cancelDrag(); assert.strictEqual(doc.a, 2);
});



// ---------------------------------------------------------------- 审查回归（2026-09-04 第二轮）
test('P0-1 整段平移：钉住的段自动改成自定起点并真的挪了；整条平移 = 挪锚点且自定起点段跟着走', () => {
  const host = screenHost(blank());
  const seg = host.doc.source.segments[Edit.addSegment(host, 'manual')];
  Edit.appendPoint(host, seg, [200, 200]);
  const r = Edit.transformSegment(host, seg, Edit.T.translate2(50, 20), null);
  assert.strictEqual(r.promoted, true); assert.strictEqual(seg.startFrom, 'explicit');
  const e = Edit.effPoints(host, seg); near(e[0].sx, 150); near(e[0].sy, 220); near(e[1].sx, 250);
  // 第二段挂上一段：整条平移 → 锚点动 + 自定段跟着动，钉住段不被提成 explicit
  const s2 = host.doc.source.segments[Edit.addSegment(host, 'manual')];
  Edit.appendPoint(host, s2, [300, 300]);
  const r2 = Edit.transformAll(host, Edit.T.translate2(10, 10));
  assert.strictEqual(r2.anchorMoved, true); eqJ(host.doc.authoring.anchor, { x: 110, y: 210 });
  near(seg.start.x, 160); near(seg.start.y, 230); assert.strictEqual(s2.startFrom, 'previous');
  // 只动选中点时钉住的起点不动、不提升
  const s3 = host.doc.source.segments[Edit.addSegment(host, 'manual')]; Edit.appendPoint(host, s3, [400, 400]);
  const r3 = Edit.transformSegment(host, s3, Edit.T.translate2(5, 5), new Set([0, 1]));
  assert.strictEqual(r3.promoted, false); assert.strictEqual(s3.startFrom, 'previous');
});
test('P0-2 solveLanding2D：g=0 / 地面线在起点上方 都不产生非有限数', () => {
  const v = solveLanding2D([0, 100], { x: 30, y: -10 }, 0, 100, 80); eqJ(v, { x: 30, y: -10 });
  const w = solveLanding2D([0, 100], { x: 30, y: -10 }, 1000, 60, 80);   // 地面线比起点高 40，vy 不够
  assert.ok(Number.isFinite(w.x) && Number.isFinite(w.y) && w.y < 0);
  const f = flight2D([0, 100], w, 1000, 60); near(f.landing[0], 80, 0.05); near(f.landing[1], 60, 1e-6);
  const a = solveApex2D([0, 0], { x: 10, y: -10 }, 0, 0, -50); eqJ(a, { x: 10, y: -10 });
  eqJ(solveLanding3D([0, 0, 0], { x: 1, y: 2, z: 3 }, 0, flat, 5, 5), { x: 1, y: 2, z: 3 });
});
test('P1-1 拖锚点：自定起点的段一起平移（画布 = 烘出来的）', () => {
  const host = screenHost(blank());
  const seg = host.doc.source.segments[Edit.addSegment(host, 'manual')];
  Edit.appendPoint(host, seg, [200, 200]); Edit.setStartMode(host, seg, 'explicit');
  const p = host.doc.source.segments[Edit.addSegment(host, 'physics')]; p.startFrom = 'explicit'; p.start = { x: 300, y: 300 }; p.groundY = 350;
  Edit.setAnchorScreen(host, 130, 240);
  eqJ(seg.start, { x: 130, y: 240 }); near(Edit.effPoints(host, seg)[1].sx, 230); eqJ(p.start, { x: 330, y: 340 }); assert.strictEqual(p.groundY, 390);
  Edit.setAnchorScreen(host, 0, 0, false); eqJ(seg.start, { x: 130, y: 240 }, 'carry=false 只改锚点');
});
test('P1-2/P1-3 normalize 不裁 h；convertSpace 贴地 h=restH；setGroundY 不高于起点', () => {
  const cal = fakeCal(Math.PI / 4, 0);
  const doc = blank('world'); doc.authoring.anchor = { x: 50, y: 60 };
  const host = worldHost(doc, cal, 10);
  const seg = doc.source.segments[Edit.addSegment(host, 'manual')];
  Edit.appendPoint(host, seg, { x: 20, z: 30, h: 100 });
  seg.path.points[0].h = 40;   // 起点存储 h 被弄坏（模拟坏锚点）：规范化只平移，第二点相对差保持 60
  Edit.normalize(host, seg);
  near(seg.path.points[1].h - seg.path.points[0].h, 70, 1e-6);
  const d2 = blank('screen'); const h2 = worldHost(d2, cal, 10);
  const m = d2.source.segments[Edit.addSegment(h2, 'manual')]; Edit.appendPoint(h2, m, [60, 70]);
  const ph = d2.source.segments[Edit.addSegment(h2, 'physics')];
  Edit.convertSpace(h2, 'screen', 'world'); d2.space = 'world';
  assert.ok(m.path.points.every((p) => Math.abs(p.h - 10) < 1e-9), '贴地 = restH');
  assert.strictEqual(ph.radius > 0, true);
  const d3 = blank('screen'); const h3 = screenHost(d3);
  const p3 = d3.source.segments[Edit.addSegment(h3, 'physics')];
  assert.strictEqual(Edit.setGroundY(h3, p3, 100), true); assert.strictEqual(p3.groundY, 200);
  const info = Edit.setLanding(h3, p3, [300, 150]); assert.strictEqual(info.clamped, true); assert.strictEqual(p3.groundY, 200);
  p3.gravity = 0; assert.strictEqual(Edit.setLanding(h3, p3, [300, 250]).noGravity, true);
});
test('P2-1 worldCurveSamples：h 按归一弧长插值、控制点在 i*16、去重不影响索引', () => {
  const s = worldCurveSamples([{ x: 0, z: 0, h: 0 }, { x: 100, z: 0, h: 50 }, { x: 200, z: 0, h: 0 }], true);
  assert.strictEqual(s.length, 33);
  near(s[16].h, 50, 1e-9); near(s[0].h, 0); near(s[32].h, 0);
  const mid = s[8]; near(mid.h, 50 * mid.s01 / s[16].s01, 1e-9, '按弧长线性');
  const p = worldCurveSamples([{ x: 0, z: 0, h: 0 }, { x: 0, z: 0, h: 0 }, { x: 10, z: 0, h: 7 }], false);
  assert.strictEqual(p.length, 3); near(p[2].h, 7);
});



// ---------------------------------------------------------------- 审查回归（第三轮修复）
test('P0-N1 换场景流程：carry=false 不规范化；相对量换算后存储 h 剖面不变', () => {
  const calA = fakeCal(Math.PI / 4, 0), calB = fakeCal(Math.PI / 3, 25);   // 新场景：不同俯角、地面高 25
  const doc = blank('world'); doc.authoring.anchor = { x: 50, y: 60 };
  const host = { doc, cal: calA, bakeSegment: () => null, restH: () => 0, entityRadius: () => 7 };
  const seg = doc.source.segments[Edit.addSegment(host, 'manual')];
  Edit.appendPoint(host, seg, { x: 20, z: 30, h: 40 }); Edit.appendPoint(host, seg, { x: 60, z: 10, h: 80 }); Edit.appendPoint(host, seg, { x: 90, z: 0, h: 20 });
  const hBefore = seg.path.points.map((p) => p.h);
  const cap = Edit.captureRelative(host);
  host.cal = calB;                       // 换场景：cal 已是新场景，锚点还是旧坐标
  Edit.setAnchorScreen(host, 40, 55, false);
  Edit.applyRelative(host, cap);
  eqJ(seg.path.points.map((p) => p.h), hBefore, '存储 h 一个都不能动');
  const eff = Edit.effPointsWorld(host, seg);
  near(eff[1].h, 40, 1e-6); near(eff[2].h, 80, 1e-6); near(eff[3].h, 20, 1e-6);
  const a = Edit.anchorWorld(host); near(seg.path.points[0].x, a[0], 0.006, '0 号点跟到新锚点 x'); near(seg.path.points[0].z, a[2], 0.006);
});
test('P1-N1 锚点模式的段起点本地算（不等烘焙）', () => {
  const host = screenHost(blank());
  host.bakeSegment = () => ({ start: [999, 999], end: [1000, 1000] });   // 过期的烘焙边界
  const seg = host.doc.source.segments[Edit.addSegment(host, 'manual')];
  Edit.appendPoint(host, seg, [200, 200]);
  Edit.setAnchorScreen(host, 130, 240);
  const e = Edit.effPoints(host, seg); near(e[0].sx, 130); near(e[0].sy, 240); near(e[1].sx, 230);
  const s2 = host.doc.source.segments[Edit.addSegment(host, 'manual')];
  eqJ(Edit.segStartScreen(host, s2), [999, 999], '"上一段末点"仍取烘焙边界');
});
test('P2-N2/N5 零位移不促升、不改；切回锚点删掉残留 start', () => {
  const host = screenHost(blank());
  const seg = host.doc.source.segments[Edit.addSegment(host, 'manual')]; Edit.appendPoint(host, seg, [200, 200]);
  const before = JSON.stringify(seg);
  const r = Edit.transformSegment(host, seg, Edit.T.translate2(0, 0), null);
  assert.strictEqual(r.promoted, false); assert.strictEqual(JSON.stringify(seg), before);
  assert.strictEqual(Edit.transformAll(host, Edit.T.rotate2([0, 0], 0)).anchorMoved, false);
  Edit.setStartMode(host, seg, 'explicit'); assert.ok(seg.start);
  Edit.setStartMode(host, seg, 'anchor'); assert.strictEqual(seg.start, undefined);
  Edit.setAnchorScreen(host, 100, 200); assert.strictEqual(JSON.stringify(host.doc.authoring.anchor), JSON.stringify({ x: 100, y: 200 }));
});
test('P2-N3 新建抛体段的地面线不高于起点', () => {
  const host = screenHost(blank());
  const m = host.doc.source.segments[Edit.addSegment(host, 'manual')]; Edit.appendPoint(host, m, [300, 260]);   // 末点在锚点(200)下方 60
  const p = host.doc.source.segments[Edit.addSegment(host, 'physics')];
  near(p.groundY, 260, 1e-6);
  assert.strictEqual(Edit.setGroundY(host, p, p.groundY), false, '出生态不能是 setter 拒收的状态');
});
test('P2-c 起点在地面线之下：把手按抬到地面线算（与烘焙机同式），不再飞出画外', () => {
  const f = flight2D([0, 60], { x: 100, y: -200 }, 1000, 0);   // 起点比地面线低 60
  assert.strictEqual(f.lifted, true); near(f.t, 0.4, 1e-9); near(f.landing[0], 40, 1e-9); near(f.landing[1], 0, 1e-9);
  const v = solveLanding2D([0, 60], { x: 100, y: -200 }, 1000, 0, 80); near(v.x, 200, 1e-6);
});
test('R10-① 起点已在地面线之下：地面线 / 落点把手随手挪，不再钳回原始起点；正常态仍钳', () => {
  const host = screenHost(blank());
  const m = host.doc.source.segments[Edit.addSegment(host, 'manual')]; Edit.appendPoint(host, m, [300, 260]);
  const p = host.doc.source.segments[Edit.addSegment(host, 'physics')];
  Edit.setPoint(host, m, 1, [300, 320]);   // 上游末点压到线下 60（groundY 仍 260）→ 受支持的"抬起点"态
  assert.strictEqual(Edit.physicsInfo(host, p).lifted, true);
  assert.strictEqual(Edit.setGroundY(host, p, 264), false); near(p.groundY, 264, 1e-6);
  const r = Edit.setLanding(host, p, [250, 266]); assert.strictEqual(r.clamped, false); near(p.groundY, 266, 1e-6);
  Edit.setGroundY(host, p, 330); near(p.groundY, 330, 1e-6);   // 线拖到起点之下：回到正常态
  assert.strictEqual(Edit.setGroundY(host, p, 300), true); near(p.groundY, 320, 1e-6);   // 正常态：线不能高于起点
});
console.log(`viewer tests: ${passed} passed`);
