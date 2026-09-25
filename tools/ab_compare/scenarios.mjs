/**
 * 对照场景表(数据驱动)。每个场景 = 一次**冷启动**(新浏览器、新上下文、新页面)+ 一串步骤,A、B 两边一字不差地执行。
 *
 * 启动(boot):
 *   { scene }                 → `/?mode=dev&visualCapture&devScene=<scene>`,就绪 = 当前场景数据 id === scene
 *   { warp, scene }           → `/?mode=dev&visualCapture&narrativeWarp=<warp>`,就绪 = 进到 warp 的目标场景
 *   visualCapture:false       → 去掉 visualCapture(它把渲染分辨率钉死在 1,DPR 那一轮必须去掉才测得到真 DPR 路径)
 *   dpr / viewport            → 覆盖该场景的 deviceScaleFactor / 视口
 *
 * 步骤(steps,按序执行;全部只调 master 上就有的入口,缺了记 unsupported,不补丁):
 *   { advance: n }            → 锁步推进 n 个固定帧(假时钟前进 n×1000/60 ms + stepFixedTicks)
 *   { checkpoint: 'name' }    → 截整页 + 取状态探针 + 收自上个检查点以来的报错
 *   { cmd: {type, ...} }      → window.__game.applyRuntimeCommand(cmd)(dev 运行时命令词表,见 master 的 devRuntimeCommands.ts)
 *   { api: 'name', args }     → window.__gameDevAPI[name](...args)
 *   { viewport: {width,height} } → 改视口(触发游戏自己的 resize 路径)
 *   { settle: ms }            → 墙钟等待(逻辑与假时钟都停着,只让在途 I/O 落地)
 *   cmd / api 都是「发出去不等」:它们可能要等假时钟 / 固定帧才会兑现,结果在后续检查点里如实记(done/pending/failed/unsupported)。
 *
 * 想调节拍 / 检查点,改下面 TEMPLATES 就行;选哪些对象由 run.mjs 的命令行过滤。
 */
import fs from 'node:fs';
import path from 'node:path';

export const KINDS = ['scene', 'npc', 'minigame', 'cutscene', 'warp', 'resize', 'dpr'];

/** 小游戏种类 → 数据来源(相对 public/assets/data) */
const MINIGAME_SOURCES = {
  water: 'water_minigames/index.json',
  sugarWheel: 'sugar_wheel/index.json',
  paperCraft: 'paper_craft/index.json',
  objectExamine: 'object_examine/index.json',
  pressureHold: 'pressure_holds.json',
};

export const TEMPLATES = {
  /** 进场景:+30 帧、+180 帧 */
  scene: () => [
    { advance: 30 }, { checkpoint: 'enter+30' },
    { advance: 150 }, { checkpoint: 'enter+180' },
  ],
  /** 找 NPC 说话:交互 → 补完打字机 → 推两步 → 选第 0 项(没有选项时两边都记失败,照样继续) */
  npc: (npcId) => [
    { advance: 30 },
    { cmd: { type: 'debugInteractNpc', npcId } }, { advance: 20 }, { checkpoint: 'talk+20' },
    { api: 'completeDialogueText' }, { advance: 2 }, { checkpoint: 'text-complete' },
    { cmd: { type: 'debugAdvanceDialogue', maxSteps: 1 } }, { advance: 20 },
    { api: 'completeDialogueText' }, { advance: 2 }, { checkpoint: 'advance-1' },
    { cmd: { type: 'debugAdvanceDialogue', maxSteps: 1 } }, { advance: 20 },
    { api: 'completeDialogueText' }, { advance: 2 }, { checkpoint: 'advance-2' },
    { cmd: { type: 'debugChooseDialogueOption', index: 0 } }, { advance: 20 },
    { api: 'completeDialogueText' }, { advance: 2 }, { checkpoint: 'choose-0' },
  ],
  /** 小游戏:dev 入口起 → 点屏幕中心 → 横拖一下 → 再放 120 帧 */
  minigame: (kind, id, vw, vh) => [
    { advance: 10 },
    { api: 'startMinigame', args: [kind, id] }, { advance: 30 }, { checkpoint: 'start+30' },
    { cmd: { type: 'debugClick', x: Math.round(vw * 0.5), y: Math.round(vh * 0.5) } }, { advance: 20 }, { checkpoint: 'click' },
    {
      cmd: {
        type: 'debugDrag',
        fromX: Math.round(vw * 0.35), fromY: Math.round(vh * 0.55),
        toX: Math.round(vw * 0.65), toY: Math.round(vh * 0.45), durationMs: 300,
      },
    },
    { advance: 40 }, { checkpoint: 'drag' },
    { advance: 120 }, { checkpoint: 'drag+120' },
  ],
  /** 过场:开播后每 60 帧一个检查点;每个检查点之后补完台词打字机 + 点一下继续(两边同一时刻同一输入) */
  cutscene: (id, every = 60, count = 6) => {
    const steps = [{ advance: 10 }, { api: 'playCutscene', args: [id] }];
    for (let i = 1; i <= count; i++) {
      steps.push({ advance: every }, { checkpoint: `t+${every * i}` }, { api: 'completeCutsceneText' }, { cmd: { type: 'playerTap' } });
    }
    return steps;
  },
  /** 叙事跳转:进到目标场景后 +30、+180 */
  warp: () => [
    { advance: 30 }, { checkpoint: 'enter+30' },
    { advance: 150 }, { checkpoint: 'enter+180' },
  ],
  /** 改视口:缩到 960×540 再还原 */
  resize: (vw, vh) => [
    { advance: 30 }, { checkpoint: 'base' },
    { viewport: { width: 960, height: 540 } }, { settle: 300 }, { advance: 30 }, { checkpoint: 'resized-960x540' },
    { viewport: { width: vw, height: vh } }, { settle: 300 }, { advance: 30 }, { checkpoint: 'restored' },
  ],
  /** DPR=2:同场景流程 */
  dpr: () => [
    { advance: 30 }, { checkpoint: 'enter+30' },
    { advance: 150 }, { checkpoint: 'enter+180' },
  ],
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 从一棵树里读出可对照的对象清单 */
function readCatalog(treeDir) {
  const scenesDir = path.join(treeDir, 'public', 'assets', 'scenes');
  const dataDir = path.join(treeDir, 'public', 'assets', 'data');
  const scenes = new Map();
  if (fs.existsSync(scenesDir)) {
    for (const f of fs.readdirSync(scenesDir).filter((n) => n.endsWith('.json')).sort()) {
      const id = f.slice(0, -5);
      const data = readJson(path.join(scenesDir, f));
      const npcs = (Array.isArray(data?.npcs) ? data.npcs : [])
        .filter((n) => n && typeof n.id === 'string' && typeof n.dialogueGraphId === 'string' && n.dialogueGraphId.trim())
        .map((n) => n.id);
      scenes.set(id, { id, npcs });
    }
  }
  const minigames = [];
  for (const [kind, rel] of Object.entries(MINIGAME_SOURCES)) {
    const list = readJson(path.join(dataDir, rel));
    for (const e of Array.isArray(list) ? list : []) if (e && typeof e.id === 'string') minigames.push({ kind, id: e.id });
  }
  const cutscenes = (readJson(path.join(dataDir, 'cutscenes', 'index.json')) ?? [])
    .filter((c) => c && typeof c.id === 'string')
    .map((c) => ({ id: c.id, targetScene: typeof c.targetScene === 'string' ? c.targetScene : null }));
  const warps = (readJson(path.join(dataDir, 'dev_narrative_warps.json'))?.warps ?? [])
    .filter((w) => w && typeof w.id === 'string' && typeof w.scene === 'string')
    .map((w) => ({ id: w.id, scene: w.scene }));
  return { scenes, minigames, cutscenes, warps };
}

/** 两棵树的清单取并集(一边独有的对象照样两边都跑:另一边起不来 / 报错本身就是差异) */
function mergeCatalogs(cats) {
  const scenes = new Map();
  const mg = new Map();
  const cs = new Map();
  const wp = new Map();
  for (const c of cats) {
    for (const [id, s] of c.scenes) {
      const prev = scenes.get(id);
      scenes.set(id, prev ? { id, npcs: [...new Set([...prev.npcs, ...s.npcs])] } : s);
    }
    for (const m of c.minigames) mg.set(`${m.kind}:${m.id}`, m);
    for (const x of c.cutscenes) if (!cs.has(x.id)) cs.set(x.id, x);
    for (const w of c.warps) if (!wp.has(w.id)) wp.set(w.id, w);
  }
  return { scenes, minigames: [...mg.values()], cutscenes: [...cs.values()], warps: [...wp.values()] };
}

const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '_');

/**
 * @param {object} o
 * @param {string[]} o.treeDirs         A、B 两棵树
 * @param {Set<string>} o.kinds         要跑的种类
 * @param {string[]|null} o.scenes      场景过滤(null = 全部)
 * @param {number} o.npcsPerScene
 * @param {string|null} o.minigames     'first'(每种第一个,缺省)| 'all' | 'kind:id,kind:id'
 * @param {string[]|null} o.cutscenes   null = 全部
 * @param {string[]|null} o.warps       null = 全部
 * @param {string[]|null} o.resizeScenes / o.dprScenes  null = 选中场景的前两个
 * @param {{width:number,height:number}} o.viewport
 */
export function buildScenarios(o) {
  const cat = mergeCatalogs(o.treeDirs.map(readCatalog));
  const allScenes = [...cat.scenes.keys()];
  const unknown = (o.scenes ?? []).filter((s) => !cat.scenes.has(s));
  const scenes = o.scenes ? o.scenes.filter((s) => cat.scenes.has(s)) : allScenes;
  const out = [];
  const add = (kind, name, boot, steps) => out.push({ id: `${kind}__${safeName(name)}`, kind, name, boot, steps });
  const { width: vw, height: vh } = o.viewport;

  if (o.kinds.has('scene')) for (const s of scenes) add('scene', s, { scene: s }, TEMPLATES.scene());
  if (o.kinds.has('npc')) {
    for (const s of scenes) {
      for (const npc of cat.scenes.get(s).npcs.slice(0, o.npcsPerScene)) add('npc', `${s}.${npc}`, { scene: s }, TEMPLATES.npc(npc));
    }
  }
  if (o.kinds.has('minigame')) {
    let list = cat.minigames;
    const sel = o.minigames ?? 'first';
    if (sel === 'first') {
      const seen = new Set();
      list = list.filter((m) => (seen.has(m.kind) ? false : (seen.add(m.kind), true)));
    } else if (sel !== 'all') {
      const want = sel.split(',').map((x) => x.trim()).filter(Boolean);
      list = want.map((w) => {
        const [kind, ...rest] = w.split(':');
        return { kind, id: rest.join(':') };
      });
    }
    for (const m of list) add('minigame', `${m.kind}.${m.id}`, { scene: 'dev_room' }, TEMPLATES.minigame(m.kind, m.id, vw, vh));
  }
  if (o.kinds.has('cutscene')) {
    const list = o.cutscenes ? o.cutscenes.map((id) => cat.cutscenes.find((c) => c.id === id) ?? { id, targetScene: null }) : cat.cutscenes;
    for (const c of list) {
      const bootScene = c.targetScene && cat.scenes.has(c.targetScene) ? c.targetScene : 'dev_room';
      add('cutscene', c.id, { scene: bootScene }, TEMPLATES.cutscene(c.id));
    }
  }
  if (o.kinds.has('warp')) {
    const list = o.warps ? o.warps.map((id) => cat.warps.find((w) => w.id === id)).filter(Boolean) : cat.warps;
    for (const w of list) add('warp', w.id, { warp: w.id, scene: w.scene }, TEMPLATES.warp());
  }
  if (o.kinds.has('resize')) {
    for (const s of o.resizeScenes ?? scenes.slice(0, 2)) add('resize', s, { scene: s }, TEMPLATES.resize(vw, vh));
  }
  if (o.kinds.has('dpr')) {
    for (const s of o.dprScenes ?? scenes.slice(0, 2)) add('dpr', `${s}@2x`, { scene: s, dpr: 2, visualCapture: false }, TEMPLATES.dpr());
  }
  return { scenarios: out, unknownScenes: unknown, catalog: { scenes: allScenes.length, minigames: cat.minigames.length, cutscenes: cat.cutscenes.length, warps: cat.warps.length } };
}

/** 启动 URL 的查询串(master 的 src/main.ts 认这些参数) */
export function bootQuery(boot) {
  const q = new URLSearchParams();
  q.set('mode', 'dev');
  let s = q.toString();
  if (boot.visualCapture !== false) s += '&visualCapture';
  if (boot.warp) s += `&narrativeWarp=${encodeURIComponent(boot.warp)}`;
  else s += `&devScene=${encodeURIComponent(boot.scene)}`;
  return `?${s}`;
}
