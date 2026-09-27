/**
 * `mainline` 种类:按主线顺序(`dev_narrative_warps.json` 的 17 个跳转点)逐拍把游戏**玩一遍**。
 *
 * 每拍一条(个别拍太长拆两段):`?narrativeWarp=<id>` 冷启动 → 按叙事状态机往前推这一拍的内容 → 结尾开一圈面板。
 * 另有一条 `mainline__chain`:从第一个跳转点起、同一次启动里按顺序把各拍接起来,拍与拍之间叙事状态接不上的
 * (比如主图 state_9 → s02_beishi 没有迁移)用 `debugSetNarrativeState` 只往前补,场景不在就切过去。
 *
 * 只走 master 上就有的入口(两边一字不差),不注入游戏代码、不写旗标:
 *   - 触发内容:`debugInteractNpc` / `debugTriggerHotspot` / `debugSetPlayerPosition`(把人放进区里,区的 onEnter 照常触发)/
 *     `playerInteract`(区的 onInteract)/ `playerAct`(跳跃点)/ `debugSwitchScene`;
 *   - 推进对白与过场:`__gameDevAPI.completeDialogueText` / `completeCutsceneText` 补完打字机 + `playerAdvance`(对话推进事件,
 *     图对话与脚本台词都认)+ `playerTap`(过场台词 / 点击继续)+ 真键盘(Digit1…9 = 选项直选;ShiftLeft = 不选任何项的
 *     「任意键」,关说明卡 / 检视框 / 点击继续用;Space / KeyQ / KeyT = 长按条、护火、点火;Escape = 关铺子 / 地图 / 小游戏、
 *     长管线里二次确认跳过过场);
 *   - 叙事:`debugSetNarrativeState`(只在 dev 跳转点本身做不到的地方补:见各拍 note),`debugExecuteAction` 只重放**数据里原样
 *     存在的**动作(打更人给的东西、道具 use、赌坊对白里的 advanceTimeTo 夜、设火种)。
 *
 * 节拍从数据推:对白图逐节点走一遍(line 的拍数、choice 的 promptLine、runActions 里的过场 / 长按 / 小游戏 / 切场 / 说明卡 /
 * 发物 / 发信号 → 信号落到哪个状态、那个状态 onEnter 又演什么),过场按步骤表估时长与要点几下,长按按 fillSeconds 与
 * interrupt 停点算按多久,水下小游戏按实例 bounds 与实体坐标算点哪。数据改了清单跟着变;推不准的地方多给几轮推进兜底。
 * 选项缺省选第 0 项;主线要求特定项的(喊名要喊对)从图里找发 `*_right` 信号的那一项。
 *
 * 排节拍时顺手推演一份世界模型(World,每条脚本一份):
 *   - 位置:走位从实体上一次知道的位置算(出生点 / 摆人点 / 上一段走位终点 / NPC 数据坐标),不再一律按 150 px 起步;
 *   - 叙事:跳转点在 master 上**实际**落在哪(dev 不吃 startupFlags,主图冷启动在 state_1,「梦待死之礼」起各跳转点的主图
 *     一个都落不到 → 进场后按主图那一串逐跳补)、脚本置的态、对白发的信号及 `state:图:状态` 连锁、条件判得出真的 reactive 迁移、
 *     脚本发的物品(has_item_*);区的条件拿它核,判得出「不成立」`--list` 报错;
 *   - 呼吸图:breathingPerform fadeOut + wait 按资产参数算要等多久(几十秒,不是固定 2.5 s)。
 * 区里摆人避开要命的威胁圈(跑马梁喊声区的顶点平均就在路边身影近身圈里)。
 * 清单与数据的对账见 validate.mjs(`run.mjs --list --only mainline`)。
 */
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- 节奏常量

/** 对白一轮推进的帧数(补完打字机后停这么久再点下一句) */
const DLG_EVERY = 24;
/** 过场一轮(点一下)的帧数 */
const CS_EVERY = 30;
/** 切场景后等多少帧(淡出 → 装载 → 淡入;装载本身是墙钟 I/O,由 driver 的 quiesce 兜) */
const SCENE_FRAMES = 100;
/** 长管线里超过这么多帧的过场按 Esc 二次确认跳过(每拍的单条里一律整段播) */
const CHAIN_SKIP_FRAMES = 600;
/** 对白里每几句拍一张 */
const LINE_CP_EVERY = 3;
/** 「任意键」:关说明卡 / 检视框 / 点击继续,但不会选中任何选项(DialogueUI / ActionChoiceUI 只认 Space / Enter / 数字) */
const ANY_KEY = 'ShiftLeft';
const digitKey = (index) => `Digit${Math.min(9, Math.max(1, (index | 0) + 1))}`;
/** 走位按直线估,实际路径 / 起步收步会长一点:宁可多等(多出来的轮次只是空转),不能少等(少等 = 后面的输入落进别的界面) */
const PATH_SLACK = 1.15;
/** 起点不知道时的走位长度(像素) */
const UNKNOWN_LEG = 150;
/** 区内摆人要避开的威胁:峰值伤害 ≥ 这么多 HP/s 的(100 血 20 s 内打死);跟脚那种 1.5 HP/s 的全图威胁不避 */
const LETHAL_APS = 5;
/** 摆人点离威胁 boundaryRadius 再留这么多像素 */
const THREAT_MARGIN = 24;
/** 长纯耗时每这么多毫秒拍一张(呼吸图渐弱这类几十秒的等待,中途看得到演出进行到哪) */
const LONG_WAIT_CP_MS = 8000;

/** master NarrativeStateManager.REPLAY_SILENCED_ACTION_TYPES 里会**等玩家**的那几种:跳转点最后一跳若带它们,就在 dev_room 里等点击 */
const BLOCKING_ACTIONS = new Set([
  'startCutscene', 'playScriptedDialogue', 'startDialogueGraph', 'chooseAction', 'waitClickContinue',
  'startPressureHold', 'startEncounter', 'startWaterMinigame', 'startSugarWheelMinigame', 'startPaperCraftMinigame',
]);

// ---------------------------------------------------------------- 步骤小工具

const adv = (n) => ({ advance: Math.max(1, Math.round(n)) });
const cpStep = (name) => ({ checkpoint: name });
const cmd = (type, fields = {}) => ({ cmd: { type, ...fields } });
const api = (name, ...args) => (args.length ? { api: name, args } : { api: name });
const key = (k) => ({ key: k });
const act = (type, params = {}) => ({ cmd: { type: 'debugExecuteAction', action: { type, params } } });
const clone = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- 数据

/** 每份数据取第一棵有它的树(A = master 在前);场景 / 对白图按需读、缓存 */
function loadData(treeDirs) {
  const pick = (rel) => {
    for (const d of treeDirs) {
      const j = readJson(path.join(d, 'public', 'assets', rel));
      if (j) return j;
    }
    return null;
  };
  const cache = new Map();
  const cached = (rel) => {
    if (!cache.has(rel)) cache.set(rel, pick(rel));
    return cache.get(rel);
  };
  const graphs = new Map();
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (typeof n.id === 'string' && n.states && typeof n.states === 'object' && !Array.isArray(n.states)) graphs.set(n.id, n);
    for (const k of Object.keys(n)) walk(n[k]);
  })(pick('data/narrative_graphs.json'));
  const bySignal = new Map();
  for (const g of graphs.values()) {
    for (const t of arr(g.transitions)) {
      if (typeof t?.signal !== 'string' || t.signal === '__draft__') continue;
      if (!bySignal.has(t.signal)) bySignal.set(t.signal, []);
      bySignal.get(t.signal).push({ graph: g.id, from: t.from, to: t.to });
    }
  }
  const cutscenes = new Map(arr(pick('data/cutscenes/index.json')).filter((c) => typeof c?.id === 'string').map((c) => [c.id, c]));
  const holdsRaw = pick('data/pressure_holds.json');
  const holds = new Map(arr(Array.isArray(holdsRaw) ? holdsRaw : holdsRaw?.holds).filter((h) => typeof h?.id === 'string').map((h) => [h.id, h]));
  const waterIndex = arr(pick('data/water_minigames/index.json'));
  // 呼吸图参数缺省值(src/data/breathingParams.json,与 master 的 defaultBreathingParams 同源)
  const breathingDefaults = {};
  for (const d of treeDirs) {
    const j = readJson(path.join(d, 'src', 'data', 'breathingParams.json'));
    if (!j) continue;
    for (const g of arr(j.groups)) for (const p of arr(g?.params)) if (typeof p?.key === 'string' && Number.isFinite(p.default)) breathingDefaults[p.key] = p.default;
    break;
  }
  return {
    warps: arr(pick('data/dev_narrative_warps.json')?.warps).filter((w) => typeof w?.id === 'string'),
    graphs,
    bySignal,
    cutscenes,
    holds,
    items: new Map(arr(pick('data/items.json')).filter((i) => typeof i?.id === 'string').map((i) => [i.id, i])),
    shops: new Map(arr(pick('data/shops.json')).filter((s) => typeof s?.id === 'string').map((s) => [s.id, s])),
    scene: (id) => cached(`scenes/${id}.json`),
    dialogue: (id) => cached(`dialogues/graphs/${id}.json`),
    breathing: (id) => cached(`data/breathing/${id}.json`),
    breathingDefaults,
    water: (id) => {
      const e = waterIndex.find((x) => x?.id === id);
      return e?.file ? cached(`data/water_minigames/${e.file}`) : null;
    },
  };
}

/**
 * 脚本推演用的世界模型(每条脚本一份,Walker 与 Script 共用):
 *   - 场景与实体位置:走位按「上一次知道的位置 → 目标」估长度(出生点 / 摆人点 / 上一段走位的终点 / 场景里 NPC 的坐标);
 *   - 叙事:脚本自己推的状态(跳转点冷启动落地、debugSetNarrativeState、对白里发的信号 → 迁移 → `state:图:状态` 连锁、
 *     条件判得出真的 reactive 迁移、脚本发的物品 → has_item_*),给区的条件对账用(`--list` 报「把人放进去也不会触发」);
 *   - 呼吸图:句柄 → 资产、运行时改过的参数(估 breathingPerform fadeOut 等多久)。
 * 推演在「排节拍」时做(Walker 走数据那一刻),顺序与脚本发命令的顺序一致。
 */
class World {
  constructor(D) {
    this.D = D;
    this.scene = null;
    this.pos = new Map();
    this.nar = new Map();
    this.breathing = new Map();
    /** 脚本发过的物品(giveItem / removeItem):只用来判引擎派生的 has_item_* 旗标叶子 */
    this.items = new Map();
    this.settling = false;
    // reactive / reactiveAll / reactiveAny 迁移(条件判得出真才走;旗标 / 手持这类判不了的叶子 = '?',不走)
    this.reactive = [];
    for (const g of D.graphs.values()) {
      for (const t of arr(g.transitions)) {
        if (!String(t?.trigger ?? '').startsWith('reactive') || !g.states?.[t.to]) continue;
        const conds = arr(t.conditions);
        this.reactive.push({ graph: g.id, from: t.from, to: t.to, cond: t.trigger === 'reactiveAny' ? [{ any: conds }] : conds });
      }
    }
  }

  /** 进场景:NPC 回到数据坐标,人落在出生点(点名的出生点没有 → 场景缺省出生点,与 master SceneManager 同一条回退) */
  enterScene(id, spawnId = null) {
    this.scene = id;
    this.pos = new Map();
    const sd = this.D.scene(id);
    const sp = (spawnId && sd?.spawnPoints?.[spawnId]) || sd?.spawnPoint;
    if (Number.isFinite(sp?.x) && Number.isFinite(sp?.y)) this.pos.set('player', { x: sp.x, y: sp.y });
  }

  where(id) {
    if (this.pos.has(id)) return this.pos.get(id);
    const n = arr(this.D.scene(this.scene)?.npcs).find((x) => x?.id === id);
    return Number.isFinite(n?.x) && Number.isFinite(n?.y) ? { x: n.x, y: n.y } : null;
  }

  place(id, pt) {
    if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) this.pos.set(id, { x: pt.x, y: pt.y });
    else this.pos.delete(id);
  }

  narEnter(graphId, stateId) {
    const g = this.D.graphs.get(graphId);
    let e = this.nar.get(graphId);
    if (!e) {
      e = { active: g?.initialState ?? null, reached: new Set(g?.initialState ? [g.initialState] : []) };
      this.nar.set(graphId, e);
    }
    e.active = stateId;
    e.reached.add(stateId);
    if (!this.settling) this.settle();
  }

  /** 物品增减(发物会让 has_item_* 变,reactive 条件可能跟着满足) */
  itemDelta(id, n) {
    if (typeof id !== 'string' || !id) return;
    this.items.set(id, Math.max(0, (this.items.get(id) ?? 0) + n));
    if (!this.settling) this.settle();
  }

  /**
   * 状态变了之后把条件已满足的 reactive 迁移走完(与 master 的 reactive 排空同义,只看叙事叶子);reactive 进的状态再顺
   * `state:<图>:<状态>` 信号连锁(只走起点对得上的迁移)。显式信号的连锁由 Walker.signal 自己推(那边还要排 onEnter 的节拍)。
   */
  settle() {
    this.settling = true;
    try {
      for (let guard = 0; guard < 100; guard++) {
        let moved = false;
        for (const r of this.reactive) {
          if (r.from === r.to || this.narOf(r.graph).active !== r.from || this.evalCond(r.cond).v !== 'T') continue;
          const queue = [{ graph: r.graph, to: r.to }];
          for (let hops = 0; queue.length && hops < 50; hops++) {
            const m = queue.shift();
            this.narEnter(m.graph, m.to);
            for (const t of this.D.bySignal.get(`state:${m.graph}:${m.to}`) ?? []) {
              if (this.narOf(t.graph).active === t.from) queue.push({ graph: t.graph, to: t.to });
            }
          }
          moved = true;
        }
        if (!moved) break;
      }
    } finally {
      this.settling = false;
    }
  }

  /** 这张图此刻推演在哪(没碰过的图 = 冷启动的 initialState,known=false) */
  narOf(graphId) {
    const g = this.D.graphs.get(graphId);
    const e = this.nar.get(graphId);
    if (e) return { known: true, active: e.active, reached: e.reached };
    return { known: false, active: g?.initialState ?? null, reached: new Set(g?.initialState ? [g.initialState] : []) };
  }

  /**
   * 条件表达式在推演状态下的真假:'T' / 'F' / '?'。判叙事叶子(narrative + state [+ reached])与脚本自己发过的物品的
   * has_item_* 旗标(有 → 真;没有不算假:别处也可能给);其余叶子(别的旗标 / 手持 / 时段 / 位面 …)与 @owner / @scene
   * 相对引用一律 '?'。没碰过的图按 initialState 判,判出假也只算 '?'(可能被没推演的东西推过)。
   * @returns {{v:'T'|'F'|'?', why:string[]}}
   */
  evalCond(c) {
    const why = [];
    const ev = (x) => {
      if (Array.isArray(x)) return all(x.map(ev));
      if (!x || typeof x !== 'object') return '?';
      if (Array.isArray(x.all)) return all(x.all.map(ev));
      if (Array.isArray(x.any)) {
        const r = x.any.map(ev);
        return r.includes('T') ? 'T' : r.length && r.every((v) => v === 'F') ? 'F' : '?';
      }
      if (x.not !== undefined) {
        const r = ev(x.not);
        return r === 'T' ? 'F' : r === 'F' ? 'T' : '?';
      }
      if (typeof x.narrative === 'string' && typeof x.state === 'string' && x.flag === undefined && x.quest === undefined && x.scenario === undefined) {
        const gid = x.narrative.trim();
        if (gid.startsWith('@') || !this.D.graphs.has(gid)) return '?';
        const st = x.state.trim();
        const n = this.narOf(gid);
        const ok = x.reached === true ? n.active === st || n.reached.has(st) : n.active === st;
        if (ok) return 'T';
        if (!n.known) return '?';
        why.push(`${gid} 要${x.reached === true ? '到过' : '在'}「${st}」,推演在「${n.active}」`);
        return 'F';
      }
      if (typeof x.flag === 'string' && x.flag.startsWith('has_item_') && (x.value === undefined || x.value === true) && x.op === undefined) {
        return (this.items.get(x.flag.slice('has_item_'.length)) ?? 0) > 0 ? 'T' : '?';
      }
      return '?';
    };
    function all(r) {
      return r.includes('F') ? 'F' : r.every((v) => v === 'T') ? 'T' : '?';
    }
    return { v: ev(c ?? []), why };
  }
}

/** 呼吸图 fadeOut(wait)要等多久:当前这口走完(最坏 = 出图后第一口深叹整口)+ 变浅一口 + [假停] + 最后一丝 + |纸比胸口晚| + 真停后出字 */
function breathingFadeOutMs(D, world, handle) {
  const ref = world?.breathing.get(handle) ?? { asset: handle, patch: {} };
  const def = D?.breathing(ref.asset);
  const P = { ...(D?.breathingDefaults ?? {}), ...(def?.params ?? {}), ...ref.patch };
  const p = (k, d) => num(P[k], d);
  const cycle = p('ti', 2.7) + p('te', 3.75) + p('tp', 1.05);
  const current = cycle * Math.max(p('sighLen', 115) / 100, 1 + p('jitter', 6) / 100);
  const apnea = p('apnea', 0) > 0 ? p('apnea', 0) : 0;
  const sec = current + cycle * (p('f1Len', 80) / 100) + apnea + cycle * (p('f2Len', 75) / 100) + Math.abs(p('lag', 0)) + p('stillHold', 2.5);
  return sec * 1000;
}

/** 过场时长(帧)与要点几下:串行相加、parallel 取最长;showDialogue / 非自动字幕 / waitClick 各点一下。env = {D, world}:走位按世界模型里的位置估 */
function cutsceneCost(def, env = null) {
  const one = (s) => {
    if (!s || typeof s !== 'object' || s.disabled) return { ms: 0, clicks: 0 };
    if (s.kind === 'parallel') {
      let ms = 0;
      let clicks = 0;
      for (const t of arr(s.tracks)) {
        const r = t?.kind ? one(t) : seq(t?.steps ?? t);
        ms = Math.max(ms, r.ms);
        clicks += r.clicks;
      }
      return { ms, clicks };
    }
    const d = (v, x) => num(v, x);
    if (s.kind === 'present') {
      switch (s.type) {
        case 'waitTime': case 'fadeToBlack': case 'fadeIn': return { ms: d(s.duration, 1000), clicks: 0 };
        case 'flashWhite': return { ms: d(s.duration, 200), clicks: 0 };
        case 'showTitle': return { ms: d(s.duration, 2000), clicks: 0 };
        case 'cameraMove': return { ms: d(s.duration, 1000), clicks: 0 };
        case 'cameraZoom': return { ms: d(s.duration, 500), clicks: 0 };
        case 'waitClick': return { ms: 0, clicks: 1 };
        case 'showDialogue': case 'showSubtitle': return autoAdvanceCost(s.type === 'showSubtitle' ? (s.autoAdvance ?? s.subtitleAutoAdvance) : s.autoAdvance);
        default: return { ms: 0, clicks: 0 };
      }
    }
    if (s.kind === 'action') return { ms: actionMs(s.type, s.params ?? {}, env), clicks: 0 };
    return { ms: 0, clicks: 0 };
  };
  const seq = (steps) => {
    let ms = 0;
    let clicks = 0;
    for (const s of arr(steps)) {
      const r = one(s);
      ms += r.ms;
      clicks += r.clicks;
    }
    return { ms, clicks };
  };
  const r = seq(def?.steps);
  return { frames: Math.round((r.ms / 1000) * 60), clicks: r.clicks };
}

/**
 * 台词 / 字幕一拍:master CutsceneManager.awaitBeatDismiss 里点击对**任何**一拍都有效(定时 / 跟配音走的自动推进只是
 * 另一条收束路,开拍 120 ms 后点击即收)。本脚本每轮都点一下,所以每拍按一次点击算,不看 autoAdvance 的时长。
 */
function autoAdvanceCost() {
  return { ms: 0, clicks: 1 };
}

/**
 * 会占时间的动作估多久(ms)。env = {D, world}(可缺):
 *   - 走位:起点 = 世界模型里这个实体上一次知道的位置(出生点 / 摆人点 / 上一段走位终点 / 场景 NPC 坐标)→ 路点 → 终点,
 *     折线长 × PATH_SLACK;与旧口径(UNKNOWN_LEG + 路点折线)取大,再除以速度。估完把实体挪到终点(下一段从这接着算);
 *   - breathingPerform fadeOut + wait:按呼吸图资产的参数算(见 breathingFadeOutMs),不是固定值。
 */
function actionMs(type, p, env = null) {
  const world = env?.world ?? null;
  const target = typeof p.target === 'string' ? p.target.trim() : '';
  const destOf = () => {
    const at = p.at?.kind === 'entity' && typeof p.at.id === 'string' ? world?.where(p.at.id) : null;
    const x = at ? at.x : Number(p.x);
    const y = at ? at.y : Number(p.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  };
  switch (type) {
    case 'moveEntityTo': {
      const dest = destOf();
      const pts = [...arr(p.waypoints).map((q) => ({ x: Number(q?.x), y: Number(q?.y) })), dest]
        .filter((q) => Number.isFinite(q?.x) && Number.isFinite(q?.y));
      const start = target ? world?.where(target) : null;
      let poly = 0;
      for (let i = 1; i < pts.length; i++) poly += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      // 起点不知道 = 按 UNKNOWN_LEG 补第一段(旧口径);知道 = 真实第一段 × 余量。两者取大:只补长了估短的(码头水边、纸钱引路),
      // 不把旧口径已经够用的短走位(茶馆里挪一两步)改短 —— 起点推演万一不准(巡逻 / 没推演到的挪位),少等比多等危险
      const legacy = UNKNOWN_LEG + poly;
      const known = start && pts.length ? (Math.hypot(pts[0].x - start.x, pts[0].y - start.y) + poly) * PATH_SLACK : 0;
      if (world && target && dest) world.place(target, dest);
      const speed = num(Number(p.speed), 80) > 0 ? num(Number(p.speed), 80) : 80;
      return (Math.max(legacy, known) / speed) * 1000;
    }
    case 'teleportEntityTo':
      if (world && target) world.place(target, destOf());
      return 0;
    case 'jumpEntityTo':
      if (world && target) world.place(target, destOf());
      return num(p.durationMs, 400);
    case 'showEmoteAndWait': return num(p.duration, 1500);
    case 'showSpeechBubbleAndWait': return num(p.duration, 2500);
    case 'playTrajectory': return p.wait === false ? 0 : 2000;
    case 'waitMs': return num(p.durationMs, 0);
    case 'fadeWorldToBlack': case 'fadeWorldFromBlack': case 'showBlackout': case 'hideBlackout': return num(p.durationMs, 1000);
    case 'fadingZoom': return num(p.durationMs, 0);
    case 'breathingPerform': {
      if (!p.wait) return 0;
      if (p.act === 'fadeOut') return breathingFadeOutMs(env?.D, world, String(p.id ?? ''));
      return 2500;
    }
    case 'advanceTimeTo': return p.transition === 'fade' ? 1600 : 0;
    default: return 0;
  }
}

const polyPts = (poly) => arr(poly).filter((q) => Number.isFinite(q?.x) && Number.isFinite(q?.y));

function inPolygon(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/** 场景里会要命的威胁(NPC / 热区的 healthThreat,峰值 ≥ LETHAL_APS):圆心 = 实体坐标,半径 = boundaryRadius */
function lethalThreats(sceneData) {
  return [...arr(sceneData?.npcs), ...arr(sceneData?.hotspots)]
    .filter((e) => e?.healthThreat && Number.isFinite(e.x) && Number.isFinite(e.y))
    .map((e) => ({
      id: e.id,
      x: e.x,
      y: e.y,
      r: num(e.healthThreat.boundaryRadius, 0),
      peak: Math.max(num(e.healthThreat.attackPerSecond, 0), num(e.healthThreat.nearAttackPerSecond, 0)),
    }))
    .filter((t) => t.peak >= LETHAL_APS && t.r > 0);
}

/**
 * 区里摆人的点:缺省 insidePoint;落在要命威胁的圈里(比如跑马梁喊声区的顶点平均离路边身影 54 px,近身 1000 HP/s)就在区里另找——
 * 圈外(+THREAT_MARGIN)、尽量不在场景别的区里(免得顺带把别的区提前触发)、离原点最近。找不到返回原点并带上 threat。
 * @returns {{x:number,y:number,threat?:string}|null}
 */
function zonePoint(sceneData, zone) {
  const p = insidePoint(zone?.polygon);
  if (!p) return null;
  const threats = lethalThreats(sceneData);
  const hit = (q) => threats.find((t) => Math.hypot(q.x - t.x, q.y - t.y) <= t.r + THREAT_MARGIN);
  const bad = hit(p);
  if (!bad) return p;
  const pts = polyPts(zone.polygon);
  const others = arr(sceneData?.zones).filter((z) => z && z.id !== zone.id && z.zoneKind !== 'depth_floor').map((z) => polyPts(z.polygon)).filter((q) => q.length >= 3);
  // 别的区按「里面或离边不到 ZONE_EDGE_MARGIN」算重叠:别贴着别的区的边摆(贴边一两像素,落地位置稍一偏就进去了)
  const ZONE_EDGE_MARGIN = 40;
  const ring = Array.from({ length: 8 }, (_, k) => ({ dx: Math.cos((k * Math.PI) / 4) * ZONE_EDGE_MARGIN, dy: Math.sin((k * Math.PI) / 4) * ZONE_EDGE_MARGIN }));
  const near = (o, q) => inPolygon(o, q.x, q.y) || ring.some((r) => inPolygon(o, q.x + r.dx, q.y + r.dy));
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  const N = 64;
  let best = null;
  for (let i = 1; i < N; i++) {
    for (let j = 1; j < N; j++) {
      const q = { x: box.x0 + ((box.x1 - box.x0) * i) / N, y: box.y0 + ((box.y1 - box.y0) * j) / N };
      if (!inPolygon(pts, q.x, q.y) || hit(q)) continue;
      // 次序:少碰别的区 → 离本区边也留出余量 → 离原点近
      const overlap = others.filter((o) => near(o, q)).length * 2 + (ring.every((r) => inPolygon(pts, q.x + r.dx, q.y + r.dy)) ? 0 : 1);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || overlap < best.overlap || (overlap === best.overlap && d < best.d)) best = { ...q, overlap, d };
    }
  }
  if (!best) return { ...p, threat: bad.id };
  return { x: Math.round(best.x * 10) / 10, y: Math.round(best.y * 10) / 10 };
}

/** 多边形里的一点:顶点平均在里面就用它,否则包围盒中心,再不行按网格找离平均点最近的内点 */
function insidePoint(poly) {
  const pts = polyPts(poly);
  if (pts.length < 3) return null;
  const inside = (x, y) => inPolygon(pts, x, y);
  const avg = { x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: pts.reduce((s, q) => s + q.y, 0) / pts.length };
  const r1 = (q) => ({ x: Math.round(q.x * 10) / 10, y: Math.round(q.y * 10) / 10 });
  if (inside(avg.x, avg.y)) return r1(avg);
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  const mid = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
  if (inside(mid.x, mid.y)) return r1(mid);
  let best = null;
  for (let i = 1; i < 24; i++) {
    for (let j = 1; j < 24; j++) {
      const x = box.x0 + ((box.x1 - box.x0) * i) / 24;
      const y = box.y0 + ((box.y1 - box.y0) * j) / 24;
      if (!inside(x, y)) continue;
      const d = Math.hypot(x - avg.x, y - avg.y);
      if (!best || d < best.d) best = { x, y, d };
    }
  }
  return best ? r1(best) : null;
}

/** 叙事图拓扑上的最短路(只借拓扑,不问 trigger;与 master 的 planRemoteAdvance 同口径) */
function bfsPath(graph, from, to) {
  if (!graph?.states?.[to]) return null;
  if (from === to) return [];
  const adj = new Map();
  for (const t of arr(graph.transitions)) {
    if (!graph.states[t?.to]) continue;
    if (!adj.has(t.from)) adj.set(t.from, []);
    adj.get(t.from).push(t.to);
  }
  const prev = new Map([[from, null]]);
  const q = [from];
  while (q.length) {
    const cur = q.shift();
    for (const n of adj.get(cur) ?? []) {
      if (prev.has(n)) continue;
      prev.set(n, cur);
      if (n === to) {
        const out = [n];
        for (let p = cur; p !== from && p !== null; p = prev.get(p)) out.unshift(p);
        return out;
      }
      q.push(n);
    }
  }
  return null;
}

/** master NarrativeStateManager.isScenarioGraph:scenario 图对外只认 entryState / exitStates(远程置态进中段会被拒) */
function isScenarioGraph(g) {
  return g?.ownerType === 'scenario' || Boolean(g?.entryState || arr(g?.exitStates).length);
}

/**
 * 从 from 够不着 to 时(比如主图 state_9 / 冷启动的 state_1 → s02_beishi 那一串没有入边),从 to 所在那一串的根(无入边的状态)
 * 起逐跳:根一发直达,之后沿迁移边走,沿路状态都记成到过(quests / 地图节点读 reached)。只给非 scenario 图用
 * (master canRemoteEnterState 对非 scenario 图一律放行;scenario 图直达中段会被拒)。够不着返回 null。
 */
function rootPath(graph, to) {
  if (!graph?.states?.[to] || isScenarioGraph(graph)) return null;
  const hasIn = new Set(arr(graph.transitions).filter((t) => graph.states[t?.to] && graph.states[t?.from] && t.from !== t.to).map((t) => t.to));
  let best = null;
  for (const s of Object.keys(graph.states)) {
    if (hasIn.has(s)) continue;
    const p = bfsPath(graph, s, to);
    if (p && (!best || p.length + 1 > best.length)) best = [s, ...p];
  }
  return best;
}

/**
 * master 冷启动 `?narrativeWarp=` 时每条 recipe 实际落在哪(Game.advanceNarrativeForWarp + planRemoteAdvance 的推演):
 * dev 模式不吃 startupFlags,各图从 initialState 起;图内有路 → 落到目标;没路时只有 scenario 图的 entry / exit(或恰有一条边)
 * 给一发直达,非 scenario 图报「铺垫未完全到位」原地不动。path = 落地途经的状态(记到过用)。
 */
function warpLanding(D, warp) {
  const cur = new Map();
  const out = [];
  for (const r of warpRecipe(D, warp)) {
    const g = D.graphs.get(r.graph);
    if (!g) continue;
    const from = cur.get(r.graph) ?? g.initialState;
    let landed = from;
    let hops = [];
    const p = bfsPath(g, from, r.state);
    if (p) {
      landed = r.state;
      hops = p;
    } else if (isScenarioGraph(g) && (r.state === g.entryState || arr(g.exitStates).includes(r.state) || arr(g.transitions).some((t) => t?.from === from && t?.to === r.state))) {
      landed = r.state;
      hops = [r.state];
    }
    cur.set(r.graph, landed);
    out.push({ graph: r.graph, state: r.state, from, landed, hops, scenario: isScenarioGraph(g) });
  }
  return out;
}

/** 状态在图里的先后(从 initialState 广搜的层号;够不着的那一串接在后面,按无入边的根依次广搜) */
function stateRanks(graph) {
  const ranks = new Map();
  if (!graph?.states) return ranks;
  const adj = new Map();
  const hasIn = new Set();
  for (const t of arr(graph.transitions)) {
    if (!graph.states[t?.to] || !graph.states[t?.from]) continue;
    if (!adj.has(t.from)) adj.set(t.from, []);
    adj.get(t.from).push(t.to);
    if (t.from !== t.to) hasIn.add(t.to);
  }
  let base = 0;
  const bfs = (root) => {
    const q = [[root, 0]];
    let max = 0;
    ranks.set(root, base);
    while (q.length) {
      const [cur, d] = q.shift();
      max = Math.max(max, d);
      for (const n of adj.get(cur) ?? []) {
        if (ranks.has(n)) continue;
        ranks.set(n, base + d + 1);
        q.push([n, d + 1]);
      }
    }
    base += max + 1;
  };
  if (graph.states[graph.initialState]) bfs(graph.initialState);
  for (const s of Object.keys(graph.states)) if (!ranks.has(s) && !hasIn.has(s)) bfs(s);
  for (const s of Object.keys(graph.states)) if (!ranks.has(s)) bfs(s);
  return ranks;
}

// ---------------------------------------------------------------- 对白 / 动作 → 节拍段

/**
 * 节拍段(seg):
 *   line    —— 一句要点掉的台词(图对白的一拍 / choice 的 promptLine / 脚本台词 / 点击继续 / 检视框)
 *   options —— 一组选项(图对白 choice 或 chooseAction),index = 要选的那项
 *   cutscene / hold / water / shop / map / note —— 自带推进方式的演出 / 小游戏 / 面板 / 说明卡
 *   scene   —— 切场景(后面紧跟新场景 onEnter 的段)
 *   wait    —— 纯耗时
 *   item / signal / dialogue —— 不占一拍,只用来安排检查点、记引用
 */
class Walker {
  /** @param world World:排节拍时顺手推演(位置 / 叙事 / 呼吸图),一条脚本一份 */
  constructor(D, world = new World(D)) {
    this.D = D;
    this.world = world;
    this.env = { D, world };
  }

  /** @param walk {route:{node:next}, choices:{node:index}, via:{signal:toState}, ifs:boolean} */
  dialogue(graphId, walk = {}, depth = 0, seen = new Set()) {
    const g = this.D.dialogue(graphId);
    const out = [{ t: 'dialogue', graph: graphId }];
    if (!g?.nodes) return out;
    let id = (depth === 0 && walk.entry && g.nodes[walk.entry] ? walk.entry : null) ?? g.entry;
    let guard = 0;
    while (id && guard++ < 400) {
      const n = g.nodes[id];
      if (!n) break;
      switch (n.type) {
        case 'line': {
          const beats = Array.isArray(n.lines) && n.lines.length ? n.lines.length : 1;
          for (let i = 0; i < beats; i++) out.push({ t: 'line', src: 'graph', graph: graphId, node: id });
          id = n.next;
          break;
        }
        case 'choice': {
          const opts = arr(n.options);
          if (n.promptLine) out.push({ t: 'line', src: 'prompt', graph: graphId, node: id });
          const index = Math.min(Math.max(0, walk.choices?.[id] ?? 0), Math.max(0, opts.length - 1));
          out.push({ t: 'options', graph: graphId, node: id, index, count: opts.length });
          id = opts[index]?.next;
          break;
        }
        case 'runActions':
          out.push(...this.actions(n.actions, walk, depth, seen));
          id = n.next;
          break;
        case 'switch': case 'contextState': case 'ownerState':
          if (walk.route?.[id]) out.push({ t: 'route', graph: graphId, node: id, next: walk.route[id] });
          id = walk.route?.[id] ?? n.defaultNext;
          break;
        case 'end':
          id = null;
          break;
        default:
          id = n.next;
      }
    }
    return out;
  }

  actions(actions, walk = {}, depth = 0, seen = new Set()) {
    const out = [];
    for (const a of arr(actions)) {
      if (!a || typeof a.type !== 'string') continue;
      const p = a.params ?? {};
      switch (a.type) {
        case 'startCutscene': {
          // 时长在这里就估(按此刻的世界模型:过场里的走位从人现在的位置算),过场走完的位置留给后面的段
          const def = this.D.cutscenes.get(p.id);
          out.push({ t: 'cutscene', id: p.id, cost: def ? cutsceneCost(def, this.env) : null });
          break;
        }
        case 'showBreathingOverlay':
          if (typeof p.id === 'string') this.world.breathing.set(p.id, { asset: typeof p.breathing === 'string' ? p.breathing : p.id, patch: {} });
          break;
        case 'setBreathingParams': {
          const b = this.world.breathing.get(p.id);
          if (b && p.params && typeof p.params === 'object') Object.assign(b.patch, p.params);
          break;
        }
        case 'playScriptedDialogue': for (let i = 0; i < arr(p.lines).length; i++) out.push({ t: 'line', src: 'scripted' }); break;
        case 'waitClickContinue': out.push({ t: 'line', src: 'click' }); break;
        case 'startPressureHold': out.push({ t: 'hold', id: p.id }); break;
        case 'startWaterMinigame': out.push({ t: 'water', id: p.id }); break;
        case 'openShop': out.push({ t: 'shop', id: p.shopId }); break;
        case 'openMap': out.push({ t: 'map' }); break;
        case 'showSystemNote': out.push({ t: 'note', id: p.noteId }); break;
        case 'giveItem':
          out.push({ t: 'item', id: p.id });
          this.world.itemDelta(p.id, num(Number(p.count), 1));
          break;
        case 'removeItem':
          this.world.itemDelta(p.id, -num(Number(p.count), 1));
          break;
        case 'switchScene':
          out.push({ t: 'scene', id: p.targetScene, spawn: p.targetSpawnPoint || null });
          this.world.enterScene(p.targetScene, p.targetSpawnPoint || null);
          if (depth < 4) out.push(...this.sceneEnter(p.targetScene, walk, depth + 1, seen));
          break;
        case 'startDialogueGraph':
          if (depth < 4) out.push(...this.dialogue(p.graphId, walk, depth + 1, seen));
          break;
        case 'chooseAction': {
          const opts = arr(p.options);
          const index = Math.min(Math.max(0, walk.actionChoice ?? 0), Math.max(0, opts.length - 1));
          out.push({ t: 'options', action: true, index, count: opts.length });
          out.push(...this.actions(opts[index]?.actions, walk, depth, seen));
          break;
        }
        case 'runActions': out.push(...this.actions(p.actions, walk, depth, seen)); break;
        case 'runActionsIf': if (walk.ifs) out.push(...this.actions(p.actions, walk, depth, seen)); break;
        case 'emitNarrativeSignal':
          out.push({ t: 'signal', id: p.signal });
          if (depth < 4) out.push(...this.signal(p.signal, walk, depth + 1, seen));
          break;
        default: {
          const ms = actionMs(a.type, p, this.env);
          if (ms > 0) out.push({ t: 'wait', ms, why: a.type });
        }
      }
    }
    return out;
  }

  /**
   * 信号落到哪个状态、那个状态 onEnter 演什么。同一张图里同一信号去往不同状态(条件分支)时要 walk.via 点名,否则不猜。
   * 进了状态记进世界模型,再顺着 master 进状态时广播的 `state:<图>:<状态>` 连锁往下推(主图 s0x 就是这样跟着各拍走的)。
   */
  signal(sig, walk, depth, seen) {
    const trans = this.D.bySignal.get(sig) ?? [];
    // 防环按「信号 + 监听它的图此刻所在状态」:同一信号在图走到别处之后再发一次是正经的下一跳(送货 songhuo_returned:
    // 先 survived → litiangou_peril,救场后 litiangou_rescue → returned),图没动的重发才是环
    const key = `${sig}#${[...new Set(trans.map((t) => t.graph))].map((g) => this.world.narOf(g).active).join('|')}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const out = [];
    const byGraph = new Map();
    for (const t of trans) {
      if (!byGraph.has(t.graph)) byGraph.set(t.graph, []);
      byGraph.get(t.graph).push(t);
    }
    for (const [gid, ts] of byGraph) {
      const tos = new Set(ts.map((t) => t.to));
      // 同图多个去处:推演的当前状态恰好对上一条的起点就走那条;对不上再看 walk.via 点名
      const cur = this.world.narOf(gid).active;
      const fromHit = [...new Set(ts.filter((t) => t.from === cur).map((t) => t.to))];
      let to = null;
      if (tos.size === 1) to = [...tos][0];
      else if (fromHit.length === 1) to = fromHit[0];
      else if (walk.via?.[sig] && tos.has(walk.via[sig])) to = walk.via[sig];
      if (!to) continue;
      this.world.narEnter(gid, to);
      const st = this.D.graphs.get(gid)?.states?.[to];
      out.push(...this.actions(st?.onEnterActions, walk, depth, seen));
      out.push(...this.signal(`state:${gid}:${to}`, walk, depth, seen));
    }
    return out;
  }

  sceneEnter(sceneId, walk, depth, seen) {
    return this.actions(this.D.scene(sceneId)?.onEnter, walk, depth, seen);
  }

  /** 从 choice 的每个选项往下走(不跨下一个 choice),找第一个发出匹配信号的选项 */
  optionEmitting(graphId, nodeId, re) {
    const g = this.D.dialogue(graphId);
    const n = g?.nodes?.[nodeId];
    if (n?.type !== 'choice') return null;
    for (const [i, o] of arr(n.options).entries()) {
      const seenNodes = new Set();
      const q = [o?.next];
      while (q.length) {
        const id = q.shift();
        if (!id || seenNodes.has(id)) continue;
        seenNodes.add(id);
        const m = g.nodes[id];
        if (!m || m.type === 'choice') continue;
        if (m.type === 'runActions' && arr(m.actions).some((a) => a?.type === 'emitNarrativeSignal' && re.test(String(a.params?.signal)))) return i;
        if (m.next) q.push(m.next);
        if (m.defaultNext) q.push(m.defaultNext);
        for (const c of arr(m.cases)) q.push(c?.next);
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------- 脚本

class Script {
  /**
   * @param ctx {D, W, viewport}
   * @param o.mode 'beat' | 'chain'(长管线:只留大检查点、长过场跳过、夜只推一次)
   */
  constructor(ctx, { mode = 'beat', scene = null, label = '' } = {}) {
    this.D = ctx.D;
    // 每条脚本自己的世界模型 + Walker(位置 / 叙事推演不串条)
    this.world = new World(ctx.D);
    this.W = new Walker(ctx.D, this.world);
    this.viewport = ctx.viewport;
    this.mode = mode;
    this.chain = mode === 'chain';
    this.scene = scene;
    this.label = label;
    this.steps = [];
    this.refs = [];
    this.notes = [];
    this.isNight = false;
  }

  ref(kind, id, extra = {}) {
    if (id === undefined || id === null || id === '') return;
    this.refs.push({ kind, id, ...extra });
  }

  push(...s) {
    // 脚本直接重放的发物 / 收物也记进世界模型(has_item_* 叶子)
    for (const st of s) {
      const a = st?.cmd?.type === 'debugExecuteAction' ? st.cmd.action : null;
      if (a?.type === 'giveItem') this.world.itemDelta(a.params?.id, num(Number(a.params?.count), 1));
      else if (a?.type === 'removeItem') this.world.itemDelta(a.params?.id, -num(Number(a.params?.count), 1));
    }
    this.steps.push(...s);
    return this;
  }

  adv(n) {
    if (n > 0) this.steps.push(adv(n));
    return this;
  }

  /** 检查点;长管线里只留 major 的 */
  cp(name, major = false) {
    if (this.chain && !major) return this;
    this.steps.push(cpStep(name));
    return this;
  }

  /** 补完打字机再拍(别截到打了一半的字) */
  observe(name, major = false) {
    if (this.chain && !major) return this;
    this.push(api('completeDialogueText'), api('completeCutsceneText'), adv(2));
    return this.cp(name, major);
  }

  /** 一轮推进:补完 → 推进对白(可关)→ 点一下 → 走 every 帧 →(检查点)→ 一个键 */
  iter({ every = DLG_EVERY, cpName = null, k = ANY_KEY, dialogue = true } = {}) {
    this.push(api('completeCutsceneText'));
    if (dialogue) this.push(api('completeDialogueText'), cmd('playerAdvance'));
    this.push(cmd('playerTap'), adv(every));
    if (cpName) this.cp(cpName);
    if (k) this.push(key(k));
    return this;
  }

  pump(label, n, { every = DLG_EVERY, cpEvery = 0, k = ANY_KEY, dialogue = true } = {}) {
    for (let i = 1; i <= n; i++) this.iter({ every, k, dialogue, cpName: cpEvery && (i % cpEvery === 0 || i === n) ? `${label}.${i}` : null });
    return this;
  }

  inScene(id) {
    this.scene = id;
    this.push({ inScene: id });
    this.ref('scene', id);
    return this;
  }

  // ---------------- 进场 / 收尾

  /** 进场:+30 帧拍一张,再把跳转点最后一跳的 onEnter 演出(发物 / 过场 …)推完 */
  start(bootSegs = []) {
    this.adv(30);
    this.cp('enter+30', true);
    if (bootSegs.length) this.play(bootSegs, 'boot');
    return this;
  }

  /** 面板一圈:背包 I / 任务 Tab / 规矩 R / 书架 B / 地图 M / 对话记录 L / 暂停菜单 Esc,开 → 拍 → 同一键关 */
  ui(label = 'ui', major = false) {
    this.pump(`${label}.settle`, 2, { k: ANY_KEY });
    this.cp(`${label}.before`, major);
    for (const [k, name] of [['KeyI', 'inventory'], ['Tab', 'quest'], ['KeyR', 'rules'], ['KeyB', 'bookshelf'], ['KeyM', 'map'], ['KeyL', 'log'], ['Escape', 'menu']]) {
      this.push(key(k), adv(14));
      this.cp(`${label}.${name}`, major);
      this.push(key(k), adv(10));
    }
    this.cp(`${label}.closed`, major);
    return this;
  }

  // ---------------- 世界里的交互

  sceneData() {
    return this.D.scene(this.scene);
  }

  /**
   * 把人放进区里(onEnter 照常触发);onInteract 的区再按一下 E。
   * 摆人点避开要命的威胁圈(见 zonePoint);区的条件(连同所属分组的条件)按世界模型的叙事推演核一遍,判得出「不成立」就记
   * 一条 zoneGate 引用(`--list` 报错:master 上把人放进去也不会触发,后面排的节拍全落空)。
   */
  zone(zoneId, walk = {}, label = zoneId) {
    this.ref('zone', zoneId, { scene: this.scene });
    const sd = this.sceneData();
    const z = arr(sd?.zones).find((x) => x?.id === zoneId);
    const p = z ? zonePoint(sd, z) : null;
    if (!p) return this;
    if (p.threat) this.ref('unsafePlacement', zoneId, { scene: this.scene, threat: p.threat, x: p.x, y: p.y });
    const groupConds = z.group ? arr(sd?.entityGroups).find((g) => g?.id === z.group)?.conditions : undefined;
    const gate = this.world.evalCond([...arr(groupConds), ...arr(z.conditions)]);
    if (gate.v === 'F') this.ref('zoneGate', zoneId, { scene: this.scene, why: gate.why.join(';') });
    this.push(cmd('debugSetPlayerPosition', { x: p.x, y: p.y, snapCamera: true }), adv(6));
    this.world.place('player', p);
    let segs = this.W.actions(z.onEnter, walk);
    if (walk.interact || (!arr(z.onEnter).length && arr(z.onInteract).length)) {
      this.push(cmd('playerInteract'), adv(6));
      segs = this.W.actions(z.onInteract, walk);
    }
    this.adv(14);
    return this.play(segs, label);
  }

  talk(npcId, walk = {}, label = npcId) {
    this.ref('npc', npcId, { scene: this.scene });
    const npc = arr(this.sceneData()?.npcs).find((x) => x?.id === npcId);
    this.push(cmd('debugInteractNpc', { npcId }), adv(20));
    const gid = npc?.dialogueGraphId;
    return this.play(gid ? this.W.dialogue(gid, walk) : [], label);
  }

  inspect(hotspotId, walk = {}, label = hotspotId) {
    this.ref('hotspot', hotspotId, { scene: this.scene });
    const hs = arr(this.sceneData()?.hotspots).find((x) => x?.id === hotspotId);
    this.push(cmd('debugTriggerHotspot', { hotspotId }), adv(20));
    const d = hs?.data ?? {};
    let segs = [];
    if (typeof d.graphId === 'string' && d.graphId) segs = this.W.dialogue(d.graphId, { ...walk, entry: d.entry });
    else {
      if (typeof d.text === 'string' && d.text.trim()) segs.push({ t: 'line', src: 'inspect' });
      segs.push(...this.W.actions(d.actions, walk));
    }
    return this.play(segs, label);
  }

  /** 过场景热区(debugTriggerHotspot = 与玩家按 E 同一条处理;autoTrigger 的也走它) */
  transition(hotspotId, walk = {}) {
    this.ref('hotspot', hotspotId, { scene: this.scene });
    const hs = arr(this.sceneData()?.hotspots).find((x) => x?.id === hotspotId);
    const target = hs?.data?.targetScene;
    const spawn = typeof hs?.data?.targetSpawnPoint === 'string' && hs.data.targetSpawnPoint ? hs.data.targetSpawnPoint : null;
    this.push(cmd('debugTriggerHotspot', { hotspotId }));
    this.sceneWait(`${hotspotId}.leaving`);
    if (!target) return this;
    // 热区点名的出生点也对账(目标场景没有 → master 静默退回缺省出生点;两边同一份数据,算数据缺陷不算渲染差异)
    if (spawn) this.ref('spawn', spawn, { scene: target, via: `${this.scene}:${hotspotId}` });
    this.world.enterScene(target, spawn);
    this.inScene(target);
    this.cp(`scene:${target}`);
    return this.play(this.W.sceneEnter(target, walk, 1, new Set()), `enter:${target}`);
  }

  /** dev 切场景(地图传送 / 长管线跨拍用) */
  switchTo(sceneId, spawnPoint = null, walk = {}) {
    this.push(cmd('debugSwitchScene', { sceneId, ...(spawnPoint ? { spawnPoint } : {}) }));
    this.sceneWait(`switch:${sceneId}.leaving`);
    this.world.enterScene(sceneId, spawnPoint);
    this.inScene(sceneId);
    if (spawnPoint) this.ref('spawn', spawnPoint, { scene: sceneId });
    this.cp(`switch:${sceneId}`);
    return this.play(this.W.sceneEnter(sceneId, walk, 1, new Set()), `enter:${sceneId}`);
  }

  /** 跳跃点:站到 align 上按跳 */
  actSpot(hotspotId, walk = {}) {
    this.ref('hotspot', hotspotId, { scene: this.scene });
    const hs = arr(this.sceneData()?.hotspots).find((x) => x?.id === hotspotId);
    const d = hs?.data ?? {};
    const al = d.align ?? { x: hs?.x, y: hs?.y };
    if (!Number.isFinite(al?.x) || !Number.isFinite(al?.y)) return this;
    this.push(cmd('debugSetPlayerPosition', { x: al.x, y: al.y, snapCamera: true }), adv(6));
    this.cp(`${hotspotId}.align`);
    this.push(cmd('playerAct', { verb: arr(d.verbs)[0] ?? 'jump' }), adv(40));
    this.world.place('player', null); // 跳完落在哪不知道

    return this.play(this.W.actions(d.actions, walk), hotspotId);
  }

  /** 切场景的等待:淡出途中拍一张(遮幕 / 装载中的样子),再等到新场景揭幕 */
  sceneWait(name) {
    this.adv(24);
    this.cp(name);
    return this.adv(SCENE_FRAMES - 24);
  }

  /** 真键盘 */
  press(k, frames = 30, name = null) {
    this.push(key(k), adv(frames));
    if (name) this.cp(name);
    return this;
  }

  hold(k, frames, name = null) {
    this.push({ keyDown: k }, adv(Math.round(frames / 2)));
    if (name) this.cp(name);
    this.push(adv(frames - Math.round(frames / 2)), { keyUp: k });
    return this;
  }

  /** 夜:重放 序章_街巷_赌坊门卫 n_6 里那条 advanceTimeTo(找不到退回 夜 + fade) */
  night() {
    if (this.isNight) return this;
    let params = { phase: '夜', transition: 'fade' };
    const g = this.D.dialogue('序章_街巷_赌坊门卫');
    for (const n of Object.values(g?.nodes ?? {})) {
      const a = arr(n?.actions).find((x) => x?.type === 'advanceTimeTo');
      if (a) params = clone(a.params);
    }
    this.push(act('advanceTimeTo', params), adv(150));
    this.cp(`time:${params.phase}`, true);
    this.adv(150);
    this.isNight = true;
    return this;
  }

  /** 道具的 use.actions 原样跑一遍(= 背包里点「用」) */
  useItem(itemId, name = null) {
    this.ref('item', itemId);
    const it = this.D.items.get(itemId);
    for (const a of arr(it?.use?.actions)) this.push(act(a.type, clone(a.params ?? {})));
    this.adv(20);
    if (name) this.cp(name);
    return this;
  }

  /** debugSetNarrativeState 一跳 + 该状态 onEnter 的演出推完 */
  setState(graphId, stateId, walk = {}) {
    this.ref('narrative', graphId, { state: stateId });
    this.push(cmd('debugSetNarrativeState', { graphId, stateId }), adv(6));
    this.world.narEnter(graphId, stateId);
    const st = this.D.graphs.get(graphId)?.states?.[stateId];
    return this.play(this.W.actions(st?.onEnterActions, walk), `state:${stateId}`);
  }

  /** 沿拓扑最短路逐跳推(与 dev 跳转点同口径);够不着:非 scenario 图从目标那一串的根逐跳(见 rootPath),再不行一发直达 */
  jump(graphId, from, to, walk = {}) {
    const g = this.D.graphs.get(graphId);
    const p = bfsPath(g, from, to) ?? rootPath(g, to) ?? [to];
    for (const s of p) this.setState(graphId, s, walk);
    return this;
  }

  /** 状态已由 reactive 迁移进入时,把它 onEnter 的演出推完(只排节拍,不发命令) */
  stateEnter(graphId, stateId, walk = {}) {
    this.ref('narrative', graphId, { state: stateId });
    this.world.narEnter(graphId, stateId);
    const st = this.D.graphs.get(graphId)?.states?.[stateId];
    return this.play(this.W.actions(st?.onEnterActions, walk), `reactive:${stateId}`);
  }

  // ---------------- 演出 / 小游戏

  /** @param cost Walker 排节拍时按当时世界模型估好的 {frames, clicks};缺省现估 */
  cutscene(id, label, cost = null) {
    this.ref('cutscene', id);
    const c = this.D.cutscenes.get(id);
    cost = cost ?? (c ? cutsceneCost(c, this.W.env) : { frames: 300, clicks: 3 });
    if (this.chain && cost.frames > CHAIN_SKIP_FRAMES) {
      // 长管线:开演 45 帧拍一张,Esc 二次确认跳过(3 s 窗口内再按一次),再推两轮兜住跳过后接着来的台词
      this.adv(45);
      this.cp(`${label}.cs:${id}+45`, true);
      this.push(key('Escape'), adv(12), key('Escape'), adv(40));
      this.iter({ every: CS_EVERY, dialogue: false });
      return this;
    }
    const n = Math.ceil(cost.frames / CS_EVERY) + cost.clicks + 2;
    const want = this.chain ? 0 : Math.min(8, Math.max(2, Math.round(cost.frames / 240)));
    const every = want ? Math.max(1, Math.floor(n / want)) : 0;
    for (let i = 1; i <= n; i++) {
      this.iter({ every: CS_EVERY, dialogue: false, cpName: every && i % every === 0 ? `${label}.cs:${id}#${i}` : null });
    }
    return this;
  }

  /**
   * 长按条(PressureHoldUI:按住 Space 充能,每段开头 holding 复位成 false、只认新的 keydown;松手回落到 0;
   * `abortOnReleaseFromRatio` 以上松手 = 失败)。所以**全程不松手**:开头按下 Space,之后每一轮再发一次 keyDown
   * (已按住时 Playwright 发的是 repeat keydown:长按条认、DialogueUI / 点击继续都不认),interrupt 带出来的台词
   * 靠 playerAdvance / playerTap 推(不走 Space)。时长按停点折算、interrupt 之后的段按从 0 充起算(没按住那几帧会回落),
   * 多按不要紧:到停点本段就结束。完事再松。
   */
  pressureHold(id, label) {
    this.ref('pressureHold', id);
    const h = this.D.holds.get(id);
    const fill = num(h?.fillSeconds, 3);
    const ints = arr(h?.interrupts).filter((x) => Number.isFinite(x?.atRatio)).sort((a, b) => a.atRatio - b.atRatio);
    const talkFrames = (actions) => this.W.actions(actions, {}).reduce((m, g) => m + (g.t === 'line' ? DLG_EVERY : g.t === 'wait' ? (g.ms / 1000) * 60 : 0), 0);
    let frames = 0;
    let stop = 1;
    for (const [i, it] of ints.entries()) {
      frames += it.atRatio * fill * 60 * (i === 0 ? 1 : 1.1) + talkFrames(it.actions);
      if (it.abort) {
        stop = it.atRatio;
        break;
      }
    }
    if (stop === 1) frames += fill * 60 * (ints.length ? 1.1 : 1) + talkFrames(h?.onComplete);
    const n = Math.ceil((frames + 30) / DLG_EVERY);
    const cps = Math.min(6, Math.max(2, ints.length * 2 + 1));
    const every = Math.max(1, Math.floor(n / cps));
    this.adv(20);
    this.cp(`${label}.hold:${id}`);
    this.push({ keyDown: 'Space' });
    for (let i = 1; i <= n; i++) {
      this.push(api('completeDialogueText'), cmd('playerAdvance'), cmd('playerTap'), adv(DLG_EVERY));
      if (i % every === 0) this.cp(`${label}.hold:${id}#${i}`);
      this.push({ keyDown: 'Space' });
    }
    this.push({ keyUp: 'Space' }, adv(10));
    this.cp(`${label}.hold:${id}.released`);
    return this;
  }

  /** 水下捞箱:按实例 bounds 与画面同口径(min(sw/bw, sh/bh)×0.92 居中)算要拉的那件在屏幕上的位置,点它、按住空格拉,最后 Esc 出水 */
  waterMinigame(id, label) {
    this.ref('waterMinigame', id);
    const w = this.D.water(id);
    const bw = num(w?.bounds?.width, 720);
    const bh = num(w?.bounds?.height, 480);
    const { width: vw, height: vh } = this.viewport;
    const scale = Math.min(vw / bw, vh / bh) * 0.92;
    const ox = (vw - bw * scale) / 2;
    const oy = (vh - bh * scale) / 2;
    const target = arr(w?.entities).find((e) => e?.pull) ?? arr(w?.entities)[0];
    const pt = target?.pos
      ? { x: Math.round(ox + target.pos.x * scale), y: Math.round(oy + target.pos.y * scale) }
      : { x: Math.round(vw / 2), y: Math.round(vh / 2) };
    this.adv(60);
    this.cp(`${label}.water:${id}`);
    this.push({ click: pt }, adv(20));
    this.cp(`${label}.water.pick`);
    this.hold('Space', 180, `${label}.water.pull`);
    this.adv(30);
    this.cp(`${label}.water.pull-end`);
    this.hold('Space', 120);
    this.adv(30);
    this.push(key('Escape'), adv(40));
    this.cp(`${label}.water.exit`);
    return this;
  }

  /**
   * 把一串节拍段演完。每句台词:(要拍就先补完再拍)→ 一轮推进(推进键之后按的是**下一组选项要选的那个数字键**,
   * 这样预测差一两句时选项照样选对,只是那一帧没拍到);每组选项:拍 → 按数字键。结尾再推两轮兜底。
   */
  play(segs, label, { sweep = 2 } = {}) {
    const nextDigit = (i) => {
      for (let j = i; j < segs.length; j++) if (segs[j].t === 'options') return digitKey(segs[j].index);
      return null;
    };
    let lastDigit = null;
    let lineNo = 0;
    let forceCp = null;
    let opened = false;
    let any = false;
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i];
      switch (g.t) {
        case 'dialogue':
          this.ref('dialogue', g.graph);
          break;
        case 'route':
          this.ref('dialogueNode', g.graph, { node: g.node, next: g.next });
          break;
        case 'signal':
          this.ref('signal', g.id);
          break;
        case 'item':
          this.ref('item', g.id);
          forceCp = `${label}.item:${g.id}`;
          break;
        case 'line': {
          any = true;
          lineNo++;
          const name = forceCp ?? (!opened ? `${label}.open` : lineNo % LINE_CP_EVERY === 0 ? `${label}.l${lineNo}` : null);
          if (name) this.observe(name);
          opened = true;
          forceCp = null;
          this.iter({ k: nextDigit(i + 1) ?? lastDigit ?? ANY_KEY });
          break;
        }
        case 'options':
          any = true;
          if (g.graph) this.ref('dialogueNode', g.graph, { node: g.node, index: g.index, type: 'choice' });
          this.adv(6);
          this.observe(`${label}.choice@${g.node ?? 'action'}`);
          opened = true;
          lastDigit = digitKey(g.index);
          this.push(key(lastDigit), adv(DLG_EVERY));
          break;
        case 'cutscene':
          any = true;
          this.cutscene(g.id, label, g.cost);
          break;
        case 'hold':
          any = true;
          this.pressureHold(g.id, label);
          break;
        case 'water':
          any = true;
          this.waterMinigame(g.id, label);
          break;
        case 'shop':
          any = true;
          this.ref('shop', g.id);
          this.adv(20);
          this.cp(`${label}.shop:${g.id}`);
          this.push(key('Escape'), adv(20));
          break;
        case 'map':
          any = true;
          this.adv(30);
          this.cp(`${label}.map`);
          this.push(key('Escape'), adv(20));
          break;
        case 'note':
          any = true;
          this.ref('systemNote', g.id);
          this.adv(24);
          this.cp(`${label}.note:${g.id}`);
          this.push(key(ANY_KEY), adv(12));
          break;
        case 'scene':
          any = true;
          this.sceneWait(`${label}.leaving:${g.id}`);
          this.inScene(g.id);
          if (g.spawn) this.ref('spawn', g.spawn, { scene: g.id });
          this.cp(`${label}.scene:${g.id}`);
          break;
        case 'wait': {
          // 长一点的纯耗时(表情气泡 / 走位 / 缓推镜 / 淡入淡出 / 等待)中途拍一张:演出进行到一半的样子;
          // 几十秒的(呼吸图渐弱)每 LONG_WAIT_CP_MS 再多拍一张
          const f = Math.round((g.ms / 1000) * 60) + 2;
          if (g.ms >= 1200 && !this.chain) {
            const parts = Math.max(2, Math.ceil(g.ms / LONG_WAIT_CP_MS));
            let done = 0;
            for (let k = 1; k < parts; k++) {
              const at = Math.round((f * k) / parts);
              this.adv(at - done);
              done = at;
              this.cp(k === 1 ? `${label}.${g.why ?? 'wait'}` : `${label}.${g.why ?? 'wait'}.${k}`);
            }
            this.adv(f - done);
          } else {
            this.adv(f);
          }
          break;
        }
        default:
          break;
      }
    }
    if (forceCp) this.observe(forceCp);
    if (any || segs.some((g) => g.t === 'signal')) {
      for (let i = 0; i < (this.chain ? Math.min(1, sweep) : sweep); i++) this.iter({ k: lastDigit ?? ANY_KEY });
      this.cp(`${label}.end`);
    }
    return this;
  }
}

// ---------------------------------------------------------------- 各拍

/** 跳转点把某张图推到哪(recipe);最后一跳的 onEnter 是否带要等玩家的演出(带了就不能拿它冷启动:它在 dev_room 里等点击) */
function warpRecipe(D, warp) {
  const out = [];
  if (warp?.flowGraph && warp.flowState) out.push({ graph: warp.flowGraph, state: warp.flowState });
  for (const s of arr(warp?.set)) if (s?.graph && s?.state) out.push({ graph: s.graph, state: s.state });
  return out;
}

function warpBootSegs(D, W, warp) {
  const segs = [];
  let blocking = false;
  for (const r of warpRecipe(D, warp)) {
    const g = D.graphs.get(r.graph);
    if (!g || r.state === g.initialState) continue;
    const acts = arr(g.states?.[r.state]?.onEnterActions);
    if (acts.some((a) => BLOCKING_ACTIONS.has(a?.type))) blocking = true;
    segs.push(...W.actions(acts, {}));
  }
  return { segs, blocking };
}

/**
 * 每拍:warp = 冷启动用的跳转点(同名);bootWarp = 该跳转点最后一跳自带要点击的演出、没法拿它冷启动时改用的跳转点
 * (随后在脚本里按原跳转点的 recipe 补状态);run(s) = 这一拍怎么玩(s.chain = 长管线模式);ends = 这一拍玩完主图 / 子图该落在哪(长管线跨拍补状态用)。
 */
const BEATS = [
  {
    id: '听书', warp: '听书', ends: { flow_xungou_main: 'state_2', scenario_听书: 'kicked_out' },
    note: '进茶馆自动开的听书开场:说书三段过场 → 点击继续 → 被赶 → 景别复位 → 切到雾津街头',
    run(s) {
      // 场景 onEnter 已经开了这张图(就绪时攥着切换);contextState 走主图 initial 那支
      s.play(s.W.dialogue('序章_寻狗_听书开场', { route: { n_1: 'fire_cutscene' } }), '听书开场');
    },
  },
  {
    id: '找吃的', warp: '找吃的', ends: { flow_xungou_main: 'state_4' },
    note: '包子铺气味首现(说明卡)→ 吃饭点 → 后巷官差发崖墓尸活(长过场)→ 回街上 → 癞子显摆(三选第 0 项)',
    run(s) {
      s.zone('z_包子铺_初闻');
      s.inspect('主线_吃饭点A');
      s.transition('T_去后巷子');
      s.zone('new_zone_0', { route: { n_1: 'n_4' } }, '崖墓任务发布');
      s.transition('T_回雾津街头');
      s.zone('Zone_癞子第一次出现', { interact: true }, '癞子显摆');
    },
  },
  {
    id: '找吃的~赌坊', warp: '找吃的', ends: { flow_xungou_main: 'state_6' }, night: true,
    note: '找吃的后半段(同一跳转点起,主图 state_2 → state_4 逐跳补):路遇私铸钱(三段过场 + 三把火说明卡)→ 赌坊看场 → 赌坊输钱过场 → 入夜(换夜原画)',
    run(s) {
      if (!s.chain) s.jump('flow_xungou_main', 'state_2', 'state_4');
      s.zone('Zone_路遇私铸钱', {}, '路遇私铸钱');
      s.talk('街巷_赌坊门卫', { route: { n_7: 'n_6' } }, '赌坊');
      s.adv(120);
      s.cp('night', true);
      s.isNight = true;
    },
  },
  {
    id: '夜巡找癞子', warp: '夜巡找癞子', ends: { flow_xungou_main: 'state_8' }, nightBeat: true,
    note: '先重放赌坊对白里那条 advanceTimeTo 夜(跳转点不跑对白,夜巡的人只在夜里出现)→ 夜遇癞子(两组选项第 0 项)→ 打更人给上山的家伙 + 开铺子(Esc 关)',
    run(s) {
      s.night();
      s.zone('Zone_夜遇癞子', {}, '夜遇癞子');
      s.talk('npc_夜巡_打更人', { route: { n_branch: 'n_ask' }, ifs: true }, '打更人');
    },
  },
  {
    id: '出南门', warp: '出南门', ends: { flow_xungou_main: 'state_9', scenario_夜出南门: '到跑马梁', wrapper_跑马梁_风火引路: '下梁' }, nightBeat: true,
    note: '入夜 → (跳转点不发东西:重放打更人 n_hand 的 giveItem + 铺子里 0 价的洋火)→ 出南门 → 南头没点火(说明卡)→ 纤藤上手、设洋火为火种、T 点着 → 望山弹地图(Esc 关,地图节点坐标推不出 → debugSwitchScene 跑马梁 代替点地图)→ 迎风 / 护火说明卡 / Q 护火 → 风口过场(人走到 (485, 935),出了喊声 / 香火两个区)→ 跟脚 → 有人喊(喊声区顶点平均离路边身影只 54 px、近身 1000 HP/s,火又被风吹熄了 → 摆人点改在区里离它 boundaryRadius 之外)/ 点火教学两张说明卡 → T 重点 → 闻到香火 → 和尚坡进崖墓入口',
    run(s) {
      s.night();
      if (!s.chain) {
        // 打更人 n_hand 里给的东西(条件都是「身上没有」,冷启动必然都给)
        const g = s.D.dialogue('序章_夜巡打更人_备上山');
        for (const a of arr(g?.nodes?.n_hand?.actions)) {
          for (const x of a?.type === 'runActionsIf' ? arr(a.params?.actions) : [a]) {
            if (x?.type === 'giveItem') {
              s.ref('item', x.params?.id);
              s.push(act('giveItem', clone(x.params)));
            }
          }
        }
      }
      // 茶馆杂货里的洋火(0 价)= 在铺子里买了 3 根
      const shop = s.D.shops.get('teahouse_shop');
      const igniter = arr(shop?.items).find((x) => s.D.items.get(x?.itemId)?.igniter)?.itemId ?? 'yanghuo';
      s.ref('shop', 'teahouse_shop');
      s.ref('item', igniter);
      s.push(act('giveItem', { id: igniter, count: 3 }), adv(30));
      s.cp('items');
      s.transition('T_出南门');
      s.zone('z_南门小路_南头', { via: { nanmen_road_end: '点火' } }, '南头');
      s.useItem('torch', 'torch.held');
      s.push(act('setActiveIgniter', { item: igniter }), adv(10));
      s.press('KeyT', 45, 'torch.lit');
      s.stateEnter('scenario_夜出南门', '望山');
      s.switchTo('跑马梁', null, { via: { 跑马梁_进场: '迎风' } });
      s.zone('Zone_跑马梁_护火', {}, '护火');
      s.hold('KeyQ', 60, 'guard');
      s.adv(30);
      s.cp('guarded');
      s.zone('Zone_跑马梁_阵风', {}, '风口');
      s.zone('Zone_跑马梁_喊声', {}, '有人喊');
      s.press('KeyT', 45, 'torch.relit');
      s.zone('Zone_跑马梁_香火', {}, '香火');
      s.transition('T_到崖墓');
    },
  },
  {
    id: '背尸', warp: '背尸', ends: { scenario_背尸: 'fled', scenario_梦待死之礼: 'road' },
    note: '进崖墓(进场过场)→ 看尸:捡帕子包(发物)→ 长按背尸(两次 interrupt:力被吞 / 打照面叠图)→ 鬼打墙三回(第三回坠潭、死亡系绳)→ 回雾津街头',
    run(s) {
      s.zone('z_崖墓进场', {}, '崖墓进场');
      s.inspect('hs_女尸', {}, '背尸');
      s.zone('z_鬼打墙', { route: { root: 'loop1a' } }, '鬼打墙1');
      s.zone('z_鬼打墙', { route: { root: 'loop2_sfx' } }, '鬼打墙2');
      s.zone('z_鬼打墙', { route: { root: 'fall1' } }, '鬼打墙3');
    },
  },
  {
    id: '背尸_跑马梁', warp: '背尸_跑马梁', ends: { wrapper_崖墓入口_认路: '认得路' }, nightBeat: true,
    note: '入夜 → 跑马梁不带火(往前走)→ 风口过场 → 有人喊(摆人点避开路边身影的威胁圈,理由同「出南门」)/ 点火教学说明卡 → 香火 → 崖墓入口 → 牛头凼口(叠图、翻上去)→ 牛头凼远眺 → 回崖墓入口 → 栈道口(前进)→ 崖墓前段跳 → 崖墓前段后跳 → 崖墓后段 → 崖墓(六图)',
    run(s) {
      if (!s.chain) {
        s.night();
        s.zone('Zone_跑马梁_阵风', {}, '风口');
        s.zone('Zone_跑马梁_喊声', {}, '有人喊');
        s.zone('Zone_跑马梁_香火', {}, '香火');
        s.transition('T_到崖墓');
      } else if (s.scene !== '崖墓入口') {
        s.switchTo('崖墓入口');
      }
      s.zone('Zone_崖墓入口_牛头凼口', { ifs: true }, '牛头凼口');
      s.transition('T_到崖墓入口');
      s.zone('Zone_崖墓入口_栈道口', { route: { sw_known: 'c_go' } }, '栈道口');
      s.actSpot('T_到前段1');
      s.actSpot('T_到崖墓后段');
      s.transition('T_到崖墓');
    },
  },
  {
    id: '梦待死之礼', warp: '梦待死之礼', ends: { scenario_梦待死之礼: 'woken', flow_xungou_main: 's02b_meng' },
    note: '入梦区 → 夜路 → 农家院 → 饭屋(倒头饭叠图、chooseAction【吃】)→ 里屋(盖脸纸呼吸图;n_fade 的 fadeOut + wait 按资产参数要等约 42 s:第一口深叹走完 + 变浅 + 最后一丝 + 真停后出字)→ gasp → 醒来土路 → 回雾津街头',
    run(s) {
      s.zone('z_梦待死之礼', {}, '入梦');
      s.zone('z_梦_到农家院', {}, '到农家院');
      s.zone('z_进屋', {}, '进屋');
      s.zone('z_饭桌', {}, '饭桌');
      s.zone('z_门板', { ifs: true }, '门板');
    },
  },
  {
    id: '吹牛', warp: '吹牛', ends: { scenario_吹牛: 'spread', flow_xungou_main: 's03_chuiniu', scenario_婆子家: 'hired' },
    lead: { hotspot: 'T_进茶馆' },
    note: '茶客堆吹牛(两组选项第 0 项,师承种子 → 规矩理层)→ 出门 → 找上门的婆子(接单 → 进婆子家院)',
    run(s) {
      s.inspect('hs_茶客吹牛', {}, '吹牛');
      s.transition('exit_to_street');
      s.talk('npc_婆子', {}, '婆子上门');
    },
  },
  {
    id: '婆子家', warp: '婆子家', ends: { scenario_婆子家: 'paid', flow_xungou_main: 's04_pozi' },
    note: '院外扫脸色(脚本台词)→ 读人婆子 / 儿子 → 板着脸宣布(风向变了、收钱)→ 出院子去河边',
    run(s) {
      s.zone('z_院外扫脸色', {}, '院外');
      s.talk('npc_院中婆子', {}, '读婆子');
      s.talk('npc_她儿子', {}, '读儿子');
      s.inspect('hs_院中宣布', {}, '宣布');
      s.transition('T_出院子');
    },
  },
  {
    id: '河边', warp: '河边', ends: { scenario_河边: 'fled', flow_xungou_main: 's05_hebian' },
    note: '河边递纸(鬼手叠图、选项第 0 项、纸钱 ×5)→ 回城 → 去码头',
    run(s) {
      s.zone('z_河边递纸', {}, '递纸');
      s.transition('T回城');
      s.transition('T_去码头');
    },
  },
  {
    id: '码头', warp: '码头', ends: { scenario_码头: 'resolved', flow_xungou_main: 's06_laoxiang', scenario_枯井: 'hired' },
    note: '走到水边:表情 / 缓推镜 / 走位 / 脚本台词 → 洋人第一次出场长过场 → 三选第 0 项跳水捞箱 → 水下小游戏(点箱子、空格拉、Esc)→ 抓痕 / 罗盘叠图、银角子 → 名声蒙太奇 → 回街上 → 枯井街坊上门(接活 → 枯井土地庙)',
    run(s) {
      s.zone('new_zone_2', {}, '码头水边');
      s.transition('T码头到街巷');
      s.talk('npc_枯井街坊', {}, '枯井街坊');
    },
  },
  {
    id: '枯井', warp: '枯井', ends: { scenario_枯井: 'fled' },
    note: '井边哭声(脚本台词)→ 往井下看(狗脸叠图)→ 跑回街上 → 进茶馆',
    run(s) {
      s.zone('z_井边哭声', {}, '井边');
      s.inspect('hs_枯井', {}, '枯井');
      s.transition('T_进茶馆');
    },
  },
  {
    id: '向导', warp: '向导', ends: { scenario_向导: 'outfitted', flow_xungou_main: 's08_xiangdao', scenario_送货: 'bundle_taken' },
    note: '茶馆告示 → 出门围观竞争 → 当铺道袍 / 庙会罗盘 / 城东桃木(三件发物)→ 回人堆披上(置办蒙太奇 + 道士行头)→ 送货雇主(接包袱 → 阎王岭山口)',
    run(s) {
      s.inspect('hs_向导传闻', {}, '告示');
      s.transition('exit_to_street');
      s.talk('hs_围观人群', {}, '围观');
      s.inspect('hs_当铺道袍', {}, '道袍');
      s.inspect('hs_庙会罗盘', {}, '罗盘');
      s.inspect('hs_城东桃木', {}, '桃木');
      s.talk('hs_围观人群', { route: { root: 'dress_intro' } }, '披上行头');
      s.talk('npc_送货雇主', {}, '送货雇主');
    },
  },
  {
    id: '送货', warp: '送货', ends: { scenario_送货: 'returned', flow_xungou_main: 's09_songhuo' },
    note: '同行闲扯过场(规矩象层)→ X 点一(脚本台词)→ X 点二 / 三喊对名字(选发 *_right 的那项)→ 歇脚棚放包袱 → 看进山路:夜路回程长对白 + 长按别应声(两次 interrupt)→ 李天狗救场 → 回雾津街头 → 义庄管事上门(进义庄)',
    run(s) {
      s.zone('z_同行闲扯', {}, '同行闲扯');
      s.zone('z_X点一', {}, 'X点一');
      for (const [hs, graph, name] of [['hs_X点二_林边', '线外_寻狗_喊名_点二', 'X点二'], ['hs_X点三_林边', '线外_寻狗_喊名_点三', 'X点三']]) {
        const idx = s.W.optionEmitting(graph, 'c1', /_right$/) ?? 0;
        s.inspect(hs, { choices: { c1: idx } }, name);
      }
      s.inspect('hs_歇脚棚', {}, '歇脚棚');
      s.inspect('hs_进山的路', { route: { sw_p3: 'p3r_call', sw_awk_p3: 'awk3_1', sw_p2: 'p2r' }, via: { songhuo_returned: 'litiangou_peril' } }, '进山路');
      s.talk('npc_义庄管事', {}, '义庄管事');
    },
  },
  {
    id: '义庄镇尸', warp: '义庄镇尸', bootWarp: '招募', recipeSkip: ['scenario_义庄镇尸'],
    ends: { scenario_义庄镇尸: 'all_done' },
    lead: { npc: 'npc_义庄管事' },
    note: '跳转点「义庄镇尸」最后一跳(entered)自带进门过场,在 dev_room 里等点击 → 就绪条件永远等不到;改从「招募」(送货已回;主图在 dev 下落不到 s09_songhuo,进场后补上)冷启动,'
      + '找义庄管事进义庄、走进门区触发 entered(与正常流程同路;进门区要主图到过 s09_songhuo)→ 细看两尸 → 撒米 / 墨斗 / 石子 / 剪子四样(各一次短长按)→ 过半反扑(死亡系绳)→ 两尸松手过场 → 出义庄'
      + '(T_出义庄 点名的出生点 from_yizhuang 雾津街头里没有:master 数据缺陷,两边同样静默退回缺省出生点)',
    run(s) {
      if (s.scene !== '义庄') s.talk('npc_义庄管事', {}, '义庄管事');
      s.zone('z_义庄进门', {}, '进门');
      s.inspect('hs_两尸', {}, '看两尸');
      s.inspect('hs_镇尸_撒米', {}, '撒米');
      s.stateEnter('scenario_义庄镇尸', 'in_progress');
      s.inspect('hs_镇尸_墨斗', {}, '墨斗');
      s.stateEnter('scenario_义庄镇尸', 'two_done');
      s.inspect('hs_镇尸_石子', {}, '石子');
      s.inspect('hs_镇尸_剪子', {}, '剪子');
      s.stateEnter('scenario_义庄镇尸', 'all_done');
      s.transition('T_出义庄');
    },
  },
  {
    id: '招募', warp: '招募', ends: { scenario_招募: 'recruited', flow_xungou_main: 's11_zhaomu' },
    note: '克拉拉招募(三选第 0 项,定钱)',
    run(s) {
      s.talk('npc_克拉拉', {}, '克拉拉');
    },
  },
  {
    id: '终幕', warp: '终幕', bootWarp: '招募', ends: { scenario_终幕: 'departed', flow_xungou_main: 's12_chufa' },
    lead: { hotspot: 'T_去城门' },
    note: '跳转点「终幕」最后一跳(向导 outfitted)自带置办蒙太奇,在 dev_room 里等点击 → 改从「招募」冷启动,按「终幕」的 recipe 逐跳补(主图 s11_zhaomu、向导三跳到 outfitted,'
      + '蒙太奇在街上演)→ 西城门 → 城门汇合(换道士形象、选项第 0 项)→ 终幕过场',
    run(s) {
      if (s.scene !== '城门口') s.transition('T_去城门');
      s.talk('npc_埃德加', {}, '城门汇合');
    },
  },
];

/** 按 recipe 把叙事图只往前补(当前 → 目标:目标在图里更靠后才补;有路逐跳、没路一发直达) */
function applyRecipe(s, D, recipe, expected, skip = []) {
  for (const r of recipe) {
    if (skip.includes(r.graph)) continue;
    const g = D.graphs.get(r.graph);
    if (!g) {
      s.ref('narrative', r.graph, { state: r.state });
      continue;
    }
    const cur = expected.get(r.graph) ?? g.initialState;
    if (cur === r.state) continue;
    const ranks = stateRanks(g);
    if ((ranks.get(r.state) ?? -1) <= (ranks.get(cur) ?? -1)) continue;
    s.jump(r.graph, cur, r.state);
    expected.set(r.graph, r.state);
  }
}

/**
 * 冷启动进跳转点之后:世界模型按 master 的实际落地初始化(途经状态记到过),返回 {expected: 图 → 实际所在, missed: 没落到的}。
 * 不照抄 recipe:dev 模式跳过 startupFlags,主图 flow_xungou_main 冷启动在 state_1,从那里到 s02_beishi 起那一串没有迁移、
 * 非 scenario 图又不给一发直达 —— 「梦待死之礼」起每个跳转点的主图都停在 state_1(master 报「铺垫未完全到位」照样进场)。
 */
function landWarp(s, D, warp) {
  s.world.enterScene(warp.scene, warp.spawn || null);
  const expected = new Map();
  const missed = [];
  for (const l of warpLanding(D, warp)) {
    // 没动的图也记成「已知在 landed」:之后按它门控的条件判得出真假(主图停在 state_1 就该报)
    for (const h of l.hops.length ? l.hops : [l.landed]) s.world.narEnter(l.graph, h);
    expected.set(l.graph, l.landed);
    if (l.landed !== l.state) missed.push(l);
  }
  return { expected, missed };
}

/**
 * 跳转点没落到的非 scenario 图(主图)用 debugSetNarrativeState 补上(master canRemoteEnterState 对非 scenario 图放行;
 * 与长管线跨拍同一条路:从目标那一串的根逐跳)。scenario 图直达中段会被 master 拒,不补、只记。返回补不上的说明。
 */
function fixWarpLanding(s, D, warp, landing) {
  const notes = [];
  for (const l of landing.missed) {
    if (l.scenario) {
      notes.push(`⚠ 跳转点「${warp.id}」冷启动推不到 ${l.graph}.${l.state}(停在 ${l.landed},scenario 图不能远程直达中段 → 不补)`);
      continue;
    }
    s.jump(l.graph, l.landed, l.state);
    landing.expected.set(l.graph, l.state);
    notes.push(`跳转点「${warp.id}」在 dev 下把 ${l.graph} 推不到 ${l.state}(冷启动停在 ${l.landed}:startupFlags 不吃、图内无路)→ 进场后 debugSetNarrativeState 逐跳补上`);
  }
  return notes;
}

/** 同一条里检查点名必须唯一(compare 按名对齐 A/B):重名的后缀 #2、#3 */
function uniqueCheckpoints(steps) {
  const seen = new Map();
  return steps.map((st) => {
    if (!('checkpoint' in st)) return st;
    const n = (seen.get(st.checkpoint) ?? 0) + 1;
    seen.set(st.checkpoint, n);
    return n === 1 ? st : { checkpoint: `${st.checkpoint}#${n}` };
  });
}

// ---------------------------------------------------------------- 清单

/**
 * @param {object} o
 * @param {string[]} o.treeDirs    A(master)在前
 * @param {{width:number,height:number}} o.viewport
 * @returns {{name, beat, boot:{warp, scene}, steps, refs, note}[]}
 */
export function buildMainlineItems({ treeDirs, viewport }) {
  const D = loadData(treeDirs);
  const ctx = { D, viewport };
  const warpById = new Map(D.warps.map((w) => [w.id, w]));
  const out = [];

  // ---- 每拍一条
  for (const beat of BEATS) {
    const warp = warpById.get(beat.warp);
    const bootWarp = warpById.get(beat.bootWarp ?? beat.warp);
    if (!warp || !bootWarp) {
      out.push({
        name: beat.id, beat: beat.id, boot: { warp: beat.bootWarp ?? beat.warp, scene: bootWarp?.scene ?? warp?.scene ?? '?' },
        steps: [], refs: [{ kind: 'warp', id: beat.warp }, { kind: 'warp', id: beat.bootWarp ?? beat.warp }], note: `跳转点「${beat.warp}」不在数据里`,
      });
      continue;
    }
    const s = new Script(ctx, { mode: 'beat', scene: bootWarp.scene, label: beat.id });
    s.ref('warp', warp.id);
    if (bootWarp !== warp) s.ref('warp', bootWarp.id);
    s.ref('scene', bootWarp.scene);
    const landing = landWarp(s, D, bootWarp);
    const boot = warpBootSegs(D, s.W, bootWarp);
    const notes = [];
    if (boot.blocking) notes.push(`⚠ 跳转点「${bootWarp.id}」最后一跳带要点击的演出(就绪前在 dev_room 里等)`);
    s.start(boot.segs);
    // 跳转点在 master 上没落到的主图状态:进场后补(否则按主图门控的区 / 热区 / NPC 全不出来,这一拍的正戏一样都不演)
    notes.push(...fixWarpLanding(s, D, bootWarp, landing));
    if (bootWarp !== warp) {
      // 按原跳转点的 recipe 从冷启动那一拍(补过之后的实际状态)往前补
      applyRecipe(s, D, warpRecipe(D, warp), landing.expected, beat.recipeSkip ?? []);
      if (warpBootSegs(D, new Walker(D), warp).blocking) notes.push(`跳转点「${warp.id}」最后一跳带要点击的演出、没法冷启动 → 改从「${bootWarp.id}」启动再补状态`);
    }
    beat.run(s);
    s.ui('ui');
    out.push({
      name: beat.id,
      beat: beat.id,
      boot: { warp: bootWarp.id, scene: bootWarp.scene },
      steps: uniqueCheckpoints(s.steps),
      refs: s.refs,
      note: [beat.note, ...notes].filter(Boolean).join(';'),
    });
  }

  // ---- 长管线:第一个跳转点起,同一次启动里按顺序接下去
  {
    const first = warpById.get(BEATS[0].warp);
    if (first) {
      const s = new Script(ctx, { mode: 'chain', scene: first.scene, label: 'chain' });
      s.ref('warp', first.id);
      s.ref('scene', first.scene);
      const landing = landWarp(s, D, first);
      const expected = landing.expected;
      s.adv(30);
      s.cp('chain.boot', true);
      fixWarpLanding(s, D, first, landing);
      for (const [i, beat] of BEATS.entries()) {
        const warp = warpById.get(beat.warp);
        if (!warp) continue;
        const tag = `chain.${String(i + 1).padStart(2, '0')}.${beat.id}`;
        s.cp(`${tag}.start`, true);
        if (i > 0) {
          applyRecipe(s, D, warpRecipe(D, warp), expected, beat.recipeSkip ?? []);
          // 场景:能走过去的走过去(lead:上一拍所在场景里通往这拍的热区 / NPC),否则 dev 切场景
          if (s.scene !== warp.scene) {
            const sc = s.sceneData();
            if (beat.lead?.hotspot && arr(sc?.hotspots).some((h) => h?.id === beat.lead.hotspot)) s.transition(beat.lead.hotspot);
            else if (beat.lead?.npc && arr(sc?.npcs).some((n) => n?.id === beat.lead.npc)) s.talk(beat.lead.npc, {}, `${beat.id}.lead`);
            if (s.scene !== warp.scene && beat.id !== '背尸_跑马梁') s.switchTo(warp.scene);
          }
        }
        beat.run(s);
        for (const [g, st] of Object.entries(beat.ends ?? {})) expected.set(g, st);
        s.cp(`${tag}.end`, true);
      }
      s.ui('chain.ui', true);
      out.push({
        name: 'chain',
        beat: 'chain',
        boot: { warp: first.id, scene: first.scene },
        steps: uniqueCheckpoints(s.steps),
        refs: s.refs,
        note: '同一次启动按序接各拍(拍间只往前补叙事状态,接不上的场景 dev 切过去;超过 600 帧的过场 Esc 二次确认跳过;夜只推一次;面板只在最后开一圈)',
      });
    }
  }
  return out;
}

/** `--beats` 过滤:拍名(找吃的 同时命中 找吃的~赌坊)、完整 id(mainline__婆子家)、chain */
export function matchBeat(item, filters) {
  if (!filters || !filters.length) return true;
  return filters.some((f) => f === item.beat || f === item.name || `mainline__${item.name}` === f || item.name.startsWith(f) || `mainline__${item.name}`.startsWith(f));
}

export const MAINLINE_BEATS = BEATS.map((b) => b.id);
