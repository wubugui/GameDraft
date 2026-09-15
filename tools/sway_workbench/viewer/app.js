// 草木工作台前端：原画上涂三个通道（补植被 / 锁死 / 刚体）→ 推给游戏看 → 满意了导出到游戏。
//
// 两个按钮的意思是制作人 2026-09-14 定死的（"推给游戏是指立即推送给运行时的游戏！资源写游戏应该叫做导出到游戏"）：
//   推给游戏   = 页面上**此刻**的涂层（存没存都算）烘一份预览，在跑着的游戏里原地换上，**资源一个字节不动**；
//   导出到游戏 = 先存盘，再烘进资源（各时段照明载荷目录），发行包里就是这一份。
// ⚠ 原先的「推给游戏」只让游戏重装盘上已经烘好的那份：涂了、存了、按多少次，游戏里都是上一次烘的样子。
//
// 三个通道各有**自己的**一张原画分辨率画布（白色 = 涂满），存盘时才合成 RGBA：
// R 补植被、G 锁死、B 刚体。⚠ 不许三个通道挤在一张画布上加色画：
//   ① 橡皮只能整体擦，改一个通道会连带擦掉另外两个（作者报的"只能画不能擦"就是这条）；
//   ② canvas 是预乘的，在同一张上叠画另一个通道会把先前通道的值冲淡（实测 20828 → 20446）。
// 显示时按视图缩放贴上去——所以不管怎么缩放平移，落盘的永远是原画像素。
// 叠加显示的那几层（已抠出的植被 / 实例分区 / 自由度）都从服务端现取 sway_*.png，
// **不在前端重算任何拆层逻辑**（那一份只在 sway_field.py）。

const $ = (id) => document.getElementById(id);
const api = async (p, body) => {
  const r = await fetch(p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => ({ ok: false, err: '返回不是 JSON' }));
  if (!j.ok) {
    const e = new Error(j.err || '失败');
    Object.assign(e, j);                       // 把 conflict / needConfirm / before / after 带出来
    throw e;
  }
  return j;
};

const CHANNELS = ['veg', 'freeze', 'rigid', 'unrigid'];   // → 存盘时的 R / G / B / A（服务端合成）
const CH_COLOR = {
  veg: [95, 208, 122], freeze: [224, 178, 92], rigid: [106, 168, 255], unrigid: [255, 110, 140],
};
const CH_NAME = { veg: '补植被', freeze: '锁死不动', rigid: '加刚体', unrigid: '减刚体' };

const S = {
  scene: '', native: [1, 1], view: { x: 0, y: 0, k: 1 }, chan: 'rigid', erase: false, dirty: false,
  show: { paint: true, veg: true, ids: false, free: false, rigid: false },
  lockMerged: false,
  needsExport: false,    // 盘上的涂层比资源里的拆层新 = 存过但没导出，资源（发行包）里还是上一版
  previewNewer: false,   // 推给游戏的预览与资源里那份内容不同 = 游戏里看到的是预览，还没导出（服务端按内容指纹判）
  hasPreview: false,     // 本机有这个场景推过的预览（丢弃改动时据它决定要不要去撤）
  layers: null, imgs: {}, buf: {}, painting: false, last: null,
  undo: [], redo: [], stroke: null,
  undoByteCap: 320 * 1024 * 1024,   // 撤销栈总字节上限（另有四十条的上限）：见 beginStroke 的注释
  baseMtime: 0,          // 装载时盘上那份的时间戳（乐观并发：别让两个窗口互相覆盖）
  draftTimer: null,      // 本地草稿（浏览器崩了 / 误关窗也不丢手上的活）
  chDirty: {},           // 哪几层和盘上那份不一样了（草稿只编码这几层）
  // 作者逐株设置（原画像素位置，不存实例 id——id 每次烘焙都会变）：锚点、整体摆
  ov: { anchors: [], coherent: [] },
  ovDirty: false,
  tool: 'paint',         // paint | anchor | coherent
};

// ---------------------------------------------------------------- 本地草稿
/**
 * 草稿存哪儿：服务端 `local/sway_drafts/<场景>.json`（`/api/draft`）。
 * ⚠ 原来放 localStorage：桌面壳是纯内存 profile、端口每次随机，关窗 / 崩了草稿跟着没——
 *   "浏览器崩了 / 误关窗只丢 8 秒"在主入口里从来不成立。自检把 put / get / clear 换成桩（`__draftStoreForTest`）。
 */
const draftStore = {
  put: (sid, d) => api('/api/draft', { scene: sid, draft: d }),
  get: async (sid) => (await api('/api/draft?scene=' + encodeURIComponent(sid))).draft || null,
  clear: (sid) => api('/api/draft/clear', { scene: sid }),
  // 「先不管」= 收起来：改名成 <场景>.stash-<at>.json，之后的自动草稿 / 存盘都不碰它，「历史…」里能恢复或删
  stash: (sid) => api('/api/draft/stash', { scene: sid }),
  stashes: async (sid) => (await api('/api/draft/stashes?scene=' + encodeURIComponent(sid))).items || [],
  getStash: async (sid, name) => (await api(`/api/draft/stash?scene=${encodeURIComponent(sid)}&name=${encodeURIComponent(name)}`)).draft || null,
  deleteStash: (sid, name) => api('/api/draft/stash/delete', { scene: sid, name }),
};
/** 这一局里作者已经说过"不恢复"的草稿（场景 → 草稿时间戳）：同一份不再一装场景就问一次 */
const draftDeclined = new Map();

/**
 * 存草稿。两条都是手感相关的硬要求：
 * - **笔按着的时候绝不存**：一层 PNG 编码 ~45 ms，四层 ~180 ms，正画着卡这一下就是"一顿"。
 * - **只编码和盘上不一样的层**：草稿是"相对盘上那份的增量"，恢复时先装盘上的再盖这几层。
 *   通常只有一层动过，于是一次 ~45 ms，还挑空闲时段做。
 */
function draftPayload() {
  if (!S.scene || !S.dirty || S.painting) return null;
  const dirty = CHANNELS.filter((c) => S.chDirty[c]);
  if (!dirty.length && !S.ovDirty) return null;
  const d = { at: Date.now(), base: S.baseMtime, ch: {} };
  for (const c of dirty) d.ch[c] = channelDataURL(c);
  if (S.ovDirty) d.ov = JSON.parse(JSON.stringify(S.ov));
  return d;
}

function saveDraft() {
  // 便宜的判定先做，别为了一次空转去排 idle
  if (!S.scene || !S.dirty || S.painting) return;
  if (!CHANNELS.some((c) => S.chDirty[c]) && !S.ovDirty) return;
  const sid = S.scene;                 // ⚠ 排队期间人可能已经切了场景
  const run = () => {
    if (S.scene !== sid) return;       // 切走了：这份草稿属于上一个场景，写下去就是把 A 的活存进 B 的键
    // 作者刚选了「不保存」：新场景装完之前 dirty 还挂着，这时写草稿等于把刚丢掉的活又存回去
    if (S.draftSuppress === sid) return;
    const d = draftPayload();
    if (!d) return;                    // 排队期间人又下笔了：这一轮让掉，下一轮再存
    // 草稿是兜底不是主路：存不上只记一笔，不打扰画画
    Promise.resolve(draftStore.put(sid, d)).catch((e) => { S.draftErr = String((e && e.message) || e); });
  };
  if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 2000 });
  else run();
}

function clearDraft(sid = S.scene) {
  if (!sid) return;
  draftDeclined.delete(sid);
  Promise.resolve(draftStore.clear(sid)).catch(() => { /* 没有就没有 */ });
}

/**
 * 页内多选一（不用浏览器的 confirm：只有「确定 / 取消」两个键，"先保存再切"这种三选一给不出来，
 * 而且「确定」= 丢掉手上的活，顺手一个回车就没了）。`choices = [[值, 文字, 'primary'|'danger'?], …]`，
 * 第一个是取消（Esc 也回它）；焦点落在第一个按钮上，回车不会误触危险的那个。
 */
function choose(title, msg, choices) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    const box = document.createElement('div');
    box.className = 'modal-box';
    const h = document.createElement('h3');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = msg;
    const row = document.createElement('div');
    row.className = 'modal-btns';
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(choices[0][0]); return; }
      // 模态开着时页面快捷键一律不收（按 X 清层、按 B 导出这种不能从对话框底下漏过去）
      if (!['Tab', 'Enter', ' '].includes(e.key)) e.stopPropagation();
    };
    const done = (v) => { window.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v); };
    for (const [v, text, kind] of choices) {
      const b = document.createElement('button');
      b.textContent = text;
      b.dataset.choice = v;
      if (kind) b.classList.add(kind);
      b.addEventListener('click', () => done(v));
      row.appendChild(b);
    }
    box.append(h, p, row);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    window.addEventListener('keydown', onKey, true);
    row.firstChild.focus();
  });
}

/**
 * 装场景时发现盘上有这个场景的草稿：问一句。**不挡装载**（场景先画出来、先能看能画），作者答了再叠。
 * 三个选项：恢复 / 删掉这份草稿 / 先不管（留着，这一局不再问）。原来只有恢复或取消，取消了草稿永远留在盘上、每次打开都问。
 */
async function offerDraft() {
  const sid = S.scene, token = S.openToken;
  let d = null;
  try { d = await draftStore.get(sid); } catch { d = null; }
  if (!d || !d.ch || S.scene !== sid) return false;
  if (draftDeclined.get(sid) === d.at) return false;   // 这一局里已经说过先不管这一份了
  const age = Math.round((Date.now() - d.at) / 1000);
  const which = [...CHANNELS.filter((c) => d.ch[c]).map((c) => CH_NAME[c]), ...(d.ov ? ['锚点 / 整体摆'] : [])].join('、');
  // 草稿是增量：盘上那份在草稿写完之后又被改过的话，叠上去就是两份混在一起——说清楚再让人选
  const drifted = d.base !== undefined && d.base !== S.baseMtime;
  const warn = drifted ? '\n\n⚠ 盘上那份在这份草稿之后又被改过（另一个窗口？），叠上去会把两边混在一起。' : '';
  const pickDraft = await choose('发现没保存的草稿',
    `「${sid}」有一份 ${age < 90 ? age + ' 秒前' : Math.round(age / 60) + ' 分钟前'}没保存的草稿（${which}）。${warn}`,
    [['later', '先不管'], ['drop', '删掉草稿', 'danger'], ['restore', '恢复', 'primary']]);
  if (S.scene !== sid || S.openToken !== token) return false;   // 答的这会儿已经切走了
  if (pickDraft === 'drop') { clearDraft(sid); log('草稿已删掉'); return false; }
  if (pickDraft !== 'restore') {
    // 「先不管」：收进「历史…」里（原来只在内存里记一笔，8 秒后的自动草稿就把它覆盖了、一存盘就删了——等于延迟删除）
    try {
      await draftStore.stash(sid);
      log('这份草稿收进「历史…」里了，随时能恢复或删掉');
    } catch (e) {
      draftDeclined.set(sid, d.at);
      log('草稿没收起来（' + ((e && e.message) || e) + '），先留在原处');
    }
    return false;
  }
  return applyDraft(d);
}

/** 草稿里带着哪几层（给人看的名字）：确认框与日志都要说清楚"换掉的是哪几层" */
const draftLayerNames = (d) => [...CHANNELS.filter((c) => d.ch && d.ch[c]).map((c) => CH_NAME[c]), ...(d.ov ? ['锚点 / 整体摆'] : [])];

/**
 * 把一份草稿（相对盘上那份的增量）用到页面上：**草稿里有的层整层替换**、逐株设置整份换。
 * 返回 true = 全部换上了；有一层图读不出来就**一层都不动**、返回 false（原来读不出的那层悄悄跳过、其余照换）。
 * 换之前把被换掉的每一层整层收一份、连同原来的锚点 / 整体摆作为**一组**进撤销栈：一下 Ctrl+Z 全回去。
 * ⚠ 原来不进撤销栈：恢复收起来的草稿把之后 20 分钟的笔画整层盖掉，Ctrl+Z 只会把更早的笔画补丁贴到换过的层上、拼成一块花脸。
 */
async function applyDraft(d) {
  const sid = S.scene;
  const chans = CHANNELS.filter((c) => d.ch[c]);
  const imgs = await Promise.all(chans.map((c) => loadImg(d.ch[c])));
  if (S.scene !== sid || imgs.some((im) => !im)) {
    for (const im of imgs) releaseImg(im);
    if (S.scene === sid) log('⛔ 草稿里有一层图读不出来，一层都没动');
    return false;
  }
  const parts = chans.map((c) => layerPatch(c));
  if (d.ov) parts.push({ kind: 'ov', prev: JSON.parse(JSON.stringify(S.ov)) });
  if (parts.length) pushUndo({ kind: 'group', parts, bytes: parts.reduce((n, p) => n + (p.bytes || 0), 0) });
  chans.forEach((c, i) => { loadChannel(c, imgs[i]); releaseImg(imgs[i]); S.chDirty[c] = true; });
  if (d.ov) { S.ov = d.ov; S.ovDirty = true; }
  S.dirty = true;
  log(`已从草稿恢复「${draftLayerNames(d).join('、')}」（整层换成草稿里的；Ctrl+Z 撤回；还没落盘，记得 Ctrl+S）`);
  return true;
}

const log = (m, cls) => {
  const el = $('log');
  el.textContent += (el.textContent ? '\n' : '') + m;
  el.scrollTop = el.scrollHeight;
};

// ---------------------------------------------------------------- 装载
/**
 * 场景下拉框的清单（带每个场景的状态）。**可以反复调**，选中项保持不变。
 * ⚠ 原来只在启动时读一次：推 / 导出 / 保存之后标签还写着"没烘过"、没"有涂层"；更要命的是
 *   标着"没有深度，装不了（先在照明实验室烘几何场）"的场景，作者照做烘完回来，它照样灰着选不了，只能重启工具。
 *   现在点开下拉框之前（focus / mousedown）、窗口重新拿到焦点、保存 / 推送 / 导出成功之后各刷一次。
 * 场景集合没变时**原地改**每一项的文字与可选状态，不重建：下拉列表正开着时整个换掉会把它关掉 / 选中项跳走。
 */
async function loadScenes() {
  const j = await api('/api/scenes');
  const sel = $('scene');
  const keep = sel.value || S.scene;
  const same = sel.options.length === j.scenes.length && j.scenes.every((s, i) => sel.options[i].value === s.id);
  if (!same) sel.innerHTML = '';
  j.scenes.forEach((s, i) => {
    const o = same ? sel.options[i] : document.createElement('option');
    const st = s.hasBackground === false ? '没有背景图，装不了'
      : !s.depth ? '没有深度，装不了（先在照明实验室烘几何场）'
        : s.sway ? `v${s.sway.version} · ${s.sway.instances} 株${s.sway.paint ? ' · 有涂层' : ''}` : '没烘过';
    const text = `${s.id}　（${st}）`;
    const disabled = !s.depth || s.hasBackground === false;
    if (o.value !== s.id) o.value = s.id;
    if (o.textContent !== text) o.textContent = text;
    if (o.disabled !== disabled) o.disabled = disabled;
    if (!same) sel.appendChild(o);
  });
  if (keep && sel.value !== keep) sel.value = keep;
  return j.scenes;
}

/** 刷新场景清单：同一时刻只一发，1.5 s 内的重复触发（focus 紧跟 mousedown）并掉；失败不打扰（下拉框照旧能用） */
let _scenesInFlight = null, _scenesAt = 0;
function refreshScenes(force = false) {
  // 保存 / 导出之后那一发（force）不能搭在它之前就发出去的那一发上：那一发读到的是改之前的状态
  if (_scenesInFlight) return force ? _scenesInFlight.then(() => refreshScenes(true)) : _scenesInFlight;
  if (!force && Date.now() - _scenesAt < 1500) return Promise.resolve();
  _scenesAt = Date.now();
  _scenesInFlight = loadScenes().catch(() => {}).finally(() => { _scenesInFlight = null; });
  return _scenesInFlight;
}

/**
 * 复用的临时画布（按用途取名，整个页面每种用途只有一张）。
 *
 * ⚠ 为什么必须复用：画布和解码后的图片占的是 JS 堆**外**的内存，垃圾回收感知不到压力、不会及时回收。
 *   原来每切一次场景新建 4 张涂层画布 + 8 张大图、每重画一次新建一张整幅叠加层，旧的只是不再引用——
 *   实测新开页面连切 5 次场景，第 6 次起**所有图片都加载不出来**（既不成功也不报错），
 *   切场景表现为"名字变了、画面不动"（制作人 2026-09-13 报）。
 * ⚠ 复用必须清空：每次取出都**重新赋一次宽高**——即使尺寸没变也要赋：按规范这一步把像素清掉、
 *   并把变换 / 透明度 / 合成模式等画布状态全部复位。只 clearRect 不复位状态的话，上一次留下的
 *   `globalCompositeOperation`（橡皮用 destination-out）会让下一次画上去的东西直接被抹掉。
 * 取出来的画布只在**这一次同步调用里**有效：下一次取同名画布就被清空了，别留引用。
 */
const _scratch = new Map();
function scratch(name, w, h, willRead = false) {
  let c = _scratch.get(name);
  if (!c) {
    c = document.createElement('canvas');
    _scratch.set(name, c);
  }
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return { c, x: c.getContext('2d', { willReadFrequently: willRead }) };
}

/** 图片用完就断开，让浏览器立刻丢掉解码数据（不等垃圾回收） */
function releaseImg(im) {
  if (im) {
    im.onload = null;
    im.onerror = null;
    im.src = '';
  }
}

const loadImg = (url) => new Promise((res) => {
  const im = new Image();
  im.onload = () => res(im);
  im.onerror = () => res(null);
  im.src = url;
});

/**
 * 装一个场景。
 *
 * 🔴 **全部读到才算切过去**（制作人 2026-09-13："切了场景没反应，画面都不变"）。
 * 原来一进来就把 `S.scene` 改成新场景、再去请求；请求一失败（比如 dev_room 根本没有背景图），
 * 异常没人接——日志一个字没有、下拉框显示新名字、画面停在旧场景，**而页面以为自己已经在新场景上**：
 * 这时按 Ctrl+S 会把旧场景的涂层存进新场景名下，推送 / 导出也打到错的场景。
 * 现在：先请求，全部成功才换 `S.scene` 与画面；失败留在原场景、下拉框退回、日志里说清楚为什么。
 */
async function openScene(sid, opts = {}) {
  const prev = S.scene;
  if (S.dirty && !opts.force) {
    // 「保存并切换 / 不保存 / 取消」：原来浏览器 confirm 只有确定（= 丢掉手上的活）和取消，想先存得取消、存、再选一次
    const how = await choose('涂层还没保存',
      sid === prev ? `重新装「${sid}」会丢掉这些改动。` : `切到「${sid}」之前怎么处理「${prev}」上这些改动？`,
      [['cancel', '取消'], ['discard', '不保存', 'danger'], ['save', sid === prev ? '先保存' : '保存并切换', 'primary']]);
    if (how === 'save') await save();
    if (how === 'cancel' || (how === 'save' && S.dirty)) {
      $('scene').value = prev || '';    // 取消了（或没存上）就把下拉框退回去，别让名字和画面对不上
      return;
    }
    if (how === 'discard' && prev) {
      // 明说了不要：草稿也删，装载这一两秒里定时草稿也别把它写回来（dirty 要到新场景装完才清）
      S.draftSuppress = prev;
      clearDraft(prev);
      if (sid === prev) opts = { ...opts, noDraft: true };
      // 推过的预览烘自刚丢掉的这份：撤掉（等它删完再装：重装同一个场景时叠加层要读回资源那份）
      await revokePreview(prev);
    }
  }
  // ⚠ 只认最后一次：画布是复用的，前一次还没装完、后一次已经开始的话，
  //   两次会往**同一组**画布里写，后装完的那个（可能是旧场景）把新场景的涂层盖掉
  const token = (S.openToken = (S.openToken || 0) + 1);
  log(`装入 ${sid}…`);
  const fail = (why) => {
    S.draftSuppress = null;
    log(`⛔ 装不上 ${sid}：${why}${prev ? `（还停在 ${prev}）` : ''}`);
    $('scene').value = prev || '';
  };
  let L, got;
  try {
    L = await api('/api/layers?scene=' + encodeURIComponent(sid));
    if (token !== S.openToken) return;
    const q = '&t=' + Date.now();
    got = await Promise.all([
      loadImg(`/api/img?scene=${encodeURIComponent(sid)}&kind=background${q}`),
      loadImg(`/api/img?scene=${encodeURIComponent(sid)}&kind=matte${q}`),
      loadImg(`/api/img?scene=${encodeURIComponent(sid)}&kind=ids${q}`),
      loadImg(`/api/img?scene=${encodeURIComponent(sid)}&kind=rigid${q}`),
      ...CHANNELS.map((c) => loadImg(`/api/ch?scene=${encodeURIComponent(sid)}&name=${c}${q}`)),
    ]);
  } catch (e) {
    if (token === S.openToken) fail(e.message || String(e));
    return;
  }
  const [bg, matte, ids, rigid, ...chImgs] = got;
  if (token !== S.openToken || !bg) {
    for (const im of got) releaseImg(im);
    if (token === S.openToken) fail('原画读不出来');
    return;
  }
  // ---- 从这里开始才真正换场景 ----
  S.scene = sid;
  $('scene').value = sid;
  document.title = '草木工作台 · ' + sid;
  // 「历史…」列的是上一个场景的：留着的话点恢复是拿 A 的历史名去恢复 B（"没有这一份历史"），点草稿的恢复没反应
  $('history-box').style.display = 'none';
  $('history-box').innerHTML = '';
  if (S.draftSuppress) { clearDraft(S.draftSuppress); S.draftSuppress = null; }   // 再清一次在飞的那一发
  // 上一个场景的大图断开、着色缓存作废（画布本身留着复用）
  for (const im of Object.values(S.imgs || {})) releaseImg(im);
  invalidateTint();
  S.layers = L;
  S.native = L.native;
  S.imgs = { bg, matte, ids, rigid };
  S.idMap = ids ? readIds(ids) : null;
  S.hover = 0;
  // 四层各一张画布，**跨场景复用**：重新赋宽高 = 清空像素并复位画笔状态（见 scratch 的注释）
  const [nw, nh] = S.native;
  S.buf = {};
  for (const c of CHANNELS) {
    const { x } = scratch('buf:' + c, nw, nh, true);
    S.buf[c] = x;
  }
  CHANNELS.forEach((c, i) => { loadChannel(c, chImgs[i]); releaseImg(chImgs[i]); });
  S.baseMtime = L.paintMtime || 0;
  S.ov = { anchors: (L.overrides && L.overrides.anchors) || [], coherent: (L.overrides && L.overrides.coherent) || [] };
  S.ovDirty = false;
  S.needsExport = needsExportOf(L);
  S.previewNewer = previewNewerOf(L);
  S.hasPreview = (L.previewMtime || 0) > 0;
  S.undo = [];
  S.redo = [];
  S.dirty = false;
  S.chDirty = {};
  // 先把场景画出来再问草稿：草稿在服务端，问一趟要时间，别让作者对着上一个场景 / 黑屏等
  fitView();
  showState(L);
  const painted = CHANNELS.reduce((n, c) => n + (L.counts ? (L.counts[c] || 0) : 0), 0);
  log(`装入 ${sid}（${nw}×${nh}）${painted ? `，已有涂层 ${painted} 像素` : ''}`);
  draw();
  if (!opts.noDraft) offerDraft().then((restored) => { if (restored && S.scene === sid) draw(); }).catch(() => { /* 草稿是兜底 */ });
  // 后台预热：按推送的口径把这个场景算一遍（不写盘），第一次「推给游戏」就不用等分割与补图
  api('/api/warm', { scene: sid }).catch(() => { /* 预热失败不是错，推送时照常算 */ });
}

/** 状态行：几株、覆盖率；叠加层是推送的预览（还没导出）时说出来 */
function showState(L) {
  const m = L.meta;
  $('state').textContent = m
    ? `${m.instances.length} 株 · v${m.version}${L.stale ? '（旧版，要重新导出）' : ''}`
      + ` · 植被 ${(m.veg_coverage * 100).toFixed(1)}%`
      + (m.lock ? ` · 锁死 ${(m.lock.coverage * 100).toFixed(1)}%` : '')
      + (m.rigid_coverage ? ` · 刚体 ${(m.rigid_coverage * 100).toFixed(1)}%` : '')
      + (L.source === 'preview' ? ' · 叠加层是推给游戏的预览（还没导出）' : '')
    : '这个场景还没烘过拆层 —— 点「推给游戏」跑一次自动分割打底（第一次要几十秒）';
}

/**
 * 推送 / 导出之后只换"拆层产物"那几层（已抠出的植被 / 实例分区 / 已判定的刚体、实例表、状态行）。
 * ⚠ 不许走 openScene：它会从盘上重装四层涂层，**没存的笔画就没了**（推给游戏本来就不要求先存）。
 */
async function refreshDerived(sid) {
  if (S.scene !== sid) return;
  const kinds = ['matte', 'ids', 'rigid'];
  let L, got;
  try {
    L = await api('/api/layers?scene=' + encodeURIComponent(sid));
    const q = '&t=' + Date.now();
    got = await Promise.all(kinds.map((k) => loadImg(`/api/img?scene=${encodeURIComponent(sid)}&kind=${k}${q}`)));
  } catch (e) {
    log('刷新叠加层失败：' + e.message);
    return;
  }
  if (S.scene !== sid) { for (const im of got) releaseImg(im); return; }
  kinds.forEach((k, i) => { releaseImg(S.imgs[k]); S.imgs[k] = got[i]; });
  S.idMap = S.imgs.ids ? readIds(S.imgs.ids) : null;
  S.layers = L;
  S.needsExport = needsExportOf(L);
  S.previewNewer = previewNewerOf(L);
  S.hasPreview = (L.previewMtime || 0) > 0;
  invalidateTint();
  showState(L);
  draw();
  refreshScenes(true);               // 下拉框里"没烘过 / v? · N 株"跟着这次推送 / 导出变
}

/**
 * 盘上的涂层是不是还没进资源。服务端给了 `needsExport`（按烘焙**读到的**输入指纹比）就用它；
 * 老服务端没有这个字段才退回比写盘时刻。
 * ⚠ 只比时刻会漏：导出正烘着时作者又存了一次，烘焙最后才写 sway.json，时刻比完"资源更新"，
 *   「待导出」从此不亮——资源（发行包）里却没有烘焙途中存下的那几笔。
 */
function needsExportOf(L) {
  return typeof L.needsExport === 'boolean' ? L.needsExport : (L.paintMtime || 0) > (L.bakedMtime || 0);
}

/**
 * 游戏里 / 叠加层是不是推送的预览（与资源里那份内容不同）。服务端给了 `previewDiffersFromExport`（按输入内容指纹比）就用它；
 * 老服务端没有才退回比写盘时刻。
 * ⚠ 只比时刻会骗人：推了一版试验又丢掉，预览的时刻照样最新，徽章一直说「资源还没导出」、叫人按 P 再推；
 *   撤销回导出的样子再推一次，内容与资源一模一样，也照样这么说。
 */
function previewNewerOf(L) {
  return typeof L.previewDiffersFromExport === 'boolean' ? L.previewDiffersFromExport : (L.previewMtime || 0) > (L.bakedMtime || 0);
}

/** 与游戏联动里自检要换成桩的口子（自检跑在真页面、真服务上：撤预览这一下绝不能删到作者本机的真预览、打到真游戏） */
const gameLink = {
  revoke: (sid) => api('/api/push/revoke', { scene: sid }),
};

/**
 * 丢弃没保存的改动（切场景 / 重装选「不保存」、关窗 / 刷新选「不保存」、恢复历史）之后：
 * 推给游戏的预览要是烘自被丢掉的那份（与盘上这份内容不同，服务端判），就撤掉——删本机预览目录（资源不动），
 * 游戏在后台换回资源里那份。服务端不等游戏就回，关窗时壳只等 2 秒也来得及。
 * ⚠ 原来什么都不做：被丢掉的试验在这一局游戏里一直显示（每次进场景都再装一遍），之后哪天打开这个场景，
 *   叠加层和 Alt+点检视还是那版，作者照着它决定哪里不用再涂。
 */
async function revokePreview(sid) {
  if (!sid || sid !== S.scene || !S.hasPreview) return false;
  try {
    const r = await gameLink.revoke(sid);
    if (!r || !r.revoked) return false;
    if (S.scene === sid) { S.hasPreview = false; S.previewNewer = false; }
    if (lastPush && lastPush.sid === sid) lastPush = null;
    // 还在等游戏页进这个场景、起来后要补发预览的那一轮：预览已经没了，别再补发
    if (waitingForGame && waitingForGame.sid === sid) waitingForGame.cancelled = true;
    // 资源里没有游戏装得上的这一层（从没导出过 / 版本旧 / 一株都没有）：游戏没东西可换回，推上去那层还挂着——
    // 不许说"换回资源里这份"（第七轮复核）；服务端按运行时同一判据给 hasExport
    if (r.hasExport === false) log('资源里还没有这个场景的草木层：刚推的预览已撤掉，游戏里挂着的那层也拆掉了（导出之后草木才会摆）');
    else log('游戏换回资源里这份（刚推的预览没保存，已撤掉）');
    renderBadges();
    return true;
  } catch (e) {
    log('撤掉推过的预览失败：' + ((e && e.message) || e));
    return false;
  }
}

/**
 * 一层的**不透明灰度**图 → 这一层的画布（白 + alpha = 强度）。
 *
 * ⚠ 收发一律走不透明灰度,**不许把数据放在 alpha 里**:canvas 按 alpha 预乘,alpha=0 的像素
 * RGB 会被清成 0。本仓已经被这条坑过两次(matte 的 alpha、涂层的第四通道),第二次的症状是
 * "保存成功、刷新回来全没了"。
 */
function loadChannel(ch, img) {
  const [nw, nh] = S.native;
  S.buf[ch].clearRect(0, 0, nw, nh);
  if (!img) return;
  const { x } = scratch('load-channel', nw, nh, true);
  x.drawImage(img, 0, 0, nw, nh);
  const src = x.getImageData(0, 0, nw, nh).data;
  const d = S.buf[ch].createImageData(nw, nh);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    p[i] = 255; p[i + 1] = 255; p[i + 2] = 255; p[i + 3] = src[i];   // 灰度值 = 这一层的强度
  }
  S.buf[ch].putImageData(d, 0, 0);
}

/**
 * 这一层的画布 → **不透明灰度** dataURL（存盘用；alpha 全 255，数据在亮度上）。
 *
 * 缓冲里是"白 + alpha"，把它按 source-over 画到**黑底**上，出来的 RGB 就是 `255*a/255 = a`
 * ——正好是要的灰度，整张交给 GPU，不用在 JS 里爬 940 万像素。
 * ⚠ 这两种算法的产物**逐字节相等**（验过 2048×1152×4 层，零差异）；哪天要动这里，
 * 先把两条路的输出比一遍再改：这些字节就是数据本身，差 1 都会在每次存读之间越漂越远。
 */
function channelDataURL(ch) {
  const [nw, nh] = S.native;
  const { c: out, x } = scratch('channel-out', nw, nh);
  x.fillStyle = '#000';
  x.fillRect(0, 0, nw, nh);
  x.drawImage(S.buf[ch].canvas, 0, 0);
  return out.toDataURL('image/png');
}

/**
 * 实例 id 图的 CPU 副本（半分辨率够用）：悬停查"指着哪一株"。
 * ⚠ id 图必须**最近邻**读：插值出来的 id 是两株之间的假 id（运行时那份也踩过这条）。
 */
function readIds(img) {
  const [nw, nh] = S.native;
  const w = Math.max(1, nw >> 1), h = Math.max(1, nh >> 1);
  const { x } = scratch('read-ids', w, h, true);
  x.imageSmoothingEnabled = false;
  x.drawImage(img, 0, 0, w, h);
  return { data: x.getImageData(0, 0, w, h).data, w, h };
}

/** 画面点 → 实例 id（0 = 不属于任何一株） */
function idAt(sx, sy) {
  const m = S.idMap;
  if (!m) return 0;
  const [nw, nh] = S.native;
  const ix = Math.min(m.w - 1, Math.max(0, Math.floor((sx / nw) * m.w)));
  const iy = Math.min(m.h - 1, Math.max(0, Math.floor((sy / nh) * m.h)));
  const o = (iy * m.w + ix) * 4;
  return m.data[o] + 256 * m.data[o + 1];
}

/**
 * 几株整片上色的蒙版（整体摆的株 / 悬停的那株），按 **id 图本身 + 排好序的 id** 缓存。
 * ⚠ 原来每次 draw 都重建：画笔每个鼠标移动都要爬一遍半分辨率 id 图（≈ 59 万像素）、再传一张新纹理，
 *   标过一株整体摆之后笔刷就从 ≈ 2 ms 一次变成十几 ms，"画笔只重画经过的那一块"白做。
 *   id 图换了（装场景 / 推送导出后 refreshDerived 换了新对象）或 id 集合变了（点整体摆、撤销、恢复草稿）键就变，自然重建。
 * ⚠ 与 tintFromChannel 同一条：在共用的 `tint-build` 里算、拷进缓存画布再贴，刚 putImageData 的那张第一次贴出去
 *   低 alpha 处取整不同，局部重画与整张重画会差出一道方框接缝。
 */
const _idMask = new Map();          // 用途 → { map, key, c }
function idMaskCanvas(name, ids, rgba) {
  const m = S.idMap;
  const key = [...ids].sort((a, b) => a - b).join(',');
  const hit = _idMask.get(name);
  if (hit && hit.map === m && hit.key === key) return hit.c;
  const { c: build, x } = scratch('tint-build', m.w, m.h, true);
  const d = x.createImageData(m.w, m.h);
  const p = d.data, s = m.data;
  for (let i = 0; i < p.length; i += 4) {
    if (!ids.has(s[i] + 256 * s[i + 1])) continue;
    p[i] = rgba[0]; p[i + 1] = rgba[1]; p[i + 2] = rgba[2]; p[i + 3] = rgba[3];
  }
  x.putImageData(d, 0, 0);
  const { c, x: cx } = scratch(name, m.w, m.h);
  cx.drawImage(build, 0, 0);
  _idMask.set(name, { map: m, key, c });
  return c;
}

/**
 * 「实例分区」叠加层：每一株一个颜色（色相按株号散开），不属于任何一株（id 0）全透明。
 * ⚠ 不许直接把 sway_ids.png 贴上去：那张是**不透明 RGB**（R/G = 株号，B = 类别），崖墓入口实测 R 最大才 45——
 *   贴上去就是整幅 55% 的近黑蒙版，相邻两株红色只差 1/255：按钮亮着、画面只是变暗，一株也分不出来。
 * 与 idMaskCanvas 同一套缓存（`_idMask`，键 = idMap 对象：装场景 / 推送导出后换了新对象自然重建，invalidateTint 一并清掉），
 * 同一条"在 tint-build 里算、拷过一次再贴"。贴的时候关插值（见 draw）：半分辨率放大，插值会在两株交界糊出第三种颜色。
 */
function idPartitionCanvas() {
  const m = S.idMap;
  const hit = _idMask.get('partition');
  if (hit && hit.map === m) return hit.c;
  const { c: build, x } = scratch('tint-build', m.w, m.h, true);
  const d = x.createImageData(m.w, m.h);
  const p = d.data, s = m.data;
  let lastId = 0, rgb = null;
  for (let i = 0; i < p.length; i += 4) {
    const id = s[i] + 256 * s[i + 1];
    if (!id) continue;                               // 不属于任何一株：透明，原画照常看得见
    if (id !== lastId) { lastId = id; rgb = idColor(id); }
    p[i] = rgb[0]; p[i + 1] = rgb[1]; p[i + 2] = rgb[2]; p[i + 3] = 255;
  }
  x.putImageData(d, 0, 0);
  const { c, x: cx } = scratch('id-partition', m.w, m.h);
  cx.drawImage(build, 0, 0);
  _idMask.set('partition', { map: m, key: '', c });
  return c;
}

/** 株号 → 颜色：色相走黄金角（相邻株号差约 222°，挨着的两株不会撞色），明度三档轮换再拉开一层 */
const _idColors = new Map();
function idColor(id) {
  let c = _idColors.get(id);
  if (c) return c;
  const h = (id * 0.6180339887498949) % 1, sat = 0.85, l = [0.56, 0.42, 0.7][id % 3];
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, p0 = 2 * l - q;
  const ch = (t) => {
    t = (t + 1) % 1;
    const v = t < 1 / 6 ? p0 + (q - p0) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p0 + (q - p0) * (2 / 3 - t) * 6 : p0;
    return Math.round(v * 255);
  };
  c = [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)];
  _idColors.set(id, c);
  return c;
}

/** 悬停高亮：把那一株整片描出来（只看得见"哪些像素归它"，比读坐标直观得多） */
function drawHover(ctx) {
  const id = S.hover;
  const m = S.idMap;
  if (!id || !m) return;
  const [nw, nh] = S.native;
  ctx.drawImage(idMaskCanvas('hover', new Set([id]), [255, 240, 130, 150]), 0, 0, nw, nh);
}

// ---------------------------------------------------------------- 视图
/** 上一次复位视图时画布区的尺寸与算出的视图（窗口尺寸变了时据它判"作者动没动过视图"、平移多少） */
let lastStage = null, lastFit = null;
function fitView() {
  const st = $('stage').getBoundingClientRect();
  const [nw, nh] = S.native;
  const k = Math.min(st.width / nw, st.height / nh);
  S.view = { k, x: (st.width - nw * k) / 2, y: (st.height - nh * k) / 2 };
  lastStage = [st.width, st.height];
  lastFit = { ...S.view };
  for (const id of ['bg', 'ov']) {
    const c = $(id);
    c.width = nw;
    c.height = nh;
  }
  applyView();
}

/**
 * 窗口尺寸变了（最大化 / 还原 / 贴边分屏）：**保住作者的缩放与平移**，只按画布区尺寸的变化平移一半让中心不动。
 * ⚠ 原来一律 fitView：放大到一处正在涂，把窗口贴到游戏旁边对照一下，视图就跳回整张图。
 *   画布是原画分辨率、与画布区尺寸无关，本来就没有东西需要复位。
 *   只有视图还停在上一次复位的样子（作者没缩放没平移过）时才跟着窗口重新复位。
 */
function onStageResize() {
  const st = $('stage').getBoundingClientRect();
  const same = (a, b) => !!a && !!b && Math.abs(a.k - b.k) < 1e-9 && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
  if (!lastStage || same(S.view, lastFit)) { fitView(); draw(); return; }
  S.view.x += (st.width - lastStage[0]) / 2;
  S.view.y += (st.height - lastStage[1]) / 2;
  lastStage = [st.width, st.height];
  applyView();
}

function applyView() {
  const t = `translate(${S.view.x}px,${S.view.y}px) scale(${S.view.k})`;
  $('bg').style.transform = t;
  $('ov').style.transform = t;
  updateCursor();                    // 缩放变了，笔刷圈的屏幕尺寸跟着变（不等下一次鼠标移动）
}

/** 指针最近一次在画布区上的屏幕坐标（离开画布区 = null：这时改笔刷大小不把圈显示出来） */
let lastPointer = null;
/**
 * 笔刷圈（#cursor）：屏幕上的直径 = 笔刷 × 缩放，圆心在指针上。不给坐标就用最近一次的指针位置。
 * ⚠ 原来只在 pointermove 里算：滚轮缩放之后、按 [ / ] 改笔刷之后圈还是旧尺寸，手不动就一直是错的——
 *   悬停着按 ] 看起来什么都没发生。
 */
function updateCursor(clientX, clientY) {
  if (clientX === undefined) {
    if (!lastPointer) return;
    [clientX, clientY] = lastPointer;
  }
  const cur = $('cursor');
  if (!cur) return;
  const r = Number($('size').value) * S.view.k;
  const st = $('stage').getBoundingClientRect();
  cur.style.display = 'block';
  cur.style.width = cur.style.height = r + 'px';
  cur.style.left = clientX - st.left - r / 2 + 'px';
  cur.style.top = clientY - st.top - r / 2 + 'px';
}

/**
 * 滚轮缩放停下 ~100 ms 后整张重画一次（只在画着锚点 / 悬停高亮时）。
 * ⚠ 锚点圈是按"原画像素 9/k"画在叠加层上的，缩放只是 CSS 拉伸那张画布：不重画的话放大去看竿底，圈跟着胀成几十像素、
 *   正好盖住要看的地方；接着在旁边涂一笔，局部重画只把圈的一角按新尺寸画回来，剩下半个大圈，直到按 F。
 *   整张重画要 45–80 ms，不能每个滚轮刻度都来一次，所以等滚轮停下。
 */
let _zoomRedraw = 0;
function scheduleZoomRedraw() {
  clearTimeout(_zoomRedraw);
  _zoomRedraw = 0;
  if (!S.scene || !(S.ov.anchors.length || S.hover)) return;
  _zoomRedraw = setTimeout(() => { _zoomRedraw = 0; draw(); }, 100);
}

const toNative = (ev) => {
  const st = $('stage').getBoundingClientRect();
  return [(ev.clientX - st.left - S.view.x) / S.view.k, (ev.clientY - st.top - S.view.y) / S.view.k];
};

// ---------------------------------------------------------------- 画
/**
 * 重画。`rect`（原画像素 `{x, y, w, h}`）= 只重画叠加层的这一块——**画笔拖动时走它**。
 * ⚠ 整张重画要把四层涂层逐像素合一遍（2048×1152 × 4 ≈ 3700 万次），实测 45–70 ms 一次；
 *   原来每个鼠标移动都整张重画，笔刷只剩十几帧、拖快了跟不上手。一笔只动笔刷那一小块，就只重画那一块。
 *   原画那张画布只在整张重画时画（画笔不改它）。
 */
function draw(rect) {
  const [nw, nh] = S.native;
  let rx = 0, ry = 0, rw = nw, rh = nh;
  if (rect) {
    rx = Math.max(0, Math.floor(rect.x)); ry = Math.max(0, Math.floor(rect.y));
    rw = Math.min(nw, Math.ceil(rect.x + rect.w)) - rx; rh = Math.min(nh, Math.ceil(rect.y + rect.h)) - ry;
    if (rw <= 0 || rh <= 0) return;
  } else {
    const b = $('bg').getContext('2d');
    b.clearRect(0, 0, nw, nh);
    if (S.imgs.bg) b.drawImage(S.imgs.bg, 0, 0, nw, nh);
  }

  const o = $('ov').getContext('2d');
  o.save();
  if (rect) { o.beginPath(); o.rect(rx, ry, rw, rh); o.clip(); }
  o.clearRect(rx, ry, rw, rh);
  const a = Number($('alpha').value) / 100;
  o.globalAlpha = a;
  // ⚠ 整幅贴、靠裁剪限制范围，**不用**九参数的子矩形 drawImage：实测（真 GPU 与 SwiftShader 都中）
  //   「已抠出的植被」+「自由度」同开时，子矩形那条合成路径与整幅贴出来的像素差到 127，局部重画完就花一块。
  //   贵的是下面涂层四层逐像素的 CPU 合成，那部分只算这一块；整幅贴图在 GPU 上被裁掉，便宜。
  const blit = (src) => o.drawImage(src, 0, 0, nw, nh);
  if (S.show.ids && S.idMap) {
    // 株号上色后的半分辨率图，最近邻放大：交界处不许插值出两株之间的假颜色
    o.imageSmoothingEnabled = false;
    blit(idPartitionCanvas());
    o.imageSmoothingEnabled = true;
  }
  // matte.R = 已抠出的植被；画成绿色蒙版（只取 R 当 alpha）
  if (S.show.veg && S.imgs.matte) blit(tintFromChannel(S.imgs.matte, 0, [95, 208, 122]));
  if (S.show.free && S.imgs.matte) blit(tintFromChannel(S.imgs.matte, 2, [200, 200, 255]));
  if (S.show.rigid && S.imgs.rigid) blit(tintFromChannel(S.imgs.rigid, 0, [120, 140, 255]));
  if (S.show.paint && S.buf[S.chan]) o.drawImage(paintOverlay(rx, ry, rw, rh), rx, ry);
  o.globalAlpha = 1;
  drawOverrides(o);
  drawHover(o);
  o.restore();
}

/** 画作者的逐株设置：整体摆的株整片描淡蓝，锚点画成带十字的圈（屏幕上大小不随缩放变） */
function drawOverrides(ctx) {
  const m = S.idMap;
  const [nw, nh] = S.native;
  if (m && S.ov.coherent.length) {
    const ids = new Set(S.ov.coherent.map((p) => idAt(p[0], p[1])).filter((i) => i > 0));
    if (ids.size) ctx.drawImage(idMaskCanvas('coherent', ids, [120, 190, 255, 110]), 0, 0, nw, nh);
  }
  const r = 9 / Math.max(S.view.k, 1e-3);
  ctx.save();
  ctx.lineWidth = 2 / Math.max(S.view.k, 1e-3);
  for (const [ax, ay] of S.ov.anchors) {
    ctx.strokeStyle = '#000a';
    ctx.beginPath(); ctx.arc(ax, ay, r + ctx.lineWidth, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#ffd24a';
    ctx.beginPath(); ctx.arc(ax, ay, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ax - r * 1.6, ay); ctx.lineTo(ax + r * 1.6, ay);
    ctx.moveTo(ax, ay - r * 1.6); ctx.lineTo(ax, ay + r * 1.6); ctx.stroke();
  }
  ctx.restore();
}

/**
 * 视图着色的缓存（matte/rigid 的某个通道 → 一张上了色的画布）。
 *
 * 按**用途**复用画布（同一个通道同一种颜色只有一张），记着它当前画的是哪张图；图变了就在原画布上重画。
 * ⚠ 原来键里带着 `img.src`，每次装场景都换 `?t=`，跨装载永远命中不了，旧画布一张不放
 *   （实测连开 4 次堆涨 81 MB，再多几次图片就加载不出来了）。换场景只作废（`invalidateTint`），不新建。
 */
const _cache = new Map();
function invalidateTint() {
  for (const e of _cache.values()) e.src = '';
  _idMask.clear();                   // 别让缓存键把上一份 id 图（半分辨率 ≈ 2 MB）钉在内存里
}
function tintFromChannel(img, ch, rgb) {
  const key = 'tint:' + ch + ':' + rgb.join(',');
  const hit = _cache.get(key);
  if (hit && hit.src === img.src) return hit.c;
  const [nw, nh] = S.native;
  const { c: build, x } = scratch('tint-build', nw, nh, true);
  x.drawImage(img, 0, 0, nw, nh);
  const d = x.getImageData(0, 0, nw, nh);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const v = p[i + ch];
    p[i] = rgb[0]; p[i + 1] = rgb[1]; p[i + 2] = rgb[2]; p[i + 3] = v;
  }
  x.putImageData(d, 0, 0);
  // ⚠ 缓存的是**拷过一次**的画布，不是刚 putImageData 的那张：刚写进去的那张第一次被贴出去时，
  //   低 alpha 处的预乘取整与之后再贴不一样（实测差到 127）——整张画一遍、再局部重画一块，
  //   笔画周围就是一道看得见的方框接缝。拷一次之后每次贴都走同一条路径。
  const { c, x: cx } = scratch(key, nw, nh);
  cx.drawImage(build, 0, 0);
  _cache.set(key, { src: img.src, c });
  return c;
}

/**
 * 我画的四层各上一个色，一次画出来；当前层画得实一点，其余压淡（免得看不清在改哪一层）。
 * 只合 `(rx, ry, rw, rh)` 这一块，返回的画布尺寸就是这一块（画到叠加层的 `(rx, ry)`）。
 */
function paintOverlay(rx, ry, rw, rh) {
  const { c, x } = scratch('paint-overlay', rw, rh);
  const d = x.createImageData(rw, rh);
  const p = d.data;
  for (const ch of CHANNELS) {
    const s = S.buf[ch].getImageData(rx, ry, rw, rh).data;
    const [cr, cg, cb] = CH_COLOR[ch];
    const w = ch === S.chan ? 1 : 0.45;
    for (let i = 0; i < p.length; i += 4) {
      const a = s[i + 3] * w;
      if (a <= p[i + 3]) continue;
      p[i] = cr; p[i + 1] = cg; p[i + 2] = cb; p[i + 3] = a;
    }
  }
  x.putImageData(d, 0, 0);
  return c;
}

// ---------------------------------------------------------------- 笔刷（只动当前通道）
/**
 * 撤销按**分块补丁**存：画布切成 128×128 的块，一笔里**某一块第一次被碰到时**把它原样收起来，
 * 同一笔后面再经过这块不再收——整笔作为一组，撤销时把这些块贴回去（块互不重叠，顺序无所谓）。
 * ⚠ 别只存第一段的范围（第一版就是这么写的：拖一长条，撤销只回来一个圆点），
 * 也别整张快照（2048×1152 一笔 9 MB，四十笔就 360 MB）。
 * ⚠ 也别每个鼠标移动收一块矩形（2026-09-14 之前就是这样）：笔刷 240 来回刷一块石头，一次移动 ≈ 250 KB、
 *   60 Hz 一秒 15 MB，四十笔就是几个 GB，渲染进程先卡 GC 再白屏，8 秒草稿之后的活全没了。
 *   分块后一笔最多就是整层那 9 MB；另有总字节上限（`S.undoByteCap`），超了从最老的丢。
 */
const UNDO_TILE = 128;
function beginStroke() {
  // since：离上一个笔印走了多远（-1 = 这一笔还没印过；见 dabStops）
  S.stroke = { ch: S.chan, patches: [], tiles: new Set(), bytes: 0, since: -1 };
}

function endStroke() {
  const st = S.stroke;
  S.stroke = null;
  if (!st || !st.patches.length) return;
  delete st.tiles;                   // 只在笔按着时判重用，进撤销栈不带它
  delete st.since;
  pushUndo(st);
}

/** 作者的新动作只从这里进撤销栈：进了就作废重做栈（在撤回去的状态上又画了一笔，之前撤掉的那几步接不上了） */
function pushUndo(g) {
  S.redo = [];
  pushCapped(S.undo, g);
}

/** 撤销 / 重做栈共用：四十条 + 总字节两道上限，超了从最老的丢（刚进的这一条永远留着） */
function pushCapped(stack, g) {
  stack.push(g);
  let total = stack.reduce((n, e) => n + (e.bytes || 0), 0);
  while (stack.length > 1 && (stack.length > 40 || total > S.undoByteCap)) {
    total -= stack.shift().bytes || 0;
  }
}

/**
 * 一条撤销 / 重做记录的"反面"：**在套用它之前**把它要盖掉的那些块 / 那份逐株设置原样收一份，套回去就是反方向那一步。
 * 块的范围与原记录一模一样，所以一条记录来回撤 / 重做字节数不涨。
 */
function inverseEntry(g) {
  if (g.kind === 'group') {
    const parts = g.parts.map(inverseEntry);
    return { kind: 'group', parts, bytes: parts.reduce((n, p) => n + (p.bytes || 0), 0) };
  }
  if (g.kind === 'ov') return { kind: 'ov', prev: JSON.parse(JSON.stringify(S.ov)) };
  const patches = g.patches.map((pt) => ({ x: pt.x, y: pt.y, data: S.buf[g.ch].getImageData(pt.x, pt.y, pt.data.width, pt.data.height) }));
  return { ch: g.ch, patches, bytes: patches.reduce((n, pt) => n + pt.data.data.length, 0) };
}

/** 撤一条。`kind: 'group'` = 一次动作换了好几层（恢复收起来的草稿），一下全撤回去 */
function undoEntry(g) {
  if (g.kind === 'group') {
    for (let i = g.parts.length - 1; i >= 0; i--) undoEntry(g.parts[i]);
    return;
  }
  if (g.kind === 'ov') {
    S.ov = g.prev;
    S.dirty = true;
    S.ovDirty = true;
    return;
  }
  for (let i = g.patches.length - 1; i >= 0; i--) {
    const pt = g.patches[i];
    S.buf[g.ch].putImageData(pt.data, pt.x, pt.y);
  }
  S.dirty = true;
  S.chDirty[g.ch] = true;
}

function undo() {
  const g = S.undo.pop();
  if (!g) { log('没有可撤销的了'); return; }
  pushCapped(S.redo, inverseEntry(g));
  undoEntry(g);
  draw();
}

/**
 * 重做（Ctrl+Shift+Z / Ctrl+Y）。
 * ⚠ 原来没有重做，而且 `e.key.toLowerCase()` 把 Ctrl+Shift+Z 的 'Z' 也当成 'z'：Ctrl+Z 多按了一下、顺手按重做，
 *   结果**又撤掉一笔**，两笔都没了（没存的活只能再画一遍）。
 */
function redo() {
  const g = S.redo.pop();
  if (!g) { log('没有可重做的了'); return; }
  pushCapped(S.undo, inverseEntry(g));
  undoEntry(g);
  draw();
}

/** 画之前把这一段会碰到的块收起来（撤销用；同一笔里每块只收一次）；范围钳在画布内 */
function keepPatch(ctx, x0, y0, x1, y1, pad) {
  const st = S.stroke;
  if (!st) return;
  const [nw, nh] = S.native;
  const xa = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
  const ya = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
  const xb = Math.min(nw, Math.ceil(Math.max(x0, x1) + pad));
  const yb = Math.min(nh, Math.ceil(Math.max(y0, y1) + pad));
  if (xb <= xa || yb <= ya) return;
  for (let ty = Math.floor(ya / UNDO_TILE); ty * UNDO_TILE < yb; ty++) {
    for (let tx = Math.floor(xa / UNDO_TILE); tx * UNDO_TILE < xb; tx++) {
      const key = tx + ',' + ty;
      if (st.tiles.has(key)) continue;
      st.tiles.add(key);
      const x = tx * UNDO_TILE, y = ty * UNDO_TILE;
      const w = Math.min(UNDO_TILE, nw - x), h = Math.min(UNDO_TILE, nh - y);
      const data = ctx.getImageData(x, y, w, h);
      st.patches.push({ x, y, data });
      st.bytes += data.data.length;
    }
  }
}

/** 整层收一份（清空本层 / 恢复草稿换层前用）：一次 getImageData，不走分块 */
function layerPatch(ch) {
  const [nw, nh] = S.native;
  const data = S.buf[ch].getImageData(0, 0, nw, nh);
  return { ch, patches: [{ x: 0, y: 0, data }], bytes: data.data.length };
}

/** 半径 r、落在 (x, y) 的一个笔印碰不碰得到原画 [0,nw)×[0,nh)（点到矩形的距离 < r） */
function dabTouchesPicture(x, y, r) {
  const [nw, nh] = S.native;
  return Math.hypot(Math.max(0 - x, 0, x - nw), Math.max(0 - y, 0, y - nh)) < r;
}

/**
 * 这一段 (x0,y0)→(x1,y1) 上的笔印落在哪（沿线段的距离）。间距是**整笔连续**的：离上一个印子走满一个间距才印下一个，
 * 余下没走满的距离带进下一段（`S.stroke.since`；下笔那一下是 -1 = 还没印过，正好印一个）。**段首永远不补印**。
 * ⚠ 原来每段从 i=0 到 i=steps 各印一次：段首正是上一段的最后一个印子（每个点印两遍），间距也每段重新起算——
 *   慢拖（每次移动 1–3 px）印子挤成 1–3 px 一个，软边按 1-(1-a)^n 叠成实心，快拖却还是软的：
 *   同一个「软硬」，刚体度 / 植被边缘跟着手速变，软橡皮慢擦吃边更快；点一下（stroke(p,p)）是同一处印两遍。
 */
function dabStops(L, sp, st) {
  const at = [];
  let since = st && st.since >= 0 ? st.since : -1;
  if (since < 0) { at.push(0); since = 0; }
  // since ≥ sp 只在一笔中途把笔刷调小（[ 键）时出现：段首离上一个印子已经超过新间距、而且还没印过，从段首起印
  for (let t = Math.max(0, sp - since); t <= L + 1e-6; t += sp) at.push(t);
  const last = at.length ? at[at.length - 1] : -1;
  if (st) st.since = last >= 0 ? Math.max(0, L - last) : since + L;
  return at;
}

function stroke(x0, y0, x1, y1, erasing) {
  const ch = S.chan;
  const ctx = S.buf[ch];
  const r = Number($('size').value) / 2;
  const hard = Number($('hard').value) / 100;
  const pad = r + 2;
  // 这一段动过的原画矩形（给 draw 只重画这一块）
  const rect = { x: Math.min(x0, x1) - pad, y: Math.min(y0, y1) - pad, w: Math.abs(x1 - x0) + pad * 2, h: Math.abs(y1 - y0) + pad * 2 };
  const L = Math.hypot(x1 - x0, y1 - y0);
  const pts = [];
  for (const t of dabStops(L, Math.max(2, r * 0.35), S.stroke)) {
    const k = L > 0 ? t / L : 0;
    const x = x0 + (x1 - x0) * k, y = y0 + (y1 - y0) * k;
    if (dabTouchesPicture(x, y, r)) pts.push([x, y]);
  }
  // ⚠ 一个印子都没落到原画上（点在四周的暗边上、或这一段还没走满一个间距）：一个像素没动，不许记脏——
  //   原来照样标"有未保存的改动"，撤销栈里却什么都没有，关窗还要问、存一次白白挤掉一份历史
  if (!pts.length) return rect;
  keepPatch(ctx, x0, y0, x1, y1, pad);
  ctx.save();
  ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
  // ⚠ 软硬 100：内外两个圆一样大的径向渐变按规范**什么都不画**（Chromium 实测：画 0 像素、橡皮擦不掉）——
  //   而说明里正写着"软硬拉到 100 涂得最干净"。满硬直接实心填；其余内圆至少比外圆小半个像素
  let fill = 'rgba(255,255,255,1)';
  for (const [x, y] of pts) {
    if (hard < 0.999) {
      fill = ctx.createRadialGradient(x, y, Math.min(r * hard, r - 0.5), x, y, r);
      fill.addColorStop(0, 'rgba(255,255,255,1)');
      fill.addColorStop(1, 'rgba(255,255,255,0)');
    }
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  S.dirty = true;
  S.chDirty[ch] = true;
  return rect;
}

/** 当前这一笔是不是在擦：橡皮键按下、或者用右键拖（画图软件的通用手势） */
const erasingNow = (ev) => S.erase || (ev && (ev.buttons & 2) !== 0);

// ---------------------------------------------------------------- 事件
const CH_BTN = { 't-veg': 'veg', 't-freeze': 'freeze', 't-rigid': 'rigid', 't-unrigid': 'unrigid' };

function syncTool() {
  for (const [id, v] of Object.entries(CH_BTN)) $(id).classList.toggle('on', S.tool === 'paint' && S.chan === v);
  $('t-anchor').classList.toggle('on', S.tool === 'anchor');
  $('t-coherent').classList.toggle('on', S.tool === 'coherent');
  $('t-erase').classList.toggle('on', S.erase);
  $('t-erase').textContent = S.erase ? '橡皮（开）' : '橡皮';
}

function bindTools() {
  for (const [id, v] of Object.entries(CH_BTN)) {
    $(id).addEventListener('click', () => { S.chan = v; S.tool = 'paint'; syncTool(); draw(); });
  }
  $('t-anchor').addEventListener('click', () => { S.tool = S.tool === 'anchor' ? 'paint' : 'anchor'; syncTool(); });
  $('t-coherent').addEventListener('click', () => { S.tool = S.tool === 'coherent' ? 'paint' : 'coherent'; syncTool(); });
  // 橡皮是**开关**，擦的永远是当前通道：作者要的是"把这一层的某块去掉"，
  // 不是把三层一起抹了（旧版一擦连别的通道一起没，等于不能改）
  // 与 E 键一样回到画笔：原来只翻橡皮，锚点 / 整体摆工具还开着，按钮写着「橡皮（开）」、下一下左键放的却是锚点
  $('t-erase').addEventListener('click', () => { S.erase = !S.erase; S.tool = 'paint'; syncTool(); });
  $('clear-ch').addEventListener('click', () => {
    if (!S.buf[S.chan]) return;
    const [nw, nh] = S.native;
    pushUndo(layerPatch(S.chan));
    S.buf[S.chan].clearRect(0, 0, nw, nh);
    S.dirty = true;
    S.chDirty[S.chan] = true;
    draw();
    log(`清空了「${CH_NAME[S.chan]}」这一层（Ctrl+Z 可撤销）`);
  });
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  syncTool();
  const views = { 'v-paint': 'paint', 'v-veg': 'veg', 'v-ids': 'ids', 'v-free': 'free', 'v-rigid': 'rigid' };
  for (const [id, v] of Object.entries(views)) {
    $(id).addEventListener('click', () => { S.show[v] = !S.show[v]; $(id).classList.toggle('on', S.show[v]); draw(); });
  }
  for (const [id, out] of [['size', 'size-v'], ['hard', 'hard-v'], ['alpha', 'alpha-v']]) {
    $(id).addEventListener('input', () => {
      $(out).textContent = $(id).value;
      if (id === 'alpha') draw();
      if (id === 'size') updateCursor();       // [ / ] 也走这里（它们派发 input）：悬停着按，圈立刻变
    });
  }
}

function bindCanvas() {
  const stage = $('stage'), cur = $('cursor');
  stage.addEventListener('contextmenu', (e) => e.preventDefault());   // 右键留给橡皮
  // 植株工具（锚点 / 整体摆）：在捕获期截住，涂层一个像素都不动
  stage.addEventListener('pointerdown', (e) => {
    // ⚠ 整体摆工具里右键放行给画笔：「右键拖 = 擦当前层」是随时都成立的手势（说明里就这么写）。
    //   原来右键也被当成"点一株切换"：想擦一笔乱涂，结果把光标下那株的整体摆悄悄翻了，一个像素没擦
    if (S.tool === 'paint' || e.altKey || !S.scene || e.button === 1 || e.shiftKey
      || (S.tool === 'coherent' && e.button === 2)) return;
    e.preventDefault();
    e.stopPropagation();
    const [x, y] = toNative(e);
    // 存下来的点钳进原画里（先取整再钳）：点在原画边外几个像素（贴底边的前景草很常见）时，idAt 钳到边上认得出株、
    // 画面上也标上了，存盘 / 推送却按 0 ≤ x < 宽 丢掉——作者看着设好了，游戏里没有，下次装场景标记也没了
    const [nw, nh] = S.native;
    const keep = (v, n) => Math.min(n - 0.1, Math.max(0, Math.round(v * 10) / 10));
    const px = keep(x, nw), py = keep(y, nh);
    const prev = JSON.parse(JSON.stringify(S.ov));
    if (S.tool === 'anchor') {
      if (e.button === 2) {
        const lim = 30 / Math.max(S.view.k, 1e-3);
        let best = -1, bd = lim * lim;
        S.ov.anchors.forEach((a, i) => { const d = (a[0] - x) ** 2 + (a[1] - y) ** 2; if (d <= bd) { bd = d; best = i; } });
        if (best < 0) {
          // 不许一声不响：作者多半是想右键擦涂层，忘了锚点工具还开着
          log('附近 30 像素内没有锚点（锚点工具里右键是删锚点；擦涂层先按 1-4 回到画笔）');
          return;
        }
        S.ov.anchors.splice(best, 1);
        log(`删掉一个锚点（还剩 ${S.ov.anchors.length} 个）`);
      } else {
        const id = idAt(px, py);
        S.ov.anchors.push([px, py]);
        log(`放了锚点 (${Math.round(px)},${Math.round(py)})` + (id ? ` → ${id} 号` : '　⚠ 不在任何一株上（烘焙时往外 24 像素找最近一株）'));
      }
    } else {
      const id = idAt(px, py);
      if (!id) { log('这里不属于任何一株'); return; }
      const i = S.ov.coherent.findIndex((p) => idAt(p[0], p[1]) === id);
      if (i >= 0) {
        S.ov.coherent.splice(i, 1);
        log(`${id} 号不再整体摆`);
      } else {
        S.ov.coherent.push([px, py]);
        log(`${id} 号标成整体摆（整株一起弯）`);
      }
    }
    pushUndo({ kind: 'ov', prev });
    S.dirty = true;
    S.ovDirty = true;
    draw();
  }, true);
  // Alt+点 = 检视这一点（属于哪株、什么脾气）：作者面最常问的三句话都在这一个回答里
  stage.addEventListener('pointerdown', async (e) => {
    if (!e.altKey || !S.scene) return;
    e.preventDefault();
    e.stopPropagation();
    const [nx, ny] = toNative(e);
    try {
      const j = await api(`/api/inspect?scene=${encodeURIComponent(S.scene)}&x=${Math.round(nx)}&y=${Math.round(ny)}`);
      const i = j.instance;
      log(i
        ? `(${j.at[0]},${j.at[1]}) → ${i.id} 号${i.kind === 'plant' ? '（整株刚转）' : '（根部钉住弯）'}`
          + `${i.height ? ' 株高 ' + i.height : ''}${i.persp ? ' 透视 ' + i.persp : ''}`
          + `　alpha ${j.matte ? j.matte.alpha : '?'} · 叶度 ${j.matte ? j.matte.leafy : '?'}`
          + ` · 自由度 ${j.matte ? j.matte.freedom : '?'} · 刚体 ${j.rigid ?? '?'}`
        : `(${j.at[0]},${j.at[1]}) → 这一点不属于任何一株（没抠出来 / 被锁死 / 是石头）`);
    } catch (err) {
      log('检视失败：' + err.message);
    }
  }, true);
  stage.addEventListener('pointerdown', (e) => {
    if (e.button === 1 || e.shiftKey) { S.pan = [e.clientX, e.clientY]; return; }
    S.painting = true;
    beginStroke();
    S.last = toNative(e);
    draw(stroke(S.last[0], S.last[1], S.last[0], S.last[1], S.erase || e.button === 2));
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    lastPointer = [e.clientX, e.clientY];
    updateCursor(e.clientX, e.clientY);
    if (S.pan) {
      S.view.x += e.clientX - S.pan[0];
      S.view.y += e.clientY - S.pan[1];
      S.pan = [e.clientX, e.clientY];
      applyView();
      return;
    }
    if (!S.painting) {
      // Alt 按住 = 指哪株亮哪株（画画时不闪）
      const want = e.altKey ? idAt(...toNative(e)) : 0;
      if (want !== S.hover) {
        S.hover = want;
        const i = want ? (S.layers?.instances || []).find((x) => x.id === want) : null;
        $('hover').textContent = want
          ? `${want} 号${i && i.kind === 'plant' ? '（整株刚转）' : '（根部钉住弯）'}` + (i && i.height ? ` 株高 ${i.height}` : '')
          : '';
        draw();
      }
      return;
    }
    const p = toNative(e);
    const rect = stroke(S.last[0], S.last[1], p[0], p[1], erasingNow(e));
    S.last = p;
    draw(rect);
  });
  const end = () => { if (S.painting) endStroke(); S.painting = false; S.pan = null; };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointerleave', () => { end(); lastPointer = null; cur.style.display = 'none'; });
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const st = stage.getBoundingClientRect();
    const mx = e.clientX - st.left, my = e.clientY - st.top;
    const k = S.view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12);
    S.view.x = mx - ((mx - S.view.x) * k) / S.view.k;
    S.view.y = my - ((my - S.view.y) * k) / S.view.k;
    S.view.k = k;
    lastPointer = [e.clientX, e.clientY];
    applyView();                     // 含笔刷圈按新缩放重算
    scheduleZoomRedraw();            // 锚点圈按新缩放重画（滚轮停下再画）
  }, { passive: false });
}

/**
 * 保存。**同一时刻只有一次在飞**：Ctrl+S 连按两下、Ctrl+S 紧跟着 B 导出，都等同一次保存——
 * 原来两发带着同一个 baseMtime 进服务端，后一发撞上"盘上比你装载的新"的假冲突、或抢同一个临时文件报 500。
 * **保存期间又画的笔画不许被当成已保存**：拍快照时记下编辑序号，回来对不上就留着脏、说再按一次。
 */
let saveInFlight = null;
function save(force = false) {
  if (saveInFlight) return saveInFlight;
  saveInFlight = saveOnce(force).finally(() => { saveInFlight = null; });
  return saveInFlight;
}
async function saveOnce(force) {
  if (!S.scene) return;
  if (!S.buf.veg) { log('场景还没装好，不存（免得拿空画布覆盖盘上的）'); return; }
  if (!S.dirty && !force) { log('没有未保存的改动（盘上就是现在这份）'); return; }
  $('save').disabled = true;
  try {
    const sid = S.scene;
    const seqAt = S.editSeq;
    const channels = {};
    for (const c of CHANNELS) channels[c] = channelDataURL(c);
    let j;
    try {
      j = await api('/api/paint', { scene: sid, channels, baseMtime: S.baseMtime, force, overrides: S.ov });
    } catch (e) {
      if (e.conflict) {
        log(`⛔ ${e.message}`);
        alert(`${e.message}\n\n（盘上 ${new Date(e.diskMtime * 1000).toLocaleTimeString()} 改过；你装载的是 ${new Date(e.yourMtime * 1000).toLocaleTimeString()}）`);
        return;
      }
      if (e.needConfirm) {
        const b = e.before, a = e.after;
        const rows = CHANNELS.map((c) => `　${CH_NAME[c]}：${b[c]} → ${a[c]}`).join('\n');
        if (!confirm(`${e.message}\n\n${rows}\n\n确定要这么存吗？（上一版会留在历史里）`)) {
          log('已取消保存');
          return;
        }
        return await saveOnce(true);
      }
      throw e;
    }
    if (S.scene !== sid) return;     // 存的途中换了场景（确认过丢弃）：别把新场景的状态清掉
    S.baseMtime = j.mtime || S.baseMtime;
    // 存下的与资源里导出时读到的输入比（服务端写完之后按指纹算，与装场景同一个判据）；老服务端不回就照旧当"还没导出"。
    // ⚠ 原来一律 true：撤销回原样 / 锚点加了又删 / 空层按 X 再 Ctrl+S，盘上一个字节没变，徽章照样亮「● 待导出」，作者白导出十几秒
    S.needsExport = typeof j.needsExport === 'boolean' ? j.needsExport : true;
    const c = j.coverage;
    log(`已存 ${j.path}（补植被 ${(c.veg * 100).toFixed(2)}% · 锁死 ${(c.freeze * 100).toFixed(2)}%`
      + ` · 加刚体 ${(c.rigid * 100).toFixed(2)}% · 减刚体 ${(c.unrigid * 100).toFixed(2)}%）`);
    if (j.lockMigrated) log('  旧的 sway_lock.png 已并进涂层并删除——从此锁死区只有一个来源');
    // 这次保存往历史里挤进了一份：「历史…」开着的话重列（原来要关了再开才看得见新的那份）
    if ($('history-box').style.display === 'block') { $('history-box').style.display = 'none'; showHistory(); }
    refreshScenes(true);             // 下拉框里的"有涂层"跟着变
    if (S.editSeq !== seqAt) {
      log('⚠ 保存期间又画了几笔：那几笔还没存，再按一次 Ctrl+S');
      renderBadges();
      return;
    }
    S.dirty = false;
    S.chDirty = {};
    S.ovDirty = false;
    clearDraft(sid);
  } catch (e) {
    log('保存失败：' + e.message);
  } finally {
    $('save').disabled = false;
  }
}

/**
 * 推送 / 导出共用：服务端开线程烘，这里轮询进度。
 * ⚠ 不能同步等一个 fetch：第一次要跑分割，几十秒，浏览器那边就是个卡死的按钮（作者会以为工具死了、再点一次）。
 * 两个按钮在活跑完之前都按不动（服务端也只许一个活）。
 */
async function runJob(btn, label, start) {
  const html = btn.innerHTML;
  try {
    await start();
    let seen = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      const st = await api('/api/job/status');
      for (const l of st.log.slice(seen)) log('  ' + l);
      seen = st.log.length;
      if (st.running) btn.textContent = `${label}中 ${st.elapsed.toFixed(0)}s…`;
      if (st.done) return st;
    }
  } finally {
    btn.innerHTML = html;          // 按钮的禁用由调用方的 setJobBusy 管（导出前那一次保存也在里面）
  }
}

/**
 * 推给游戏：页面上此刻的四层 + 锚点 / 整体摆（存没存都算）→ 服务端烘一份预览到本机临时目录 →
 * 在跑着的游戏原地换上。资源一个字节不动，所以**不先存盘**。
 */
/** 推送 / 导出（含导出前那一次保存）在跑：两个按钮与 P / B 都不叠第二个 */
let jobBusy = false;
function setJobBusy(on) {
  jobBusy = on;
  $('push').disabled = on;
  $('export').disabled = on;
}

/** 正在等哪个场景的游戏页起来（推送时游戏没开、已经让控制台拉起）：同一个场景再推不再拉第二个游戏窗口 */
let waitingForGame = null;
/** 最近一次推送成功时游戏页的心跳（徽章据它分辨"游戏刷新过、预览没了"和"刚推完、正在换上"） */
let lastPush = null;

async function pushToGame() {
  if (jobBusy) { log('正在推送 / 导出，等它跑完'); return; }
  if (!S.scene) return;
  if (!S.buf.veg) { log('场景还没装好，不推'); return; }
  const sid = S.scene;
  const channels = {};
  for (const c of CHANNELS) channels[c] = channelDataURL(c);
  log('推给游戏：用页面上此刻的涂层（存没存都算）烘一份预览，资源不动……');
  if (noWindNote(sid)) log(`⚠ ${noWindNote(sid)}：预览照样烘，但游戏里看不出效果（先给场景配 wind）`);
  // 这次推送持有按钮的"忙"：等游戏起来那段提前放掉，finally 只放自己还拿着的（不许替后一次推送把按钮放开）
  let holding = true;
  setJobBusy(true);
  try {
    let st;
    try {
      st = await runJob($('push'), '推送', () => api('/api/push', { scene: sid, channels, overrides: S.ov }));
    } catch (e) {
      log('推给游戏失败：' + e.message);
      return;
    }
    if (!st.succeeded) { log('推给游戏失败：' + st.err); return; }
    await refreshDerived(sid);
    const p = st.push || {};
    // 只有游戏页真开着、有 bootId 时才记：没有游戏页时记个空 bootId，之后任何游戏页都会被当成"同一局、正在换上"
    if (p.pushed && p.pageAlive && p.game && p.game.bootId) lastPush = { sid, bootId: p.game.bootId, at: Date.now() };
    // 游戏页开着、但正在启动 / 装场景 / 原地重装（心跳里 loading）：**不许**去拉游戏（那会再开一个游戏窗口，
    // 或排一条切场景命令把玩家送回入口）。新的这一行已经在槽里了，等它装好、进了这个场景再确认换上
    if (p.pushed && p.pageBusy) {
      holding = false;
      setJobBusy(false);
      await waitBusyPage(sid, p);
      return;
    }
    // pushed 只说明 dev server 收下了；游戏页开没开、在不在这个场景看心跳（老 dev server 没有心跳就按收下了算）
    if (p.pushed && (p.inScene || !('pageAlive' in p))) {
      // 等游戏真换上这段不锁按钮（没配风的场景要等满才知道换不上）
      holding = false;
      setJobBusy(false);
      await confirmApplied(sid, p, `✔ 游戏里已换上（第 ${p.rev} 次）——不切场景、玩家不动。资源还没动，满意了点「导出到游戏」`);
      return;
    }
    if (p.pushed && p.pageAlive) {
      log(`✔ 预览已烘好（第 ${p.rev} 次）：游戏现在在「${p.game.sceneId}」，进到 ${sid} 就是这份。资源还没动`);
      return;
    }
    // 游戏页没开 / 没应答：让控制台把游戏切到（拉起到）这个场景，等游戏页真进了这个场景再告诉它一次
    //（游戏只认它启动之后推的那行：盘上留着的旧行一律不算）
    if (waitingForGame && waitingForGame.sid === sid && !waitingForGame.cancelled) {
      // 上一次推送已经在等这个场景的游戏页了：再调一次 /api/link/open 会再开一个游戏窗口（两个页面、两份声音、抢同一条槽）。
      // 那边等到之后补发的就是预览目录里最新这份，这次不用另等
      waitingForGame.rev = p.rev;
      log(`预览已烘好；还在等游戏页进到 ${sid}，起来后补发的就是这份`);
      return;
    }
    log(p.pushed ? `dev server 收下了，但没有游戏页开着：让游戏切到 ${sid}……` : `游戏没收到（${p.why || '没开着'}），让游戏切到 ${sid}……`);
    holding = false;
    setJobBusy(false);               // 预览已经烘好了；等游戏起来这段不锁按钮（游戏可能根本起不来）
    // 等待凭证是个对象：导出同一个场景时把它作废（见 exportOnce），finally 只清自己那张
    const token = { sid, cancelled: false };
    waitingForGame = token;
    const dropped = () => {
      if (token.cancelled) return true;          // 导出那边已经在日志里说过"不再补发预览"
      if (waitingForGame === token) return false;
      log(`不再等游戏页进 ${sid}（后来又推了「${waitingForGame ? waitingForGame.sid : '别的场景'}」）`);
      return true;
    };
    try {
      const k = await api('/api/link/open', { scene: sid });
      if (k.via === 'none') {
        // 控制台没开、dev server 也没应答：一条命令都没排（没人会来取，排了就是几小时后把游戏拽进这个场景）
        log(`控制台和游戏都没开（${k.console || k.detail || '没应答'}）：预览已烘好，开游戏进 ${sid} 再按 P`);
        return;
      }
      log(k.via === 'queue'
        ? `  控制台没开（${k.console}）：切场景命令已排进 dev server 的队列（没人取会自动过期），等游戏页进到 ${sid}……`
        : `  已请求控制台拉起游戏，等游戏页进到 ${sid}……`);
      // ⚠ 按真实流逝的时间封顶，不按轮数：每次 /api/link/status 在游戏没开时要实探 5 个端口（每个 0.4 s），
      //   原来"90 轮 × 1 s"实际等了四五分钟才说"等了一分半"
      const t0 = Date.now();
      while (Date.now() - t0 < LINK_TIMING.waitMs) {
        await new Promise((r) => setTimeout(r, LINK_TIMING.pollMs));
        if (dropped()) return;
        const s = await api('/api/link/status').catch(() => null);
        const inScene = s && s.pageAlive && s.page && s.page.sceneId === sid && !s.page.loading;
        const legacy = s && s.alive && !('pageAlive' in s);
        if (!inScene && !legacy) continue;
        // ⚠ 补发前再判一次：等状态的这一拍里作者按了 B 导出，补发的 preview 会排在导出那行之后，游戏停在旧预览上
        if (dropped()) return;
        const n = await api('/api/push/notify', { scene: sid });
        const nb = (n.game && n.game.bootId) || (s.page && s.page.bootId) || '';
        if (n.pushed && nb) lastPush = { sid, bootId: nb, at: Date.now() };
        if (!n.pushed) { log(`游戏起来了但没收到：${n.why}`); return; }
        await confirmApplied(sid, n, `✔ 游戏起来了，已换上这份预览（第 ${n.rev} 次）`);
        return;
      }
      log(`等了一分半游戏页还没进到 ${sid}：开好游戏后再按一次「推给游戏」`);
    } catch (e) {
      log('让游戏切场景失败：' + e.message + '（先跑 dev server）');
    } finally {
      if (waitingForGame === token) waitingForGame = null;
    }
  } finally {
    if (holding) setJobBusy(false);
  }
}

/**
 * 推送时游戏页开着但正在装场景 / 原地重装（`pageBusy`）：轮询心跳，等**它**装好（不再 loading）。
 * 装好在这个场景 ⇒ 等它把这次推送换上再打勾；装好在别的场景 ⇒ 说一句进来就是这份。
 * 等的这段占着 `waitingForGame`：期间再按 P 不另起一轮等待（只把要确认的推送号换成最新那次），导出同一个场景会作废它。
 */
async function waitBusyPage(sid, p) {
  if (waitingForGame && waitingForGame.sid === sid && !waitingForGame.cancelled) {
    waitingForGame.rev = p.rev;
    log(`预览已烘好（第 ${p.rev} 次）；游戏页还在装场景，装好后换上的就是这份`);
    return;
  }
  log(`游戏页正在装场景…预览已烘好（第 ${p.rev} 次），等它装好再确认换上`);
  const token = { sid, cancelled: false, rev: p.rev };
  waitingForGame = token;
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < LINK_TIMING.waitMs) {
      await new Promise((r) => setTimeout(r, LINK_TIMING.pollMs));
      if (token.cancelled) return;
      if (waitingForGame !== token) {
        log(`不再等游戏页装好 ${sid}（后来又推了「${waitingForGame ? waitingForGame.sid : '别的场景'}」）`);
        return;
      }
      const s = await api('/api/link/status').catch(() => null);
      const pg = s && s.pageAlive ? s.page : null;
      if (!pg || pg.loading || !pg.sceneId) continue;
      if (token.cancelled || waitingForGame !== token) return;
      if (pg.sceneId !== sid) {
        log(`游戏页装好了，在「${pg.sceneId}」：进到 ${sid} 就是这份预览。资源还没动`);
        return;
      }
      if (pg.bootId) lastPush = { sid, bootId: pg.bootId, at: Date.now() };
      await confirmApplied(sid, { rev: token.rev, game: pg },
        `✔ 游戏里已换上（第 ${token.rev} 次）——资源还没动，满意了点「导出到游戏」`);
      return;
    }
    log(`等了一分半游戏页还没装好 ${sid}：装好之后再按一次「推给游戏」`);
  } finally {
    if (waitingForGame === token) waitingForGame = null;
  }
}

/**
 * 与游戏联动的几个等待（毫秒，自检把它们调短）：
 * waitMs = 等游戏页进场景最多等多久（按真实流逝时间）、pollMs = 那段每隔多久问一次；
 * applyMs = 推送 / 导出之后等游戏真换上最多等多久（游戏 0.9 s 轮询一次、重装一两秒，正常三四秒内见分晓）、applyPollMs 同理。
 */
const LINK_TIMING = { waitMs: 90000, pollMs: 1000, applyMs: 12000, applyPollMs: 700 };

/** 这个场景没配风时给人看的那句（没配风：游戏里草木层根本不建，推送 / 导出烘得再好也一株不动） */
function noWindNote(sid) {
  return S.layers && S.scene === sid && S.layers.hasWind === false
    ? '这个场景没配风（场景 JSON 的 wind），游戏里草木不会动' : '';
}

/**
 * 等游戏页把第 `rev` 次推送**真换上屏幕**：心跳里的 `page.applied`（这个场景真换上的最近那次推送）≥ rev 才算。
 * 回 'applied' / 'timeout' / 'legacy'（老 dev server 的心跳没有 applied，确认不了，照旧按收下了算）。
 * ⚠ `inScene` 只说明"4 秒内有这个场景的心跳"：原来据它就打「✔ 游戏里已换上」——没配风的场景游戏根本装不上，
 *   游戏日志只有一句"装不上（看上面的原因）"，工作台却打着勾，之后每推一次都一样。
 * 游戏原地重装那一两拍不轮询、心跳会断一下：断了接着等，不算失败。
 */
async function waitApplied(sid, rev, game) {
  if (!game || !('applied' in game) || typeof rev !== 'number') return 'legacy';
  if (game.sceneId === sid && typeof game.applied === 'number' && game.applied >= rev) return 'applied';
  const t0 = Date.now();
  while (Date.now() - t0 < LINK_TIMING.applyMs) {
    await new Promise((r) => setTimeout(r, LINK_TIMING.applyPollMs));
    const s = await api('/api/link/status').catch(() => null);
    const pg = s && s.pageAlive ? s.page : null;
    if (!pg || pg.sceneId !== sid) continue;
    if (!('applied' in pg)) return 'legacy';
    if (typeof pg.applied === 'number' && pg.applied >= rev) return 'applied';
  }
  return 'timeout';
}

/** 推送 / 导出 / 补发之后：等到真换上才打勾，等不到就直说（没配风的场景点名原因） */
async function confirmApplied(sid, p, okMsg) {
  const game = p.game || null;
  if (game && 'applied' in game) log(`  游戏收到了（第 ${p.rev} 次），等它换上……`);
  const r = await waitApplied(sid, p.rev, game);
  if (r !== 'timeout') { log(okMsg); return; }
  const nw = noWindNote(sid);
  log(`⚠ 游戏收到了第 ${p.rev} 次，但 ${Math.round(LINK_TIMING.applyMs / 1000)} 秒内没换上：看游戏调试面板的 [sway] 日志${nw ? `——${nw}` : ''}`);
}

/**
 * 导出到游戏：先存盘（导出读的是盘上那份），再烘进资源（各时段照明载荷目录），游戏换回资源里这份。
 */
/**
 * 正在跑的导出（含导出前那一次保存）：跑完 resolve 成 `''`（成功 / 没开始烘）或失败原因。
 * 关窗保护据它拦：导出一个文件一个文件地写资源，进程半路退出 = 资源里新的 ids / matte 配旧的 sway.json。
 */
let exportJob = null;
function exportToGame() {
  if (jobBusy) { log('正在推送 / 导出，等它跑完'); return exportJob || Promise.resolve(''); }
  if (!S.scene) return Promise.resolve('');
  const run = exportOnce().finally(() => { if (exportJob === run) exportJob = null; });
  exportJob = run;
  return run;
}
async function exportOnce() {
  const sid = S.scene;
  setJobBusy(true);
  try {
    // ⚠ 先落盘再导出：导出读的是盘上那张图，没存就导出 = 导出的是上一版（页面上看着已经涂了，结果没进资源）
    if (S.dirty || saveInFlight) { log('导出前先保存……'); await save(); }
    if (S.dirty) { log('没存上，不导出（导出读的是盘上那份）'); return ''; }
    if (S.scene !== sid) return '';
    const baseAtExport = S.baseMtime;
    log('导出到游戏：盘上的涂层烘进资源（各时段照明载荷目录）……');
    if (noWindNote(sid)) log(`⚠ ${noWindNote(sid)}：资源照样写，但游戏里看不出效果（先给场景配 wind）`);
    // 推送时游戏没开、还在等游戏页进这个场景再补发预览：作废它。
    // ⚠ 原来不管：游戏冷启动几十秒，这期间按了 B，游戏起来后那边照样补发一行 source:'preview'（排在导出那行之后），
    //   游戏停在导出之前的预览上、工作台还说「✔ 游戏起来了，已让它换上这份预览」，徽章也不报（资源比预览新）
    if (waitingForGame && waitingForGame.sid === sid && !waitingForGame.cancelled) {
      waitingForGame.cancelled = true;
      log('导出了，推送那边不再补发预览（游戏进这个场景就是导出的这份）');
    }
    let st;
    try {
      st = await runJob($('export'), '导出', () => api('/api/export', { scene: sid }));
    } catch (e) {
      log('导出失败：' + e.message);
      return '导出失败：' + e.message;
    }
    if (!st.succeeded) { log('导出失败：' + st.err); return '导出失败：' + st.err; }
    // 导出取代了之前推的预览（游戏收到导出那行就忘了预览，服务端也删了本机预览）：「刚推完」别再拿来判徽章
    if (lastPush && lastPush.sid === sid) lastPush = null;
    await refreshDerived(sid);
    // 烘焙读的是开跑那一刻盘上的涂层；烘着的时候作者又存过（盘上时刻变了）= 那几笔不在资源里，「待导出」得亮着
    //（服务端按输入指纹给 needsExport 时这里本来就是 true；老服务端只比时刻，会被最后写的 sway.json 盖过去）
    if (S.scene === sid && S.baseMtime !== baseAtExport) {
      S.needsExport = true;
      log('⚠ 导出烘着的时候又存过：那次存下的笔画不在这次导出里，再按一次「导出到游戏」');
    }
    const p = st.push || {};
    if (p.pushed && (p.inScene || !('pageAlive' in p))) {
      log('✔ 已写进资源');
      // 等游戏真换回资源这份：不挂在导出的 promise 上（关窗保护等的是资源写完，不是游戏换没换上）
      confirmApplied(sid, p, `✔ 游戏已换回资源里这份（第 ${p.rev} 次）`).catch(() => {});
      return '';
    }
    log(!p.pushed ? `✔ 已写进资源（游戏没收到：${p.why || '没开着'}；进这个场景就是这份）`
      : p.pageBusy ? `✔ 已写进资源（游戏页正在装场景，装好进到 ${sid} 就是这份）`
      : p.pageAlive ? `✔ 已写进资源（游戏现在在「${p.game.sceneId}」，进到 ${sid} 就是这份）`
        : '✔ 已写进资源（没有游戏页开着；进这个场景就是这份）');
    return '';
  } finally {
    setJobBusy(false);
  }
}

/**
 * 历史版本：页面内的一张列表，点「恢复」就回去（恢复前当前这份也进历史，所以恢复本身也可撤）。
 * ⚠ 别用 `prompt` 让人输序号——这是**丢了活之后**才会用的功能，那种时候最不该再为难人。
 */
/** 「历史…」顶上那一段：收起来的草稿（「发现没保存的草稿」里选了「先不管」的），恢复 = 草稿里的那几层整层替换页面上的、删 = 真删 */
function renderStashes(box, stashes) {
  const head = document.createElement('div');
  head.className = 'hint';
  // ⚠ 原来写"恢复 = 叠到页面上"，读着像合并，实际是整层替换：之后在这几层上画的笔画会没
  head.textContent = `${stashes.length} 份收起来的草稿（没保存过；恢复 = 用草稿里的这几层替换页面上的）`;
  box.appendChild(head);
  const sid = S.scene;
  for (const it of stashes) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.style.flex = '1';
    const when = it.at ? new Date(it.at).toLocaleString() : it.name;
    const which = [...(it.channels || []).map((c) => CH_NAME[c] || c), ...(it.ov ? ['锚点 / 整体摆'] : [])].join('、');
    label.textContent = `草稿 ${when}　${which}`;
    const restore = document.createElement('button');
    restore.textContent = '恢复';
    restore.addEventListener('click', async () => {
      if (S.scene !== sid) return;
      try {
        const d = await draftStore.getStash(sid, it.name);
        if (!d || !d.ch) { log('这份草稿读不出来'); return; }
        // 与恢复历史同一道闸：手上有没存的改动、或盘上那份在收起草稿之后又被改过，先说清楚要换掉哪几层
        //（原来直接换：草稿收起来之后在这几层上画的笔画整层没了，也没问一句）
        const names = draftLayerNames(d).join('、');
        const drifted = d.base !== undefined && d.base !== S.baseMtime;
        if (S.dirty || drifted) {
          const why = [
            S.dirty ? `手上有没保存的改动：恢复会用草稿里的「${names}」整层替换页面上的这几层，之后在这几层上画的会没（Ctrl+Z 能撤回）。` : '',
            drifted ? '⚠ 盘上那份在收起这份草稿之后又被改过（另一个窗口？），换上去会把两边混在一起。' : '',
          ].filter(Boolean).join('\n\n');
          const pick = await choose('恢复收起来的草稿', why, [['cancel', '取消'], ['go', `替换「${names}」`, 'danger']]);
          if (pick !== 'go' || S.scene !== sid) return;
        }
        if (!(await applyDraft(d))) return;          // 没换上就留着这份草稿
        draw();
        box.style.display = 'none';
        await draftStore.deleteStash(sid, it.name);   // 换上了才删（撤销在页面上，8 秒后的自动草稿也会兜住这一份）
      } catch (e) {
        log('恢复草稿失败：' + e.message);
      }
    });
    const del = document.createElement('button');
    del.textContent = '删';
    del.addEventListener('click', async () => {
      try {
        await draftStore.deleteStash(sid, it.name);
        row.remove();
        log('草稿已删掉');
      } catch (e) {
        log('删草稿失败：' + e.message);
      }
    });
    row.append(label, restore, del);
    box.appendChild(row);
  }
}

async function showHistory() {
  if (!S.scene) return;
  const box = $('history-box');
  if (box.style.display === 'block') { box.style.display = 'none'; return; }
  box.innerHTML = '<div class="hint">读取中…</div>';
  box.style.display = 'block';
  try {
    const j = await api('/api/history?scene=' + encodeURIComponent(S.scene));
    const stashes = await draftStore.stashes(S.scene).catch(() => []);
    box.innerHTML = '';
    if (stashes.length) renderStashes(box, stashes);
    if (!j.items.length) {
      const none = document.createElement('div');
      none.className = 'hint';
      none.textContent = '还没有历史版本。每次保存会自动留一份（保留最近 20 份）。';
      box.appendChild(none);
      return;
    }
    const head = document.createElement('div');
    head.className = 'hint';
    head.textContent = `${j.items.length} 份历史（新的在上；恢复前当前这份也会进历史）`;
    box.appendChild(head);
    for (const it of j.items.slice(0, 20)) {
      const row = document.createElement('div');
      row.className = 'row';
      const when = it.name.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2}).*$/, '$2-$3 $4:$5:$6');
      const label = document.createElement('span');
      label.style.flex = '1';
      label.textContent = `${when}　${Math.round(it.bytes / 1024)} KB`;
      const btn = document.createElement('button');
      btn.textContent = '恢复';
      btn.addEventListener('click', async () => {
        if (S.dirty && await choose('手上有没保存的改动', '恢复这一份历史会盖掉它们。', [['cancel', '取消'], ['go', '恢复', 'danger']]) !== 'go') return;
        const sid = S.scene;
        try {
          const r = await api('/api/restore', { scene: sid, name: it.name });
          log(`已恢复 ${r.restored}（当前这份也进了历史，后悔还能再恢复回来）`);
          box.style.display = 'none';
          // 上面已经问过一次：重装时不再问"切场景会丢"，也不再拿恢复之前的草稿来叠（那会把刚恢复的又盖回去）
          clearDraft(sid);
          // 盘上换成了历史那份：推过的预览与它不一样就撤掉（烘自被盖掉的那份，别让游戏和叠加层还显示它）
          await revokePreview(sid);
          S.dirty = false;
          await openScene(sid, { force: true, noDraft: true });
        } catch (e) {
          log('恢复失败：' + e.message);
        }
      });
      row.append(label, btn);
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = '';
    log('历史版本出错：' + e.message);
  }
}

/** 常驻状态条：有没有没保存的、游戏里是预览还是资源、资源是不是最新、游戏在不在 */
let link = null;                       // 最近一次 /api/link/status（dev server 在不在 + 游戏页心跳）
function renderBadges() {
  const b = $('badges');
  if (!b) return;
  const bits = [];
  bits.push(S.dirty
    ? '<b style="color:#ffb454">● 有未保存的改动</b>'
    : '<span style="color:#7ec87e">● 已保存</span>');
  // 推了 ≠ 进了资源，存了 ≠ 进了资源。这两档不说出来，作者会以为发行包里已经是这样了。
  // 游戏里此刻是不是预览看游戏页自己报的（它刷新过就忘了预览，盘上的时间戳说明不了）
  const page = link && link.pageAlive ? link.page : null;
  const here = !!page && page.sceneId === S.scene;
  // 刚推完那一两秒：游戏在原地重装、心跳还没带上新预览号（重装期间轮询停着）。同一局游戏（bootId 没变）就别说"游戏刷新过"
  const justPushed = !!lastPush && !!lastPush.bootId && lastPush.sid === S.scene && !!page
    && lastPush.bootId === page.bootId && Date.now() - lastPush.at < 20000;
  if (S.previewNewer) {
    bits.push(here && !page.preview && !justPushed && !page.loading
      ? '<b style="color:#ffb454">● 推过的预览没进这一局游戏（游戏刷新过）：按 P 再推一次；资源还没导出</b>'
      : here ? '<b style="color:#ffb454">● 游戏里是推送的预览（资源还没导出）</b>'
        : '<b style="color:#ffb454">● 最近推给游戏的是预览（资源还没导出）</b>');
  } else if (S.needsExport) {
    // 涂层没动、原画 / 照明烘焙在导出之后变过：说清是这个，免得作者去找自己哪笔没导出
    bits.push(S.layers && S.layers.id === S.scene && S.layers.bakeInputsChanged
      ? '<b style="color:#ffb454">● 待导出（原画 / 照明烘焙变过，资源里的拆层还是按旧的烘的）</b>'
      : '<b style="color:#ffb454">● 待导出（资源里还是上一版）</b>');
  }
  // 没配风：推送 / 导出都做得成、游戏也收得下，就是一株不动——不说出来作者只会以为工具没用
  if (noWindNote(S.scene)) bits.push(`<b style="color:#ffb454">● ${noWindNote(S.scene)}</b>`);
  const port = link && link.game ? link.game.replace('http://127.0.0.1:', ':') : '';
  bits.push(!link || !link.alive ? '游戏：没开着'
    : page ? `<span style="color:#7ec87e">● 游戏在 ${port}（${page.loading ? '正在装场景…' : here ? '就在这个场景' : '在 ' + page.sceneId}）</span>`
      : 'pageAlive' in link ? `dev server 在 ${port}，游戏页没开` : `<span style="color:#7ec87e">● 游戏在 ${port}</span>`);
  b.innerHTML = bits.join('　');
}
async function refreshBadges() {
  try {
    link = await api('/api/link/status');
  } catch {
    link = null;
  }
  renderBadges();
}

/**
 * 脏态一改就同步到界面（保存按钮变色、窗口标题带 ●、状态条），不等 1.5 秒一次的轮询——
 * 画完一笔低头找"存了没"，看到的必须是此刻的状态。挂成 `S.dirty` 的 setter，所有赋值点都自动走它。
 */
let _dirty = false;
S.editSeq = 0;                         // 每记一次"有改动"就加一（保存期间又画了几笔，靠它分辨）
Object.defineProperty(S, 'dirty', {
  enumerable: true,
  get: () => _dirty,
  set: (v) => {
    const next = !!v;
    if (next) S.editSeq++;
    if (next === _dirty) return;
    _dirty = next;
    $('save').classList.toggle('dirty', _dirty);
    document.title = (_dirty ? '● ' : '') + '草木工作台' + (S.scene ? ` · ${S.scene}` : '');
    renderBadges();
  },
});

/** 关窗 / 刷新前桌面壳来问（`tools/desktop_shell.py` 的 `_guard_unsaved`）；「保存并关闭」走的就是 Ctrl+S 那条 `save` */
/**
 * ⚠ 导出在跑也要拦：导出先存盘（S.dirty 已经是 false），再一个文件一个文件地写资源、sway.json 最后写；
 *   原来只看 S.dirty，关窗直接关、进程带着 daemon 线程退出，资源里留下新的 ids / matte 配旧的 sway.json，谁也不知道。
 */
window.__unsavedSummary = () => [
  S.dirty && S.scene ? `「${S.scene}」的涂层 / 锚点有未保存的改动。` : '',
  exportJob ? '正在导出到游戏：现在关掉，资源目录会只写一半（新的拆层图配旧的 sway.json）。「保存并关闭」会等导出跑完再关。' : '',
].filter(Boolean).join('\n');
window.__saveUnsaved = () => {
  window.__saveUnsavedResult = 'pending';
  (async () => {
    if (S.dirty || saveInFlight) await save();
    if (S.dirty) return '没存上（看左下日志）';
    // 导出还在跑：等它跑完才说 ok（原来 save 立刻回"没有未保存的改动"，「保存并关闭」照样在导出半路把窗口关了）
    if (exportJob) {
      const err = await exportJob;
      if (err) return `${err}（看左下日志；涂层已经存盘了，再关一次就关）`;
    }
    return 'ok';
  })().then((r) => { window.__saveUnsavedResult = r; },
    (e) => { window.__saveUnsavedResult = String((e && e.message) || e); });
};
/** 壳里选了「不保存」：这份活的草稿一起删掉（作者明说了不要，别下次打开又问要不要恢复）；壳最多等 2 秒 */
window.__onDiscardUnsaved = () => {
  if (!S.scene) return null;
  // 窗口马上就关 / 刷新：定时草稿先停，别在删掉之后又写回来
  clearInterval(S.draftTimer);
  S.draftSuppress = S.scene;
  // 推过的预览烘自这份没保存的活：一起撤掉（服务端删完本机预览就回，通知游戏在它那边的后台发，不占壳的 2 秒）
  return Promise.all([
    Promise.resolve(draftStore.clear(S.scene)).catch(() => {}),
    revokePreview(S.scene),
  ]);
};

// ---------------------------------------------------------------- 起
/**
 * 桌面壳收到第二个实例的 `open:<场景>`（主编辑器场景页「在草木工作台中打开…」）时调。
 * ⚠ 已经开着的就是这个场景：什么都不做（壳已经把窗口提到前面了）。原来照样 openScene——
 *   干净时静默重装、撤销栈清空、视图复位；有没存的改动时弹"重新装会丢掉这些改动"，而作者只是想把埋在底下的窗口叫出来。
 */
window.__openScene = (sid) => (sid && sid === S.scene ? undefined : openScene(sid));
//: 自检与取证用:页面状态全挂出来(桌面壳无头跑 selftest 时按它断言)
window.__openSceneForTest = openScene;          // 自检要重装同一个场景（验着色缓存清理、未保存三选一），__openScene 对同场景是空操作
window.__exportJobForTest = () => exportJob;    // 自检钉"导出在跑时关窗要拦"
window.__waitingForGameForTest = () => waitingForGame;   // 自检钉"导出作废推送的补发、finally 只清自己那张凭证"
window.__linkTimingForTest = LINK_TIMING;       // 自检把联动的等待调短（真值：进场景 90 s、换上 12 s）
window.__setExportJobForTest = (p) => { exportJob = p; };
window.__S = S;
window.__draw = draw;
window.__loadChannelForTest = loadChannel;      // 自检脚本要把导出的通道图装回来验往返
window.__draftPayloadForTest = draftPayload;   // 自检钉"只编码脏层 / 笔按下时不动"
window.__saveDraftForTest = saveDraft;         // 自检要接管 idle 队列，验排队中途切场景的守卫
window.__draftStoreForTest = draftStore;       // 自检把草稿的 put / get / clear 换成桩（草稿存服务端 local/，自检不写它）
window.__gameLinkForTest = gameLink;           // 自检把撤预览换成桩（真服务上它会删本机预览、通知真游戏）
window.__tintCacheForTest = _cache;            // 自检钉"装场景会清着色缓存"（不清是每次 ~20 MB 的泄漏）
window.__idMaskForTest = _idMask;              // 自检钉"整体摆蒙版不随画笔每次移动重建"
window.__scratchForTest = _scratch;            // 自检钉"连切场景画布数量不涨"（原来每切一次多一批大画布）

(async () => {
  bindTools();
  bindCanvas();
  $('save').addEventListener('click', () => save());
  $('fit').addEventListener('click', () => { fitView(); draw(); });
  setInterval(refreshBadges, 1500);
  $('history').addEventListener('click', showHistory);
  // 本地草稿：每 8 秒存一次（只在有改动时），页面崩了也只丢这 8 秒
  S.draftTimer = setInterval(saveDraft, 8000);
  $('export').addEventListener('click', exportToGame);
  $('push').addEventListener('click', pushToGame);
  $('scene').addEventListener('change', (e) => {
    // 选完就把焦点还回去：焦点停在下拉框上时单键快捷键全部让开（按 P 没反应），
    // 下拉框还会拿字母做首字母跳转——按 B 想导出，结果切到了 bridge_underpass
    e.target.blur();
    openScene(e.target.value).catch((err) => log('⛔ 切场景出错：' + ((err && err.message) || err)));
  });
  // 点开下拉框之前刷一次清单（烘完几何场回来，"没有深度，装不了"的场景要能选）；窗口重新拿到焦点时也刷
  $('scene').addEventListener('mousedown', () => { refreshScenes(); });
  $('scene').addEventListener('focus', () => { refreshScenes(); });
  window.addEventListener('focus', () => { refreshScenes(); });
  window.addEventListener('resize', onStageResize);
  // Ctrl+滚轮不许缩放整页（侧栏上一滚就把整页放大、累加、桌面壳里没法复位）；画布自己的滚轮缩放照常
  window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); save(); return; }
    // ⚠ 撤销只认不带 Shift / Alt 的 Ctrl+Z：Ctrl+Shift+Z（大多数画图软件的重做）原来也被当成撤销，多撤掉一笔
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && k === 'z') { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && ((e.shiftKey && k === 'z') || (!e.shiftKey && k === 'y'))) { e.preventDefault(); redo(); return; }
    // ⚠ 焦点在会吃字母键的控件里时，单键快捷键让开。切完场景焦点就停在场景下拉框上，
    // 那时按 X 会**清掉整整一层**、按 B 会直接导出进资源——而人只是想用首字母跳选项。
    // 滑块不在此列（它不认字母键，拦了反而是点过笔刷滑块后 [ ] 就失灵）；
    // Ctrl+S / Ctrl+Z 也不在此列：那两个在哪儿都该好使。
    const el0 = e.target;
    const tag = el0 && el0.tagName;
    // ⚠ 焦点在下拉框上时字母键归它（首字母跳选项）——这里 X 是清层、B 是导出，宁可快捷键不响也不能误触发。
    //   最常见的"切完场景快捷键没反应"由场景下拉框选完就失焦解决（见 bindUI 里 scene 的 change）。
    const eats = tag === 'SELECT' || tag === 'TEXTAREA' || (el0 && el0.isContentEditable)
      || (tag === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(el0.type));
    if (eats) return;
    // 切层 / 橡皮 = 回到画笔（原来在锚点 / 整体摆工具里按 2，下一下左键放的还是锚点）
    const pick = { 1: 'veg', 2: 'rigid', 3: 'freeze', 4: 'unrigid' }[e.key];
    if (pick) { S.chan = pick; S.tool = 'paint'; syncTool(); draw(); return; }
    if (k === 'e') { S.erase = !S.erase; S.tool = 'paint'; syncTool(); return; }
    if (k === 'x') { $('clear-ch').click(); return; }
    // 画图软件的通用键：[ ] 改笔刷、F 视图复位；P 推给游戏、B 导出到游戏
    if (k === '[' || k === ']') {
      const inp = $('size');
      const step = Math.max(2, Math.round(Number(inp.value) * 0.2));
      inp.value = String(Math.max(4, Math.min(240, Number(inp.value) + (k === ']' ? step : -step))));
      inp.dispatchEvent(new Event('input'));
      return;
    }
    if (k === 'f') { fitView(); draw(); return; }
    if (k === 'p' && !e.ctrlKey) { pushToGame(); return; }
    if (k === 'b' && !e.ctrlKey) { exportToGame(); }
  });
  window.addEventListener('beforeunload', (e) => { if (S.dirty && !window.__discardUnsaved) { e.preventDefault(); e.returnValue = ''; } });
  try {
    const list = await loadScenes();
    const boot = await api('/api/boot').catch(() => ({ open: '' }));
    const first = boot.open || (list.find((s) => s.sway) || list.find((s) => s.depth) || {}).id;
    if (first) { $('scene').value = first; await openScene(first); }
  } catch (e) {
    log('起不来：' + e.message);
  }
})();
