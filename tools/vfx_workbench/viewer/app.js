'use strict';
/* 粒子工作台 · 前端主机（文档 / 撤销 / 选择 / 本地预览 / 检视器 / 联动 / 保存）。
 *
 * 硬契约（逐条照 agent_docs 的 trajectory-workbench 卡「硬契约」一节）：
 * - **本工作台是 `assets/data/vfx/` 与 `assets/data/vfx_placements.json`（布置库）唯一的写入者**，主编辑器只读显示。
 * - **本地预览 = 同一份运行时模拟**：`/gen/vfx.bundle.js` 打的是 `vfxSim.ts` / `vfxSpace.ts` /
 *   `sceneSpace.ts` / `depthShellField.ts` / `groundHeightfield.ts` / `sceneWind.ts` / `perspectiveScale.ts`
 *   **本体**，页面里 `new VfxInstanceSim(...)` 真跑，喂的输入也与 `VfxSystem` 同形（风 + 风的钟、实例的铺撒区域、
 *   透视度量）。JS 里**不再写第二份**任何换算或积分——两份必然漂，而且漂了一处都不报错。
 * - **坐标对齐自证不许绕过**（`checkAlignment`）：25 个画面点过运行时 `groundWorldAt` 对工作台 `SceneCal`，
 *   壳接触点过运行时 `shellContactAt` 对服务端 `SceneGeometry.shell_contact`。Δ 非零 → 场景芯片整块染红。
 * - **锚点模式的「角色挂点」那一档也只是工作态**：写 `authoring.attach`（与 `authoring.anchor` 同待遇，
 *   运行时忽略整个 `authoring`），关掉就把那个键删掉 ⇒ 资产字节回到原样；跟随靠的是运行时那份
 *   `VfxInstanceSim.moveAnchor`，**不在 JS 里另写一套跟随**。
 * - **本工作台也是布置库 `assets/data/vfx_placements.json` 唯一的写入者**（2026-09-14 制作人："粒子的布置也是在粒子工作台"）。
 *   工作态 `S.lib` 是整份库（全局，不跟着效果 / 场景换）；当前展开的是 `S.scene × S.phase`（时段外观键，`''` = 基底）。
 *   各份**互不继承、没配就没有**：夜里没摆就是没有。
 * - **活动布置** = 本份里当前效果被选中的那条（没选就取第一条）。本地预览喂的输入与 `VfxSystem.ensureSim` 同形：
 *   锚点 = 实例 anchor、种子 = 实例 seed（没写 = 运行时 `hashSeed(id)`，从包里取）、countScale、`{area, confine}` 第 7 参。
 *   没有活动布置 → 退回 `authoring.anchor`、无区域（状态栏写明）。
 * - **只有真改 doc / 库才标脏**（`history.commit` 比前后**复合**快照 `{doc, lib}`）；`id` 不进历史栈。
 *   脏态分两份记（`docDirty` / `libDirty`）：Ctrl+S 一次存两份，只成功一半时如实说哪份没存上、那份不清脏。
 * - **保存锁**：保存在飞期间又改了 doc / 库，返回后不覆盖内存、不清脏，状态栏说再按一次。
 * - **磁盘操作一条链**（`runIO`）：存 / 新建 / 改名 / 复制 / 删串行，谁先谁后由链定。
 * - **装载门**（`setBusy`）：换场景 / 打开 / 新建期间遮罩 + `#app` inert + `onKey` 作废 + 存盘拒绝，
 *   换场景有序号守卫（`sceneOp`），装载失败整个退回原现场。换场景 / 换时段外观不丢布置改动（库是全局的），
 *   但在飞的手势整个撤回。
 * - **手势期间不写盘**；手势记着它开始时的 doc 与库（`S.dragDoc` / `S.dragLib`），被整份换掉就整个作废（不回滚）。
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
/**
 * 角色挂点预览（锚点模式的第三档）：手持挂件自带的效果在运行时是
 * `HeldPropSystem` 逐帧 `moveVfx(id, 挂点世界点)` → `VfxInstanceSim.moveAnchor`
 * （锚点跟着手走、**已发射的粒子留在原地**）。工作台这一档跑的就是那条：
 * 锚点 = 角色脚点画面 x + `offsetX`、脚点画面 y、离脚点 `heightWu` 高
 * （与 `resolveAnchorWorld` 的 `contact.x + pose.x` / `contact.y` / `−pose.y` 逐字同口径）。
 * 尺度锚：角色高 150 wu，火把火头大约 100–120 wu。
 */
const CHAR_HEIGHT_WU = 150;
const ATTACH_DEFAULT_HEIGHT_WU = 110;
/** 来回走：走速取游戏里的走速（玩家动静场强度 = 100 / 420 ≈ 0.24），半幅 240 wu */
const WALK_SPEED_WU = 100;
const WALK_SPAN_WU = 240;
/**
 * 「外部给点」（`spawn.shape.kind = 'external'`）的**预览用假点**：游戏里出生点由燃烧系统每帧交进来（正在烧的格 / 纸，
 * `VfxSystem.setInstanceSpawnPoints` → `VfxInstanceSim.setSpawnPoints`），工作台里没有燃烧系统，一个点都不给就一颗都不发——
 * 作者调火苗参数什么都看不见。预览时在锚点周围摆一小圈假点、走的是同一个 `setSpawnPoints`；**只在预览内存里，绝不写盘 / 推游戏**，
 * 视图里标「预览用假点」。半径取一张燃着纸钱的半尺寸量级。
 */
const EXT_PREVIEW_COUNT = 6;
const EXT_PREVIEW_SPREAD_WU = 24;
const EXT_PREVIEW_RADIUS_WU = 4;
/** 火焰调试工具（I）：点一下 = 在光标下的表面上立一段竖直火焰（`VfxFireSegment`，经 `VfxStepContext.fires` 喂给模拟），只在预览内存里 */
const FIRE_DEBUG_LEN_WU = 40;
const FIRE_DEBUG_R_WU = 10;
/** 联动：文档改动防抖发一次；每 3 分钟续一次（槽 5 分钟新鲜期） */
const PUBLISH_DEBOUNCE_MS = 120;
const PUBLISH_KEEPALIVE_MS = 180000;
const STATUS_POLL_MS = 400;
/** 「让游戏切到这个时段」时游戏在别的场景：让它切过来，等这么久还没进本场景就作废那次请求（不许几小时后作者自己走进来时突然推进一天） */
const PHASE_SWITCH_WAIT_MS = 60000;
/**
 * 粒子区域的两块（与主编辑器画布 / F2 叠加层同色）：发射区域 = 实例 `area`（青、虚线），
 * 范围区域 = `confine.area`（黄、实线 + 边带内沿）。两块分开配，见 vfx-system「粒子区域」。
 */
const AREA_ROLES = ['emit', 'range'];
const AREA_RGB = { emit: [110, 205, 255], range: [255, 209, 102] };
const AREA_LABEL = { emit: '发射区域', range: '范围区域' };
/**
 * 表面材质区（布置库 `scenes[场景].surfaces`，**场景级、所有时段共用**）：水面 / 湿地。落雷与所有标了反光的灯在这里
 * 照出倒影与高光；落在水面上的雷改放水面电弧、水花（发射器 `onSurface`）。本台是唯一作者面（主编辑器只读）。
 * 顶点键 `area:s<第几块>:<第几个点>`，与粒子区域的顶点共用一套拖拽 / 加点 / 删点；拉框工具 `areaWater` / `areaWet` 拉出新的一块。
 */
const SURF_RGB = { water: [90, 160, 255], wet: [120, 220, 170] };
const SURF_LABEL = { water: '水面', wet: '湿地' };
/** 与 `tools/editor/shared/vfx_placements.py` 的 SURFACE_ORDER / `types.ts` 的 `VfxSurfaceRegionDef` 同序 */
const SURFACE_ORDER = ['id', 'kind', 'polygon', 'reflect', 'roughness', 'feather'];
/** 与运行时 `surfaceMask.ts` 的 SURFACE_DEFAULTS 同值（检视器里当占位提示；不写进文件） */
const SURFACE_DEFAULTS = {
  ground: { reflect: 1, roughness: 0.45, detail: 1, ripple: 1 },
  water: { reflect: 1, roughness: 0.08 }, wet: { reflect: 1, roughness: 0.25 }, feather: 24,
};
/** 全局缺省表面材质（库顶层 `defaultSurface`）的键序（与 `vfx_placements.DEFAULT_SURFACE_ORDER` 同序） */
const DEFAULT_SURFACE_ORDER = ['reflect', 'roughness', 'detail', 'ripple'];
/** 拉框工具 → 拉出来的是哪一种（粒子区域两种写活动布置；表面两种新建一块表面区） */
const AREA_TOOL_ROLE = { areaEmit: 'emit', areaRange: 'range', areaWater: 'water', areaWet: 'wet' };
function isSurfRole(role) { return /^s\d+$/.test(role || ''); }
function isSurfDraftRole(role) { return role === 'water' || role === 'wet'; }
/** 当前场景的表面区（只读视图；行对象是库里的原对象） */
function sceneSurfaces(lib) {
  const L = lib || S.lib, sid = S.scene && S.scene.id;
  const ent = sid && L && L.scenes && typeof L.scenes === 'object' ? L.scenes[sid] : null;
  return ent && Array.isArray(ent.surfaces) ? ent.surfaces : [];
}
function surfOfRole(role) { return isSurfRole(role) ? sceneSurfaces()[+role.slice(1)] || null : null; }
function roleRgb(role) {
  if (isSurfRole(role)) { const r = surfOfRole(role); return SURF_RGB[r && r.kind] || SURF_RGB.water; }
  return SURF_RGB[role] || AREA_RGB[role] || [200, 200, 200];
}
function roleLabel(role) {
  if (isSurfRole(role)) { const r = surfOfRole(role); return `${SURF_LABEL[r && r.kind] || '表面区'}「${r ? r.id : ''}」`; }
  return SURF_LABEL[role] || AREA_LABEL[role] || role;
}
/** 3D 里区域折线沿边的采样步长（画面 wu）与离地抬高（wu）：贴着地形走，又不被地面网格吃掉 */
const AREA_STEP = 12;
const AREA_LIFT = 2;
/** 布置实例的键序（与 `types.ts` 的 `VfxInstanceDef` / 共享模块 `INSTANCE_ORDER` 逐字同序；服务端存盘还会再收一次） */
const INSTANCE_ORDER = ['id', 'effect', 'anchor', 'seed', 'countScale', 'autoStart', 'conditions', 'area', 'confine'];
const CONFINE_ORDER = ['area', 'feather', 'ceiling'];

const S = {
  doc: null, effects: [], sources: { anims: [], images: [] }, sfx: [],
  scenes: [], scene: null, cal: null, marks: [],
  /** 布置：整份工作态库 / 读不懂时的错（非空 = 只读，绝不覆盖盘上那份）/ 当前时段外观键 / 选中的布置 id */
  lib: null, libErr: '', libPath: '', libReal: true, phase: '', placeId: '',
  /** 去掉「限定」勾 / 删掉最后一块区域时收着的 confine（键 `场景\n外观\nid`；本次会话有效，不进历史） */
  confineStash: {},
  /** 正在拉的区域框（画面坐标两角）；null = 没在拉 */
  areaDraft: null,
  /** 画面上显示并可编辑本场景的表面材质区（水面 / 湿地）；UI 态，不进历史 */
  surfEdit: false,
  rt: null, rtErr: '', geo: null, shellField: null, space: null, wind: null, area: null, simInput: null,
  sim: null, simErr: '', simTime: 0, frames: 0, playing: false, speed: 1, seed: 1234,
  evCount: { sound: 0, field: 0, hit: 0, flockState: 0 }, lastFlock: '',
  fields: [], playerField: null,
  /** `movedAt` = 最近一次挪动玩家标记的 performance.now()（速度按真实时间算、停手就归零，见 setPlayerAt） */
  player: { on: false, world: null, scene: null, speed: 0, movedAt: 0 },
  walk: { on: false, baseX: null, sceneY: 0, dir: 1 },
  probes: [],
  /** 火焰调试工具放的火焰段（M-world `VfxFireSegment`）：只在预览内存里，不进 doc / 历史 / 联动；换场景、重置清掉 */
  fires: [],
  /**
   * 可燃物模板表（`/api/burnables`，本台只读）：`rows` = 服务端给的 `{id, label, mode, bindable, note, summary, doc}`、
   * `errors` = 读不懂的 `{id: 原因}`、`map` = 每份 `doc` 过打包进来的运行时 `resolveBurnable(doc, id)` 得到的
   * `Map<id, ResolvedBurnable>`（建模拟时当 `burnTemplates` 传，与 `VfxSystem` 同形）；`loaded` = 至少读到过一次，
   * `err` = 最近一次没读到的原因，`key` = 表内容的规范串（内容真变了才重建模拟）。
   */
  burn: { loaded: false, err: '', rows: [], errors: {}, map: null, key: '' },
  sel: { key: '' }, gizmoMode: 'move', tool: 'select', view: 3,
  /** 作者最近操作的发射器（检视器与左栏 ⧉ / 改名 / ↑ / ↓ / × 作用在它上面）：选中锚点 / 顶点 / 刺激点时不许退回 emitters[0] */
  emitterId: '',
  /** 作者最近操作的光柱（左栏光柱那排按钮作用在它上面） */
  beamId: '',
  /** 布置库之外按 id 用当前效果的地方（挂件预设 / playVfx，服务端只读扫出来的；删 / 改名 / 左栏都看它） */
  extRefs: [],
  /** 鼠标按下时压着的那个 DOM 元素（松开前不许把它从 DOM 里拆掉，否则 Chromium 不发 click，见 `renderLeft`） */
  pressTarget: null, pendingLeft: false, pendingInspector: false,
  dirty: false, docDirty: false, libDirty: false, cleanDoc: '', cleanLib: '', rev: 0,
  busy: 0, loadingScene: '', sceneOp: 0, entityOp: 0,
  dragDoc: null, dragLib: null,
  align: null,
  layers: { mesh: true, dimMesh: false, grid: true, particles: true, rings: true, marks: true, beams: true },
  link: { on: true, status: null, gameUrl: '', pubPending: false, lastPub: 0, rejected: '', placementsErr: '', defErr: '',
    /** 游戏页没在跑时点的「让游戏切到这个时段」：游戏页起来后补发（带新序号） */
    pendingPhase: null,
    /** 关窗选了「不保存」：已把盘上那份推给游戏，之后一发工作态都不许再推 */
    discarded: false },
  cursor: '',
  /**
   * 雷电样式（`lightning.js` 那一节 + `/api/lightning*`）：`lib` = 样式库草稿（改参数 / 另存 / 删都写它），`baseLib` = 上次读到 / 套用后的盘上那份，
   * `assign` = 待换样式的效果 `{效果 id: 样式 id}`。草稿与 `assign` 进撤销栈（与 doc / 布置库同一个复合快照），
   * 但脏态单独记（`lsDirty`、「●未套用」）：它们只有「生成并套用」才落盘，Ctrl+S 不管。
   * `effects` = 服务端给的每份雷电效果（样式 / 种子 / 组 / 产物是否最新），`spec` / `presets` / `kinds` = 参数表 / 内置预设 / 形状模型名。
   */
  ls: { loaded: false, err: '', lib: null, baseLib: null, assign: {}, clean: '', spec: {}, presets: [], kinds: {}, effects: [], usage: {}, path: '' },
  lsDirty: false,
};
let v3 = null;
let v2 = null;
/** 原画视图里光柱的真实预览层（离屏 WebGL，编译运行时那段 GLSL 核心） */
let beamPreview = null;
let history = null;
let simTimer = 0;
let pubTimer = 0;
/** 键盘微移手势（`nudgeSelected`）：`{key, base, acc, timer}`；null = 没在微移。按着的方向键记在 `nudgeKeys` */
let nudge = null;
const nudgeKeys = new Set();
/** 连按方向键之间停这么久就算一次微移结束（入一条历史、重建一次、推一发） */
const NUDGE_IDLE_MS = 400;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function status(msg, kind) {
  const e = el('status');
  e.textContent = msg || '';
  e.title = msg || '';                                   // 状态栏一行放不下会被省略号截掉：全文悬停可看
  e.className = kind || '';
}
/** 两份脏态分开记（Ctrl+S 存两份，只成功一半时只清成功的那份）。
 *  比的是**键序无关**的串（`canonJson`）：存盘后 S.doc 换成服务端按 types.ts 重排过键序的那份，而撤销栈里的快照还是页面的键序——
 *  原来按 JSON.stringify 比，存完 Ctrl+Z 再 Ctrl+Y，内容与盘上一字不差却亮「保存 ●」、关窗还问要不要存、只存脏的又把没改的文件重写一遍 */
function docKey() { return S.doc ? canonJson(S.doc) : ''; }
function libKey() { return canonJson(S.lib || null); }
/** 修改范围按工作态与载入/保存基线逐份比较，切场景本身不产生修改。 */
function changedPlacementLibrary() {
  const baseline = S.cleanLib ? JSON.parse(S.cleanLib) : { scenes: {} };
  const out = { scenes: {} };
  const scenes = new Set([...Object.keys(baseline.scenes || {}), ...Object.keys((S.lib && S.lib.scenes) || {})]);
  for (const sid of scenes) {
    const before = (baseline.scenes || {})[sid] || {}, after = ((S.lib && S.lib.scenes) || {})[sid] || {};
    const phases = new Set(['', ...Object.keys(before.variants || {}), ...Object.keys(after.variants || {})]);
    for (const phase of phases) {
      const a = phase ? (after.variants || {})[phase] : after.base;
      const b = phase ? (before.variants || {})[phase] : before.base;
      if (canonJson(a || []) === canonJson(b || [])) continue;
      const ent = out.scenes[sid] || (out.scenes[sid] = {});
      if (phase) (ent.variants || (ent.variants = {}))[phase] = a || [];
      else ent.base = a || [];
    }
    // 表面材质区是场景级的一份：改了就整份提交（空数组 = 清空）
    if (canonJson(before.surfaces || []) !== canonJson(after.surfaces || [])) {
      (out.scenes[sid] || (out.scenes[sid] = {})).surfaces = Array.isArray(after.surfaces) ? after.surfaces : [];
    }
  }
  // 全局缺省表面材质（库顶层，所有场景一份）：改了就整份提交（空对象 = 回运行时缺省）
  const dsAfter = (S.lib && S.lib.defaultSurface) || {};
  if (canonJson(baseline.defaultSurface || {}) !== canonJson(dsAfter)) out.defaultSurface = dsAfter;
  return out;
}
/** 只接回本次提交的份，防止外部变化污染未编辑范围的撤销快照和脏态基线。 */
function acceptSavedPlacements(saved, changes, source = S.lib) {
  const local = JSON.parse(JSON.stringify(source));
  for (const [sid, ent] of Object.entries(changes.scenes)) {
    const target = local.scenes[sid] || (local.scenes[sid] = {});
    if ('base' in ent) target.base = libRows(sid, '', saved);
    for (const phase of Object.keys(ent.variants || {})) (target.variants || (target.variants = {}))[phase] = libRows(sid, phase, saved);
    if ('surfaces' in ent) {
      const sv = saved && saved.scenes && saved.scenes[sid] ? saved.scenes[sid].surfaces : null;
      if (Array.isArray(sv) && sv.length) target.surfaces = JSON.parse(JSON.stringify(sv)); else delete target.surfaces;
    }
  }
  if ('defaultSurface' in changes) {
    const ds = saved && saved.defaultSurface;
    if (ds && typeof ds === 'object' && Object.keys(ds).length) local.defaultSurface = JSON.parse(JSON.stringify(ds));
    else delete local.defaultSurface;
  }
  return local;
}
/** `which` = 'doc' | 'lib' | 缺省（两份） */
function markClean(which) {
  if (which !== 'lib') S.cleanDoc = docKey();
  if (which !== 'doc') S.cleanLib = libKey();
  refreshDirty();
}
function refreshDirty() {
  S.docDirty = docKey() !== S.cleanDoc;
  S.libDirty = libKey() !== S.cleanLib;
  S.dirty = S.docDirty || S.libDirty;
  S.lsDirty = !!S.ls.loaded && lsKey() !== S.ls.clean;
  renderDocState();
}
/** 雷电样式的工作态（草稿样式库 + 待换样式清单）的规范串；与 `S.ls.clean` 比出「●未套用」 */
function lsKey() { return canonJson({ lib: S.ls.lib, assign: S.ls.assign || {} }); }
function touchDoc() { S.rev++; }
/** 焦点还在输入框里、值改了没提交：失焦让 `change` 同步写进 doc（存盘 / 关窗前调） */
function commitFocusedInput() {
  const ae = document.activeElement;
  if (ae && ae !== document.body && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && typeof ae.blur === 'function') ae.blur();
}
/** 这个键盘事件是不是在往控件里打字（这时单键快捷键让开）。勾选框 / 滑块 / 按钮不吃字母键，不算 */
function isTypingTarget(t) {
  if (!t) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit', 'color'].includes(t.type);
}
function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
/** 键序无关的 JSON 串（比"内容一样不一样"用：服务端存盘会按 types.ts 重排键序） */
function canonJson(o) {
  const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
  return JSON.stringify(sortKeys(o));
}
function round1(v) { return Math.round(v * 10) / 10; }
function isPoly(a) { return Array.isArray(a) && a.length >= 3 && a.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])); }
/** 就地按键序重排（引用不变：闭包 / 拖拽里拿着的还是同一个对象） */
function orderKeys(o, order) {
  if (!o || typeof o !== 'object') return o;
  const tmp = {};
  for (const k of order) if (k in o) tmp[k] = o[k];
  for (const k of Object.keys(o)) if (!(k in tmp)) tmp[k] = o[k];
  for (const k of Object.keys(o)) delete o[k];
  return Object.assign(o, tmp);
}

// ---------------------------------------------------------------------------
// 布置库（场景 × 时段外观）
// ---------------------------------------------------------------------------
/** 某场景某时段外观的实例（只读视图：过滤掉非对象；行对象是库里的原对象） */
function libRows(sid, phase, lib) {
  const L = lib || S.lib;
  const ent = L && L.scenes && typeof L.scenes === 'object' ? L.scenes[sid] : null;
  if (!ent || typeof ent !== 'object') return [];
  const raw = phase ? (ent.variants && typeof ent.variants === 'object' ? ent.variants[phase] : null) : ent.base;
  return Array.isArray(raw) ? raw.filter((r) => r && typeof r === 'object') : [];
}
function curRows() { return S.scene ? libRows(S.scene.id, S.phase) : []; }
/** 库里某份的**真数组**（没有就建）——只许在写入闭包里调（容器只在写入时补，删空的由 `pruneLib` 剥掉） */
function rowsArr(sid, phase) {
  if (!S.lib || typeof S.lib !== 'object') S.lib = { scenes: {} };
  if (!S.lib.scenes || typeof S.lib.scenes !== 'object') S.lib.scenes = {};
  const ent = S.lib.scenes[sid] || (S.lib.scenes[sid] = {});
  if (!phase) { if (!Array.isArray(ent.base)) ent.base = []; return ent.base; }
  if (!ent.variants || typeof ent.variants !== 'object') ent.variants = {};
  if (!Array.isArray(ent.variants[phase])) ent.variants[phase] = [];
  return ent.variants[phase];
}
/** 空的份 / 空场景剥掉（没配 = 没有，不留空壳——否则加一条再删掉，库就一直"脏"着） */
function pruneLib() {
  if (S.lib && S.lib.defaultSurface && typeof S.lib.defaultSurface === 'object' && !Object.keys(S.lib.defaultSurface).length) delete S.lib.defaultSurface;
  const sc = S.lib && S.lib.scenes;
  if (!sc || typeof sc !== 'object') return;
  for (const sid of Object.keys(sc)) {
    const ent = sc[sid];
    if (!ent || typeof ent !== 'object') continue;
    if (Array.isArray(ent.base) && !ent.base.length) delete ent.base;
    if (Array.isArray(ent.surfaces) && !ent.surfaces.length) delete ent.surfaces;
    if (ent.variants && typeof ent.variants === 'object') {
      for (const k of Object.keys(ent.variants)) if (Array.isArray(ent.variants[k]) && !ent.variants[k].length) delete ent.variants[k];
      if (!Object.keys(ent.variants).length) delete ent.variants;
    }
    if (!Object.keys(ent).length) delete sc[sid];
  }
}
/** 全库里引用某效果的布置 `[{sceneId, phase, id}]`（与服务端 `placements.refs_to_effect` 同序） */
function libRefs(effectId, lib) {
  const out = [];
  const sc = (lib || S.lib || {}).scenes;
  if (!sc || typeof sc !== 'object') return out;
  for (const sid of Object.keys(sc)) {
    const ent = sc[sid] || {};
    const phases = (Array.isArray(ent.base) ? [''] : []).concat(ent.variants && typeof ent.variants === 'object' ? Object.keys(ent.variants) : []);
    for (const ph of phases) for (const r of libRows(sid, ph, lib)) if (r.effect === effectId) out.push({ sceneId: sid, phase: ph, id: String(r.id || '') });
  }
  return out;
}
/** 布置库之外的引用（`/api/effect` 回的 `externalRefs`）给人看的一行：挂件那条补上文件名（作者要知道去主编辑器改哪个） */
function extRefsText(refs) {
  return (refs || []).map((r) => (r.kind === 'action' ? r.label : `${r.label}（${r.file}）`)).join('；');
}
/** 去哪改这些引用（与服务端 `placements.refs_fix_hint` 同一句）：挂件预设 / 动作 → 主编辑器；可燃物模板的粒子 → 燃烧工作台里打开那份模板 */
function extRefsFixHint(refs) {
  const parts = [];
  const files = [...new Set((refs || []).filter((r) => r.kind !== 'burnable').map((r) => r.file))].sort();
  if (files.length) parts.push(`在主编辑器里改掉 ${files.join(' / ')} 里的这些引用`);
  const tids = [...new Set((refs || []).filter((r) => r.kind === 'burnable').map((r) => String(r.burnable || '')))].sort();
  if (tids.length) parts.push(`在燃烧工作台里打开模板${tids.map((t) => `「${t}」`).join('/')}改粒子`);
  return parts.join('、');
}
function phasesOf(sid) {
  if (S.scene && S.scene.id === sid && Array.isArray(S.scene.phases)) return S.scene.phases;
  const s = S.scenes.find((x) => x.id === sid);
  return s && Array.isArray(s.phases) ? s.phases : [{ key: '', label: '基底', background: '', timePhase: '' }];
}
function phaseInfo(sid, phase) {
  return phasesOf(sid).find((p) => p.key === (phase || '')) || null;
}
function phaseLabel(sid, phase) { const p = phaseInfo(sid, phase); return p ? p.label : (phase || '基底'); }
function libEditable() {
  if (S.libErr) { status(`布置库读不懂，不能改（也绝不覆盖盘上那份）：${S.libErr}`, 'err'); return false; }
  if (!S.scene) { status('还没装场景', 'warn'); return false; }
  return true;
}
/**
 * 活动布置：本份（当前场景 × 当前时段外观）里**当前效果**的那条——选中过的（`S.placeId`）优先，否则第一条。
 * 没有 = null（本地预览退回 `authoring.anchor`、无区域）。
 */
function activePlacement() {
  if (!S.doc || !S.scene) return null;
  const mine = curRows().filter((r) => r.effect === S.doc.id);
  if (!mine.length) return null;
  return (S.placeId && mine.find((r) => r.id === S.placeId)) || mine[0];
}
function stashKey(id) { return `${S.scene ? S.scene.id : ''}\n${S.phase}\n${id}`; }
function areaPoly(p, role) {
  if (isSurfRole(role)) { const r = surfOfRole(role); return r && isPoly(r.polygon) ? r.polygon : null; }
  if (!p) return null;
  if (role === 'range') return p.confine && typeof p.confine === 'object' && isPoly(p.confine.area) ? p.confine.area : null;
  return isPoly(p.area) ? p.area : null;
}

/** 磁盘操作一条链：存 / 新建 / 改名 / 复制 / 删全部串行（不串就会留下两份文件或删完又被写回） */
let ioChain = Promise.resolve();
function runIO(fn) {
  const p = ioChain.then(fn, fn);
  ioChain = p.catch(() => {});
  return p;
}

/**
 * 顶栏三个下拉（效果 / 场景 / 时段外观）用方向键逐项切换：装载门把 `#app` 设成 inert，Chromium 把焦点从里面的下拉框上拿走，
 * 装完焦点落在 body——第二下方向键进了 onKey 变成「微移」（场景 / 时段外观下还留着发射器 / 玩家的选中，真挪了它们）。
 * 只有**键盘**触发的 change（`isTrusted`）才记下焦点、装完放回；鼠标在页内列表里选的本来就该放掉焦点。
 */
const TOP_SELECTS = ['effectSel', 'sceneSel', 'phaseSel'];
function keyboardSelectOf(opts) {
  const ae = document.activeElement;
  return opts && opts.refocus && ae && TOP_SELECTS.includes(ae.id) ? ae : null;
}
function restoreSelectFocus(t) {
  if (!t || S.busy || !el('dialog').hidden || !t.isConnected || t.disabled) return;
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae !== document.documentElement) return;   // 焦点已经在别处（作者点过别的）：不抢
  t.focus({ preventScroll: true });
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
  if (rt && cal && cal.planar) {
    // 没有深度载荷：与游戏同一个平面近似（`Game.buildVfxSpace` 没几何时那条），2D 光带 / 粒子照样能预览
    const ps0 = rt.perspectiveScale.createPerspectiveScaleResolver(S.scene && S.scene.perspectiveScale);
    S.space = rt.vfxSpace.createPlanarVfxSpace(cal.k, ps0 ? (x, y) => ps0.scaleAt(x, y) : null);
    return;
  }
  if (!rt || !cal || !cal.ground) return;
  const geo = runtimeGeo();
  // 壳栅格就是 work 栅格（服务端 shell_bytes 给的就是它），标定同 work cal —— 别借别的 cal
  const shell = cal.shell
    ? rt.depthShellField.buildDepthShellField(cal.shell.data, cal.shell.w, cal.shell.h,
      { ppu: cal.ppu, cx: cal.cx, cy: cal.cy }, cal.rows)
    : null;
  const viewDir = rt.sceneSpace.viewDirWorld(geo);
  // 透视度量与 `Game.buildVfxSpace` 同一根轴：薄片的尺寸 / 离地高 / 位移都按脚点系数折，不给就恒 1（远处的纸又大又快）
  const ps = rt.perspectiveScale.createPerspectiveScaleResolver(S.scene && S.scene.perspectiveScale);
  S.geo = geo; S.shellField = shell;
  S.space = rt.vfxSpace.createFieldVfxSpace({ geo, shell, viewDir, perspective: ps ? (x, y) => ps.scaleAt(x, y) : null });
}

/**
 * 场景风：游戏那份 `SceneWindState`（参数解析 + 钟）原样打包进来。钟跟本地预览的模拟时间走，
 * 重建 / 重置一起归零（同种子 + 同 dt 串 ⇒ 逐帧相同，风也算在内）。
 * 薄片（纸钱）**只**吃它：不喂 = 一张也吹不动，而且不报错（2026-09-12 工作台就这么"根本没效果"过）。
 */
function resetWind() {
  if (!S.rt) { S.wind = null; return; }
  if (!S.wind) S.wind = new S.rt.sceneWind.SceneWindState();
  S.wind.reset(S.scene ? S.scene.wind : null);
}

/**
 * 喂给本地模拟的实例级输入——与 `VfxSystem.ensureSim` **逐字同形**（同一份 `VfxInstanceSim`，输入少一样照样"不是游戏里那个"）：
 *   id = 实例 id；seed = `typeof seed === 'number' ? seed >>> 0 : hashSeed(id)`（`hashSeed` 是包里的运行时本体，不在 JS 里另写）；
 *   countScale `?? 1`；第 7 参 `{area: Array.isArray(area) ? area : null, confine: 是对象 ? confine : null}`。
 * 没有活动布置：id = 效果 id、种子取控制条、倍率 1、无区域（状态栏写明"本场景本时段没有布置这个效果"）。
 * 区域 / confine 拷一份再给：拖顶点时库里的数组在原地变，模拟构造时烘的权重网格不能跟着半变不变。
 */
function simInput() {
  const p = activePlacement();
  if (!p) return { placement: '', id: (S.doc && S.doc.id) || 'preview', seed: S.seed >>> 0, countScale: 1, area: null, confine: null };
  const hash = S.rt && S.rt.vfxRandom ? S.rt.vfxRandom.hashSeed(p.id) : (S.seed >>> 0);
  return {
    placement: p.id, id: p.id,
    seed: typeof p.seed === 'number' ? (p.seed >>> 0) : hash,
    countScale: p.countScale ?? 1,
    area: Array.isArray(p.area) ? clone(p.area) : null,
    confine: p.confine && typeof p.confine === 'object' ? clone(p.confine) : null,
  };
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
/**
 * 装一个场景的一套**时段外观**（`phase`：`''` = 基底，其余 = `timeVariants` 的键）。背景跟着外观换（3D 贴图与 2D 原画都换），
 * 几何共用那一份深度。换场景 / 换外观**不丢布置改动**（库是全局的），但在飞的手势整个撤回。
 */
async function loadScene(sceneId, phase, opts) {
  const refocus = keyboardSelectOf(opts);
  const op = ++S.sceneOp;
  S.loadingScene = sceneId;
  cancelGestures();
  setBusy(true, `装载场景「${sceneId}」…`);
  const prev = { scene: S.scene, cal: S.cal, marks: S.marks, geo: S.geo, shell: S.shellField, space: S.space, phase: S.phase, placeId: S.placeId };
  try {
    const j = await API.json(`/api/scene?id=${encodeURIComponent(sceneId)}&phase=${encodeURIComponent(phase || '')}`);
    const sc = j.scene;
    const name = sc.background;
    const bgUrl = `/api/scene_bg?id=${encodeURIComponent(sceneId)}&bg=${encodeURIComponent(name)}&w=1600`;
    const [img, mesh, ground, shell, hf] = await Promise.all([
      API.image(bgUrl),
      sc.cal ? API.bin(`/api/scene_mesh?id=${encodeURIComponent(sceneId)}&bg=${encodeURIComponent(name)}&stride=2`) : null,
      sc.cal ? API.bin(`/api/scene_ground?id=${encodeURIComponent(sceneId)}&bg=${encodeURIComponent(name)}`) : null,
      sc.cal ? API.bin(`/api/scene_shell?id=${encodeURIComponent(sceneId)}&bg=${encodeURIComponent(name)}`) : null,
      sc.cal ? API.bin(`/api/scene_heightfield?id=${encodeURIComponent(sceneId)}&bg=${encodeURIComponent(name)}`) : null,
    ]);
    if (op !== S.sceneOp) return;                      // 后一次装载已经进来了：这一发整个作废
    // ---- 一次性提交（中途失败上一个场景原封不动）
    const sameScene = !!prev.scene && prev.scene.id === sc.id;
    const samePortion = sameScene && prev.phase === (sc.phase || '');
    S.scene = sc;
    S.phase = sc.phase || '';
    S.bgName = name;
    if (!samePortion) {
      // 换了一份布置：选中的布置 / 区域顶点属于上一份，别让它指着别人的行
      S.placeId = '';
      if (S.sel.key === 'anchor' || /^area:/.test(S.sel.key)) S.sel.key = '';
    }
    S.marks = sc.marks || [];
    S.cal = null;
    if (sc.cal) {
      const cal = new SceneCal(sc.cal, sc.worldWidth, sc.worldHeight);
      cal.setGround(ground); cal.setShell(shell); cal.setHeightfield(hf);
      S.cal = cal;
    } else if (sc.worldWidth > 0 && sc.worldHeight > 0) {
      // 没有深度载荷：平面近似标定（与运行时平面近似同式）——只能摆 2D 光带，3D 光柱与地形判据在这里都不真
      S.cal = new PlanarCal(sc.worldWidth, sc.worldHeight, Math.SQRT2);
    }
    buildSpace();
    // 同一场景只换时段外观（几何共用）：机位留着——来回切日 / 夜对比布置时每切一次都被重置镜头没法看
    if (v3 && v3.ok) { v3.setMesh(mesh); v3.setTexture(img); if (!sameScene) v3.fit(true); }
    if (v2) { v2.setBackground(img); if (!sameScene) v2.fit(); }
    if (!sameScene) {
      // 玩家标记 / 刺激点 / 在飞的场都是上一个场景的世界坐标：原来原样留着，标记飘在新场景的半空或画外，
      // 挂点模式下火把按上一个场景的脚点画面坐标发射（常在地图外），看起来"什么都不出"
      S.walk.on = false;
      S.probes.length = 0; S.fields.length = 0; S.playerField = null; S.fires.length = 0;
      if (S.sel.key === 'player' || /^probe:/.test(S.sel.key)) S.sel.key = '';
      S.player.on = false; S.player.world = null; S.player.scene = null; S.player.speed = 0;
      // 挂点模式离不开角色：在新场景的锚点脚下重新放一个（与开这一档时同一条）
      if (attachOn() && S.cal && placePlayerAtAnchor()) { S.walk.baseX = S.player.scene[0]; S.walk.sceneY = S.player.scene[1]; }
      updatePlayerField();
    }
    rebuildSim();
    await refreshAlignment();
    // 检视器的「布置」一节 / 种子框 / 状态栏都跟着这一份走：只重画左栏的话检视器还停在上一份的布置上，
    // 改那几个框按 id 在新的一份里找不到行、静默什么都不做
    renderSceneInfo(); renderScenePickers(); renderAll();
    schedulePublish();
    status(`场景「${sc.name || sceneId}」· ${phaseLabel(sc.id, S.phase)} 已装上${sc.cal ? '' : '（没有深度载荷：平面近似——只有 2D 光带与原画上的位置是真的）'}`, sc.cal ? 'ok' : 'warn');
  } catch (e) {
    if (op === S.sceneOp) {
      S.scene = prev.scene; S.cal = prev.cal; S.marks = prev.marks; S.geo = prev.geo; S.shellField = prev.shell; S.space = prev.space;
      S.phase = prev.phase; S.placeId = prev.placeId;
      renderScenePickers();
      status(`场景装不上：${e && e.message || e}（退回原场景）`, 'err');
    }
  } finally {
    if (op === S.sceneOp) S.loadingScene = '';
    setBusy(false);
    restoreSelectFocus(refocus);
  }
}

// ---------------------------------------------------------------------------
// 本地预览（跑的就是运行时那份模拟）
// ---------------------------------------------------------------------------
/** 锚点模式 = 「角色挂点」时的那一块工作态（`authoring.attach` 在 = 这一档开着） */
function attachDef() {
  const au = S.doc && S.doc.authoring;
  const at = au && au.attach;
  return at && typeof at === 'object' ? at : null;
}
function attachOn() { return !!attachDef(); }
function attachHeight() {
  const at = attachDef(); if (!at) return 0;
  return Math.max(0, Number.isFinite(at.heightWu) ? at.heightWu : ATTACH_DEFAULT_HEIGHT_WU);
}
/**
 * 挂点锚点：**角色脚点的画面点 + 横向偏移 + 离脚点高度**——与运行时
 * `HeldPropSystem.resolveAnchorWorld` 同一条式子（`contact.x + pose.x`, `contact.y`, `−pose.y`），
 * 解世界点仍走 `VfxSpace.anchorToWorld`（= 游戏的 `VfxSystem.sceneToWorld`）。
 * 场上没有角色 ⇒ 返回 null，锚点退回场景面那一档，状态栏黄字说明（不静默假装挂上了）。
 */
function attachAnchor() {
  if (!attachOn()) return null;
  if (!S.player.on || !S.player.scene) return null;
  const at = attachDef();
  const dx = Number.isFinite(at.offsetX) ? at.offsetX : 0;
  return { x: round2(S.player.scene[0] + dx), y: round2(S.player.scene[1]), h: attachHeight() };
}

function effectiveAnchor() {
  const att = attachAnchor();
  if (att) return att;
  return sceneAnchor();
}
/**
 * 效果的预览锚点 `authoring.anchor` 是不是**这个场景**的：它是作者场景（`authoring.sceneId`）里的画面点，别的场景里没有意义。
 * 原来不看场景：在义庄按 A 点过一下、存了，换到跑马梁（这里也没布置它）预览按义庄的画面坐标发射（常在地图外），
 * 镜头也对准那里，「把当前效果布置到这里」把新布置钉在那个点上。没记作者场景的老资产照旧处处用它。
 */
function authoringAnchorHere(au) {
  return !au.sceneId || (!!S.scene && au.sceneId === S.scene.id);
}
/** 场景面上的锚点（不看挂点那一档）：活动布置的 anchor → 效果的预览锚点（只在它的作者场景）→ 出生点 → 画面中下 */
function sceneAnchor() {
  const p = activePlacement();
  if (p && p.anchor && Number.isFinite(p.anchor.x) && Number.isFinite(p.anchor.y)) return p.anchor;
  const au = S.doc && S.doc.authoring;
  if (au && au.anchor && Number.isFinite(au.anchor.x) && authoringAnchorHere(au)) return au.anchor;
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
  resetWind();
  S.simInput = S.doc ? simInput() : null;
  const inp = S.simInput;
  S.area = inp && inp.placement && (inp.area || inp.confine) ? { id: inp.placement, poly: inp.area, confine: inp.confine } : null;
  if (!S.rt || !S.space || !S.doc) return;
  const a = anchorWorld(); if (!a) return;
  try {
    const snap = JSON.parse(JSON.stringify(S.doc));
    const hasBeams = Array.isArray(snap.beams) && snap.beams.length > 0;
    if (!Array.isArray(snap.emitters)) snap.emitters = [];
    if (!snap.emitters.length && !hasBeams) { S.simErr = '还没有发射器也没有光柱'; return; }
    // 薄片绑的可燃物模板：与 VfxSystem 同形（id → resolveBurnable 清洗后的模板）；表没读到 = null（纸不可燃，状态栏说）
    S.sim = new S.rt.vfxSim.VfxInstanceSim(inp.id, snap, a, inp.seed, S.space, inp.countScale,
      { area: inp.area, confine: inp.confine, burnTemplates: S.burn.map, surfaceKind: previewSurfaceKind(effectiveAnchor()) });
  } catch (e) {
    S.simErr = String(e && e.message || e);
  }
}
/** 拖拽中的便宜同步：只挪那些缓存在运行态里的量（原点 / 巢中心），不重建池子（否则一拖就闪回 t=0） */
function patchSim() {
  if (!S.sim || !S.doc) return;
  const a = anchorWorld(); if (!a) return;
  // 锚点本体也得跟上：挂点模式每帧调运行时的 `moveAnchor`，它按 `sim.anchorWorld` 算**增量**——
  // 这里只挪 origin 不同步它，下一拍整批会被再挪一次（双倍位移，且不报错）。
  S.sim.moveAnchor(a);
  for (const e of S.sim.emitters) {
    const def = (S.doc.emitters || []).find((x) => x.id === e.def.id); if (!def) continue;
    const off = def.offset || [0, 0, 0];
    S.sim.moveEmitterOrigin(e.def.id, [a[0] + off[0], a[1] + off[1], a[2] + off[2]]);
  }
  syncSimBeams();
}
/**
 * 拖光柱把手时的便宜同步：把 doc 里此刻的光柱定义换进模拟里的光柱运行态（形状过得了运行时闸门才换），
 * 帧标脏让它按新定义重解——光柱跟手走，不重建模拟（尘埃不回 t=0）。
 */
function syncSimBeams() {
  if (!S.sim || !S.rt || !S.rt.vfxBeam || !S.doc) return;
  for (const b of S.sim.beams) {
    const def = (S.doc.beams || []).find((x) => x && x.id === b.def.id);
    if (!def || S.rt.vfxBeam.beamDefErrors(def).length) continue;
    b.def = clone(def);
    b.look = S.rt.vfxBeam.resolveBeamLook(b.def);
    b.frameRev = -1;
  }
}

function playerCtx() {
  if (!S.player.on || !S.player.world) return null;
  return { world: S.player.world, speed: S.player.speed };
}
/** 玩家动静场（常驻、跟随）——与 `VfxSystem.update` 那一段同式 */
function updatePlayerField(dt) {
  if (!S.rt) return;
  if (!S.playerAirflow) S.playerAirflow = new S.rt.vfxMotionSource.VfxMotionAirflow('player:motion');
  if (!S.playerContact) S.playerContact = new S.rt.vfxMotionSource.VfxMotionContact();
  if (!S.fields.includes(S.playerAirflow.field)) { S.playerAirflow.reset(); S.playerContact.reset(); }
  const foot = S.player.on ? S.player.world : null;
  const air = S.playerAirflow.sample(foot, dt, foot && S.space ? S.space.metricAt(foot[0], foot[2]) : 1);
  const contact = S.playerContact.sample(foot, dt, foot && S.space ? S.space.metricAt(foot[0], foot[2]) : 1);
  S.contacts = contact ? [contact] : [];
  if (foot) { if (!S.fields.includes(air)) S.fields.push(air); }
  else { const i = S.fields.indexOf(air); if (i >= 0) S.fields.splice(i, 1); }
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
  walkTick(dt);                                          // 角色照走：跑不起来模拟时也看得见锚点在动
  // 手拖的玩家停手了（100 ms 没挪）：速度归零——人站住了，动静场强度就是 0（来回走的速度由 walkTick 显式给）
  if (!S.walk.on && S.player.speed && performance.now() - (S.player.movedAt || 0) > 100) S.player.speed = 0;
  if (!S.sim) return;
  updatePlayerField(dt);
  // 挂点模式：把锚点挪到角色挂点上，用的就是运行时那份 `VfxInstanceSim.moveAnchor`
  //（= 游戏里 `HeldPropSystem.syncVfx` → `VfxSystem.moveVfx` 那条）——已发射的粒子留在原地。
  if (attachOn()) { const a = anchorWorld(); if (a) S.sim.moveAnchor(a); }
  for (let i = S.fields.length - 1; i >= 0; i--) {
    const f = S.fields[i];
    if (f.remaining === Infinity) continue;
    f.remaining -= dt;
    if (f.remaining <= 0) { if (f === S.playerField) S.playerField = null; S.fields.splice(i, 1); }
  }
  // 与 `Game` 同序：风的钟先推进，再按它跑模拟（`VfxSystem.update` 的 ctx 同形）
  if (S.wind) S.wind.advance(dt);
  const wind = S.wind ? S.wind.params : null;
  // 外部给点：游戏里燃烧系统每帧交一次（`BurnSystem.presentPlates`）；这里每帧交预览用假点（同一个 setSpawnPoints）
  feedExternalPoints();
  S.sim.step(dt, { fields: S.fields, contacts: S.contacts, player: playerCtx(), time: S.simTime, wind, windTime: S.wind ? S.wind.time : 0,
    fires: S.fires });
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
    // 暂停期间摆的 / 拖的玩家不算"正在跑"：按播放那一拍从站定开始（来回走的速度下一拍由 walkTick 给回）
    S.player.speed = 0;
    let last = performance.now();
    simTimer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000) * S.speed; last = now;
      stepSim(dt); draw(); renderSimBar();
    }, 16);
  }
  renderSimBar();
}
function resetSim() {
  rebuildSim(); S.fields.length = 0; S.playerField = null; S.fires.length = 0; draw(); renderSimBar();
  // 重置 = 重开本地预览：顺手重读可燃物模板表（燃烧工作台里改了模板没切窗口也能跟上；内容没变什么都不做）
  void refreshBurnTemplates();
}

// ---------------------------------------------------------------------------
// 燃烧预览（外部给点的假点 / 火焰调试）——只在预览内存里
// ---------------------------------------------------------------------------
function hasExternalShape(doc) {
  return !!(doc && Array.isArray(doc.emitters) && doc.emitters.some((e) => e && e.spawn && e.spawn.shape && e.spawn.shape.kind === 'external'));
}
/** 预览用假点（世界点 + 半径）：锚点周围一小圈，贴锚点那一高度。没有 external 发射器 = null */
function externalPreviewPoints() {
  if (!hasExternalShape(S.doc)) return null;
  const a = anchorWorld(); if (!a) return null;
  const out = [];
  for (let i = 0; i < EXT_PREVIEW_COUNT; i++) {
    const t = (i / EXT_PREVIEW_COUNT) * Math.PI * 2;
    out.push({ pos: [a[0] + Math.cos(t) * EXT_PREVIEW_SPREAD_WU, a[1], a[2] + Math.sin(t) * EXT_PREVIEW_SPREAD_WU], r: EXT_PREVIEW_RADIUS_WU });
  }
  return out;
}
function feedExternalPoints() {
  if (!S.sim || typeof S.sim.setSpawnPoints !== 'function') return;
  const pts = externalPreviewPoints();
  if (!pts) return;
  const buf = new Float32Array(pts.length * 4);
  pts.forEach((p, i) => { buf[i * 4] = p.pos[0]; buf[i * 4 + 1] = p.pos[1]; buf[i * 4 + 2] = p.pos[2]; buf[i * 4 + 3] = p.r; });
  S.sim.setSpawnPoints(buf, pts.length);
}
/** 火焰调试：在世界点 `world`（表面上）立一段竖直向上的火焰 */
function addFireAt(world) {
  const at = world.map(round2);
  S.fires.push({ x: at[0], y: at[1], z: at[2], ax: 0, ay: 1, az: 0, len: FIRE_DEBUG_LEN_WU, r: FIRE_DEBUG_R_WU });
  const hint = fireHint();
  status(`放了一段调试火焰（高 ${FIRE_DEBUG_LEN_WU} wu、粗 ${FIRE_DEBUG_R_WU} wu，只在本地预览里）：${hint.text}`, hint.kind);
  setTool('select');                                   // 与发刺激（K）同：放一下就回选择，再放按 I
  renderSimBar();
}

// ---------------------------------------------------------------------------
// 可燃物模板（薄片 plate.burnable 绑的；本台只读，唯一写入者是燃烧工作台）
// ---------------------------------------------------------------------------
/** 在飞的那次模板表读取；在飞期间又被叫 = 排一次在它后面（多次合成一次） */
let burnInFlight = null;
let burnQueued = null;
/**
 * 重取可燃物模板表（`/api/burnables`）。每份原始文档过**打包进来的运行时** `resolveBurnable(doc, id)`（页面不另写清洗 / 缺省）
 * 装成 `S.burn.map`，建模拟时当 `burnTemplates` 传（与 `VfxSystem` 同形）。
 * 时机：页面启动、打开效果（`openEffect` 在重建模拟前等它）、「↺ 重置」、窗口重新获得焦点（燃烧工作台里存了盘切回来）。
 * **内容真变了才动**：表内容（原始文档 + 读不懂清单）一样就什么都不做；变了且当前效果绑着的模板清洗结果变了才重建本地预览
 * （`opts.rebuild === false` = 调用方自己马上重建 / 重画，这里只换表）。读不到不抛：留着上一份表、`S.burn.err` 记原因。
 * 返回 promise<bool>：表内容变没变。
 */
function refreshBurnTemplates(opts) {
  const rebuild = !(opts && opts.rebuild === false);
  if (!burnInFlight) {
    burnInFlight = loadBurnTemplates(rebuild).finally(() => { burnInFlight = null; });
    return burnInFlight;
  }
  if (!burnQueued) {
    const q = { rebuild };
    q.promise = burnInFlight.then(() => { burnQueued = null; return refreshBurnTemplates({ rebuild: q.rebuild }); });
    burnQueued = q;
  } else if (rebuild) burnQueued.rebuild = true;
  return burnQueued.promise;
}
async function loadBurnTemplates(rebuild) {
  let j;
  try {
    j = await API.json('/api/burnables');
  } catch (e) {
    const err = String((e && e.message) || e);
    const changed = S.burn.err !== err;
    S.burn.err = err;
    if (changed && rebuild) { renderInspector(); renderSimBar(); }
    return false;
  }
  const rows = Array.isArray(j.templates) ? j.templates : [];
  const errors = j.errors && typeof j.errors === 'object' ? j.errors : {};
  const key = canonJson({ docs: rows.map((r) => [r.id, r.doc]), errors });
  const res = S.rt && S.rt.burnables ? S.rt.burnables.resolveBurnable : null;
  const hadErr = !!S.burn.err;
  if (S.burn.loaded && key === S.burn.key && (S.burn.map || !res)) {
    S.burn.err = '';
    if (hadErr && rebuild) { renderInspector(); renderSimBar(); }
    return false;
  }
  const before = S.doc ? boundBurnKey() : '';
  let map = null;
  if (res) {
    map = new Map();
    for (const r of rows) { const t = res(r.doc, r.id); if (t) map.set(r.id, t); }
  }
  S.burn = { loaded: true, err: '', rows, errors, map, key };
  if (rebuild) {
    if (S.doc && boundBurnKey() !== before) { rebuildSim(); draw(); }
    renderInspector(); renderSimBar();
  }
  return true;
}
/** 当前效果绑着的模板此刻的清洗结果（规范串）：模板表换了但这几份没变 = 不重建本地预览 */
function boundBurnKey() {
  const ids = [...new Set(plateBurnBindings(S.doc).map((b) => b.template))].sort();
  return canonJson(ids.map((id) => [id, (S.burn.map && S.burn.map.get(id)) || null]));
}
/** 效果里绑了可燃模板的薄片：`[{emitter, index, template}]`（template 去空白，与运行时 `plateBurnOf` 同口径；形状坏 / 没写不算） */
function plateBurnBindings(doc) {
  const out = [];
  (doc && Array.isArray(doc.emitters) ? doc.emitters : []).forEach((e, i) => {
    const b = e && e.plate && e.plate.burnable;
    const t = b && typeof b === 'object' && !Array.isArray(b) && typeof b.template === 'string' ? b.template.trim() : '';
    if (t) out.push({ emitter: String(e.id || ''), index: i, template: t });
  });
  return out;
}
/**
 * 一个模板 id 能不能让薄片可燃、为什么不能（检视器保值展示的原因、火工具提示、状态栏共用这一份判据）：
 * `{id, state, short, why, row}`，`state` ∈ ok / missing / unreadable / consume / unresolvable / unresolved / noTable。
 * 不能绑的原因句取服务端 `note`（形状闸门 `plate_burnable_notes` 同一句）；表里没有的与闸门同一个前缀。
 */
function burnTemplateStatus(id) {
  const B = S.burn;
  const tid = String(id || '').trim();
  if (!B.loaded) {
    return { id: tid, state: 'noTable', short: '模板表没读到', row: null,
      why: `可燃物模板表没读到${B.err ? `（${B.err}）` : ''}：本地预览里认不出「${tid}」，这张纸在这里不可燃` };
  }
  const row = B.rows.find((r) => r.id === tid) || null;
  if (!row) {
    return B.errors[tid]
      ? { id: tid, state: 'unreadable', short: '读不懂', row, why: `plate.burnable.template「${tid}」这份模板读不懂（${B.errors[tid]}）：运行时这张纸不可燃` }
      : { id: tid, state: 'missing', short: '不存在', row, why: `plate.burnable.template「${tid}」不在 assets/data/burnables/ 里（或读不懂）：运行时这张纸不可燃` };
  }
  if (!row.bindable) {
    const consume = row.mode === 'consume';
    return { id: tid, state: consume ? 'consume' : 'unresolvable', short: consume ? '消耗燃烧，薄片不能绑' : '装不上', row,
      why: row.note || `plate.burnable.template「${tid}」薄片绑不了：运行时这张纸不可燃` };
  }
  if (B.map && !B.map.has(tid)) {
    return { id: tid, state: 'unresolved', short: '运行时装不上', row,
      why: `plate.burnable.template「${tid}」过运行时 resolveBurnable 得到空（没图 / 没正的真实尺寸）：运行时这张纸不可燃` };
  }
  return { id: tid, state: 'ok', short: '', why: '', row };
}
/**
 * 当前效果里每个绑了模板的薄片**此刻在本地预览里真的可燃吗**：`[{emitter, index, template, ok, why}]`。
 * 先看模拟本体（`sim.emitters[i].burn` 非空 = 运行时 `plateBurnOf` 装上了），不可燃再说原因：
 * 运动模型不是薄片（运行时根本不读 plate）/ 模板的问题（`burnTemplateStatus`）/ 本地预览没在跑。
 */
function burnBindingStates() {
  return plateBurnBindings(S.doc).map((b) => {
    const rtEm = S.sim ? S.sim.emitters.find((e) => e.def.id === b.emitter) : null;
    if (rtEm && rtEm.burn) return Object.assign({ ok: true, why: '' }, b);
    const em = S.doc.emitters[b.index];
    const solver = S.rt && S.rt.vfxProgram ? S.rt.vfxProgram.resolveEmitterProgram(em).solver : 'plate';
    if (solver !== 'plate') return Object.assign({ ok: false, why: `发射器「${b.emitter}」的运动模型不是薄片：plate.burnable 运行时不读` }, b);
    const st = burnTemplateStatus(b.template);
    if (st.state !== 'ok') return Object.assign({ ok: false, why: `发射器「${b.emitter}」：${st.why}` }, b);
    return Object.assign({ ok: false, why: S.sim ? `发射器「${b.emitter}」绑的「${b.template}」本地预览没装上（点「↺ 重置」再试）` : '本地预览没在跑' }, b);
  });
}
/** 火工具（I）的提示：这个效果里放火能点着什么（`{kind, text}`） */
function fireHint() {
  const states = burnBindingStates();
  const ok = states.filter((s) => s.ok), bad = states.filter((s) => !s.ok);
  if (!states.length) return { kind: 'warn', text: '这个效果没有可燃薄片（薄片一节「可燃模板」选一份面燃烧模板），火焰点不着东西' };
  if (!ok.length) return { kind: 'warn', text: `薄片绑了可燃模板，但本地预览里不可燃——${bad.map((s) => s.why).join('；')}——火焰点不着东西` };
  const tids = [...new Set(ok.map((s) => s.template))];
  return { kind: bad.length ? 'warn' : 'ok',
    text: `碰到的可燃纸片受热够了会着（模板 ${tids.map((t) => `「${t}」`).join(' / ')}）${bad.length ? `；另有不可燃的——${bad.map((s) => s.why).join('；')}` : ''}` };
}
/** 检视器「打开燃烧工作台」：另起燃烧工作台进程（带当前模板 id）；那边存盘后切回来靠窗口焦点重读模板表 */
async function openBurnWorkbench(id) {
  const tid = String(id || '').trim();
  try {
    const r = await API.post('/api/open_burn_workbench', tid ? { id: tid } : {});
    status(`${r.message || '已另起燃烧工作台'}：那边存盘后切回这里，模板表会重读、本地预览按新模板烧`, 'ok');
  } catch (e) {
    status(`燃烧工作台起不来：${(e && e.message) || e}`, 'err');
  }
}
function clearFires() { S.fires.length = 0; draw(); renderSimBar(); status('清掉了调试火焰（已经着了的纸照样烧完）'); }
/** 视图里画、但不可选中的预览标记：外部给点的假点、调试火焰 */
function previewMarks() {
  const out = [];
  const pts = S.doc && S.sim ? externalPreviewPoints() : null;
  if (pts) pts.forEach((p, i) => out.push({ pos: p.pos, color: [1, 0.62, 0.2, 0.95], size: 6, label: i === 0 ? '预览用假点（外部给点）' : '' }));
  S.fires.forEach((f, i) => out.push({ pos: [f.x, f.y, f.z], top: [f.x + f.ax * f.len, f.y + f.ay * f.len, f.z + f.az * f.len],
    color: [1, 0.35, 0.1, 1], size: 8, label: i === 0 ? '调试火焰（只在预览里）' : '' }));
  return out;
}
/**
 * 可燃薄片此刻：在烧 / 烧没（永久作废的槽位）；`flammable` = 模拟里真有装上模板的薄片（运行时 `plateBurnOf` 给了燃烧态），
 * `bound` = 效果里绑了模板的薄片个数（绑了不等于装上，原因见 `burnBindingStates`）。
 */
function burnStats() {
  let burning = 0, burnt = 0, flammable = false;
  const bound = S.doc ? plateBurnBindings(S.doc).length : 0;
  if (!S.sim) return { burning, burnt, flammable, bound };
  for (const e of S.sim.emitters) {
    if (!e.burn) continue;
    flammable = true;
    burning += e.burn.burning;
    for (let i = 0; i < e.burn.burnt.length; i++) if (e.burn.burnt[i]) burnt++;
  }
  return { burning, burnt, flammable, bound };
}

// ---------------------------------------------------------------------------
// 给视图看的东西（物体 / 球 / 粒子 / 场）
// ---------------------------------------------------------------------------
function emColor(i) { return EM_COLORS[i % EM_COLORS.length]; }
function cssOf(c) { return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`; }

function particlePoints() {
  const out = [];
  if (!S.sim) return out;
  const progressOf = S.rt && S.rt.vfxPlateBurn ? S.rt.vfxPlateBurn.plateBurnProgress : null;
  const beamApi = S.rt && S.rt.vfxBeam;
  const loc = { t01: 0, u: 0, v: 0, edge: 0 };
  const sc = { x: 0, y: 0 };
  S.sim.emitters.forEach((e, i) => {
    const p = e.p, pts = [];
    // 被光柱照亮（光柱里的尘埃）：柱外的在游戏里看不见，点云里也不画（判据是运行时 vfxBeam 那几个函数本体）
    const bl = beamApi && e.def.appearance && e.def.appearance.beamLit ? S.sim.beamById(e.def.appearance.beamLit.beam) : null;
    if (bl) S.sim.beamFrame(bl);
    const blPulse = bl ? S.sim.beamPulse(bl) : 1;
    // 可燃薄片：燃着的按运行时 `plateBurnProgress` 分两档画——前半程火色（着了），后半程焦黑（快成灰）；烧没的不在活池里、自然不画
    const lit = [], charred = [];
    for (let k = 0; k < p.cap; k++) {
      if (!p.alive[k]) continue;
      if (bl) {
        let inside = false;
        if (bl.frame3d) inside = beamApi.beam3dLocal(bl.frame3d, p.x[k], p.y[k], p.z[k], loc);
        else if (bl.frame2d) { S.space.toScene([p.x[k], p.y[k], p.z[k]], sc); inside = beamApi.beam2dLocal(bl.frame2d, sc.x, sc.y, loc); }
        const fade = S.simTime > 0 ? bl.fade : 1;
        if (!inside || beamApi.beamGainAt(bl.def, bl.look, loc, blPulse, fade) <= 0.002) continue;
      }
      const prog = e.burn && progressOf ? progressOf(e.burn, k) : -1;
      (prog < 0 ? pts : prog < 0.5 ? lit : charred).push(p.x[k], p.y[k], p.z[k]);
    }
    const c = emColor(i);
    out.push({ id: e.def.id, pts, color: c, css: cssOf(c), size: 5, sizeWu: e.def.appearance.sizeWu });
    if (e.burn) {
      const cc = e.burn.P.charColor;
      const fire = [1, 0.55, 0.12, 1], ch = [Math.max(0.12, cc[0]), Math.max(0.1, cc[1]), Math.max(0.09, cc[2]), 1];
      out.push({ id: e.def.id, burn: 'burning', pts: lit, color: fire, css: cssOf(fire), size: 6, sizeWu: e.def.appearance.sizeWu });
      out.push({ id: e.def.id, burn: 'charred', pts: charred, color: ch, css: cssOf(ch), size: 6, sizeWu: e.def.appearance.sizeWu });
    }
  });
  return out;
}

function objects() {
  const out = [];
  if (!S.doc) return out;
  const a = anchorWorld();
  // **锚点排在发射器前面**：偏移为 0 时两者叠在同一点（线上六份效果没有一个发射器写了 offset，全叠着），
  // 点它必须拿到锚点——布置的锚点是**这一个场景**的位置，发射器 offset 写进效果文件、**所有场景所有时段的布置**一起挪。
  // 原来发射器在前：在马梁拖萤火虫想挪位置，改的是 fireflies.json 的 offset，存盘后每个场景的萤火虫都偏了。
  // 偏移不为 0 的发射器在别的点上，照样能直接点中；叠着的想选发射器走左栏那一行（选中后拾取优先保住当前选中项）
  const ap = activePlacement();
  if (a) out.push({ key: 'anchor', label: attachOn() ? '预览锚点' : ap ? `布置锚点 · ${ap.id}` : '预览锚点', pos: a, color: [1, 1, 1, 0.9], size: 9, selected: S.sel.key === 'anchor' });
  (S.doc.emitters || []).forEach((em, i) => {
    if (!a) return;
    const off = em.offset || [0, 0, 0];
    const pos = [a[0] + off[0], a[1] + off[1], a[2] + off[2]];
    out.push({ key: `emitter:${em.id}`, label: `发射器 ${em.id}`, pos, color: emColor(i), size: 10, selected: S.sel.key === `emitter:${em.id}` });
  });
  // 活动布置的区域顶点：每个都是可选对象（一选中立刻出 move gizmo），名字只在选中时写（九个顶点全写字就糊了）
  if (ap && S.cal) {
    for (const role of AREA_ROLES) {
      const poly = areaPoly(ap, role); if (!poly) continue;
      const c = AREA_RGB[role];
      poly.forEach((pt, i) => {
        const key = `area:${role}:${i}`, sel = S.sel.key === key;
        out.push({ key, label: sel ? `${AREA_LABEL[role]} · 顶点 ${i + 1}` : '', pos: vertexWorld(pt), color: [c[0] / 255, c[1] / 255, c[2] / 255, 1], size: 7, selected: sel, vertex: true });
      });
    }
  }
  // 表面材质区的顶点（打开「显示并编辑表面材质区」时）：与粒子区域顶点同一套拖 / 加点 / 删点
  if (S.cal && S.surfEdit) {
    sceneSurfaces().forEach((r, ri) => {
      if (!r || !isPoly(r.polygon)) return;
      const role = `s${ri}`, c = roleRgb(role);
      r.polygon.forEach((pt, i) => {
        const key = `area:${role}:${i}`, sel = S.sel.key === key;
        out.push({ key, label: sel ? `${roleLabel(role)} · 顶点 ${i + 1}` : '', pos: vertexWorld(pt), color: [c[0] / 255, c[1] / 255, c[2] / 255, 1], size: 7, selected: sel, vertex: true });
      });
    });
  }
  // 光柱的两个把手：起点（带名字）/ 终点（选中时才写名字）。拖起点 / 终点改的是效果里这根光柱的 from / to
  for (const b of (S.doc.beams || [])) {
    if (!b || !b.id) continue;
    for (const which of ['from', 'to']) {
      const key = `${which === 'from' ? 'beam' : 'beamEnd'}:${b.id}`, sel = S.sel.key === key;
      const pos = beamPointWorld(b, which); if (!pos) continue;
      out.push({ key, label: which === 'from' ? `光柱 ${b.id}${b.mode === '2d' ? '（2D）' : ''}` : sel ? `光柱 ${b.id} · 终点` : '',
        pos, color: which === 'from' ? [1, 0.86, 0.45, 1] : [1, 0.7, 0.3, 1], size: which === 'from' ? 10 : 8, selected: sel });
    }
  }
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
    const be = S.rt?.vfxProgram.resolveEmitterProgram(em).solver === 'flock' ? em.behavior : null; if (!be || !be.home) continue;
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
// 光柱（体积光）：把手 / 线框 / 原画视图预览
// ---------------------------------------------------------------------------
/** 选中键里的光柱：`beam:<id>`（起点）/ `beamEnd:<id>`（终点）；别的键 = null */
function beamKeyOf(key) {
  const m = /^(beam|beamEnd):(.+)$/.exec(key || '');
  return m ? { which: m[1] === 'beam' ? 'from' : 'to', id: m[2] } : null;
}
function beamDefOf(id) { return S.doc ? (S.doc.beams || []).find((b) => b && b.id === id) || null : null; }
/** 检视器与左栏光柱那排按钮作用的光柱：选中的是光柱把手 → 它；否则 null（检视器回到发射器） */
function currentBeam() { const k = beamKeyOf(S.sel.key); return k ? beamDefOf(k.id) : null; }
/** 光柱按钮作用的光柱：选中的 → 最近操作的 → 第一根 */
function focusBeam() {
  if (!S.doc) return null;
  const bs = S.doc.beams || [];
  return currentBeam() || (S.beamId && bs.find((b) => b.id === S.beamId)) || bs[0] || null;
}
/** 锚点投到画面上的那一点（2D 光带的原点；与运行时 `beamFrame` 同一条：toScene(锚点世界点)） */
function beamAnchorScene() {
  const a = anchorWorld(); if (!a || !S.space) return null;
  const o = { x: 0, y: 0 }; S.space.toScene(a, o); return [o.x, o.y];
}
/** 锚点正下方地面点投到画面（2D 光带立在这里那一深度的直立面上） */
function beamFootScene() {
  const a = anchorWorld(); if (!a || !S.space) return null;
  const o = { x: 0, y: 0 }; S.space.toScene([a[0], S.space.groundY(a[0], a[2]), a[2]], o); return [o.x, o.y];
}
/** 画面点 → 2D 光带把手的世界点（锚点脚下直立面上、投影正好对准这一画面点；与尘埃出生同一个 `uprightWorldAtScene`） */
function beamSceneToWorld(sx, sy) {
  const foot = beamFootScene();
  if (foot && S.space && S.space.uprightWorldAtScene) return S.space.uprightWorldAtScene(foot[0], foot[1], sx, sy);
  return S.cal ? S.cal.sceneToWorldGround(sx, sy) : null;
}
function beamPointWorld(b, which) {
  const a = anchorWorld(); if (!a) return null;
  if (b.mode === '3d') {
    const s = b.shape3d || {};
    const v = which === 'from' ? (Array.isArray(s.from) ? s.from : [0, 0, 0]) : (Array.isArray(s.to) ? s.to : [0, 0, 0]);
    return [a[0] + v[0], a[1] + v[1], a[2] + v[2]];
  }
  const s = b.shape2d || {}, as = beamAnchorScene(); if (!as) return null;
  const v = which === 'from' ? (Array.isArray(s.from) ? s.from : [0, 0]) : (Array.isArray(s.to) ? s.to : [0, 0]);
  return beamSceneToWorld(as[0] + v[0], as[1] + v[1]);
}
/** 写一个把手（3D = 相对锚点的世界偏移；2D = 相对锚点画面点的画面偏移）。起点与终点挤到 1 wu 以内 = 不写（形状闸门会拒存） */
function writeBeamPoint(id, which, value) {
  const b = beamDefOf(id); if (!b || !value.every(Number.isFinite)) return;
  const is3d = b.mode === '3d';
  const sh = is3d ? (b.shape3d || (b.shape3d = { to: [0, -100, 0], section: { kind: 'rect', width: 60, height: 20 } })) : (b.shape2d || (b.shape2d = { to: [0, 100], width: [30, 90] }));
  const v = value.map(round2);
  const other = which === 'from' ? sh.to : (sh.from || (is3d ? [0, 0, 0] : [0, 0]));
  if (Array.isArray(other) && Math.hypot(...v.map((x, i) => x - (other[i] || 0))) < 1) return;
  if (which === 'from') {
    if (v.every((x) => x === 0)) delete sh.from; else sh.from = v;
    if (is3d) orderKeys(sh, ['from', 'to', 'section', 'spreadDeg', 'rollDeg']); else orderKeys(sh, ['from', 'to', 'width', 'occludeByDepth']);
  } else sh.to = v;
}
/** 光柱把手的世界位移（gizmo / 微移 / 3D 相对拖）→ 写回 */
function applyBeamMove(base, v) {
  if (base.mode === '3d') { writeBeamPoint(base.id, base.which, [0, 1, 2].map((i) => base.value[i] + v[i])); return; }
  const cal = S.cal, as = beamAnchorScene(); if (!cal || !as) return;
  const s = cal.worldToScene(base.pos[0] + v[0], base.pos[1] + v[1], base.pos[2] + v[2]);
  writeBeamPoint(base.id, base.which, [s[0] - as[0], s[1] - as[1]]);
}
/** 世界点（表面拾取 / Alt 拖）→ 把手 */
function setBeamPointToWorld(base, p) {
  const a = anchorWorld(); if (!a) return;
  if (base.mode === '3d') { writeBeamPoint(base.id, base.which, [p[0] - a[0], p[1] - a[1], p[2] - a[2]]); return; }
  const cal = S.cal, as = beamAnchorScene(); if (!cal || !as) return;
  const s = cal.worldToScene(p[0], p[1], p[2]);
  writeBeamPoint(base.id, base.which, [s[0] - as[0], s[1] - as[1]]);
}
/** 画面点（2D 视图 Alt 拖）→ 把手：2D = 画面偏移；3D = 那一点脚下的地面世界点 */
function setBeamPointToScene(base, sp) {
  if (base.mode === '3d') { if (S.cal) setBeamPointToWorld(base, S.cal.sceneToWorldGround(sp[0], sp[1])); return; }
  const as = beamAnchorScene(); if (!as) return;
  writeBeamPoint(base.id, base.which, [sp[0] - as[0], sp[1] - as[1]]);
}
/** 本地预览模拟里的光柱运行态 + 显示用的淡入淡出（还没播 = 画满，好调形状；播起来按真实淡入淡出） */
function previewBeamRuntimes() {
  if (!S.sim || !S.sim.beams) return [];
  return S.sim.beams.map((b) => {
    S.sim.beamFrame(b);
    return { runtime: Object.assign({}, b, { fade: S.simTime > 0 ? b.fade : 1 }), pulse: S.sim.beamPulse(b) };
  });
}
/** 光柱的画面包络（与运行时 `VfxRenderer.renderBeams` 同一条：3D = 两圈截面顶点投到画面的凸包；2D = 四角） */
function beamHullScene(b) {
  const api = S.rt && S.rt.vfxBeam; if (!api || !S.space) return null;
  if (b.frame3d) {
    const c = b.frame3d.corners, m = c.length / 3, pts = new Float32Array(m * 2), o = { x: 0, y: 0 };
    for (let k = 0; k < m; k++) { S.space.toScene([c[k * 3], c[k * 3 + 1], c[k * 3 + 2]], o); pts[k * 2] = o.x; pts[k * 2 + 1] = o.y; }
    const out = new Float32Array(api.VFX_BEAM_MAX_HULL * 2);
    return { pts: out, count: api.convexHull2d(pts, m, out) };
  }
  if (b.frame2d) return { pts: b.frame2d.corners, count: 4 };
  return null;
}
/** 3D 视图：光柱线框（3D = 两圈截面 + 侧棱；2D = 光带四边立在锚点脚下的直立面上） */
function beamLines3() {
  const out = [];
  if (!S.sim || !S.sim.beams) return out;
  for (const b of S.sim.beams) {
    S.sim.beamFrame(b);
    const sel = beamKeyOf(S.sel.key);
    const color = sel && sel.id === b.def.id ? [1, 0.9, 0.3, 0.95] : [1, 0.82, 0.5, 0.55];
    const arr = [];
    if (b.frame3d) {
      const c = b.frame3d.corners, n = b.frame3d.sides;
      const P = (ring, k) => [c[(ring * n + k) * 3], c[(ring * n + k) * 3 + 1], c[(ring * n + k) * 3 + 2]];
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        arr.push(...P(0, k), ...P(0, k2), ...P(1, k), ...P(1, k2), ...P(0, k), ...P(1, k));
      }
      const f = b.frame3d;
      arr.push(...f.origin, f.origin[0] + f.axis[0] * f.length, f.origin[1] + f.axis[1] * f.length, f.origin[2] + f.axis[2] * f.length);
    } else if (b.frame2d) {
      const c = b.frame2d.corners;
      const W = [0, 1, 2, 3].map((k) => beamSceneToWorld(c[k * 2], c[k * 2 + 1]));
      if (W.every(Boolean)) for (let k = 0; k < 4; k++) arr.push(...W[k], ...W[(k + 1) % 4]);
    }
    if (arr.length) out.push({ pts: new Float32Array(arr), color });
  }
  return out;
}
/** 原画视图：光柱真实预览（运行时那段 GLSL 编译出来画）+ 选中的那根描边 */
function drawBeams2d(g, view) {
  if (!S.rt || !S.rt.vfxBeamGlsl || !S.sim || !S.cal || !S.layers.beams) return;
  if (!beamPreview) { beamPreview = new BeamPreview(); beamPreview.onAsset = () => draw(); }
  const beams = previewBeamRuntimes();
  if (!beams.length) return;
  const env = {
    affine: S.space ? S.rt.vfxBeam.sceneQAffine(S.space) : null,
    wuPerQ: S.space ? S.space.wuPerQ : 1, time: S.simTime,
    uprightQz: S.space && S.space.uprightWorldAtScene
      ? (fx, fy, sx, sy) => { const q = [0, 0, 0]; S.space.toQ(S.space.uprightWorldAtScene(fx, fy, sx, sy), q); return q[2]; } : null,
    hasDepth: !!(S.cal && S.cal.shell),
  };
  const n = beamPreview.draw(g, S.rt, S.cal, env, beams, view, (b) => beamHullScene(b), S.scene ? S.scene.depthTolerance || 0.05 : 0.05);
  if (n < 0 && beamPreview.err && !S.beamPreviewErrShown) { S.beamPreviewErrShown = true; status(`光柱预览着色器编译失败：${beamPreview.err}`, 'err'); }
  const sel = beamKeyOf(S.sel.key);
  if (sel) {
    const b = beams.find((x) => x.runtime.def.id === sel.id);
    const hull = b ? beamHullScene(b.runtime) : null;
    if (hull && hull.count >= 3) {
      g.strokeStyle = 'rgba(255,230,80,.7)'; g.lineWidth = 1; g.setLineDash([5, 4]);
      g.beginPath();
      for (let k = 0; k < hull.count; k++) { const x = hull.pts[k * 2] * view.zoom + view.ox, y = hull.pts[k * 2 + 1] * view.zoom + view.oy; if (k) g.lineTo(x, y); else g.moveTo(x, y); }
      g.closePath(); g.stroke(); g.setLineDash([]);
    }
  }
}

// ---- 光柱列表操作
function uniqueBeamId(base) {
  const used = new Set((S.doc.beams || []).map((b) => b.id));
  if (!used.has(base)) return base;
  let n = 2; while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}
/**
 * 加一根光柱。3D 缺省 = 从锚点斜上方打到锚点脚下稍穿进地面的一道窗光（矩形截面、平行光）；
 * 2D 缺省 = 锚点上方往下张开的一条梯形光带。锚点通常离面有高度，终点按离面高往下找地面。
 */
function addBeam(mode) {
  if (!S.doc) return;
  const an = effectiveAnchor();
  const lift = Number.isFinite(an.h) ? an.h : 0;
  edit(mode === '2d' ? '加 2D 光带' : '加 3D 光柱', () => {
    S.doc.beams = S.doc.beams || [];
    const id = uniqueBeamId('beam');
    const beam = mode === '2d'
      ? { id, mode: '2d', shape2d: { from: [-60, -240], to: [0, 0], width: [40, 150] }, color: [1, 0.9, 0.7], intensity: 0.4, edgeSoftness: 0.5 }
      : { id, mode: '3d', shape3d: { from: [-160, 280, 60], to: [30, -(lift + 15), -10], section: { kind: 'rect', width: 110, height: 30 } },
        color: [1, 0.88, 0.65], intensity: 0.45, noise: { strength: 0.3, scaleWu: 90, velocity: [8, 3, 0] } };
    S.doc.beams.push(beam);
    S.sel.key = `beam:${id}`; S.beamId = id;
  });
}
function beamRefs(id) {
  return (S.doc.emitters || []).filter((e) => (e.spawn && e.spawn.shape && e.spawn.shape.kind === 'beam' && e.spawn.shape.beam === id)
    || (e.appearance && e.appearance.beamLit && e.appearance.beamLit.beam === id)).map((e) => e.id);
}
function dupBeam(id) {
  edit('复制光柱', () => {
    const arr = S.doc.beams || [];
    const i = arr.findIndex((b) => b.id === id); if (i < 0) return;
    const copy = clone(arr[i]);
    copy.id = uniqueBeamId(id);
    arr.splice(i + 1, 0, copy);
    S.sel.key = `beam:${copy.id}`; S.beamId = copy.id;
  });
}
function delBeam(id) {
  const users = beamRefs(id);
  if (users.length) { status(`删不了光柱「${id}」：发射器 ${users.join(' / ')} 还用着它（光柱体积出生 / 被光柱照亮，先改掉）`, 'err'); return; }
  edit('删光柱', () => {
    S.doc.beams = (S.doc.beams || []).filter((b) => b.id !== id);
    if (!S.doc.beams.length) delete S.doc.beams;
    if (beamKeyOf(S.sel.key) && beamKeyOf(S.sel.key).id === id) S.sel.key = '';
    if (S.beamId === id) S.beamId = '';
  });
}
function moveBeam(id, dir) {
  edit('重排光柱', () => {
    const arr = S.doc.beams || [];
    const i = arr.findIndex((b) => b.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  });
}
/** 改光柱 id（写入闭包里调）：尘埃的「光柱体积」出生 / 「被光柱照亮」引用跟着改 */
function renameBeam(oldId, newId) {
  const arr = S.doc.beams || [];
  if (arr.some((b) => b.id === newId)) { status(`已经有一根光柱叫「${newId}」`, 'err'); return; }
  const b = arr.find((x) => x.id === oldId); if (!b) return;
  b.id = newId;
  for (const e of (S.doc.emitters || [])) {
    if (e.spawn && e.spawn.shape && e.spawn.shape.kind === 'beam' && e.spawn.shape.beam === oldId) e.spawn.shape.beam = newId;
    if (e.appearance && e.appearance.beamLit && e.appearance.beamLit.beam === oldId) e.appearance.beamLit.beam = newId;
  }
  const k = beamKeyOf(S.sel.key);
  if (k && k.id === oldId) S.sel.key = `${k.which === 'from' ? 'beam' : 'beamEnd'}:${newId}`;
  if (S.beamId === oldId) S.beamId = newId;
}

// ---------------------------------------------------------------------------
// gizmo 主机接口
// ---------------------------------------------------------------------------
/** 选中键里的发射器 id（`emitter:` / `nest:` / `range:` / `startle:`）；别的键 = '' */
function emitterIdOfKey(key) {
  const m = /^(emitter|nest|range|startle):(.+)$/.exec(key || '');
  return m ? m[2] : '';
}
/**
 * 检视器与左栏 ⧉ / 改名 / ↑ / ↓ / × 作用的发射器：选中的是发射器那一类 → 它；否则**作者最近操作的那个**（`S.emitterId`，
 * 还在就用）→ 第一个。原来一律退回第一个：调着第二个发射器的速率、点一下布置行或区域顶点，右栏同一个滚动位置就换成了
 * 第一个发射器，接着打的数全写进了别人，× 删的也是第一个。
 */
function currentEmitter() {
  if (!S.doc) return null;
  const ems = S.doc.emitters || [];
  const byKey = emitterIdOfKey(S.sel.key);
  return (byKey && ems.find((e) => e.id === byKey)) || (S.emitterId && ems.find((e) => e.id === S.emitterId)) || ems[0] || null;
}
function radiusOf(key) {
  const m = /^(nest|range|startle):(.+)$/.exec(key || ''); if (!m) return null;
  const em = (S.doc.emitters || []).find((e) => e.id === m[2]); if (!em || S.rt?.vfxProgram.resolveEmitterProgram(em).solver !== 'flock' || !em.behavior?.home) return null;
  const field = { nest: 'nestRadius', range: 'rangeRadius', startle: 'startleRadius' }[m[1]];
  return { em, home: em.behavior.home, field, label: { nest: '巢半径', range: '活动域半径', startle: '惊起半径' }[m[1]] };
}

/** 区域顶点（画面点）→ 世界地面点：与运行时的判据同一个点（"粒子正下方的地面点"落在画面上的位置） */
function vertexWorld(pt) { return S.cal ? S.cal.sceneToWorldGround(pt[0], pt[1]) : [0, 0, 0]; }
function areaKey(key) {
  const m = /^area:(emit|range|s\d+):(\d+)$/.exec(key || '');
  if (!m) return null;
  if (isSurfRole(m[1]) && !S.surfEdit) return null;
  const p = activePlacement(), poly = areaPoly(p, m[1]), i = +m[2];
  return poly && i < poly.length ? { role: m[1], i, p, poly, pt: poly[i] } : null;
}

function gizmoPivot() {
  const key = S.sel.key; if (!key) return null;
  const a = anchorWorld();
  if (key === 'anchor') {
    const ap = activePlacement();
    return a ? { pivot: a, kind: 'start', n: 1, label: attachOn() ? '角色挂点' : ap ? `布置锚点 · ${ap.id}` : '预览锚点' } : null;
  }
  const ak = areaKey(key);
  // 顶点只在地上挪：`slot` = X / Z 两根轴 + XZ 面 + 贴地中心（2D 原画里同一份配置投到画上）
  if (ak) return S.cal ? { pivot: vertexWorld(ak.pt), kind: 'slot', n: 1, label: `${roleLabel(ak.role)} · 顶点 ${ak.i + 1}${ak.p && !isSurfRole(ak.role) ? ` · ${ak.p.id}` : ''}` } : null;
  if (key === 'player') return S.player.world ? { pivot: S.player.world.slice(), kind: 'slot', n: 1, label: '玩家标记' } : null;
  const bk = beamKeyOf(key);
  if (bk) {
    const b = beamDefOf(bk.id), p = b ? beamPointWorld(b, bk.which) : null;
    return p ? { pivot: p, kind: 'points', n: 1, label: `光柱 · ${b.id} · ${bk.which === 'from' ? '起点' : '终点'}${b.mode === '2d' ? '（2D 光带）' : ''}` } : null;
  }
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
  if (key === 'anchor') return attachOn() ? '挪角色挂点' : activePlacement() ? '移动布置锚点' : '移动锚点';
  const ak = areaKey(key); if (ak) return `挪${roleLabel(ak.role)}顶点`;
  if (key === 'player') return '移动玩家';
  const bk = beamKeyOf(key); if (bk) return `挪光柱${bk.which === 'from' ? '起点' : '终点'}`;
  if (/^probe:/.test(key)) return '移动刺激点';
  const r = radiusOf(key); if (r) return `改${r.label}`;
  return '移动发射器';
}
function gizmoBase(key) {
  const a = anchorWorld();
  if (key === 'anchor') {
    if (!a || !S.space) return null;
    const an = effectiveAnchor();
    if (attachOn()) {
      // 挂点那一档：拖的不是场景锚点，而是**挂点相对角色的两个量**（离脚点高 + 画面横向偏移）
      if (!S.player.on || !S.player.scene) return null;
      let footPos;
      try { footPos = S.space.anchorToWorld({ x: an.x, y: an.y, h: 0 }); } catch (e) { return null; }
      const at0 = attachDef();
      return { kind: 'attach', pos: a.slice(), surfPos: footPos.slice(), h: an.h || 0, playerX: S.player.scene[0],
        offsetX: at0 && Number.isFinite(at0.offsetX) ? at0.offsetX : 0 };
    }
    // 落笔那张面上的那一点（h=0）：XZ 拖的是它，h 是它之上的高度
    let surfPos;
    try { surfPos = S.space.anchorToWorld(Object.assign({}, an, { h: 0 })); } catch (e) { return null; }
    return { kind: 'anchor', pos: a.slice(), anchor: JSON.parse(JSON.stringify(an)), surfPos: surfPos.slice(), h: an.h || 0 };
  }
  const ak = areaKey(key);
  if (ak) return S.cal ? { kind: 'vertex', role: ak.role, i: ak.i, id: ak.p && !isSurfRole(ak.role) ? ak.p.id : '', pos: vertexWorld(ak.pt).slice(), scene: ak.pt.slice() } : null;
  if (key === 'player') return S.player.world ? { kind: 'player', pos: S.player.world.slice() } : null;
  const bk = beamKeyOf(key);
  if (bk) {
    const b = beamDefOf(bk.id), pos = b ? beamPointWorld(b, bk.which) : null;
    if (!pos) return null;
    const sh = (b.mode === '3d' ? b.shape3d : b.shape2d) || {};
    const zero = b.mode === '3d' ? [0, 0, 0] : [0, 0];
    const value = (bk.which === 'from' ? (Array.isArray(sh.from) ? sh.from : zero) : (Array.isArray(sh.to) ? sh.to : zero)).slice();
    return { kind: 'beamPt', id: b.id, which: bk.which, mode: b.mode, pos: pos.slice(), value };
  }
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
  if (base.kind === 'vertex') {
    // 顶点沿地面走：手势起点的地面点 + XZ 位移 → 那一处的地面高 → 投回画面
    const cal = S.cal; if (!cal) return;
    const x = base.pos[0] + v[0], z = base.pos[2] + v[2];
    setAreaVertex(base.role, base.i, cal.worldToScene(x, cal.groundHeight(x, z), z));
    return;
  }
  if (base.kind === 'emitter') {
    const d = (S.doc.emitters || []).find((x) => x.id === base.id); if (!d) return;
    const o = [round2(base.offset[0] + v[0]), round2(base.offset[1] + v[1]), round2(base.offset[2] + v[2])];
    if (o[0] === 0 && o[1] === 0 && o[2] === 0) delete d.offset; else d.offset = o;
    return;
  }
  if (base.kind === 'player') { setPlayerAt([base.pos[0] + v[0], base.pos[1] + v[1], base.pos[2] + v[2]], true); return; }
  if (base.kind === 'beamPt') { applyBeamMove(base, v); return; }
  if (base.kind === 'probe') {
    const p = S.probes[base.idx]; if (!p) return;
    p.at = [round2(base.pos[0] + v[0]), round2(base.pos[1] + v[1]), round2(base.pos[2] + v[2])];
    return;
  }
  if (base.kind === 'attach') { setAttachFromDrag(v, base); return; }
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
/**
 * 挂点位移（gizmo 给的是相对手势起点的累计量 v）→ `attach` 的两个量：
 *   Y 改离脚点高度 `heightWu`（不许负）；XZ 折回**画面横向**偏移 `offsetX`
 *   （挂点的纵深一律跟角色脚点，与运行时一致：`contact.y` 就是脚点那一行）。
 */
function setAttachFromDrag(v, base) {
  const cal = S.cal; if (!cal || !base) return;
  const at = ensureAttach();
  at.heightWu = Math.max(0, round2((base.h || 0) + v[1]));
  const sp = [base.surfPos[0] + v[0], 0, base.surfPos[2] + v[2]];
  sp[1] = cal.groundHeight(sp[0], sp[2]);
  const s = cal.worldToScene(sp[0], sp[1], sp[2]);
  if (!Number.isFinite(s[0])) return;
  setAttachOffsetX(at, s[0] - base.playerX);
}
/** 世界点 → 挂点两个量（A 工具点一下 / 直接把挂点拖到某处）：横向按**脚点的画面 x** 折 */
function setAttachTo(world) {
  const cal = S.cal, at = attachDef();
  if (!cal || !at || !S.player.scene) return;
  const gy = cal.groundHeight(world[0], world[2]);
  const s = cal.worldToScene(world[0], gy, world[2]);
  if (!Number.isFinite(s[0])) return;
  setAttachOffsetX(at, s[0] - S.player.scene[0]);
  at.heightWu = Math.max(0, round2(world[1] - gy));
}
function setAttachOffsetX(at, dx) {
  const v = round2(dx);
  if (v === 0) delete at.offsetX; else at.offsetX = v;
}
function ensureAuthoring() { if (!S.doc.authoring) S.doc.authoring = {}; return S.doc.authoring; }
function ensureAttach() {
  const au = ensureAuthoring();
  if (!au.attach || typeof au.attach !== 'object') au.attach = { heightWu: ATTACH_DEFAULT_HEIGHT_WU };
  if (!Number.isFinite(au.attach.heightWu)) au.attach.heightWu = ATTACH_DEFAULT_HEIGHT_WU;
  return au.attach;
}
/**
 * 切锚点模式。开 = 写 `authoring.attach`（场上没角色就顺手在当前锚点放一个）；
 * 关 = 删掉那个键，**资产字节回到原样**（这一整块与 `anchor` 同待遇：运行时忽略）。
 */
function setAttachMode(on) {
  if (!S.doc) return;
  if (!!attachDef() === !!on) return;
  edit(on ? '锚点改挂在角色挂点' : '锚点改回场景面', () => {
    if (on) { ensureAttach(); return; }
    const au = S.doc.authoring; if (!au) return;
    delete au.attach;
    if (!Object.keys(au).length) delete S.doc.authoring;
  });
  if (!on) { setWalk(false); return; }
  if (!S.player.on && !placePlayerAtAnchor()) {
    status('锚点模式=角色挂点：场上还没有角色，按 M 点一下地面放一个', 'warn');
  }
  rebuildSim(); renderAll();
}
/** 把角色放到当前（场景面）锚点的脚下——开挂点模式时省作者一步 */
function placePlayerAtAnchor() {
  if (!S.cal) return false;
  const a = effectiveAnchor();
  if (!setPlayerSceneAt(a.x, a.y, 0)) return false;
  status(`放了一个角色在锚点脚下（高 ${CHAR_HEIGHT_WU} wu 是尺度参考）`, 'ok');
  return true;
}
/** 锚点写到哪：有活动布置 = **实例的 anchor**（运行时读的就是它）；没有 = 效果的 `authoring.anchor`（只给工作台重开现场） */
function ensureAnchor() {
  const p = activePlacement();
  if (p) {
    if (!p.anchor || typeof p.anchor !== 'object') p.anchor = { x: 0, y: 0 };
    return p.anchor;
  }
  const au = ensureAuthoring();
  if (!au.anchor || !authoringAnchorHere(au)) {
    // 在作者场景之外放 / 拖预览锚点：从此刻的场景锚点（出生点）起一个新的，并把作者场景记成这里（=「记为作者场景」）——
    // 只改 x / y 的话 sceneId 还指着别的场景，`sceneAnchor` 照样不认它，拖了等于没拖
    au.anchor = JSON.parse(JSON.stringify(sceneAnchor()));
    if (S.scene && au.sceneId !== S.scene.id) { au.sceneId = S.scene.id; au.background = S.scene.background; }
  }
  return au.anchor;
}
/**
 * 「记为作者场景」：作者场景记成这里。预览锚点是**别的场景**的画面点时先从此刻的场景锚点（本份没布置它 = 出生点）起一个新的——
 * 原来只改 sceneId / background，旧场景的画面坐标一下子被当成这里的（常在地图外），预览跳过去，
 * 接着点「把当前效果布置到这里」，新布置就钉在那个点上。只在写入闭包里调。
 */
function bindAuthoringScene() {
  if (!S.doc || !S.scene) return;
  const au = ensureAuthoring();
  if (au.anchor && !authoringAnchorHere(au)) au.anchor = clone(sceneAnchor());
  au.sceneId = S.scene.id; au.background = S.scene.background;
}
/** 区域顶点写回（画面点，0.1 wu 精度——与主编辑器画布同口径） */
function setAreaVertex(role, i, s) {
  if (!Number.isFinite(s[0]) || !Number.isFinite(s[1])) return;
  const poly = areaPoly(activePlacement(), role);
  if (!poly || !poly[i]) return;
  poly[i] = [round1(s[0]), round1(s[1])];
}
function reanchor() { rebuildSim(); draw(); }

/** 线框球（巢 / 活动域 / 惊起）的半径直接写（拖线框本身用；缩放 gizmo 走 `applyGizmo`） */
function setRadiusValue(key, r) {
  const rr = radiusOf(key); if (!rr || !Number.isFinite(r)) return;
  rr.home[rr.field] = Math.max(1, round2(r));
}
/**
 * 3D 里**按住 Alt** 拖物体（不经 gizmo）：落到光标下的表面 / 地面上——显式的"扔到那张面上"。
 * 平常的直接拖走 `applyGizmo`（相对位移，与 gizmo 中心同语义），见 view3d `_move`。
 * ⚠ 只在拖拽写入闭包（`dragTick`）里调：锚点那一档不许经 `setAnchorAt`（它套 `edit()` 每拍重建模拟、还切工具）。
 */
function dragObjectTo(key, base, surf) {
  if (!base || !surf) return;
  if (base.kind === 'vertex') { if (S.cal) setAreaVertex(base.role, base.i, S.cal.worldToScene(surf.p[0], surf.p[1], surf.p[2])); return; }
  if (base.kind === 'emitter') {
    const a = anchorWorld(); if (!a) return;
    const d = (S.doc.emitters || []).find((x) => x.id === base.id); if (!d) return;
    d.offset = [round2(surf.p[0] - a[0]), round2(surf.p[1] - a[1]), round2(surf.p[2] - a[2])];
    return;
  }
  if (base.kind === 'attach') { setAttachTo(surf.p); return; }
  if (base.kind === 'anchor') { writeAnchorFromSurface(surf); return; }
  if (base.kind === 'beamPt') { setBeamPointToWorld(base, surf.p); return; }
  if (base.kind === 'player') { setPlayerAt(surf.p, true); return; }
  if (base.kind === 'probe') { const p = S.probes[base.idx]; if (p) p.at = surf.p.map(round2); return; }
  if (base.kind === 'radius') setRadiusValue(key, Math.hypot(surf.p[0] - base.pos[0], surf.p[2] - base.pos[2]));
}
/**
 * 2D 原画里**按住 Alt** 直接拖物体：光标下的画面点就是新位置（显式"扔到这里"）。平常的直接拖走
 * `dragObjectByScene`（相对位移）。锚点只改画面点、`h` / `surface` 原样留着。
 */
function dragObjectToScene(key, base, scenePt) {
  const cal = S.cal; if (!cal || !base) return;
  if (base.kind === 'vertex') { setAreaVertex(base.role, base.i, scenePt); return; }
  if (base.kind === 'attach') {
    const at = attachDef();
    if (at && S.player.scene) setAttachOffsetX(at, scenePt[0] - S.player.scene[0]);
    return;
  }
  if (base.kind === 'anchor') {
    const a = ensureAnchor();
    a.x = round2(scenePt[0]); a.y = round2(scenePt[1]);
    return;
  }
  if (base.kind === 'radius') return;                  // 半径没有"扔到哪"的意思（相对拖见 dragObjectByScene）
  if (base.kind === 'beamPt') { setBeamPointToScene(base, scenePt); return; }
  dragObjectTo(key, base, { p: cal.sceneToWorldGround(scenePt[0], scenePt[1]), onShell: false });
}
/**
 * 2D 原画里直接拖物体（不按 Alt）：**相对位移**，与 gizmo 中心同语义——原来把光标的画面点当成绝对位置写进锚点，
 * 而标记画在离面 h 高处，一按下锚点就往下跳 h 的投影；发射器经地面换算，y 偏移被拍回地面。
 *   ds = 光标画面点 − 按下时的画面点；gv = 两处地面点的世界差（y = 0）。
 *   锚点：画面点 + ds（h / surface 不动）；挂点：横向偏移 + ds.x；顶点：原画面点 + ds；
 *   发射器 / 玩家 / 刺激点：`applyGizmo` 走世界 XZ 位移（离地高照旧）；半径：按投影圆半径的比例缩放。
 */
function dragObjectByScene(key, base, ds, gv, ratio) {
  if (!base || !S.cal) return;
  if (base.kind === 'anchor') {
    const a = ensureAnchor();
    a.x = round2(base.anchor.x + ds[0]); a.y = round2(base.anchor.y + ds[1]);
    return;
  }
  if (base.kind === 'attach') { const at = attachDef(); if (at) setAttachOffsetX(at, base.offsetX + ds[0]); return; }
  if (base.kind === 'vertex') { setAreaVertex(base.role, base.i, [base.scene[0] + ds[0], base.scene[1] + ds[1]]); return; }
  if (base.kind === 'radius') { if (Number.isFinite(ratio) && ratio > 0) setRadiusValue(key, base.radius * ratio); return; }
  // 2D 光带的把手就是画面点：画面上挪多少就挪多少（3D 光柱照发射器那样走地面位移）
  if (base.kind === 'beamPt' && base.mode === '2d') { writeBeamPoint(base.id, base.which, [base.value[0] + ds[0], base.value[1] + ds[1]]); return; }
  if (gv) applyGizmo(key, base, { kind: 'move', v: { x: gv[0], y: 0, z: gv[2] } });
}

/**
 * 键盘微移。玩家标记与刺激点不在 doc / 布置库里：**不经 `edit()`**——原来每按一下方向键都重建模拟（回 t=0、群体回巢），
 * 想看"人走近蝙蝠就惊飞"，边按边走一只都飞不起来；还白白把 rev 加一（在飞的保存误报"保存期间又有改动"）。
 */
function nudgeSelected(dx, dy, dz) {
  const key = S.sel.key;
  if (nudge && !history.inDrag()) nudgeReset();          // 手势已经被别处收掉 / 撤回（撤销会作废在飞的拖拽）：这份簿记作废，重新起
  if (nudge && nudge.key !== key) nudgeEnd();
  const base = nudge ? nudge.base : gizmoBase(key); if (!base) return false;
  if (base.kind === 'player' || base.kind === 'probe') {
    applyGizmo(key, base, { kind: 'move', v: { x: dx, y: dy, z: dz } });
    draw(); renderLeft(); renderSimBar();
    return true;
  }
  // 锚点 / 发射器 / 区域顶点：连按（含按住的自动重复）合成**一次手势**——与鼠标拖同一条 dragBegin / dragTick / dragEnd：
  // 原来每下 keydown 一次 edit()，按住 Shift+→ 一秒 = 30 条历史、30 次重建模拟（预览回 t=0，边挪边看群体根本看不了）、
  // 30 发推送，撤回要按 30 下 Ctrl+Z，还把 200 条上限里更早的真改动（删掉的布置、拉好的区域）挤掉。
  // 位移按手势起点累计（`applyGizmo` 本来就收累计量）；松开最后一个方向键 / 按别的键 / 按鼠标 / 停手 400 ms 收尾
  if (!nudge) {
    if (!S.doc || history.inDrag()) return false;      // 鼠标手势还按着：方向键不另起一条（两条手势抢同一个 beginDrag）
    nudge = { key, base, acc: [0, 0, 0], timer: 0 };
    nudgeKeys.clear();
    dragBegin('微移');
  }
  nudge.acc[0] += dx; nudge.acc[1] += dy; nudge.acc[2] += dz;
  const acc = nudge.acc.slice();
  dragTick(() => applyGizmo(key, base, { kind: 'move', v: { x: acc[0], y: acc[1], z: acc[2] } }));
  if (nudge.timer) clearTimeout(nudge.timer);
  nudge.timer = setTimeout(nudgeEnd, NUDGE_IDLE_MS);
  return true;
}
/** 键盘微移手势收尾（一条历史 + 一次重建 + 一发推送）；没在微移 = 什么都不做 */
function nudgeEnd() {
  const n = nudge; if (!n) return;
  nudge = null; nudgeKeys.clear();
  if (n.timer) clearTimeout(n.timer);
  dragEnd();
}
/** 手势被整个撤回 / 作废（换场景 / 换效果）：只丢掉微移的簿记，历史那一半由调用方处理 */
function nudgeReset() {
  if (nudge && nudge.timer) clearTimeout(nudge.timer);
  nudge = null; nudgeKeys.clear();
}

// ---------------------------------------------------------------------------
// 作者操作
// ---------------------------------------------------------------------------
/**
 * 表面拾取点 → 锚点（有活动布置写布置的 anchor，否则 authoring.anchor；挂点模式折成挂点两个量）。
 * **不套 `edit()`、不动选中与工具**：A 工具那一下由 `setAnchorAt` 包进一条历史；Alt 拖拽在 `dragTick` 里直接调它
 *（原来拖拽也经 setAnchorAt，每拍 edit → 重建模拟回 t=0 + 重建左栏与检视器，`patchSim` 白写了）。
 */
function writeAnchorFromSurface(surf) {
  const cal = S.cal; if (!cal || !S.doc || !surf) return;
  if (attachOn()) { setAttachTo(surf.p); return; }
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
}
/** A 工具（非挂点模式）这一下写到哪就叫什么：有活动布置写的是那条布置的 anchor（游戏用的、推给游戏、Ctrl+S 存进布置库），
 *  没有才是 authoring.anchor（仅工作台预览）。原来一律叫「放预览锚点」，挪了游戏里的布置作者还以为只动了预览 */
function anchorToolEditLabel() {
  const ap = activePlacement();
  return ap ? `挪布置锚点 · ${ap.id}` : '放预览锚点';
}
/** 工具栏 A 按钮的提示跟着「此刻有没有活动布置」走（renderLeft / setTool 时刷新） */
function renderAnchorToolTitle() {
  const b = document.querySelector('#tools button[data-tool="anchor"]'); if (!b) return;
  const ap = S.doc ? activePlacement() : null;
  const head = ap
    ? `放锚点（A）：有活动布置——改的是这条布置「${ap.id}」的 anchor（游戏用的，推给游戏、Ctrl+S 存进布置库）`
    : '放锚点（A）：没有活动布置——写 authoring.anchor（仅工作台预览，运行时不读）';
  b.title = `${head}；点场景表面，切 ground/shell 落到对应面。锚点模式=角色挂点时，点的是「火头摆在哪」（写 authoring.attach）`;
}
function setAnchorAt(surf) {
  const cal = S.cal; if (!cal || !S.doc) return;
  if (attachOn()) {
    // 挂点模式下 A 工具点的是"火头应该在哪"：折成挂点的高度 + 画面横向偏移（不写场景锚点）
    if (!S.player.scene) { status('锚点模式=角色挂点：先按 M 放一个角色', 'warn'); return; }
    edit('挪角色挂点', () => writeAnchorFromSurface(surf));
    S.sel.key = 'anchor';
    setTool('select');
    return;
  }
  edit(anchorToolEditLabel(), () => writeAnchorFromSurface(surf));
  S.sel.key = 'anchor';
  setTool('select');
}
function setAnchorScene(sx, sy) {
  const cal = S.cal; if (!cal || !S.doc) return;
  if (attachOn()) {
    if (!S.player.scene) { status('锚点模式=角色挂点：先按 M 放一个角色', 'warn'); return; }
    edit('挪角色挂点', () => setAttachOffsetX(ensureAttach(), sx - S.player.scene[0]));
    S.sel.key = 'anchor';
    setTool('select');
    return;
  }
  const a0 = effectiveAnchor();
  edit(anchorToolEditLabel(), () => {
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
  // 速度 = **真在动**的速度：M 工具点一下是"把人放到那里"，不是跑过去——原来按跳的距离 ×12 猜（一跳就 600 wu/s），
  // 暂停时衰减又不跑，按播放第一拍就是满格 player:motion 场，站着不动的人把群体惊飞（作者会以为怕人权重调高了、去改对的资产）。
  // 拖着走（gizmo / 直接拖 / 方向键）= 位移 ÷ 距上一次挪动的真实时间；停手 100 ms 以上由 stepSim 归零
  const now = performance.now();
  if (!keepTool) S.player.speed = 0;
  else if (S.player.world) {
    const d = Math.hypot(w[0] - S.player.world[0], w[2] - S.player.world[2]);
    const dt = Math.max(1 / 120, (now - (S.player.movedAt || 0)) / 1000);
    S.player.speed = Math.min(600, d / dt);
  }
  S.player.movedAt = now;
  S.player.on = true; S.player.world = w;
  S.player.scene = cal.worldToScene(w[0], w[1], w[2]);
  S.walk.baseX = S.player.scene[0]; S.walk.sceneY = S.player.scene[1];   // 手动挪过 = 从这里重新来回走
  if (!keepTool) { S.sel.key = 'player'; setTool('select'); }
  draw(); renderLeft();
}
/**
 * 画面点放 / 挪角色（挂点预览与来回走都走它）：速度是**给定的真速度**，不像拖拽那样按位移猜。
 * 存的 `scene` 就是要求的那一点（挂点锚点直接读它，不再往返一次）。
 */
function setPlayerSceneAt(sx, sy, speed) {
  const cal = S.cal; if (!cal) return false;
  const w = cal.sceneToWorldGround(sx, sy);
  if (!w || !w.every(Number.isFinite)) return false;
  S.player.on = true;
  S.player.world = [w[0], w[1], w[2]];
  S.player.scene = [sx, sy];
  S.player.speed = Math.max(0, speed || 0);
  return true;
}
function clearPlayer() { S.walk.on = false; S.player.on = false; S.player.world = null; S.player.speed = 0; if (S.sel.key === 'player') S.sel.key = ''; updatePlayerField(); draw(); renderLeft(); renderInspector(); }

/** 让角色来回走（这一档就是为了看"锚点在动、已发射的粒子留在原地"） */
function setWalk(on) {
  const want = !!on;
  if (want && !S.player.on && !placePlayerAtAnchor()) {
    status('要让角色走动，先按 M 点一下地面放一个角色', 'warn');
    return;
  }
  S.walk.on = want;
  if (want) { S.walk.baseX = S.player.scene[0]; S.walk.sceneY = S.player.scene[1]; S.walk.dir = 1; }
  else if (S.player.on) S.player.speed = 0;
  renderLeft(); renderInspector(); renderSimBar(); draw();
}
/**
 * 走一拍。横向 1 wu 恒等于 1 画面 wu（伪世界是正交重建的），所以画面 x 上走
 * `WALK_SPEED_WU · dt` 就是真走速；到半幅或场景边缘就折返。
 * 速度显式喂给 `S.player.speed`（动静场按它算强度：站着不动强度恒 0）。
 */
function walkTick(dt) {
  if (!S.walk.on) return;
  const cal = S.cal;
  if (!cal || !S.player.on || !S.player.scene) { S.walk.on = false; return; }
  if (!Number.isFinite(S.walk.baseX)) { S.walk.baseX = S.player.scene[0]; S.walk.sceneY = S.player.scene[1]; }
  const lo = Math.max(2, S.walk.baseX - WALK_SPAN_WU), hi = Math.min(cal.worldW - 2, S.walk.baseX + WALK_SPAN_WU);
  let x = S.player.scene[0] + S.walk.dir * WALK_SPEED_WU * dt;
  if (x >= hi) { x = hi; S.walk.dir = -1; } else if (x <= lo) { x = lo; S.walk.dir = 1; }
  setPlayerSceneAt(x, S.walk.sceneY, WALK_SPEED_WU);
}

/**
 * 角色代理的身体线（**只是尺度参考，不可选中、不进 doc**）：脚点到头顶 150 wu 的立柱 + 肩线，
 * 挂点模式下再从身体中线拉一根横杆到挂点——"火头到底在手的高度上吗"靠它一眼看出来。
 */
function bodyLines() {
  const out = [];
  const cal = S.cal;
  if (!cal || !S.player.on || !S.player.world) return out;
  const w = S.player.world;
  const r = cal.screenRightWorld();
  const half = 26, sh = w[1] + CHAR_HEIGHT_WU * 0.8;
  out.push({
    pts: [w[0], w[1], w[2], w[0], w[1] + CHAR_HEIGHT_WU, w[2],
      w[0] - r[0] * half, sh - r[1] * half, w[2] - r[2] * half, w[0] + r[0] * half, sh + r[1] * half, w[2] + r[2] * half],
    color: [0.4, 0.8, 1, 0.5],
  });
  const aw = attachAnchor() ? anchorWorld() : null;
  if (aw) out.push({ pts: [w[0], aw[1], w[2], aw[0], aw[1], aw[2]], color: [1, 0.75, 0.35, 0.8] });
  return out;
}

/** 发一个刺激：本地立刻进场总线（预览看得见），同时推给游戏 */
function addFieldAt(world) {
  const kind = el('fieldKind').value || 'fear';
  const tag = (el('fieldTag').value || '').trim() || (kind === 'wind' ? 'wind' : 'item:bug');
  const radius = num(el('fieldRadius').value, 260);
  const strength = num(el('fieldStrength').value, 1);
  const duration = num(el('fieldDuration').value, 0);
  const def = { kind, tag, radius, strength };
  if (duration > 0) def.duration = duration;
  if (kind === 'wind' || kind === 'airflow') {
    def.direction = ['X', 'Y', 'Z'].map(axis => num(el('fieldDir' + axis).value, 0));
    if (!Math.hypot(...def.direction)) { status('刺激方向不能全为 0', 'warn'); return; }
  }
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
/** 删刺激点：选中的是**后面**的那个时下标跟着减一（与区域顶点同一条）——原来选中键原样不动，
 *  删掉前面一个后 gizmo / 高亮跳到了下一个刺激点上，接着按 Delete 删的是另一个；选中最后一个时选中直接消失 */
function removeProbe(i) {
  S.probes.splice(i, 1);
  const m = /^probe:(\d+)$/.exec(S.sel.key || '');
  if (m) {
    const j = +m[1];
    if (j === i) S.sel.key = '';
    else if (j > i) S.sel.key = `probe:${j - 1}`;
  }
  draw(); renderLeft();
}

// ---------------------------------------------------------------------------
// 布置：增删排序改 id / 复制到别的时段外观 / 区域
// ---------------------------------------------------------------------------
/** 一次布置库编辑（与 `edit` 同一条历史 / 脏态 / 重建 / 联动；闭包末尾剥掉空的份） */
function editLib(label, fn) {
  if (!libEditable()) return false;
  return edit(label, () => { fn(); pruneLib(); });
}
/** 按 id 改本份里的一条布置（写入时现找：检视器的闭包可能比库晚一拍，不许拿着旧对象写） */
function editPlacement(id, label, fn) {
  return editLib(label, () => {
    const r = curRows().find((x) => x.id === id);
    if (r) { fn(r); orderKeys(r, INSTANCE_ORDER); if (r.anchor) orderKeys(r.anchor, ['x', 'y', 'h', 'surface']); if (r.confine) orderKeys(r.confine, CONFINE_ORDER); }
  });
}
function uniquePlaceId(base, used) {
  const u = new Set(used);
  if (!u.has(base)) return base;
  let n = 2; while (u.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}
/** 「把当前效果布置到这里」：本份新加一条，id 唯一，锚点 = 此刻的预览锚点（场景面那一档，不取角色挂点） */
function placeHere() {
  if (!S.doc) { status('还没打开效果', 'warn'); return false; }
  if (!libEditable()) return false;
  const rows = curRows();
  const id = uniquePlaceId(`vfx_${S.doc.id}`, rows.map((r) => r.id));
  const an = sceneAnchor();
  const anchor = { x: round2(an.x), y: round2(an.y) };
  if (Number.isFinite(an.h)) anchor.h = round2(an.h);
  if (an.surface === 'shell') anchor.surface = 'shell';
  const sid = S.scene.id, ph = S.phase, prevId = S.placeId;
  S.placeId = id;
  const changed = editLib(`把「${S.doc.id}」布置到 ${sid} · ${phaseLabel(sid, ph)}`, () => {
    rowsArr(sid, ph).push({ id, effect: S.doc.id, anchor });
  });
  if (!changed) { S.placeId = prevId; return false; }
  select('anchor');
  status(`布置了「${id}」到 ${sid} · ${phaseLabel(sid, ph)}（锚点 = 当前预览锚点）`, 'ok');
  return true;
}
/** 实例 id 在全库（所有场景 × 所有时段外观）里摆了几条 */
function instanceIdCount(id, lib) {
  const sc = (lib || S.lib || {}).scenes;
  let n = 0;
  if (!sc || typeof sc !== 'object') return n;
  for (const sid of Object.keys(sc)) {
    const ent = sc[sid] || {};
    const phases = (Array.isArray(ent.base) ? [''] : []).concat(ent.variants && typeof ent.variants === 'object' ? Object.keys(ent.variants) : []);
    for (const ph of phases) for (const r of libRows(sid, ph, lib)) if (r.id === id) n++;
  }
  return n;
}
/**
 * 布置库之外按**实例 id** 引用它的地方（playVfx / stopVfx / setVfxState 的 instanceId、条件叶 vfx；服务端只读扫出来的）。
 * 接口没有 / 出错 = 当作"不知道有引用"（不拦着删，只是不问）。
 */
async function instanceRefs(id) {
  try {
    const r = await fetch(`/api/instance_refs?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!r.ok) return [];
    const j = await r.json();
    return j && !j.error && Array.isArray(j.refs) ? j.refs.filter((x) => x && typeof x === 'object') : [];
  } catch (e) { return []; }
}
const INSTANCE_REF_KIND = { playVfx: 'playVfx', stopVfx: 'stopVfx', setVfxState: 'setVfxState', condition: '条件' };
function instanceRefLines(refs, max) {
  const lim = max || 8;
  const lines = refs.slice(0, lim).map((r) => `${r.file || '?'} · ${r.path || '?'}（${INSTANCE_REF_KIND[r.kind] || r.kind || '?'}）`);
  if (refs.length > lim) lines.push(`… 等共 ${refs.length} 处`);
  return lines;
}
let placeDelPending = false;
/**
 * 删活动布置（Delete 键 / 「删」按钮），可撤销。删完这个实例 id 在全库里一条都不剩、而布置库之外还有 playVfx / stopVfx /
 * setVfxState / 条件按这个 id 引用它 → 先列出（文件 · 位置）要作者明确确认——工作台不改那些文件（归主编辑器），删了它们静默指空：
 * 运行时 playVfx 只 warn 一句整步跳过，条件叶恒为假，画面上都是"什么都没发生"。
 * 返回 `true` = 删了。
 */
async function delPlacement() {
  const p = activePlacement(); if (!p || placeDelPending) return false;
  if (!libEditable()) return false;
  const id = p.id, sid = S.scene.id, ph = S.phase, effId = S.doc.id;
  if (instanceIdCount(id) <= 1) {
    placeDelPending = true;
    let refs = [];
    try { refs = await instanceRefs(id); } finally { placeDelPending = false; }
    if (refs.length) {
      const c = await choiceDialog(`删布置「${id}」`,
        `删了之后全库再没有叫「${id}」的布置，但布置库之外还有 ${refs.length} 处按这个 id 用它（工作台不改这些文件，删了它们会指空——去主编辑器改）：\n`
        + instanceRefLines(refs).join('\n'), [['cancel', '取消'], ['delete', '仍然删除（这些引用会指空）']]);
      if (c !== 'delete') { status(`没删布置「${id}」`, ''); return false; }
    }
    // 等接口 / 对话框期间现场可能变了（换了场景 / 效果、那一条已经没了）：不删别人
    if (S.busy || !S.scene || S.scene.id !== sid || S.phase !== ph || !S.doc || S.doc.id !== effId
      || !curRows().some((r) => r.id === id && r.effect === effId)) {
      status(`没删布置「${id}」：确认期间换了场景 / 效果，或那一条已经不在了`, 'warn');
      return false;
    }
  }
  const changed = editLib(`删布置「${id}」`, () => {
    const arr = rowsArr(sid, ph);
    const i = arr.findIndex((r) => r && r.id === id);
    if (i >= 0) arr.splice(i, 1);
  });
  S.placeId = '';
  if (S.sel.key === 'anchor' || /^area:/.test(S.sel.key)) S.sel.key = '';
  rebuildSim(); renderAll();
  return changed;
}
function movePlacement(dir) {
  const p = activePlacement(); if (!p) return;
  const id = p.id;
  // 挪的这一行保持活动：没点过行时活动布置是"第一条"，A、B 一换位，高亮 / 检视器 / 预览全跳到 B，再按一下 ↓ 挪回去的是 B
  S.placeId = id;
  editLib('重排布置', () => {
    const arr = rowsArr(S.scene.id, S.phase);
    const i = arr.findIndex((r) => r && r.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  });
}
/** 改布置 id（本份内唯一）。playVfx / 条件叶 vfx 按 id 找实例——状态栏提醒那边要跟着改 */
function renamePlacement(oldId, newId) {
  const v = String(newId || '').trim();
  if (!v || v === oldId) return false;
  if (curRows().some((r) => r.id === v)) { status(`这一份里已经有一条叫「${v}」`, 'err'); return false; }
  // 选中键与 stash 键**先**跟过去再改：edit() 里马上 rebuildSim，那时 S.placeId 还是旧 id 的话 activePlacement() 找不到、
  // 退回这个效果的第一条——同一效果摆了两条（两个池塘的萤火虫）时，改第二条的名，预览跑到第一条的锚点 / 区域 / 种子上，
  // 检视器和 gizmo 却还在第二条，直到下一次编辑
  const ap = activePlacement();
  const prevPlace = S.placeId;
  const k0 = stashKey(oldId), k1 = stashKey(v), st = S.confineStash[k0];
  if (ap && ap.id === oldId) S.placeId = v;
  if (st) { S.confineStash[k1] = st; delete S.confineStash[k0]; }
  const changed = editPlacement(oldId, '改布置 id', (r) => { r.id = v; });
  if (!changed) {
    S.placeId = prevPlace;
    if (st) { S.confineStash[k0] = st; delete S.confineStash[k1]; }
    return false;
  }
  renderAll();
  const msg = `布置 id「${oldId}」→「${v}」：playVfx 与条件（vfx / vfxState）按 id 引用实例，引用了旧 id 的要跟着改`;
  status(msg, 'warn');
  // 旧 id 在全库里一条都不剩了：去问布置库之外谁还按旧 id 用它，有就把具体文件补进这条提醒（状态栏已经换成别的话就不覆盖）
  if (!instanceIdCount(oldId)) {
    void instanceRefs(oldId).then((refs) => {
      if (!refs.length || el('status').textContent !== msg) return;
      const files = [...new Set(refs.map((r) => r.file || '?'))];
      status(`${msg}——还有 ${refs.length} 处引用旧 id「${oldId}」（去主编辑器改）：${instanceRefLines(refs, 4).join('；')}${files.length > 1 ? `（涉及 ${files.join(' / ')}）` : ''}`, 'warn');
    });
  }
  return true;
}
/**
 * 复制到本场景另一套时段外观：选中那条（`scope='one'`）或这一份整份（`'all'`）。
 * 目标里有同 id 的：`onConflict` = 'overwrite'（原位替换）/ 'skip'（不动目标那条）。返回 `{copied, skipped}`。
 */
function copyPlacementsTo(targetPhase, scope, onConflict) {
  if (!S.scene) return null;
  const src = scope === 'all' ? curRows() : [activePlacement()].filter(Boolean);
  if (!src.length || targetPhase === S.phase) return null;
  const res = { copied: 0, skipped: 0 };
  editLib(`复制布置到 ${phaseLabel(S.scene.id, targetPhase)}`, () => {
    const arr = rowsArr(S.scene.id, targetPhase);
    for (const r of src) {
      const i = arr.findIndex((x) => x && x.id === r.id);
      if (i >= 0 && onConflict !== 'overwrite') { res.skipped++; continue; }
      if (i >= 0) arr[i] = clone(r); else arr.push(clone(r));
      res.copied++;
    }
  });
  return res;
}
async function copyPlacementsDialog() {
  if (!S.scene || !libEditable()) return;
  const others = phasesOf(S.scene.id).filter((p) => p.key !== S.phase);
  if (!others.length) { status('这个场景只有一套外观（没开日夜 / 没有 timeVariants），没地方可复制', 'warn'); return; }
  const ap = activePlacement();
  if (!ap && !curRows().length) { status('这一份里没有布置可复制', 'warn'); return; }
  let tgt = null, scope = null;
  const picked = await dialog((form, done) => {
    tgt = h('select', { 'data-role': 'copyTarget' });
    for (const p of others) tgt.appendChild(h('option', { value: p.key }, p.label));
    scope = h('select', { 'data-role': 'copyScope' });
    if (ap) scope.appendChild(h('option', { value: 'one' }, `选中的「${ap.id}」`));
    scope.appendChild(h('option', { value: 'all' }, `这一份整份（${curRows().length} 条）`));
    form.append(h('h3', {}, `复制布置 · ${S.scene.id} · ${phaseLabel(S.scene.id, S.phase)}`),
      h('div', { class: 'row' }, h('span', {}, '复制到'), tgt),
      h('div', { class: 'row' }, h('span', {}, '复制什么'), scope),
      h('p', {}, '各份互不继承：复制过去就是那一份自己的，之后两边分开改'),
      h('div', { class: 'btns' }, h('button', { type: 'button', onclick: () => done(null) }, '取消'),
        h('button', { class: 'primary', type: 'button', 'data-choice': 'copy', onclick: () => done({ phase: tgt.value, scope: scope.value }) }, '复制')));
  });
  const pick = picked === true ? { phase: tgt.value, scope: scope.value } : picked;
  if (!pick) return;
  const src = pick.scope === 'all' ? curRows() : [ap];
  const tgtIds = new Set(libRows(S.scene.id, pick.phase).map((r) => r.id));
  const clash = src.filter((r) => tgtIds.has(r.id)).map((r) => r.id);
  let mode = 'overwrite';
  if (clash.length) {
    mode = await choiceDialog(`「${phaseLabel(S.scene.id, pick.phase)}」里已经有同 id 的布置`,
      `同 id：${clash.join(' / ')}`, [['cancel', '取消'], ['skip', '跳过这些'], ['overwrite', '覆盖']]);
    if (!mode || mode === 'cancel') return;
  }
  const r = copyPlacementsTo(pick.phase, pick.scope, mode);
  if (r) status(`复制了 ${r.copied} 条到「${phaseLabel(S.scene.id, pick.phase)}」${r.skipped ? `（跳过 ${r.skipped} 条同 id 的）` : ''}`, 'ok');
}
let placeCopyPending = false;
/**
 * 把**一条**布置在本场景两套时段外观之间拷（左栏「选中的布置 · 别的时段外观」的「拷过去 / 拷过来」）。
 * 只动这一个 id：目标里有同 id 的就原位覆盖（先确认，可撤销），没有就加到末尾；同效果的其它条、别的效果一律不动
 * （制作人 2026-09-16：拷贝只拷左栏选中的那一条——第一版整份替换被打回）。拷完两份照旧各改各的、互不继承。
 * 目标里同 id 是**别的效果**的布置 → 不拷，状态栏说先改 id。拷进正在看的这一份 → 选中它。
 * 返回 `true` = 拷了。
 */
async function copyPlacementAcrossPhases(id, fromPhase, toPhase) {
  if (placeCopyPending || !S.scene || !libEditable()) return false;
  const sid = S.scene.id, from = fromPhase || '', to = toPhase || '';
  if (from === to || !id) return false;
  const fromLabel = phaseLabel(sid, from), toLabel = phaseLabel(sid, to);
  const src = libRows(sid, from).find((r) => r.id === id);
  if (!src) { status(`「${fromLabel}」里没有「${id}」`, 'warn'); return false; }
  const dst = libRows(sid, to).find((r) => r.id === id);
  if (dst && dst.effect !== src.effect) { status(`「${toLabel}」里的「${id}」布置的是别的效果「${dst.effect}」：先把其中一条改 id 再拷`, 'err'); return false; }
  if (dst && canonJson(dst) === canonJson(src)) { status(`「${toLabel}」里的「${id}」和「${fromLabel}」这条已经一样了`, 'ok'); return false; }
  if (dst) {
    const key0 = libKey();
    placeCopyPending = true;
    let c;
    try {
      c = await choiceDialog(`覆盖「${toLabel}」里的「${id}」`,
        `「${toLabel}」里的「${id}」会换成「${fromLabel}」这一条（锚点、区域、种子、数量等全部，可撤销）。\n别的布置不动。`,
        [['cancel', '取消'], ['overwrite', '覆盖']]);
    } finally { placeCopyPending = false; }
    if (c !== 'overwrite') { status(`没拷：「${toLabel}」里的「${id}」原样`, ''); return false; }
    // 对话框期间现场变了（换了场景、库被改过）：不按过期的判断动手
    if (S.busy || !S.scene || S.scene.id !== sid || libKey() !== key0) {
      status('没拷：确认期间换了场景或布置库变了，请再点一次', 'warn');
      return false;
    }
  }
  const prevPlace = S.placeId, prevSel = S.sel.key;
  // 拷进正在看的这一份：它成为活动布置（edit 里马上 rebuildSim，要先摆对）；区域顶点序号对不上新行，清掉
  if (to === S.phase) {
    S.placeId = id;
    if (/^area:/.test(S.sel.key)) S.sel.key = '';
  }
  const changed = editLib(`拷布置「${id}」：${fromLabel} → ${toLabel}`, () => {
    const r = libRows(sid, from).find((x) => x.id === id);
    const arr = rowsArr(sid, to);
    const i = arr.findIndex((x) => x && x.id === id);
    if (i >= 0) arr[i] = clone(r); else arr.push(clone(r));
  });
  if (!changed) { S.placeId = prevPlace; S.sel.key = prevSel; return false; }
  // 限定暂存跟着这条走（去掉「限定」勾时收着的范围区域，再勾上时两份一致）
  const kFrom = `${sid}\n${from}\n${id}`, kTo = `${sid}\n${to}\n${id}`;
  delete S.confineStash[kTo];
  if (S.confineStash[kFrom]) S.confineStash[kTo] = clone(S.confineStash[kFrom]);
  if (to === S.phase && S.doc && src.effect === S.doc.id) select(`place:${id}`);
  status(`${dst ? '覆盖' : '拷'}了「${toLabel}」里的「${id}」（只动这一条；Ctrl+S 存盘）`, 'ok');
  return true;
}
/** 从「这个效果还布置在」点过去：切到那个场景那套外观并选中它 */
async function goPlacement(sid, phase, id) {
  if (!S.scene || S.scene.id !== sid || S.phase !== (phase || '')) await loadScene(sid, phase || '');
  if (!S.scene || S.scene.id !== sid || S.phase !== (phase || '')) return;
  select(`place:${id}`);
}

/**
 * 写一块区域（拉框 / 删整块都走这里；语义照搬自 2026-09-13 主编辑器场景页那一栏，那一栏已拆掉、本台是唯一作者面）：
 * - 发射区域 `area`：`null` = 去掉；此时范围区域也没有 → `confine` 收进 stash 再删（没有区域的 confine 运行时整条忽略）。
 * - 范围区域 `confine.area`：写入即打开限定（没有 confine 就建，之前收着的边带 / 限高一并带回来）；
 *   `null` = 去掉，退回用发射区域（限定照开），发射区域也没有就整个 confine 收进 stash。
 * 只在写入闭包里调。
 */
function writeArea(p, role, pts) {
  const key = stashKey(p.id);
  if (role === 'range') {
    if (pts) {
      const c = p.confine && typeof p.confine === 'object' ? p.confine : (S.confineStash[key] ? clone(S.confineStash[key]) : {});
      delete S.confineStash[key];
      c.area = pts;
      p.confine = orderKeys(c, CONFINE_ORDER);
    } else if (p.confine && typeof p.confine === 'object' && 'area' in p.confine) {
      delete p.confine.area;
      if (!isPoly(p.area)) { S.confineStash[key] = clone(p.confine); delete p.confine; }
    }
  } else if (pts) {
    p.area = pts;
  } else {
    delete p.area;
    if (p.confine && typeof p.confine === 'object' && !isPoly(p.confine.area)) { S.confineStash[key] = clone(p.confine); delete p.confine; }
  }
}
function clearArea(role) {
  if (isSurfRole(role)) return deleteSurface(+role.slice(1));
  const p = activePlacement(); if (!p || !areaPoly(p, role)) return false;
  const ok = editPlacement(p.id, `清除${AREA_LABEL[role]}`, (r) => writeArea(r, role, null));
  if (/^area:/.test(S.sel.key)) S.sel.key = '';
  renderAll();
  return ok;
}
/** 「粒子限定在区域里」：去勾 = confine（含拉好的范围区域）收进 stash；再勾 = 原样回来 */
function setConfine(on) {
  const p = activePlacement(); if (!p) return false;
  const key = stashKey(p.id);
  if (on) {
    if (p.confine) return false;
    const st = S.confineStash[key];
    if (!isPoly(p.area) && !(st && isPoly(st.area))) { status('一块区域都没有：先拉一块发射区域或范围区域，限定才有东西可限', 'warn'); return false; }
    return editPlacement(p.id, '限定粒子区域', (r) => { r.confine = st ? clone(st) : {}; delete S.confineStash[key]; });
  }
  if (!p.confine) return false;
  return editPlacement(p.id, '去掉限定（范围区域先收着）', (r) => { S.confineStash[key] = clone(r.confine); delete r.confine; });
}
function areaToolBegin(role) {
  if (isSurfDraftRole(role)) {
    if (!S.scene || !S.cal) { status('这个场景没有深度载荷，拉不了表面区', 'warn'); return false; }
    return libEditable();
  }
  if (!S.doc || !S.cal) { status('这个场景没有深度载荷，拉不了区域', 'warn'); return false; }
  if (S.libErr) { libEditable(); return false; }
  if (!activePlacement()) { status(`本场景本时段没有布置这个效果：先点左栏「把当前效果布置到这里」，再拉${AREA_LABEL[role]}`, 'warn'); return false; }
  return true;
}
function setAreaDraft(role, a, b) {
  S.areaDraft = a && b ? { role, a: a.slice(), b: b.slice() } : null;
  draw();
}
/** 松手：拖出来的框 = 那一块区域（4 个点，画面坐标）。太小的框当手滑，不写 */
function commitAreaDraft() {
  const d = S.areaDraft; S.areaDraft = null;
  if (d && isSurfDraftRole(d.role)) return commitSurfaceDraft(d);
  const p = activePlacement();
  if (!d || !p) { draw(); return false; }
  const x0 = Math.min(d.a[0], d.b[0]), x1 = Math.max(d.a[0], d.b[0]), y0 = Math.min(d.a[1], d.b[1]), y1 = Math.max(d.a[1], d.b[1]);
  if (x1 - x0 < 4 || y1 - y0 < 4) { status(`框太小（${fmt(x1 - x0, 0)} × ${fmt(y1 - y0, 0)} wu），没写`, 'warn'); draw(); return false; }
  const pts = [[round1(x0), round1(y0)], [round1(x1), round1(y0)], [round1(x1), round1(y1)], [round1(x0), round1(y1)]];
  const role = d.role;
  if (/^area:/.test(S.sel.key)) S.sel.key = '';
  const ok = editPlacement(p.id, `拉${AREA_LABEL[role]}`, (r) => writeArea(r, role, pts));
  setTool('select');
  // 拉之前选着布置锚点（布置到这里 / 打开效果都会选中它）：拉完不许还选着——
  // 框拉歪了按 Delete 想删框，删掉的是整条布置（锚点 / 种子 / 两块区域一起没）
  if (ok && (S.sel.key === 'anchor' || /^area:/.test(S.sel.key))) select('');
  if (ok) status(`${AREA_LABEL[role]}：${fmt(x1 - x0, 0)} × ${fmt(y1 - y0, 0)} wu（拖顶点改形状 · 双击边线加点 · 选中顶点后 Delete / 右键删点）`, 'ok');
  return ok;
}
/** 双击边线加点：插在 `after` 之后，新点立刻选中（gizmo 马上在它身上） */
function insertAreaVertex(role, after, pt) {
  if (isSurfRole(role)) {
    const ri = +role.slice(1);
    const ok = editSurfaces(`${roleLabel(role)}加点`, (arr) => {
      const r = arr[ri]; if (r && isPoly(r.polygon)) r.polygon.splice(after + 1, 0, [round1(pt[0]), round1(pt[1])]);
    });
    if (ok) select(`area:${role}:${after + 1}`);
    return ok;
  }
  const p = activePlacement(); if (!p || !areaPoly(p, role)) return false;
  const ok = editPlacement(p.id, `${AREA_LABEL[role]}加点`, (r) => {
    const poly = areaPoly(r, role); if (poly) poly.splice(after + 1, 0, [round1(pt[0]), round1(pt[1])]);
  });
  if (ok) select(`area:${role}:${after + 1}`);
  return ok;
}
/** 删点；只剩 3 个时再删 = 删掉整块（先确认） */
async function deleteAreaVertexKey(key) {
  const ak = areaKey(key); if (!ak) return false;
  if (isSurfRole(ak.role)) return deleteSurfaceVertex(ak, key);
  if (ak.poly.length <= 3) {
    const sure = await confirmDialog(`删掉整块${AREA_LABEL[ak.role]}？`,
      `只剩 3 个顶点，再删就不成多边形了。${ak.role === 'range' ? '删掉范围区域 = 退回用发射区域（限定照开）' : '删掉发射区域 = 纸钱铺撒退成锚点周围的圆盘'}`);
    if (!sure) return false;
    return clearArea(ak.role);
  }
  // 选中的是同一块里**后面**的顶点：删掉前面一个，它的下标跟着减一——原来选中键原样不动，指到了原来的下一个点，
  // gizmo 跳过去，接着按 Delete 删的是另一个点
  const cur = /^area:(emit|range|s\d+):(\d+)$/.exec(S.sel.key || '');
  const ok = editPlacement(ak.p.id, `${AREA_LABEL[ak.role]}删点`, (r) => { const poly = areaPoly(r, ak.role); if (poly) poly.splice(ak.i, 1); });
  if (ok && cur && cur[1] === ak.role) {
    const idx = +cur[2];
    if (idx === ak.i) S.sel.key = '';
    else if (idx > ak.i) S.sel.key = `area:${ak.role}:${idx - 1}`;
  } else if (S.sel.key === key) S.sel.key = '';
  renderAll();
  return ok;
}
/**
 * 边线拾取（双击加点用）：沿边按 `AREA_STEP` 采样、经视图给的投影落到画布上，找离光标最近的一段。
 * 3D 与 2D 共用，只差 `projScene(sx, sy) → 画布 px`。返回 `{role, after, pt(画面点), d}` 或 null。
 */
function areaEdgeHit(projScene, mx, my, tol) {
  const p = activePlacement();
  const roles = (p ? AREA_ROLES : []).concat(S.surfEdit ? sceneSurfaces().map((_, i) => `s${i}`) : []);
  if (!roles.length) return null;
  let best = null;
  for (const role of roles) {
    const poly = areaPoly(p, role); if (!poly) continue;
    for (let j = 0; j < poly.length; j++) {
      const A = poly[j], B = poly[(j + 1) % poly.length];
      const n = Math.max(1, Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1]) / AREA_STEP));
      let prev = projScene(A[0], A[1]);
      for (let k = 1; k <= n; k++) {
        const cur = projScene(A[0] + (B[0] - A[0]) * k / n, A[1] + (B[1] - A[1]) * k / n);
        if (prev && cur) {
          const d = distToSeg(mx, my, prev, cur);
          if (d <= tol && (!best || d < best.d)) {
            const dx = cur[0] - prev[0], dy = cur[1] - prev[1], l2 = dx * dx + dy * dy;
            const u = l2 > 0 ? clamp(((mx - prev[0]) * dx + (my - prev[1]) * dy) / l2, 0, 1) : 0;
            const t = (k - 1 + u) / n;
            best = { role, after: j, d, pt: [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t] };
          }
        }
        prev = cur;
      }
    }
  }
  return best;
}
/**
 * 区域画什么（画面坐标，2D / 3D 共用）：发射区域（青虚线）、范围区域（黄实线）、实际起限定作用那块上的
 * **边带内沿**（离框线 `feather` 的等值线——运行时 `confineDistanceContour` 本体，不在 JS 里另写距离场）、正在拉的框。
 * 边带内沿按区域 JSON 缓存（256² 网格的距离场一帧算一次太贵，播放时 60 帧 / 秒在调它）。
 */
let areaCache = { key: '', contour: null };
function areaShapes() {
  const out = { polys: [], contour: null, draft: null };
  if (S.surfEdit) {
    sceneSurfaces().forEach((r, i) => { if (r && isPoly(r.polygon)) out.polys.push({ role: `s${i}`, poly: r.polygon, surf: r.kind === 'wet' ? 'wet' : 'water' }); });
  }
  const p = activePlacement();
  if (p) {
    for (const role of AREA_ROLES) { const poly = areaPoly(p, role); if (poly) out.polys.push({ role, poly }); }
    if (p.confine && typeof p.confine === 'object' && S.rt && S.rt.vfxConfine) {
      const key = JSON.stringify([p.area || null, p.confine]);
      if (areaCache.key !== key) {
        const f = S.rt.vfxConfine.buildConfineField(Array.isArray(p.area) ? p.area : null, p.confine);
        areaCache = { key, contour: f && f.feather > 0 ? { segs: S.rt.vfxConfine.confineDistanceContour(f, f.feather), feather: f.feather } : null };
      }
      out.contour = areaCache.contour;
    }
  }
  const d = S.areaDraft;
  if (d) {
    const x0 = Math.min(d.a[0], d.b[0]), x1 = Math.max(d.a[0], d.b[0]), y0 = Math.min(d.a[1], d.b[1]), y1 = Math.max(d.a[1], d.b[1]);
    out.draft = { role: d.role, poly: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
  }
  return out;
}
/** 3D：画面点 → 贴地世界点（略抬高） */
function areaPointWorld(sx, sy) {
  const w = S.cal.sceneToWorldGround(sx, sy);
  return [w[0], w[1] + AREA_LIFT, w[2]];
}
/** 3D 折线：边上按步长采样贴地；虚线 = 按累计长度隔段画 */
function areaLines3() {
  const cal = S.cal; if (!cal) return [];
  const sh = areaShapes(), out = [];
  const ring = (poly, rgb, alpha, dash) => {
    const arr = [];
    let run = 0;
    for (let j = 0; j < poly.length; j++) {
      const A = poly[j], B = poly[(j + 1) % poly.length];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const n = Math.max(1, Math.ceil(len / AREA_STEP));
      let prev = areaPointWorld(A[0], A[1]);
      for (let k = 1; k <= n; k++) {
        const cur = areaPointWorld(A[0] + (B[0] - A[0]) * k / n, A[1] + (B[1] - A[1]) * k / n);
        if (!dash || Math.floor(run / 24) % 2 === 0) arr.push(prev[0], prev[1], prev[2], cur[0], cur[1], cur[2]);
        run += len / n;
        prev = cur;
      }
    }
    out.push({ pts: new Float32Array(arr), color: [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, alpha] });
  };
  for (const s of sh.polys) ring(s.poly, roleRgb(s.role), 0.95, s.role === 'emit');
  if (sh.contour && sh.contour.segs.length) {
    const arr = [], c = sh.contour.segs;
    for (let i = 0; i + 3 < c.length; i += 4) {
      const a = areaPointWorld(c[i], c[i + 1]), b = areaPointWorld(c[i + 2], c[i + 3]);
      arr.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
    const rgb = AREA_RGB.range;
    out.push({ pts: new Float32Array(arr), color: [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 0.5] });
  }
  if (sh.draft) ring(sh.draft.poly, roleRgb(sh.draft.role), 0.8, true);
  return out;
}

// ---------------------------------------------------------------------------
// 表面材质区（水面 / 湿地；场景级、所有时段共用）
// ---------------------------------------------------------------------------
/** 当前场景表面区的**真数组**（没有就建）——只许在写入闭包里调（删空的由 `pruneLib` 剥掉） */
function surfacesArr() {
  if (!S.lib || typeof S.lib !== 'object') S.lib = { scenes: {} };
  if (!S.lib.scenes || typeof S.lib.scenes !== 'object') S.lib.scenes = {};
  const ent = S.lib.scenes[S.scene.id] || (S.lib.scenes[S.scene.id] = {});
  if (!Array.isArray(ent.surfaces)) ent.surfaces = [];
  return ent.surfaces;
}
/** 一次表面区编辑（与布置同一条历史 / 脏态 / 联动）；写完逐块收键序 */
function editSurfaces(label, fn) {
  if (!S.scene) return false;
  return editLib(label, () => { const arr = surfacesArr(); fn(arr); for (const r of arr) if (r && typeof r === 'object') orderKeys(r, SURFACE_ORDER); });
}
function uniqueSurfaceId(kind) {
  const used = new Set(sceneSurfaces().map((r) => r && r.id));
  let n = 1; while (used.has(`${kind}_${n}`)) n++;
  return `${kind}_${n}`;
}
/** 松手：拖出来的框 = 新的一块表面区（4 个点，画面坐标）；太小的框当手滑 */
function commitSurfaceDraft(d) {
  const x0 = Math.min(d.a[0], d.b[0]), x1 = Math.max(d.a[0], d.b[0]), y0 = Math.min(d.a[1], d.b[1]), y1 = Math.max(d.a[1], d.b[1]);
  if (x1 - x0 < 4 || y1 - y0 < 4) { status(`框太小（${fmt(x1 - x0, 0)} × ${fmt(y1 - y0, 0)} wu），没写`, 'warn'); draw(); return false; }
  const kind = d.role, id = uniqueSurfaceId(kind);
  const polygon = [[round1(x0), round1(y0)], [round1(x1), round1(y0)], [round1(x1), round1(y1)], [round1(x0), round1(y1)]];
  const ok = editSurfaces(`拉一块${SURF_LABEL[kind]}「${id}」`, (arr) => { arr.push({ id, kind, polygon }); });
  setTool('select');
  if (ok) {
    S.surfEdit = true;
    select(`area:s${sceneSurfaces().length - 1}:0`);
    status(`${SURF_LABEL[kind]}「${id}」：${fmt(x1 - x0, 0)} × ${fmt(y1 - y0, 0)} wu（整个场景所有时段共用；拖顶点贴着原画里的${SURF_LABEL[kind]}描边 · 双击边线加点）`, 'ok');
  }
  return ok;
}
/** 删一块（可撤） */
function deleteSurface(ri) {
  const r = sceneSurfaces()[ri]; if (!r) return false;
  const ok = editSurfaces(`删${SURF_LABEL[r.kind] || '表面区'}「${r.id}」`, (arr) => { arr.splice(ri, 1); });
  if (/^area:s\d+:/.test(S.sel.key)) S.sel.key = '';
  renderAll();
  return ok;
}
/** 删表面区的一个顶点；只剩 3 个时再删 = 删掉整块（先确认） */
async function deleteSurfaceVertex(ak, key) {
  const ri = +ak.role.slice(1);
  if (ak.poly.length <= 3) {
    const sure = await confirmDialog(`删掉整块${roleLabel(ak.role)}？`, '只剩 3 个顶点，再删就不成多边形了。');
    if (!sure) return false;
    return deleteSurface(ri);
  }
  const cur = /^area:(s\d+):(\d+)$/.exec(S.sel.key || '');
  const ok = editSurfaces(`${roleLabel(ak.role)}删点`, (arr) => { const r = arr[ri]; if (r && isPoly(r.polygon)) r.polygon.splice(ak.i, 1); });
  if (ok && cur && cur[1] === ak.role) {
    const idx = +cur[2];
    if (idx === ak.i) S.sel.key = '';
    else if (idx > ak.i) S.sel.key = `area:${ak.role}:${idx - 1}`;
  } else if (S.sel.key === key) S.sel.key = '';
  renderAll();
  return ok;
}
/** 改一块的一个量（检视器用；`v == null` = 删掉那个键、回缺省） */
function setSurfaceField(ri, key, v, label) {
  const r = sceneSurfaces()[ri]; if (!r) return false;
  return editSurfaces(`改${SURF_LABEL[r.kind] || '表面区'}「${r.id}」的${label}`, (arr) => {
    const x = arr[ri]; if (!x) return;
    if (v == null || v === '') delete x[key]; else x[key] = v;
  });
}
/** 全局缺省表面材质的一个量（`v == null` = 删掉那个键、回运行时缺省）；所有场景一份 */
function setDefaultSurfaceField(key, v, label) {
  return editLib(`改没画区域的地方的${label}（所有场景）`, () => {
    if (!S.lib || typeof S.lib !== 'object') S.lib = { scenes: {} };
    const d = S.lib.defaultSurface && typeof S.lib.defaultSurface === 'object' ? S.lib.defaultSurface : (S.lib.defaultSurface = {});
    if (v == null || v === '') delete d[key]; else d[key] = v;
    orderKeys(d, DEFAULT_SURFACE_ORDER);
  });
}
/** 改一块的 id（本场景里唯一；不许空） */
function renameSurface(ri, v) {
  const r = sceneSurfaces()[ri]; const id = String(v || '').trim();
  if (!r || !id || id === r.id) return false;
  if (sceneSurfaces().some((x, i) => i !== ri && x && x.id === id)) { status(`本场景已经有叫「${id}」的表面区`, 'warn'); renderInspector(); return false; }
  return editSurfaces(`表面区「${r.id}」改名为「${id}」`, (arr) => { if (arr[ri]) arr[ri].id = id; });
}
function setSurfEdit(on) {
  S.surfEdit = !!on;
  if (!S.surfEdit && /^area:s\d+:/.test(S.sel.key)) S.sel.key = '';
  if (!S.surfEdit && isSurfDraftRole(AREA_TOOL_ROLE[S.tool])) setTool('select');
  renderInspector(); draw();
}
/** 本地预览：锚点落在哪种表面（与 `VfxSystem.surfaceKindAt` 同一个判据：盖着它的最后一块区是水面才算 water） */
function previewSurfaceKind(anchor) {
  const pip = S.rt && S.rt.vfxConfine && S.rt.vfxConfine.pointInPolygon;
  if (!pip || !anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return 'ground';
  const rs = sceneSurfaces();
  for (let i = rs.length - 1; i >= 0; i--) {
    const r = rs[i];
    if (r && isPoly(r.polygon) && pip(r.polygon, anchor.x, anchor.y)) return r.kind === 'water' ? 'water' : 'ground';
  }
  return 'ground';
}

// ---- 发射器列表操作
function uniqueEmitterId(base) {
  const used = new Set((S.doc.emitters || []).map((e) => e.id));
  if (!used.has(base)) return base;
  let n = 2; while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}
function addEmitter() {
  if (!S.rt?.vfxProgram) { status('运行时模块未加载，暂时无法新建发射器', true); return; }
  edit('加发射器', () => {
    const id = uniqueEmitterId('emitter');
    S.doc.emitters = S.doc.emitters || [];
    S.doc.emitters.push({
      id,
      simulation: S.rt.vfxProgram.newEmitterProgram('particle'),
      appearance: { image: (S.sources.images[0] || '/resources/runtime/images/vfx/dust.png'), sizeWu: 6, lit: true },
      spawn: { max: 30, rate: 6, shape: { kind: 'sphere', radius: 20 }, speed: [10, 30] },
      motion: { drag: 0.6 },
      life: { seconds: [1.5, 3] },
    });
    S.sel.key = `emitter:${id}`; S.emitterId = id;
  });
}
function dupEmitter(id) {
  edit('复制发射器', () => {
    const i = (S.doc.emitters || []).findIndex((e) => e.id === id); if (i < 0) return;
    const copy = JSON.parse(JSON.stringify(S.doc.emitters[i]));
    copy.id = uniqueEmitterId(id);
    if (copy.collision && copy.collision.onHit) delete copy.collision.onHit;   // 引用要作者重指，不静默复制
    S.doc.emitters.splice(i + 1, 0, copy);
    S.sel.key = `emitter:${copy.id}`; S.emitterId = copy.id;
  });
}
function delEmitter(id) {
  const users = (S.doc.emitters || []).filter((e) => e.collision && e.collision.onHit && e.collision.onHit.emitter === id).map((e) => e.id);
  if (users.length) { status(`删不了「${id}」：${users.join(' / ')} 的撞击子发射还指着它（先改掉）`, 'err'); return; }
  edit('删发射器', () => {
    S.doc.emitters = (S.doc.emitters || []).filter((e) => e.id !== id);
    if (S.sel.key.endsWith(`:${id}`)) S.sel.key = '';
    if (S.emitterId === id) S.emitterId = '';
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
  if (S.emitterId === oldId) S.emitterId = newId;
}

// ---------------------------------------------------------------------------
// 编辑 / 历史 / 手势
// ---------------------------------------------------------------------------
/**
 * 一次原子编辑：只有真改了 doc / 库才入历史、才标脏、**才重建模拟 / 推给游戏 / 加 rev**——
 * 什么都没改（再输一遍同一个数、点在原地）原来照样重建模拟回 t=0、推一发、rev 加一（在飞的保存误报"又有改动"）。
 * 没改也重画一遍：钳位后值没变时输入框里还留着作者打的越界数，得刷回真值。
 */
function edit(label, fn) {
  if (!S.doc && !S.lib) return false;
  const changed = history.commit(label, fn);
  if (changed) {
    touchDoc();
    rebuildSim();
    refreshDirty(); renderAll(); schedulePublish();
    status(`${label}`, '');
  } else {
    refreshDirty(); renderAll();
  }
  return changed;
}
function dragBegin(label) {
  if (!S.doc) return;
  S.dragDoc = S.doc; S.dragLib = S.lib;
  history.beginDrag(label);
}
function dragTick(fn) {
  if (S.dragDoc !== S.doc || S.dragLib !== S.lib) return;   // doc / 库被整份换掉：这次手势作废（不回滚）
  fn();
  touchDoc(); patchSim(); refreshDirty(); draw(); renderSimBar();
}
function dragEnd() {
  if (!history.inDrag()) return;
  const changed = history.endDrag();
  S.dragDoc = null; S.dragLib = null;
  if (changed) { rebuildSim(); refreshDirty(); renderAll(); schedulePublish(); }
  else { draw(); }
}
/** doc 正被整份换掉（打开另一份效果）：丢掉在飞手势，**不**回滚（回滚会把旧文档塞回新资产里） */
function dropGestures() {
  nudgeReset();
  if (v3) v3.drag = null;
  if (v2) v2.drag = null;
  history.discardDrag();
  S.dragDoc = null; S.dragLib = null; S.areaDraft = null;
}
/** 换场景 / 换时段外观：doc 与库都不换，在飞的手势**撤回**到按下之前（半截拖拽不许留在库里、又不进历史） */
function cancelGestures() {
  nudgeReset();
  if (v3) v3.drag = null;
  if (v2) v2.drag = null;
  if (history && history.inDrag()) history.cancelDrag();
  S.dragDoc = null; S.dragLib = null; S.areaDraft = null;
}

function select(key) {
  key = key || '';
  // 选中了东西 = 回到选择工具：原来按了 A / M / K / 拉区域又改主意、去左栏点一行，工具还武装着——
  // 选中项没有 gizmo（两个视图只在选择工具下画），再点它的标记跑的是那个工具（A 把布置锚点挪到点击处、K 往游戏里真发一个刺激）
  if (key && S.tool !== 'select') {
    if (/^area/.test(S.tool)) cancelAreaDrag();
    setTool('select');
  }
  const pm = /^place:(.+)$/.exec(key);
  let rebuilt = false;
  if (pm) {
    // 选中一条布置 = 它成为活动布置，gizmo 立刻落在它的锚点上
    const before = activePlacement();
    S.placeId = pm[1];
    key = 'anchor';
    if (before !== activePlacement()) { rebuildSim(); renderSimBar(); rebuilt = true; }
  }
  const emId = emitterIdOfKey(key);
  if (emId) S.emitterId = emId;                        // 记住作者最近操作的发射器（选别的东西时检视器不跳回第一个）
  const bmk = beamKeyOf(key);
  if (bmk) S.beamId = bmk.id;
  if (S.sel.key === key && !rebuilt) { draw(); return; }
  S.sel.key = key;
  const r = radiusOf(S.sel.key);
  if (r) S.gizmoMode = 'scale';                        // 半径只有缩放有意义
  else if (S.gizmoMode === 'scale') S.gizmoMode = 'move';
  renderLeft(); renderInspector(); draw();
}
function setTool(t) {
  S.tool = t;
  if (!/^area/.test(t)) S.areaDraft = null;
  const tr = AREA_TOOL_ROLE[t];
  if ((tr === 'emit' || tr === 'range') && S.doc && !activePlacement()) {
    status(`本场景本时段没有布置这个效果：先点左栏「把当前效果布置到这里」，再拉${AREA_LABEL[tr]}`, 'warn');
  }
  if (isSurfDraftRole(tr)) {
    // 拉表面区就把表面区显示出来（拉完要能看见、能拖顶点）
    if (!S.surfEdit) { S.surfEdit = true; renderInspector(); }
    status(`拉一块${SURF_LABEL[tr]}：按住拖一个框（之后拖顶点改形状 · 双击边线加点 · 选中顶点 Delete / 右键删点）。Esc 退出`, '');
  }
  if (t === 'fire' && S.doc) {
    // 武装火工具就先说清楚放了火能点着什么（绑了模板但装不上要说为什么），别等点下去才发现什么都不着
    const hint = fireHint();
    status(`火焰调试（I）：点场景表面放一段竖直火焰（只在本地预览里）——${hint.text}`, hint.kind);
  }
  for (const b of document.querySelectorAll('#tools button[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
  renderAnchorToolTitle();
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

/**
 * 打开一份效果。只有**效果**有未保存改动才确认（布置库是全局的，换效果不丢它的改动；但历史栈清掉——
 * 复合快照里带着旧 doc，撤销会把旧效果塞回来）。`opts.keepScene` = 不跳作者场景（从布置行「打开这个效果」进来），
 * `opts.placeId` = 打开后选中哪条布置。
 */
async function openEffect(id, opts) {
  const o = opts || {};
  if (S.busy) { status('装载中，等一下', 'warn'); return; }
  const refocus = keyboardSelectOf(o);                 // 方向键逐项换效果：装完焦点放回下拉框（见 keyboardSelectOf）
  // 检视器输入框里打了数还没提交：先提交，再看脏不脏——主编辑器「在工作台打开」/ 桌面壳 `--open` 走 `__openEffect`，
  // 焦点一动不动，原来脏检查看到"没改"、不问就把 doc 换掉，刚打的值没了；而且必须在 setBusy 之前（#app 变 inert
  // 会把值冲进马上要被换掉的旧 doc）。下拉框不失焦：它在选中那一刻就提交了，方向键逐项换效果时每步都进这里
  if (document.activeElement && document.activeElement.tagName !== 'SELECT') commitFocusedInput();
  // 有未保存的改动：「先保存 / 不保存 / 取消」（原来只有丢弃或取消，作者得取消、Ctrl+S、再选一次）
  if (S.docDirty && !o.force && !await resolveDirtyBefore(`打开「${id}」`, false)) { if (S.doc) el('effectSel').value = S.doc.id; restoreSelectFocus(refocus); return; }
  setBusy(true, `打开「${id}」…`);
  const snapshot = { doc: S.doc, cleanDoc: S.cleanDoc, placeId: S.placeId, emitterId: S.emitterId, extRefs: S.extRefs };
  try {
    const j = await API.json(`/api/effect?id=${encodeURIComponent(id)}`);
    dropGestures();
    S.doc = j.doc;
    S.sel.key = '';
    S.emitterId = '';                                  // 上一份效果的发射器 id，别让同名的串过来
    S.beamId = '';
    S.extRefs = Array.isArray(j.externalRefs) ? j.externalRefs : [];
    S.placeId = o.placeId || '';
    // 撤销栈里库那一半一律留着（把每条的 doc 换成新打开的这份，只改了旧效果 doc 的条目丢掉）——
    // 原来一律清空，一边摆几个效果一边切来切去时，前面拉的区域 / 删的布置全都撤不回来；
    // 也不看 libDirty：「先保存」/ Ctrl+S 刚把库存了，存盘不清撤销栈，换效果也不许清。
    // 只有改名 / 删效果（服务端改了盘上的库、页面整份换过 S.lib）才清：旧快照里是旧 id / 删掉的布置
    if (o.resetHistory) history.clear(); else rebaseHistoryOnDoc(j.doc);
    markClean('doc');
    touchDoc();
    S.probes.length = 0; S.fields.length = 0; S.playerField = null;
    S.walk.on = false;                                 // 走动是上一份资产的工作态，不跟着跨资产
    let env = { placeId: '', elsewhere: [] };
    if (!o.keepScene) {
      env = await syncEnvWithDoc(!!o.jump);
      if (env.placeId && !o.placeId) o.placeId = env.placeId;
    }
    if (o.placeId) S.placeId = o.placeId;
    // 重开效果 = 重读可燃物模板表（燃烧工作台可能刚改过模板）：第一次建模拟就按盘上最新的模板烧；读不到照旧开
    await refreshBurnTemplates({ rebuild: false });
    // 雷电效果：重读「每份效果的产物是不是最新」那张表（复制 / 别处刚生成过，开页时读的那张已经旧了）
    if (S.doc && S.doc.generator) await refreshLightningRows();
    rebuildSim();
    if (o.placeId && activePlacement() && activePlacement().id === o.placeId) S.sel.key = 'anchor';
    renderAll();
    el('effectSel').value = id;
    // 换了效果就推一次：游戏里还挂着上一个效果（可能是刚丢弃的改动）的工作态
    schedulePublish();
    const libNote = S.libDirty ? '（布置库还有未保存的改动）' : '';
    if (S.scene && !activePlacement() && env.elsewhere.length) {
      const where = env.elsewhere.slice(0, 3).map((r) => `${r.sceneId} · ${phaseLabel(r.sceneId, r.phase)}`).join('、');
      status(`打开「${id}」：这里没布置它；它布置在 ${where}${env.elsewhere.length > 3 ? ` 等 ${env.elsewhere.length} 处` : ''}（左栏「这个效果还布置在」点一下过去）${libNote}`, 'warn');
    } else {
      status(`打开「${id}」${libNote}`, 'ok');
    }
  } catch (e) {
    S.doc = snapshot.doc; S.cleanDoc = snapshot.cleanDoc; S.placeId = snapshot.placeId;
    S.emitterId = snapshot.emitterId; S.extRefs = snapshot.extRefs;
    refreshDirty();
    status(`打不开「${id}」：${e && e.message || e}`, 'err');
    if (S.doc) el('effectSel').value = S.doc.id;
  } finally { setBusy(false); restoreSelectFocus(refocus); }
}

/**
 * 重开现场：打开一个效果时决定装哪个场景。
 * - 当前这份（场景 × 时段外观）里就布置了它 → 不动。
 * - **从效果下拉框换效果、而且已经在某个场景里** → 不动：作者很可能正要把它布置到这里
 *   （新建的效果一律带着作者场景，照它跳就等于每次换效果都被拽走）。返回 `elsewhere`，状态栏说它布置在哪。
 * - `jump`（开页 / 桌面壳 `--open` / 主编辑器打过来）或还没装场景：
 *   全库有布置 → 去那一份并选中那条（优先同场景的另一套外观）——开页停在一个没布置它的场景里，
 *   作者第一眼只看到"本场景本时段没有布置这个效果"；没有布置但记着作者场景 → 装它（背景名折回那套时段外观）；
 *   都没有、也还没装场景 → 装第一个有深度的。
 * 返回 `{placeId, elsewhere}`。装不上不拦着干活，状态栏会说。
 */
async function syncEnvWithDoc(jump) {
  const out = { placeId: '', elsewhere: [] };
  if (!S.doc) return out;
  const refs = libRefs(S.doc.id);
  if (S.scene && refs.some((r) => r.sceneId === S.scene.id && r.phase === S.phase)) return out;
  if (S.scene && !jump) { out.elsewhere = refs; return out; }
  const known = (sid) => S.scenes.some((s) => s.id === sid);
  const ref = (S.scene && refs.find((r) => r.sceneId === S.scene.id)) || refs.find((r) => known(r.sceneId));
  if (ref) {
    await loadScene(ref.sceneId, ref.phase);
    if (S.scene && S.scene.id === ref.sceneId && S.phase === ref.phase) out.placeId = ref.id;
    return out;
  }
  const au = S.doc.authoring;
  if (au && au.sceneId && known(au.sceneId)) {
    const bg = au.background || '';
    const ph = bg ? phasesOf(au.sceneId).find((p) => p.background === bg) : null;
    if (!(S.scene && S.scene.id === au.sceneId && (!bg || S.bgName === bg))) {
      await loadScene(au.sceneId, ph ? ph.key : (S.scene && S.scene.id === au.sceneId ? S.phase : ''));
    }
    return out;
  }
  if (!S.scene) {
    const first = S.scenes.find((s) => s.depth) || S.scenes[0];
    if (first) await loadScene(first.id, '');
  }
  return out;
}

/**
 * Ctrl+S：**一次存两份**（效果 + 布置库，走同一条 `runIO` 链、先后各一个请求）。
 * 布置库只在真脏时存；读不懂的库绝不覆盖。只成功一半 → 状态栏如实说哪份没存上，那份不清脏、历史栈不清。
 * 保存锁：请求在飞期间又改了 → 两份都不清脏、不覆盖内存，状态栏说再按一次。
 */
async function saveEffect() {
  // 光标还停在检视器的输入框里（改了数没按回车）：先让它失焦，`change` 同步把值提交进 doc 再存——
  // 不然存的是改之前的值，状态栏还说"已存"
  commitFocusedInput();
  nudgeEnd();                                          // 键盘微移不是"手势没松开"：先把它收成一条历史再存
  if (!S.doc && !S.libDirty) return;
  if (S.busy) { status('装载中不存盘（doc 与画布还没对上）', 'warn'); return; }
  if (history.inDrag()) { status('手势没松开，不存盘', 'warn'); return; }
  if (!S.dirty) { status(S.lsDirty ? '雷电样式的改动要点检视器里「生成并套用」才落盘（Ctrl+S 只存效果与布置库）' : '没有未保存的改动', S.lsDirty ? 'warn' : 'ok'); return; }
  const revAt = S.rev;
  const id = S.doc ? S.doc.id : '';
  return runIO(async () => {
    const wantLib = S.libDirty;
    const libChanges = structuredClone(changedPlacementLibrary());
    // 只存真改了的那份：没改的效果文件不重写（盘上那份可能刚被别处改过，原样覆盖回去等于替人撤销）
    const wantDoc = !!S.doc && S.docDirty;
    let docRes = null, libRes = null, docErr = '', libErr = '';
    if (wantDoc) {
      try { docRes = await API.post('/api/save', { doc: structuredClone(S.doc), base: S.cleanDoc ? JSON.parse(S.cleanDoc) : null }); } catch (e) { docErr = String(e && e.message || e); }
    }
    if (wantLib) {
      if (S.libErr) libErr = `布置库读不懂，不覆盖它：${S.libErr}`;
      else {
        try { libRes = await API.post('/api/placements/save', { changes: libChanges, base: JSON.parse(S.cleanLib) }); } catch (e) { libErr = String(e && e.message || e); }
      }
    }
    if (S.rev !== revAt || (S.doc ? S.doc.id : '') !== id) {
      // The submitted snapshot may already be on disk. Advance only that
      // baseline, keeping edits made during the request dirty and undoable.
      if (docRes && S.doc?.id === id) S.cleanDoc = canonJson(docRes.doc);
      if (libRes) S.cleanLib = canonJson(acceptSavedPlacements(libRes.doc, libChanges, JSON.parse(S.cleanLib)));
      refreshDirty();
      status('保存期间又有改动，再按一次 Ctrl+S', 'warn');
      return;
    }
    // 服务端落盘形与页面这份**内容**一样（它通常只是重排键序）：本地预览不重来。原来每次 Ctrl+S 都 rebuildSim 回 t=0——
    // 调一下群体参数、播 10 秒看它落定、Ctrl+S，蝙蝠回巢、纸钱重撒，正在看的状态没了（模拟拿的是自己的快照，换对象不用重建）
    if (libRes) libRes.doc = acceptSavedPlacements(libRes.doc, libChanges);
    const sameDoc = !docRes || canonJson(S.doc) === canonJson(docRes.doc);
    const sameLib = !libRes || canonJson(S.lib) === canonJson(libRes.doc);
    // 存上的那份换成服务端的落盘形（新对象：必须 renderAll 重建检视器，旧闭包绑着孤儿对象）
    if (docRes) { S.doc = docRes.doc; markClean('doc'); }
    if (libRes) { S.lib = libRes.doc; markClean('lib'); }
    // 存盘**不清撤销栈**：存完才发现刚才删错了布置 / 拉错了区域，Ctrl+Z 还得回得去（撤回来就又是未保存）
    if (!sameDoc || !sameLib) { touchDoc(); rebuildSim(); }
    await refreshEffects();
    if (docRes && S.doc && S.doc.generator) await refreshLightningRows();
    if (S.doc) el('effectSel').value = S.doc.id;
    renderAll(); schedulePublish();
    const warns = [].concat((docRes && docRes.warnings) || [], (libRes && libRes.warnings) || []);
    if (docErr || libErr) {
      const parts = [];
      if (docErr) parts.push(`效果没存上：${docErr}`);
      else if (docRes) parts.push(`效果已存 ${docRes.path}`);
      if (libErr) parts.push(`布置库没存上：${libErr}`);
      else if (libRes) parts.push(`布置库已存 ${libRes.path}`);
      status(parts.join('；'), 'err');
      return;
    }
    const saved = [docRes && docRes.path, libRes && libRes.path].filter(Boolean).join(' + ');
    status(`已存 ${saved}${warns.length ? ' ⚠ ' + warns.join('；') : ''}`, warns.length ? 'warn' : 'ok');
  });
}

/**
 * 当前效果有未保存改动、又要打开别的（新建 / 复制之后会切过去）：**先问、再动盘**。
 * 原来先写盘再在 openEffect 里问"丢弃改动？"——选取消就留下一个没人要的新文件。
 * 返回 'save'（已存上）/ 'discard' / 'carry'（复制时把改动带进副本）/ null（取消）。
 */
async function resolveDirtyBefore(what, allowCarry) {
  if (!S.docDirty || !S.doc) return 'clean';
  commitFocusedInput();
  const choices = [['cancel', '取消'], ['discard', '不保存']];
  if (allowCarry) choices.push(['save', '先保存']);
  choices.push(allowCarry ? ['carry', '改动带进副本'] : ['save', '先保存']);
  const c = await choiceDialog(`「${S.doc.id}」有未保存的改动`,
    allowCarry ? `${what}之前怎么处理这些改动？\n「改动带进副本」= 副本就是现在页面上这份，「${S.doc.id}」保持盘上原样` : `${what}之前怎么处理这些改动？`, choices);
  if (!c || c === 'cancel') return null;
  if (c === 'save') {
    await saveEffect();
    if (S.docDirty) { status('没存上，没继续（看上一条状态）', 'err'); return null; }
  }
  return c;
}
/**
 * 换了效果、布置库还有没存的改动：撤销栈里每条的复合快照 `{doc, lib}` 把 doc 换成新打开的这份，
 * 只剩库的差别；前后变得一样的（只改了旧效果 doc 的）丢掉。库的改动于是还能撤销，旧效果永远不会被撤回来。
 */
function rebaseHistoryOnDoc(doc) {
  const rebase = (arr) => {
    const out = [];
    for (const en of arr) {
      const b = JSON.parse(en.before), a = JSON.parse(en.after);
      b.doc = doc; a.doc = doc;
      const bs = JSON.stringify(b), as = JSON.stringify(a);
      if (bs !== as) out.push({ label: en.label, before: bs, after: as });
    }
    arr.length = 0;
    arr.push(...out);
  };
  history.discardDrag();
  rebase(history.undoStack);
  rebase(history.redoStack);
  renderDocState();
}
// ---------------------------------------------------------------------------
// 雷电样式（`lightning.js` 那一节的读写；数据规矩在 tools/vfx_workbench/lightning.py）
// ---------------------------------------------------------------------------
/** 服务端那份（`/api/lightning` 或套用的回包）装进 `S.ls`：草稿 = 盘上那份、待换清单清空、脏态基线重记 */
function acceptLightningState(j) {
  const L = S.ls;
  L.spec = j.spec || {}; L.presets = j.presets || []; L.kinds = j.kinds || {};
  L.effects = Array.isArray(j.effects) ? j.effects : []; L.usage = j.usage || {};
  L.path = j.libraryPath || ''; L.err = j.libraryErr || '';
  L.baseLib = j.library ? clone(j.library) : null;
  L.lib = j.library ? clone(j.library) : null;
  L.assign = {};
  L.loaded = true;
  L.clean = lsKey();
}
async function loadLightning() {
  try { acceptLightningState(await API.json('/api/lightning')); }
  catch (e) { S.ls.err = String(e && e.message || e); S.ls.loaded = true; S.ls.clean = lsKey(); }
  refreshDirty();
}
/** 只刷新「每份效果的产物是不是最新」那张表（存了效果之后种子 / 组可能变了），不动草稿 */
async function refreshLightningRows() {
  try {
    const j = await API.json('/api/lightning');
    S.ls.effects = Array.isArray(j.effects) ? j.effects : [];
    S.ls.usage = j.usage || {};
  } catch (e) { /* 表不刷新不拦着干活 */ }
}
/**
 * 「套用」：样式库草稿（带基线）+ 待换清单交给服务端，它存样式库、把受影响的效果全部按样式重新套用并落盘。
 * 当前效果有没存的改动就不做（服务端要重写这份效果文件，页面上的改动会对不上）。完了重开当前效果（盘上那份）并推给游戏。
 */
async function applyLightning() {
  commitFocusedInput();
  const L = S.ls;
  if (!L.lib || L.err) { status(`样式库读不懂，不能套用：${L.err || '还没读到'}`, 'err'); return; }
  if (S.busy) { status('装载中，等一下', 'warn'); return; }
  if (history.inDrag()) { status('手势没松开', 'warn'); return; }
  if (S.docDirty) { status('当前效果有没保存的改动：先 Ctrl+S 再「套用」（套用会重写效果文件）', 'warn'); return; }
  return runIO(async () => {
    setBusy(true, '套用雷电样式…');
    let r = null, err = '';
    try {
      r = await API.post('/api/lightning/apply', { library: L.lib, base: L.baseLib, assign: L.assign || {} });
    } catch (e) { err = String(e && e.message || e); }
    setBusy(false);
    if (err) { status(`没套用：${err}`, 'err'); return; }
    acceptLightningState(r);
    const bad = (r.results || []).filter((x) => !x.ok);
    await refreshEffects();
    const id = S.doc ? S.doc.id : '';
    if (id) await openEffect(id, { force: true, keepScene: true });
    refreshDirty(); renderAll();
    const done = (r.results || []).filter((x) => x.ok).length;
    if (bad.length) status(`套用了 ${done} 个；${bad.length} 个没成：${bad.map((x) => `${x.id}：${x.err}`).join('；')}`, 'err');
    else status(`已套用 ${done} 个效果、存了样式库 ${r.libraryPath || ''}${done ? '（当前这道已推给游戏；同组别的几道游戏里刷新后生效）' : ''}`, 'ok');
  });
}
/**
 * 「把别的层同步给同组」：这份效果样式以外的那几层（落点光团、碎石、水花……）抄给同组其余几份（服务端落盘，
 * 带基线核对）。当前效果有没存的改动就不做（抄的是盘上那份）。
 */
async function syncLightningGroup() {
  commitFocusedInput();
  if (!S.doc || !S.doc.generator || !S.doc.generator.group) { status('这份效果不在雷电样式组里', 'warn'); return; }
  if (S.busy) { status('装载中，等一下', 'warn'); return; }
  if (S.docDirty) { status('当前效果有没保存的改动：先 Ctrl+S 再同步（同步抄的是盘上那份）', 'warn'); return; }
  return runIO(async () => {
    setBusy(true, '同步给同组…');
    let r = null, err = '';
    try { r = await API.post('/api/lightning/sync_group', { effectId: S.doc.id }); }
    catch (e) { err = String(e && e.message || e); }
    setBusy(false);
    if (err) { status(`没同步：${err}`, 'err'); return; }
    acceptLightningState(r);
    await refreshEffects();
    refreshDirty(); renderAll();
    const res = r.results || [], bad = res.filter((x) => !x.ok), changed = res.filter((x) => x.ok && x.changed).length;
    if (bad.length) status(`同步了 ${changed} 份；${bad.length} 份没成：${bad.map((x) => `${x.id}：${x.err}`).join('；')}`, 'err');
    else status(`同组 ${res.length} 份里改了 ${changed} 份（其余本来就一样）`, 'ok');
  });
}

async function newEffect() {
  if (!await resolveDirtyBefore('新建', false)) return;
  const v = await promptDialog('新建效果', 'id（= 文件名）', suggestId('新效果'));
  if (!v) return;
  return runIO(async () => {
    try {
      await API.post('/api/create', { id: v, sceneId: S.scene ? S.scene.id : '', background: S.scene ? S.scene.background : '' });
      await refreshEffects();
      await openEffect(v, { force: true });
    } catch (e) { status(`新建失败：${e && e.message || e}`, 'err'); }
  });
}
async function duplicateEffect() {
  if (!S.doc) return;
  const how = await resolveDirtyBefore('复制', true);
  if (!how) return;
  const v = await promptDialog('复制效果', '新 id', suggestId(S.doc.id + '_2'));
  if (!v) return;
  const src = S.doc.id;
  // 副本默认就是**页面上此刻这份**（与盘上一致时两者相同）；只有作者选了「不保存」才取盘上那份
  const working = how === 'discard' ? null : clone(S.doc);
  return runIO(async () => {
    try {
      await API.post('/api/duplicate', working ? { id: src, to: v, doc: working } : { id: src, to: v });
      await refreshEffects();
      await openEffect(v, { force: true });
    } catch (e) { status(`复制失败：${e && e.message || e}`, 'err'); }
  });
}
/** 改名：服务端**连布置库里引用旧 id 的一起改**（先写库再改名，失败回滚库）。两份都得先存干净——改的是磁盘上那份 */
async function renameEffect() {
  if (!S.doc) return;
  if (S.docDirty || S.libDirty) { status('先保存再改名（改名连布置库一起改磁盘上那份，工作态的改动会对不上）', 'warn'); return; }
  // 布置库之外还按 id 用它（挂件预设 / playVfx）：本台不写那些文件，改名 = 让它们静默指空。服务端也拒，这里先说人话、不弹对话框
  if (S.extRefs.length) {
    status(`改不了名：「${S.doc.id}」还被 ${S.extRefs.length} 处按 id 引用（${extRefsText(S.extRefs)}）——先${extRefsFixHint(S.extRefs)}再来改名`, 'err');
    return;
  }
  const v = await promptDialog('改名', '新 id（布置里引用它的会跟着改）', S.doc.id);
  if (!v || v === S.doc.id) return;
  const old = S.doc.id;
  return runIO(async () => {
    try {
      const r = await API.post('/api/rename', { id: old, to: v });
      if (r.placements) { S.lib = r.placements; markClean('lib'); }
      await refreshEffects();
      await openEffect(v, { resetHistory: true });
      status(`改名「${old}」→「${v}」${r.placementsChanged ? `；布置库里 ${r.placementsChanged} 条跟着改了` : ''}`, 'ok');
    } catch (e) { status(`改名失败：${e && e.message || e}`, 'err'); }
  });
}
/**
 * 删效果：全库有布置引用它 → 列出（场景 · 时段外观 · 实例 id），作者选「连布置一起删」或取消。
 * 服务端再核一次（盘上那份为准），对不上时再问一次。布置库有未保存的改动时先存（删的是磁盘上的布置）。
 */
async function deleteEffect() {
  if (!S.doc) return;
  if (S.libDirty) { status('布置库有未保存的改动：先 Ctrl+S 再删效果（删效果会连带改磁盘上的布置库）', 'warn'); return; }
  const id = S.doc.id;
  const refsText = (refs) => refs.map((r) => `${r.sceneId} · ${phaseLabel(r.sceneId, r.phase)} · ${r.id}`).join('\n');
  // 布置库之外按 id 用它的（挂件预设 / playVfx）：**只列不改**（那些文件归主编辑器），删完它们指空——要作者看着清单明确确认。
  // 原来只看布置库：火把 ember 态的余烟 incense_smoke 没有布置，确认框说"全库没有布置引用它"，删完游戏里再也不冒烟
  const extText = (ext) => (ext.length ? `\n\n还有 ${ext.length} 处按 id 用它（删除不改这些地方，删了它们会指空——${extRefsFixHint(ext)}）：\n${ext.map((r) => (r.kind === 'action' ? r.label : `${r.label}（${r.file}）`)).join('\n')}` : '');
  const ask = (refs, ext) => {
    if (!refs.length && !ext.length) return confirmDialog(`删除「${id}」`, '删了就没了（全库没有布置、也没有挂件预设 / playVfx 引用它）').then((v) => (v ? 'plain' : 'cancel'));
    const head = refs.length ? `全库还有 ${refs.length} 条布置引用它：\n${refsText(refs)}` : '全库没有布置引用它。';
    const go = refs.length ? (ext.length ? '连布置一起删（外部引用照旧指空）' : '连布置一起删') : '仍然删除（引用会指空）';
    return choiceDialog(`删除「${id}」`, head + extText(ext), [['cancel', '取消'], ['with', go]]);
  };
  const choice = await ask(libRefs(id), S.extRefs);
  if (!choice || choice === 'cancel') return;
  return runIO(async () => {
    try {
      // 外部引用只在对话框里列给作者看过才算确认过（页面没列、盘上有 = 服务端回 needConfirm 再问一次）
      let r = await API.post('/api/delete', { id, withPlacements: choice === 'with', confirmExternal: S.extRefs.length > 0 });
      if (r.needConfirm) {
        // 服务端按盘上为准再核一次（主编辑器可能刚存了挂件预设、布置库在盘上与页面不同）：对不上就再问一次
        const again = await ask(r.refs || [], r.externalRefs || []);
        if (again !== 'with' && again !== 'plain') { status('没删', ''); return; }
        r = await API.post('/api/delete', { id, withPlacements: true, confirmExternal: true });
      }
      if (r.placements) { S.lib = r.placements; markClean('lib'); }
      await refreshEffects();
      if (S.effects.length) await openEffect(S.effects[0].id, { force: true, resetHistory: true });
      else {
        // 最后一份也删了：撤销栈里还拿着它，Ctrl+Z 再 Ctrl+S 会把刚删的文件写回来
        S.doc = null; history.clear(); markClean('doc'); rebuildSim(); renderAll(); schedulePublish();
      }
      status(`已删「${id}」${r.placementsRemoved ? `，连带删了 ${r.placementsRemoved} 条布置` : ''}`, 'ok');
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
    // Esc = 取消（与点「取消」同值：prompt 回 ''，confirm 回 false，多选一回 null）
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      // 对话框里的下拉列表开着：Esc 只关列表（原来整个对话框被取消、列表还飘在页面上）
      if (window.Dropdown && Dropdown.isOpen()) { Dropdown.close(); return; }
      const inp = form.querySelector('input[type=text]');
      done(inp ? '' : form.querySelector('[data-choice]') ? null : false);
    };
    const done = (v) => { window.removeEventListener('keydown', onEsc, true); if (window.Dropdown) Dropdown.close(); el('dialog').hidden = true; form.textContent = ''; resolve(v); };
    build(form, done);
    el('dialog').hidden = false;
    window.addEventListener('keydown', onEsc, true);
    // 输入框优先拿焦点并全选（改名 / 新 id 直接打字就是替换）；没有输入框就落在第一个按钮（「取消」）上——
    // 删除之类的确认框里手滑按一下 Enter 不许就删了
    const inp0 = form.querySelector('input[type=text]');
    const first = inp0 || form.querySelector('button');
    if (first) { first.focus(); if (inp0) inp0.select(); }
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
/** 多选一（`choices = [[value, 文字], …]`，最后一个是主按钮）；Enter = 主按钮 */
function choiceDialog(title, msg, choices) {
  return dialog((form, done) => {
    const btns = h('div', { class: 'btns' });
    choices.forEach(([v, text], i) => btns.appendChild(h('button', { type: 'button', class: i === choices.length - 1 ? 'primary' : '', 'data-choice': v, onclick: () => done(v) }, text)));
    form.append(h('h3', {}, title), h('p', { style: 'white-space:pre-line' }, msg), btns);
  }).then((v) => (v === true ? choices[choices.length - 1][0] : v));
}

// ---------------------------------------------------------------------------
// 联动
// ---------------------------------------------------------------------------
function schedulePublish() {
  if (!S.link.on || S.link.discarded) return;
  if (pubTimer) clearTimeout(pubTimer);
  pubTimer = setTimeout(() => { pubTimer = 0; void publishNow(null); }, PUBLISH_DEBOUNCE_MS);
}
/** 在飞的几发（关窗「不保存」要等它们落地再推盘上那份，否则后到的工作态把盘上那份盖掉）。
 *  ⚠ 平常的发布不串行：游戏没开时每一发要等连接被拒（Windows 上近 1 s），串起来就一路排队，连上后的补推被堵在后面 */
const pubInflight = new Set();
/**
 * 推给游戏：工作态效果 + 实际编辑的场景 × 外观（未发送的份继续读盘，[] 明确清空该份）
 * + 此刻展开的场景 × 时段外观（只作诊断）。`phaseReq = {timePhase}` = 「让游戏切到这个时段」（序号服务端发）。
 * 库读不懂时不推库——推一份空库过去等于把游戏里所有布置清掉。
 */
async function publishNow(probe, phaseReq) {
  if (!S.link.on || !S.doc || S.link.discarded) return null;
  const body = { effectId: S.doc.id, def: S.doc, sceneId: S.scene ? S.scene.id : '' };
  if (S.lib && !S.libErr) body.placements = { mode: 'scoped', library: changedPlacementLibrary(), sceneId: S.scene ? S.scene.id : '', phase: S.phase };
  if (probe) body.probe = probe;
  if (phaseReq) body.phaseRequest = phaseReq;
  return postPublish(body);
}
/** 发一份联动文档并把回包记进链路状态（工作态那一发与关窗「不保存」推盘上那份共用） */
function postPublish(body) {
  const run = async () => {
    let r = null;
    try {
      // 不走 API.post：它在 ok:false 时直接抛，回包里的 placementsErr（布置库没过闸门）就跟着丢了——
      // 游戏没开时照样要告诉作者"你的库形状不对"
      const resp = await fetch('/api/link/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
      try { r = await resp.json(); } catch (e) { throw new Error(`/api/link/publish: 非 JSON 响应 (${resp.status})`); }
      // 只有真送到了才算推过（保活 / 连上补推都按它算）；连不上 dev server 不是"被拒"——游戏没开是常态，
      // 不许挂一条红字"游戏没收到：目标计算机积极拒绝"，也不许因此把保活推迟三分钟
      if (r.ok) S.link.lastPub = Date.now();
      S.link.pending = !r.ok && r.connected === false;
      // 效果此刻过不了形状闸门（改到一半）：服务端推的是上一份合法的、布置照推，这是黄字提示不是"游戏没收到"
      S.link.rejected = r.ok || r.connected === false || r.skipped ? '' : (r.err || '游戏没收到这份');
      S.link.placementsErr = r.placementsErr || '';
      S.link.defErr = r.defErr || '';
    } catch (e) {
      S.link.rejected = String(e && e.message || e);
      r = { ok: false, err: S.link.rejected };
    }
    renderLinkChip();
    return r;
  };
  const p = run();
  pubInflight.add(p);
  p.finally(() => pubInflight.delete(p));
  return p;
}
/**
 * 关窗 / 刷新时作者选了「不保存」（桌面壳 `_guard_unsaved` 先调它、最多等 2 s）：把**盘上那份**效果与布置库推给游戏，
 * 让游戏丢掉刚被丢弃的工作态覆盖；之后这页一发工作态都不再推。不改 `S`（页面马上就关 / 重载）。
 * 原来这个钩子没挂：游戏里的预览覆盖一直留着丢弃掉的改动，5 分钟内刷新游戏页还会被槽里那份再套一次——
 * 作者对着一份盘上没有、工作台里也没有的内容试玩。
 */
async function discardLiveWorkingCopy() {
  // 看的是**推过没有**，不是此刻勾没勾「联动」：联动开着改了一通（每一发都进了游戏与槽）、再去勾关掉、关窗选「不保存」，
  // 原来直接返回——游戏整个会话都挂着丢掉的工作态，5 分钟内刷新游戏页还会被槽里那份再套一次。`lastPub` 只在真送到时才记
  if (!S.doc || (!S.link.on && !S.link.lastPub)) return null;
  S.link.discarded = true;
  if (pubTimer) { clearTimeout(pubTimer); pubTimer = 0; }
  const id = S.doc.id;
  await Promise.allSettled([...pubInflight]);
  const [eff, lib] = await Promise.all([
    API.json(`/api/effect?id=${encodeURIComponent(id)}`).catch(() => null),
    API.json('/api/placements').catch(() => null),
  ]);
  if (!eff || !eff.doc) return null;                   // 盘上没有这份（被别处删了）：没有可推的"盘上那份"
  const body = { effectId: id, def: eff.doc, sceneId: S.scene ? S.scene.id : '' };
  // 盘上的库读不懂就不推库（推空库 = 清掉游戏里所有布置）；形状不对服务端也会拦下、效果照推
  if (lib && lib.doc) body.placements = { mode: 'scoped', library: { scenes: {} }, sceneId: S.scene ? S.scene.id : '', phase: S.phase };
  return postPublish(body);
}
/** 游戏此刻是不是已经在显示工作台这一份（同场景同一套时段外观）：是就不用切，更不许让它推进一整天 */
function gameShowsThisAppearance() {
  const st = S.link.status, d = st && st.connected && st.gameAlive ? st.doc : null;
  return !!(d && S.scene && d.sceneId === S.scene.id && d.appearancePhase != null && d.appearancePhase === S.phase);
}
/** 「让游戏切到这个时段」：发当前时段外观对应的真实时段（base = 没单列外观的第一个时段，优先白天） */
async function requestGamePhase() {
  const info = S.scene ? phaseInfo(S.scene.id, S.phase) : null;
  if (!info || !info.timePhase) { status('这套外观没有对应的时段可切（场景没开日夜，或每个时段都单列了外观）', 'warn'); return null; }
  if (!S.link.on) { status('联动关着：先勾上顶栏「联动」', 'warn'); return null; }
  if (!S.doc) { status('还没打开效果（联动文档要带着效果）', 'warn'); return null; }
  // 游戏已经是这套外观：基底覆盖好几个时段（辰 / 午 / 暮），游戏在午、按钮发「辰」= 游戏往前走过午夜，
  // 日结、天数加一、延时事件全跑一遍——作者只是想看看基底的布置
  if (gameShowsThisAppearance()) {
    status(`游戏已经是这套外观（时段 ${S.link.status.doc.timePhase || '?'} · ${info.label}），不用切`, 'ok');
    renderPhaseButton();
    return null;
  }
  const st = S.link.status;
  if (!(st && st.connected && st.gameAlive)) {
    // 游戏页没在跑：发出去也白发——新开的游戏页第一次拉取只记下序号不执行，连上补推又是同一个序号。
    // 记着，游戏页起来后带新序号补发（`handleLinkStatus`）
    S.link.pendingPhase = { sceneId: S.scene.id, phase: S.phase, timePhase: info.timePhase, label: info.label };
    status(`游戏页没在跑：记下了，游戏页开了之后会自动切到时段「${info.timePhase}」（${info.label}）`, 'warn');
    return { ok: false, pending: true };
  }
  if (st.doc && st.doc.sceneId !== S.scene.id) {
    // 游戏在**别的场景**：游戏侧按它**当前场景**判"外观变没变"——那个场景没有「夜」外观时两个时段都解析成基底，
    // 不推进时间却回"已切"，工作台还报成功；作者再拉起游戏进本场景，还是白天，调的夜里布置一个都看不见。
    // 记下、先让游戏切到本场景，进来了（`handleLinkStatus`）再按本场景判一次、需要才发
    const pend = { sceneId: S.scene.id, phase: S.phase, timePhase: info.timePhase, label: info.label };
    S.link.pendingPhase = pend;
    const lr = await launchForPhase(pend, String(st.doc.sceneId || '?'));
    renderPhaseButton();
    return { ok: false, pending: true, launch: lr };
  }
  S.link.pendingPhase = null;
  const r = await publishNow(null, { timePhase: info.timePhase });
  if (r && r.ok) status(`已让游戏（在「${S.scene.id}」）切到时段「${info.timePhase}」（${info.label}）——游戏轮询到就切`, 'ok');
  else status(`没发出去：${(r && r.err) || '联动失败'}`, 'err');
  return r;
}
/** 为一次记下的切时段请求让游戏切到那个场景（`/api/link/launch`：游戏在跑 = 切场景）。失败 = 请求作废并说原因 */
async function launchForPhase(pend, gameScene) {
  pend.launchedAt = Date.now();
  try {
    const r = await API.post('/api/link/launch', { sceneId: pend.sceneId });
    if (S.link.pendingPhase === pend) {
      status(`游戏在「${gameScene}」：已让它切到「${pend.sceneId}」，进了本场景再切到时段「${pend.timePhase}」（${pend.label}）`, 'warn');
    }
    return r;
  } catch (e) {
    const err = String(e && e.message || e);
    if (S.link.pendingPhase === pend) {
      S.link.pendingPhase = null;
      status(`游戏在「${gameScene}」，切不到「${pend.sceneId}」：${err}（切时段请求没发）`, 'err');
    }
    return { ok: false, err };
  }
}
/**
 * 游戏页在跑时处理记下的切时段请求（每份回传都来一次）。只在游戏**已经在请求的那个场景**里才按那个场景判、需要才发；
 * 在别的场景 = 让它切过来（只发一次），超时作废。返回这一拍有没有推过一发（推过就不用再补推工作态）。
 */
function settlePendingPhase(pend, r) {
  const gameScene = String(r.doc.sceneId || '');
  if (!S.scene || S.scene.id !== pend.sceneId || S.phase !== pend.phase) {
    S.link.pendingPhase = null;
    status(`之前记下的「切到时段 ${pend.timePhase}」没发：你已经换到了别的场景 / 外观`, 'warn');
    return false;
  }
  if (gameScene === pend.sceneId) {
    S.link.pendingPhase = null;
    // 进来之后再核一次：本场景已经是这套外观就不发（基底覆盖好几个时段，发了 = 白推进一整天）
    if (gameShowsThisAppearance()) { status(`游戏在「${gameScene}」，已经是这套外观（${pend.label}），不用切`, 'ok'); return false; }
    void publishNow(null, { timePhase: pend.timePhase }).then((res) => {
      if (res && res.ok) status(`游戏在「${gameScene}」：已让它切到时段「${pend.timePhase}」（${pend.label}）`, 'ok');
      else status(`没发出去：${(res && res.err) || '联动失败'}`, 'err');
    });
    return true;
  }
  if (!pend.launchedAt) { void launchForPhase(pend, gameScene || '?'); return false; }
  if (Date.now() - pend.launchedAt > PHASE_SWITCH_WAIT_MS) {
    S.link.pendingPhase = null;
    status(`游戏还在「${gameScene || '?'}」，${Math.round(PHASE_SWITCH_WAIT_MS / 1000)} 秒没进「${pend.sceneId}」：切时段请求作废（游戏进了本场景再点一次）`, 'warn');
  }
  return false;
}
async function pollLink() {
  if (!S.link.on) { renderLinkChip(); return; }
  let r;
  try {
    r = await API.json('/api/link/status');
  } catch (e) {
    r = { ok: false, connected: false, err: String(e && e.message || e) };
  }
  handleLinkStatus(r);
}
/** 收一份游戏回传的状态（轮询与自检共用这一条） */
function handleLinkStatus(r) {
  const prev = S.link.status;
  S.link.status = r;
  if (r.gameUrl !== undefined) {
    S.link.gameUrl = r.gameUrl || '';
    if (!el('gameUrl').matches(':focus')) el('gameUrl').value = S.link.gameUrl;
  }
  if (r.connected) {
    // 游戏页刚起来 / 刚刷新（bootId 换了）：马上把工作态推过去——先调参再「拉起游戏」时，
    // 原来要等三分钟保活或下一次编辑，这段时间游戏里显示的是盘上那份
    const bootOf = (st) => (st && st.connected && st.gameAlive && st.doc ? String(st.doc.bootId || st.doc.writer || '') : '');
    const cameUp = r.gameAlive && bootOf(r) !== bootOf(prev);
    const pend = S.link.pendingPhase;
    // 记下的切时段请求（游戏页没开时点的 / 游戏在别的场景时点的）：游戏页起来或切进那个场景时发，这一发带**新序号**，游戏会执行
    const pushed = pend && r.gameAlive && r.doc ? settlePendingPhase(pend, r) : false;
    if (!pushed && (cameUp || Date.now() - S.link.lastPub > PUBLISH_KEEPALIVE_MS)) void publishNow(null);
  }
  renderLinkChip(); renderGamePanel(); renderPhaseButton();
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function draw() { if (S.view === 3 && v3 && v3.ok) v3.draw(); else if (v2) v2.draw(); }
function renderAll() { renderLeft(); renderInspector(); renderDocState(); renderSimBar(); draw(); }
/**
 * 重建检视器。焦点在检视器的输入框里时（改完一个数按 Tab 去下一格：`change` 在失焦那一刻触发 → 重建）
 * 推到下一拍再建，建完把焦点放回**同一个位置**的控件上——同步重建会把正要获得焦点的下一格一起删掉，
 * 焦点掉回页面，Tab 走不下去。右栏滚动位置一并保住。
 */
let inspectorTimer = 0;
/** 正在派发一个从检视器里冒出来的 `change`：⚠ Chromium 派发它时已经把焦点元素清空了（activeElement 是 body），
 *  只看焦点判不出"作者正在从一格 Tab 到下一格" */
let inspectorChanging = false;
/**
 * 鼠标还压着的元素在不在这个容器里。**松开之前不许把它从 DOM 里拆掉**：在检视器里改了数没按回车、直接去点左栏一行 /
 * 检视器里的按钮 / 折叠标题，mousedown 让输入框失焦 → `change` → edit → 重建，按下的那个节点没了，Chromium 就不发 click——
 * 值提交了，但行没选上、按钮没反应、折叠没展开，作者得再点一次还不知道为什么。拆 DOM 推到松开之后（`flushPressRenders`）。
 */
function pressedIn(container) {
  const t = S.pressTarget;
  return !!(t && container && t !== container && container.contains(t));
}
function flushPressRenders() {
  if (S.pressTarget) return;
  if (S.pendingLeft) renderLeft();
  if (S.pendingInspector) renderInspector();
}
/** 页内下拉列表开着、而且它属于这个容器里的某个 `<select>` */
function dropdownOpenIn(container) {
  return !!(window.Dropdown && Dropdown.isOpen() && container && container.contains(Dropdown.ownerOf()));
}
function renderInspector() {
  const box = el('inspector');
  if (pressedIn(box)) { S.pendingInspector = true; return; }
  // 检视器里某个下拉的列表开着：不许拆它的 <select>。原来在 id 框里改了名没回车、直接点「自动开」：mousedown 让 id 框失焦 → 改名 →
  // 松开鼠标补重建，列表还挂在被拆掉的旧 select 上，选中发给孤儿节点——拿旧 id 找行静默什么都不做；别的下拉则 change 冒不到
  // document，焦点不放，重建又把焦点放回新 select，接着按方向键改的是下拉框。列表一关（ddclose）就补上
  if (dropdownOpenIn(box)) { S.pendingInspector = true; return; }
  S.pendingInspector = false;
  const ae = document.activeElement;
  if (inspectorChanging || (ae && box.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName))) {
    if (!inspectorTimer) inspectorTimer = setTimeout(() => { inspectorTimer = 0; rebuildInspector(); }, 0);
    return;
  }
  if (inspectorTimer) { clearTimeout(inspectorTimer); inspectorTimer = 0; }
  rebuildInspector();
}
function rebuildInspector() {
  inspectorChanging = false;
  const box = el('inspector'), side = el('side');
  const focusables = () => [...box.querySelectorAll('input, select, textarea, button')];
  const ae = document.activeElement;
  const idx = ae && box.contains(ae) ? focusables().indexOf(ae) : -1;
  const kind = idx >= 0 ? `${ae.tagName}:${ae.type || ''}` : '';
  const fkey = idx >= 0 ? (ae.dataset.key || '') : '';
  const scroll = side.scrollTop;
  Inspector.render(host, box);
  side.scrollTop = scroll;
  if (idx >= 0) {
    // 按**身份键**放回同一个参数（Inspector.stampKeys）；只有旧控件没有键时才退回按位置。新的检视器里没这个键（那一行没了）
    // 就不放——原来只按位置：提交让上面多出 / 少了几行，焦点落到别的参数上，接着打的数写进了别人、状态栏还说"改湍流尺度"
    const n = fkey ? focusables().find((x) => x.dataset.key === fkey) : focusables()[idx];
    if (n && `${n.tagName}:${n.type || ''}` === kind) {
      n.focus();
      if (n.tagName === 'INPUT' && (n.type === 'text' || n.type === 'number') && typeof n.select === 'function') n.select();
    }
  }
}
function renderDocState() {
  el('docState').textContent = (S.doc ? `${S.doc.id}${S.docDirty ? ' ●未保存' : ''}` : '（没打开效果）')
    + (S.libErr ? ' · ⚠ 布置库读不懂（只读）' : S.libDirty ? ' · 布置库 ●未保存' : '')
    + (S.lsDirty ? ' · 雷电样式 ●未套用（点「生成并套用」）' : '');
  // 保存按钮自己说有没有没存的（原来只有底栏左下角一行小字，改完找不到"存了没"）
  const save = el('btnSave');
  save.classList.toggle('dirty', S.dirty);
  save.textContent = S.dirty ? '保存 ●' : '保存';
  save.title = S.dirty ? `Ctrl+S：存${[S.docDirty ? '效果' : '', S.libDirty ? '布置库' : ''].filter(Boolean).join(' + ')}` : 'Ctrl+S（没有未保存的改动）';
  document.title = `${S.dirty ? '● ' : ''}粒子工作台${S.doc ? ` · ${S.doc.id}` : ''}`;
  el('btnUndo').disabled = !history.canUndo;
  el('btnRedo').disabled = !history.canRedo;
  el('btnUndo').title = history.canUndo ? `撤销：${history.peekUndo()}` : '没有可撤销的';
  el('btnRedo').title = history.canRedo ? `重做：${history.peekRedo()}` : '没有可重做的';
}
/** 薄片（纸钱）此刻的状况：离开面的 / 醒着的（睡着 = 静摩擦 + 附着顶住了风） */
function plateStats() {
  let plates = 0, free = 0, awake = 0;
  if (!S.sim) return { plates, free, awake };
  for (const e of S.sim.emitters) {
    if (!e.plate) continue;
    const p = e.p, arr = e.plate.arr;
    for (let k = 0; k < p.cap; k++) {
      if (!p.alive[k]) continue;
      plates++;
      if (arr.contact[k] === 0) free++;
      if (!arr.sleep[k]) awake++;
    }
  }
  return { plates, free, awake };
}
function renderSimBar() {
  el('btnPlay').textContent = S.playing ? '⏸ 暂停' : '▶ 播放';
  // 有活动布置时种子取布置的（没写 = 按 id 哈希，与游戏同一个函数）：控制条那个只管"没布置时"的预览
  const pl = S.simInput && S.simInput.placement;
  el('seed').disabled = !!pl;
  el('seed').title = pl ? `现在按布置「${pl}」的种子跑（${S.simInput.seed}；在检视器「布置」一节改）` : '同一份定义 + 同一个种子 ⇒ 逐帧相同';
  const info = el('simInfo');
  info.className = 'dim';
  // 状态格一行放不下时省略号截断（index.html `#simInfo`：不许它折行把画布顶得一跳一跳），全文放 title
  if (S.simErr || !S.sim) {
    info.textContent = S.simErr ? `⚠ 跑不起来：${S.simErr}`
      : S.rt ? (S.cal ? '（没有可跑的发射器）' : '这个场景没有深度载荷，跑不了本地预览') : `没有运行时包${S.rtErr ? '：' + S.rtErr : ''}`;
    info.title = info.textContent;
    return;
  }
  const w = S.wind && S.wind.params;
  const ps = plateStats();
  const usesArea = (S.doc.emitters || []).some((e) => e.spawn && e.spawn.shape && e.spawn.shape.kind === 'area');
  let txt = `t=${fmt(S.simTime, 2)}s · ${S.sim.liveCount} 只 · ${S.sim.state} · 帧 ${S.frames}`
    + (S.evCount.hit ? ` · 撞 ${S.evCount.hit}` : '') + (S.evCount.sound ? ` · 声 ${S.evCount.sound}` : '')
    + (S.lastFlock ? ` · ${S.lastFlock}` : '')
    + (w ? ` · 风 ${fmt(w.speed, 0)} wu/s` : ' · 无风');
  if (ps.plates) txt += ` · 薄片 离地 ${ps.free} / 醒 ${ps.awake}`;
  if (S.sim.beams && S.sim.beams.length) {
    txt += ` · 光柱 ${S.sim.beams.length}${S.simTime > 0 ? `（淡入 ${S.sim.beams.map((b) => fmt(b.fade, 2)).join(' / ')}）` : ''}`;
  }
  const planarBeamWarn = !!(S.cal && S.cal.planar && S.sim.beams && S.sim.beams.some((b) => b.def.mode === '3d'));
  const bs = burnStats();
  if (bs.flammable || bs.bound || S.fires.length) txt += ` · 可燃 在烧 ${bs.burning} / 烧没 ${bs.burnt}${S.fires.length ? ` · 调试火焰 ${S.fires.length} 段` : ''}`;
  // 绑了可燃模板却没装上（模板不存在 / 是消耗燃烧 / 读不懂 / 表没读到 / 不是薄片）：运行时静默不可燃，这里必须说出来
  const burnBad = bs.bound ? burnBindingStates().filter((s) => !s.ok) : [];
  if (hasExternalShape(S.doc)) txt += ` · 外部给点=预览用假点 ${EXT_PREVIEW_COUNT} 个（游戏里由燃烧系统给，写盘不带）`;
  const inp = S.simInput;
  if (inp && inp.placement) {
    txt += ` · 布置「${inp.placement}」种子 ${inp.seed}${inp.countScale !== 1 ? ` ×${fmt(inp.countScale, 2)}` : ''}${S.sim.confine ? ' · 限定区域' : ''}`;
    if (usesArea) txt += S.area && S.area.poly ? ` · 区域=布置「${S.area.id}」` : ' · 区域=锚点周围（活动布置没圈发射区域）';
  } else {
    txt += ` · 本场景本时段没有布置这个效果（锚点=预览锚点、无区域）`;
    if (usesArea) txt += ' · 区域=锚点周围';
  }
  // ⚠ 提示排在最前：一行放不下时截掉的是尾巴，警告不许被省略号吃掉
  const warns = [];
  if (attachOn()) {
    const at = attachDef();
    if (attachAnchor()) {
      txt += ` · 锚点=角色挂点（高 ${fmt(attachHeight(), 0)} wu${at.offsetX ? `、偏 ${fmt(at.offsetX, 0)} wu` : ''}）`
        + (S.walk.on ? ' · 角色在走' : '');
    } else {
      warns.push('⚠ 锚点模式=角色挂点，但场上没有角色（按 M 放一个）：暂时落在场景锚点上');
    }
  }
  if (ps.plates && !w) warns.push('本场景无持续风；纸片是否接受局部气流和刺激，见「模拟与外部影响」');
  if (planarBeamWarn) warns.push('⚠ 没有深度载荷：3D 光柱在这里只是平面近似，要摆 3D 光柱去有深度的场景');
  if (burnBad.length) warns.push(`⚠ 可燃薄片不可燃：${burnBad[0].why}${burnBad.length > 1 ? `（另有 ${burnBad.length - 1} 处）` : ''}`);
  if (warns.length) { txt = `${warns.join(' · ')} · ${txt}`; info.className = 'warn'; }
  info.textContent = txt;
  info.title = txt;
}
function renderScenePickers() {
  const sel = el('sceneSel');
  if (sel.childElementCount !== S.scenes.length) {
    sel.textContent = '';
    for (const s of S.scenes) sel.appendChild(h('option', { value: s.id }, `${s.id}${s.depth ? '' : '（无深度）'}`));
  }
  if (S.scene) sel.value = S.scene.id;
  // 时段外观（取代原来按背景图选）：选项文字 = 给人看的名字，值 = 外观键（'' = 基底）
  const ps = el('phaseSel');
  ps.textContent = '';
  const phases = S.scene ? phasesOf(S.scene.id) : [];
  for (const p of phases) ps.appendChild(h('option', { value: p.key, title: `背景 ${p.background}${p.timePhase ? ` · 让游戏切到时段「${p.timePhase}」` : ''}` }, p.label));
  if (S.scene) ps.value = S.phase;
  ps.disabled = phases.length < 2;
  ps.title = phases.length < 2 ? '这个场景只有一套外观（没开日夜 / 没有 timeVariants）' : '时段外观：布置按「场景 × 时段外观」各配各的，互不继承';
  renderPhaseButton();
}
/** 「让游戏切到这个时段」的可用态：没有可切的时段 / 游戏已经在显示这一份（再发 = 白推进一整天）时置灰 */
function renderPhaseButton() {
  const info = S.scene ? phaseInfo(S.scene.id, S.phase) : null;
  const btn = el('btnPhaseRequest');
  const same = gameShowsThisAppearance();
  btn.disabled = !(info && info.timePhase) || same;
  const st = S.link.status, gd = st && st.connected && st.gameAlive && st.doc ? st.doc : null;
  const where = !gd || !S.scene ? '' : gd.sceneId === S.scene.id ? '（游戏就在本场景）' : `（游戏现在在「${gd.sceneId || '?'}」：先让它切到本场景，进来再切时段）`;
  btn.title = !(info && info.timePhase) ? '这套外观没有对应的时段可切（场景没开日夜，或每个时段都单列了外观）'
    : same ? `游戏已经是这套外观（时段 ${S.link.status.doc.timePhase || '?'} · ${info.label}），不用切`
      : `让游戏推进到时段「${info.timePhase}」（${info.label}），好看这一份布置${where}${S.link.pendingPhase ? '（已记下：游戏进了本场景就切）' : ''}`;
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
  if (pressedIn(el('left'))) { S.pendingLeft = true; return; }   // 按住左栏的行 / 按钮时不拆（见 pressedIn）
  S.pendingLeft = false;
  renderAnchorToolTitle();
  const list = el('emList');
  list.textContent = '';
  if (S.doc) {
    const a = effectiveAnchor();
    const att = attachDef();
    // 预览锚点记在别的场景：这里用的是出生点，照样标「默认：出生点」（与 sceneAnchor 同一条判据）
    const explicit = !!(S.doc.authoring && S.doc.authoring.anchor && authoringAnchorHere(S.doc.authoring));
    const onChar = !!attachAnchor();
    const ap = activePlacement();
    list.appendChild(h('div', { class: 'item' + (S.sel.key === 'anchor' ? ' on' : ''), onclick: () => select('anchor') },
      h('span', { class: 'ic' }, att ? '🕯' : '⊕'),
      h('span', { class: 'name' }, att ? (onChar ? '锚点 · 挂在角色挂点' : '锚点 · 挂点模式（场上没角色）')
        : ap ? `布置锚点 · ${ap.id}` : `预览锚点${explicit ? '' : '（默认：出生点）'}`),
      h('span', { class: 'dim' }, att ? `高 ${fmt(attachHeight(), 0)}${att.offsetX ? ` 偏 ${fmt(att.offsetX, 0)}` : ''}`
        : `${fmt(a.x, 0)},${fmt(a.y, 0)}${a.surface === 'shell' ? ' 壳' : ''}`)));
  }
  // 选中的不是发射器（锚点 / 顶点 / 刺激点 / 布置行）时，检视器与 ⧉ / 改名 / ↑ / ↓ / × 仍作用在「当前发射器」上：给它一个次级高亮
  const curEm = currentEmitter();
  const emScoped = !!emitterIdOfKey(S.sel.key);
  for (const em of ((S.doc && S.doc.emitters) || [])) {
    const on = S.sel.key === `emitter:${em.id}` || S.sel.key.endsWith(`:${em.id}`);
    const cur = !on && !emScoped && curEm === em;
    const row = h('div', { class: 'item' + (on ? ' on' : '') + (cur ? ' cur' : ''), 'data-emitter': em.id,
      title: cur ? '当前发射器：右栏检视器与上面 ⧉ / 改名 / ↑ / ↓ / × 作用在它上面' : '', onclick: () => select(`emitter:${em.id}`) },
      h('span', { class: 'ic' }, S.rt?.vfxProgram.resolveEmitterProgram(em).solver === 'flock' ? '🕊' : em.subOnly ? '↳' : '✦'),
      h('span', { class: 'name' }, em.id),
      h('span', { class: 'dim' }, String(em.spawn ? em.spawn.max : 0)));
    list.appendChild(row);
    if (S.rt?.vfxProgram.resolveEmitterProgram(em).solver === 'flock' && em.behavior?.home) {
      for (const [k, lab] of [['nest', '巢半径'], ['range', '活动域'], ['startle', '惊起']]) {
        const key = `${k}:${em.id}`;
        list.appendChild(h('div', { class: 'item sub' + (S.sel.key === key ? ' on' : ''), onclick: () => select(key) },
          h('span', { class: 'ic' }, '◯'), h('span', { class: 'name' }, lab),
          h('span', { class: 'dim' }, fmt(em.behavior.home[{ nest: 'nestRadius', range: 'rangeRadius', startle: 'startleRadius' }[k]], 0))));
      }
    }
  }
  // ---- 光柱（与发射器并列）：选中 = 起点把手；左栏按钮作用在「当前光柱」上
  const bl = el('beamList');
  bl.textContent = '';
  const fb = focusBeam();
  const beamScoped = !!beamKeyOf(S.sel.key);
  for (const b of ((S.doc && S.doc.beams) || [])) {
    const k = beamKeyOf(S.sel.key);
    const on = !!k && k.id === b.id;
    const cur = !on && !beamScoped && fb === b;
    const users = S.doc ? beamRefs(b.id) : [];
    bl.appendChild(h('div', { class: 'item' + (on ? ' on' : '') + (cur ? ' cur' : ''), 'data-beam': b.id,
      title: `${b.mode === '2d' ? '2D 光带（画面坐标）' : '3D 光柱（M-world）'}${users.length ? `；尘埃发射器 ${users.join(' / ')} 用着它` : ''}`,
      onclick: () => select(`beam:${b.id}`) },
    h('span', { class: 'ic' }, b.mode === '2d' ? '▱' : '◭'),
    h('span', { class: 'name' }, b.id),
    h('span', { class: 'dim' }, `${b.mode === '2d' ? '2D' : '3D'}${users.length ? ` · ${users.length} 尘` : ''}`)));
  }
  if (S.doc && !(S.doc.beams || []).length) bl.appendChild(h('div', { class: 'pad dim', style: 'padding:2px 10px' }, '没有光柱（体积光）'));
  for (const id of ['btnDupBeam', 'btnRenameBeam', 'btnUpBeam', 'btnDownBeam', 'btnDelBeam']) el(id).disabled = !fb;
  for (const id of ['btnAddBeam3', 'btnAddBeam2']) el(id).disabled = !S.doc;
  const pl = el('playerRow');
  pl.textContent = '';
  pl.appendChild(h('div', { class: 'item' + (S.sel.key === 'player' ? ' on' : ''), onclick: () => S.player.on && select('player') },
    h('span', { class: 'ic' }, '🚶'), h('span', { class: 'name' }, S.player.on ? `玩家（${fmt(S.player.speed, 0)} wu/s）` : '（没放玩家）'),
    S.player.on ? h('button', { class: 'danger', onclick: (e) => { e.stopPropagation(); clearPlayer(); } }, '×') : null));
  const wk = h('input', { type: 'checkbox' });
  wk.checked = S.walk.on;
  wk.addEventListener('change', () => setWalk(wk.checked));
  pl.appendChild(h('div', { class: 'item sub' }, h('span', { class: 'ic' }, '↔'),
    h('label', { class: 'chk', title: `沿画面横向来回走 ±${WALK_SPAN_WU} wu（挂点模式下就能看"锚点在动、已发射的粒子按「跟着发射点走」留下或跟上"）` },
      wk, `来回走（${WALK_SPEED_WU} wu/s）`)));
  const pr = el('probeList');
  pr.textContent = '';
  S.probes.forEach((p, i) => {
    pr.appendChild(h('div', { class: 'item' + (S.sel.key === `probe:${i}` ? ' on' : ''), onclick: () => select(`probe:${i}`) },
      h('span', { class: 'ic' }, p.field.kind === 'fear' ? '⚡' : p.field.kind === 'attract' ? '✿' : '≋'),
      h('span', { class: 'name' }, `${p.field.kind}:${p.field.tag}`),
      h('button', { onclick: (e) => { e.stopPropagation(); fireField(i); } }, '再发'),
      h('button', { class: 'danger', onclick: (e) => { e.stopPropagation(); removeProbe(i); } }, '×')));
  });
  renderPlacements();
}
/**
 * 左栏「布置 · 场景 · 时段外观」与「这个效果还布置在」。
 * 本份的全部实例都列出来：当前效果的行可选（选中 = 活动布置）；别的效果的行灰显、带「打开这个效果」。
 */
function renderPlacements() {
  const sid = S.scene ? S.scene.id : '';
  el('placeHead').textContent = S.scene ? `布置 · ${S.scene.name || sid} · ${phaseLabel(sid, S.phase)}` : '布置';
  const list = el('placeList');
  list.textContent = '';
  const ap = activePlacement();
  const rows = curRows();
  if (S.libErr) list.appendChild(h('div', { class: 'pad warn', style: 'padding:2px 10px' }, `⚠ 布置库读不懂（只读，绝不覆盖）：${S.libErr}`));
  for (const r of rows) {
    const mine = !!S.doc && r.effect === S.doc.id;
    const on = mine && ap && ap.id === r.id;
    const kids = [h('span', { class: 'ic' }, mine ? '✦' : '·'), h('span', { class: 'name', title: r.id }, r.id), h('span', { class: 'dim' }, r.effect)];
    if (!mine) {
      kids.push(h('button', {
        title: `打开效果「${r.effect}」并选中这条（留在 ${sid} · ${phaseLabel(sid, S.phase)}）`,
        onclick: (e) => { e.stopPropagation(); void openEffect(r.effect, { keepScene: true, placeId: r.id }); },
      }, '打开这个效果'));
    }
    list.appendChild(h('div', {
      class: 'item' + (on ? ' on' : '') + (mine ? '' : ' other'), 'data-place': r.id,
      title: mine ? '选中 = 活动布置（本地预览按它跑、锚点 / 区域改的是它）' : `这条布置的是「${r.effect}」`,
      onclick: () => { if (mine) select(`place:${r.id}`); },
    }, ...kids));
  }
  const others = S.scene ? phasesOf(sid).filter((p) => p.key !== S.phase) : [];
  if (!rows.length) list.appendChild(h('div', { class: 'pad dim', style: 'padding:2px 10px' }, S.scene ? '这一份还没有布置（没配就没有，不继承别的时段）' : '还没装场景'));
  const editable = !!S.scene && !S.libErr;
  el('btnPlaceHere').disabled = !(editable && S.doc);
  for (const id of ['btnPlaceDel', 'btnPlaceUp', 'btnPlaceDown', 'btnPlaceRename']) el(id).disabled = !(editable && ap);
  el('btnPlaceCopy').disabled = !(editable && rows.length && phasesOf(sid).length > 1);
  // ---- 选中的那一条布置在本场景别的时段外观里：比一比，一键拷过去 / 拷过来（只动这一条）
  //      这一份里还没有当前效果的布置时，列出别的时段外观里当前效果的布置，可以逐条拷过来
  const pp = el('placePhases');
  pp.textContent = '';
  if (others.length && S.doc) {
    const here = phaseLabel(sid, S.phase);
    const copyBtn = (act, disabled, title, fn) => h('button', { 'data-act': act, disabled, title, onclick: (e) => { e.stopPropagation(); void fn(); } }, act === 'push' ? '拷过去' : '拷过来');
    // 两行：左栏只有 170–230 px，时段名（「基底（辰时、午时、向晚）」）和状态、按钮挤一行时名字被省略号吃光
    const actLine = (id, stateText, stateCls, ...btns) => h('div', { class: 'act', 'data-copy-id': id },
      h('span', { class: stateCls, 'data-role': 'phaseState' }, stateText), h('div', { class: 'pair' }, ...btns));
    if (ap) {
      pp.appendChild(h('div', { class: 'pad dim', style: 'padding:6px 10px 0', title: '只拷选中的这一条（同 id 原位覆盖 / 没有就加上），别的布置不动；拷完两份各改各的' },
        `「${ap.id}」在别的时段外观`));
      for (const p of others) {
        const t = libRows(sid, p.key).find((r) => r.id === ap.id);
        const foreign = !!t && t.effect !== ap.effect;
        const same = !!t && !foreign && canonJson(t) === canonJson(ap);
        const state = foreign ? `同 id 是别的效果「${t.effect}」` : !t ? '没有这条' : same ? '这条一样' : '这条不一样';
        pp.appendChild(h('div', { class: 'phaseRow', 'data-phase-row': p.key },
          h('div', { class: 'lab' }, h('span', { class: 'ic' }, same ? '＝' : '≠'), h('span', { class: 'name' }, p.label)),
          actLine(ap.id, state, same ? 'dim' : 'warn',
            copyBtn('push', !editable || foreign || same, `把「${here}」的「${ap.id}」拷到「${p.label}」${t ? '（覆盖那边同 id 的这条）' : '（加上这一条）'}，别的布置不动`,
              () => copyPlacementAcrossPhases(ap.id, S.phase, p.key)),
            copyBtn('pull', !editable || !t || foreign || same, `把「${p.label}」的「${ap.id}」拷到正在看的「${here}」（覆盖这边这条），别的布置不动`,
              () => copyPlacementAcrossPhases(ap.id, p.key, S.phase)))));
      }
    } else {
      const blocks = others.map((p) => ({ p, mine: libRows(sid, p.key).filter((r) => r.effect === S.doc.id) })).filter((b) => b.mine.length);
      if (blocks.length) {
        pp.appendChild(h('div', { class: 'pad dim', style: 'padding:6px 10px 0', title: '逐条拷：只拷点的那一条，别的布置不动' },
          `「${S.doc.id}」在别的时段外观的布置`));
        for (const { p, mine } of blocks) {
          const lines = mine.map((r) => {
            const clash = curRows().find((x) => x.id === r.id);
            return actLine(r.id, clash ? `「${r.id}」· 这里同 id 是「${clash.effect}」` : `「${r.id}」`, clash ? 'warn' : 'dim',
              copyBtn('pull', !editable || !!clash, `把「${p.label}」的「${r.id}」拷到正在看的「${here}」，别的布置不动`,
                () => copyPlacementAcrossPhases(r.id, p.key, S.phase)));
          });
          pp.appendChild(h('div', { class: 'phaseRow', 'data-phase-row': p.key },
            h('div', { class: 'lab' }, h('span', { class: 'ic' }, '→'), h('span', { class: 'name' }, p.label)), ...lines));
        }
      }
    }
  }
  // ---- 这个效果还布置在（全库）
  const els = el('placeElsewhere');
  els.textContent = '';
  const refs = S.doc ? libRefs(S.doc.id) : [];
  for (const r of refs) {
    const here = S.scene && r.sceneId === sid && r.phase === S.phase;
    els.appendChild(h('div', {
      class: 'item' + (here && ap && ap.id === r.id ? ' on' : ''), 'data-ref': `${r.sceneId}\n${r.phase}\n${r.id}`,
      title: here ? '就在当前这一份里' : '切到那个场景那套时段外观并选中它',
      onclick: () => { void goPlacement(r.sceneId, r.phase, r.id); },
    }, h('span', { class: 'ic' }, here ? '●' : '→'), h('span', { class: 'name' }, `${r.sceneId} · ${phaseLabel(r.sceneId, r.phase)}`), h('span', { class: 'dim' }, r.id)));
  }
  // 布置库之外按 id 用它的（挂件预设 / playVfx / 可燃物模板的燃烧粒子）：只读列出来（改挂件 / 动作去主编辑器，改模板去燃烧工作台）。
  // 原来这里只看布置库，火把余烟 incense_smoke 没有布置就写"游戏里不会出现"，作者据此删掉了它
  const ext = S.doc ? S.extRefs : [];
  for (const r of ext) {
    els.appendChild(h('div', { class: 'item other', 'data-extref': `${r.file}\n${r.where}`,
      title: r.kind === 'burnable' ? `${r.file}（可燃物模板烧起来发它：在燃烧工作台里打开模板「${r.burnable}」改粒子，工作台只读）` : `${r.file}（这一处归主编辑器改，工作台只读）` },
      h('span', { class: 'ic' }, r.kind === 'prop' ? '◇' : r.kind === 'burnable' ? '◆' : '▶'),
      h('span', { class: 'name' }, r.kind === 'prop' || r.kind === 'burnable' ? r.label : `${r.action || 'playVfx'} · ${r.where}`),
      h('span', { class: 'dim' }, r.file.split('/').pop())));
  }
  if (!refs.length && S.doc) {
    els.appendChild(h('div', { class: 'pad dim', style: 'padding:2px 10px' }, ext.length
      ? `全库都没有布置这个效果；上面 ${ext.length} 处按 id 用它（挂件 / 动作 / 可燃物燃烧时临时生成，不需要布置）`
      : '全库都没有布置这个效果，也没有挂件预设 / playVfx / 可燃物模板用它：游戏里不会出现'));
  }
}
function renderLinkChip() {
  const chip = el('linkChip'), st = S.link.status;
  if (!S.link.on) { chip.textContent = '联动关'; chip.className = 'chip off'; return; }
  if (S.link.rejected) { chip.textContent = `游戏没收到：${S.link.rejected}`; chip.className = 'chip bad'; return; }
  // 形状问题是黄字附注，不是"游戏没收到"：效果改到一半过不了闸门时服务端推的是上一份合法的、布置照推
  const notes = [S.link.defErr, S.link.placementsErr].filter(Boolean).map((x) => `\n⚠ ${x}`).join('');
  if (!st || !st.connected) { chip.textContent = '游戏没开（开了会自动推过去；工作台照常能改能存）' + notes; chip.title = st && st.err ? `连不上 dev server：${st.err}` : ''; chip.className = 'chip ' + (notes ? 'warn' : 'off'); return; }
  chip.title = '';
  if (!st.gameAlive) { chip.textContent = 'dev server 在，游戏页没开（开了会自动推过去）' + notes; chip.className = 'chip warn'; return; }
  const d = st.doc || {};
  const mine = (d.instances || []).length;
  chip.textContent = `游戏在「${d.sceneId || '?'}」· ${mine} 个实例引用「${d.effectId || ''}」· 已套用#${d.appliedRev || 0}` + notes;
  chip.className = 'chip ' + (notes ? 'warn' : d.appliedRev ? 'ok' : 'warn');
}
function renderGamePanel() {
  const p = el('gamePanel'), st = S.link.status;
  p.textContent = '';
  if (!st || !st.connected) { p.appendChild(h('div', { class: 'pad dim' }, '游戏没在跑（工作台照常能改、能存）')); return; }
  const d = st.doc;
  if (!d) { p.appendChild(h('div', { class: 'pad dim' }, 'dev server 在，游戏页没回传')); return; }
  const kv = (k, v) => p.appendChild(h('div', { class: 'kv' }, h('span', {}, k), h('span', {}, String(v))));
  kv('场景', d.sceneId || '?');
  // 时段 / 外观：同场景但游戏用的外观 ≠ 工作台展开的那一份 = 你在调的东西游戏里现在看不见
  if (d.timePhase !== undefined || d.appearancePhase !== undefined) {
    const gameLabel = d.sceneId && d.appearancePhase != null ? phaseLabel(d.sceneId, d.appearancePhase) : '?';
    kv('时段', `时段 ${d.timePhase || '?'} · 外观 ${gameLabel}`);
    if (S.scene && d.sceneId === S.scene.id && d.appearancePhase != null && d.appearancePhase !== S.phase) {
      p.appendChild(h('div', { class: 'pad warn', 'data-role': 'phaseMismatch', style: 'padding:2px 10px' },
        `⚠ 你在调「${phaseLabel(S.scene.id, S.phase)}」，游戏现在是「${gameLabel}」——点顶栏「让游戏切到这个时段」`));
    }
  }
  if (d.placementsApplied) {
    const pa = d.placementsApplied;
    kv('布置', `${pa.sceneId} · ${phaseLabel(pa.sceneId, pa.phase)} · ${pa.preview ? '工作态（工作台推的）' : '盘上那份'}`);
  } else if (d.placementsApplied === null) kv('布置', '（游戏还没建布置表）');
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
/** 焦点停在（收起的）下拉框上时，下拉框自己要的键：方向键逐项切换、Tab / Enter、单独按下的修饰键；
 *  Delete / Backspace 也不放（在下拉框上按删除不该删掉场景里选中的东西） */
const SELECT_OWN_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Enter', 'Shift', 'Control', 'Alt', 'Meta', 'Delete', 'Backspace']);
/** 单独按下不打断键盘微移的键（按住 Shift 再按方向键是 10 wu 一步） */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);
function onKey(e) {
  // 微移中按了别的键（Ctrl+Z / Delete / W …）：先把微移收成一条历史，那个键再照常执行（撤销撤的就是这次微移）
  if (nudge && !/^Arrow/.test(e.key) && !MODIFIER_KEYS.has(e.key)) nudgeEnd();
  if (S.busy) return;                                   // 装载门：这几秒里 doc 与画布本来就不一致
  if (!el('dialog').hidden) return;
  // 下拉框点开又原样关掉 / 选了同一项（不发 change）之后焦点还停在它上面：原来单键快捷键全部让开，
  // 字母还被下拉框拿去做首字母跳转——按 F 想对准，结果换成了 fireflies。方向键照旧留给它逐项切换。
  let released = false;
  if (e.target && e.target.tagName === 'SELECT' && !(window.Dropdown && Dropdown.isOpen()) && !SELECT_OWN_KEYS.has(e.key)) {
    e.preventDefault();
    e.target.blur();
    released = true;
  }
  if (!released && isTypingTarget(e.target)) {
    const kk = e.key.toLowerCase(), t = e.target;
    if ((e.ctrlKey || e.metaKey) && kk === 's') { e.preventDefault(); void saveEffect(); }
    // 检视器里一格**没动过**的输入框（改完上一格按 Tab 过来，重建后焦点落在这里、文字还被选中）：Ctrl+Z / Ctrl+Y 归页面的撤销栈。
    // 原来归浏览器的文字撤销——新建出来的框没有可撤的，按了什么都不发生也不说为什么。动过的框照旧留给文字撤销
    else if ((e.ctrlKey || e.metaKey) && (kk === 'z' || kk === 'y') && t.closest && t.closest('#inspector')
      && t.dataset && t.dataset.v0 !== undefined && t.value === t.dataset.v0) {
      e.preventDefault();
      t.blur();
      if (kk === 'y' || e.shiftKey) doRedo(); else doUndo();
    }
    return;
  }
  if (v3 && v3.capturesKeys()) return;                  // 按住右键飞行：键盘归相机
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); void saveEffect(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
  if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); return; }
  if (e.ctrlKey || e.metaKey) return;
  // 单键快捷键不吃按住的自动重复（方向键微移除外）：松开右键飞行时 A 还按着，重复的 keydown 落到这里切成锚点工具，
  // 下一次左键点选直接把布置锚点改到了点击处；按住 E 同理把 gizmo 切成旋转、按住 Delete 连删一串
  if (e.repeat && !/^Arrow/.test(e.key)) return;
  if (e.key === 'Escape') {
    // 拉区域框拉到一半按 Esc：连在飞的框一起作废（原来只清草稿，鼠标一动草稿又回来、松手照样写进布置）
    cancelAreaDrag();
    // 任何武装着的工具（A / M / K / 拉区域 / H）Esc 都退回选择：原来只退区域工具，A / M / K 没法取消
    if (S.tool !== 'select') setTool('select');
    return;
  }
  if (k === 'v') { setTool('select'); return; }
  if (k === 'a') { setTool('anchor'); return; }
  if (k === 'm') { setTool('player'); return; }
  if (k === 'k') { setTool('field'); return; }
  if (k === 'i') { setTool('fire'); return; }
  if (k === 'h') { setTool('pan'); return; }
  if (k === 'w') { S.gizmoMode = 'move'; draw(); return; }
  if (k === 'e') { S.gizmoMode = 'rotate'; draw(); return; }
  if (k === 'r') { S.gizmoMode = 'scale'; draw(); return; }
  if (k === '1') { setView(3); return; }
  if (k === '2') { setView(2); return; }
  if (k === 'f') { focusSelected(); return; }
  if (e.key === 'Home') { if (S.view === 3 && v3 && v3.ok) v3.fit(false); else if (v2) v2.fit(); return; }
  // 空格：**松开时**才切播放，且按住期间没拖过——空格 + 左键拖是平移，按住的自动重复不许让播放来回翻
  if (e.key === ' ') { e.preventDefault(); if (!e.repeat) S.spaceTap = true; return; }
  if (e.key === '.') { stepSim(1 / 60); draw(); renderSimBar(); return; }
  if (e.key === 'Delete') {
    if (areaKey(S.sel.key)) { void deleteAreaVertexKey(S.sel.key); return; }
    // 选中的是布置（左栏点了一条 = 选中它的锚点）：删这条布置，可撤销
    if (S.sel.key === 'anchor' && activePlacement() && !attachOn()) {
      const id = activePlacement().id;
      void delPlacement().then((done) => { if (done) status(`删了布置「${id}」（Ctrl+Z 撤销）`, 'warn'); });
      return;
    }
    const pm = /^probe:(\d+)$/.exec(S.sel.key);
    if (pm) { removeProbe(+pm[1]); return; }
    if (S.sel.key === 'player') { clearPlayer(); return; }
    const em = /^emitter:(.+)$/.exec(S.sel.key);
    if (em) { delEmitter(em[1]); return; }
    const bk = beamKeyOf(S.sel.key);
    if (bk) { delBeam(bk.id); return; }
    return;
  }
  const step = e.shiftKey ? 10 : 1;
  const arrow = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
  if (arrow && nudgeSelected(arrow[0], 0, arrow[1])) {
    // 真微移了才吞掉：否则 Chromium 顺手按键盘滚动最后点过的那个面板（左栏行 / 右栏标题），看着的面板一路滚走
    e.preventDefault();
    if (nudge) nudgeKeys.add(e.key);                      // 只记合成手势那一路的键（玩家 / 刺激点不起手势）
  }
}
function doUndo() { const at = placeSlot(), av = areaSelSlot(); const l = history.undo(); if (l) { followPlace(at); followAreaSel(av); touchDoc(); rebuildSim(); refreshDirty(); renderAll(); schedulePublish(); status(`撤销：${l}`); } return l; }
function doRedo() { const at = placeSlot(), av = areaSelSlot(); const l = history.redo(); if (l) { followPlace(at); followAreaSel(av); touchDoc(); rebuildSim(); refreshDirty(); renderAll(); schedulePublish(); status(`重做：${l}`); } return l; }
/** 选中的区域顶点（撤销 / 重做前记下：哪一块、第几个、画面点、那一块几个点；没选顶点 = null） */
function areaSelSlot() {
  const ak = areaKey(S.sel.key);
  return ak ? { role: ak.role, i: ak.i, pt: ak.pt.slice(), n: ak.poly.length } : null;
}
/**
 * 撤销 / 重做之后把顶点选中跟到**同一个点**上：那一块点数没变（撤的是拖顶点 / 别的参数）= 下标照旧；
 * 点数变了（撤的是加点 / 删点）= 按画面点找回那个点，找不到（撤掉的正是它）就放掉选中。
 * 原来下标原样留着：双击插点再 Ctrl+Z，选中落到了原来的下一个点上，接着拖 / 按 Delete 动的是作者没选过的点。
 */
function followAreaSel(av) {
  if (!av || !/^area:/.test(S.sel.key)) return;          // followPlace 已经因为那条布置没了放掉了选中
  const poly = areaPoly(activePlacement(), av.role);
  if (!poly) { S.sel.key = ''; return; }
  if (poly.length === av.n && av.i < poly.length) { S.sel.key = `area:${av.role}:${av.i}`; return; }
  const j = poly.findIndex((q) => q[0] === av.pt[0] && q[1] === av.pt[1]);
  S.sel.key = j >= 0 ? `area:${av.role}:${j}` : '';
}
/** 活动布置在本份里本效果那几行中的位置（撤销 / 重做前记下；没选过 = null） */
function placeSlot() {
  if (!S.placeId || !S.doc) return null;
  const i = curRows().filter((r) => r.effect === S.doc.id).findIndex((r) => r.id === S.placeId);
  return i >= 0 ? { i, id: S.placeId } : null;
}
/**
 * 撤销 / 重做之后选中的布置 id 不在了（撤的是改名）：跟到**同一位置**那一行上（改名不挪位置），那一行也没有了
 * （撤的是「布置到这里」）就放掉选中。原来 S.placeId 原样留着一个不存在的 id，活动布置静默退回第一条——
 * 检视器、gizmo、「删」按钮全换成了第一条，接着按 Delete 删掉的是另一条布置。
 */
function followPlace(at) {
  if (!at || !S.doc) return;
  const mine = curRows().filter((r) => r.effect === S.doc.id);
  if (mine.some((r) => r.id === S.placeId)) return;
  const row = mine[at.i];
  if (row) {
    const k0 = stashKey(at.id), k1 = stashKey(row.id);
    if (S.confineStash[k0] && !S.confineStash[k1]) { S.confineStash[k1] = S.confineStash[k0]; delete S.confineStash[k0]; }
    S.placeId = row.id;
  } else {
    S.placeId = '';
    if (S.sel.key === 'anchor' || /^area:(emit|range):/.test(S.sel.key)) S.sel.key = '';
  }
}
/** 作废在飞的拉区域框（两个视图的手势 + 草稿）：Esc 用；松手时 `_up` 也只在还是区域工具时才提交 */
function cancelAreaDrag() {
  let had = !!S.areaDraft;
  if (v3 && v3.drag && v3.drag.kind === 'area') { v3.drag = null; had = true; }
  if (v2 && v2.drag && v2.drag.kind === 'area') { v2.drag = null; had = true; }
  S.areaDraft = null;
  if (had) { status('拉区域取消了', ''); draw(); }
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
  get programApi() { return S.rt && S.rt.vfxProgram; },
  get doc() { return S.doc; },
  get cal() { return S.cal; },
  get scene() { return S.scene; },
  get marks() { return S.marks; },
  get sel() { return S.sel; },
  get tool() { return S.tool; },
  get gizmoMode() { return S.gizmoMode; },
  get layers() { return S.layers; },
  get sources() { return S.sources; },
  /** 动画包的状态名（`/api/anims` 带来的）；不认识的包 = 空表（检视器的下拉照样保值显示当前值） */
  animStates: (path) => ((S.sources.animStates || {})[path] || []),
  get sfx() { return S.sfx; },
  /** 效果目录（`/api/effects`） */
  get effects() { return S.effects; },
  /** 可燃物模板表（`/api/burnables` + 运行时清洗结果）：检视器「可燃模板」选择器的候选与只读参数 */
  get burn() { return S.burn; },
  burnTemplateStatus, openBurnWorkbench,
  get player() { return S.player; },
  get walk() { return S.walk; },
  get attach() { return attachDef(); },
  get phase() { return S.phase; },
  get libErr() { return S.libErr; },
  get confineStash() { return S.confineStash; },
  activePlacement, curRows, phaseLabel, phaseInfo, stashKey, areaPoly, authoringAnchorHere, sceneAnchor, hashSeedOf: (id) => (S.rt && S.rt.vfxRandom ? S.rt.vfxRandom.hashSeed(id) : null),
  placeHere, editPlacement, renamePlacement, setConfine, clearArea,
  areaToolBegin, setAreaDraft, commitAreaDraft, areaEdgeHit, insertAreaVertex, deleteAreaVertexKey,
  areaShapes, areaLines3, areaPointWorld,
  areaToolRole: (t) => AREA_TOOL_ROLE[t] || null,
  roleCss: (role, a) => { const c = roleRgb(role); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; },
  sceneSurfaces: () => sceneSurfaces(), surfaceDefaults: SURFACE_DEFAULTS, surfaceLabel: SURF_LABEL,
  get surfEdit() { return S.surfEdit; }, setSurfEdit,
  deleteSurface, setSurfaceField, renameSurface, setDefaultSurfaceField,
  get defaultSurface() { return (S.lib && S.lib.defaultSurface) || {}; },
  selectSurface: (ri) => { if (sceneSurfaces()[ri]) { if (!S.surfEdit) S.surfEdit = true; select(`area:s${ri}:0`); } },
  status, select, setTool, edit, dragBegin, dragTick, dragEnd,
  objects, spheres, particlePoints, fieldMarks, anchorWorld, bodyLines, previewMarks, addFireAt,
  gizmoPivot, gizmoBase, applyGizmo, gizmoLabel, dragObjectTo, dragObjectToScene, dragObjectByScene, nudgeSelected,
  radiusSelected: () => !!(S.doc && radiusOf(S.sel.key)), setRadiusValue,
  setAnchorAt, setAnchorScene, setPlayerAt, addFieldAt,
  setAttachMode, ensureAttach, setWalk,
  currentEmitter, renameEmitter, ensureAuthoring, ensureAnchor, reanchor,
  currentBeam, renameBeam, beamRefs, beamLines3, drawBeams2d,
  beamApi: () => (S.rt && S.rt.vfxBeam) || null,
  onCursorWorld, onCursorScene, renderInspector,
  get ls() { return S.ls; },
  get lightningDirty() { return S.lsDirty; },
  get docDirty() { return S.docDirty; },
  applyLightning: () => applyLightning(),
  syncLightningGroup: () => syncLightningGroup(),
};

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function boot() {
  // 复合快照：一次撤销同时回滚效果 doc 与布置库（拖一个区域顶点与改一个发射参数是同一条历史栈）
  history = new History({
    // 雷电样式的草稿与待换清单也在快照里：改参数 / 换样式可以 Ctrl+Z（落盘另走「生成并套用」）
    get: () => ({ doc: S.doc, lib: S.lib, ls: { lib: S.ls.lib, assign: S.ls.assign } }),
    set: (v) => { S.doc = v.doc; S.lib = v.lib; if (v.ls) { S.ls.lib = v.ls.lib; S.ls.assign = v.ls.assign || {}; } },
    onChange: () => renderDocState(),
  });
  v3 = new View3D(el('view3d'), el('overlay3d'), host);
  v2 = new View2D(el('view2d'), host);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', (e) => {
    if (/^Arrow/.test(e.key)) { nudgeKeys.delete(e.key); if (nudge && !nudgeKeys.size) nudgeEnd(); return; }
    if (e.key !== ' ') return;
    const tap = S.spaceTap; S.spaceTap = false;
    if (tap && !S.busy && el('dialog').hidden && !isTypingTarget(e.target)) setPlaying(!S.playing);
  });
  // 检视器里的 change 派发期间重建一律推到下一拍（见 renderInspector）；window 冒泡阶段是最后一站，在那儿放下标记
  // 只有输入框的 change 伴随着焦点移走（失焦才提交）；下拉框 / 勾选框在选中那一刻就提交，照常同步重建
  el('inspector').addEventListener('change', (e) => { if (isTypingTarget(e.target) && e.target.tagName !== 'SELECT') inspectorChanging = true; }, true);
  window.addEventListener('change', () => { inspectorChanging = false; });
  // Ctrl+滚轮不许缩放整页：Ctrl 是 gizmo 吸附键、右栏又常滚，浏览器的页面缩放一直累加，桌面壳里原来没法复位只能关窗重开。
  // 只拦浏览器的默认缩放，页面自己的滚轮处理（3D / 2D 视图的朝光标缩放）照常收到事件；壳另有 Ctrl+0 兜底复位
  window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  // 按住空格期间按了鼠标 = 空格 + 拖平移，松开空格不再切播放。
  // 同时记下按着的元素：松开前左栏 / 检视器的重建推迟（`pressedIn`），松开后下一拍补上——
  // click 与 mouseup 同一个任务派发，所以 click 的处理先跑、点在原来那个节点上
  window.addEventListener('pointerdown', (e) => { nudgeEnd(); S.spaceTap = false; S.pressTarget = e.target instanceof Node ? e.target : null; }, true);
  // 按鼠标 = 键盘微移结束（视图的 mousedown 马上要起自己的 dragBegin）；合成的 mousedown 不带 pointerdown，两边都接
  window.addEventListener('mousedown', () => nudgeEnd(), true);
  window.addEventListener('blur', () => nudgeEnd());
  const releasePress = () => {
    if (!S.pressTarget) return;
    S.pressTarget = null;
    if (S.pendingLeft || S.pendingInspector) setTimeout(flushPressRenders, 0);
  };
  window.addEventListener('pointerup', releasePress, true);
  window.addEventListener('pointercancel', releasePress, true);
  window.addEventListener('blur', releasePress);
  // 勾选框用完就把焦点还回去：焦点停在它上面时 Space 会再勾一次，作者勾一下图层之后空格播放就变成了切图层。
  // ⚠ 下拉框**不在这里**失焦：方向键逐项切换每一步都发 change，第一步就失焦的话第二下方向键落到页面上变成「微移」选中物。
  //   下拉框的焦点在 onKey 里按键放（SELECT_OWN_KEYS 之外的键）
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !el('dialog').hidden) return;
    // 鼠标在页内下拉列表里选的（Dropdown.pick 发的是合成的 change，isTrusted = false）也放掉焦点：
    // 否则检视器重建把焦点放回这个下拉框，接着按方向键想微移选中物，改的却是这个下拉框的值。
    // 键盘方向键逐项切换发的是真 change（isTrusted），焦点留着，连按照旧逐项走
    const mousePick = t.tagName === 'SELECT' && !e.isTrusted;
    if (mousePick || (t.tagName === 'INPUT' && (t.type === 'checkbox' || t.type === 'radio'))) setTimeout(() => { if (document.activeElement === t) t.blur(); }, 0);
  }, true);
  // 输入框里按 Enter = 提交并离开这一格（检视器、预览条的种子 / 倍速 / 刺激参数都算；对话框里的 Enter 仍是确定）：
  // 原来 Enter 发了 change 焦点却留在框里（检视器重建后还被选中），Ctrl+Z / 空格 / W/E/R / Delete 全被输入框吃掉
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.key === 'Enter' && t && t.tagName === 'INPUT' && (t.type === 'text' || t.type === 'number') && !el('dialogForm').contains(t)) t.blur();
  });
  window.addEventListener('resize', () => { if (v3 && v3.ok) v3.resize(); if (v2) v2.resize(); });
  // 画布所在格子自己变了大小（窗口没变）：顶栏下拉框填上选项变宽、链路芯片多出「⚠」行、预览条折行，#top / #simbar 长高、
  // #center 变矮——原来只接 window resize，画布缓冲区还是开页那一刻的尺寸被拉伸着画：2D 点顶点差出二十几 px（容差 10 px）、
  // 3D 的 gizmo 与标签画的地方不是拾取认的地方。只调看得见的那个视图（藏着的 2D 按 0×0 算会被缩成 1×1，切过去时 setView 再调）
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { if (S.view === 3 && v3 && v3.ok) v3.resize(); else if (v2) v2.resize(); }).observe(el('center'));
  }
  // 页内下拉列表关了：列表开着期间推迟的检视器重建补上（下一拍——pick 里先关列表、后发 change，得等 change 处理完）
  document.addEventListener('ddclose', () => { if (S.pendingInspector || S.pendingLeft) setTimeout(flushPressRenders, 0); });
  document.addEventListener('ddstale', () => status('下拉框在列表开着时被重建了，这一下没选上：再点开选一次', 'warn'));
  bindUI();
  setTool('select');
  setView(v3 && v3.ok ? 3 : 2);
  await loadRuntime();
  let boot0 = {};
  try { boot0 = await API.json('/api/boot'); } catch (e) { /* 服务刚起：下面照常 */ }
  if (boot0.bundle && !boot0.bundle.ok && boot0.bundle.err) S.rtErr = boot0.bundle.err;
  try { const j = await API.json('/api/scenes'); S.scenes = j.scenes || []; } catch (e) { S.scenes = []; }
  try {
    // 动画包带着它的状态名（「状态 / 栖息状态」下拉的候选）；老形状（纯路径串）照收
    const j = await API.json('/api/anims');
    const rows = (j.anims || []).map((a) => (typeof a === 'string' ? { path: a, states: [] } : a));
    S.sources = { anims: rows.map((a) => a.path), images: j.images || [], animStates: Object.fromEntries(rows.map((a) => [a.path, a.states || []])) };
  } catch (e) { /* 候选空着 */ }
  try { const j = await API.json('/api/sfx'); S.sfx = j.sfx || []; } catch (e) { /* 同上 */ }
  // 可燃物模板表（薄片「可燃模板」的候选 + 本地预览的 burnTemplates）；读不到不拦开页，检视器与状态栏会说
  await refreshBurnTemplates({ rebuild: false });
  // 窗口重新获得焦点（多半是在燃烧工作台里改完模板存了盘切回来）/ 页面重新可见：重读模板表——
  // 内容一样什么都不做；变了且当前效果绑着的模板清洗结果变了才重建本地预览
  window.addEventListener('focus', () => { void refreshBurnTemplates(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refreshBurnTemplates(); });
  // 布置库先于场景 / 效果装：本地预览第一次建模拟就要按活动布置跑。读不懂 = 只读（绝不拿空库覆盖盘上那份）
  S.libReal = !(boot0.placements && boot0.placements.real === false);
  try {
    const j = await API.json('/api/placements');
    S.lib = j.doc && typeof j.doc === 'object' ? j.doc : { scenes: {} }; S.libPath = j.path || ''; S.libErr = '';
  } catch (e) {
    S.lib = { scenes: {} }; S.libErr = String(e && e.message || e);
    status(`布置库读不懂（只读，不会覆盖）：${S.libErr}`, 'err');
  }
  markClean('lib');
  await loadLightning();
  await refreshEffects();
  renderScenePickers();
  // 先开效果、由它决定装哪个场景（`syncEnvWithDoc`）：原来先装第一个有深度的场景、再跳去效果的场景，开页要装两遍
  const openId = boot0.open || (S.effects[0] ? S.effects[0].id : '');
  if (openId) await openEffect(openId, { jump: true });
  if (!S.scene) {
    const withDepth = S.scenes.find((s) => s.depth) || S.scenes[0];
    if (withDepth) await loadScene(withDepth.id, '');
  }
  renderAll();
  void pollLink();
  setInterval(() => { void pollLink(); }, STATUS_POLL_MS);
  window.__ready = true;
}

function bindUI() {
  // `refocus` = 这一下是键盘方向键逐项切的（真 change）：装载门把焦点拿走，装完放回，第二下方向键接着切（见 keyboardSelectOf）
  el('effectSel').addEventListener('change', (e) => { void openEffect(e.target.value, { refocus: e.isTrusted }); });
  el('btnNew').addEventListener('click', () => { void newEffect(); });
  el('btnDup').addEventListener('click', () => { void duplicateEffect(); });
  el('btnRename').addEventListener('click', () => { void renameEffect(); });
  el('btnDelete').addEventListener('click', () => { void deleteEffect(); });
  el('btnSave').addEventListener('click', () => { void saveEffect(); });
  el('btnUndo').addEventListener('click', () => { doUndo(); });
  el('btnRedo').addEventListener('click', () => { doRedo(); });
  el('sceneSel').addEventListener('change', (e) => { void loadScene(e.target.value, '', { refocus: e.isTrusted }); });
  el('phaseSel').addEventListener('change', (e) => { if (S.scene) void loadScene(S.scene.id, e.target.value, { refocus: e.isTrusted }); });
  el('btnPhaseRequest').addEventListener('click', () => { void requestGamePhase(); });
  el('btnPlaceHere').addEventListener('click', () => placeHere());
  el('btnPlaceDel').addEventListener('click', () => { void delPlacement(); });
  el('btnPlaceUp').addEventListener('click', () => movePlacement(-1));
  el('btnPlaceDown').addEventListener('click', () => movePlacement(1));
  el('btnPlaceRename').addEventListener('click', async () => {
    const p = activePlacement(); if (!p) return;
    const v = await promptDialog('改布置 id', 'id（本份内唯一；playVfx / 条件按它找）', p.id);
    if (v) renamePlacement(p.id, v);
  });
  el('btnPlaceCopy').addEventListener('click', () => { void copyPlacementsDialog(); });
  el('btnBindScene').addEventListener('click', () => {
    if (!S.doc || !S.scene) return;
    edit('绑定作者场景', () => bindAuthoringScene());
  });
  // 左侧工具条（原来只画了按钮没接点击：只有快捷键能切工具——区域工具没有快捷键，这一行必须有）
  for (const b of document.querySelectorAll('#tools button[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  el('btnView3').addEventListener('click', () => setView(3));
  el('btnView2').addEventListener('click', () => setView(2));
  el('btnFocus').addEventListener('click', () => focusSelected());
  el('btnFit').addEventListener('click', () => { if (S.view === 3 && v3 && v3.ok) v3.fit(false); else if (v2) v2.fit(); });
  el('btnPlay').addEventListener('click', () => setPlaying(!S.playing));
  el('btnStep').addEventListener('click', () => { stepSim(1 / 60); draw(); renderSimBar(); });
  el('btnReset').addEventListener('click', () => resetSim());
  // 预览条的数值框同检视器：有焦点时滚轮先失焦，免得滚一下改了种子 / 倍速 / 刺激参数
  for (const id of ['seed', 'speed', 'fieldRadius', 'fieldStrength', 'fieldDuration', 'fieldDirX', 'fieldDirY', 'fieldDirZ']) Inspector.blurOnWheel(el(id));
  el('fieldKind').addEventListener('change', () => { el('fieldDirection').hidden = !['wind', 'airflow'].includes(el('fieldKind').value); });
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
  el('btnAddBeam3').addEventListener('click', () => addBeam('3d'));
  el('btnAddBeam2').addEventListener('click', () => addBeam('2d'));
  el('btnDupBeam').addEventListener('click', () => { const b = focusBeam(); if (b) dupBeam(b.id); });
  el('btnDelBeam').addEventListener('click', () => { const b = focusBeam(); if (b) delBeam(b.id); });
  el('btnUpBeam').addEventListener('click', () => { const b = focusBeam(); if (b) moveBeam(b.id, -1); });
  el('btnDownBeam').addEventListener('click', () => { const b = focusBeam(); if (b) moveBeam(b.id, 1); });
  el('btnRenameBeam').addEventListener('click', async () => {
    const b = focusBeam(); if (!b) return;
    const v = await promptDialog('改光柱名', 'id（尘埃的「光柱体积」/「被光柱照亮」会跟着改）', b.id);
    if (v && v !== b.id) edit('改光柱 id', () => renameBeam(b.id, v));
  });
  el('btnClearFields').addEventListener('click', () => { S.fields.length = 0; S.playerField = null; draw(); status('清了所有刺激场'); });
  el('btnClearFires').addEventListener('click', () => clearFires());
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
    box.addEventListener('change', () => {
      S.layers[k] = box.checked;
      // 藏起群体半径：选中着的那个半径也放掉（看不见的线框球上还挂着缩放 gizmo、左栏还高亮着，作者不知道自己选了什么）
      if (k === 'rings' && !box.checked && radiusOf(S.sel.key)) select('');
      if (k === 'mesh' || k === 'dimMesh') { if (v2) v2.draw(); }
      draw();
    });
  }
}

/**
 * 关窗 / 刷新前桌面壳来问（`tools/desktop_shell.py` 的 `_guard_unsaved`）：有没存的就说清楚是哪几份，
 * 作者可以直接「保存并关闭」——走的就是 Ctrl+S 那条 `saveEffect`，只存成一半 / 保存期间又改了都算没存上。
 */
function unsavedSummary() {
  // 输入框里刚打的数还没提交（没按 Enter / Tab）：关窗 / 刷新时点标题栏 X 或按 F5 都不会让它失焦
  commitFocusedInput();
  const parts = [];
  if (S.docDirty && S.doc) parts.push(`效果「${S.doc.id}」`);
  if (S.libDirty) parts.push('布置库');
  if (S.lsDirty) parts.push('雷电样式（要点「生成并套用」才落盘，「保存并关闭」不管它）');
  return parts.length ? `${parts.join('、')}有未保存的改动。` : '';
}
window.__unsavedSummary = unsavedSummary;
window.__saveUnsaved = () => {
  window.__saveUnsavedResult = 'pending';
  Promise.resolve(saveEffect()).then(() => {
    window.__saveUnsavedResult = S.dirty ? (el('status').textContent || '没存上') : 'ok';
  }, (e) => { window.__saveUnsavedResult = String(e && e.message || e); });
};
// 选「不保存」：把盘上那份推给游戏（返回 promise，壳最多等 2 s）
window.__onDiscardUnsaved = () => discardLiveWorkingCopy();
window.addEventListener('beforeunload', (e) => {
  if (!window.__discardUnsaved) commitFocusedInput();
  if ((S.dirty || S.lsDirty) && !window.__discardUnsaved) { e.preventDefault(); e.returnValue = ''; }
});

/** 桌面壳 `--open <id>` / 主编辑器打进来：装载门内与手势没松开时一律拒 */
window.__openEffect = (id) => {
  if (S.busy || history.inDrag()) { status('正在装载 / 手势没松开，稍后再试', 'warn'); return; }
  void openEffect(id, { jump: true });
};

window.addEventListener('DOMContentLoaded', () => { void boot(); });
