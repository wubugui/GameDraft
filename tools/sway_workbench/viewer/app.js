// 草木工作台前端：原画上涂三个通道（补植被 / 锁死 / 刚体）→ 存 sway_paint.png → 重烘 → 推给游戏看。
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
  needsBake: false,      // 涂层比拆层新 = 存过但没烘,游戏里看到的还是上一版
  layers: null, imgs: {}, buf: {}, painting: false, last: null,
  undo: [], stroke: null,
  baseMtime: 0,          // 装载时盘上那份的时间戳（乐观并发：别让两个窗口互相覆盖）
  draftTimer: null,      // 本地草稿（浏览器崩了 / 误关窗也不丢手上的活）
  chDirty: {},           // 哪几层和盘上那份不一样了（草稿只编码这几层）
  // 作者逐株设置（原画像素位置，不存实例 id——id 每次重烘都会变）：锚点、整体摆
  ov: { anchors: [], coherent: [] },
  ovDirty: false,
  tool: 'paint',         // paint | anchor | coherent
};

// ---------------------------------------------------------------- 本地草稿
const draftKey = () => `sway-draft:${S.scene}`;

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
    const d = draftPayload();
    if (!d) return;                    // 排队期间人又下笔了：这一轮让掉，下一轮再存
    try {
      localStorage.setItem(draftKey(), JSON.stringify(d));
    } catch { /* 配额满了就算了，草稿是兜底不是主路 */ }
  };
  if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 2000 });
  else run();
}

function clearDraft() {
  try { localStorage.removeItem(draftKey()); } catch { /* 没有就没有 */ }
}

async function offerDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch { d = null; }
  if (!d || !d.ch) return false;
  const age = Math.round((Date.now() - d.at) / 1000);
  const which = [...CHANNELS.filter((c) => d.ch[c]).map((c) => CH_NAME[c]), ...(d.ov ? ['锚点 / 整体摆'] : [])].join('、');
  // 草稿是增量：盘上那份在草稿写完之后又被改过的话，叠上去就是两份混在一起——说清楚再让人选
  const drifted = d.base !== undefined && d.base !== S.baseMtime;
  const warn = drifted ? '\n\n⚠ 盘上那份在这份草稿之后又被改过（另一个窗口？），叠上去会把两边混在一起。' : '';
  if (!confirm(`发现 ${age < 90 ? age + ' 秒前' : Math.round(age / 60) + ' 分钟前'}没保存的草稿（${which}），恢复吗？`
    + `\n（选“取消”就用盘上那份，草稿会留着）${warn}`)) return false;
  for (const c of CHANNELS) {
    if (!d.ch[c]) continue;
    await new Promise((res) => {
      const im = new Image();
      im.onload = () => { loadChannel(c, im); releaseImg(im); res(); };
      im.onerror = () => { releaseImg(im); res(); };
      im.src = d.ch[c];
    });
    S.chDirty[c] = true;
  }
  if (d.ov) { S.ov = d.ov; S.ovDirty = true; }
  S.dirty = true;
  log('已从本地草稿恢复（还没落盘，记得 Ctrl+S）');
  return true;
}

const log = (m, cls) => {
  const el = $('log');
  el.textContent += (el.textContent ? '\n' : '') + m;
  el.scrollTop = el.scrollHeight;
};

// ---------------------------------------------------------------- 装载
async function loadScenes() {
  const j = await api('/api/scenes');
  const sel = $('scene');
  sel.innerHTML = '';
  for (const s of j.scenes) {
    const o = document.createElement('option');
    const st = s.hasBackground === false ? '没有背景图，装不了'
      : s.sway ? `v${s.sway.version} · ${s.sway.instances} 株${s.sway.paint ? ' · 有涂层' : ''}` : '没烘过';
    o.value = s.id;
    o.textContent = `${s.id}　（${st}）`;
    o.disabled = !s.depth || s.hasBackground === false;
    sel.appendChild(o);
  }
  return j.scenes;
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
 * 这时按 Ctrl+S 会把旧场景的涂层存进新场景名下，重烘 / 推送也打到错的场景。
 * 现在：先请求，全部成功才换 `S.scene` 与画面；失败留在原场景、下拉框退回、日志里说清楚为什么。
 */
async function openScene(sid) {
  const prev = S.scene;
  if (S.dirty && !confirm('涂层还没保存，切场景会丢。继续？')) {
    $('scene').value = prev || '';      // 取消了就把下拉框退回去，别让名字和画面对不上
    return;
  }
  // ⚠ 只认最后一次：画布是复用的，前一次还没装完、后一次已经开始的话，
  //   两次会往**同一组**画布里写，后装完的那个（可能是旧场景）把新场景的涂层盖掉
  const token = (S.openToken = (S.openToken || 0) + 1);
  log(`装入 ${sid}…`);
  const fail = (why) => {
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
  S.needsBake = (L.paintMtime || 0) > (L.bakedMtime || 0);
  S.undo = [];
  S.dirty = false;
  S.chDirty = {};
  await offerDraft();
  fitView();
  const m = L.meta;
  $('state').textContent = m
    ? `${m.instances.length} 株 · v${m.version}${L.stale ? '（旧版，要重烘）' : ''}`
      + ` · 植被 ${(m.veg_coverage * 100).toFixed(1)}%`
      + (m.lock ? ` · 锁死 ${(m.lock.coverage * 100).toFixed(1)}%` : '')
      + (m.rigid_coverage ? ` · 刚体 ${(m.rigid_coverage * 100).toFixed(1)}%` : '')
    : '这个场景还没烘过拆层 —— 点「重烘拆层」跑一次自动分割打底';
  const painted = CHANNELS.reduce((n, c) => n + (L.counts ? (L.counts[c] || 0) : 0), 0);
  log(`装入 ${sid}（${nw}×${nh}）${painted ? `，已有涂层 ${painted} 像素` : ''}`);
  draw();
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

/** 悬停高亮：把那一株整片描出来（只看得见"哪些像素归它"，比读坐标直观得多） */
function drawHover(ctx) {
  const id = S.hover;
  const m = S.idMap;
  if (!id || !m) return;
  const [nw, nh] = S.native;
  const { c, x } = scratch('hover', m.w, m.h);
  const d = x.createImageData(m.w, m.h);
  const p = d.data, s = m.data;
  for (let i = 0; i < p.length; i += 4) {
    if (s[i] + 256 * s[i + 1] !== id) continue;
    p[i] = 255; p[i + 1] = 240; p[i + 2] = 130; p[i + 3] = 150;
  }
  x.putImageData(d, 0, 0);
  ctx.drawImage(c, 0, 0, nw, nh);
}

// ---------------------------------------------------------------- 视图
function fitView() {
  const st = $('stage').getBoundingClientRect();
  const [nw, nh] = S.native;
  const k = Math.min(st.width / nw, st.height / nh);
  S.view = { k, x: (st.width - nw * k) / 2, y: (st.height - nh * k) / 2 };
  for (const id of ['bg', 'ov']) {
    const c = $(id);
    c.width = nw;
    c.height = nh;
  }
  applyView();
}

function applyView() {
  const t = `translate(${S.view.x}px,${S.view.y}px) scale(${S.view.k})`;
  $('bg').style.transform = t;
  $('ov').style.transform = t;
}

const toNative = (ev) => {
  const st = $('stage').getBoundingClientRect();
  return [(ev.clientX - st.left - S.view.x) / S.view.k, (ev.clientY - st.top - S.view.y) / S.view.k];
};

// ---------------------------------------------------------------- 画
function draw() {
  const [nw, nh] = S.native;
  const b = $('bg').getContext('2d');
  b.clearRect(0, 0, nw, nh);
  if (S.imgs.bg) b.drawImage(S.imgs.bg, 0, 0, nw, nh);

  const o = $('ov').getContext('2d');
  o.clearRect(0, 0, nw, nh);
  const a = Number($('alpha').value) / 100;
  o.globalAlpha = a;
  if (S.show.ids && S.imgs.ids) o.drawImage(S.imgs.ids, 0, 0, nw, nh);
  if (S.show.veg && S.imgs.matte) {
    // matte.R = 已抠出的植被；画成绿色蒙版（只取 R 当 alpha）
    o.save();
    o.globalCompositeOperation = 'source-over';
    o.drawImage(tintFromChannel(S.imgs.matte, 0, [95, 208, 122]), 0, 0, nw, nh);
    o.restore();
  }
  if (S.show.free && S.imgs.matte) o.drawImage(tintFromChannel(S.imgs.matte, 2, [200, 200, 255]), 0, 0, nw, nh);
  if (S.show.rigid && S.imgs.rigid) o.drawImage(tintFromChannel(S.imgs.rigid, 0, [120, 140, 255]), 0, 0, nw, nh);
  if (S.show.paint && S.buf[S.chan]) o.drawImage(paintOverlay(), 0, 0, nw, nh);
  o.globalAlpha = 1;
  drawOverrides(o);
  drawHover(o);
}

/** 画作者的逐株设置：整体摆的株整片描淡蓝，锚点画成带十字的圈（屏幕上大小不随缩放变） */
function drawOverrides(ctx) {
  const m = S.idMap;
  const [nw, nh] = S.native;
  if (m && S.ov.coherent.length) {
    const ids = new Set(S.ov.coherent.map((p) => idAt(p[0], p[1])).filter((i) => i > 0));
    if (ids.size) {
      const { c, x } = scratch('coherent', m.w, m.h);
      const d = x.createImageData(m.w, m.h);
      const p = d.data, s = m.data;
      for (let i = 0; i < p.length; i += 4) {
        if (!ids.has(s[i] + 256 * s[i + 1])) continue;
        p[i] = 120; p[i + 1] = 190; p[i + 2] = 255; p[i + 3] = 110;
      }
      x.putImageData(d, 0, 0);
      ctx.drawImage(c, 0, 0, nw, nh);
    }
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
}
function tintFromChannel(img, ch, rgb) {
  const key = 'tint:' + ch + ':' + rgb.join(',');
  const hit = _cache.get(key);
  if (hit && hit.src === img.src) return hit.c;
  const [nw, nh] = S.native;
  const { c, x } = scratch(key, nw, nh, true);
  x.drawImage(img, 0, 0, nw, nh);
  const d = x.getImageData(0, 0, nw, nh);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const v = p[i + ch];
    p[i] = rgb[0]; p[i + 1] = rgb[1]; p[i + 2] = rgb[2]; p[i + 3] = v;
  }
  x.putImageData(d, 0, 0);
  _cache.set(key, { src: img.src, c });
  return c;
}

/** 我画的三个通道各上一个色，一次画出来；当前通道画得实一点，其余压淡（免得看不清在改哪一层） */
function paintOverlay() {
  const [nw, nh] = S.native;
  const { c, x } = scratch('paint-overlay', nw, nh);
  const d = x.createImageData(nw, nh);
  const p = d.data;
  for (const ch of CHANNELS) {
    const s = S.buf[ch].getImageData(0, 0, nw, nh).data;
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
 * 撤销按**逐段矩形补丁**存：一笔拖过去分成很多段，每段画之前把那一小块原样收起来，
 * 整笔作为一组；撤销时**反序**贴回去（段之间会重叠，顺序反了就补不回原样）。
 * ⚠ 别只存第一段的范围（第一版就是这么写的：拖一长条，撤销只回来一个圆点），
 * 也别整张快照（2048×1152 一笔 9 MB，四十笔就 360 MB）。
 */
function beginStroke() {
  S.stroke = { ch: S.chan, patches: [] };
}

function endStroke() {
  const st = S.stroke;
  S.stroke = null;
  if (!st || !st.patches.length) return;
  S.undo.push(st);
  if (S.undo.length > 40) S.undo.shift();
}

function undo() {
  const g = S.undo.pop();
  if (!g) { log('没有可撤销的了'); return; }
  if (g.kind === 'ov') {
    S.ov = g.prev;
    S.dirty = true;
    S.ovDirty = true;
    draw();
    return;
  }
  for (let i = g.patches.length - 1; i >= 0; i--) {
    const pt = g.patches[i];
    S.buf[g.ch].putImageData(pt.data, pt.x, pt.y);
  }
  S.dirty = true;
  S.chDirty[g.ch] = true;
  draw();
}

/** 画之前收一块原样（撤销用）；范围钳在画布内 */
function keepPatch(ctx, x0, y0, x1, y1, pad) {
  if (!S.stroke) return;
  const [nw, nh] = S.native;
  const x = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
  const y = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
  const w = Math.min(nw, Math.ceil(Math.max(x0, x1) + pad)) - x;
  const h = Math.min(nh, Math.ceil(Math.max(y0, y1) + pad)) - y;
  if (w <= 0 || h <= 0) return;
  S.stroke.patches.push({ x, y, data: ctx.getImageData(x, y, w, h) });
}

function stroke(x0, y0, x1, y1, erasing) {
  const ch = S.chan;
  const ctx = S.buf[ch];
  const r = Number($('size').value) / 2;
  const hard = Number($('hard').value) / 100;
  keepPatch(ctx, x0, y0, x1, y1, r + 2);
  ctx.save();
  ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(2, r * 0.35)));
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps, y = y0 + ((y1 - y0) * i) / steps;
    const g = ctx.createRadialGradient(x, y, r * hard, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  S.dirty = true;
  S.chDirty[ch] = true;
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
  $('t-erase').addEventListener('click', () => { S.erase = !S.erase; syncTool(); });
  $('clear-ch').addEventListener('click', () => {
    if (!S.buf[S.chan]) return;
    const [nw, nh] = S.native;
    beginStroke();
    keepPatch(S.buf[S.chan], 0, 0, nw, nh, 0);
    S.buf[S.chan].clearRect(0, 0, nw, nh);
    endStroke();
    S.dirty = true;
    S.chDirty[S.chan] = true;
    draw();
    log(`清空了「${CH_NAME[S.chan]}」这一层（Ctrl+Z 可撤销）`);
  });
  $('undo').addEventListener('click', undo);
  syncTool();
  const views = { 'v-paint': 'paint', 'v-veg': 'veg', 'v-ids': 'ids', 'v-free': 'free', 'v-rigid': 'rigid' };
  for (const [id, v] of Object.entries(views)) {
    $(id).addEventListener('click', () => { S.show[v] = !S.show[v]; $(id).classList.toggle('on', S.show[v]); draw(); });
  }
  for (const [id, out] of [['size', 'size-v'], ['hard', 'hard-v'], ['alpha', 'alpha-v']]) {
    $(id).addEventListener('input', () => { $(out).textContent = $(id).value; if (id === 'alpha') draw(); });
  }
}

function bindCanvas() {
  const stage = $('stage'), cur = $('cursor');
  stage.addEventListener('contextmenu', (e) => e.preventDefault());   // 右键留给橡皮
  // 植株工具（锚点 / 整体摆）：在捕获期截住，涂层一个像素都不动
  stage.addEventListener('pointerdown', (e) => {
    if (S.tool === 'paint' || e.altKey || !S.scene || e.button === 1 || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    const [x, y] = toNative(e);
    const prev = JSON.parse(JSON.stringify(S.ov));
    if (S.tool === 'anchor') {
      if (e.button === 2) {
        const lim = 30 / Math.max(S.view.k, 1e-3);
        let best = -1, bd = lim * lim;
        S.ov.anchors.forEach((a, i) => { const d = (a[0] - x) ** 2 + (a[1] - y) ** 2; if (d <= bd) { bd = d; best = i; } });
        if (best < 0) return;
        S.ov.anchors.splice(best, 1);
        log(`删掉一个锚点（还剩 ${S.ov.anchors.length} 个）`);
      } else {
        const id = idAt(x, y);
        S.ov.anchors.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
        log(`放了锚点 (${Math.round(x)},${Math.round(y)})` + (id ? ` → ${id} 号` : '　⚠ 不在任何一株上（烘焙时往外 24 像素找最近一株）'));
      }
    } else {
      const id = idAt(x, y);
      if (!id) { log('这里不属于任何一株'); return; }
      const i = S.ov.coherent.findIndex((p) => idAt(p[0], p[1]) === id);
      if (i >= 0) {
        S.ov.coherent.splice(i, 1);
        log(`${id} 号不再整体摆`);
      } else {
        S.ov.coherent.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
        log(`${id} 号标成整体摆（整株一起弯）`);
      }
    }
    S.undo.push({ kind: 'ov', prev });
    if (S.undo.length > 40) S.undo.shift();
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
    stroke(S.last[0], S.last[1], S.last[0], S.last[1], S.erase || e.button === 2);
    draw();
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    const r = Number($('size').value) * S.view.k;
    cur.style.display = 'block';
    cur.style.width = cur.style.height = r + 'px';
    const st = stage.getBoundingClientRect();
    cur.style.left = e.clientX - st.left - r / 2 + 'px';
    cur.style.top = e.clientY - st.top - r / 2 + 'px';
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
    stroke(S.last[0], S.last[1], p[0], p[1], erasingNow(e));
    S.last = p;
    draw();
  });
  const end = () => { if (S.painting) endStroke(); S.painting = false; S.pan = null; };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointerleave', () => { end(); cur.style.display = 'none'; });
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const st = stage.getBoundingClientRect();
    const mx = e.clientX - st.left, my = e.clientY - st.top;
    const k = S.view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12);
    S.view.x = mx - ((mx - S.view.x) * k) / S.view.k;
    S.view.y = my - ((my - S.view.y) * k) / S.view.k;
    S.view.k = k;
    applyView();
  }, { passive: false });
}

async function save(force = false) {
  if (!S.scene) return;
  if (!S.buf.veg) { log('场景还没装好，不存（免得拿空画布覆盖盘上的）'); return; }
  $('save').disabled = true;
  try {
    const channels = {};
    for (const c of CHANNELS) channels[c] = channelDataURL(c);
    let j;
    try {
      j = await api('/api/paint', { scene: S.scene, channels, baseMtime: S.baseMtime, force, overrides: S.ov });
    } catch (e) {
      if (e.conflict) {
        log(`⛔ ${e.message}`);
        alert(`${e.message}\n\n（盘上 ${new Date(e.diskMtime * 1000).toLocaleTimeString()} 改过；你装载的是 ${new Date(e.yourMtime * 1000).toLocaleTimeString()}）`);
        $('save').disabled = false;
        return;
      }
      if (e.needConfirm) {
        const b = e.before, a = e.after;
        const rows = CHANNELS.map((c) => `　${CH_NAME[c]}：${b[c]} → ${a[c]}`).join('\n');
        if (!confirm(`${e.message}\n\n${rows}\n\n确定要这么存吗？（上一版会留在历史里）`)) {
          log('已取消保存');
          $('save').disabled = false;
          return;
        }
        $('save').disabled = false;
        return save(true);
      }
      throw e;
    }
    S.dirty = false;
    S.chDirty = {};
    S.ovDirty = false;
    S.needsBake = true;              // 存下了但还没烘：游戏里看到的仍是上一版
    S.baseMtime = j.mtime || S.baseMtime;
    clearDraft();
    const c = j.coverage;
    log(`已存 ${j.path}（补植被 ${(c.veg * 100).toFixed(2)}% · 锁死 ${(c.freeze * 100).toFixed(2)}%`
      + ` · 加刚体 ${(c.rigid * 100).toFixed(2)}% · 减刚体 ${(c.unrigid * 100).toFixed(2)}%）`);
    if (j.lockMigrated) log('  旧的 sway_lock.png 已并进涂层并删除——从此锁死区只有一个来源');
  } catch (e) {
    log('保存失败：' + e.message);
  }
  $('save').disabled = false;
}

async function bake() {
  if (!S.scene) return;
  // ⚠ 先落盘再烘：烘焙读的是盘上那张图，没存就烘 = 烘的是上一版（页面上看着已经涂了，结果没生效）
  if (S.dirty) await save();
  $('bake').disabled = true;
  const btn = $('bake');
  const label = btn.textContent;
  log('重烘中……（第一次要跑分割，几十秒；之后走缓存只要几秒）');
  try {
    await api('/api/bake', { scene: S.scene });
    // 轮询进度：烘焙在服务端的线程里跑，别把浏览器卡在一个 fetch 上（作者会以为工具死了）
    let seen = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      const st = await api('/api/bake/status');
      for (const l of st.log.slice(seen)) log('  ' + l);
      seen = st.log.length;
      btn.textContent = st.running ? `重烘中 ${st.elapsed.toFixed(0)}s…` : label;
      if (st.done) {
        if (!st.succeeded) log('烘焙失败：' + st.err);
        break;
      }
    }
    _cache.clear();
    await openScene(S.scene);
  } catch (e) {
    log('烘焙失败：' + e.message);
  }
  btn.textContent = label;
  btn.disabled = false;
}

/**
 * 历史版本：页面内的一张列表，点「恢复」就回去（恢复前当前这份也进历史，所以恢复本身也可撤）。
 * ⚠ 别用 `prompt` 让人输序号——这是**丢了活之后**才会用的功能，那种时候最不该再为难人。
 */
async function showHistory() {
  if (!S.scene) return;
  const box = $('history-box');
  if (box.style.display === 'block') { box.style.display = 'none'; return; }
  box.innerHTML = '<div class="hint">读取中…</div>';
  box.style.display = 'block';
  try {
    const j = await api('/api/history?scene=' + encodeURIComponent(S.scene));
    if (!j.items.length) {
      box.innerHTML = '<div class="hint">还没有历史版本。每次保存会自动留一份（保留最近 20 份）。</div>';
      return;
    }
    box.innerHTML = '';
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
        if (S.dirty && !confirm('手上有没保存的改动，恢复会盖掉它。继续？')) return;
        try {
          const r = await api('/api/restore', { scene: S.scene, name: it.name });
          log(`已恢复 ${r.restored}（当前这份也进了历史，后悔还能再恢复回来）`);
          box.style.display = 'none';
          await openScene(S.scene);
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

async function push() {
  try {
    const j = await api('/api/push', { scene: S.scene });
    if (j.pushed) { log(`已推给游戏（第 ${j.rev} 次）——原地重装，不切场景、玩家不动`); return; }
    // 游戏没在这个场景里 / 没开着：退回"让它切过来"，至少能看见
    log(`推不动：${j.why}；改用切场景`);
    const k = await api('/api/link/open', { scene: S.scene });
    log(`已让游戏切到 ${S.scene}（${k.via}）`);
  } catch (e) {
    log('推给游戏失败：' + e.message + '（游戏没开？先跑 dev server）');
  }
}

/** 常驻状态条：有没有没保存的、游戏在不在、在哪个场景 */
async function refreshBadges() {
  const b = $('badges');
  if (!b) return;
  const bits = [];
  bits.push(S.dirty
    ? '<b style="color:#ffb454">● 有未保存的改动</b>'
    : '<span style="color:#7ec87e">● 已保存</span>');
  // 存了 ≠ 生效。差一次重烘的时候,游戏里看到的还是上一版 —— 这一档不说出来,
  // 作者会以为是工具没用(而不是自己少按一下)。
  if (S.needsBake) bits.push('<b style="color:#ffb454">● 待重烘（游戏里还是上一版）</b>');
  try {
    const j = await api('/api/link/status');
    const sid = j.state && (j.state.sceneId || j.state.scene);
    bits.push(j.alive
      ? `<span style="color:#7ec87e">● 游戏在 ${j.game.replace('http://127.0.0.1:', ':')}</span>`
        + (sid ? `（${sid === S.scene ? '就在这个场景' : '在 ' + sid}）` : '')
      : '游戏：没开着');
  } catch {
    bits.push('游戏：没开着');
  }
  b.innerHTML = bits.join('　');
}

// ---------------------------------------------------------------- 起
window.__openScene = (sid) => openScene(sid);
//: 自检与取证用:页面状态全挂出来(桌面壳无头跑 selftest 时按它断言)
window.__S = S;
window.__draw = draw;
window.__loadChannelForTest = loadChannel;      // 自检脚本要把导出的通道图装回来验往返
window.__draftPayloadForTest = draftPayload;   // 自检钉"只编码脏层 / 笔按下时不动"
window.__saveDraftForTest = saveDraft;         // 自检要接管 idle 队列，验排队中途切场景的守卫
window.__tintCacheForTest = _cache;            // 自检钉"装场景会清着色缓存"（不清是每次 ~20 MB 的泄漏）
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
  $('bake').addEventListener('click', bake);
  $('push').addEventListener('click', push);
  $('scene').addEventListener('change', (e) => {
    openScene(e.target.value).catch((err) => log('⛔ 切场景出错：' + ((err && err.message) || err)));
  });
  window.addEventListener('resize', () => { fitView(); draw(); });
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); save(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); return; }
    // ⚠ 焦点在会吃字母键的控件里时，单键快捷键让开。切完场景焦点就停在场景下拉框上，
    // 那时按 X 会**清掉整整一层**、按 B 会直接开烘——而人只是想用首字母跳选项。
    // 滑块不在此列（它不认字母键，拦了反而是点过笔刷滑块后 [ ] 就失灵）；
    // Ctrl+S / Ctrl+Z 也不在此列：那两个在哪儿都该好使。
    const el0 = e.target;
    const tag = el0 && el0.tagName;
    const eats = tag === 'SELECT' || tag === 'TEXTAREA' || (el0 && el0.isContentEditable)
      || (tag === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(el0.type));
    if (eats) return;
    const pick = { 1: 'veg', 2: 'rigid', 3: 'freeze', 4: 'unrigid' }[e.key];
    if (pick) { S.chan = pick; syncTool(); draw(); return; }
    if (k === 'e') { S.erase = !S.erase; syncTool(); return; }
    if (k === 'x') { $('clear-ch').click(); return; }
    // 画图软件的通用键：[ ] 改笔刷、F 视图复位、B 重烘
    if (k === '[' || k === ']') {
      const inp = $('size');
      const step = Math.max(2, Math.round(Number(inp.value) * 0.2));
      inp.value = String(Math.max(4, Math.min(240, Number(inp.value) + (k === ']' ? step : -step))));
      inp.dispatchEvent(new Event('input'));
      return;
    }
    if (k === 'f') { fitView(); draw(); return; }
    if (k === 'b' && !e.ctrlKey) { $('bake').click(); }
  });
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  try {
    const list = await loadScenes();
    const boot = await api('/api/boot').catch(() => ({ open: '' }));
    const first = boot.open || (list.find((s) => s.sway) || list.find((s) => s.depth) || {}).id;
    if (first) { $('scene').value = first; await openScene(first); }
  } catch (e) {
    log('起不来：' + e.message);
  }
})();
