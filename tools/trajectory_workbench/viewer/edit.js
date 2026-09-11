'use strict';
/* 轨迹工作台 · 文档编辑操作（视图 → 这里 → doc）。
 *
 * 全部操作都用**有效坐标**说话：画面空间是场景坐标 [sx, sy]；世界空间是 {x, z, h}
 * （地面坐标 + 离地高度）。存进 doc 的控制点与烘焙机看到的一样：`path.points` 是一个"形状"，
 * 烘焙时按 `startFrom` 平移到段起点（delta = start − points[0]）。为了让"画布上画的 = 烘出来的"，
 * 这里在每次写点之前先 `normalize`：把存储点整体平移到 delta = 0（points[0] == 起点），
 * 之后存储坐标就是有效坐标。起点被锚住（anchor / previous）的段，0 号点永远钉在起点上。
 *
 * 需要的上下文 `host`：doc / cal / space / 段起点（优先拿上次烘焙的段边界）/ restH（世界空间静止离地高）。
 * 这里不碰 DOM、不碰历史栈（调用方用 History.commit 包起来）。 */

const Edit = {
  segs(doc) { doc.source = doc.source || { segments: [] }; doc.source.segments = doc.source.segments || []; return doc.source.segments; },
  startMode(doc, seg) {
    const i = Edit.segs(doc).indexOf(seg);
    if (i === 0) return 'explicit';   // 曲线没有锚点：第 0 段的起点就是曲线起点（自定，可拖）
    const m = seg.startFrom === 'entity' || seg.startFrom === 'anchor' ? 'explicit' : seg.startFrom;   // 旧的"锚点"起点：曲线不再有锚点，按自定
    return m === 'previous' || m === 'explicit' ? m : 'previous';
  },
  isPinned(doc, seg) { return Edit.startMode(doc, seg) !== 'explicit'; },
  isWorld(host) { return host.doc.space === 'world'; },

  // ---------------------------------------------------------------- 曲线原点 / 曲线起点（两回事）
  /** **曲线原点** = 作者摆的参考点：播放时给的位置对齐的就是它，帧相对它写（2026-09-11 第二轮）。
   *  世界空间的真相是 `authoring.originWorld`（绝对世界点），`authoring.origin` 是它的投影；画面空间只有 `origin`。
   *  没摆过（新曲线 / 老资产）**退到曲线起点**——保持"原点就在起点上"的老观感，作者一拖两者就分开。
   *  ⚠ 别再把它当成"第一帧"：原点钉死在起点上时，调一下运动起点整条曲线在播放时就整体位移了（制作人打回过）。 */
  originWorld(host) {
    const au = host.doc.authoring || {};
    if (!host.cal) return null;
    if (au.originWorld && Number.isFinite(num(au.originWorld.x, NaN))) {
      return [num(au.originWorld.x, 0), num(au.originWorld.y, 0), num(au.originWorld.z, 0)];
    }
    return Edit.curveStartWorld(host);
  },
  originScreen(host) {
    const au = host.doc.authoring || {};
    if (Edit.isWorld(host)) {
      const w = Edit.originWorld(host);
      if (w && host.cal) { const f = host.cal.worldToScene(w[0], w[1], w[2]); return [f[0], f[1]]; }
    }
    if (au.origin && Number.isFinite(num(au.origin.x, NaN))) return [num(au.origin.x, 0), num(au.origin.y, 0)];
    return Edit.curveStartScreen(host);
  },
  /** 作者到底摆过原点没有（没摆过 = 跟着曲线起点走，UI 上要说清楚）。 */
  hasOrigin(host) {
    const au = host.doc.authoring || {};
    const o = Edit.isWorld(host) ? au.originWorld : au.origin;
    return !!(o && Number.isFinite(num(o.x, NaN)));
  },
  /** 写原点（世界绝对点）：同时把画面投影写上，右栏 / 画布不必等烘焙回填。 */
  setOriginWorld(host, w) {
    if (!w || !Number.isFinite(w[0]) || !host.cal) return false;
    const au = host.doc.authoring;
    au.originWorld = { x: round3(w[0]), y: round3(w[1]), z: round3(w[2]) };
    const f = host.cal.worldToScene(au.originWorld.x, au.originWorld.y, au.originWorld.z);
    au.origin = { x: round2(f[0]), y: round2(f[1]) };
    return true;
  },
  /** 写原点（画面点）。世界空间：落到该画面点脚下的地面，**保持原来的离地高**（与拖点同式）。 */
  setOriginScreen(host, s) {
    if (!s || !Number.isFinite(s[0]) || !Number.isFinite(s[1])) return false;
    if (!Edit.isWorld(host)) { host.doc.authoring.origin = { x: round2(s[0]), y: round2(s[1]) }; return true; }
    const cal = host.cal; if (!cal) return false;
    const cur = Edit.originWorld(host);
    const h = cur ? Math.max(0, cur[1] - cal.groundHeight(cur[0], cur[2])) : 0;
    const g = cal.sceneToWorldGround(s[0], s[1]);
    return Edit.setOriginWorld(host, [g[0], g[1] + h, g[2]]);
  },
  /** 原点的离地高（世界空间；画面空间没有这个概念） */
  originHeight(host) {
    const w = Edit.originWorld(host), cal = host.cal;
    if (!w || !cal) return 0;
    return Math.max(0, w[1] - cal.groundHeight(w[0], w[2]));
  },
  setOriginHeight(host, h) {
    const w = Edit.originWorld(host), cal = host.cal;
    if (!w || !cal) return false;
    return Edit.setOriginWorld(host, [w[0], cal.groundHeight(w[0], w[2]) + Math.max(0, num(h, 0)), w[2]]);
  },
  /** 原点回到曲线起点（右栏按钮；也是新曲线的缺省关系）。 */
  originToCurveStart(host) {
    if (Edit.isWorld(host)) { const w = Edit.curveStartWorld(host); return w ? Edit.setOriginWorld(host, w) : false; }
    return Edit.setOriginScreen(host, Edit.curveStartScreen(host));
  },
  /** 整条变换把原点一起带走（不带的话"整条挪开"在播放时等于没挪：播放位置对齐的是原点）。 */
  transformOrigin(host, T) {
    if (Edit.isWorld(host)) {
      const cal = host.cal, w = Edit.originWorld(host);
      if (!cal || !w) return;
      const h = Math.max(0, w[1] - cal.groundHeight(w[0], w[2]));
      const o = T.pos([w[0], w[2], h]);
      const nh = Math.max(0, o.length > 2 ? o[2] : h);
      Edit.setOriginWorld(host, [o[0], cal.groundHeight(o[0], o[1]) + nh, o[1]]);
      return;
    }
    const s = Edit.originScreen(host);
    Edit.setOriginScreen(host, T.pos([s[0], s[1]]));
  },
  /** **曲线起点** = 第 0 段的起点（运动从哪儿开始）；没有分段时退到原点 / 出生点。 */
  curveStartWorld(host) {
    const segs = Edit.segs(host.doc);
    if (segs.length) { const w = Edit.segStartWorld(host, segs[0]); if (w) return w; }
    return Edit._originFallbackWorld(host);
  },
  curveStartScreen(host) {
    const segs = Edit.segs(host.doc);
    if (segs.length) return Edit.segStartScreen(host, segs[0]);
    return Edit._originFallbackScreen(host);
  },
  _originFallbackWorld(host) {
    const au = host.doc.authoring || {}, cal = host.cal;
    if (!cal) return null;
    if (au.originWorld && Number.isFinite(au.originWorld.x)) return [au.originWorld.x, au.originWorld.y, au.originWorld.z];
    const o = au.origin || au.anchor || (host.scene && host.scene.spawnPoint) || null;
    if (!o) return null;
    const g = cal.sceneToWorldGround(num(o.x, 0), num(o.y, 0));
    return [g[0], g[1] + host.restH(), g[2]];
  },
  _originFallbackScreen(host) {
    const au = host.doc.authoring || {};
    const o = au.origin || au.anchor || (host.scene && host.scene.spawnPoint) || null;
    return o ? [num(o.x, 0), num(o.y, 0)] : [0, 0];
  },
  /** 段起点（世界坐标）：自定起点 / 锚点 本地算（拖锚点时才能实时跟手）；"上一段末点"才需要上次烘焙的段边界。 */
  segStartWorld(host, seg) {
    const doc = host.doc, cal = host.cal;
    if (!cal) return null;
    const segs = Edit.segs(doc), i = segs.indexOf(seg);
    const bs = host.bakeSegment(i);
    const mode = Edit.startMode(doc, seg);
    if (mode === 'explicit') {
      if (seg.start && seg.start.z != null) return cal.xzhToWorld(num(seg.start.x, 0), num(seg.start.z, 0), num(seg.start.h, 0));
      if (bs && bs.start && bs.start.length === 3) return bs.start.slice();
      const pts = (seg.path && seg.path.points) || [];   // 没写 start 的自定起点 = 画在哪就在哪（path[0]）
      if (pts.length) return cal.xzhToWorld(num(pts[0].x, 0), num(pts[0].z, 0), num(pts[0].h, 0));
    }
    if (mode === 'previous' && i > 0) {
      if (bs && bs.start && bs.start.length === 3) return bs.start.slice();
      const pb = host.bakeSegment(i - 1);
      if (pb && pb.end && pb.end.length === 3) return pb.end.slice();
      const prev = segs[i - 1];
      if (prev.kind === 'manual' && prev.path && prev.path.points && prev.path.points.length) {
        const pts = Edit.effPointsWorld(host, prev);
        if (pts.length) return pts[pts.length - 1].pos.slice();
      }
      const ps = Edit.segStartWorld(host, prev);
      if (ps) return ps;
    }
    return Edit._originFallbackWorld(host);
  },
  segStartXZH(host, seg) {
    const w = Edit.segStartWorld(host, seg);
    if (!w) return null;
    const o = host.cal.worldToXZH(w[0], w[1], w[2]);
    return { x: o.x, z: o.z, h: o.h };
  },
  /** 段起点（画面坐标）。 */
  segStartScreen(host, seg) {
    const doc = host.doc;
    if (Edit.isWorld(host)) {
      const w = Edit.segStartWorld(host, seg);
      return w && host.cal ? host.cal.worldToScene(w[0], w[1], w[2]) : Edit._originFallbackScreen(host);
    }
    const segs = Edit.segs(doc), i = segs.indexOf(seg);
    const bs = host.bakeSegment(i);
    const mode = Edit.startMode(doc, seg);
    if (mode === 'explicit') {
      if (seg.start) return [num(seg.start.x, 0), num(seg.start.y, 0)];
      if (bs && bs.start) return [bs.start[0], bs.start[1]];
      const pts = (seg.path && seg.path.points) || [];
      if (pts.length) return [num(pts[0].x, 0), num(pts[0].y, 0)];
    }
    if (mode === 'previous' && i > 0) {
      if (bs && bs.start) return [bs.start[0], bs.start[1]];
      const pb = host.bakeSegment(i - 1);
      if (pb && pb.end) return [pb.end[0], pb.end[1]];
      const prev = segs[i - 1];
      if (prev.kind === 'manual' && prev.path && prev.path.points && prev.path.points.length) {
        const pts = Edit.effPointsScreen(host, prev);
        if (pts.length) return [pts[pts.length - 1].sx, pts[pts.length - 1].sy];
      }
      return Edit.segStartScreen(host, prev);
    }
    return Edit._originFallbackScreen(host);
  },

  // ---------------------------------------------------------------- 有效点
  _delta(host, seg) {
    const pts = (seg.path && seg.path.points) || [];
    if (!pts.length) return Edit.isWorld(host) ? [0, 0, 0] : [0, 0];
    if (Edit.isWorld(host)) {
      const st = Edit.segStartXZH(host, seg);
      if (!st) return [0, 0, 0];
      return [st.x - num(pts[0].x, 0), st.z - num(pts[0].z, 0), st.h - num(pts[0].h, 0)];
    }
    const st = Edit.segStartScreen(host, seg);
    return [st[0] - num(pts[0].x, 0), st[1] - num(pts[0].y, 0)];
  },
  /** 世界空间有效点：[{x,z,h,pos:[x,y,z],sx,sy,foot:[fx,fy]}]。
   *  ⚠ 这里的 `h` 是**离地高度**（0 = 贴地），= 存储的 h − restH（restH = 锚点静止离地高，
   *  圆心锚的铜钱 = 半径/cosθ）。文件里存的 h 是锚点离地面的绝对高度（烘焙机 y = 地面 + h）。 */
  effPointsWorld(host, seg) {
    const cal = host.cal, pts = (seg.path && seg.path.points) || [];
    if (!cal) return [];
    const d = Edit._delta(host, seg), rh = host.restH();
    return pts.map((p) => {
      const x = num(p.x, 0) + d[0], z = num(p.z, 0) + d[1], hh = Math.max(0, num(p.h, 0) + d[2]);
      const pos = cal.xzhToWorld(x, z, hh), s = cal.worldToScene(pos[0], pos[1], pos[2]);
      const f = cal.worldToScene(pos[0], pos[1] - hh, pos[2]);
      return { x, z, h: hh - rh, hAbs: hh, pos, sx: s[0], sy: s[1], foot: f };
    });
  },
  /** 画面空间有效点：[{sx,sy}] */
  effPointsScreen(host, seg) {
    const pts = (seg.path && seg.path.points) || [];
    const d = Edit._delta(host, seg);
    return pts.map((p) => ({ sx: num(p.x, 0) + d[0], sy: num(p.y, 0) + d[1] }));
  },
  /** 两种空间统一：每个点都有 sx/sy；世界空间另有 x/z/h/pos/foot。 */
  effPoints(host, seg) { return Edit.isWorld(host) ? Edit.effPointsWorld(host, seg) : Edit.effPointsScreen(host, seg); },
  /** 把存储点平移到 delta=0（points[0] == 起点）。之后存储坐标 == 有效坐标。
   *  纯刚性平移：**不钳 h**（钻地由烘焙机采样时钳 / 报警），否则一次坏起点就把整条形状逐点裁掉且不可撤销。 */
  normalize(host, seg) {
    const pts = seg.path && seg.path.points;
    if (!pts || !pts.length) return;
    const d = Edit._delta(host, seg);
    if (d.every((v) => Math.abs(v) < 1e-9)) return;
    if (Edit.isWorld(host)) for (const p of pts) { p.x = r4(num(p.x, 0) + d[0]); p.z = r4(num(p.z, 0) + d[1]); p.h = r4(num(p.h, 0) + d[2]); }
    else for (const p of pts) { p.x = r4(num(p.x, 0) + d[0]); p.y = r4(num(p.y, 0) + d[1]); }
  },
  /** 有效坐标 → 存储点（世界 {x,z,h（离地高度，0=贴地）} / 画面 {x,y}）。 */
  _mk(host, pos) {
    if (Edit.isWorld(host)) return { x: round2(pos.x), z: round2(pos.z), h: round2(Math.max(0, num(pos.h, 0) + host.restH())) };
    return { x: round2(pos[0]), y: round2(pos[1]) };
  },

  // ---------------------------------------------------------------- 段
  newSegId(doc, kind) { const used = new Set(Edit.segs(doc).map((s) => s.id)); let i = 1; while (used.has(`${kind}_${i}`)) i++; return `${kind}_${i}`; }
  ,
  /** 新建一段并追加到末尾。手绘段起手只有起点一个点（钉在起点），之后在画布上点。返回索引。 */
  addSegment(host, kind, opts) {
    const doc = host.doc, segs = Edit.segs(doc), first = segs.length === 0, world = Edit.isWorld(host);
    const o = opts || {};
    let seg;
    if (kind === 'manual') {
      seg = { id: Edit.newSegId(doc, 'manual'), kind: 'manual', startFrom: first ? 'explicit' : 'previous', path: { points: [], smooth: true },
        timing: { durationMs: 1000, keys: [{ atMs: 0, progress: 0 }, { atMs: 1000, progress: 1 }] } };
      segs.push(seg);
      const st = world ? Edit.segStartXZH(host, seg) : Edit.segStartScreen(host, seg);
      if (st) seg.path.points.push(world ? { x: round2(st.x), z: round2(st.z), h: round2(Math.max(0, st.h)) } : Edit._mk(host, st));
    } else {
      const r = o.radius != null ? o.radius : (host.entityRadius ? host.entityRadius() : 7);
      seg = { id: Edit.newSegId(doc, 'physics'), kind: 'physics', startFrom: first ? 'explicit' : 'previous',
        v0: world ? { x: -120, y: 260, z: 40 } : { x: -120, y: -260 }, gravity: world ? 865 : 1500, restitution: 0.45, tangentialDamping: 0.1, rollingFriction: 150,
        stop: { minSpeed: 40, maxMs: 4000 }, spin: { radius: r } };
      segs.push(seg);
      // 画面空间地面线：不能高于这一段真正的起点（setGroundY 的不变量），曲线起点+接地偏移只是下限
      if (world) seg.radius = r; else seg.groundY = round2(Math.max(Edit.segStartScreen(host, seg)[1], Edit._originFallbackScreen(host)[1] + host.contactOffsetY()));
      // 第一段从**原点**起（新曲线的原点就在这儿；作者之后拖开两者才分家）
      if (first && !world) seg.start = (() => { const o = Edit.originScreen(host); return { x: round2(o[0]), y: round2(o[1]) }; })();
      if (first && world) { const o = Edit.originWorld(host); if (o) { const q = host.cal.worldToXZH(o[0], o[1], o[2]); seg.start = { x: round2(q.x), z: round2(q.z), h: round2(Math.max(0, q.h)) }; } }
    }
    return segs.length - 1;
  },
  deleteSegment(host, i) {
    const segs = Edit.segs(host.doc);
    if (i < 0 || i >= segs.length) return;
    segs.splice(i, 1);
    if (segs[0] && segs[0].startFrom !== 'explicit') Edit.setStartMode(host, segs[0], 'explicit');   // 新的第 0 段：起点就是它现在的位置
  },
  moveSegment(host, i, d) {
    const segs = Edit.segs(host.doc); const j = i + d;
    if (i < 0 || j < 0 || j >= segs.length) return i;
    [segs[i], segs[j]] = [segs[j], segs[i]];
    if (segs[0] && segs[0].startFrom !== 'explicit') Edit.setStartMode(host, segs[0], 'explicit');
    return j;
  },
  duplicateSegment(host, i) {
    const segs = Edit.segs(host.doc); const src = segs[i]; if (!src) return -1;
    const copy = deepClone(src);
    copy.id = Edit.newSegId(host.doc, src.kind);
    copy.startFrom = 'previous';
    segs.splice(i + 1, 0, copy);
    return i + 1;
  },
  /** 粘贴一段（来自剪贴板的段对象）到末尾；起点接上一段。 */
  pasteSegment(host, segObj) {
    const segs = Edit.segs(host.doc);
    const copy = deepClone(segObj);
    copy.id = Edit.newSegId(host.doc, copy.kind || 'manual');
    copy.startFrom = segs.length ? 'previous' : 'explicit';
    segs.push(copy);
    return segs.length - 1;
  },
  setStartMode(host, seg, mode) {
    const world = Edit.isWorld(host);
    Edit.normalize(host, seg);
    const cur = Edit.startMode(host.doc, seg);
    if (mode === 'explicit' && (cur !== 'explicit' || !seg.start)) {
      // 从"它现在的绝对起点"补 start：cur 仍按旧 startFrom 算（previous → 上一段末点；第 0 段 → path[0] / 回落）
      const st = world ? Edit.segStartXZH(host, seg) : Edit.segStartScreen(host, seg);
      if (st) seg.start = world ? { x: round2(st.x), z: round2(st.z), h: round2(Math.max(0, st.h)) } : { x: round2(st[0]), y: round2(st[1]) };
    }
    seg.startFrom = mode;
    if (mode !== 'explicit') { delete seg.start; Edit.normalize(host, seg); }   // 残留的 start 会误导读文件的人
  },
  /** 自定起点（世界的 h 是**绝对**离地高，与文件同口径）。没有 start 的段先按现算的起点补齐（部分写入才有基准）。 */
  setExplicitStart(host, seg, pos) {
    if (Edit.startMode(host.doc, seg) !== 'explicit') seg.startFrom = 'explicit';
    if (!seg.start) {
      if (Edit.isWorld(host)) { const st = Edit.segStartXZH(host, seg); seg.start = st ? { x: round2(st.x), z: round2(st.z), h: round2(Math.max(0, st.h)) } : { x: 0, z: 0, h: 0 }; }
      else { const st = Edit.segStartScreen(host, seg); seg.start = { x: round2(st[0]), y: round2(st[1]) }; }
    }
    const pts = seg.path && seg.path.points;
    if (Edit.isWorld(host)) {
      const cur = seg.start || {};
      seg.start = { x: round2(num(pos.x, num(cur.x, 0))), z: round2(num(pos.z, num(cur.z, 0))), h: round2(Math.max(0, num(pos.h, num(cur.h, 0)))) };
      if (pts && pts.length) { const d = [seg.start.x - num(pts[0].x, 0), seg.start.z - num(pts[0].z, 0), seg.start.h - num(pts[0].h, 0)]; for (const p of pts) { p.x = r4(num(p.x, 0) + d[0]); p.z = r4(num(p.z, 0) + d[1]); p.h = r4(Math.max(0, num(p.h, 0) + d[2])); } }
    } else {
      seg.start = { x: round2(pos[0]), y: round2(pos[1]) };
      if (pts && pts.length) { const d = [seg.start.x - num(pts[0].x, 0), seg.start.y - num(pts[0].y, 0)]; for (const p of pts) { p.x = r4(num(p.x, 0) + d[0]); p.y = r4(num(p.y, 0) + d[1]); } }
    }
  },

  // ---------------------------------------------------------------- 控制点
  appendPoint(host, seg, pos) {
    seg.path = seg.path || { points: [] }; seg.path.points = seg.path.points || [];
    Edit.normalize(host, seg);
    seg.path.points.push(Edit._mk(host, pos));
    return seg.path.points.length - 1;
  },
  insertPoint(host, seg, after, pos) {
    Edit.normalize(host, seg);
    const p = Edit._mk(host, pos);
    seg.path.points.splice(after + 1, 0, p);
    return after + 1;
  },
  /** 写一个点的有效坐标。world 的 pos 可以只给 {h}（离地高度，0=贴地）或只给 {x,z}。 */
  setPoint(host, seg, i, pos) {
    const pts = seg.path && seg.path.points; if (!pts || !pts[i]) return;
    if (i === 0 && Edit.isPinned(host.doc, seg)) return;
    Edit.normalize(host, seg);
    const p = pts[i];
    if (Edit.isWorld(host)) {
      if (pos.x != null) p.x = round2(pos.x);
      if (pos.z != null) p.z = round2(pos.z);
      if (pos.h != null) p.h = round2(Math.max(0, pos.h + host.restH()));
    } else { p.x = round2(pos[0]); p.y = round2(pos[1]); }
    if (i === 0 && Edit.startMode(host.doc, seg) === 'explicit') seg.start = Edit.isWorld(host) ? { x: p.x, z: p.z, h: num(p.h, 0) } : { x: p.x, y: p.y };
  },
  /** 批量写点（拖多个点）。items: [{i, pos}] */
  setPoints(host, seg, items) { for (const it of items) Edit.setPoint(host, seg, it.i, it.pos); },
  deletePoints(host, seg, indices) {
    const pts = seg.path && seg.path.points; if (!pts) return 0;
    Edit.normalize(host, seg);
    const pinned = Edit.isPinned(host.doc, seg);
    const del = new Set(indices.filter((i) => i >= 0 && i < pts.length && !(pinned && i === 0)));
    if (!del.size) return 0;
    if (pts.length - del.size < 1) return 0;
    seg.path.points = pts.filter((_, i) => !del.has(i));
    if (!pinned && seg.path.points.length) { const p = seg.path.points[0]; seg.start = Edit.isWorld(host) ? { x: p.x, z: p.z, h: num(p.h, 0) } : { x: p.x, y: p.y }; }
    return del.size;
  },
  /** 平滑 / 折线 */
  setSmooth(host, seg, smooth) { seg.path = seg.path || { points: [] }; seg.path.smooth = !!smooth; },

  // ---------------------------------------------------------------- 命名插槽（曲线暴露给场景的位置）
  /** 插槽存画面坐标（作者场景 wu）；世界空间烘焙机回填脚下地面的世界坐标 `world`。 */
  slots(doc) { doc.slots = Array.isArray(doc.slots) ? doc.slots : []; return doc.slots; },
  findSlot(doc, id) { return Edit.slots(doc).find((q) => q.id === id) || null; },
  newSlotId(doc) { const used = new Set(Edit.slots(doc).map((q) => q.id)); let i = 1; while (used.has(`slot_${i}`)) i++; return `slot_${i}`; },
  addSlot(host, x, y, label) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const s = { id: Edit.newSlotId(host.doc), x: round2(x), y: round2(y) };
    if (label) s.label = label;
    Edit.slots(host.doc).push(s);
    return s.id;
  },
  setSlot(host, id, pos) {
    const s = Edit.findSlot(host.doc, id); if (!s) return false;
    if (pos.x != null && Number.isFinite(pos.x)) s.x = round2(pos.x);
    if (pos.y != null && Number.isFinite(pos.y)) s.y = round2(pos.y);
    delete s.world;   // 世界坐标是烘焙派生量，挪了就作废，等下次烘焙回填
    return true;
  },
  renameSlot(host, id, newId) {
    const s = Edit.findSlot(host.doc, id); const nid = String(newId || '').trim();
    if (!s || !nid || nid === id) return false;
    if (Edit.findSlot(host.doc, nid)) return false;
    s.id = nid; return true;
  },
  setSlotLabel(host, id, label) { const s = Edit.findSlot(host.doc, id); if (!s) return false; const l = String(label || '').trim(); if (l) s.label = l; else delete s.label; return true; },
  deleteSlot(host, id) { const arr = Edit.slots(host.doc); const i = arr.findIndex((q) => q.id === id); if (i < 0) return false; arr.splice(i, 1); return true; },
  /** 插槽脚下的地面世界点（本地算；与烘焙机回填的 `world` 同式） */
  slotWorld(host, s) { const cal = host.cal; if (!cal) return null; return cal.sceneToWorldGround(num(s.x, 0), num(s.y, 0)); },
  /** 整条变换连插槽一起（插槽是地面上的站位：世界按 (x,z) 变换再落回地面，画面直接变换） */
  transformSlots(host, T) {
    const cal = host.cal;
    for (const s of Edit.slots(host.doc)) {
      if (Edit.isWorld(host)) {
        if (!cal) continue;
        const g = cal.sceneToWorldGround(num(s.x, 0), num(s.y, 0));
        const o = T.pos([g[0], g[2], 0]);
        const f = cal.worldToScene(o[0], cal.groundHeight(o[0], o[1]), o[1]);
        s.x = round2(f[0]); s.y = round2(f[1]);
      } else { const o = T.pos([num(s.x, 0), num(s.y, 0)]); s.x = round2(o[0]); s.y = round2(o[1]); }
      delete s.world;
    }
  },

  // ---------------------------------------------------------------- 抛体
  restYFn(host) { const cal = host.cal, rh = host.restH(); return (x, z) => cal.groundHeight(x, z) + rh; },
  /** 本地解析飞行：{start(screen [sx,sy] | world xyz), tip, landing, apex, arc(screen 折线), arcW(world), grounded} */
  physicsInfo(host, seg) {
    const T = 0.25, v = seg.v0 || {};
    const g = Math.abs(num(seg.gravity, 0));
    if (Edit.isWorld(host)) {
      const cal = host.cal, st = Edit.segStartWorld(host, seg);
      if (!st || !cal) return null;
      const f = flight3D(st, v, g, Edit.restYFn(host));
      const toS = (p) => cal.worldToScene(p[0], p[1], p[2]);
      const tipW = [st[0] + num(v.x, 0) * T, st[1] + num(v.y, 0) * T, st[2] + num(v.z, 0) * T];
      return { start: toS(st), startW: st, tip: toS(tipW), tipW, landing: toS(f.landing), landingW: f.landing,
        apex: f.apex ? toS(f.apex) : null, apexW: f.apex, arc: f.arc.map(toS), arcW: f.arc, grounded: f.grounded, t: f.t };
    }
    const st0 = Edit.segStartScreen(host, seg);
    const gy = typeof seg.groundY === 'number' ? seg.groundY : st0[1];
    const st = [st0[0], Math.min(st0[1], gy)];   // 起点在地面线之下：烘焙机抬到地面线，把手也从抬起后的点画
    const f = flight2D(st, v, g, gy);
    return { start: st, tip: [st[0] + num(v.x, 0) * T, st[1] + num(v.y, 0) * T], landing: f.landing, apex: f.apex, arc: f.arc, grounded: f.grounded, t: f.t, groundY: gy, lifted: st0[1] > gy };
  },
  setV0(host, seg, v) {
    seg.v0 = seg.v0 || {};
    if (v.x != null && Number.isFinite(v.x)) seg.v0.x = round2(v.x);
    if (v.y != null && Number.isFinite(v.y)) seg.v0.y = round2(v.y);
    if (Edit.isWorld(host) && v.z != null && Number.isFinite(v.z)) seg.v0.z = round2(v.z);
  },
  /** 把初速箭尖拖到画面/世界某处（箭尖 = 起点 + v0·0.25s）。 */
  setTip(host, seg, tip) {
    const T = 0.25;
    if (Edit.isWorld(host)) {
      const st = Edit.segStartWorld(host, seg); if (!st) return;
      Edit.setV0(host, seg, { x: (tip[0] - st[0]) / T, y: (tip[1] - st[1]) / T, z: (tip[2] - st[2]) / T });
    } else {
      const st = Edit.segStartScreen(host, seg);
      Edit.setV0(host, seg, { x: (tip[0] - st[0]) / T, y: (tip[1] - st[1]) / T });
    }
  },
  /** 落点把手：画面 [lx, ly]（ly 改地面线）；世界 [x, z]（地面坐标）。
   *  返回 {clamped, noGravity}：画面空间落点不能高于起点（2D 地面是一条线，起点在地面之下没有意义），钳了要告诉作者。 */
  setLanding(host, seg, target) {
    const g = Math.abs(num(seg.gravity, 0));
    const info = { clamped: false, noGravity: !(g > 1e-9) };
    if (info.noGravity) return info;
    if (Edit.isWorld(host)) {
      const st = Edit.segStartWorld(host, seg); if (!st) return info;
      if (!Number.isFinite(target[0]) || !Number.isFinite(target[1])) return info;
      seg.v0 = solveLanding3D(st, seg.v0 || {}, g, Edit.restYFn(host), target[0], target[1]);
    } else {
      const st = Edit.segStartScreen(host, seg);
      if (!Number.isFinite(target[0])) return info;
      if (target.length > 1 && target[1] != null && Number.isFinite(target[1])) {
        const gy0 = typeof seg.groundY === 'number' ? seg.groundY : st[1];
        if (st[1] > gy0) seg.groundY = round2(target[1]);   // 起点已在地面线之下（烘焙机抬起点）：线随手挪，不钳——钳回原始起点会让线一碰就瞬移
        else { info.clamped = target[1] < st[1]; seg.groundY = round2(Math.max(st[1], target[1])); }
      }
      const gy = typeof seg.groundY === 'number' ? seg.groundY : st[1];
      seg.v0 = solveLanding2D(st, seg.v0 || {}, g, gy, target[0]);
    }
    return info;
  },
  /** 最高点把手：画面 y / 世界 y。 */
  setApex(host, seg, y) {
    const g = Math.abs(num(seg.gravity, 0));
    if (!(g > 1e-9) || !Number.isFinite(y)) return { noGravity: !(g > 1e-9) };
    if (Edit.isWorld(host)) {
      const st = Edit.segStartWorld(host, seg); if (!st) return {};
      seg.v0 = solveApex3D(st, seg.v0 || {}, g, Edit.restYFn(host), y);
    } else {
      const st = Edit.segStartScreen(host, seg);
      const gy = typeof seg.groundY === 'number' ? seg.groundY : st[1];
      seg.v0 = solveApex2D(st, seg.v0 || {}, g, gy, y);
    }
    return {};
  },
  /** 地面线（画面空间）：正常态不能高于起点（烘焙机会把起点抬到地面线，等于起点被改了）。返回是否钳过。
   *  起点**已经**在地面线之下（上一段末点比线低）时是受支持的状态：解算 / 烘焙都按"起点抬到线上"算，这时线随手挪、不钳，
   *  否则线一碰就跳回原始起点（与 physicsInfo 的判断打架）。 */
  setGroundY(host, seg, y) {
    if (!Number.isFinite(y)) return false;
    const st = Edit.segStartScreen(host, seg);
    const gy0 = typeof seg.groundY === 'number' ? seg.groundY : st[1];
    if (st[1] > gy0) { seg.groundY = round2(y); return false; }
    const clamped = y < st[1];
    seg.groundY = round2(Math.max(st[1], y));
    return clamped;
  },

  // ---------------------------------------------------------------- 变换（gizmo）
  /** T：{kind, pos(p)→p, vec(v)→v, k}；画面 p=[x,y]；世界 p=[x,z,h]（h 只受 hScale/hOffset），vec 是 3D 速度。
   *  钉住起点的段：旋转 / 缩放 / 镜像以起点为轴（整体变换后再拉回起点）；**纯平移会被起点吃掉**，所以整段平移
   *  自动把起点改成"自定"（脱离锚点 / 上一段），返回 {promoted:true} 让调用方提示。只动选中点（only）时起点永远不动。 */
  transformSegment(host, seg, T, only) {
    const doc = host.doc, world = Edit.isWorld(host);
    const info = { promoted: false };
    if (Edit.isIdentity(T, world)) return info;   // 零位移 / 零角 / ×1：整条 no-op（不促升起点、不标脏）
    if (!only && T.kind === 'translate' && Edit.isPinned(doc, seg)) { Edit.setStartMode(host, seg, 'explicit'); info.promoted = true; }
    const pinned = Edit.isPinned(doc, seg);
    const rh = world ? host.restH() : 0;   // 变换作用在"离地高度"上（贴地的点缩放后仍贴地）
    if (seg.kind === 'manual' && seg.path && seg.path.points) {
      Edit.normalize(host, seg);
      const pts = seg.path.points;
      pts.forEach((p, i) => {
        if (only && !only.has(i)) return;
        if (i === 0 && pinned && only) return;   // 只动选中点时钉住的起点不动；整段变换则整体刚性变换后再拉回起点
        if (world) { const o = T.pos([num(p.x, 0), num(p.z, 0), num(p.h, 0) - rh]); p.x = round2(o[0]); p.z = round2(o[1]); p.h = round2(Math.max(0, o[2] + rh)); }
        else { const o = T.pos([num(p.x, 0), num(p.y, 0)]); p.x = round2(o[0]); p.y = round2(o[1]); }
      });
      if (!pinned && !only) {
        if (world && seg.start) { const o = T.pos([num(seg.start.x, 0), num(seg.start.z, 0), num(seg.start.h, 0) - rh]); seg.start = { x: round2(o[0]), z: round2(o[1]), h: round2(Math.max(0, o[2] + rh)) }; }
        else if (seg.start) { const o = T.pos([num(seg.start.x, 0), num(seg.start.y, 0)]); seg.start = { x: round2(o[0]), y: round2(o[1]) }; }
      }
      // 起点被钉住而形状整体变换后 0 号点会离开起点：再规范化拉回来（= 以起点为轴的变换）
      if (pinned) Edit.normalize(host, seg);
    } else if (seg.kind === 'physics' && !only) {
      const v = seg.v0 || {};
      if (world) { const o = T.vec([num(v.x, 0), num(v.y, 0), num(v.z, 0)]); seg.v0 = { x: round2(o[0]), y: round2(o[1]), z: round2(o[2]) }; }
      else { const o = T.vec([num(v.x, 0), num(v.y, 0)]); seg.v0 = { x: round2(o[0]), y: round2(o[1]) }; }
      if (!pinned && seg.start) {
        if (world) { const o = T.pos([num(seg.start.x, 0), num(seg.start.z, 0), num(seg.start.h, 0) - rh]); seg.start = { x: round2(o[0]), z: round2(o[1]), h: round2(Math.max(0, o[2] + rh)) }; }
        else { const o = T.pos([num(seg.start.x, 0), num(seg.start.y, 0)]); seg.start = { x: round2(o[0]), y: round2(o[1]) }; }
      }
      if (!world && typeof seg.groundY === 'number' && T.groundY) seg.groundY = round2(T.groundY(seg.groundY));
    }
    return info;
  },
  /** T 是不是恒等（探针：两个不同点变换后都不动） */
  isIdentity(T, world) {
    const probes = world ? [[0, 0, 0], [100, 37, 5]] : [[0, 0], [100, 37]];
    return probes.every((p) => { const q = T.pos(p); return q.every((v, i) => Math.abs(v - p[i]) < 1e-9); });
  },
  /** 整条：平移 = 每个自定起点的段整体挪（钉在上一段末点的段由规范化跟着走）+ 插槽 + **原点**一起挪；
   *  旋转 / 缩放逐段以原点为轴，插槽与原点也跟着。原点必须一起走——播放位置对齐的是原点，
   *  不带它的话"把整条挪开"在播放时等于什么都没发生。 */
  transformAll(host, T) {
    const world = Edit.isWorld(host);
    if (Edit.isIdentity(T, world)) return { allMoved: false };
    for (const seg of Edit.segs(host.doc)) {
      if (T.kind === 'translate' && Edit.isPinned(host.doc, seg)) continue;   // 接上一段的：起点跟着上一段走，别促升
      Edit.transformSegment(host, seg, T, null);
    }
    Edit.transformSlots(host, T);
    if (Edit.hasOrigin(host)) Edit.transformOrigin(host, T);   // 没摆过的跟着曲线起点走，不用动
    return { allMoved: true };
  },
  /** 常用变换构造。pivot：画面 [px,py] / 世界 [px,pz]。 */
  T: {
    translate2(dx, dy) { return { kind: 'translate', pos: (p) => [p[0] + dx, p[1] + dy], vec: (v) => v, k: 1, groundY: (y) => y + dy }; },
    translate3(dx, dz, dh) { return { kind: 'translate', pos: (p) => [p[0] + dx, p[1] + dz, p[2] + (dh || 0)], vec: (v) => v, k: 1 }; },
    rotate2(pivot, deg) {
      const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      return { kind: 'rotate', pos: (p) => { const x = p[0] - pivot[0], y = p[1] - pivot[1]; return [pivot[0] + x * c - y * s, pivot[1] + x * s + y * c]; },
        vec: (v) => [v[0] * c - v[1] * s, v[0] * s + v[1] * c], k: 1, groundY: (y) => y };
    },
    /** 绕竖直轴转（俯视逆时针为正，x 朝右 z 朝远） */
    rotateY(pivot, deg) {
      const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      return { kind: 'rotate', pos: (p) => { const x = p[0] - pivot[0], z = p[1] - pivot[1]; return [pivot[0] + x * c - z * s, pivot[1] + x * s + z * c, p[2]]; },
        vec: (v) => [v[0] * c - v[2] * s, v[1], v[0] * s + v[2] * c], k: 1 };
    },
    scale2(pivot, kx, ky) {
      const k = Math.sqrt(Math.abs(kx * ky)) || 1;
      return { kind: 'scale', pos: (p) => [pivot[0] + (p[0] - pivot[0]) * kx, pivot[1] + (p[1] - pivot[1]) * ky],
        // 抛体：射程 ∝ v²/g，尺度缩 k 则速度缩 √k 才落在同比例的位置
        vec: (v) => [v[0] * Math.sign(kx) * Math.sqrt(Math.abs(kx)), v[1] * Math.sign(ky) * Math.sqrt(Math.abs(ky))], k,
        groundY: (y) => pivot[1] + (y - pivot[1]) * ky };
    },
    scale3(pivot, kx, kz, kh) {
      const k = Math.sqrt(Math.abs(kx * kz)) || 1;
      return { kind: 'scale', pos: (p) => [pivot[0] + (p[0] - pivot[0]) * kx, pivot[1] + (p[1] - pivot[1]) * kz, p[2] * (kh == null ? 1 : kh)],
        vec: (v) => [v[0] * Math.sign(kx) * Math.sqrt(Math.abs(kx)), v[1] * Math.sqrt(Math.abs(kh == null ? k : kh)), v[2] * Math.sign(kz) * Math.sqrt(Math.abs(kz))], k };
    },
    mirror2(pivot, axis) { return axis === 'x' ? { kind: 'mirror', pos: (p) => [2 * pivot[0] - p[0], p[1]], vec: (v) => [-v[0], v[1]], k: 1, groundY: (y) => y }
      : { kind: 'mirror', pos: (p) => [p[0], 2 * pivot[1] - p[1]], vec: (v) => [v[0], -v[1]], k: 1, groundY: (y) => 2 * pivot[1] - y }; },
    mirror3(pivot, axis) { return axis === 'x' ? { kind: 'mirror', pos: (p) => [2 * pivot[0] - p[0], p[1], p[2]], vec: (v) => [-v[0], v[1], v[2]], k: 1 }
      : { kind: 'mirror', pos: (p) => [p[0], 2 * pivot[1] - p[1], p[2]], vec: (v) => [v[0], v[1], -v[2]], k: 1 }; },
  },

  // ---------------------------------------------------------------- 空间 / 场景换算
  /** 画面 ↔ 世界的分段换算（切换空间时）：点按"画面点 → 脚下地面点"或"世界点 → 画面投影"逐个转；初速按 0.25s 位移换。 */
  convertSpace(host, from, to) {
    const cal = host.cal, doc = host.doc; if (!cal) return;
    for (const seg of Edit.segs(doc)) {
      const pts = (seg.path && seg.path.points) || [];
      if (to === 'world') {
        const rh = round2(host.restH());   // 贴地 = 存储 h 是 restH（不是 0）
        if (seg.path) seg.path.points = pts.map((p) => { const g = cal.sceneToWorldGround(num(p.x, 0), num(p.y, 0)); return { x: round2(g[0]), z: round2(g[2]), h: rh }; });
        if (seg.start) { const g = cal.sceneToWorldGround(num(seg.start.x, 0), num(seg.start.y, 0)); seg.start = { x: round2(g[0]), z: round2(g[2]), h: rh }; }
        if (seg.kind === 'physics') { const v = seg.v0 || { x: 0, y: 0 }; seg.v0 = { x: round2(num(v.x, 0)), y: round2(-num(v.y, 0) / cal.cosTheta), z: 0 }; delete seg.groundY; seg.radius = seg.radius || (seg.spin && seg.spin.radius) || 0; if (num(seg.gravity, 0) > 1200) seg.gravity = 865; }
        if (seg.tracks) delete seg.tracks.sortY;
      } else {
        if (seg.path) seg.path.points = pts.map((p) => { const s = cal.xzhToScene(num(p.x, 0), num(p.z, 0), num(p.h, 0)); return { x: round2(s[0]), y: round2(s[1]) }; });
        if (seg.start) { const s = cal.xzhToScene(num(seg.start.x, 0), num(seg.start.z, 0), num(seg.start.h, 0)); seg.start = { x: round2(s[0]), y: round2(s[1]) }; }
        if (seg.kind === 'physics') {
          const v = seg.v0 || { x: 0, y: 0, z: 0 }; const o = cal.projectOffset(num(v.x, 0), num(v.y, 0), num(v.z, 0)); seg.v0 = { x: round2(o[0]), y: round2(o[1]) };
          // 地面线不能高于这段的起点：自定起点用它，钉住的段起点估计 = 上一段末点（转换后）或锚点
          const i = Edit.segs(doc).indexOf(seg); const prev = i > 0 ? Edit.segs(doc)[i - 1] : null;
          const prevPts = prev && prev.path && prev.path.points; const prevEnd = prevPts && prevPts.length ? prevPts[prevPts.length - 1] : null;
          const oy = Edit._originFallbackScreen(host)[1];
          const sy = seg.start ? num(seg.start.y, 0) : (Edit.startMode(doc, seg) === 'previous' && prevEnd ? num(prevEnd.y, oy) : oy);
          seg.groundY = round2(Math.max(sy, oy + host.contactOffsetY())); delete seg.radius;
        }
      }
    }
  },
  bounds(host, scope, seg, set) {
    const pts = [];
    const push = (s, only) => {
      if (s.kind === 'manual') Edit.effPoints(host, s).forEach((p, i) => { if (!only || only.has(i)) pts.push([p.sx, p.sy]); });
      else if (!only) { let pi = null; try { pi = Edit.physicsInfo(host, s); } catch (e) { pi = null; } if (pi) { pts.push(pi.start, pi.tip, pi.landing); if (pi.apex) pts.push(pi.apex); } }
    };
    if (scope === 'all') Edit.segs(host.doc).forEach((s) => push(s, null));
    else if (seg) push(seg, scope === 'points' ? set : null);
    if (!pts.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    return { x0, y0, x1, y1, n: pts.length };
  },
};
function r4(v) { return Math.round(v * 10000) / 10000; }
function round3(v) { return Math.round(v * 1000) / 1000; }   // 世界坐标落盘取 3 位（与烘焙机同）

if (typeof module !== 'undefined' && module.exports) module.exports = { Edit };
