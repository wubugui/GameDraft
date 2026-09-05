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
    const m = seg.startFrom === 'entity' ? 'anchor' : seg.startFrom;
    return m === 'anchor' || m === 'previous' || m === 'explicit' ? m : (i === 0 ? 'anchor' : 'previous');
  },
  isPinned(doc, seg) { return Edit.startMode(doc, seg) !== 'explicit'; },
  isWorld(host) { return host.doc.space === 'world'; },

  // ---------------------------------------------------------------- 起点
  /** 锚点的世界位置（画面锚点脚下地面点抬 restH）。 */
  anchorWorld(host) {
    const au = host.doc.authoring, cal = host.cal;
    if (!cal) return null;
    if (au.anchorWorld && Number.isFinite(au.anchorWorld.x)) return [au.anchorWorld.x, au.anchorWorld.y, au.anchorWorld.z];
    const g = cal.sceneToWorldGround(au.anchor.x, au.anchor.y + (au.contactOffsetY || 0));
    return [g[0], g[1] + host.restH(), g[2]];
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
    }
    if (mode === 'anchor') { const a = Edit.anchorWorld(host); if (a) return a; }
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
    return Edit.anchorWorld(host);
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
      return w && host.cal ? host.cal.worldToScene(w[0], w[1], w[2]) : [doc.authoring.anchor.x, doc.authoring.anchor.y];
    }
    const segs = Edit.segs(doc), i = segs.indexOf(seg);
    const bs = host.bakeSegment(i);
    const mode = Edit.startMode(doc, seg);
    if (mode === 'explicit') {
      if (seg.start) return [num(seg.start.x, 0), num(seg.start.y, 0)];
      if (bs && bs.start) return [bs.start[0], bs.start[1]];
    }
    if (mode === 'anchor') return [doc.authoring.anchor.x, doc.authoring.anchor.y];
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
    return [doc.authoring.anchor.x, doc.authoring.anchor.y];
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
      seg = { id: Edit.newSegId(doc, 'manual'), kind: 'manual', startFrom: first ? 'anchor' : 'previous', path: { points: [], smooth: true },
        timing: { durationMs: 1000, keys: [{ atMs: 0, progress: 0 }, { atMs: 1000, progress: 1 }] } };
      segs.push(seg);
      const st = world ? Edit.segStartXZH(host, seg) : Edit.segStartScreen(host, seg);
      if (st) seg.path.points.push(world ? { x: round2(st.x), z: round2(st.z), h: round2(Math.max(0, st.h)) } : Edit._mk(host, st));
    } else {
      const r = o.radius != null ? o.radius : (host.entityRadius ? host.entityRadius() : 7);
      seg = { id: Edit.newSegId(doc, 'physics'), kind: 'physics', startFrom: first ? 'anchor' : 'previous',
        v0: world ? { x: -120, y: 260, z: 40 } : { x: -120, y: -260 }, gravity: world ? 865 : 1500, restitution: 0.45, tangentialDamping: 0.1, rollingFriction: 150,
        stop: { minSpeed: 40, maxMs: 4000 }, spin: { radius: r } };
      segs.push(seg);
      // 画面空间地面线：不能高于这一段真正的起点（setGroundY 的不变量），锚点+接地偏移只是下限
      if (world) seg.radius = r; else seg.groundY = round2(Math.max(Edit.segStartScreen(host, seg)[1], doc.authoring.anchor.y + (doc.authoring.contactOffsetY || 0)));
    }
    return segs.length - 1;
  },
  deleteSegment(host, i) {
    const segs = Edit.segs(host.doc);
    if (i < 0 || i >= segs.length) return;
    segs.splice(i, 1);
    if (segs[0] && Edit.startMode(host.doc, segs[0]) === 'previous') segs[0].startFrom = 'anchor';
  },
  moveSegment(host, i, d) {
    const segs = Edit.segs(host.doc); const j = i + d;
    if (i < 0 || j < 0 || j >= segs.length) return i;
    [segs[i], segs[j]] = [segs[j], segs[i]];
    if (segs[0] && Edit.startMode(host.doc, segs[0]) === 'previous') segs[0].startFrom = 'anchor';
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
    copy.startFrom = segs.length ? 'previous' : 'anchor';
    segs.push(copy);
    return segs.length - 1;
  },
  setStartMode(host, seg, mode) {
    const world = Edit.isWorld(host);
    Edit.normalize(host, seg);
    const cur = Edit.startMode(host.doc, seg);
    if (mode === 'explicit' && cur !== 'explicit') {
      const st = world ? Edit.segStartXZH(host, seg) : Edit.segStartScreen(host, seg);
      seg.start = world ? { x: round2(st.x), z: round2(st.z), h: round2(Math.max(0, st.h)) } : { x: round2(st[0]), y: round2(st[1]) };
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

  // ---------------------------------------------------------------- 锚点
  /** 锚点换位 = 整条轨迹整体挪（形状相对锚点）：钉住的段靠规范化跟着走；**自定起点的段也一起平移**
   *  （carry=false 时只改锚点本身，换场景时用——那里由 applyRelative 负责搬形状）。 */
  setAnchorScreen(host, x, y, carry) {
    const au = host.doc.authoring, world = Edit.isWorld(host);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (round2(x) === au.anchor.x && round2(y) === au.anchor.y) return;   // 没动：什么都不碰（不标脏、不删 anchorWorld）
    // carry=false 是换场景中途（cal 已是新场景、锚点还是旧坐标）：此时规范化会拿跨场景的垃圾 delta 平移形状，绝不能做
    if (carry !== false) for (const seg of Edit.segs(host.doc)) Edit.normalize(host, seg);
    const old = { x: au.anchor.x, y: au.anchor.y };
    let dWorld = null;
    if (carry !== false && world && host.cal && host.cal.ground) {
      const a = host.cal.sceneToWorldGround(old.x, old.y), b = host.cal.sceneToWorldGround(x, y);
      dWorld = [b[0] - a[0], b[2] - a[2]];
    }
    au.anchor = { x: round2(x), y: round2(y) };
    delete au.anchorWorld;
    if (carry === false) return;
    const dx = au.anchor.x - old.x, dy = au.anchor.y - old.y;
    for (const seg of Edit.segs(host.doc)) {
      if (Edit.startMode(host.doc, seg) !== 'explicit' || !seg.start) continue;
      if (world) { if (dWorld) { seg.start.x = round2(num(seg.start.x, 0) + dWorld[0]); seg.start.z = round2(num(seg.start.z, 0) + dWorld[1]); } }
      else { seg.start.x = round2(num(seg.start.x, 0) + dx); seg.start.y = round2(num(seg.start.y, 0) + dy); if (typeof seg.groundY === 'number') seg.groundY = round2(seg.groundY + dy); }
      // 自定起点的存储点跟起点走（规范化到新起点）
      const pts = seg.path && seg.path.points;
      if (pts && pts.length) { if (world) { const d = [seg.start.x - num(pts[0].x, 0), seg.start.z - num(pts[0].z, 0)]; for (const p of pts) { p.x = r4(num(p.x, 0) + d[0]); p.z = r4(num(p.z, 0) + d[1]); } } else { const d = [seg.start.x - num(pts[0].x, 0), seg.start.y - num(pts[0].y, 0)]; for (const p of pts) { p.x = r4(num(p.x, 0) + d[0]); p.y = r4(num(p.y, 0) + d[1]); } } }
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
  /** 整条：平移 = 挪锚点（帧相对锚点，语义天然正确，自定起点的段由 setAnchorScreen 一起带走）；其余变换逐段以锚点为轴。 */
  transformAll(host, T) {
    if (Edit.isIdentity(T, Edit.isWorld(host))) return { anchorMoved: false };
    if (T.kind === 'translate') {
      const au = host.doc.authoring;
      if (Edit.isWorld(host)) {
        const a = Edit.anchorWorld(host); if (!a) return { anchorMoved: false };
        const o = T.pos([a[0], a[2], 0]);
        const f = host.cal.worldToScene(o[0], host.cal.groundHeight(o[0], o[1]), o[1]);   // 新锚点脚下地面点 → 画面
        Edit.setAnchorScreen(host, f[0], f[1] - (au.contactOffsetY || 0), true);
      } else { const o = T.pos([au.anchor.x, au.anchor.y]); Edit.setAnchorScreen(host, o[0], o[1], true); }
      return { anchorMoved: true };
    }
    for (const seg of Edit.segs(host.doc)) Edit.transformSegment(host, seg, T, null);
    return { anchorMoved: false };
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
          const sy = seg.start ? num(seg.start.y, 0) : (Edit.startMode(doc, seg) === 'previous' && prevEnd ? num(prevEnd.y, doc.authoring.anchor.y) : doc.authoring.anchor.y);
          seg.groundY = round2(Math.max(sy, doc.authoring.anchor.y + (doc.authoring.contactOffsetY || 0))); delete seg.radius;
        }
      }
    }
  },
  /** 换预览实体后静止离地高变了：存储的绝对 h 整体跟着挪（离地高度不变）。 */
  shiftRestHeight(host, dRest) {
    if (!Edit.isWorld(host) || !dRest) return;
    for (const seg of Edit.segs(host.doc)) {
      for (const p of ((seg.path && seg.path.points) || [])) p.h = round2(Math.max(0, num(p.h, 0) + dRest));
      if (seg.start && seg.start.h != null) seg.start.h = round2(Math.max(0, num(seg.start.h, 0) + dRest));
    }
  },
  /** 换场景前：把所有段的坐标记成"相对锚点"。返回给 applyRelative 用的数据。 */
  captureRelative(host) {
    const doc = host.doc, world = Edit.isWorld(host);
    for (const seg of Edit.segs(doc)) Edit.normalize(host, seg);
    let base;
    if (world) { const aw = Edit.anchorWorld(host); base = aw && host.cal ? host.cal.worldToXZH(aw[0], aw[1], aw[2]) : null; }
    else base = { x: doc.authoring.anchor.x, y: doc.authoring.anchor.y };
    return { world, base };
  },
  /** 换场景后：按新锚点把 x/z（画面：x/y）加回去（形状与锚点的相对关系不变）。
   *  世界空间的 h 是"锚点离地面的绝对高度"，与场景无关，**故意不动**（restH 只在换实体时变，由 shiftRestHeight 管）。 */
  applyRelative(host, cap) {
    const doc = host.doc, world = Edit.isWorld(host);
    if (!cap || !cap.base || cap.world !== world) return;
    let nb;
    if (world) { const aw = Edit.anchorWorld(host); nb = aw && host.cal ? host.cal.worldToXZH(aw[0], aw[1], aw[2]) : null; }
    else nb = { x: doc.authoring.anchor.x, y: doc.authoring.anchor.y };
    if (!nb) return;
    const d = world ? [nb.x - cap.base.x, nb.z - cap.base.z] : [nb.x - cap.base.x, nb.y - cap.base.y];
    for (const seg of Edit.segs(doc)) {
      const pts = (seg.path && seg.path.points) || [];
      if (world) {
        for (const p of pts) { p.x = round2(num(p.x, 0) + d[0]); p.z = round2(num(p.z, 0) + d[1]); }
        if (seg.start) { seg.start.x = round2(num(seg.start.x, 0) + d[0]); seg.start.z = round2(num(seg.start.z, 0) + d[1]); }
      } else {
        for (const p of pts) { p.x = round2(num(p.x, 0) + d[0]); p.y = round2(num(p.y, 0) + d[1]); }
        if (seg.start) { seg.start.x = round2(num(seg.start.x, 0) + d[0]); seg.start.y = round2(num(seg.start.y, 0) + d[1]); }
        if (typeof seg.groundY === 'number') seg.groundY = round2(seg.groundY + d[1]);
      }
    }
  },
  /** 所有段的有效点包围盒（画面）。scope: 'points'(seg+set) | 'segment'(seg) | 'all' */
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

if (typeof module !== 'undefined' && module.exports) module.exports = { Edit };
