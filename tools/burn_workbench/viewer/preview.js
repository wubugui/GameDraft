'use strict';
/* 燃烧工作台 · 本地预览：跑的是打包进来的**运行时燃烧模拟本体**（`/gen/burn.bundle.js`），不是 JS 里另写的一份。
 *
 * 两份模拟，一条时间轴：
 * - **模板预览**（原画视图）：平面空间（`vfxSpace` 的 planar）里按模板**真实尺寸**摆一个实例——
 *   `burnableWorldSize` → `burnEntityPlacement` → `burnPlacementFrame` → `buildBurnWorldGrid`，火线速度就是准的。
 *   风 = 页面上的预览风（不写资源）。
 * - **场景视图**（从「用在哪」点开，只读）：那个场景里所有开了可燃的实体进**同一个** `BurnSceneSim`（跨实体蔓延看得到），
 *   各用各的模板（当前模板用工作态）；实体按自己的 transform 摆（`burnEntityPlacement`：x / y / scale / rotation / anchor，
 *   透视与朝向口径见 `entityPerspective` / `entityFacingLeft`）；世界映射用场景载荷 field 空间，没有就 planar；风 = 场景 JSON 那份。
 *   `initial: burning` 的实例在 0 秒点着（有着火点按第一个、没有整体点——与运行时 `BurnableHostDef.initial` 同口径）。
 * - 输入与游戏同形：`resolveBurnable`（工作态文档）→ 读图 `loadBurnImageData`（不预乘、长边 640，与游戏同一个函数）→ `buildBurnGrid`。
 * - 时间轴：外部事件记日志，拖动 = 新建模拟从 0 按日志推到那一刻（确定性，与游戏重放同一条路）。
 * - 站位：`igniteStancesFor`（挂件预设 + 玩家动画 + 场景透视系数），与游戏 `IgnitePerformer` 同一组纯函数。
 *
 * 摆放（`burnEntityPlacement` / `burnPlacementFrame`）与着色参数（`burnShadeParamsOf`）直接调运行时导出的纯函数，页面里不另拼。 */

const TEMPLATE_KEY = '__template__';
const P = {
  t: 0, playing: false, speed: 1, duration: 60,
  /** 模板预览：`{id, key, b, img, grid, placement, frame, world, sim}` 或 `{id, error}` */
  art: null, artSig: '', artBuilding: 0, artEvents: [],
  /** 场景视图：空间 / 透视 / 风 + 实例 + 模拟 */
  sc: { sceneId: '', space: null, spaceKind: 'none', persp: null, wind: null, geo: null, items: [], sim: null, problems: [], sig: '' },
  scBuilding: 0, scEvents: {},
  buildErr: '', buildPromise: null,
  imgCache: new Map(),
  query: null,
  lastFrameMs: 0,
};

async function loadRuntime() {
  try {
    S.rt = await import('/gen/burn.bundle.js');
    S.rtErr = '';
    P.query = S.rt.burnSim.createBurnCellQuery();
  } catch (e) {
    S.rt = null; S.rtErr = String((e && e.message) || e);
  }
  try {
    const r = await fetch('/gen/burnShade.glsl', { cache: 'no-store' });
    S.glsl = sliceGlsl(await r.text());
    S.glslErr = '';
  } catch (e) {
    S.glsl = ''; S.glslErr = String((e && e.message) || e);
  }
}

/** 与 `BurnFilters.sliceGlsl` 同一对标记 */
function sliceGlsl(src) {
  const b = '//__BURN_SHADE_BEGIN__', e = '//__BURN_SHADE_END__';
  const i = src.indexOf(b), j = src.indexOf(e);
  if (i < 0 || j < 0) throw new Error('burnShade.glsl 缺切片标记');
  return src.substring(i + b.length, j);
}

// ---------------------------------------------------------------------------
// 场景视图的世界空间（与粒子系统 / 游戏同一份）
// ---------------------------------------------------------------------------
function binField(buf) {
  const dv = new DataView(buf);
  const w = dv.getUint32(0, true), hh = dv.getUint32(4, true);
  return { w, h: hh, data: new Float32Array(buf, 8, w * hh) };
}
function buildSceneSpace(scene, groundBuf, shellBuf) {
  const rt = S.rt;
  const sc = P.sc;
  sc.space = null; sc.geo = null; sc.spaceKind = 'none'; sc.persp = null; sc.wind = null; sc.sceneId = scene ? scene.id : '';
  if (!rt || !scene) return;
  const ps = rt.perspectiveScale.createPerspectiveScaleResolver(scene.perspectiveScale);
  sc.persp = ps;
  // 与 `Game.buildVfxSpace` 同形：透视度量按用时取，没配恒 1
  const perspective = (x, y) => (ps ? ps.scaleAt(x, y) : 1);
  const cal = scene.cal;
  if (cal && groundBuf) {
    const g = binField(groundBuf);
    const rows = cal.R.flat();
    const geo = {
      work: { w: cal.work.w, h: cal.work.h }, cal: { ppu: cal.ppuWork, cx: cal.cxWork, cy: cal.cyWork },
      sceneWorld: { w: scene.worldWidth, h: scene.worldHeight }, basisRows: rows, wuPerQUnit: cal.wuPerQUnit,
      ground: { data: g.data, w: g.w, h: g.h },
    };
    let shell = null;
    if (shellBuf) {
      const s = binField(shellBuf);
      shell = rt.depthShellField.buildDepthShellField(s.data, s.w, s.h, { ppu: cal.ppuWork, cx: cal.cxWork, cy: cal.cyWork }, rows);
    }
    sc.space = rt.vfxSpace.createFieldVfxSpace({ geo, shell, viewDir: rt.sceneSpace.viewDirWorld(geo), perspective });
    sc.geo = geo;
    sc.spaceKind = 'field';
  } else {
    sc.space = rt.vfxSpace.createPlanarVfxSpace(rt.vfxSpace.DEFAULT_PLANAR_VFX_DEPTH_SCALE, perspective);
    sc.spaceKind = 'planar';
  }
  sc.wind = rt.sceneWind.resolveSceneWind(scene.wind);
}

/**
 * 透视系数吃不吃——照运行时实体本身（不另定口径）：
 * - 热点 `Hotspot.setPerspectiveScale`：`perspectiveScaleEnabled === true` 才参与（缺省不参与：多为贴背景绘制）；
 * - NPC `Npc.setPerspectiveScale`：`perspectiveScaleEnabled ?? !renderRaw`（缺省参与；抠图贴回原位的 renderRaw 不参与）。
 */
function entityPerspective(ent) {
  if (ent.kind === 'npc') return !!(ent.perspectiveScaleEnabled ?? !ent.renderRaw);
  return ent.perspectiveScaleEnabled === true;
}
/** 朝左（左右镜像）：热点 `displayImage.facing === 'left'`（`Hotspot` 展示图朝向）；NPC `initialFacing === 'left'`（`Npc.applyInitialFacing`） */
function entityFacingLeft(ent) {
  return ent.kind === 'npc' ? ent.initialFacing === 'left' : ent.displayFacing === 'left';
}

/**
 * 场景实体上的一个实例怎么摆：`burnEntityPlacement`（实体 x / y / scale / rotation / anchor + 模板真实尺寸 + 透视 + 朝向）。
 * 采样点：热点按实体 (x, y)（`Hotspot._refreshDepthScale`）；NPC 按接地点（`Npc._refreshDepthScale` 用 contactX/Y，
 * 缺省锚点时 = (x, y)；锚点不在底中时接地点本身含系数，按它迭代到不动——运行时是逐帧收敛到同一个不动点）。
 */
function entityPlacementOf(ent, b) {
  const g = S.rt.burnGeometry;
  const size = S.rt.burnables.burnableWorldSize(b);
  const flipX = entityFacingLeft(ent);
  const def = { x: Number(ent.x) || 0, y: Number(ent.y) || 0, scale: ent.scale, rotation: ent.rotation, anchor: ent.anchor };
  const ps = P.sc.persp;
  let f = 1;
  if (ps && entityPerspective(ent)) {
    f = ps.scaleAt(def.x, def.y);
    if (ent.kind === 'npc') {
      for (let k = 0; k < 8; k++) {
        const p = g.burnEntityPlacement(def, size, { depthScale: f, flipX });
        const f2 = ps.scaleAt(p.footX, p.footY);
        if (Math.abs(f2 - f) < 1e-9) break;
        f = f2;
      }
    }
  }
  const placement = g.burnEntityPlacement(def, size, { depthScale: f, flipX });
  return { placement, frame: g.burnPlacementFrame(placement), depthScale: f };
}
/** 交互半径（`Hotspot.effectiveInteractionRange` / `Npc` 同式）：半径 × 实例 scale × 透视系数（吃透视才乘） */
function interactionRadius(it) {
  const rt = S.rt;
  return (Number(it.ent.interactionRange) || 0) * (rt ? rt.entityTransform.entityScaleOf(it.ent) : 1) * it.depthScale;
}

/** 着色参数：运行时导出的 `burnShadeParams.burnShadeParamsOf`（与 `BurnSystem` 同一个函数） */
function shadeParamsOf(b, grid, clock) {
  return S.rt.burnShadeParams.burnShadeParamsOf(b, grid, clock);
}

/**
 * 燃烧场纹理的"代"：模拟的脏标记是读后清的，两个视图各有一张纹理——谁先读谁清，另一张就停在旧的上。
 * 所以脏标记只在这里读，按 (模拟, 实例) 记一个递增代号，纹理比代号决定要不要重编码。
 */
const TEX_GEN = new WeakMap();
function texGen(sim, key) {
  let m = TEX_GEN.get(sim);
  if (!m) { m = new Map(); TEX_GEN.set(sim, m); }
  let g = m.get(key) || 0;
  if (sim.takeDirty(key)) { g++; m.set(key, g); }
  return g;
}

function loadImg(url) {
  let p = P.imgCache.get(url);
  if (!p) {
    p = S.rt.burnImageData.loadBurnImageData(url).catch(() => null);
    P.imgCache.set(url, p);
    // 涂层每一笔都是一份新的 data URL：只留最近的几十份
    const dataKeys = [...P.imgCache.keys()].filter((k) => k.startsWith('data:'));
    while (dataKeys.length > 24) P.imgCache.delete(dataKeys.shift());
  }
  return p;
}

/** 原画视图的预览风（场景 JSON 同形：wu/s，1 m = 88 wu） */
function previewWind() {
  if (!S.rt || !(S.wind.mps > 0)) return null;
  return S.rt.sceneWind.resolveSceneWind({ direction: [S.wind.dir < 0 ? -1 : 1, 0, 0], speed: S.wind.mps * S.rt.burnables.BURN_WU_PER_M });
}

function makeSim(inputs, wind) {
  return new S.rt.burnSim.BurnSceneSim(inputs, { wind, windTimeAt: (t) => t }, 0);
}
function simInput(it, events) {
  return { key: it.key, burnable: it.b, grid: it.grid, worlds: [it.world], events: events.slice() };
}

let buildTimer = 0;
function schedulePreviewBuild(force) {
  if (buildTimer) clearTimeout(buildTimer);
  buildTimer = setTimeout(() => {
    buildTimer = 0;
    P.buildPromise = Promise.all([buildArt(force), buildScene(force)]).then(() => {
      P.buildErr = '';
      if (typeof onPreviewBuilt === 'function') onPreviewBuilt();
    }).catch((e) => { P.buildErr = String((e && e.message) || e); requestDraw(); });
  }, 60);
}

// ---------------------------------------------------------------------------
// 模板预览（原画视图）
// ---------------------------------------------------------------------------
async function buildArt(force) {
  const rt = S.rt, id = S.docId, raw = id ? S.docs[id] : null;
  if (!rt || !raw) { P.art = null; P.artSig = ''; return; }
  const sig = canonJson({ id, raw, wind: S.wind });
  if (!force && sig === P.artSig && P.art) return;
  const token = ++P.artBuilding;
  const b = rt.burnables.resolveBurnable(raw, id);
  if (!b) { P.art = { id, error: '模板读不懂：图没写，或真实尺寸（宽 / 高 cm）没写 / 不是正数——游戏里这份模板不建' }; P.artSig = sig; requestDraw(); return; }
  const [img, mask, order] = await Promise.all([loadImg(b.image), b.maskData ? loadImg(b.maskData) : null, b.orderData ? loadImg(b.orderData) : null]);
  if (token !== P.artBuilding || S.docId !== id) return;
  if (!img) { P.art = { id, error: `图读不出来：${b.image}` }; P.artSig = sig; requestDraw(); return; }
  const g = rt.burnGeometry;
  const size = rt.burnables.burnableWorldSize(b);
  const placement = g.burnEntityPlacement({ x: 0, y: 0 }, size, { depthScale: 1, flipX: false });
  const frame = g.burnPlacementFrame(placement);
  const space = rt.vfxSpace.createPlanarVfxSpace(rt.vfxSpace.DEFAULT_PLANAR_VFX_DEPTH_SCALE, null);
  const grid = rt.burnSim.buildBurnGrid(b, img, mask, order);
  const world = g.buildBurnWorldGrid(frame, b.orientation, space);
  const it = { id, key: TEMPLATE_KEY, b, img, grid, placement, frame, world, size, wind: previewWind(),
    maskErr: !!(b.maskData && !mask), orderErr: !!(b.orderData && !order) };
  P.art = it;
  P.artSig = sig;
  replayArt();
}
function replayArt() {
  const it = P.art;
  if (it && it.grid && S.rt) {
    it.sim = makeSim([simInput(it, P.artEvents)], it.wind);
    it.sim.advanceTo(P.t);
  }
  requestDraw();
}

// ---------------------------------------------------------------------------
// 场景视图
// ---------------------------------------------------------------------------
function sceneSig() {
  const sv = S.sv;
  if (!sv || !sv.scene) return '';
  const used = {};
  for (const ent of sv.scene.entities) if (S.docs[ent.template]) used[ent.template] = S.docs[ent.template];
  return canonJson({ scene: sv.scene.id, kind: P.sc.spaceKind, ents: sv.scene.entities, used });
}
/** `initial: burning` 的实例：0 秒点着（有着火点按第一个、没有整体点——`BurnableHostDef.initial`） */
function seedEvents(it) {
  if (!(it.ent.host && it.ent.host.initial === 'burning')) return [];
  const p = it.b.ignitionPoints[0];
  return [p ? { t: 0, k: 'ignite', u: p.u, v: p.v } : { t: 0, k: 'igniteAll' }];
}
function sceneEventsOf(it) {
  return seedEvents(it).concat(P.scEvents[it.key] || []);
}

async function buildScene(force) {
  const rt = S.rt, sv = S.sv, sc = P.sc;
  if (!rt || !sv || !sv.scene || !sc.space || sc.sceneId !== sv.scene.id) { sc.items = []; sc.sim = null; sc.problems = []; sc.sig = ''; return; }
  const sig = sceneSig();
  if (!force && sig === sc.sig) return;
  const token = ++P.scBuilding;
  const scene = sv.scene;
  const problems = [];
  const items = [];
  const seen = new Set();
  for (const ent of scene.entities.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const key = ent.id;
    if (!key) { problems.push({ key: '?', level: 'error', msg: `一个${ent.kind === 'npc' ? ' NPC' : '热点'}没有 id：游戏里认不出它` }); continue; }
    if (seen.has(key)) { problems.push({ key, level: 'error', msg: `实体 id「${key}」在场景里重复：只取第一个` }); continue; }
    seen.add(key);
    const raw = S.docs[ent.template];
    if (!raw) { problems.push({ key, level: 'error', msg: `模板「${ent.template}」不存在（burnables/ 里没有）：游戏里这个实例不建` }); continue; }
    const b = rt.burnables.resolveBurnable(raw, ent.template);
    if (!b) { problems.push({ key, level: 'error', msg: `模板「${ent.template}」读不懂（缺图 / 真实尺寸）：游戏里这个实例不建` }); continue; }
    const pl = entityPlacementOf(ent, b);
    items.push({ key, ent, b, placement: pl.placement, frame: pl.frame, depthScale: pl.depthScale });
  }
  await Promise.all(items.map(async (it) => {
    const [img, mask, order] = await Promise.all([
      loadImg(it.b.image), it.b.maskData ? loadImg(it.b.maskData) : null, it.b.orderData ? loadImg(it.b.orderData) : null]);
    it.img = img; it.mask = mask; it.order = order;
  }));
  if (token !== P.scBuilding || S.sv !== sv || sc.sceneId !== scene.id) return;
  const good = [];
  for (const it of items) {
    if (!it.img) { problems.push({ key: it.key, level: 'error', msg: `模板图读不出来：${it.b.image}（游戏里这个实例不建）` }); continue; }
    if (it.b.maskData && !it.mask) problems.push({ key: it.key, level: 'warn', msg: '燃料涂层读不出来：按没有涂层算（与游戏同）' });
    if (it.b.orderData && !it.order) problems.push({ key: it.key, level: 'warn', msg: '顺序涂层读不出来：按方向算（与游戏同）' });
    it.grid = rt.burnSim.buildBurnGrid(it.b, it.img, it.mask, it.order);
    it.world = rt.burnGeometry.buildBurnWorldGrid(it.frame, it.b.orientation, sc.space);
    if (it.grid.fuelCells === 0) problems.push({ key: it.key, level: 'warn', msg: '一格燃料都没有（alpha 阈值 / 涂层把它全抹了）：点不着' });
    good.push(it);
  }
  sc.items = good;
  sc.problems = problems;
  sc.sig = sig;
  replayScene();
}
function replayScene() {
  const sc = P.sc;
  sc.sim = S.rt && sc.items.length ? makeSim(sc.items.map((it) => simInput(it, sceneEventsOf(it))), sc.wind) : null;
  if (sc.sim) sc.sim.advanceTo(P.t);
  requestDraw();
}
function sceneItem(key) { return P.sc.items.find((x) => x.key === key) || null; }

// ---------------------------------------------------------------------------
// 时间轴 / 事件
// ---------------------------------------------------------------------------
function stepPreview(dt) {
  if (!(dt > 0)) return;
  P.t += dt;
  if (P.t > P.duration - 5) P.duration = Math.ceil((P.t + 30) / 30) * 30;
  if (P.art && P.art.sim) P.art.sim.advanceTo(P.t);
  if (P.sc.sim) P.sc.sim.advanceTo(P.t);
}
function seek(t) {
  P.t = Math.max(0, Number(t) || 0);
  replayArt();
  replayScene();
}
/** 预览按钮 / 点火工具作用在谁身上：原画视图 = 模板实例；场景视图 = 选中的实体 */
function eventTarget() {
  if (S.view === 'scene') {
    const it = S.sv ? sceneItem(S.sv.entityId) : null;
    return it && P.sc.sim ? { sim: P.sc.sim, key: it.key, it, scene: true } : null;
  }
  return P.art && P.art.sim ? { sim: P.art.sim, key: P.art.key, it: P.art, scene: false } : null;
}
/** 记一条外部事件（进日志 + 进模拟）。`kind` = ignite / igniteAll / extinguish / reset */
function addPreviewEvent(target, kind, u, v) {
  if (!target) return null;
  const ev = kind === 'ignite' ? { t: P.t, k: 'ignite', u, v } : { t: P.t, k: kind };
  const arr = target.scene ? (P.scEvents[target.key] || (P.scEvents[target.key] = [])) : P.artEvents;
  let i = arr.length;
  while (i > 0 && arr[i - 1].t > ev.t) i--;
  arr.splice(i, 0, ev);
  if (target.sim.has(target.key)) target.sim.addEvent(target.key, ev);
  requestDraw();
  return ev;
}
function restartPreview() {
  P.artEvents = [];
  P.scEvents = {};
  P.t = 0;
  P.duration = 60;
  replayArt();
  replayScene();
}

/** 一个实例此刻的读数（状态 / 剩余燃料 / 在烧格数 / 火势 / 火光 / 粒子发射率） */
function itemReadout(sim, it) {
  const key = it.key, b = it.b;
  const d = sim.debugItem(key);
  if (!d) return null;
  const q = sim.query(key, 'flame', P.query);
  const flameCount = q.count, flameArea = q.area;
  const vit = sim.vitality(key);
  let fuelLeft;
  if (b.mode === 'consume') fuelLeft = 1 - Math.min(1, d.consumed / (b.consumeSeconds + b.flameSeconds));
  else fuelLeft = it.grid.fuelCells > 0 ? d.remaining / it.grid.fuelCells : 0;
  let light = null;
  if (b.light && flameCount > 0) {
    let I = b.light.intensityPerM2 * (flameArea / 10000) * (b.mode === 'consume' ? vit : 1);
    if (b.light.maxIntensity !== undefined) I = Math.min(b.light.maxIntensity, I);
    light = { intensity: I, cx: q.cx, cy: q.cy + b.flameLengthCm * S.rt.burnables.BURN_WU_PER_CM / 2, cz: q.cz };
  }
  const particles = b.particles.map((slot) => {
    const qq = sim.query(key, slot.from, P.query);
    const k = b.mode === 'consume' && slot.from === 'flame' ? vit : 1;
    return { effect: slot.effect, from: slot.from, count: qq.count, rate: qq.count ? (qq.area / slot.refArea) * k : 0 };
  });
  return { state: d.state, fuelLeft, flameCount, flameArea, vit, light, particles, events: d.events, mode: d.mode };
}

// ---------------------------------------------------------------------------
// 点火站位（场景视图里选中的实例）
// ---------------------------------------------------------------------------
/** 站位要的纯数据（挂件预设 + 状态 + 玩家动画 + 挂点）。拿不齐 = `data: null` + 原因 */
function stanceInput() {
  const rt = S.rt, pl = S.player;
  const problems = [];
  if (!rt) return { data: null, problems: ['没有运行时包：站位解不了'] };
  if (!pl || !pl.anim) return { data: null, problems: [`玩家动画包读不到（${pl ? pl.animUrl : '?'}）`] };
  if (!pl.sockets) return { data: null, problems: ['玩家动画包没有 sockets.json：挂点没标，站位解不出来'] };
  const sheet = pl.sheetSize || [0, 0];
  const anim = rt.resolveAnimationSet.normalizeAnimationSetDef(pl.anim, sheet[0], sheet[1]);
  const socks = rt.animationSockets.resolveSockets(pl.sockets, anim);
  if (!socks.set) return { data: null, problems: ['sockets.json 结构坏了：游戏里当作没有挂点'] };
  if (socks.stale) return { data: null, problems: ['挂点标注跟现在的图集对不上（cols / rows / 格数变了）：游戏里当作没有挂点，先去挂点面板重标'] };
  const socketNames = Object.keys(socks.set.sockets);
  const socket = S.stance.socket && socks.set.sockets[S.stance.socket] ? S.stance.socket : (socks.set.sockets.right_hand ? 'right_hand' : socketNames[0]);
  if (!socket) return { data: null, problems: ['玩家一个挂点都没标'], socketNames };
  const presetRow = S.presets.find((p) => p.id === S.stance.presetId) || S.presets[0];
  if (!presetRow) return { data: null, problems: ['没有能点火的挂件预设（prop_presets.json 里给火把写 igniter）：站位画不出来'], socketNames, socket };
  const table = rt.propPresets.parsePropPresets({ [presetRow.id]: presetRow.def });
  const pdef = table[presetRow.id];
  const stateNames = pdef && pdef.states ? Object.keys(pdef.states) : [];
  let stateName = rt.propPresets.resolvePropStateName(pdef, S.stance.state || undefined);
  if (S.stance.state && !stateName) { problems.push(`预设没有状态「${S.stance.state}」，按缺省状态`); stateName = rt.propPresets.resolvePropStateName(pdef); }
  const res = rt.propPresets.resolvePropAttach(pdef, {}, stateName);
  if (!res.igniter) problems.push(`「${presetRow.id}」${stateName ? `的状态「${stateName}」` : ''}点不了火（igniter 没写 / 写了 null）：游戏里这个状态不能点`);
  if (!(res.light && res.light.intensity > 0)) problems.push(`「${presetRow.id}」${stateName ? `的状态「${stateName}」` : ''}没燃着（没有灯）：游戏里这个状态不能点`);
  const img = res.images[0];
  const size = img ? presetRow.sizes[img] : null;
  if (!size) return { data: null, problems: problems.concat([`挂件贴图读不到像素尺寸（${img || '没有图'}）`]), socketNames, socket, presetRow, stateNames, stateName };
  const u = res.firePoint ? res.firePoint[0] : (res.anchorX ?? 0.5);
  const v = res.firePoint ? res.firePoint[1] : (res.anchorY ?? 0.5);
  const logical = String((pl.ignite && pl.ignite.animation) || '').trim() || 'ignite';
  const data = {
    anim: { worldWidth: anim.worldWidth, worldHeight: anim.worldHeight, states: anim.states || {} },
    stateMap: pl.stateMap || {},
    sockets: { sockets: socks.set.sockets, igniteSlots: socks.set.igniteSlots },
    socket, logical,
    attach: { scale: res.scale, anchorX: res.anchorX, anchorY: res.anchorY, rotationOffsetDeg: res.rotation, mirrorWithHost: res.mirror, texW: size[0], texH: size[1] },
    u, v,
  };
  return { data, problems, socketNames, socket, presetRow, stateNames, stateName, logical };
}

/**
 * 场景视图里一个实例：每个着火点（没有着火点 = `burnIgniteAim` 的中间点）左右两个站位、接触帧火头、残差、
 * 离交互圈多远。`walk` 由 app 层填（本地 / 游戏判定）。
 */
function computeStances(key) {
  const rt = S.rt;
  const out = { points: [], problems: [], contactNote: '', input: null, radius: 0 };
  const it = sceneItem(key);
  if (!rt || !it) return out;
  const inp = stanceInput();
  out.input = inp;
  out.problems.push(...inp.problems);
  const targets = it.b.ignitionPoints.length
    ? it.b.ignitionPoints.map((p) => ({ id: p.id, u: p.u, v: p.v, scene: rt.burnGeometry.burnUvToScene(it.frame, p.u, p.v) }))
    : (() => { const a = rt.burnAim.burnIgniteAim(it.b, it.grid, it.frame, null); const c = rt.burnAim.burnFuelCenterUv(it.grid); return [{ id: null, u: c.u, v: c.v, scene: a.scene }]; })();
  const depthAt = (x, y) => (P.sc.persp ? P.sc.persp.scaleAt(x, y) : 1);
  const radius = interactionRadius(it);
  out.radius = radius;
  if (!inp.data) {
    out.points = targets.map((t) => ({ target: t, right: null, left: null }));
    return out;
  }
  const logicalContact = rt.igniteStance.igniteContactOf(inp.data);
  for (const t of targets) {
    const r = rt.igniteStance.igniteStancesFor(inp.data, t.scene, depthAt);
    const side = (s) => {
      if (!s) return null;
      const tip = rt.igniteStance.igniteTipOffset(inp.data, r.contact, s.facing, depthAt(s.x, s.y));
      const dist = Math.hypot(s.x - it.ent.x, s.y - it.ent.y);
      return { facing: s.facing, x: s.x, y: s.y, residual: s.residual, tip: tip ? { x: s.x + tip.x, y: s.y + tip.y } : null, dist, outOfRange: dist > radius };
    };
    out.points.push({ target: t, contact: r.contact, right: side(r.right), left: side(r.left) });
    if (!r.contact) out.problems.push('点火片段与 idle 都没有：站位解不出来');
  }
  const c = out.points[0] && out.points[0].contact;
  if (c) {
    const clipWanted = (inp.data.stateMap && inp.data.stateMap[inp.data.logical]) || inp.data.logical;
    if (!logicalContact) out.contactNote = `点火片段「${clipWanted}」不存在：用 idle 第 ${c.frame} 帧（游戏里同样退回 idle）`;
    else if (!c.marked) out.contactNote = `片段「${c.clip}」没标点火接触帧：用第 0 帧（挂点面板勾「点火接触帧」）`;
    else out.contactNote = `接触帧：片段「${c.clip}」第 ${c.frame} 帧（图集格 ${c.slot}）`;
    if (!logicalContact || !c.marked) out.problems.push(out.contactNote);
  }
  return out;
}
