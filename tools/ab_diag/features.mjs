/**
 * `feature` 种类:每一条 = 冷启动一个**合适的**场景 → 触发一项游戏功能 → 触发后立刻 + 播放过程中若干检查点
 * (动画类效果按 +10 / +30 / +90 / +240 帧这样一串打点,看得到起手、过程与收尾)。
 *
 * 只走 master 上就有的入口(两边一字不差):
 *   - `debugExecuteAction`(= `window.__game.applyRuntimeCommand({type:'debugExecuteAction', action:{type, params}})`)
 *     跑任意 ActionRegistry 动作——参数照抄**游戏数据里的真实用法**(并尽量在数据用它的那个场景里跑,
 *     效果要的东西才都在:可燃物、粒子实例、风、灯…);
 *   - 其余 dev 运行时命令(`debugSetPlayerPosition` / `playerMoveTo` / `playerPosture` / `debugSetNarrativeState` …);
 *   - 外部输入(driver 的 `key` / `keyDown` / `keyUp` / `click` / `wheel` 步骤 = Playwright 真键盘 / 真鼠标):
 *     只有快捷键才开得了的面板靠它。不注入任何游戏代码。
 *
 * 能从数据里现取的一律现取(时段变体、可燃物、雷符的 strikeThreat 参数、粒子实例、风场 / 惊扰场参数 …),
 * 这样数据改了清单跟着变;取不到才退回下面抄好的常量(注明出处)。清单与数据的对账见 validate.mjs(`run.mjs --list`)。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 类别 → 说明(`--features` 可按类别名过滤) */
export const FEATURE_CATEGORIES = {
  time: '时段外观(timeVariants:advanceTimeTo 换装重载)',
  burn: '燃烧(igniteBurnable / extinguishBurnable / resetBurnable,场景可燃物与手持可燃挂件)',
  strike: '落雷(strikeThreat;雷符整段用法)',
  vfx: '粒子(playVfx / stopVfx / setVfxState / emitVfxField / playCanvasVfx / playPropVfx)',
  prop: '手持挂件(火把:attachToSocket / setPropState / 护火键)',
  fx: '画面演出(风、压暗、震屏、缩放、闪白、黑场、叠图、呼吸图、文档揭示、说明卡)',
  ent: '实体(显隐、表情 / 气泡、阴影绑定、动画、走位、热区展示图)',
  ui: '面板(背包 / 任务 / 规矩 / 书架 / 地图 / 商店 / 菜单 / 对话记录)',
  fg: '前景层(人走到树后被挡、树旁落雷)',
  player: '玩家移动 / 姿态(playerMoveTo 走路、蹲 / 凝视 / 踢 / 跳)',
};

// ---------------------------------------------------------------- 步骤小工具

/** 跑一个 ActionRegistry 动作 */
export const act = (type, params = {}) => ({ cmd: { type: 'debugExecuteAction', action: { type, params } } });
/** dev 运行时命令 */
const cmd = (type, fields = {}) => ({ cmd: { type, ...fields } });
const api = (name, ...args) => (args.length ? { api: name, args } : { api: name });
const key = (k) => ({ key: k });

/**
 * 时间线:offsets 是相对「触发那一刻」的帧偏移(升序),展开成 advance + checkpoint。
 * 检查点名 `<label>+<偏移>`(同一条内唯一,compare 按名对齐)。
 */
export function timeline(label, offsets) {
  const out = [];
  let prev = 0;
  for (const off of offsets) {
    if (off > prev) out.push({ advance: off - prev });
    out.push({ checkpoint: `${label}+${off}` });
    prev = off;
  }
  return out;
}

/** 每条的开头:进场 30 帧,拍一张「触发前」 */
const PRE = () => [{ advance: 30 }, { checkpoint: 'before' }];

/** 时段换装:遮幕淡入 500 ms → 整场景重载(I/O)→ 揭幕 500 ms;重载大的场景(崖墓一带)留足 */
const SWAP_CPS = [10, 30, 60, 120, 240, 480];
/** 落雷:闪白 45 ms、雷光 210 ms、连劈间隔 240±110 ms、表现连劈 600±250 ms —— 前密后疏 */
const STRIKE_CPS = [3, 8, 15, 30, 45, 60, 90, 120, 180, 240];

/** 固定的落点种子:雷符数据里不带 seed(靠运行时随机),对照要逐条确定,这里补一个(两边相同) */
const STRIKE_SEED = 20260927;

// ---------------------------------------------------------------- 数据

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** 走一遍任意 JSON,把形如 `{type, params:{…}}` 的动作全交给 cb(过场步骤、对话图、叙事图、物品 use 都是这个形状) */
export function walkActions(node, cb) {
  if (Array.isArray(node)) {
    for (const x of node) walkActions(x, cb);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string' && node.params && typeof node.params === 'object' && !Array.isArray(node.params)) cb(node);
  for (const k of Object.keys(node)) walkActions(node[k], cb);
}

/** 一棵树里 feature 清单要用的数据(只读 public/assets) */
function readFeatureData(treeDir) {
  const pub = path.join(treeDir, 'public', 'assets');
  const dataDir = path.join(pub, 'data');
  const scenesDir = path.join(pub, 'scenes');
  const scenes = new Map();
  if (fs.existsSync(scenesDir)) {
    for (const f of fs.readdirSync(scenesDir).filter((n) => n.endsWith('.json')).sort()) {
      const d = readJson(path.join(scenesDir, f));
      if (d && typeof d === 'object') scenes.set(f.slice(0, -5), d);
    }
  }
  const vfxDir = path.join(dataDir, 'vfx');
  const vfx = new Map();
  if (fs.existsSync(vfxDir)) {
    for (const f of fs.readdirSync(vfxDir).filter((n) => n.endsWith('.json')).sort()) vfx.set(f.slice(0, -5), readJson(path.join(vfxDir, f)));
  }
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    scenes,
    vfx,
    items: arr(readJson(path.join(dataDir, 'items.json'))),
    cutscenes: arr(readJson(path.join(dataDir, 'cutscenes', 'index.json'))),
    gameConfig: readJson(path.join(dataDir, 'game_config.json')) ?? {},
    placements: readJson(path.join(dataDir, 'vfx_placements.json'))?.scenes ?? {},
    propPresets: readJson(path.join(dataDir, 'prop_presets.json')) ?? {},
    documents: arr(readJson(path.join(dataDir, 'document_reveals.json'))),
    systemNotes: arr(readJson(path.join(dataDir, 'system_notes.json'))?.notes),
    overlays: readJson(path.join(dataDir, 'overlay_images.json')) ?? {},
    shops: arr(readJson(path.join(dataDir, 'shops.json'))),
    quests: arr(readJson(path.join(dataDir, 'quests.json'))),
    rules: arr(readJson(path.join(dataDir, 'rules.json'))?.rules),
    breathing: fs.existsSync(path.join(dataDir, 'breathing'))
      ? fs.readdirSync(path.join(dataDir, 'breathing')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort()
      : [],
    narrativeGraphs: readJson(path.join(dataDir, 'narrative_graphs.json')),
    dialogueGraphsDir: path.join(pub, 'dialogues', 'graphs'),
  };
}

/** A、B 两份取并集:场景按 id 并(A 优先),其余整份取 A(A 没有才用 B)——一边独有的对象照样两边都跑 */
function mergeFeatureData(list) {
  const [first, ...rest] = list;
  const out = { ...first, scenes: new Map(first.scenes), vfx: new Map(first.vfx) };
  for (const d of rest) {
    for (const [id, s] of d.scenes) if (!out.scenes.has(id)) out.scenes.set(id, s);
    for (const [id, v] of d.vfx) if (!out.vfx.has(id)) out.vfx.set(id, v);
    for (const k of ['items', 'cutscenes', 'documents', 'systemNotes', 'shops', 'quests', 'rules', 'breathing']) {
      if (!out[k]?.length && d[k]?.length) out[k] = d[k];
    }
    for (const k of ['gameConfig', 'placements', 'propPresets', 'overlays', 'narrativeGraphs']) {
      if ((!out[k] || !Object.keys(out[k]).length) && d[k] && Object.keys(d[k]).length) out[k] = d[k];
    }
  }
  return out;
}

/** 数据里的真实用法:{type, params, scene(能定位就给), src} */
function collectUsages(D) {
  const out = [];
  for (const c of D.cutscenes) {
    walkActions(c?.steps, (a) => out.push({ type: a.type, params: a.params, scene: typeof c?.targetScene === 'string' ? c.targetScene : null, src: `cutscene:${c?.id}` }));
  }
  for (const [sid, sc] of D.scenes) walkActions(sc, (a) => out.push({ type: a.type, params: a.params, scene: sid, src: `scene:${sid}` }));
  for (const it of D.items) walkActions(it, (a) => out.push({ type: a.type, params: a.params, scene: null, src: `item:${it?.id}` }));
  // 叙事图 / 对话图:动作挂在状态 / 节点上,定位不到场景(scene = null)
  walkActions(D.narrativeGraphs, (a) => out.push({ type: a.type, params: a.params, scene: null, src: 'narrative_graphs' }));
  if (fs.existsSync(D.dialogueGraphsDir)) {
    for (const f of fs.readdirSync(D.dialogueGraphsDir).filter((n) => n.endsWith('.json')).sort()) {
      walkActions(readJson(path.join(D.dialogueGraphsDir, f)), (a) => out.push({ type: a.type, params: a.params, scene: null, src: `dialogue:${f.slice(0, -5)}` }));
    }
  }
  return out;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/** 游戏开局时段(与 DayManager 同口径:startAt 落在哪段;配置缺省 07:00) */
function startPhaseOf(gameConfig) {
  const dn = gameConfig?.dayNight ?? {};
  const toMin = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const start = toMin(dn.startAt ?? '07:00') ?? 7 * 60;
  const phases = (Array.isArray(dn.phases) ? dn.phases : [])
    .map((p) => ({ id: typeof p?.id === 'string' ? p.id : null, from: toMin(p?.from) }))
    .filter((p) => p.id && p.from !== null)
    .sort((a, b) => a.from - b.from);
  if (!phases.length) return { start: null, ids: [] };
  let cur = phases[phases.length - 1].id; // startAt 早于第一段 = 还在上一天的最后一段里
  for (const p of phases) if (p.from <= start) cur = p.id;
  return { start: cur, ids: phases.map((p) => p.id) };
}

// ---------------------------------------------------------------- 抄自数据的兜底常量(数据里找不到时才用)

/** items.json 雷符(leifu)use 里那条 strikeThreat 的参数(2026-09-27 master) */
const FALLBACK_STRIKE = {
  effects: 'lightning_bolt_01,lightning_bolt_02,lightning_bolt_03,lightning_bolt_04,lightning_bolt_05,lightning_bolt_06,lightning_bolt_07,lightning_bolt_08,lightning_bolt_09,lightning_bolt_10',
  effectSeed: 0, extraChance: 0.45, fallback: 'random', fallbackRadius: 650, flashAlpha: 0.045, flashMs: 45,
  gapJitterMs: 110, gapMs: 240, lightHeight: 240, lightIntensity: 7, lightMs: 210, lightRange: 1400, maxDistance: 1800,
  rank: 'threat', sfx: 'sfx_thunder_crack', sfxVolume: 0.65, shakeAmplitude: 10, shakeMs: 260, strikes: 3,
  visualStrikes: 5, visualExtraChance: 1, visualGapMs: 600, visualGapJitterMs: 250, fallbackMargin: 0.14,
  fallbackMinDistance: 120, fallbackSeparation: 160, fallbackGroundOnly: true, sfxVoices: 0, vfxVoices: 0, fallbackMaxSlopeDeg: 60,
};
/** items.json 驱虫(item:bug)那条惊扰场 */
const FALLBACK_BUG_FEAR = { kind: 'fear', tag: 'item:bug', radius: 900, strength: 2.5, duration: 4, at: { kind: 'entity', id: 'player' }, h: 100 };
/** 崖墓.json z_风口 的阵风场 */
const FALLBACK_WIND_FIELD = { kind: 'wind', tag: 'gust', radius: 600, strength: 900, duration: 1.2, at: { kind: 'entity', id: 'player' }, direction: [-1, 0, 0] };

/**
 * 进场后先让「走进去就开演」的叙事区闲下来(dev 调试命令 debugSetNarrativeState,master 就有):
 * 跑马梁 wrapper 在 往前走 / 迎风 / 跟脚 / 点火选择 各挂一个区,人一走到树边就进风口过场;
 * 「下梁」是终态,不挂任何区条件,onEnter 只清气味。走位 / 前景层 / 挂件这类需要把人摆到别处的条目用它。
 */
const SCENE_CALM = {
  跑马梁: [cmd('debugSetNarrativeState', { graphId: 'wrapper_跑马梁_风火引路', stateId: '下梁' }), { advance: 10 }],
};
const calm = (scene) => (SCENE_CALM[scene] ? clone(SCENE_CALM[scene]) : []);

// ---------------------------------------------------------------- 各类别

/**
 * @param {object} o
 * @param {string[]} o.treeDirs
 * @param {{width:number,height:number}} o.viewport
 * @returns {{name:string, category:string, boot:{scene:string}, steps:object[], note:string}[]}
 */
export function buildFeatureItems({ treeDirs, viewport }) {
  const D = mergeFeatureData(treeDirs.map(readFeatureData));
  const U = collectUsages(D);
  const has = (s) => D.scenes.has(s);
  const out = [];
  const add = (category, detail, scene, steps, note = '') => {
    if (!has(scene)) return;
    out.push({ name: `${category}__${detail}`, category, boot: { scene }, steps: uniqueCheckpoints(steps), note });
  };
  const usage = (type, pred = () => true) => U.find((u) => u.type === type && pred(u)) ?? null;
  // 对话图里的用法定位场景:哪个场景的 JSON 引用了这张图(NPC dialogueGraphId / 热区 graphId …)
  const sceneText = [...D.scenes].map(([id, s]) => [id, JSON.stringify(s)]);
  const sceneOfUsage = (u) => {
    if (!u) return null;
    if (u.scene) return u.scene;
    if (!u.src.startsWith('dialogue:')) return null;
    const gid = u.src.slice('dialogue:'.length);
    return sceneText.find(([, t]) => t.includes(`"${gid}"`))?.[0] ?? null;
  };
  const { width: vw, height: vh } = viewport;
  const at = (fx, fy) => ({ x: Math.round(vw * fx), y: Math.round(vh * fy) });

  // ---------------- 1. 时段外观:每个带 timeVariants 的场景 × 每个变体
  {
    const { start, ids } = startPhaseOf(D.gameConfig);
    for (const [sid, sc] of D.scenes) {
      const tv = sc?.timeVariants;
      if (!tv || typeof tv !== 'object' || Array.isArray(tv)) continue;
      const keys = Object.keys(tv);
      const dn = sc?.dayNight?.enabled === true ? '' : '(场景没开 dayNight:应当两边都不换装)';
      for (const v of keys) {
        const steps = PRE();
        if (v === start) {
          // 开局就在这一段(比如「午」):先推到一个没有变体的时段(= 顶层基底),再推回来
          const base = ids.find((p) => p !== start && !keys.includes(p)) ?? ids.find((p) => p !== start);
          if (!base) continue;
          steps.push(
            act('advanceTimeTo', { phase: base, transition: 'fade' }), ...timeline(`to-${base}`, [30, 120, 240]),
            act('advanceTimeTo', { phase: v, transition: 'fade' }), ...timeline(`to-${v}`, SWAP_CPS),
          );
        } else {
          steps.push(act('advanceTimeTo', { phase: v, transition: 'fade' }), ...timeline(`to-${v}`, SWAP_CPS));
        }
        // transition 'fade' 抄自 序章_街巷_赌坊门卫 的 advanceTimeTo(遮幕 → 重载 → 揭幕)
        add('time', `${sid}@${v}`, sid, steps, `advanceTimeTo ${v}(fade)${dn}`);
      }
    }
  }

  // ---------------- 2. 燃烧:场景里每个可燃实体(热区 / NPC)+ 每个可燃挂件预设
  let burnScene = null;
  for (const [sid, sc] of D.scenes) {
    const hosts = [
      ...(Array.isArray(sc?.hotspots) ? sc.hotspots : []),
      ...(Array.isArray(sc?.npcs) ? sc.npcs : []),
    ].filter((e) => e && typeof e.id === 'string' && typeof e.burnable?.template === 'string');
    for (const h of hosts) {
      burnScene ??= sid;
      const target = h.id;
      const steps = PRE();
      if (h.burnable.initial === 'burning') {
        steps.push(
          act('extinguishBurnable', { target }), ...timeline('extinguish', [10, 60]),
          act('igniteBurnable', { target }), ...timeline('ignite', [10, 30, 90, 240]),
        );
      } else {
        steps.push(
          act('igniteBurnable', { target }), ...timeline('ignite', [10, 30, 90, 240, 480]),
          act('extinguishBurnable', { target }), ...timeline('extinguish', [10, 60]),
        );
      }
      steps.push(act('resetBurnable', { target }), ...timeline('reset', [10]));
      add('burn', `${sid}.${target}`, sid, steps, `模板 ${h.burnable.template}${h.burnable.initial === 'burning' ? '(开场就燃着)' : ''}`);
    }
  }
  for (const [pid, preset] of Object.entries(D.propPresets ?? {})) {
    if (typeof preset?.burnable?.template !== 'string') continue;
    const scene = burnScene ?? 'dev_room';
    const sock = { target: 'player', socket: 'right_hand' };
    add('burn', `held.${pid}@${scene}`, scene, [
      ...PRE(),
      act('attachToSocket', { ...sock, prop: pid }), ...timeline('attached', [20]),
      act('igniteBurnable', sock), ...timeline('ignite', [10, 30, 90, 240]),
      act('extinguishBurnable', sock), ...timeline('extinguish', [10, 60]),
      act('resetBurnable', sock), ...timeline('reset', [10]),
    ], `手持可燃挂件 ${pid}(模板 ${preset.burnable.template})`);
  }

  // ---------------- 3. 落雷
  {
    const src = usage('strikeThreat', (u) => u.src.startsWith('item:'));
    const itemId = src ? src.src.slice(5) : 'leifu';
    const params = { ...clone(src?.params ?? FALLBACK_STRIKE), seed: STRIKE_SEED };
    for (const scene of ['跑马梁', '崖墓入口', '雾津街头']) {
      add('strike', scene, scene, [...PRE(), act('strikeThreat', params), ...timeline('strike', STRIKE_CPS)],
        `${itemId} 的 strikeThreat 参数 + seed ${STRIKE_SEED}`);
    }
    // 整段道具用法(云 → 压暗 → 风 → 雨 → 闪 → 落雷 → 收),照 items.json 原样跑(不补 seed)
    const item = D.items.find((i) => i?.id === itemId);
    const useActions = Array.isArray(item?.use?.actions) ? item.use.actions : [];
    if (useActions.length) {
      add('strike', `${itemId}.use@跑马梁`, '跑马梁', [
        ...PRE(),
        ...useActions.map((a) => act(a.type, clone(a.params ?? {}))),
        ...timeline('use', [60, 180, 330, 510, 690, 725, 740, 760, 800, 900, 1080, 1260]),
      ], `${itemId} 的 use.actions 原样(runActionsDetached 整段,约 18 s)`);
    }
  }

  // ---------------- 4. 粒子
  {
    // 4a. 群体(蝙蝠):按布置里 initialState 的效果找场景实例
    const flockEffects = [...D.vfx.entries()]
      .filter(([, def]) => Array.isArray(def?.emitters) && def.emitters.some((e) => e?.behavior?.initialState))
      .map(([id]) => id);
    const bugFear = clone(usage('emitVfxField', (u) => u.params?.kind === 'fear' && String(u.params?.tag).startsWith('item:'))?.params ?? FALLBACK_BUG_FEAR);
    const doneEffects = new Set();
    for (const sid of [...D.scenes.keys()]) {
      const pl = D.placements?.[sid];
      const base = Array.isArray(pl) ? pl : Array.isArray(pl?.base) ? pl.base : [];
      for (const inst of base) {
        if (!inst || !flockEffects.includes(inst.effect) || doneEffects.has(inst.effect)) continue;
        doneEffects.add(inst.effect);
        add('vfx', `flock@${sid}.${inst.id}`, sid, [
          ...PRE(),
          act('setVfxState', { instanceId: inst.id, state: 'airborne' }), ...timeline('airborne', [10, 30, 90, 240]),
          act('emitVfxField', bugFear), ...timeline('fear', [10, 60, 180]),
          act('setVfxState', { instanceId: inst.id, state: 'returning' }), ...timeline('returning', [60, 240]),
        ], `群体 ${inst.effect}:起飞 → 惊扰场(${bugFear.tag})→ 归巢`);
      }
    }
    // 4b. 场景布置实例的播放 / 收(过场里 playVfx instanceId 的真实用法)
    const seenInst = new Set();
    for (const u of U.filter((x) => x.type === 'playVfx' && typeof x.params?.instanceId === 'string')) {
      const inst = u.params.instanceId;
      if (seenInst.has(inst)) continue;
      seenInst.add(inst);
      const scene = u.scene ?? Object.keys(D.placements ?? {}).find((s) => JSON.stringify(D.placements[s]).includes(`"${inst}"`));
      if (!scene) continue;
      add('vfx', `instance@${scene}.${inst}`, scene, [
        ...PRE(),
        act('playVfx', clone(u.params)), ...timeline('play', [10, 30, 90, 240, 480]),
        act('stopVfx', { instanceId: inst, soft: true }), ...timeline('stop', [30, 120]),
      ], `${u.src} 的 playVfx;stopVfx soft 抄自 主线_初上跑马梁`);
    }
    // 4c. 临时效果(带 handle)起 / 收:雷符里那三团(云 / 风雾 / 雨)
    const plays = U.filter((x) => x.type === 'playVfx' && typeof x.params?.handle === 'string' && x.src.startsWith('item:'));
    const stops = U.filter((x) => x.type === 'stopVfx' && typeof x.params?.handle === 'string' && x.src.startsWith('item:'));
    if (plays.length) {
      add('vfx', 'storm@雾津街头', '雾津街头', [
        ...PRE(),
        ...plays.map((u) => act('playVfx', clone(u.params))), ...timeline('storm', [10, 60, 180, 360]),
        ...stops.map((u) => act('stopVfx', clone(u.params))), ...timeline('stop', [30, 90, 180]),
      ], `${plays[0].src} 的 playVfx handle(${plays.map((u) => u.params.effect).join(' / ')})`);
    }
    // 4d. 风场:崖墓 z_风口 那条;放到有会被风吹动的布置的场景(跑马梁纸钱 / 落叶,崖墓前段蝙蝠 / 雾)
    const wind = clone(usage('emitVfxField', (u) => u.params?.kind === 'wind')?.params ?? FALLBACK_WIND_FIELD);
    for (const scene of ['跑马梁', '崖墓前段']) {
      add('vfx', `wind_field@${scene}`, scene, [...PRE(), act('emitVfxField', wind), ...timeline('gust', [5, 15, 30, 60, 90])], '风场参数抄自 崖墓 z_风口');
    }
    // 4e. 惊扰场:说书收场过场里那一脚(茶馆飞虫)
    const fear = U.find((x) => x.type === 'emitVfxField' && x.params?.kind === 'fear' && x.scene);
    if (fear) {
      add('vfx', `fear_field@${fear.scene}`, fear.scene, [...PRE(), act('emitVfxField', clone(fear.params)), ...timeline('fear', [5, 15, 30, 60, 120])], `${fear.src}`);
    }
    // 4f. 画布特效(屏幕空间;数据里还没有真实用法,效果取现成粒子资产)
    add('vfx', 'canvas@城门口', '城门口', [
      ...PRE(),
      act('playCanvasVfx', { name: 'ab_canvas_smoke', effect: 'incense_smoke', xPercent: 30, yPercent: 70, scale: 1.5 }),
      act('playCanvasVfx', { name: 'ab_canvas_fireflies', effect: 'fireflies', xPercent: 65, yPercent: 45, scale: 1, order: 5 }),
      ...timeline('play', [10, 60, 180]),
      act('stopCanvasVfx', { name: 'ab_canvas_smoke' }), ...timeline('stop-smoke', [30]),
      act('clearCanvas', {}), ...timeline('clear', [10]),
    ], 'playCanvasVfx / stopCanvasVfx / clearCanvas');
    // 4g. 挂件上的一次性效果(火把熄灭的烟,prop_presets 里 out 状态进入动作的那条)
    const snuff = usage('playPropVfx')?.params?.effect ?? 'torch_snuff_smoke';
    add('vfx', 'prop_vfx@跑马梁', '跑马梁', [
      ...PRE(), ...calm('跑马梁'),
      act('attachToSocket', { target: 'player', socket: 'right_hand', prop: 'torch', state: 'lit' }), ...timeline('lit', [20]),
      act('playPropVfx', { target: 'player', socket: 'right_hand', effect: snuff }), ...timeline('puff', [5, 20, 60, 120]),
    ], `playPropVfx ${snuff}`);
  }

  // ---------------- 5. 手持挂件:火把(夜里看得出灯)
  {
    const sock = { target: 'player', socket: 'right_hand' };
    add('prop', 'torch@跑马梁@夜', '跑马梁', [
      ...PRE(), ...calm('跑马梁'),
      act('advanceTimeTo', { phase: '夜', transition: 'fade' }), ...timeline('to-夜', [120, 300]),
      act('attachToSocket', { ...sock, prop: 'torch', state: 'lit' }), ...timeline('lit', [10, 60, 180]),
      { keyDown: 'KeyQ' }, ...timeline('guard', [10, 60]), { keyUp: 'KeyQ' }, ...timeline('unguard', [30]),
      act('setPropState', { ...sock, state: 'out', fadeMs: 300 }), ...timeline('out', [5, 20, 60, 120]),
      act('setPropState', { ...sock, state: 'lit' }), ...timeline('relit', [10, 60]),
      cmd('playerMoveTo', { x: 330, y: 960 }), ...timeline('walk', [15, 45, 90, 180]),
      act('detachFromSocket', sock), ...timeline('detached', [10]),
    ], '火把 lit → 护火键 Q → out(fadeMs 300,抄自 主线_初上跑马梁)→ 重燃 → 举着走 → 摘下');
  }

  // ---------------- 6. 画面演出
  {
    const gustU = usage('sceneWindGust', (u) => !!u.scene);
    const gustScene = gustU?.scene ?? '跑马梁';
    const gust = gustU?.params ?? { speedMultiplier: 4, durationMs: 3600, attackMs: 300, releaseMs: 1500, id: '可怕的呼啸风声3', volume: 1 };
    add('fx', `wind_gust@${gustScene}`, gustScene,
      [...PRE(), act('sceneWindGust', clone(gust)), ...timeline('gust', [10, 30, 90, 180, 300])], `sceneWindGust(${gustU?.src ?? '过场 跑马梁_纸钱引路'} 的参数)`);
    add('fx', 'wind_gust@崖墓入口', '崖墓入口', [
      ...PRE(), act('sceneWindGust', { speedMultiplier: 2.2, durationMs: 8000, attackMs: 350, releaseMs: 700 }), ...timeline('gust', [10, 30, 90, 240, 480, 600]),
    ], 'sceneWindGust(跑马梁 wrapper「迎风」的参数)');
    add('fx', 'scene_dim@雾津街头', '雾津街头', [
      ...PRE(),
      act('setSceneDim', { fadeMs: 2400, scale: 0.38 }), ...timeline('dim', [30, 90, 150]),
      act('setSceneDim', { fadeMs: 2600, scale: 1 }), ...timeline('undim', [60, 180]),
    ], 'setSceneDim(雷符里的两档)');
    add('fx', 'flash_shake@雾津街头', '雾津街头', [
      ...PRE(),
      act('screenFlash', { alpha: 0.1, color: '#c8d8ff', durationMs: 85 }), ...timeline('flash-blue', [1, 3, 6]),
      act('screenFlash', {}), ...timeline('flash-white', [2, 8, 14, 30]),
      act('cameraShake', { amplitude: 10, durationMs: 450, frequency: 18 }), ...timeline('shake', [2, 5, 10, 30]),
    ], 'screenFlash(雷符 / 缺省)+ cameraShake');
    add('fx', 'fade_blackout@雾津街头', '雾津街头', [
      ...PRE(),
      act('fadeWorldToBlack', { durationMs: 900 }), ...timeline('to-black', [10, 30, 60]),
      act('fadeWorldFromBlack', { durationMs: 600 }), ...timeline('from-black', [10, 30, 60]),
      act('showBlackout', { durationMs: 1500 }), ...timeline('blackout', [30, 90, 120]),
      act('hideBlackout', { durationMs: 3000 }), ...timeline('unblack', [60, 120, 200]),
    ], 'fadeWorldToBlack / fadeWorldFromBlack / showBlackout / hideBlackout(对话图与过场里的时长)');
    for (const scene of ['码头白天', '雾津街头']) {
      add('fx', `camera_zoom@${scene}`, scene, [
        ...PRE(),
        act('setCameraZoom', { zoom: 1.37 }), ...timeline('zoom1.37', [2, 30]),
        act('restoreSceneCameraZoom', {}), ...timeline('restore', [2]),
        act('setCameraZoom', { zoom: 1.5 }), ...timeline('zoom1.5', [2]),
        act('restoreSceneCameraZoom', {}), ...timeline('restore2', [2]),
        act('fadingZoom', { zoom: 1.5, durationMs: 2000 }), ...timeline('fading1.5', [30, 60, 120, 150]),
        act('fadingZoom', { zoom: 1.37, durationMs: 600 }), ...timeline('fading1.37', [20, 45]),
        act('fadingRestoreSceneCameraZoom', { durationMs: 600 }), ...timeline('fading-restore', [20, 60]),
      ], 'setCameraZoom 1.37 / 1.5、fadingZoom(码头白天 的 1.5 / 2000)、还原');
    }
    // 叠图 / 叠化
    const ov = Object.keys(D.overlays ?? {});
    const ovA = ov.includes('river_ghost_hand') ? 'river_ghost_hand' : ov[0];
    const ovB = ov.includes('scare_closeup') ? 'scare_closeup' : ov[1] ?? ov[0];
    if (ovA) {
      add('fx', 'overlay_image@城门口', '城门口', [
        ...PRE(),
        act('showOverlayImage', { id: ovA, image: ovA, xPercent: 50, yPercent: 46, widthPercent: 58 }), ...timeline('show', [10, 60]),
        act('blendOverlayImage', { id: 'ab_blend', fromImage: ovA, toImage: ovB, xPercent: 50, yPercent: 50, widthPercent: 40, durationMs: 1200, delayMs: 200, order: 2 }),
        ...timeline('blend', [10, 40, 80, 100]),
        act('hideOverlayImage', { id: ovA }), act('hideOverlayImage', { id: 'ab_blend' }), ...timeline('hide', [10]),
        act('showOverlayImage', { id: 'ab_fill', image: ovB, xPercent: 50, yPercent: 50, widthPercent: 50, fill: true }), ...timeline('fill', [10]),
        act('hideOverlayImage', { id: 'ab_fill' }), ...timeline('hide-fill', [10]),
      ], `showOverlayImage(${ovA},对话图里的布局)/ blendOverlayImage / fill / hideOverlayImage`);
    }
    // 呼吸图(梦_里屋 对话图里的用法)
    const breath = usage('showBreathingOverlay');
    if (breath || D.breathing.length) {
      const p = clone(breath?.params ?? { id: D.breathing[0], breathing: D.breathing[0], xPercent: 50, yPercent: 48, widthPercent: 82 });
      const bScene = sceneOfUsage(breath) ?? '梦_里屋';
      add('fx', `breathing@${bScene}.${p.breathing}`, bScene, [
        ...PRE(),
        act('showBreathingOverlay', p), ...timeline('show', [10, 60, 180]),
        act('setBreathingParams', { id: p.id, params: { ti: 1.2, te: 1.6, swing: 20 }, durationMs: 1000 }), ...timeline('params', [60, 180]),
        act('breathingPerform', { id: p.id, act: 'gasp' }), ...timeline('gasp', [10, 30, 90]),
        act('breathingPerform', { id: p.id, act: 'fadeOut' }), ...timeline('fadeOut', [60, 180]),
        act('hideOverlayImage', { id: p.id }), ...timeline('hide', [10]),
      ], 'showBreathingOverlay / setBreathingParams / breathingPerform gasp、fadeOut / hideOverlayImage');
    }
    // 文档揭示:每份都 force 播一遍叠化;另取一份不 force(条件不满足 → 模糊图)。
    // 场景 = 数据里揭示它的那张对话图挂在哪个场景(找不到退 城门口)
    const docSceneOf = (id) => sceneOfUsage(usage('revealDocument', (u) => u.params?.documentId === id && !!sceneOfUsage(u))) ?? '城门口';
    const docScene = Object.fromEntries(D.documents.filter((d) => typeof d?.id === 'string').map((d) => [d.id, docSceneOf(d.id)]));
    for (const d of D.documents) {
      if (typeof d?.id !== 'string') continue;
      const scene = docScene[d.id];
      const delay = Math.round(((d.animation?.delayMs ?? 0) / 1000) * 60);
      const dur = Math.round(((d.animation?.durationMs ?? 2000) / 1000) * 60);
      add('fx', `document@${scene}.${d.id}`, scene, [
        ...PRE(),
        act('revealDocument', { documentId: d.id, force: true }),
        ...timeline('reveal', [...new Set([10, delay + 10, delay + Math.round(dur / 2), delay + dur + 20])].sort((a, b) => a - b)),
        act('hideDocument', { documentId: d.id }), ...timeline('hide', [10]),
        act('revealDocument', { documentId: d.id }), ...timeline('re-reveal', [10]),
        act('hideDocument', { documentId: d.id }), ...timeline('re-hide', [10]),
      ], 'revealDocument force(叠化)→ hide → 再揭示(已揭示 = 直出清晰图)');
    }
    const blurDoc = D.documents.find((d) => d?.revealCondition && JSON.stringify(d.revealCondition) !== '{"all":[]}');
    if (blurDoc) {
      add('fx', `document_blurred@${docScene[blurDoc.id] ?? '城门口'}.${blurDoc.id}`, docScene[blurDoc.id] ?? '城门口', [
        ...PRE(), act('revealDocument', { documentId: blurDoc.id }), ...timeline('blurred', [10, 60]),
        act('hideDocument', { documentId: blurDoc.id }), ...timeline('hide', [10]),
      ], 'revealDocument 不 force:揭示条件不满足 → 显示模糊图');
    }
    // 说明卡:数据里用到的几张依次弹、任意键关
    const noteIds = [...new Set(U.filter((u) => u.type === 'showSystemNote').map((u) => u.params?.noteId).filter(Boolean))];
    if (!noteIds.length) noteIds.push(...D.systemNotes.slice(0, 2).map((n) => n.id));
    const noteSteps = [...PRE()];
    for (const n of noteIds.slice(0, 4)) {
      noteSteps.push(act('showSystemNote', { noteId: n, force: true }), ...timeline(`note-${n}`, [10, 45]), key('Enter'), ...timeline(`closed-${n}`, [30]));
    }
    if (noteIds.length) add('fx', 'system_notes@城门口', '城门口', noteSteps, `showSystemNote ${noteIds.slice(0, 4).join(' / ')}(任意键关:Enter)`);
  }

  // ---------------- 7. 实体
  {
    const W = '雾津街头';
    add('ent', `npc_enable@${W}`, W, [
      ...PRE(),
      act('setEntityEnabled', { target: 'npc_街头叫花子', enabled: false }), ...timeline('off', [2, 30]),
      act('setEntityEnabled', { target: 'npc_街头叫花子', enabled: true }), ...timeline('on', [2, 30]),
    ], 'setEntityEnabled NPC 关 / 开');
    add('ent', 'hotspot_enable@城隍庙夜', '城隍庙夜', [
      ...PRE(),
      // master 的 setEntityEnabled 只认 NPC / player / 过场临时演员;热区走 persistHotspotEnabled。两条都比。
      act('setEntityEnabled', { target: 'hs_无名女尸', enabled: false }), ...timeline('setEntityEnabled-off', [2, 30]),
      act('setEntityEnabled', { target: 'hs_无名女尸', enabled: true }), ...timeline('setEntityEnabled-on', [2]),
      act('persistHotspotEnabled', { sceneId: '城隍庙夜', hotspotId: 'hs_无名女尸', enabled: false }), ...timeline('persist-off', [2, 30]),
      act('persistHotspotEnabled', { sceneId: '城隍庙夜', hotspotId: 'hs_无名女尸', enabled: true }), ...timeline('persist-on', [2, 30]),
    ], '热区显隐:setEntityEnabled(master 上对热区是告警空操作)+ persistHotspotEnabled');
    add('ent', 'hotspot_image@城隍庙夜', '城隍庙夜', [
      ...PRE(),
      act('setHotspotDisplayImage', { sceneId: '城隍庙夜', hotspotId: 'hs_无名女尸', image: '/resources/runtime/images/corpses/demo/two_corpses_lie_flat.png', worldWidth: 260, worldHeight: 140 }),
      ...timeline('image', [2, 30, 90]),
      act('setHotspotDisplayImage', { sceneId: '城隍庙夜', hotspotId: 'hs_无名女尸', image: '/resources/runtime/images/corpses/demo/chenghuang_unknown_woman.png', worldHeight: 130, facing: 'right' }),
      ...timeline('image-facing', [2, 30]),
    ], 'setHotspotDisplayImage(图与尺寸抄自 过场里 义庄 hs_两尸 那条)+ facing');
    add('ent', `emote_bubble@${W}`, W, [
      ...PRE(),
      act('showEmote', { target: 'npc_街头肥鸡', emote: '!', duration: 1500 }),
      act('showEmote', { target: 'player', emote: '?', duration: 1200 }), ...timeline('emote', [5, 20, 45, 80, 120]),
      act('showSpeechBubble', { target: 'npc_街头拉客女', text: '那缸水是人家屋头的，莫舀。', duration: 2600 }), ...timeline('bubble', [5, 30, 90, 170]),
      act('showSpeechBubble', { target: 'npc_街头瞎子李', text: '过来嘛，挨近点……我跟你说句话。', duration: 3200, pinOnScreen: true }),
      ...timeline('bubble-pinned', [5, 60, 200]),
    ], 'showEmote / showSpeechBubble(对话图里的写法)/ pinOnScreen 画外贴边');
    add('ent', `shadow@${W}`, W, [
      ...PRE(),
      act('setEntityShadow', { target: 'player', source: 'virtual', azimuthDeg: 60, elevationDeg: 30, darkness: 0.7, softness: 0.35 }), ...timeline('virtual', [2, 30]),
      act('setEntityShadow', { target: 'npc_街头肥鸡', source: 'virtual', azimuthDeg: 200, elevationDeg: 45, darkness: 0.5, softness: 0.5 }), ...timeline('npc-virtual', [2]),
      act('setEntityShadow', { target: 'player', source: 'light:light_1', darkness: 0.6 }), ...timeline('light', [2, 30]),
      act('setEntityShadow', { target: 'player', source: 'none' }), ...timeline('none', [2]),
      act('setEntityShadow', { target: 'player', source: 'light:lamp_2' }), ...timeline('scene-binding', [2]),
    ], 'setEntityShadow virtual / light:<灯> / none(最后还原成场景 playerShadowBindings 那条)');
    add('ent', `npc_anim@${W}`, W, [
      ...PRE(),
      act('playNpcAnimation', { target: 'npc_街头肥鸡', state: 'peck' }),
      act('playNpcAnimation', { target: 'npc_街头土狗', state: 'bark' }), ...timeline('anim', [5, 20, 60, 120]),
      act('playNpcAnimation', { target: 'player', state: 'crouch', holdFrame: -1 }), ...timeline('player-crouch-hold', [5, 30]),
      act('playNpcAnimation', { target: 'player', state: 'crouch', reverse: true, loop: 'false', thenState: 'idle' }), ...timeline('player-crouch-reverse', [5, 30, 90]),
      act('playNpcAnimation', { target: 'npc_街头叫花子', state: 'crouch', speed: 0.5 }), ...timeline('npc-crouch-slow', [10, 60]),
    ], 'playNpcAnimation(过场里 player crouch holdFrame / reverse thenState 的写法)');
    add('ent', `move@${W}`, W, [
      ...PRE(),
      act('moveEntityTo', { target: 'npc_街头叫花子', x: 900, y: 1560, speed: 80, faceTowardMovement: true }), ...timeline('move', [10, 60, 120, 180, 300]),
      act('faceEntity', { target: 'npc_街头叫花子', faceTarget: 'player' }), ...timeline('face', [5]),
      act('jumpEntityTo', { target: 'npc_街头土狗', x: 980, y: 1650, durationMs: 300, arcHeight: 50, faceTowardMovement: true }), ...timeline('jump', [5, 12, 30]),
    ], 'moveEntityTo / faceEntity / jumpEntityTo(过场里的写法)');
  }

  // ---------------- 8. 面板(外部真键盘 / 真鼠标;UI 场景用没有 onEnter、没有区的 城门口)
  {
    const U0 = '城门口';
    const clickIn = (fx, fy, label) => [{ click: at(fx, fy) }, ...timeline(label, [10])];
    const wheelIn = (label) => [{ wheel: { ...at(0.5, 0.5), dy: 360 } }, ...timeline(label, [10])];
    add('ui', `inventory@${U0}`, U0, [
      ...PRE(),
      act('giveItem', { id: 'joss_paper', count: 5 }), act('giveItem', { id: 'leifu', count: 2 }), act('giveItem', { id: 'temple_notes', count: 1 }),
      ...timeline('given', [20, 240]),
      key('KeyI'), ...timeline('open', [10, 40]), ...clickIn(0.36, 0.4, 'click'), ...wheelIn('wheel'), key('KeyI'), ...timeline('closed', [10]),
    ], '给三样东西(数据里的 giveItem)→ I 开背包 → 点一格 → 滚轮 → I 关');
    add('ui', `quest@${U0}`, U0, [
      ...PRE(),
      act('updateQuest', { id: '支线-归还小孩铁环-归还铁环' }), act('setFocusedQuest', { id: '支线-归还小孩铁环-归还铁环', announce: true }),
      ...timeline('accepted', [20, 120, 300]),
      key('Tab'), ...timeline('open', [10, 40]), ...clickIn(0.3, 0.35, 'click'), ...wheelIn('wheel'), key('Tab'), ...timeline('closed', [10]),
    ], 'updateQuest(对话图里的那条)+ setFocusedQuest announce → Tab 任务面板');
    const ruleIds = D.rules.map((r) => r?.id).filter(Boolean).slice(0, 2);
    add('ui', `rules@${U0}`, U0, [
      ...PRE(),
      ...ruleIds.map((id) => act('giveRule', { id })), ...timeline('given', [20, 240]),
      key('KeyR'), ...timeline('open', [10, 40]), ...clickIn(0.3, 0.35, 'click'), ...wheelIn('wheel'), key('KeyR'), ...timeline('closed', [10]),
    ], `giveRule ${ruleIds.join(' / ')} → R 规矩面板`);
    add('ui', `bookshelf@${U0}`, U0, [
      ...PRE(),
      act('addArchiveEntry', { bookType: 'character', entryId: 'storyteller_zhang' }), act('addArchiveEntry', { bookType: 'character', entryId: 'blind_li' }),
      ...timeline('added', [20, 240]),
      key('KeyB'), ...timeline('open', [10, 40]), ...clickIn(0.3, 0.45, 'click-book'), ...timeline('book', [30]), ...wheelIn('wheel'),
      key('Escape'), ...timeline('esc1', [10]), key('Escape'), ...timeline('esc2', [10]),
    ], 'addArchiveEntry(对话图里的人物条目)→ B 书架 → 点一本 → 滚轮 → Esc 退一层 / 再退');
    add('ui', `map@${U0}`, U0, [
      ...PRE(),
      act('openMap', {}), ...timeline('open', [10, 40]), ...wheelIn('wheel'), key('Escape'), ...timeline('closed', [10]),
      key('KeyM'), ...timeline('key-open', [10, 40]), key('KeyM'), ...timeline('key-closed', [10]),
    ], 'openMap 动作 + M 快捷键(不点地图:点地点会真的传送)');
    for (const shop of D.shops.map((s) => s?.id).filter(Boolean)) {
      add('ui', `shop@${U0}.${shop}`, U0, [
        ...PRE(),
        act('openShop', { shopId: shop }), ...timeline('open', [10, 40]), ...clickIn(0.4, 0.35, 'click'), ...wheelIn('wheel'),
        key('Escape'), ...timeline('closed', [10, 30]),
      ], `openShop ${shop} → 点一行 → 滚轮 → Esc`);
    }
    add('ui', `menu@${U0}`, U0, [
      ...PRE(),
      key('Escape'), ...timeline('open', [10, 40]), key('ArrowRight'), ...timeline('next-page', [20]), ...clickIn(0.5, 0.5, 'click'),
      key('Escape'), ...timeline('esc1', [10]), key('Escape'), ...timeline('esc2', [10]),
    ], 'Esc 暂停菜单 → → 翻页 → 点一下 → Esc 退');
    add('ui', 'dialogue_log@teahouse', 'teahouse', [
      ...PRE(),
      api('completeDialogueText'), cmd('debugAdvanceDialogue', { maxSteps: 1 }), { advance: 20 },
      api('completeDialogueText'), cmd('debugAdvanceDialogue', { maxSteps: 1 }), ...timeline('talked', [20]),
      api('completeDialogueText'), key('KeyL'), ...timeline('open', [10, 40]), ...wheelIn('wheel'), key('KeyL'), ...timeline('closed', [10]),
    ], '茶馆开场对白推两句 → L 对话记录(对话态可开)→ 滚轮 → L 关');
  }

  // ---------------- 9. 前景层:人走到树后 / 树前、从树后走过、树旁落雷
  for (const [sid, sc] of D.scenes) {
    const layers = Array.isArray(sc?.foregroundLayers) ? sc.foregroundLayers : [];
    const tv = sc?.timeVariants && typeof sc.timeVariants === 'object' ? Object.keys(sc.timeVariants) : [];
    for (const L of layers) {
      const a = Array.isArray(L?.source?.at) ? L.source.at : null;
      if (!a || !Number.isFinite(a[0]) || !Number.isFinite(a[1]) || typeof L.id !== 'string') continue;
      // `at` = 原画像素里落在这株上的点(跑马梁:歪脖子树的根部,原画 2048×1152 = 场景 wu);
      // 树根往右上斜着长(拆层 bbox 约 x +0…+220、y -200…+20),路从树根右侧往上走。
      // 「树后」= 脚点在接地线之后(y 更小)、身子与树干 / 树冠在屏幕上重叠;「树前」= 接地线之前。
      const P = (dx, dy) => ({ x: Math.round(a[0] + dx), y: Math.round(a[1] + dy) });
      const spots = [['behind-trunk', P(45, -25)], ['behind-canopy', P(47, -85)], ['behind-top', P(52, -145)], ['front', P(40, 76)]];
      const strike = { ...clone(usage('strikeThreat', (u) => u.src.startsWith('item:'))?.params ?? FALLBACK_STRIKE), seed: STRIKE_SEED, fallbackRadius: 260, maxDistance: 400 };
      const body = () => {
        const s = [];
        for (const [label, p] of spots) s.push(cmd('debugSetPlayerPosition', { ...p, snapCamera: true }), ...timeline(label, [5, 60]));
        s.push(
          cmd('debugSetPlayerPosition', { ...spots[3][1], snapCamera: true }), { advance: 5 },
          cmd('playerMoveTo', spots[2][1]), ...timeline('walk-behind', [10, 30, 60, 120, 240]),
          cmd('debugSetPlayerPosition', { ...spots[0][1], snapCamera: true }), { advance: 5 },
          act('strikeThreat', strike), ...timeline('strike', [3, 8, 15, 30, 60, 120]),
        );
        return s;
      };
      add('fg', `${sid}.${L.id}`, sid, [...PRE(), ...calm(sid), ...body()], `前景层 ${L.id}:锚点 (${a.join(', ')});树后三处 / 树前 / 从树前走到树后 / 树旁落雷(seed ${STRIKE_SEED})`);
      const night = tv.includes('夜') ? '夜' : null;
      if (night) {
        add('fg', `${sid}.${L.id}@${night}`, sid, [
          ...PRE(), ...calm(sid),
          act('advanceTimeTo', { phase: night, transition: 'fade' }), ...timeline(`to-${night}`, [120, 300]),
          ...body(),
        ], `同上,先推到「${night}」(夜原画)`);
      }
    }
  }

  // ---------------- 10. 玩家移动 / 姿态
  {
    for (const sid of ['雾津街头', '崖墓入口', '河边', 'test_room_a']) {
      const sc = D.scenes.get(sid);
      const sp = sc?.spawnPoint;
      if (!sp || !Number.isFinite(sp.x) || !Number.isFinite(sp.y)) continue;
      // 目标 = 最近的另一个出生点(出生点一定站得住),距离 150–1000;没有就往右 300
      const cands = Object.entries(sc.spawnPoints ?? {})
        .map(([k, p]) => ({ k, x: p?.x, y: p?.y, d: Math.hypot((p?.x ?? 0) - sp.x, (p?.y ?? 0) - sp.y) }))
        .filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y) && c.d >= 150 && c.d <= 1000)
        .sort((m, n) => m.d - n.d);
      const t = cands[0] ?? { k: '+300', x: sp.x + 300, y: sp.y };
      add('player', `walk@${sid}`, sid, [
        ...PRE(), ...calm(sid),
        cmd('playerMoveTo', { x: Math.round(t.x * 10) / 10, y: Math.round(t.y * 10) / 10 }), ...timeline('walk', [5, 15, 30, 60, 120, 240, 480]),
      ], `playerMoveTo 出生点 → ${t.k}(${Math.round(t.d ?? 300)} wu)`);
    }
    add('player', 'posture@雾津街头', '雾津街头', [
      ...PRE(),
      cmd('playerPosture', { posture: 'crouch', held: true }), ...timeline('crouch', [5, 20, 60]),
      cmd('playerPosture', { posture: 'crouch', held: false }), ...timeline('stand', [20]),
      cmd('playerPosture', { posture: 'gaze', held: true }), ...timeline('gaze', [20, 60]),
      cmd('playerPosture', { posture: 'gaze', held: false }), ...timeline('gaze-off', [20]),
      cmd('playerAct', { verb: 'kick' }), ...timeline('kick', [5, 20, 45]),
      cmd('playerAct', { verb: 'jump' }), ...timeline('jump', [5, 15, 30, 60]),
    ], 'playerPosture 蹲 / 凝视(按住 / 松开)+ playerAct 踢 / 跳');
  }

  return out;
}

/** 同一条里检查点名必须唯一(compare 按名对齐 A/B):重名的后缀 #2、#3 */
function uniqueCheckpoints(steps) {
  const seen = new Map();
  return steps.map((s) => {
    if (!('checkpoint' in s)) return s;
    const n = (seen.get(s.checkpoint) ?? 0) + 1;
    seen.set(s.checkpoint, n);
    return n === 1 ? s : { checkpoint: `${s.checkpoint}#${n}` };
  });
}

/**
 * `--features` 过滤:每一项可以是类别名(time / burn …)、完整 id(feature__burn__…)、
 * 条目名(burn__test_room_a.burn_demo_paper)或条目名前缀(`time__崖墓` = 崖墓一带全部时段条目)。
 */
export function matchFeature(item, filters) {
  if (!filters || !filters.length) return true;
  return filters.some((f) => f === item.category || f === item.name || f === `feature__${item.name}` || item.name.startsWith(f) || `feature__${item.name}`.startsWith(f));
}
