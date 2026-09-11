'use strict';
/* 粒子工作台 · 前端主机（文档 / 撤销 / 选择 / 本地预览 / 检视器 / 联动 / 保存）。
 *
 * 硬契约（逐条照 agent_docs 的 trajectory-workbench 卡「硬契约」一节）：
 * - **本工作台是 `assets/data/vfx/` 唯一的写入者**，主编辑器只读镜像。
 * - **本地预览 = 同一份运行时模拟**：`/gen/vfx.bundle.js` 打的是 `vfxSim.ts` / `vfxSpace.ts` /
 *   `sceneSpace.ts` / `depthShellField.ts` / `groundHeightfield.ts` **本体**，页面里 `new VfxInstanceSim(...)`
 *   真跑。JS 里**不再写第二份**任何换算或积分——两份必然漂，而且漂了一处都不报错。
 * - **坐标对齐自证不许绕过**（`checkAlignment`）：25 个画面点过运行时 `groundWorldAt` 对工作台 `SceneCal`，
 *   壳接触点过运行时 `shellContactAt` 对服务端 `SceneGeometry.shell_contact`。Δ 非零 → 场景芯片整块染红。
 * - **只有真改 doc 才标脏**（`history.commit` 比前后快照）；`id` 不进历史栈。
 * - **保存锁**：保存在飞期间又改了 doc，返回后不覆盖内存、不清脏，状态栏说再按一次。
 * - **磁盘操作一条链**（`runIO`）：存 / 新建 / 改名 / 复制 / 删串行，谁先谁后由链定。
 * - **装载门**（`setBusy`）：换场景 / 打开 / 新建期间遮罩 + `#app` inert + `onKey` 作废 + 存盘拒绝，
 *   换场景有序号守卫（`sceneOp`），装载失败整个退回原现场。
 * - **手势期间不写盘**；手势记着它开始时的 doc（`S.dragDoc`），doc 被换掉就整个作废（不回滚）。
 *
 * ⚠ 本文件是 classic script：`const S` / `let v3` 是词法声明、**不挂 window**（自检脚本里用裸标识符）。 */

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
const EM_COLORS = [[0.42, 0.72, 1, 1], [1, 0.7, 0.33, 1], [0.78, 0.57, 0.92, 1], [0.5, 0.9, 0.55, 1],
  [1, 0.45, 0.55, 1], [0.4, 0.9, 0.95, 1], [0.95, 0.95, 0.55, 1]];
/** 玩家动静场：与 `VfxSystem` 的四个常量同值（那份不能打包进来——它 import pixi）。改那边记得改这里。 */
const PLAYER_MOTION_RADIUS_WU = 320;
const PLAYER_MOTION_FULL_SPEED = 420;
const PLAYER_MOTION_HEIGHT_WU = 90;
/** 联动：文档改动防抖发一次；每 3 分钟续一次（槽 5 分钟新鲜期） */
const PUBLISH_DEBOUNCE_MS = 120;
const PUBLISH_KEEPALIVE_MS = 180000;
const STATUS_POLL_MS = 400;

const S = {
  doc: null, effects: [], sources: { anims: [], images: [] }, sfx: [],
  scenes: [], scene: null, cal: null, marks: [], sceneVfx: [],
  rt: null, rtErr: '', geo: null, shellField: null, space: null,
  sim: null, simErr: '', simTime: 0, frames: 0, playing: false, speed: 1, seed: 1234,
  evCount: { sound: 0, field: 0, hit: 0, flockState: 0 }, lastFlock: '',
  fields: [], playerField: null,
  player: { on: false, world: null, scene: null, speed: 0 },
  probes: [],
  sel: { key: '' }, gizmoMode: 'move', tool: 'select', view: 3,
  dirty: false, cleanKey: '', rev: 0,
  busy: 0, loadingScene: '', sceneOp: 0, entityOp: 0,
  dragDoc: null,
  align: null,
  layers: { mesh: true, dimMesh: false, grid: true, particles: true, rings: true, marks: true },
  link: { on: true, status: null, gameUrl: '', pubPending: false, lastPub: 0, rejected: '' },
  cursor: '',
};
let v3 = null;
let v2 = null;
let history = null;
let simTimer = 0;
let pubTimer = 0;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function status(msg, kind) {
  const e = el('status');
  e.textContent = msg || '';
  e.className = kind || '';
}
function cleanKey() { return (history ? history.snapshot() : '') + '|' + (S.doc ? S.doc.id : ''); }
function markClean() { S.dirty = false; S.cleanKey = cleanKey(); renderDocState(); }
function refreshDirty() { S.dirty = cleanKey() !== S.cleanKey; renderDocState(); }
function touchDoc() { S.rev++; }

/** 磁盘操作一条链：存 / 新建 / 改名 / 复制 / 删全部串行（不串就会留下两份文件或删完又被写回） */
let ioChain = Promise.resolve();
function runIO(fn) {
  const p = ioChain.then(fn, fn);
  ioChain = p.catch(() => {});
  return p;
}

/** 装载门：遮罩 + `#app` inert + onKey 作废 + 存盘拒绝 */
function setBusy(on, text) {
  S.busy += on ? 1 : -1;
  if (S.busy < 0) S.busy = 0;
  const b = el('busy');
  b.hidden = S.busy === 0;
  el('busyText').textContent = text || '装载中…';
  if (S.busy > 0) el('app').setAttribute('inert', ''); else el('app').removeAttribute('inert');
}

function dist3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

// ---------------------------------------------------------------------------
// 运行时包 / 空间
// ---------------------------------------------------------------------------
async function loadRuntime() {
  try {
    S.rt = await import('/gen/vfx.bundle.js');
    S.rtErr = '';
  } catch (e) {
    S.rt = null; S.rtErr = String(e && e.message || e);
  }
}

/**
 * 运行时那份 `SceneSpaceGeometry`：把工作台装到的标定与行走面场按运行时 `sceneSpace.ts` 的形状喂回去，
 * 于是运行时的 `groundWorldAt` / `shellContactAt` / `vfxSim` 可以在页面里**原样跑**——同一份代码，不是照着写的。
 */
function runtimeGeo() {
  const cal = S.cal, rt = S.rt;
  if (!cal || !cal.ground || !rt) return null;
  return {
    work: { w: cal.work.w, h: cal.work.h },
    cal: { ppu: cal.ppu, cx: cal.cx, cy: cal.cy },
    sceneWorld: { w: cal.worldW, h: cal.worldH },
    basisRows: cal.rows, wuPerQUnit: cal.wuPerQ,
    ground: { data: cal.ground.data, w: cal.ground.w, h: cal.ground.h },
  };
}

function buildSpace() {
  S.geo = null; S.shellField = null; S.space = null;
  const rt = S.rt, cal = S.cal;
  if (!rt || !cal || !cal.ground) return;
  const geo = runtimeGeo();
  // 壳栅格就是 work 栅格（服务端 shell_bytes 给的就是它），标定同 work cal —— 别借别的 cal
  const shell = cal.shell
    ? rt.depthShellField.buildDepthShellField(cal.shell.data, cal.shell.w, cal.shell.h,
      { ppu: cal.ppu, cx: cal.cx, cy: cal.cy }, cal.rows)
    : null;
  const viewDir = rt.sceneSpace.viewDirWorld(geo);
  S.geo = geo; S.shellField = shell;
  S.space = rt.vfxSpace.createFieldVfxSpace({ geo, shell, viewDir });
}

// ---------------------------------------------------------------------------
// 坐标对齐自证（工作台的世界 = 游戏的世界）
// ---------------------------------------------------------------------------
/**
 * 两条口径分别拿**运行时的函数**跑一遍、和工作台 / 服务端比：
 *   dPts  25 个画面点 → M-world 地面点（运行时 `groundWorldAt` vs 工作台 `SceneCal.sceneToWorldGround`）
 *   dPen  9 个抬高点的壳接触深度（运行时 `shellContactAt` vs 服务端 `SceneGeometry.shell_contact`）
 *   dRound 世界 → 画面 → 世界往返（只用工作台自己，抓标定自身退化）
 * 镜像 / 错基 / 错尺任何一环 Δ 就是几十上百 wu，而且**从来不报错**（投影与拾取共用同一套换算所以自洽）。
 */
async function checkAlignment() {
  const geo = runtimeGeo(); const rt = S.rt, cal = S.cal;
  if (!geo || !rt) return null;
  let dPts = 0, n = 0;
  for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) {
    const sx = cal.worldW * i / 6, sy = cal.worldH * j / 6;
    dPts = Math.max(dPts, dist3(rt.sceneSpace.groundWorldAt(geo, sx, sy), cal.sceneToWorldGround(sx, sy)));
    n++;
  }
  let dRound = 0;
  for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) {
    const sx = cal.worldW * i / 4, sy = cal.worldH * j / 4;
    const w = cal.sceneToWorldGround(sx, sy);
    const s2 = cal.worldToScene(w[0], w[1], w[2]);
    dRound = Math.max(dRound, Math.hypot(s2[0] - sx, s2[1] - sy));
  }
  let dPen = 0, nPen = 0, dNormal = 0, mismatch = 0;
  if (S.shellField && S.scene) {
    const pts = [];
    for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) {
      const g = cal.sceneToWorldGround(cal.worldW * i / 4, cal.worldH * j / 4);
      pts.push([g[0], g[1] + 120, g[2]]);
    }
    try {
      const res = await API.post('/api/shell_probe', { id: S.scene.id, bg: S.scene.background, points: pts });
      for (let k = 0; k < pts.length; k++) {
        const a = rt.depthShellField.shellContactAt(S.shellField, geo, pts[k][0], pts[k][1], pts[k][2]);
        const b = res.contacts[k];
        if (!a !== !b) { mismatch++; continue; }
        if (!a || !b) continue;
        dPen = Math.max(dPen, Math.abs(a.penWu - b.penWu));
        const d = a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2];
        dNormal = Math.max(dNormal, 1 - d);
        nPen++;
      }
    } catch (e) { return { ok: false, dPts, dRound, dPen: null, err: String(e && e.message || e), n }; }
  }
  const ok = dPts < 0.5 && dRound < 0.5 && dPen < 0.5 && mismatch === 0;
  return { ok, dPts, dRound, dPen, dNormal, mismatch, n, nPen };
}
async function refreshAlignment() { S.align = await checkAlignment(); renderSceneInfo(); }
function alignText() {
  const a = S.align;
  if (!a) return S.rt ? '' : '\n⚠ 坐标自证：没有运行时包，对不了（页面画的可能不是游戏要跑的）';
  if (a.ok) return `\n坐标：与运行时同一套 ✓（${a.n} 点 Δ${fmt(a.dPts, 2)} wu · 壳 ${a.nPen} 点 Δ${fmt(a.dPen, 2)} wu）`;
  return `\n⚠ 坐标与运行时不一致：地面 Δ${fmt(a.dPts, 1)} wu · 往返 Δ${fmt(a.dRound, 1)} · 壳 Δ${a.dPen == null ? '?' : fmt(a.dPen, 1)}`
    + (a.mismatch ? ` · ${a.mismatch} 点一边有一边没有` : '') + (a.err ? ` · ${a.err}` : '');
}

// ---------------------------------------------------------------------------
// 场景装载（装载门 + 序号守卫 + 一次性提交）
// ---------------------------------------------------------------------------
async function loadScene(sceneId, bg) {
  const op = ++S.sceneOp;
  S.loadingScene = sceneId;
  setBusy(true, `装载场景「${sceneId}」…`);
  const prev = { scene: S.scene, cal: S.cal, marks: S.marks, geo: S.geo, shell: S.shellField, space: S.space };
  try {
    const j = await API.json(`/api/scene?id=${encodeURIComponent(sceneId)}${bg ? `&bg=${encodeURIComponent(bg)}` : ''}`);
    const sc = j.scene;
    const name = sc.background;
    const [img, mesh, ground, shell, hf] = await Promise.all([
      API.image(`/api/scene_bg?id=${encodeURIComponent(sceneId)}&bg=${encodeURIComponent(name)}&w=1600`),
      sc.cal ? API.bin(`/api/scene_mesh?id=${encodeURIComponent(sceneId)}&bg=${encodeURIComponent(name)}&stride=2`) : null,
      sc.cal ? API.bin(`/api/scene_ground?id=${encodeURIComponent(sceneId)}&bg=${encodeURIComponent(name)}`) : null,
      sc.cal ? API.bin(`/api/scene_shell?id=${encodeURIComponent(sceneId)}&bg=${encodeURIComponent(name)}`) : null,
      sc.cal ? API.bin(`/api/scene_heightfield?id=${encodeURIComponent(sceneId)}&bg=${encodeURIComponent(name)}`) : null,
    ]);
    if (op !== S.sceneOp) return;                      // 后一次装载已经进来了：这一发整个作废
    // ---- 一次性提交（中途失败上一个场景原封不动）
    S.scene = sc;
    S.marks = sc.marks || [];
    S.sceneVfx = sc.vfx || [];
    S.cal = null;
    if (sc.cal) {
      const cal = new SceneCal(sc.cal, sc.worldWidth, sc.worldHeight);
      cal.setGround(ground); cal.setShell(shell); cal.setHeightfield(hf);
      S.cal = cal;
    }
    buildSpace();
    if (v3 && v3.ok) { v3.setMesh(mesh); v3.setTexture(img); v3.fit(true); }
    if (v2) { v2.setBackground(img); v2.fit(); }
    rebuildSim();
    await refreshAlignment();
    renderSceneInfo(); renderScenePickers(); draw();
    status(`场景「${sc.name || sceneId}」已装上${sc.cal ? '' : '（没有深度载荷：跑不了本地预览）'}`, sc.cal ? 'ok' : 'warn');
  } catch (e) {
    if (op === S.sceneOp) {
      S.scene = prev.scene; S.cal = prev.cal; S.marks = prev.marks; S.geo = prev.geo; S.shellField = prev.shell; S.space = prev.space;
      renderScenePickers();
      status(`场景装不上：${e && e.message || e}（退回原场景）`, 'err');
    }
  } finally {
    if (op === S.sceneOp) S.loadingScene = '';
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// 本地预览（跑的就是运行时那份模拟）
// ---------------------------------------------------------------------------
function effectiveAnchor() {
  const au = S.doc && S.doc.authoring;
  if (au && au.anchor && Number.isFinite(au.anchor.x)) return au.anchor;
  const sp = (S.marks || []).find((m) => m.kind === 'spawn');
  if (sp) return { x: sp.scene[0], y: sp.scene[1], h: 0 };
  if (S.cal) return { x: S.cal.worldW / 2, y: S.cal.worldH * 0.7, h: 0 };
  return { x: 0, y: 0, h: 0 };
}
function anchorWorld() {
  if (!S.space) return null;
  try { return S.space.anchorToWorld(effectiveAnchor()); } catch (e) { return null; }
}

function rebuildSim() {
  S.sim = null; S.simErr = ''; S.simTime = 0; S.frames = 0;
  S.evCount = { sound: 0, field: 0, hit: 0, flockState: 0 }; S.lastFlock = '';
  if (!S.rt || !S.space || !S.doc) return;
  const a = anchorWorld(); if (!a) return;
  try {
    const snap = JSON.parse(JSON.stringify(S.doc));
    if (!Array.isArray(snap.emitters) || !snap.emitters.length) { S.simErr = '还没有发射器'; return; }
    S.sim = new S.rt.vfxSim.VfxInstanceSim(snap.id || 'preview', snap, a, S.seed >>> 0, S.space, 1);
  } catch (e) {
    S.simErr = String(e && e.message || e);
  }
}
/** 拖拽中的便宜同步：只挪那些缓存在运行态里的量（原点 / 巢中心），不重建池子（否则一拖就闪回 t=0） */
function patchSim() {
  if (!S.sim || !S.doc) return;
  const a = anchorWorld(); if (!a) return;
  for (const e of S.sim.emitters) {
    const def = (S.doc.emitters || []).find((x) => x.id === e.def.id); if (!def) continue;
    const off = def.offset || [0, 0, 0];
    e.origin[0] = a[0] + off[0]; e.origin[1] = a[1] + off[1]; e.origin[2] = a[2] + off[2];
    if (e.flock) { e.flock.center[0] = e.origin[0]; e.flock.center[1] = e.origin[1]; e.flock.center[2] = e.origin[2]; }
  }
}

function playerCtx() {
  if (!S.player.on || !S.player.world) return null;
  return { world: S.player.world, speed: S.player.speed };
}
/** 玩家动静场（常驻、跟随）——与 `VfxSystem.update` 那一段同式 */
function updatePlayerField() {
  if (!S.rt) return;
  if (!S.player.on || !S.player.world) {
    if (S.playerField) { const i = S.fields.indexOf(S.playerField); if (i >= 0) S.fields.splice(i, 1); S.playerField = null; }
    return;
  }
  const w = S.player.world;
  const at = [w[0], w[1] + PLAYER_MOTION_HEIGHT_WU, w[2]];
  const strength = Math.min(1.5, S.player.speed / PLAYER_MOTION_FULL_SPEED);
  if (!S.playerField) {
    S.playerField = S.rt.vfxSim.createFieldRuntime(
      { kind: 'fear', tag: 'player:motion', radius: PLAYER_MOTION_RADIUS_WU, strength }, at, 'player:motion');
    S.fields.push(S.playerField);
  } else {
    S.playerField.pos[0] = at[0]; S.playerField.pos[1] = at[1]; S.playerField.pos[2] = at[2];
    S.playerField.def = Object.assign({}, S.playerField.def, { strength });
  }
}

function stepSim(dt) {
  if (!S.sim) return;
  updatePlayerField();
  for (let i = S.fields.length - 1; i >= 0; i--) {
    const f = S.fields[i];
    if (f.remaining === Infinity) continue;
    f.remaining -= dt;
    if (f.remaining <= 0) { if (f === S.playerField) S.playerField = null; S.fields.splice(i, 1); }
  }
  S.sim.step(dt, { fields: S.fields, player: playerCtx(), time: S.simTime });
  S.simTime += dt; S.frames++;
  for (const ev of S.sim.events) {
    S.evCount[ev.type] = (S.evCount[ev.type] || 0) + 1;
    if (ev.type === 'flockState') S.lastFlock = `${ev.emitter}: ${ev.from} → ${ev.to}`;
    // 群体首次惊起会自己发一个 startle 场：跟运行时一样接回总线
    if (ev.type === 'field') S.fields.push(S.rt.vfxSim.createFieldRuntime(ev.def, ev.at));
  }
  // 玩家速度自然衰减（松开鼠标就不动了）
  S.player.speed *= 0.86;
}
/** 播放心跳用 setInterval（rAF 在隐藏页 / 无头壳里不跑，用它飞行 / 播放就"卡住"） */
function setPlaying(on) {
  S.playing = !!on;
  if (simTimer) { clearInterval(simTimer); simTimer = 0; }
  if (S.playing) {
    let last = performance.now();
    simTimer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000) * S.speed; last = now;
      stepSim(dt); draw(); renderSimBar();
    }, 16);
  }
  renderSimBar();
}
function resetSim() { rebuildSim(); S.fields.length = 0; S.playerField = null; draw(); renderSimBar(); }

// ---------------------------------------------------------------------------
// 给视图看的东西（物体 / 球 / 粒子 / 场）
// ---------------------------------------------------------------------------
function emColor(i) { return EM_COLORS[i % EM_COLORS.length]; }
function cssOf(c) { return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`; }

function particlePoints() {
  const out = [];
  if (!S.sim) return out;
  S.sim.emitters.forEach((e, i) => {
    const p = e.p, pts = [];
    for (let k = 0; k < p.cap; k++) {
      if (!p.alive[k]) continue;
      pts.push(p.x[k], p.y[k], p.z[k]);
    }
    const c = emColor(i);
    out.push({ id: e.def.id, pts, color: c, css: cssOf(c), size: 5, sizeWu: e.def.appearance.sizeWu });
  });
  return out;
}

function objects() {
  const out = [];
  if (!S.doc) return out;
  const a = anchorWorld();
  // 发射器排在锚点前面：偏移为 0 时两者叠在同一点，点它应该拿到更常操作的那个
  //（想选锚点走左栏那一行，或者选中后拾取会优先保住当前选中项 —— 见各视图 `_hit`）
  (S.doc.emitters || []).forEach((em, i) => {
    if (!a) return;
    const off = em.offset || [0, 0, 0];
    const pos = [a[0] + off[0], a[1] + off[1], a[2] + off[2]];
    out.push({ key: `emitter:${em.id}`, label: `发射器 ${em.id}`, pos, color: emColor(i), size: 10, selected: S.sel.key === `emitter:${em.id}` });
  });
  if (a) out.push({ key: 'anchor', label: '预览锚点', pos: a, color: [1, 1, 1, 0.9], size: 9, selected: S.sel.key === 'anchor' });
  if (S.player.on && S.player.world) {
    out.push({ key: 'player', label: `玩家（${fmt(S.player.speed, 0)} wu/s）`, pos: S.player.world, color: [0.4, 0.8, 1, 1], size: 12, selected: S.sel.key === 'player' });
  }
  S.probes.forEach((p, i) => {
    out.push({ key: `probe:${i}`, label: `刺激 ${p.field.kind}:${p.field.tag}`, pos: p.at, color: p.field.kind === 'fear' ? [1, 0.4, 0.4, 1] : p.field.kind === 'attract' ? [0.6, 1, 0.6, 1] : [0.7, 0.8, 1, 1], size: 10, selected: S.sel.key === `probe:${i}` });
  });
  return out;
}

function spheres() {
  const out = [];
  if (!S.doc) return out;
  const a = anchorWorld(); if (!a) return out;
  for (const em of (S.doc.emitters || [])) {
    const be = em.behavior; if (!be || !be.home) continue;
    const off = em.offset || [0, 0, 0];
    const c = [a[0] + off[0], a[1] + off[1], a[2] + off[2]];
    const rows = [['nest', be.home.nestRadius, [1, 0.85, 0.4, 0.55], '巢'],
      ['range', be.home.rangeRadius, [0.45, 0.75, 1, 0.35], '活动域'],
      ['startle', be.home.startleRadius, [1, 0.45, 0.45, 0.45], '惊起']];
    for (const [k, r, col, lab] of rows) {
      const key = `${k}:${em.id}`;
      out.push({ key, center: c, radius: r || 0, color: col, hot: S.sel.key === key, label: `${lab}半径`, emitter: em.id, field: k });
    }
  }
  return out;
}

function fieldMarks() {
  return S.fields.map((f) => ({
    at: [f.pos[0], f.pos[1], f.pos[2]], radius: f.def.radius,
    color: f.def.kind === 'fear' ? [1, 0.4, 0.4, 1] : f.def.kind === 'attract' ? [0.6, 1, 0.6, 1] : [0.7, 0.8, 1, 1],
  }));
}

// ---------------------------------------------------------------------------
// gizmo 主机接口
// ---------------------------------------------------------------------------
function currentEmitter() {
  if (!S.doc) return null;
  const m = /^(emitter|nest|range|startle):(.+)$/.exec(S.sel.key || '');
  const id = m ? m[2] : (S.doc.emitters && S.doc.emitters[0] ? S.doc.emitters[0].id : '');
  return (S.doc.emitters || []).find((e) => e.id === id) || null;
}
function radiusOf(key) {
  const m = /^(nest|range|startle):(.+)$/.exec(key || ''); if (!m) return null;
  const em = (S.doc.emitters || []).find((e) => e.id === m[2]); if (!em || !em.behavior || !em.behavior.home) return null;
  const field = { nest: 'nestRadius', range: 'rangeRadius', startle: 'startleRadius' }[m[1]];
  return { em, home: em.behavior.home, field, label: { nest: '巢半径', range: '活动域半径', startle: '惊起半径' }[m[1]] };
}

function gizmoPivot() {
  const key = S.sel.key; if (!key) return null;
  const a = anchorWorld();
  if (key === 'anchor') return a ? { pivot: a, kind: 'start', n: 1, label: '预览锚点' } : null;
  if (key === 'player') return S.player.world ? { pivot: S.player.world.slice(), kind: 'slot', n: 1, label: '玩家标记' } : null;
  const pm = /^probe:(\d+)$/.exec(key);
  if (pm) { const p = S.probes[+pm[1]]; return p ? { pivot: p.at.slice(), kind: 'points', n: 1, label: `刺激 · ${p.field.kind}:${p.field.tag}` } : null; }
  const em = /^emitter:(.+)$/.exec(key);
  if (em) {
    const d = (S.doc.emitters || []).find((x) => x.id === em[1]); if (!d || !a) return null;
    const off = d.offset || [0, 0, 0];
    return { pivot: [a[0] + off[0], a[1] + off[1], a[2] + off[2]], kind: 'points', n: 1, label: `发射器 · ${d.id}` };
  }
  const r = radiusOf(key);
  if (r && a) {
    const off = r.em.offset || [0, 0, 0];
    // n=2 才给缩放 gizmo（`Gizmo.geom` 对单选强制 move）；半径只有缩放有意义
    return { pivot: [a[0] + off[0], a[1] + off[1], a[2] + off[2]], kind: 'points', n: 2, mode: 'scale',
      label: `${r.label} ${fmt(r.home[r.field], 0)} · ${r.em.id}` };
  }
  return null;
}
function gizmoLabel() {
  const key = S.sel.key;
  if (key === 'anchor') return '移动锚点';
  if (key === 'player') return '移动玩家';
  if (/^probe:/.test(key)) return '移动刺激点';
  const r = radiusOf(key); if (r) return `改${r.label}`;
  return '移动发射器';
}
function gizmoBase(key) {
  const a = anchorWorld();
  if (key === 'anchor') {
    if (!a || !S.space) return null;
    const an = effectiveAnchor();
    // 落笔那张面上的那一点（h=0）：XZ 拖的是它，h 是它之上的高度
    let surfPos;
    try { surfPos = S.space.anchorToWorld(Object.assign({}, an, { h: 0 })); } catch (e) { return null; }
    return { kind: 'anchor', pos: a.slice(), anchor: JSON.parse(JSON.stringify(an)), surfPos: surfPos.slice(), h: an.h || 0 };
  }
  if (key === 'player') return S.player.world ? { kind: 'player', pos: S.player.world.slice() } : null;
  const pm = /^probe:(\d+)$/.exec(key || '');
  if (pm) { const p = S.probes[+pm[1]]; return p ? { kind: 'probe', idx: +pm[1], pos: p.at.slice() } : null; }
  const em = /^emitter:(.+)$/.exec(key || '');
  if (em) {
    const d = (S.doc.emitters || []).find((x) => x.id === em[1]); if (!d || !a) return null;
    const off = (d.offset || [0, 0, 0]).slice();
    return { kind: 'emitter', id: d.id, offset: off, pos: [a[0] + off[0], a[1] + off[1], a[2] + off[2]] };
  }
  const r = radiusOf(key || '');
  if (r && a) {
    const off = r.em.offset || [0, 0, 0];
    return { kind: 'radius', id: r.em.id, field: r.field, radius: r.home[r.field] || 0, pos: [a[0] + off[0], a[1] + off[1], a[2] + off[2]] };
  }
  return null;
}
/** gizmo 拖拽结果（模型空间的累计量）→ doc / UI 态。位移一律是**相对手势起点**的累计量。 */
function applyGizmo(key, base, res) {
  if (!base) return;
  if (base.kind === 'radius') {
    if (res.kind !== 'scale') return;
    const k = res.k.all != null ? res.k.all : ['x', 'y', 'z'].map((c) => res.k[c]).find((x) => Number.isFinite(x));
    if (!Number.isFinite(k)) return;
    const r = radiusOf(key); if (!r) return;
    r.home[r.field] = Math.max(1, round2(base.radius * k));
    return;
  }
  if (res.kind !== 'move') return;
  const v = [res.v.x || 0, res.v.y || 0, res.v.z || 0];
  if (!v.every(Number.isFinite)) return;               // 非有限数一律进不了 doc
  if (base.kind === 'emitter') {
    const d = (S.doc.emitters || []).find((x) => x.id === base.id); if (!d) return;
    const o = [round2(base.offset[0] + v[0]), round2(base.offset[1] + v[1]), round2(base.offset[2] + v[2])];
    if (o[0] === 0 && o[1] === 0 && o[2] === 0) delete d.offset; else d.offset = o;
    return;
  }
  if (base.kind === 'player') { setPlayerAt([base.pos[0] + v[0], base.pos[1] + v[1], base.pos[2] + v[2]], true); return; }
  if (base.kind === 'probe') {
    const p = S.probes[base.idx]; if (!p) return;
    p.at = [round2(base.pos[0] + v[0]), round2(base.pos[1] + v[1]), round2(base.pos[2] + v[2])];
    return;
  }
  if (base.kind === 'anchor') setAnchorWorld(v, base);
}

/**
 * 锚点位移（gizmo 给的是**相对手势起点的累计量** v）→ 锚点（画面点 + 离表面高度）。
 *
 * 拆成两半，因为锚点本来就是"画面点 + 离面高"两段：
 *   XZ（v.x / v.z）挪的是**落笔的那张面上的那一点**（`base.surfPos` = h=0 时的世界点），
 *     投回画面就是新的 `anchor.x/y`（往返判据由 `checkAlignment` 的 dRound 兜着）；
 *   Y（v.y）改的是 `h`（离表面高度，不许负）。
 * `surface==='shell'` 时那张面是深度壳（贴崖壁的巢），`'ground'` 时是行走面，各自的点用各自的面取。
 */
function setAnchorWorld(v, base) {
  const cal = S.cal; if (!cal || !base) return;
  const a = ensureAnchor();
  const surface = (base.anchor && base.anchor.surface) || 'ground';
  const sp = [base.surfPos[0] + v[0], base.surfPos[1], base.surfPos[2] + v[2]];
  if (surface !== 'shell') sp[1] = cal.groundHeight(sp[0], sp[2]);
  const s = cal.worldToScene(sp[0], sp[1], sp[2]);
  if (!Number.isFinite(s[0]) || !Number.isFinite(s[1])) return;
  a.x = round2(s[0]); a.y = round2(s[1]);
  a.h = Math.max(0, round2((base.h || 0) + v[1]));
}
function ensureAuthoring() { if (!S.doc.authoring) S.doc.authoring = {}; return S.doc.authoring; }
function ensureAnchor() {
  const au = ensureAuthoring();
  if (!au.anchor) au.anchor = JSON.parse(JSON.stringify(effectiveAnchor()));
  return au.anchor;
}
function reanchor() { rebuildSim(); draw(); }

/** 3D 里直接拖物体（不经 gizmo）：落到光标下的表面 / 地面上 */
function dragObjectTo(key, base, surf, alt) {
  if (!base || !surf) return;
  if (base.kind === 'emitter') {
    const a = anchorWorld(); if (!a) return;
    const d = (S.doc.emitters || []).find((x) => x.id === base.id); if (!d) return;
    d.offset = [round2(surf.p[0] - a[0]), round2(surf.p[1] - a[1]), round2(surf.p[2] - a[2])];
    return;
  }
  if (base.kind === 'anchor') { setAnchorAt(alt ? { p: surf.p, onShell: false } : surf); return; }
  if (base.kind === 'player') { setPlayerAt(surf.p, true); return; }
  if (base.kind === 'probe') { const p = S.probes[base.idx]; if (p) p.at = surf.p.map(round2); }
}
/** 2D 原画里直接拖物体：画面点 → 表面点 */
function dragObjectToScene(key, base, scenePt) {
  const cal = S.cal; if (!cal || !base) return;
  const preferShell = base.kind === 'anchor' && (effectiveAnchor().surface === 'shell');
  const w = preferShell ? cal.sceneToWorldShell(scenePt[0], scenePt[1]) : cal.sceneToWorldGround(scenePt[0], scenePt[1]);
  if (base.kind === 'anchor') {
    const a = ensureAnchor();
    a.x = round2(scenePt[0]); a.y = round2(scenePt[1]);
    return;
  }
  dragObjectTo(key, base, { p: w, onShell: preferShell }, false);
}

function nudgeSelected(dx, dy, dz) {
  const base = gizmoBase(S.sel.key); if (!base) return;
  edit('微移', () => applyGizmo(S.sel.key, base, { kind: 'move', v: { x: dx, y: dy, z: dz } }));
}

// ---------------------------------------------------------------------------
// 作者操作
// ---------------------------------------------------------------------------
function setAnchorAt(surf) {
  const cal = S.cal; if (!cal || !S.doc) return;
  edit('放预览锚点', () => {
    const a = ensureAnchor();
    if (surf.onShell) {
      a.surface = 'shell';
      const s = cal.worldToScene(surf.p[0], surf.p[1], surf.p[2]);
      a.x = round2(s[0]); a.y = round2(s[1]); a.h = 0;
    } else {
      delete a.surface;
      const gy = cal.groundHeight(surf.p[0], surf.p[2]);
      const s = cal.worldToScene(surf.p[0], gy, surf.p[2]);
      a.x = round2(s[0]); a.y = round2(s[1]); a.h = Math.max(0, round2(surf.p[1] - gy));
    }
  });
  S.sel.key = 'anchor';
  setTool('select');
}
function setAnchorScene(sx, sy) {
  const cal = S.cal; if (!cal || !S.doc) return;
  const a0 = effectiveAnchor();
  edit('放预览锚点', () => {
    const a = ensureAnchor();
    a.x = round2(sx); a.y = round2(sy);
    if (a0.h != null) a.h = a0.h;
  });
  S.sel.key = 'anchor';
  setTool('select');
}
/** 放 / 挪玩家标记（UI 态，不进 doc）：走动时自动带出 player:motion 场 */
function setPlayerAt(world, keepTool) {
  const cal = S.cal; if (!cal) return;
  const gy = cal.groundHeight(world[0], world[2]);
  const w = [world[0], gy, world[2]];
  if (S.player.world) {
    const d = Math.hypot(w[0] - S.player.world[0], w[2] - S.player.world[2]);
    S.player.speed = Math.min(600, Math.max(S.player.speed, d * 12));   // 拖得快 = 走得快
  }
  S.player.on = true; S.player.world = w;
  S.player.scene = cal.worldToScene(w[0], w[1], w[2]);
  if (!keepTool) { S.sel.key = 'player'; setTool('select'); }
  draw(); renderLeft();
}
function clearPlayer() { S.player.on = false; S.player.world = null; S.player.speed = 0; if (S.sel.key === 'player') S.sel.key = ''; updatePlayerField(); draw(); renderLeft(); }

/** 发一个刺激：本地立刻进场总线（预览看得见），同时推给游戏 */
function addFieldAt(world) {
  const kind = el('fieldKind').value || 'fear';
  const tag = (el('fieldTag').value || '').trim() || (kind === 'wind' ? 'wind' : 'item:bug');
  const radius = num(el('fieldRadius').value, 260);
  const strength = num(el('fieldStrength').value, 1);
  const duration = num(el('fieldDuration').value, 0);
  const def = { kind, tag, radius, strength };
  if (duration > 0) def.duration = duration;
  if (kind === 'wind') def.direction = [1, 0, 0];
  const at = world.map(round2);
  S.probes.push({ at, field: def });
  S.sel.key = `probe:${S.probes.length - 1}`;
  fireField(S.probes.length - 1);
  setTool('select');
}
function fireField(i) {
  const p = S.probes[i]; if (!p || !S.rt) return;
  S.fields.push(S.rt.vfxSim.createFieldRuntime(p.field, p.at));
  publishNow({ field: p.field, at: sceneAtOf(p.at) });
  status(`发了一个 ${p.field.kind}:${p.field.tag}（半径 ${fmt(p.field.radius, 0)} wu、强度 ${fmt(p.field.strength, 2)}）`, 'ok');
  draw(); renderLeft();
}
/** 世界点 → 给游戏的画面点 + 离地高（游戏侧用 `VfxSystem.sceneToWorld` 解回去） */
function sceneAtOf(at) {
  const cal = S.cal; if (!cal) return { x: 0, y: 0, h: 0 };
  const gy = cal.groundHeight(at[0], at[2]);
  const s = cal.worldToScene(at[0], gy, at[2]);
  return { x: round2(s[0]), y: round2(s[1]), h: Math.max(0, round2(at[1] - gy)) };
}
function removeProbe(i) { S.probes.splice(i, 1); if (S.sel.key === `probe:${i}`) S.sel.key = ''; draw(); renderLeft(); }

// ---- 发射器列表操作
function uniqueEmitterId(base) {
  const used = new Set((S.doc.emitters || []).map((e) => e.id));
  if (!used.has(base)) return base;
  let n = 2; while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}
function addEmitter() {
  edit('加发射器', () => {
    const id = uniqueEmitterId('emitter');
    S.doc.emitters = S.doc.emitters || [];
    S.doc.emitters.push({
      id,
      appearance: { image: (S.sources.images[0] || '/resources/runtime/images/vfx/dust.png'), sizeWu: 6, lit: true },
      spawn: { max: 30, rate: 6, shape: { kind: 'sphere', radius: 20 }, speed: [10, 30] },
      motion: { drag: 0.6 },
      life: { seconds: [1.5, 3] },
    });
    S.sel.key = `emitter:${id}`;
  });
}
function dupEmitter(id) {
  edit('复制发射器', () => {
    const i = (S.doc.emitters || []).findIndex((e) => e.id === id); if (i < 0) return;
    const copy = JSON.parse(JSON.stringify(S.doc.emitters[i]));
    copy.id = uniqueEmitterId(id);
    if (copy.collision && copy.collision.onHit) delete copy.collision.onHit;   // 引用要作者重指，不静默复制
    S.doc.emitters.splice(i + 1, 0, copy);
    S.sel.key = `emitter:${copy.id}`;
  });
}
function delEmitter(id) {
  const users = (S.doc.emitters || []).filter((e) => e.collision && e.collision.onHit && e.collision.onHit.emitter === id).map((e) => e.id);
  if (users.length) { status(`删不了「${id}」：${users.join(' / ')} 的撞击子发射还指着它（先改掉）`, 'err'); return; }
  edit('删发射器', () => {
    S.doc.emitters = (S.doc.emitters || []).filter((e) => e.id !== id);
    if (S.sel.key.endsWith(`:${id}`)) S.sel.key = '';
  });
}
function moveEmitter(id, dir) {
  edit('重排发射器', () => {
    const arr = S.doc.emitters || [];
    const i = arr.findIndex((e) => e.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  });
}
function renameEmitter(oldId, newId) {
  const arr = S.doc.emitters || [];
  if (arr.some((e) => e.id === newId)) { status(`已经有一个发射器叫「${newId}」`, 'err'); return; }
  const em = arr.find((e) => e.id === oldId); if (!em) return;
  em.id = newId;
  for (const e of arr) if (e.collision && e.collision.onHit && e.collision.onHit.emitter === oldId) e.collision.onHit.emitter = newId;
  if (S.sel.key === `emitter:${oldId}`) S.sel.key = `emitter:${newId}`;
}

// ---------------------------------------------------------------------------
// 编辑 / 历史 / 手势
// ---------------------------------------------------------------------------
/** 一次原子编辑：只有真改了 doc 才入历史、才标脏 */
function edit(label, fn) {
  if (!S.doc) return false;
  const changed = history.commit(label, fn);
  touchDoc();
  rebuildSim();
  refreshDirty(); renderAll(); schedulePublish();
  if (changed) status(`${label}`, '');
  return changed;
}
function dragBegin(label) {
  if (!S.doc) return;
  S.dragDoc = S.doc;
  history.beginDrag(label);
}
function dragTick(fn) {
  if (S.dragDoc !== S.doc) return;                    // doc 被整份换掉：这次手势作废（不回滚）
  fn();
  touchDoc(); patchSim(); refreshDirty(); draw(); renderSimBar();
}
function dragEnd() {
  if (!history.inDrag()) return;
  const changed = history.endDrag();
  S.dragDoc = null;
  if (changed) { rebuildSim(); refreshDirty(); renderAll(); schedulePublish(); }
  else { draw(); }
}
function dropGestures() {
  if (v3) v3.drag = null;
  if (v2) v2.drag = null;
  history.discardDrag();
  S.dragDoc = null;
}

function select(key) {
  if (S.sel.key === key) { draw(); return; }
  S.sel.key = key || '';
  const r = radiusOf(S.sel.key);
  if (r) S.gizmoMode = 'scale';                        // 半径只有缩放有意义
  else if (S.gizmoMode === 'scale') S.gizmoMode = 'move';
  renderLeft(); renderInspector(); draw();
}
function setTool(t) {
  S.tool = t;
  for (const b of document.querySelectorAll('#tools button[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
  draw();
}

// ---------------------------------------------------------------------------
// 资产 IO
// ---------------------------------------------------------------------------
async function refreshEffects() {
  const j = await API.json('/api/effects');
  S.effects = j.effects || [];
  const sel = el('effectSel');
  sel.textContent = '';
  for (const r of S.effects) {
    const bad = r.error ? ' ⚠' : '';
    sel.appendChild(h('option', { value: r.id }, `${r.id}${r.label ? ` · ${r.label}` : ''}${bad}`));
  }
  if (S.doc) sel.value = S.doc.id;
}

async function openEffect(id) {
  if (S.busy) { status('装载中，等一下', 'warn'); return; }
  if (S.dirty && !await confirmDialog(`「${S.doc.id}」有未保存的改动`, '丢弃改动并打开另一份？')) { el('effectSel').value = S.doc.id; return; }
  setBusy(true, `打开「${id}」…`);
  const snapshot = { doc: S.doc, dirty: S.dirty, cleanKey: S.cleanKey };
  try {
    const j = await API.json(`/api/effect?id=${encodeURIComponent(id)}`);
    dropGestures();
    S.doc = j.doc;
    S.sel.key = '';
    history.clear();
    markClean();
    touchDoc();
    S.probes.length = 0; S.fields.length = 0; S.playerField = null;
    await syncEnvWithDoc();
    rebuildSim();
    renderAll();
    el('effectSel').value = id;
    status(`打开「${id}」`, 'ok');
  } catch (e) {
    S.doc = snapshot.doc; S.dirty = snapshot.dirty; S.cleanKey = snapshot.cleanKey;
    status(`打不开「${id}」：${e && e.message || e}`, 'err');
    if (S.doc) el('effectSel').value = S.doc.id;
  } finally { setBusy(false); }
}

/** 重开现场：doc 里记着作者场景就装它（装不上不拦着干活，状态栏说一句） */
async function syncEnvWithDoc() {
  const au = S.doc && S.doc.authoring;
  const want = au && au.sceneId ? au.sceneId : (S.scene ? S.scene.id : (S.scenes[0] ? S.scenes[0].id : ''));
  const bg = au && au.background ? au.background : '';
  if (!want) return;
  if (S.scene && S.scene.id === want && (!bg || S.scene.background === bg)) return;
  await loadScene(want, bg);
}

async function saveEffect() {
  if (!S.doc) return;
  if (S.busy) { status('装载中不存盘（doc 与画布还没对上）', 'warn'); return; }
  const revAt = S.rev;
  const id = S.doc.id;
  return runIO(async () => {
    try {
      const r = await API.post('/api/save', { doc: S.doc });
      if (S.rev !== revAt || !S.doc || S.doc.id !== id) {
        status('保存期间又有改动，再按一次 Ctrl+S', 'warn');
        return;
      }
      // 保存成功后 doc 是服务端返回的新对象：必须 renderAll 重建检视器（旧闭包绑着孤儿对象）
      S.doc = r.doc;
      history.clear();
      markClean();
      touchDoc();
      rebuildSim();
      await refreshEffects();
      el('effectSel').value = S.doc.id;
      renderAll(); schedulePublish();
      status(`已存 ${r.path}${(r.warnings || []).length ? ' ⚠ ' + r.warnings.join('；') : ''}`, (r.warnings || []).length ? 'warn' : 'ok');
    } catch (e) {
      status(`存不了：${e && e.message || e}`, 'err');
    }
  });
}

async function newEffect() {
  const v = await promptDialog('新建效果', 'id（= 文件名）', suggestId('新效果'));
  if (!v) return;
  return runIO(async () => {
    try {
      await API.post('/api/create', { id: v, sceneId: S.scene ? S.scene.id : '', background: S.scene ? S.scene.background : '' });
      await refreshEffects();
      await openEffect(v);
    } catch (e) { status(`新建失败：${e && e.message || e}`, 'err'); }
  });
}
async function duplicateEffect() {
  if (!S.doc) return;
  const v = await promptDialog('复制效果', '新 id', suggestId(S.doc.id + '_2'));
  if (!v) return;
  return runIO(async () => {
    try { await API.post('/api/duplicate', { id: S.doc.id, to: v }); await refreshEffects(); await openEffect(v); }
    catch (e) { status(`复制失败：${e && e.message || e}`, 'err'); }
  });
}
async function renameEffect() {
  if (!S.doc) return;
  if (S.dirty) { status('先保存再改名（改名只动磁盘上那份）', 'warn'); return; }
  const v = await promptDialog('改名', '新 id', S.doc.id);
  if (!v || v === S.doc.id) return;
  return runIO(async () => {
    try { await API.post('/api/rename', { id: S.doc.id, to: v }); await refreshEffects(); await openEffect(v); }
    catch (e) { status(`改名失败：${e && e.message || e}`, 'err'); }
  });
}
async function deleteEffect() {
  if (!S.doc) return;
  const id = S.doc.id;
  const used = (S.sceneVfx || []).filter((v) => v.effect === id).map((v) => v.id);
  if (!await confirmDialog(`删除「${id}」`, used.length ? `本场景有实例还引用着它：${used.join(' / ')}。真的删？` : '删了就没了（主编辑器里引用它的实例会装不到）')) return;
  return runIO(async () => {
    try {
      await API.post('/api/delete', { id });
      await refreshEffects();
      if (S.effects.length) { S.dirty = false; await openEffect(S.effects[0].id); }
      else { S.doc = null; renderAll(); }
      status(`已删「${id}」`, 'ok');
    } catch (e) { status(`删不了：${e && e.message || e}`, 'err'); }
  });
}
function suggestId(base) {
  const used = new Set(S.effects.map((r) => r.id));
  if (!used.has(base)) return base;
  let n = 2; while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

// ---------------------------------------------------------------------------
// 页内对话框（不用 prompt()）
// ---------------------------------------------------------------------------
function dialog(build) {
  return new Promise((resolve) => {
    const form = el('dialogForm');
    form.textContent = '';
    const done = (v) => { el('dialog').hidden = true; form.textContent = ''; resolve(v); };
    build(form, done);
    el('dialog').hidden = false;
    const first = form.querySelector('input, button');
    if (first) first.focus();
    form.onsubmit = (e) => { e.preventDefault(); const inp = form.querySelector('input'); done(inp ? inp.value.trim() : true); };
  });
}
function promptDialog(title, label, def) {
  return dialog((form, done) => {
    const inp = h('input', { type: 'text', value: def || '' });
    form.append(h('h3', {}, title), h('div', { class: 'row' }, h('span', {}, label), inp),
      h('div', { class: 'btns' }, h('button', { type: 'button', onclick: () => done('') }, '取消'),
        h('button', { class: 'primary', type: 'submit' }, '确定')));
  });
}
function confirmDialog(title, msg) {
  return dialog((form, done) => {
    form.append(h('h3', {}, title), h('p', {}, msg),
      h('div', { class: 'btns' }, h('button', { type: 'button', onclick: () => done(false) }, '取消'),
        h('button', { class: 'primary', type: 'button', onclick: () => done(true) }, '确定')));
  });
}

// ---------------------------------------------------------------------------
// 联动
// ---------------------------------------------------------------------------
function schedulePublish() {
  if (!S.link.on) return;
  if (pubTimer) clearTimeout(pubTimer);
  pubTimer = setTimeout(() => { pubTimer = 0; void publishNow(null); }, PUBLISH_DEBOUNCE_MS);
}
async function publishNow(probe) {
  if (!S.link.on || !S.doc) return;
  try {
    const body = { effectId: S.doc.id, def: S.doc, sceneId: S.scene ? S.scene.id : '' };
    if (probe) body.probe = probe;
    const r = await API.post('/api/link/publish', body);
    S.link.lastPub = Date.now();
    S.link.rejected = r.ok ? '' : (r.err || '游戏没收到这份');
  } catch (e) {
    S.link.rejected = String(e && e.message || e);
  }
  renderLinkChip();
}
async function pollLink() {
  if (!S.link.on) { renderLinkChip(); return; }
  try {
    const r = await API.json('/api/link/status');
    S.link.status = r;
    S.link.gameUrl = r.gameUrl || '';
    if (!el('gameUrl').matches(':focus')) el('gameUrl').value = S.link.gameUrl;
    if (r.connected && Date.now() - S.link.lastPub > PUBLISH_KEEPALIVE_MS) void publishNow(null);
  } catch (e) {
    S.link.status = { ok: false, connected: false, err: String(e && e.message || e) };
  }
  renderLinkChip(); renderGamePanel();
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function draw() { if (S.view === 3 && v3 && v3.ok) v3.draw(); else if (v2) v2.draw(); }
function renderAll() { renderLeft(); renderInspector(); renderDocState(); renderSimBar(); draw(); }
function renderInspector() { Inspector.render(host, el('inspector')); }
function renderDocState() {
  el('docState').textContent = S.doc ? `${S.doc.id}${S.dirty ? ' ●未保存' : ''}` : '（没打开效果）';
  el('btnUndo').disabled = !history.canUndo;
  el('btnRedo').disabled = !history.canRedo;
  el('btnUndo').title = history.canUndo ? `撤销：${history.peekUndo()}` : '没有可撤销的';
  el('btnRedo').title = history.canRedo ? `重做：${history.peekRedo()}` : '没有可重做的';
}
function renderSimBar() {
  el('btnPlay').textContent = S.playing ? '⏸ 暂停' : '▶ 播放';
  const live = S.sim ? S.sim.liveCount : 0;
  const st = S.sim ? S.sim.state : '—';
  el('simInfo').textContent = S.simErr ? `⚠ 跑不起来：${S.simErr}`
    : !S.sim ? (S.rt ? (S.cal ? '（没有可跑的发射器）' : '这个场景没有深度载荷，跑不了本地预览') : `没有运行时包${S.rtErr ? '：' + S.rtErr : ''}`)
      : `t=${fmt(S.simTime, 2)}s · ${live} 只 · ${st} · 帧 ${S.frames}`
        + (S.evCount.hit ? ` · 撞 ${S.evCount.hit}` : '') + (S.evCount.sound ? ` · 声 ${S.evCount.sound}` : '')
        + (S.lastFlock ? ` · ${S.lastFlock}` : '');
}
function renderScenePickers() {
  const sel = el('sceneSel');
  if (sel.childElementCount !== S.scenes.length) {
    sel.textContent = '';
    for (const s of S.scenes) sel.appendChild(h('option', { value: s.id }, `${s.id}${s.depth ? '' : '（无深度）'}`));
  }
  if (S.scene) sel.value = S.scene.id;
  const bg = el('bgSel');
  bg.textContent = '';
  for (const b of ((S.scene && S.scene.backgrounds) || [])) bg.appendChild(h('option', { value: b }, b));
  if (S.scene) bg.value = S.scene.background;
  bg.hidden = !(S.scene && S.scene.backgrounds && S.scene.backgrounds.length > 1);
}
function renderSceneInfo() {
  const chip = el('sceneNote');
  if (!S.scene) { chip.textContent = '（没有场景）'; chip.className = 'chip off'; return; }
  const c = S.scene.cal;
  chip.textContent = `${S.scene.name || S.scene.id} · ${S.scene.background}`
    + (c ? `　wuPerQ ${fmt(c.wuPerQUnit, 1)} · 地面：${c.groundSource === 'ground_d' ? '行走面场' : '深度壳(近似)'}` : '　无深度')
    + alignText();
  chip.className = 'chip ' + (S.align && !S.align.ok ? 'bad' : S.scene.cal ? 'ok' : 'warn');
}
function renderLeft() {
  const list = el('emList');
  list.textContent = '';
  if (S.doc) {
    const a = effectiveAnchor();
    const explicit = !!(S.doc.authoring && S.doc.authoring.anchor);
    list.appendChild(h('div', { class: 'item' + (S.sel.key === 'anchor' ? ' on' : ''), onclick: () => select('anchor') },
      h('span', { class: 'ic' }, '⊕'),
      h('span', { class: 'name' }, `预览锚点${explicit ? '' : '（默认：出生点）'}`),
      h('span', { class: 'dim' }, `${fmt(a.x, 0)},${fmt(a.y, 0)}${a.surface === 'shell' ? ' 壳' : ''}`)));
  }
  for (const em of ((S.doc && S.doc.emitters) || [])) {
    const on = S.sel.key === `emitter:${em.id}` || S.sel.key.endsWith(`:${em.id}`);
    const row = h('div', { class: 'item' + (on ? ' on' : ''), onclick: () => select(`emitter:${em.id}`) },
      h('span', { class: 'ic' }, em.behavior ? '🕊' : em.subOnly ? '↳' : '✦'),
      h('span', { class: 'name' }, em.id),
      h('span', { class: 'dim' }, String(em.spawn ? em.spawn.max : 0)));
    list.appendChild(row);
    if (em.behavior && em.behavior.home) {
      for (const [k, lab] of [['nest', '巢半径'], ['range', '活动域'], ['startle', '惊起']]) {
        const key = `${k}:${em.id}`;
        list.appendChild(h('div', { class: 'item sub' + (S.sel.key === key ? ' on' : ''), onclick: () => select(key) },
          h('span', { class: 'ic' }, '◯'), h('span', { class: 'name' }, lab),
          h('span', { class: 'dim' }, fmt(em.behavior.home[{ nest: 'nestRadius', range: 'rangeRadius', startle: 'startleRadius' }[k]], 0))));
      }
    }
  }
  const pl = el('playerRow');
  pl.textContent = '';
  pl.appendChild(h('div', { class: 'item' + (S.sel.key === 'player' ? ' on' : ''), onclick: () => S.player.on && select('player') },
    h('span', { class: 'ic' }, '🚶'), h('span', { class: 'name' }, S.player.on ? `玩家（${fmt(S.player.speed, 0)} wu/s）` : '（没放玩家）'),
    S.player.on ? h('button', { class: 'danger', onclick: (e) => { e.stopPropagation(); clearPlayer(); } }, '×') : null));
  const pr = el('probeList');
  pr.textContent = '';
  S.probes.forEach((p, i) => {
    pr.appendChild(h('div', { class: 'item' + (S.sel.key === `probe:${i}` ? ' on' : ''), onclick: () => select(`probe:${i}`) },
      h('span', { class: 'ic' }, p.field.kind === 'fear' ? '⚡' : p.field.kind === 'attract' ? '✿' : '≋'),
      h('span', { class: 'name' }, `${p.field.kind}:${p.field.tag}`),
      h('button', { onclick: (e) => { e.stopPropagation(); fireField(i); } }, '再发'),
      h('button', { class: 'danger', onclick: (e) => { e.stopPropagation(); removeProbe(i); } }, '×')));
  });
  el('sceneUse').textContent = (S.sceneVfx || []).filter((v) => S.doc && v.effect === S.doc.id).map((v) => v.id).join(' / ')
    || '本场景没有实例引用它（主编辑器里摆）';
}
function renderLinkChip() {
  const chip = el('linkChip'), st = S.link.status;
  if (!S.link.on) { chip.textContent = '联动关'; chip.className = 'chip off'; return; }
  if (S.link.rejected) { chip.textContent = `游戏没收到：${S.link.rejected}`; chip.className = 'chip bad'; return; }
  if (!st || !st.connected) { chip.textContent = `连不上 dev server${st && st.err ? `（${st.err}）` : ''}`; chip.className = 'chip off'; return; }
  if (!st.gameAlive) { chip.textContent = 'dev server 在，游戏页没开'; chip.className = 'chip warn'; return; }
  const d = st.doc || {};
  const mine = (d.instances || []).length;
  chip.textContent = `游戏在「${d.sceneId || '?'}」· ${mine} 个实例引用「${d.effectId || ''}」· 已套用#${d.appliedRev || 0}`;
  chip.className = 'chip ' + (d.appliedRev ? 'ok' : 'warn');
}
function renderGamePanel() {
  const p = el('gamePanel'), st = S.link.status;
  p.textContent = '';
  if (!st || !st.connected) { p.appendChild(h('div', { class: 'pad dim' }, '游戏没在跑（工作台照常能改、能存）')); return; }
  const d = st.doc;
  if (!d) { p.appendChild(h('div', { class: 'pad dim' }, 'dev server 在，游戏页没回传')); return; }
  const kv = (k, v) => p.appendChild(h('div', { class: 'kv' }, h('span', {}, k), h('span', {}, String(v))));
  kv('场景', d.sceneId || '?');
  kv('空间', d.spaceKind === 'field' ? '真 3D（有载荷）' : d.spaceKind === 'planar' ? '⚠ 平面近似（载荷没到）' : '?');
  kv('已套用', `#${d.appliedRev || 0}`);
  for (const inst of (d.instances || [])) kv(inst.id, `${inst.state} · ${inst.live} 只${inst.eligible ? '' : ' · 条件不满足'}`);
  if (!(d.instances || []).length) kv('实例', '本场景没有实例引用这个效果');
  const s = d.stats || {};
  kv('stats', `${s.instances || 0} 实例 / ${s.live || 0} 只 / ${s.drawCalls || 0} 批 / ${s.fields || 0} 场 / ${fmt(s.simMs, 2)} ms`);
  if (d.playerScene) {
    let note = `${fmt(d.playerScene.x, 0)}, ${fmt(d.playerScene.y, 0)}`;
    if (S.cal && d.playerWorld) {
      const mine = S.cal.sceneToWorldGround(d.playerScene.x, d.playerScene.y);
      const dd = dist3(mine, d.playerWorld);
      note += dd < 5 ? `　坐标 ✓ Δ${fmt(dd, 2)} wu` : dd < 40 ? `　Δ${fmt(dd, 1)} wu` : `　⚠ 不是同一套坐标（Δ${fmt(dd, 0)} wu）`;
    }
    kv('玩家脚点', note);
  }
  kv('刺激已发', `#${d.probeSeqDone || 0}`);
  for (const other of (st.otherPages || [])) p.appendChild(h('div', { class: 'pad warn' }, `⚠ 另有游戏页也在回传：${other.href || other.writer}（关掉旧的）`));
}
function onCursorWorld(p) {
  if (!p || !S.cal) { el('coords').textContent = ''; return; }
  const s = S.cal.worldToScene(p[0], p[1], p[2]);
  el('coords').textContent = `画面 ${fmt(s[0], 0)}, ${fmt(s[1], 0)}\n世界 ${fmt(p[0], 0)}, ${fmt(p[1], 0)}, ${fmt(p[2], 0)}`;
}
function onCursorScene(s) {
  if (!S.cal) { el('coords').textContent = ''; return; }
  const w = S.cal.inScene(s[0], s[1]) ? S.cal.sceneToWorldGround(s[0], s[1]) : null;
  el('coords').textContent = `画面 ${fmt(s[0], 0)}, ${fmt(s[1], 0)}` + (w ? `\n地面 ${fmt(w[0], 0)}, ${fmt(w[1], 0)}, ${fmt(w[2], 0)}` : '');
}

function setView(n) {
  S.view = n;
  el('view3d').hidden = n !== 3;
  el('overlay3d').hidden = n !== 3;
  el('view2d').hidden = n !== 2;
  el('btnView3').classList.toggle('on', n === 3);
  el('btnView2').classList.toggle('on', n === 2);
  if (n === 3 && v3 && v3.ok) v3.resize(); else if (v2) v2.resize();
  draw();
}

// ---------------------------------------------------------------------------
// 键盘
// ---------------------------------------------------------------------------
function onKey(e) {
  if (S.busy) return;                                   // 装载门：这几秒里 doc 与画布本来就不一致
  if (!el('dialog').hidden) return;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (typing) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void saveEffect(); }
    return;
  }
  if (v3 && v3.capturesKeys()) return;                  // 按住右键飞行：键盘归相机
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); void saveEffect(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); const l = history.undo(); if (l) { touchDoc(); rebuildSim(); refreshDirty(); renderAll(); schedulePublish(); status(`撤销：${l}`); } return; }
  if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); const l = history.redo(); if (l) { touchDoc(); rebuildSim(); refreshDirty(); renderAll(); schedulePublish(); status(`重做：${l}`); } return; }
  if (e.ctrlKey || e.metaKey) return;
  if (k === 'v') { setTool('select'); return; }
  if (k === 'a') { setTool('anchor'); return; }
  if (k === 'm') { setTool('player'); return; }
  if (k === 'k') { setTool('field'); return; }
  if (k === 'h') { setTool('pan'); return; }
  if (k === 'w') { S.gizmoMode = 'move'; draw(); return; }
  if (k === 'e') { S.gizmoMode = 'rotate'; draw(); return; }
  if (k === 'r') { S.gizmoMode = 'scale'; draw(); return; }
  if (k === '1') { setView(3); return; }
  if (k === '2') { setView(2); return; }
  if (k === 'f') { focusSelected(); return; }
  if (e.key === 'Home') { if (S.view === 3 && v3 && v3.ok) v3.fit(false); else if (v2) v2.fit(); return; }
  if (e.key === ' ') { e.preventDefault(); setPlaying(!S.playing); return; }
  if (e.key === '.') { stepSim(1 / 60); draw(); renderSimBar(); return; }
  if (e.key === 'Delete') {
    const pm = /^probe:(\d+)$/.exec(S.sel.key);
    if (pm) { removeProbe(+pm[1]); return; }
    if (S.sel.key === 'player') { clearPlayer(); return; }
    const em = /^emitter:(.+)$/.exec(S.sel.key);
    if (em) { delEmitter(em[1]); return; }
    return;
  }
  const step = e.shiftKey ? 10 : 1;
  if (e.key === 'ArrowLeft') { nudgeSelected(-step, 0, 0); return; }
  if (e.key === 'ArrowRight') { nudgeSelected(step, 0, 0); return; }
  if (e.key === 'ArrowUp') { nudgeSelected(0, 0, step); return; }
  if (e.key === 'ArrowDown') { nudgeSelected(0, 0, -step); return; }
}
function focusSelected() {
  const pv = gizmoPivot();
  if (S.view === 3 && v3 && v3.ok) { if (pv) v3.focus(pv.pivot, 200); else v3.fit(false); return; }
  if (v2 && S.cal) { if (pv) v2.focus(S.cal.worldToScene(pv.pivot[0], pv.pivot[1], pv.pivot[2]), 400); else v2.fit(); }
}

// ---------------------------------------------------------------------------
// host（视图 / 检视器都只通过它读写）
// ---------------------------------------------------------------------------
const host = {
  get doc() { return S.doc; },
  get cal() { return S.cal; },
  get scene() { return S.scene; },
  get marks() { return S.marks; },
  get sel() { return S.sel; },
  get tool() { return S.tool; },
  get gizmoMode() { return S.gizmoMode; },
  get layers() { return S.layers; },
  get sources() { return S.sources; },
  get sfx() { return S.sfx; },
  status, select, setTool, edit, dragBegin, dragTick, dragEnd,
  objects, spheres, particlePoints, fieldMarks, anchorWorld,
  gizmoPivot, gizmoBase, applyGizmo, gizmoLabel, dragObjectTo, dragObjectToScene, nudgeSelected,
  setAnchorAt, setAnchorScene, setPlayerAt, addFieldAt,
  currentEmitter, renameEmitter, ensureAuthoring, ensureAnchor, reanchor,
  onCursorWorld, onCursorScene, renderInspector,
};

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function boot() {
  history = new History({
    get: () => S.doc,
    set: (d) => { S.doc = d; },
    onChange: () => renderDocState(),
  });
  v3 = new View3D(el('view3d'), el('overlay3d'), host);
  v2 = new View2D(el('view2d'), host);
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => { if (v3 && v3.ok) v3.resize(); if (v2) v2.resize(); });
  bindUI();
  setTool('select');
  setView(v3 && v3.ok ? 3 : 2);
  await loadRuntime();
  let boot0 = {};
  try { boot0 = await API.json('/api/boot'); } catch (e) { /* 服务刚起：下面照常 */ }
  if (boot0.bundle && !boot0.bundle.ok && boot0.bundle.err) S.rtErr = boot0.bundle.err;
  try { const j = await API.json('/api/scenes'); S.scenes = j.scenes || []; } catch (e) { S.scenes = []; }
  try { const j = await API.json('/api/anims'); S.sources = { anims: j.anims || [], images: j.images || [] }; } catch (e) { /* 候选空着 */ }
  try { const j = await API.json('/api/sfx'); S.sfx = j.sfx || []; } catch (e) { /* 同上 */ }
  await refreshEffects();
  renderScenePickers();
  const withDepth = S.scenes.find((s) => s.depth) || S.scenes[0];
  if (withDepth) await loadScene(withDepth.id, '');
  const openId = boot0.open || (S.effects[0] ? S.effects[0].id : '');
  if (openId) await openEffect(openId);
  renderAll();
  void pollLink();
  setInterval(() => { void pollLink(); }, STATUS_POLL_MS);
  window.__ready = true;
}

function bindUI() {
  el('effectSel').addEventListener('change', (e) => { void openEffect(e.target.value); });
  el('btnNew').addEventListener('click', () => { void newEffect(); });
  el('btnDup').addEventListener('click', () => { void duplicateEffect(); });
  el('btnRename').addEventListener('click', () => { void renameEffect(); });
  el('btnDelete').addEventListener('click', () => { void deleteEffect(); });
  el('btnSave').addEventListener('click', () => { void saveEffect(); });
  el('btnUndo').addEventListener('click', () => { const l = history.undo(); if (l) { touchDoc(); rebuildSim(); refreshDirty(); renderAll(); schedulePublish(); } });
  el('btnRedo').addEventListener('click', () => { const l = history.redo(); if (l) { touchDoc(); rebuildSim(); refreshDirty(); renderAll(); schedulePublish(); } });
  el('sceneSel').addEventListener('change', (e) => { void loadScene(e.target.value, ''); });
  el('bgSel').addEventListener('change', (e) => { void loadScene(S.scene.id, e.target.value); });
  el('btnBindScene').addEventListener('click', () => {
    if (!S.doc || !S.scene) return;
    edit('绑定作者场景', () => { const au = ensureAuthoring(); au.sceneId = S.scene.id; au.background = S.scene.background; });
  });
  el('btnView3').addEventListener('click', () => setView(3));
  el('btnView2').addEventListener('click', () => setView(2));
  el('btnFocus').addEventListener('click', () => focusSelected());
  el('btnFit').addEventListener('click', () => { if (S.view === 3 && v3 && v3.ok) v3.fit(false); else if (v2) v2.fit(); });
  el('btnPlay').addEventListener('click', () => setPlaying(!S.playing));
  el('btnStep').addEventListener('click', () => { stepSim(1 / 60); draw(); renderSimBar(); });
  el('btnReset').addEventListener('click', () => resetSim());
  el('seed').addEventListener('change', (e) => { S.seed = Math.max(0, Math.round(num(e.target.value, 1234))); resetSim(); });
  el('speed').addEventListener('change', (e) => { S.speed = clamp(num(e.target.value, 1), 0.05, 8); });
  el('btnAddEmitter').addEventListener('click', () => addEmitter());
  el('btnDupEmitter').addEventListener('click', () => { const em = currentEmitter(); if (em) dupEmitter(em.id); });
  el('btnDelEmitter').addEventListener('click', () => { const em = currentEmitter(); if (em) delEmitter(em.id); });
  el('btnUpEmitter').addEventListener('click', () => { const em = currentEmitter(); if (em) moveEmitter(em.id, -1); });
  el('btnDownEmitter').addEventListener('click', () => { const em = currentEmitter(); if (em) moveEmitter(em.id, 1); });
  el('btnRenameEmitter').addEventListener('click', async () => {
    const em = currentEmitter(); if (!em) return;
    const v = await promptDialog('改发射器名', 'id', em.id);
    if (v && v !== em.id) edit('改发射器 id', () => renameEmitter(em.id, v));
  });
  el('btnClearFields').addEventListener('click', () => { S.fields.length = 0; S.playerField = null; draw(); status('清了所有刺激场'); });
  el('btnLaunchGame').addEventListener('click', async () => {
    if (!S.scene) return;
    try { const r = await API.post('/api/link/launch', { sceneId: S.scene.id }); status(r.message || '已请求', r.ok ? 'ok' : 'err'); }
    catch (e) { status(`拉不起来：${e && e.message || e}`, 'err'); }
  });
  el('linkOn').addEventListener('change', (e) => { S.link.on = e.target.checked; if (S.link.on) schedulePublish(); renderLinkChip(); });
  el('gameUrl').addEventListener('change', async (e) => {
    try { await API.post('/api/link/config', { gameUrl: e.target.value }); S.link.lastPub = 0; void pollLink(); }
    catch (err) { status(`地址设不上：${err && err.message || err}`, 'err'); }
  });
  for (const k of Object.keys(S.layers)) {
    const box = el('layer_' + k); if (!box) continue;
    box.checked = S.layers[k];
    box.addEventListener('change', () => { S.layers[k] = box.checked; if (k === 'mesh' || k === 'dimMesh') { if (v2) v2.draw(); } draw(); });
  }
}

/** 桌面壳 `--open <id>` / 主编辑器打进来：装载门内与手势没松开时一律拒 */
window.__openEffect = (id) => {
  if (S.busy || history.inDrag()) { status('正在装载 / 手势没松开，稍后再试', 'warn'); return; }
  void openEffect(id);
};

window.addEventListener('DOMContentLoaded', () => { void boot(); });
