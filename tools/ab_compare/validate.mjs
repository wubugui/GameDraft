/**
 * 场景表对账(`run.mjs --list` 用;纯读文件:不起浏览器、不起 dev 服、不建 / 不改任何树)。
 *
 * 拿 **master 那棵检出**(缺省 `.tools/master-ro`)核对每条场景的每个步骤引用的东西确实存在:
 *   - 启动场景 / 叙事跳转;
 *   - dev 运行时命令(devRuntimeCommands.ts 的 case)、`__gameDevAPI` 方法(Game.ts 的接口声明);
 *   - ActionRegistry 动作类型(ActionRegistry.ts + ActionExecutor.ts 的 register)、manifest 必填参数、编辑器 ACTION_TYPES;
 *   - 动作里点名的数据:粒子效果 / 布置实例 / 可燃物与燃烧模板 / 挂件预设与状态 / 商店 / 文档 / 叠图 / 呼吸图与参数键 /
 *     说明卡 / 物品 / 任务 / 规矩 / 档案条目 / 叙事图状态 / 时段 / 实体(NPC / 热区 / player)/ 场景灯 /
 *     动画状态与图片路径(有素材目录时)/ 坐标是否在场景范围内;
 *   - 外部输入:按键是不是 master 认的键(面板快捷键 / 身体动词 / 挂件键 / 通用键)、点击点在不在视口里;
 *   - 同一条里检查点名唯一(compare 按名对齐 A/B)。
 * 错误 = 这一步在 master 上注定落空(场景表写错了);告警 = 值得看一眼但不一定错。
 */
import fs from 'node:fs';
import path from 'node:path';

const readText = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const readJson = (f) => {
  const t = readText(f);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};
const listIds = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)) : []);

/** 从 master 检出里读出对账要用的全部「存在性」事实 */
export function loadMasterRefs(masterDir, assetsDir = null) {
  const src = (rel) => readText(path.join(masterDir, rel)) ?? '';
  const data = (rel) => readJson(path.join(masterDir, 'public', 'assets', 'data', rel));
  const problems = [];

  const reg = src('src/core/ActionRegistry.ts');
  const exe = src('src/core/ActionExecutor.ts');
  if (!reg) problems.push('读不到 src/core/ActionRegistry.ts');
  const actions = new Set([...reg.matchAll(/executor\.register\(\s*'([A-Za-z_]\w*)'/g)].map((m) => m[1]));
  for (const m of exe.matchAll(/this\.register\(\s*'([A-Za-z_]\w*)'/g)) actions.add(m[1]);

  const manifest = new Map();
  for (const m of src('src/core/actionParamManifest.ts').matchAll(/\b([A-Za-z_]\w*):\s*\{\s*required:\s*\[([^\]]*)\]/g)) {
    manifest.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  }
  const editor = src('tools/editor/shared/action_editor.py');
  const e0 = editor.indexOf('ACTION_TYPES = [');
  const editorTypes = new Set(e0 >= 0 ? [...editor.slice(e0, editor.indexOf('\n]', e0)).matchAll(/"([A-Za-z_]\w*)"/g)].map((m) => m[1]) : []);

  const commands = new Set([...src('src/core/devRuntimeCommands.ts').matchAll(/case '([A-Za-z_]\w*)':/g)].map((m) => m[1]));
  if (!commands.size) problems.push('读不到 devRuntimeCommands.ts 的命令表');

  const game = src('src/core/Game.ts');
  const g0 = game.indexOf('__gameDevAPI?: {');
  const devApi = new Set(g0 >= 0 ? [...game.slice(g0, game.indexOf('\n    };', g0)).matchAll(/^\s{6}(\w+)\s*\(/gm)].map((m) => m[1]) : []);
  if (!devApi.size) problems.push('读不到 Game.ts 的 __gameDevAPI 接口声明');
  const panelKeys = new Map([...game.matchAll(/registerPanel\('(\w+)',\s*this\.\w+,\s*'(\w+)'/g)].map((m) => [m[2], m[1]]));
  const vk = /VERB_KEYS[^=]*=\s*\{([\s\S]*?)\};/.exec(src('src/systems/PlayerActionSystem.ts'));
  const verbKeys = new Map(vk ? [...vk[1].matchAll(/(\w+):\s*'(\w+)'/g)].map((m) => [m[1], m[2]]) : []);
  const pk = /PROP_CONTROL_KEYS\s*=\s*\{([^}]*)\}/.exec(src('src/systems/heldProp/HeldPropSystem.ts'));
  const propKeys = new Map(pk ? [...pk[1].matchAll(/(\w+):\s*'(\w+)'/g)].map((m) => [m[1], m[2]]) : []);
  const ba = /BREATHING_ACTS\s*(?::[^=]*)?=\s*\[([^\]]*)\]/.exec(src('src/systems/breathing/BreathingOverlaySystem.ts'));
  const breathingActs = new Set(ba ? [...ba[1].matchAll(/'(\w+)'/g)].map((m) => m[1]) : []);
  const bp = readJson(path.join(masterDir, 'src', 'data', 'breathingParams.json'));
  const breathingParamKeys = new Set((bp?.groups ?? []).flatMap((g) => (g.params ?? []).map((p) => p.key)));

  const scenesDir = path.join(masterDir, 'public', 'assets', 'scenes');
  const sceneIds = new Set(listIds(scenesDir));
  const sceneCache = new Map();
  const scene = (id) => {
    if (!sceneCache.has(id)) sceneCache.set(id, sceneIds.has(id) ? readJson(path.join(scenesDir, `${id}.json`)) : null);
    return sceneCache.get(id);
  };

  // 叙事图:任何带 id + states 的对象
  const narrative = new Map();
  walkObjects(data('narrative_graphs.json'), (o) => {
    if (typeof o.id === 'string' && o.states && typeof o.states === 'object' && !Array.isArray(o.states)) narrative.set(o.id, new Set(Object.keys(o.states)));
  });
  const archive = {};
  for (const [book, file] of Object.entries({ character: 'characters', lore: 'lore', slang: 'slang', rhyme: 'rhymes', document: 'documents', book: 'books' })) {
    const j = data(`archive/${file}.json`);
    const arr = Array.isArray(j) ? j : Array.isArray(j?.entries) ? j.entries : Array.isArray(j?.books) ? j.books : [];
    archive[book] = new Set(arr.map((e) => e?.id).filter(Boolean));
  }
  const rulesJson = data('rules.json');
  const questsJson = data('quests.json');
  return {
    masterDir,
    assetsDir: assetsDir && fs.existsSync(assetsDir) ? assetsDir : null,
    problems,
    actions, manifest, editorTypes, commands, devApi, panelKeys, verbKeys, propKeys, breathingActs, breathingParamKeys,
    sceneIds, scene,
    warps: new Set((data('dev_narrative_warps.json')?.warps ?? []).map((w) => w?.id).filter(Boolean)),
    vfx: new Set(listIds(path.join(masterDir, 'public', 'assets', 'data', 'vfx'))),
    burnTemplates: new Set(listIds(path.join(masterDir, 'public', 'assets', 'data', 'burnables'))),
    breathing: new Set(listIds(path.join(masterDir, 'public', 'assets', 'data', 'breathing'))),
    placements: data('vfx_placements.json')?.scenes ?? {},
    propPresets: data('prop_presets.json') ?? {},
    shops: new Set((data('shops.json') ?? []).map((s) => s?.id).filter(Boolean)),
    documents: new Set((data('document_reveals.json') ?? []).map((d) => d?.id).filter(Boolean)),
    overlays: new Set(Object.keys(data('overlay_images.json') ?? {})),
    systemNotes: new Set((data('system_notes.json')?.notes ?? []).map((n) => n?.id).filter(Boolean)),
    items: new Set((data('items.json') ?? []).map((i) => i?.id).filter(Boolean)),
    quests: new Set((Array.isArray(questsJson) ? questsJson : questsJson?.quests ?? []).map((q) => q?.id).filter(Boolean)),
    rules: new Set((Array.isArray(rulesJson) ? rulesJson : rulesJson?.rules ?? []).map((r) => r?.id).filter(Boolean)),
    archive,
    narrative,
    phases: new Set((data('game_config.json')?.dayNight?.phases ?? []).map((p) => p?.id).filter(Boolean)),
  };
}

function walkObjects(node, cb) {
  if (Array.isArray(node)) {
    for (const x of node) walkObjects(x, cb);
    return;
  }
  if (!node || typeof node !== 'object') return;
  cb(node);
  for (const k of Object.keys(node)) walkObjects(node[k], cb);
}

/** 通用键(Playwright 键名)——面板 / 动词 / 挂件键之外,菜单与说明卡用得到的 */
const GENERIC_KEYS = new Set(['Escape', 'Enter', 'Space', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ShiftLeft', 'Shift']);

/**
 * @param {object[]} scenarios  buildScenarios(...).scenarios
 * @param {ReturnType<typeof loadMasterRefs>} R
 * @param {{width:number,height:number}} viewport
 * @returns {{errors:string[], warnings:string[], notes:string[], used:{actions:Set<string>, commands:Set<string>, apis:Set<string>, keys:Set<string>}}}
 */
export function validateScenarios(scenarios, R, viewport) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const used = { actions: new Set(), commands: new Set(), apis: new Set(), keys: new Set() };
  for (const p of R.problems) errors.push(`[master] ${p}`);

  for (const sc of scenarios) {
    const E = (m) => errors.push(`${sc.id}: ${m}`);
    const W = (m) => warnings.push(`${sc.id}: ${m}`);
    let at = ''; // 当前步骤前缀(实体 / 坐标 / 图片这几个共用检查的报错带上它)
    const sid = sc.boot?.scene;
    const S = R.scene(sid);
    if (!R.sceneIds.has(sid)) E(`启动场景「${sid}」在 master 上不存在`);
    if (sc.boot?.warp && !R.warps.has(sc.boot.warp)) E(`叙事跳转「${sc.boot.warp}」在 master 的 dev_narrative_warps.json 里没有`);

    const npcs = new Map((Array.isArray(S?.npcs) ? S.npcs : []).filter((n) => n && typeof n.id === 'string').map((n) => [n.id, n]));
    const hotspots = new Map((Array.isArray(S?.hotspots) ? S.hotspots : []).filter((h) => h && typeof h.id === 'string').map((h) => [h.id, h]));
    const lights = new Set((S?.lighting?.lights ?? []).map((l) => l?.id).filter(Boolean));
    const worldW = Number(S?.worldWidth);
    const worldH = Number(S?.worldHeight);
    const inWorld = (x, y, what) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        E(`${at}${what} 坐标不是有限数 (${x}, ${y})`);
        return;
      }
      if ((Number.isFinite(worldW) && (x < 0 || x > worldW)) || (Number.isFinite(worldH) && (y < 0 || y > worldH))) {
        W(`${at}${what} (${x}, ${y}) 在场景「${sid}」范围 ${worldW}×${worldH} 之外`);
      }
    };
    const entity = (id, what, { hotspotOk = true } = {}) => {
      if (id === 'player') return;
      if (npcs.has(id)) return;
      if (hotspots.has(id)) {
        if (!hotspotOk) notes.push(`${sc.id}: ${at}${what}「${id}」是热区(master 的这条动作只认 NPC / player,预期是告警空操作——有意对照)`);
        return;
      }
      E(`${at}${what}「${id}」在场景「${sid}」里既不是 NPC 也不是热区`);
    };
    const asset = (p, what) => {
      if (typeof p !== 'string' || !p.startsWith('/resources/runtime/')) return;
      if (!R.assetsDir) return;
      if (!fs.existsSync(path.join(R.assetsDir, p.slice('/resources/runtime/'.length)))) E(`${at}${what} 图片「${p}」在素材目录里没有`);
    };
    const animStates = (npcId) => {
      const n = npcs.get(npcId);
      if (!n || typeof n.animFile !== 'string' || !R.assetsDir || !n.animFile.startsWith('/resources/runtime/')) return null;
      const j = readJson(path.join(R.assetsDir, n.animFile.slice('/resources/runtime/'.length)));
      return j?.states && typeof j.states === 'object' ? new Set(Object.keys(j.states)) : null;
    };
    const attached = new Map(); // `${target}.${socket}` → prop 预设 id

    const checkAction = (a, where) => {
      const type = a.type;
      const p = a.params ?? {};
      used.actions.add(type);
      if (!R.actions.has(type)) {
        E(`${where}动作「${type}」没在 master 的 ActionRegistry 注册`);
        return;
      }
      if (!R.manifest.has(type)) W(`${where}动作「${type}」不在 master 的 actionParamManifest 里`);
      else for (const req of R.manifest.get(type)) if (p[req] === undefined || p[req] === null) E(`${where}${type} 缺必填参数 ${req}`);
      if (R.editorTypes.size && !R.editorTypes.has(type)) W(`${where}动作「${type}」不在编辑器 ACTION_TYPES 里`);
      const inScene = (sceneId, what) => {
        if (sceneId !== sid) W(`${where}${type}.${what} = 「${sceneId}」与启动场景「${sid}」不同`);
      };
      switch (type) {
        case 'playVfx': case 'stopVfx': case 'setVfxState': {
          if (typeof p.effect === 'string' && p.effect && !R.vfx.has(p.effect)) E(`${where}${type} 粒子效果「${p.effect}」不存在`);
          if (typeof p.instanceId === 'string' && p.instanceId) {
            const pl = R.placements[sid];
            const all = [...(Array.isArray(pl) ? pl : Array.isArray(pl?.base) ? pl.base : []), ...Object.values(pl?.variants ?? {}).flat()];
            if (!all.some((i) => i?.id === p.instanceId)) E(`${where}${type} 布置实例「${p.instanceId}」不在场景「${sid}」的 vfx_placements 里`);
          }
          if (type === 'setVfxState' && !['roosting', 'airborne', 'fleeing', 'returning'].includes(p.state)) E(`${where}setVfxState state「${p.state}」不合法`);
          if (p.at?.kind === 'entity') entity(p.at.id, `${type}.at`);
          break;
        }
        case 'playCanvasVfx': case 'playPropVfx':
          if (!R.vfx.has(p.effect)) E(`${where}${type} 粒子效果「${p.effect}」不存在`);
          if (type === 'playPropVfx' && !attached.has(`${p.target}.${p.socket}`)) W(`${where}playPropVfx 之前这条没往 ${p.target}.${p.socket} 挂东西`);
          break;
        case 'emitVfxField':
          if (p.at?.kind === 'entity') entity(p.at.id, 'emitVfxField.at');
          break;
        case 'strikeThreat': {
          const ids = [p.effect, ...(Array.isArray(p.effects) ? p.effects : typeof p.effects === 'string' ? p.effects.split(',') : [])]
            .map((x) => String(x ?? '').trim()).filter(Boolean);
          for (const id of ids) if (!R.vfx.has(id)) E(`${where}strikeThreat 雷效果「${id}」不存在`);
          break;
        }
        case 'igniteBurnable': case 'extinguishBurnable': case 'resetBurnable': {
          if (p.socket) {
            entity(p.target, `${type}.target`);
            const prop = attached.get(`${p.target}.${p.socket}`);
            if (!prop) W(`${where}${type} 之前这条没往 ${p.target}.${p.socket} 挂东西`);
            else if (!R.propPresets[prop]?.burnable) E(`${where}${type} 挂件「${prop}」不是可燃挂件`);
          } else {
            const h = hotspots.get(p.target) ?? npcs.get(p.target);
            if (!h) E(`${where}${type} 可燃物「${p.target}」不在场景「${sid}」里`);
            else if (typeof h.burnable?.template !== 'string') E(`${where}${type}「${p.target}」没有 burnable`);
            else if (!R.burnTemplates.has(h.burnable.template)) E(`${where}${type}「${p.target}」的燃烧模板「${h.burnable.template}」不存在`);
          }
          break;
        }
        case 'attachToSocket': {
          entity(p.target, 'attachToSocket.target');
          if (p.prop !== undefined) {
            const pre = R.propPresets[p.prop];
            if (!pre) E(`${where}attachToSocket 挂件预设「${p.prop}」不存在`);
            else if (p.state !== undefined && pre.states && !(p.state in pre.states)) E(`${where}attachToSocket 挂件「${p.prop}」没有状态「${p.state}」`);
            attached.set(`${p.target}.${p.socket}`, p.prop);
          }
          break;
        }
        case 'setPropState': case 'lockPropState': {
          const prop = attached.get(`${p.target}.${p.socket}`);
          if (!prop) W(`${where}${type} 之前这条没往 ${p.target}.${p.socket} 挂东西`);
          else if (type === 'setPropState' && R.propPresets[prop]?.states && !(p.state in R.propPresets[prop].states)) E(`${where}setPropState 挂件「${prop}」没有状态「${p.state}」`);
          break;
        }
        case 'detachFromSocket':
          attached.delete(`${p.target}.${p.socket}`);
          break;
        case 'openShop':
          if (!R.shops.has(p.shopId)) E(`${where}商店「${p.shopId}」不存在`);
          break;
        case 'revealDocument': case 'hideDocument':
          if (!R.documents.has(p.documentId)) E(`${where}文档「${p.documentId}」不存在`);
          break;
        case 'showOverlayImage':
          if (!String(p.image).startsWith('/') && !R.overlays.has(p.image)) E(`${where}叠图「${p.image}」不在 overlay_images.json`);
          asset(p.image, 'showOverlayImage');
          break;
        case 'blendOverlayImage':
          for (const k of ['fromImage', 'toImage']) {
            if (!String(p[k]).startsWith('/') && !R.overlays.has(p[k])) E(`${where}叠图「${p[k]}」不在 overlay_images.json`);
            asset(p[k], `blendOverlayImage.${k}`);
          }
          break;
        case 'showBreathingOverlay':
          if (!R.breathing.has(p.breathing)) E(`${where}呼吸图「${p.breathing}」不存在`);
          break;
        case 'setBreathingParams':
          for (const k of Object.keys(p.params ?? {})) if (!R.breathingParamKeys.has(k)) E(`${where}呼吸参数键「${k}」不在 breathingParams.json`);
          break;
        case 'breathingPerform':
          if (R.breathingActs.size && !R.breathingActs.has(p.act)) E(`${where}breathingPerform act「${p.act}」不合法`);
          break;
        case 'showSystemNote':
          if (!R.systemNotes.has(p.noteId)) E(`${where}说明卡「${p.noteId}」不存在`);
          break;
        case 'giveItem': case 'removeItem':
          if (!R.items.has(p.id)) E(`${where}物品「${p.id}」不存在`);
          break;
        case 'updateQuest':
          if (!R.quests.has(p.id)) E(`${where}任务「${p.id}」不存在`);
          break;
        case 'setFocusedQuest':
          if (p.id && !R.quests.has(p.id)) E(`${where}任务「${p.id}」不存在`);
          break;
        case 'giveRule':
          if (!R.rules.has(p.id)) E(`${where}规矩「${p.id}」不存在`);
          break;
        case 'addArchiveEntry':
          if (!R.archive[p.bookType]) E(`${where}档案册「${p.bookType}」不认识`);
          else if (!R.archive[p.bookType].has(p.entryId)) E(`${where}档案条目「${p.bookType}/${p.entryId}」不存在`);
          break;
        case 'advanceTimeTo':
          if (!R.phases.has(p.phase)) E(`${where}时段「${p.phase}」不在 game_config.dayNight.phases`);
          break;
        case 'setEntityEnabled':
          entity(p.target, 'setEntityEnabled.target', { hotspotOk: false });
          break;
        case 'showEmote': case 'showSpeechBubble': case 'setEntityShadow':
          entity(p.target, `${type}.target`);
          if (type === 'setEntityShadow' && String(p.source).startsWith('light:') && !lights.has(String(p.source).slice(6))) {
            E(`${where}setEntityShadow 灯「${String(p.source).slice(6)}」不在场景「${sid}」的 lighting.lights 里`);
          }
          break;
        case 'playNpcAnimation': {
          entity(p.target, 'playNpcAnimation.target');
          const st = animStates(p.target);
          if (st && !st.has(p.state)) E(`${where}playNpcAnimation「${p.target}」的动画没有状态「${p.state}」`);
          if (p.thenState && st && !st.has(p.thenState)) E(`${where}playNpcAnimation「${p.target}」的动画没有状态「${p.thenState}」`);
          break;
        }
        case 'moveEntityTo': case 'jumpEntityTo': case 'teleportEntityTo':
          entity(p.target, `${type}.target`);
          inWorld(Number(p.x), Number(p.y), type);
          break;
        case 'faceEntity':
          entity(p.target, 'faceEntity.target');
          if (p.faceTarget) entity(p.faceTarget, 'faceEntity.faceTarget');
          break;
        case 'setHotspotDisplayImage': case 'persistHotspotEnabled':
          inScene(p.sceneId, 'sceneId');
          if (!hotspots.has(p.hotspotId)) E(`${where}${type} 热区「${p.hotspotId}」不在场景「${sid}」里`);
          asset(p.image, type);
          break;
        default:
          break;
      }
      // 嵌套动作(runActions / runActionsDetached / runActionsIf / randomBranch / chooseAction)
      for (const k of ['actions', 'elseActions', 'aboveActions', 'belowActions']) {
        if (Array.isArray(p[k])) for (const c of p[k]) if (c && typeof c.type === 'string') checkAction({ type: c.type, params: c.params ?? {} }, `${where}${type}.${k} → `);
      }
      if (Array.isArray(p.options)) {
        for (const o of p.options) {
          for (const c of Array.isArray(o?.actions) ? o.actions : []) if (c && typeof c.type === 'string') checkAction({ type: c.type, params: c.params ?? {} }, `${where}${type}.options → `);
        }
      }
    };

    const names = new Map();
    for (const [i, step] of sc.steps.entries()) {
      const where = `步骤 ${i}:`;
      at = where;
      if ('checkpoint' in step) {
        if (names.has(step.checkpoint)) E(`检查点名「${step.checkpoint}」重复(第 ${names.get(step.checkpoint)} 与第 ${i} 步)`);
        names.set(step.checkpoint, i);
      } else if ('cmd' in step) {
        const c = step.cmd;
        used.commands.add(c.type);
        if (!R.commands.has(c.type)) E(`${where}运行时命令「${c.type}」master 不认`);
        switch (c.type) {
          case 'debugExecuteAction':
            if (!c.action || typeof c.action.type !== 'string') E(`${where}debugExecuteAction 缺 action.type`);
            else checkAction({ type: c.action.type, params: c.action.params ?? {} }, where);
            break;
          case 'debugSetNarrativeState': {
            const st = R.narrative.get(c.graphId);
            if (!st) E(`${where}叙事图「${c.graphId}」不存在`);
            else if (!st.has(c.stateId)) E(`${where}叙事图「${c.graphId}」没有状态「${c.stateId}」`);
            break;
          }
          case 'debugSetPlayerPosition': case 'debugMovePlayerTo': case 'playerMoveTo':
            inWorld(Number(c.x), Number(c.y), c.type);
            break;
          case 'playerPosture':
            if (!['crouch', 'gaze', 'lie'].includes(c.posture)) E(`${where}playerPosture posture「${c.posture}」master 不认(crouch / gaze / lie)`);
            break;
          case 'playerAct':
            if (R.verbKeys.size && !R.verbKeys.has(c.verb)) E(`${where}playerAct verb「${c.verb}」不在 master 的 VERB_KEYS`);
            break;
          case 'debugInteractNpc':
            if (!npcs.has(c.npcId)) E(`${where}NPC「${c.npcId}」不在场景「${sid}」里`);
            break;
          default:
            break;
        }
      } else if ('api' in step) {
        used.apis.add(step.api);
        if (!R.devApi.has(step.api)) E(`${where}__gameDevAPI.${step.api} master 上没有`);
      } else if ('key' in step || 'keyDown' in step || 'keyUp' in step) {
        const k = step.key ?? step.keyDown ?? step.keyUp;
        used.keys.add(k);
        const known = R.panelKeys.has(k) || [...R.verbKeys.values()].includes(k) || [...R.propKeys.values()].includes(k) || GENERIC_KEYS.has(k);
        if (!known) W(`${where}按键「${k}」不是 master 认得的面板 / 动词 / 挂件 / 通用键`);
      } else if ('click' in step || 'wheel' in step) {
        const pt = step.click ?? step.wheel;
        if (!(pt.x >= 0 && pt.x < viewport.width && pt.y >= 0 && pt.y < viewport.height)) E(`${where}鼠标点 (${pt.x}, ${pt.y}) 在视口 ${viewport.width}×${viewport.height} 之外`);
      } else if (!('advance' in step || 'viewport' in step || 'settle' in step)) {
        E(`${where}认不出的步骤 ${JSON.stringify(step).slice(0, 120)}`);
      }
    }
  }
  return { errors, warnings: [...new Set(warnings)], notes: [...new Set(notes)], used };
}
