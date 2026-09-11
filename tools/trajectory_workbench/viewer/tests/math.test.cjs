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
for (const f of ['common.js', 'history.js', 'edit.js', 'gizmo.js']) {
  ctx.module = { exports: {} };
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  Object.assign(ex, ctx.module.exports);
}
const { SceneCal, densePath, worldCurveSamples, flight2D, solveLanding2D, solveApex2D, flight3D, solveLanding3D, solveApex3D, inv4, xform4, projectPoint, unprojectRay, rayPlane, rayLineParam, pointInPoly, rayGround, rayShell, perspective, ortho, lookAt, mul4, History, Edit, Gizmo, GZ_CFG } = ex;
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
  return { doc, cal: null, bakeSegment: () => null, restH: () => 0, contactOffsetY: () => 0, entityRadius: () => 7 };
}
// 曲线没有锚点：authoring.origin 只是"没有分段时起点放哪"的回落（新建第一段时用），有段之后起点 = 第 0 段起点
function blank(space) { return { id: 't', space: space || 'screen', binding: 'scene', keyframes: [], slots: [], source: { segments: [], bake: { contactOffsetY: 0 } }, authoring: { sceneId: 's', origin: { x: 100, y: 200 } } }; }
test('Edit 画面：第 0 段起点 = 曲线起点（可拖）；整条平移把起点和点一起挪；接上一段的段起点钉住、写不动删不掉', () => {
  const host = screenHost(blank());
  const i = Edit.addSegment(host, 'manual'); const seg = host.doc.source.segments[i];
  eqJ(seg.path.points, [{ x: 100, y: 200 }], '第一段从回落的起点开始');
  assert.strictEqual(Edit.startMode(host.doc, seg), 'explicit'); assert.strictEqual(Edit.isPinned(host.doc, seg), false);
  Edit.appendPoint(host, seg, [150, 220]); Edit.appendPoint(host, seg, [200, 200]);
  Edit.transformAll(host, Edit.T.translate2(10, 10));
  const eff = Edit.effPoints(host, seg);
  near(eff[0].sx, 110); near(eff[1].sx, 160); near(eff[2].sy, 210);
  eqJ(Edit.originScreen(host), [110, 210], '曲线起点 = 第 0 段起点');
  Edit.setPoint(host, seg, 1, [170, 230]);
  eqJ(seg.path.points[0], { x: 110, y: 210 }, '写点前规范化：0 号点 = 段起点');
  eqJ(seg.path.points[1], { x: 170, y: 230 });
  Edit.setPoint(host, seg, 0, [90, 190]); eqJ(seg.path.points[0], { x: 90, y: 190 }, '曲线起点可拖'); eqJ(seg.start, { x: 90, y: 190 });
  // 接上一段末点的段：0 号点钉在上一段末点上，写不动、删不掉
  const s2 = host.doc.source.segments[Edit.addSegment(host, 'manual')];
  assert.strictEqual(Edit.isPinned(host.doc, s2), true); eqJ(s2.path.points, [{ x: 210, y: 210 }], "钉在上一段末点（平移后）");
  Edit.appendPoint(host, s2, [260, 260]); Edit.appendPoint(host, s2, [300, 300]);
  Edit.setPoint(host, s2, 0, [0, 0]); eqJ(s2.path.points[0], { x: 210, y: 210 }, "钉住的起点写不动");
  assert.strictEqual(Edit.deletePoints(host, s2, [0, 2]), 1, '钉住的 0 号不删');
  assert.strictEqual(s2.path.points.length, 2);
});
test('Edit 画面：钉住段的旋转以起点为轴；整条镜像翻初速', () => {
  const host = screenHost(blank());
  Edit.addSegment(host, 'manual');   // 第 0 段：曲线起点 (100,200)
  const seg = host.doc.source.segments[Edit.addSegment(host, 'manual')];   // 接上一段末点：起点钉在 (100,200)
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
  return { doc, cal, bakeSegment: () => null, restH: () => restH, contactOffsetY: () => 0, entityRadius: () => 7 };
}
test('Edit 世界：新点存储 h = 离地高度 + restH；显示 h 为离地高度；变换不放大 restH', () => {
  const cal = fakeCal(Math.PI / 4, 0);
  const doc = blank('world'); doc.authoring.origin = { x: 50, y: 60 };
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
test('Edit 世界：曲线起点 = 第 0 段起点；整条平移把段与插槽一起挪；插槽世界点跟地面', () => {
  const cal = fakeCal(Math.PI / 4, 0);
  const doc = blank('world'); doc.authoring.origin = { x: 50, y: 60 };
  const host = worldHost(doc, cal, 10);
  const seg = doc.source.segments[Edit.addSegment(host, 'manual')];
  Edit.appendPoint(host, seg, { x: 20, z: 30, h: 3 });
  const o = Edit.curveStartWorld(host); const e0 = Edit.effPoints(host, seg)[0];
  near(o[0], e0.pos[0], 1e-6, '曲线起点 = 第 0 段 0 号点'); near(o[2], e0.pos[2], 1e-6);
  const sid = Edit.addSlot(host, 55, 66, '站位'); assert.strictEqual(sid, 'slot_1');
  const g0 = Edit.slotWorld(host, Edit.findSlot(doc, sid));
  Edit.transformAll(host, Edit.T.translate3(5, 7, 0));
  near(Edit.effPoints(host, seg)[1].x, 25, 1e-6); near(Edit.effPoints(host, seg)[1].z, 37, 1e-6);
  const g1 = Edit.slotWorld(host, Edit.findSlot(doc, sid)); near(g1[0] - g0[0], 5, 0.02, '插槽跟着整条挪 x'); near(g1[2] - g0[2], 7, 0.02, '插槽跟着整条挪 z');
  assert.strictEqual(Edit.renameSlot(host, sid, 'dropper'), true); assert.strictEqual(Edit.renameSlot(host, 'dropper', ''), false);
  assert.strictEqual(Edit.deleteSlot(host, 'dropper'), true); assert.strictEqual(Edit.slots(doc).length, 0);
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
test('P0-1 整段平移：接上一段的段自动改成自定起点并真的挪了；整条平移 = 起点与各段一起挪，接上一段的段不促升', () => {
  const host = screenHost(blank());
  Edit.addSegment(host, 'manual');   // 第 0 段：曲线起点 (100,200)
  const seg = host.doc.source.segments[Edit.addSegment(host, 'manual')];   // 接上一段：钉住
  Edit.appendPoint(host, seg, [200, 200]);
  const r = Edit.transformSegment(host, seg, Edit.T.translate2(50, 20), null);
  assert.strictEqual(r.promoted, true); assert.strictEqual(seg.startFrom, 'explicit');
  const e = Edit.effPoints(host, seg); near(e[0].sx, 150); near(e[0].sy, 220); near(e[1].sx, 250);
  // 第三段挂上一段：整条平移 → 起点动 + 自定段跟着动，钉住段不被提成 explicit（它靠规范化跟着上一段末点走）
  const s2 = host.doc.source.segments[Edit.addSegment(host, 'manual')];
  Edit.appendPoint(host, s2, [300, 300]);
  const r2 = Edit.transformAll(host, Edit.T.translate2(10, 10));
  assert.strictEqual(r2.allMoved, true); eqJ(Edit.originScreen(host), [110, 210]);
  near(seg.start.x, 160); near(seg.start.y, 230); assert.strictEqual(s2.startFrom, 'previous');
  near(Edit.effPoints(host, s2)[1].sx, 310, 1e-6, '钉住段的点跟着上一段末点走');
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
test('P1-2/P1-3 normalize 不裁 h；convertSpace 贴地 h=restH；setGroundY 不高于起点', () => {
  const cal = fakeCal(Math.PI / 4, 0);
  const doc = blank('world'); doc.authoring.origin = { x: 50, y: 60 };
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
test('P1-N1 曲线起点本地算（不等烘焙）；"上一段末点"才取烘焙边界', () => {
  const host = screenHost(blank());
  host.bakeSegment = () => ({ start: [999, 999], end: [1000, 1000] });   // 过期的烘焙边界
  const seg = host.doc.source.segments[Edit.addSegment(host, 'manual')];
  Edit.appendPoint(host, seg, [200, 200]);
  Edit.setPoint(host, seg, 0, [130, 240]);
  const e = Edit.effPoints(host, seg); near(e[0].sx, 130); near(e[0].sy, 240); near(e[1].sx, 200);
  eqJ(Edit.curveStartScreen(host), [130, 240], '起点从 seg.start 本地算，不看过期烘焙');
  eqJ(Edit.originScreen(host), [100, 200], '调运动起点绝不动曲线原点（帧相对原点写，动了整条曲线播放时就位移）');
  const s2 = host.doc.source.segments[Edit.addSegment(host, 'manual')];
  eqJ(Edit.segStartScreen(host, s2), [999, 999], '"上一段末点"仍取烘焙边界');
});
test('P2-N2/N5 零位移不促升、不改；切回"上一段末点"删掉残留 start', () => {
  const host = screenHost(blank());
  Edit.addSegment(host, 'manual');
  const seg = host.doc.source.segments[Edit.addSegment(host, 'manual')]; Edit.appendPoint(host, seg, [200, 200]);
  const before = JSON.stringify(seg);
  const r = Edit.transformSegment(host, seg, Edit.T.translate2(0, 0), null);
  assert.strictEqual(r.promoted, false); assert.strictEqual(JSON.stringify(seg), before);
  assert.strictEqual(Edit.transformAll(host, Edit.T.rotate2([0, 0], 0)).allMoved, false);
  Edit.setStartMode(host, seg, 'explicit'); assert.ok(seg.start);
  Edit.setStartMode(host, seg, 'previous'); assert.strictEqual(seg.start, undefined);
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
// ---------------------------------------------------------------- 3D gizmo / 正交相机（2026-09-10 Unity 式交互）
test('rayLineParam: 鼠标射线离轴最近处的轴参数；平行无解', () => {
  // 射线从 (0,0,10) 朝 (5,0,0)：与 X 轴（过原点）交于 x=5
  const d = norm3([5, 0, -10]);
  near(rayLineParam({ o: [0, 0, 10], d }, [0, 0, 0], [1, 0, 0]), 5, 1e-9, 'hit');
  // 射线不与轴相交（错开 y=3）：最近点仍在 x=5
  near(rayLineParam({ o: [0, 3, 10], d }, [0, 0, 0], [1, 0, 0]), 5, 1e-9, 'skew');
  // 轴不过原点：p0=(2,0,0)，同一射线 → t=3
  near(rayLineParam({ o: [0, 0, 10], d }, [2, 0, 0], [1, 0, 0]), 3, 1e-9, 'offset');
  // 与轴平行：无解
  assert.strictEqual(rayLineParam({ o: [0, 0, 10], d: [1, 0, 0] }, [0, 0, 0], [1, 0, 0]), null);
  // 视线几乎对着轴（顶视拖 Y 箭头）：夹角 0.3° 也无解，调用方退回屏幕投影法
  assert.strictEqual(rayLineParam({ o: [0, 100, 0], d: norm3([Math.sin(0.3 * Math.PI / 180), -Math.cos(0.3 * Math.PI / 180), 0]) }, [0, 0, 0], [0, 1, 0]), null);
});
test('ortho: 目标深度上的尺寸与透视一致、反投影射线平行且从机位背后出发（侧视场景比 dist 宽也画得全）', () => {
  const eye = [0, 0, -3000], target = [0, 0, 0];
  const view = lookAt(eye, target, [0, 1, 0]);
  const fov = 45 * Math.PI / 180, dist = 3000, halfH = dist * Math.tan(fov / 2), far = dist * 20 + 1e4;
  const mp = mul4(perspective(fov, 800 / 600, 30, far), view), mo = mul4(ortho(halfH, 800 / 600, -far, far), view);
  // 目标深度上同一点：两种投影落到同一像素
  const p = [200, 100, 0];
  const a = projectPoint(mp, p, 800, 600), b = projectPoint(mo, p, 800, 600);
  near(a[0], b[0], 1e-3, 'x'); near(a[1], b[1], 1e-3, 'y');
  // 正交的反投影射线：方向 = forward（+Z），两条像素射线平行；起点在机位背后 far 处
  const inv = inv4(mo);
  const r1 = unprojectRay(inv, 400, 300, 800, 600), r2 = unprojectRay(inv, 600, 300, 800, 600);
  near(r1.d[2], 1, 1e-6, 'dir'); near(Math.abs(r1.d[0] - r2.d[0]) + Math.abs(r1.d[1] - r2.d[1]), 0, 1e-6, 'parallel');
  near(r1.o[2], -3000 - far, 1, 'origin behind eye');
  // 像素 → 世界 → 像素 往返
  const q = rayPlane(r2, [0, 0, 0], [0, 0, 1]); const back = projectPoint(mo, q, 800, 600);
  near(back[0], 600, 1e-3); near(back[1], 300, 1e-3);
});
test('pointInPoly: 四边形内含（gizmo 面片拾取）', () => {
  const sq = [[10, 10], [30, 10], [30, 30], [10, 30]];
  assert.strictEqual(pointInPoly(20, 20, sq), true);
  assert.strictEqual(pointInPoly(5, 20, sq), false);
  assert.strictEqual(pointInPoly(20, 35, sq), false);
  const tri = [[0, 0], [40, 0], [0, 40], [0, 0]];
  assert.strictEqual(pointInPoly(10, 10, tri), true);
  assert.strictEqual(pointInPoly(30, 30, tri), false);
});
// ---------------------------------------------------------------- 变换 gizmo（gizmo.js：2D / 3D 共用，假 projector 钉住数学）
// 顶视正交假投影：屏幕 x = 400 + 世界 x，屏幕 y = 300 − 世界 z（Y 轴对着视线，投影成一个点）
const projTop = {
  dim: 3, project: (p) => [400 + p[0], 300 - p[2]], worldPerPx: () => 1,
  axisParam: (mx, my, p0, a) => { const c = [400 + p0[0], 300 - p0[2]], s = [a[0], -a[2]], l2 = s[0] * s[0] + s[1] * s[1]; return l2 < 1e-9 ? null : ((mx - c[0]) * s[0] + (my - c[1]) * s[1]) / l2; },
  planePoint: (mx, my, p0, a, b) => { const A = [a[0], -a[2]], B = [b[0], -b[2]], det = A[0] * B[1] - A[1] * B[0]; if (Math.abs(det) < 1e-9) return null; const c = [400 + p0[0], 300 - p0[2]], dx = mx - c[0], dy = my - c[1]; const u = (dx * B[1] - dy * B[0]) / det, w = (A[0] * dy - A[1] * dx) / det; return [p0[0] + a[0] * u + b[0] * w, p0[1] + a[1] * u + b[1] * w, p0[2] + a[2] * u + b[2] * w]; },
  groundPoint: (mx, my, p0) => [mx - 400, p0[1], 300 - my],
  viewPlanePoint: (mx, my, p0) => [mx - 400, p0[1], 300 - my],
  eyeAbove: () => true,
};
test('Gizmo.geom: 轴心投影、轴尖、对着视线的轴 / 面不给抓（顶视只剩 X / Z + XZ 面）', () => {
  const g = Gizmo.geom(projTop, GZ_CFG.world3, [10, 5, 20], 'move', 1);
  eqJ(g.c.map(Math.round), [410, 280]); eqJ(g.tip.x.map(Math.round), [494, 280]); eqJ(g.tip.z.map(Math.round), [410, 196]);
  eqJ(Object.keys(g.planes), ['xz']);   // XY / YZ 在顶视下是一条线
  assert.strictEqual(Gizmo.hit(g, 450, 280), 'x'); assert.strictEqual(Gizmo.hit(g, 410, 240), 'z');
  assert.strictEqual(Gizmo.hit(g, 410, 280), 'c'); assert.strictEqual(Gizmo.hit(g, 448, 242), 'xz');
  assert.strictEqual(Gizmo.hit(g, 600, 600), null);
  assert.strictEqual(Gizmo.hit(g, 410, 300), null, 'Y 轴投影成一个点：不可抓');
  const g1 = Gizmo.geom(projTop, GZ_CFG.world3, [10, 5, 20], 'rotate', 1);
  assert.strictEqual(g1.mode, 'move', '单点没有旋转 / 缩放');
});
test('Gizmo 拖轴：只动那一根轴的分量；Ctrl 吸附 10 wu；3px 死区', () => {
  const g = Gizmo.geom(projTop, GZ_CFG.world3, [10, 5, 20], 'move', 1);
  const d = Gizmo.dragBegin(projTop, g, 'x', 450, 280);
  assert.strictEqual(Gizmo.dragUpdate(projTop, d, 451, 281, false), null, '死区');
  let r = Gizmo.dragUpdate(projTop, d, 470, 280, false); eqJ(r.kind, 'move'); near(r.v.x, 20); near(r.v.y, 0); near(r.v.z, 0);
  r = Gizmo.dragUpdate(projTop, d, 473, 285, true); near(r.v.x, 20, 1e-9, 'snap');
  const T = Gizmo.toTransform(r, true, null); eqJ(T.pos([1, 2, 3]), [21, 2, 3]);   // world：translate3(x, z, h)
  const dz = Gizmo.dragBegin(projTop, g, 'z', 410, 240); r = Gizmo.dragUpdate(projTop, dz, 410, 210, false); near(r.v.z, 30); near(r.v.x, 0);
  eqJ(Gizmo.toTransform(r, true, null).pos([1, 2, 3]), [1, 32, 3]);
});
test('Gizmo 中心 / XZ 面 = 贴地走：h 分量恒 0', () => {
  const g = Gizmo.geom(projTop, GZ_CFG.world3, [10, 5, 20], 'move', 3);
  const d = Gizmo.dragBegin(projTop, g, 'c', 410, 280);
  const r = Gizmo.dragUpdate(projTop, d, 422, 271, false); near(r.v.x, 12); near(r.v.z, 9); near(r.v.y, 0);
  const d2 = Gizmo.dragBegin(projTop, g, 'xz', 448, 242);
  const r2 = Gizmo.dragUpdate(projTop, d2, 458, 242, false); near(r2.v.x, 10); near(r2.v.z, 0); near(r2.v.y, 0);
});
test('Gizmo 旋转环：拖到 90° 处 = 转 90°，形状跟手；缩放中心等比', () => {
  const g = Gizmo.geom(projTop, GZ_CFG.world3, [10, 5, 20], 'rotate', 2);
  assert.strictEqual(g.ring.length, 48);
  const d = Gizmo.dragBegin(projTop, g, 'ring', Math.round(g.ring[0][0]), Math.round(g.ring[0][1]));
  const r = Gizmo.dragUpdate(projTop, d, Math.round(g.ring[12][0]), Math.round(g.ring[12][1]), false);
  eqJ(r.kind, 'rotate'); near(r.deg, 90, 1);
  const T = Gizmo.toTransform(r, true, [10, 20]); const q = T.pos([30, 20, 7]);   // 轴心 (10,20)：+x 方向的点转到 +z 方向
  near(q[0], 10, 1); near(q[1], 40, 1); near(q[2], 7);
  const gs = Gizmo.geom(projTop, GZ_CFG.world3, [10, 5, 20], 'scale', 2);
  const ds = Gizmo.dragBegin(projTop, gs, 'sc', 410, 280);
  const rs = Gizmo.dragUpdate(projTop, ds, 450, 240, false); eqJ(rs.kind, 'scale'); near(rs.k.all, Math.exp(80 / 150), 1e-9);
  const Ts = Gizmo.toTransform(rs, true, [10, 20]); const p = Ts.pos([20, 20, 4]); near(p[0], 10 + 10 * rs.k.all); near(p[1], 20); near(p[2], 4 * rs.k.all);
  const dsx = Gizmo.dragBegin(projTop, gs, 'sx', 450, 280); const rsx = Gizmo.dragUpdate(projTop, dsx, 450 + 84, 280, false); near(rsx.k.x, 2); assert.strictEqual(rsx.k.z, undefined);
});
test('Gizmo 画面空间（dim 2）：Y 箭头朝上、拖上去 y 变小；toTransform 走 translate2', () => {
  const projFlat = { dim: 2, project: (p) => [p[0], p[1]], worldPerPx: () => 1,
    axisParam: (mx, my, p0, a) => ((mx - p0[0]) * a[0] + (my - p0[1]) * a[1]) / (a[0] * a[0] + a[1] * a[1]),
    planePoint: (mx, my) => [mx, my], groundPoint: (mx, my) => [mx, my], viewPlanePoint: (mx, my) => [mx, my], eyeAbove: () => true };
  const g = Gizmo.geom(projFlat, GZ_CFG.screen, [100, 100], 'move', 1);
  eqJ(g.tip.x.map(Math.round), [184, 100]); eqJ(g.tip.y.map(Math.round), [100, 16]); eqJ(Object.keys(g.planes), []);
  assert.strictEqual(Gizmo.hit(g, 100, 50), 'y');
  const d = Gizmo.dragBegin(projFlat, g, 'y', 100, 50); const r = Gizmo.dragUpdate(projFlat, d, 100, 30, false);
  near(r.v.x, 0); near(r.v.y, -20);
  eqJ(Gizmo.toTransform(r, false, null).pos([5, 5]), [5, -15]);
  const dc = Gizmo.dragBegin(projFlat, g, 'c', 100, 100); const rc = Gizmo.dragUpdate(projFlat, dc, 107, 111, false); near(rc.v.x, 7); near(rc.v.y, 11);
});
test('Gizmo 重叠轴错开画（2D 原画里 Y 与 Z 都朝上）：Z 平移 16px、拖拽数学不变', () => {
  // 原画式投影：x 右；y 上（cosθ）；z 也朝上（sinθ）
  const th = 0.6, cs = Math.cos(th), sn = Math.sin(th);
  const pr = (p) => [400 + p[0], 300 - p[1] * cs - p[2] * sn];
  const ax = (a) => [a[0], -(a[1] * cs + a[2] * sn)];
  const projArt = { dim: 3, project: pr, worldPerPx: () => 1,
    axisParam: (mx, my, p0, a) => { const c = pr(p0), s = ax(a), l2 = s[0] * s[0] + s[1] * s[1]; return ((mx - c[0]) * s[0] + (my - c[1]) * s[1]) / l2; },
    planePoint: () => null, groundPoint: (mx, my, p0) => [mx - 400, p0[1], (300 - my - p0[1] * cs) / sn], viewPlanePoint: (mx, my, p0) => [mx - 400, p0[1], 0], eyeAbove: () => true };
  const g = Gizmo.geom(projArt, GZ_CFG.world2, [0, 0, 0], 'move', 1);
  const zA = g.axes.find((a) => a.k === 'z'), yA = g.axes.find((a) => a.k === 'y');
  assert.ok(zA.offset && !yA.offset, 'Z 错开、Y 不动');
  near(g.base.z[0], 400 - 16, 1e-9); near(g.base.y[0], 400, 1e-9);
  assert.strictEqual(Gizmo.hit(g, 400, 300 - 30), 'y'); assert.strictEqual(Gizmo.hit(g, 384, 300 - 20), 'z');
  const d = Gizmo.dragBegin(projArt, g, 'z', 384, 280); const r = Gizmo.dragUpdate(projArt, d, 384, 260, false);
  near(r.v.z, 20 / sn, 1e-9, '沿真实 Z 轴（不是画上那根错开的线）'); near(r.v.x, 0); near(r.v.y, 0);
});
test('GZ_CFG.build：按选中的东西裁剪自由度（最高点只有 Y、落点在地上、插槽在地上、初速在空中不跟地形）', () => {
  const apex = GZ_CFG.build(GZ_CFG.world3, 'apex'); eqJ(apex.axes.map((a) => a.k), ['y']); eqJ(apex.planes, []); assert.strictEqual(apex.center, false);
  const landing = GZ_CFG.build(GZ_CFG.world3, 'landing'); eqJ(landing.axes.map((a) => a.k), ['x', 'z']); eqJ(landing.planes.map((p) => p[0]), ['xz']); eqJ(landing.ground, ['c', 'xz']);
  const v0 = GZ_CFG.build(GZ_CFG.world3, 'v0'); eqJ(v0.axes.map((a) => a.k), ['x', 'y', 'z']); eqJ(v0.ground, []); assert.strictEqual(v0.flat, true);
  const slot2 = GZ_CFG.build(GZ_CFG.world2, 'slot:dropper'); eqJ(slot2.axes.map((a) => a.k), ['x', 'z']); eqJ(slot2.planes.map((p) => p[0]), ['xz']); eqJ(slot2.ground, ['c', 'xz']);
  const landingS = GZ_CFG.build(GZ_CFG.screen, 'landing'); eqJ(landingS.axes.map((a) => a.k), ['x']); assert.strictEqual(landingS.center, false);
  // 初速箭尖的中心 = 该高度的水平面（不跟地形）：拖中心 y 分量恒 0
  const g = Gizmo.geom(projTop, v0, [10, 5, 20], 'move', 1, '初速');
  assert.strictEqual(g.label, '初速');
  const d = Gizmo.dragBegin(projTop, g, 'c', 410, 280); assert.ok(!d.ground && d.pa && d.pb);
  const r = Gizmo.dragUpdate(projTop, d, 430, 280, false); near(r.v.x, 20); near(r.v.y, 0); near(r.v.z, 0);
  // 最高点：没有中心可抓，只有 Y（顶视里 Y 投影成点 → 什么都抓不到，这是对的）
  const ga = Gizmo.geom(projTop, apex, [10, 5, 20], 'move', 1); assert.strictEqual(Gizmo.hit(ga, 410, 280), null);
});
// ---------------------------------------------------------------- 曲线原点（2026-09-11 制作人第二轮：原点不是第一帧）
test('Edit 原点：与曲线起点分家；单独挪；整条变换带着走；没摆过时跟着起点', () => {
  const host = screenHost(blank());
  assert.strictEqual(Edit.hasOrigin(host), true, 'blank() 里就摆了一个');
  const seg = host.doc.source.segments[Edit.addSegment(host, 'manual')];
  eqJ(seg.path.points, [{ x: 100, y: 200 }], '第一段从原点起');
  Edit.appendPoint(host, seg, [200, 200]);

  // 调运动起点：起点动，原点不动 —— 制作人那条的直接判据
  Edit.setPoint(host, seg, 0, [140, 260]);
  eqJ(Edit.curveStartScreen(host), [140, 260]);
  eqJ(Edit.originScreen(host), [100, 200]);

  // 单独挪原点：曲线一个点都不动
  const before = Edit.effPoints(host, seg).map((p) => [p.sx, p.sy]);
  Edit.setOriginScreen(host, [10, 20]);
  eqJ(Edit.originScreen(host), [10, 20]);
  eqJ(Edit.effPoints(host, seg).map((p) => [p.sx, p.sy]), before, '挪原点不许动曲线');

  // 整条变换带着原点走（不带的话"整条挪开"在播放时等于没挪）
  Edit.transformAll(host, Edit.T.translate2(5, -5));
  eqJ(Edit.originScreen(host), [15, 15]);
  eqJ(Edit.curveStartScreen(host), [145, 255]);

  // 回到曲线起点
  Edit.originToCurveStart(host);
  eqJ(Edit.originScreen(host), [145, 255]);

  // 没摆过原点的资产：原点 = 曲线起点（老资产 / 新曲线的缺省关系）
  const h2 = screenHost(blank());
  delete h2.doc.authoring.origin;
  assert.strictEqual(Edit.hasOrigin(h2), false);
  const s2 = h2.doc.source.segments[Edit.addSegment(h2, 'manual')];
  Edit.setPoint(h2, s2, 0, [77, 88]);
  eqJ(Edit.originScreen(h2), [77, 88], '没摆过就跟着起点走');
});

test('Edit 原点（世界）：拖到别处保持离地高；整条平移带着走', () => {
  const cal = fakeCal(Math.PI / 4, 0);
  const doc = blank('world');
  const host = worldHost(doc, cal, 10);
  const seg = doc.source.segments[Edit.addSegment(host, 'manual')];
  Edit.appendPoint(host, seg, { x: 20, z: 30, h: 3 });
  Edit.setOriginWorld(host, [5, cal.groundHeight(5, 6) + 12, 6]);
  near(Edit.originHeight(host), 12, 1e-6);
  const p0 = Edit.effPointsWorld(host, seg).map((p) => p.pos.slice());
  const f = cal.worldToScene(40, cal.groundHeight(40, 50) + 12, 50);
  Edit.setOriginScreen(host, [f[0], f[1]]);
  near(Edit.originHeight(host), 12, 1e-3, '按画面点拖原点保持离地高');
  eqJ(Edit.effPointsWorld(host, seg).map((p) => p.pos.slice()), p0, '挪原点不许动曲线');
  const o0 = Edit.originWorld(host).slice();
  Edit.transformAll(host, Edit.T.translate3(5, 7, 0));
  near(Edit.originWorld(host)[0], o0[0] + 5, 1e-3); near(Edit.originWorld(host)[2], o0[2] + 7, 1e-3);
});

console.log(`viewer tests: ${passed} passed`);
