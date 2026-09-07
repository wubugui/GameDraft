/**
 * F2「声学」页：**在场景里就地摆崖壁，按一下就听到回音**。
 *
 * 为什么要有这一页：声学空间是作者数据，靠耳朵调，一轮要改几十次。
 * 之前只能在控制台敲 `applyAcousticSpaceDef`，那不是给人用的东西。
 *
 * 分工（与主编辑器）：
 * - **本页管空间库**（摆崖壁、调吸收、试听、存盘）——这是靠耳朵的活，必须在游戏里做。
 * - **场景绑哪个空间在主编辑器的场景属性里选**——那是场景数据，归它管，
 *   而且那边有引用选择器（编辑器规范：引用字段不许用裸输入框）。
 *
 * 坐标：平面 `(x, z)`，**单位米**，听者在原点，俯视图 z 向上（越远越靠上）。
 * 与视觉几何**解耦**——`worldWidth` 是可行走范围不是画里的世界。
 */

import type { AcousticReflector, AcousticSpaceDef, AcousticTap } from '../audio/acousticSpace';

export interface DebugAcousticDeps {
  getCurrentSceneId: () => string | undefined;
  getSpaceId: () => string | null;
  getSpaceDef: (id: string) => AcousticSpaceDef | null;
  listSpaceIds: () => string[];
  /** 应用到运行时（立刻重算 IR） */
  applyDef: (id: string, def: AcousticSpaceDef) => void;
  setSpace: (id: string | null) => void;
  getTaps: () => AcousticTap[];
  /** 播一条试听音（走 playSfx；标了 spatial 的会进空间通道） */
  playProbe: (sfxId: string) => void;
  /** 运行时听者（声学米制）——绑了实体/相机时它会随玩家走动 */
  getRuntimeListener?: () => { x: number; z: number; y?: number } | null;
  /** 当前场景把听者绑给了谁（只读显示） */
  getListenerBinding?: () => { mode: string; entityId?: string } | null | undefined;
  /** 性能读数：重算一次 IR 的耗时与当前移动阈值 */
  getPerf?: () => { costMs: number; thresholdM: number } | null;
  log: (message: string) => void;
}

export interface DebugAcousticSectionHandle {
  root: HTMLElement;
  refresh(): void;
  destroy(): void;
}

const API = '/__gamedraft-api/acoustic-spaces';

/** 试听音：必须是**干声**，自带回音的素材会叠两层。 */
const PROBES: Array<{ id: string; label: string; seconds: number }> = [
  { id: 'sfx_pebble_scatter_dry', label: '碎石 0.8s', seconds: 0.79 },
  { id: 'sfx_gibbon_dry_a', label: '猿啼 3.0s', seconds: 3.0 },
  { id: 'sfx_jump_takeoff_dry', label: '起跳 1.3s', seconds: 1.34 },
  { id: 'sfx_land_scree_dry', label: '落地 6.0s', seconds: 6.0 },
];

const VIEW = 320;
const C_SOUND = 334;
const UNDO_MAX = 40;

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

function blankSpace(): AcousticSpaceDef {
  return {
    label: '新空间',
    listener: { x: 0, z: 0 },
    reflectors: [
      { id: '面1', a: [-80, 120], b: [80, 130], height: 40, absorb: 0.08, rough: 0.4 },
    ],
    order: 2,
    tail: { seconds: 2, gain: 0.12 },
    air: { tempC: 5 },
    width: 0.8,
    occlusion: true,
  };
}

export function createDebugAcousticSection(
  deps: DebugAcousticDeps,
): DebugAcousticSectionHandle {
  const sec = document.createElement('section');
  sec.className = 'debug-dock__section debug-acoustic__section';

  /** 本页持有的整份库；存盘写的就是它。 */
  let lib: Record<string, AcousticSpaceDef> = {};
  let comment = '';
  let spaceId: string | null = null;
  let range = 500;
  let dragging:
    | { kind: 'reflector'; ri: number; end: 'a' | 'b' | 'mid'; ox: number; oz: number }
    | { kind: 'listener' }
    | null = null;
  let selected = 0;
  let dirty = false;
  let disposed = false;
  const undo: Array<{ id: string; def: AcousticSpaceDef }> = [];

  const def = (): AcousticSpaceDef | null => (spaceId ? lib[spaceId] ?? null : null);

  function pushUndo(): void {
    const d = def();
    if (!spaceId || !d) return;
    undo.push({ id: spaceId, def: clone(d) });
    if (undo.length > UNDO_MAX) undo.shift();
    undoBtn.disabled = false;
  }

  // ---- 头部 -------------------------------------------------------------
  const title = document.createElement('h3');
  title.textContent = '声学 · 就地摆崖壁';
  sec.appendChild(title);

  const hint = document.createElement('div');
  hint.className = 'debug-dock__hint';
  hint.textContent =
    '俯视图：蓝点是你（听者），线段是崖壁。拖端点改朝向，拖中点整体挪远近，点线段选中它。'
    + ' 改完直接按试听键——IR 现算，不用重启。场景绑哪个空间去主编辑器的场景属性里选。';
  sec.appendChild(hint);

  const bar1 = document.createElement('div');
  bar1.className = 'debug-acoustic__bar';
  const picker = document.createElement('select');
  picker.title = '切换声学空间（同时换给运行时）';
  picker.addEventListener('change', () => {
    spaceId = picker.value || null;
    deps.setSpace(spaceId);
    selected = 0;
    fitRange();
    renderAll();
  });
  bar1.appendChild(picker);

  const mkBtn = (label: string, title2: string, fn: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title2;
    b.addEventListener('click', fn);
    return b;
  };

  bar1.appendChild(mkBtn('＋空间', '新建一个声学空间', () => {
    const name = prompt('新空间的名字（会成为 acoustic_spaces.json 的键）', '新空间');
    if (!name) return;
    const key = name.trim();
    if (!key) return;
    if (lib[key]) { deps.log(`[声学] "${key}" 已存在`); return; }
    lib[key] = blankSpace();
    spaceId = key;
    deps.setSpace(null);
    deps.applyDef(key, lib[key]);
    dirty = true; selected = 0; fitRange(); renderAll();
  }));

  bar1.appendChild(mkBtn('删空间', '删除当前空间', () => {
    if (!spaceId) return;
    if (!confirm(`删除声学空间「${spaceId}」？引用它的场景会变成没有回音。`)) return;
    delete lib[spaceId];
    spaceId = Object.keys(lib)[0] ?? null;
    deps.setSpace(spaceId);
    dirty = true; selected = 0; fitRange(); renderAll();
  }));

  const undoBtn = mkBtn('↶ 撤销', '撤销上一步（最多 40 步）', () => {
    const last = undo.pop();
    if (!last) return;
    lib[last.id] = last.def;
    spaceId = last.id;
    apply();
    renderAll();
    undoBtn.disabled = undo.length === 0;
  });
  undoBtn.disabled = true;
  bar1.appendChild(undoBtn);

  const saveBtn = mkBtn('保存', '写回 acoustic_spaces.json（自动备份 .bak）', () => { void save(); });
  bar1.appendChild(saveBtn);
  sec.appendChild(bar1);

  const status = document.createElement('div');
  status.className = 'debug-acoustic__status';
  sec.appendChild(status);

  // ---- 俯视图 -----------------------------------------------------------
  const canvas = document.createElement('canvas');
  canvas.width = VIEW;
  canvas.height = VIEW;
  canvas.className = 'debug-acoustic__map';
  sec.appendChild(canvas);

  const bar2 = document.createElement('div');
  bar2.className = 'debug-acoustic__bar';
  const zoomLabel = document.createElement('span');
  zoomLabel.style.fontSize = '11px';
  const zoom = document.createElement('input');
  zoom.type = 'range';
  zoom.min = '50'; zoom.max = '1500'; zoom.step = '10';
  zoom.style.flex = '1';
  zoom.addEventListener('input', () => { range = Number(zoom.value); draw(); });
  bar2.append(zoomLabel, zoom);
  bar2.appendChild(mkBtn('＋崖壁', '在当前视野外缘加一面新崖壁', () => {
    const d = def();
    if (!d) return;
    pushUndo();
    const z = range * 0.6;
    const w = range * 0.35;
    d.reflectors.push({
      id: `面${d.reflectors.length + 1}`,
      a: [-w, z], b: [w, z * 1.05], height: 60, absorb: 0.08, rough: 0.4,
    });
    selected = d.reflectors.length - 1;
    dirty = true; apply(); renderAll();
  }));
  bar2.appendChild(mkBtn('删崖壁', '删掉当前选中的那一面', () => {
    const d = def();
    if (!d || !d.reflectors.length) return;
    pushUndo();
    d.reflectors.splice(selected, 1);
    selected = Math.max(0, Math.min(selected, d.reflectors.length - 1));
    dirty = true; apply(); renderAll();
  }));
  sec.appendChild(bar2);

  // ---- 试听 -------------------------------------------------------------
  const probeRow = document.createElement('div');
  probeRow.className = 'debug-acoustic__bar';
  const probeTip = document.createElement('div');
  probeTip.className = 'debug-dock__hint';
  for (const p of PROBES) {
    probeRow.appendChild(mkBtn(`▶ ${p.label}`, `试听 ${p.id}`, () => {
      deps.playProbe(p.id);
      const taps = deps.getTaps();
      const gap = taps.length ? taps[0].delay : null;
      probeTip.textContent = gap === null
        ? '（这个空间没有反射面，只会听到干声）'
        : gap > p.seconds
          ? `首回 ${gap.toFixed(2)}s > 干声 ${p.seconds}s：听得到「原声—空白—回音」三段`
          : `首回 ${gap.toFixed(2)}s ≤ 干声 ${p.seconds}s：回音压在原声上；想要空白就把崖壁拖远`;
    }));
  }
  sec.appendChild(probeRow);
  sec.appendChild(probeTip);

  // ---- 参数 -------------------------------------------------------------
  const list = document.createElement('div');
  list.className = 'debug-acoustic__list';
  sec.appendChild(list);

  const tapBox = document.createElement('div');
  tapBox.className = 'debug-dock__hint';
  tapBox.style.whiteSpace = 'pre';
  sec.appendChild(tapBox);

  // ---- 逻辑 -------------------------------------------------------------
  function toPx(x: number, z: number): [number, number] {
    const s = VIEW / (2 * range);
    return [VIEW / 2 + x * s, VIEW / 2 - z * s];
  }
  function toWorld(px: number, py: number): [number, number] {
    const s = VIEW / (2 * range);
    return [(px - VIEW / 2) / s, (VIEW / 2 - py) / s];
  }

  function fitRange(): void {
    const d = def();
    if (!d?.reflectors.length) { range = 500; zoom.value = '500'; return; }
    const far = Math.max(...d.reflectors.flatMap((r) =>
      [Math.hypot(r.a[0], r.a[1]), Math.hypot(r.b[0], r.b[1])]));
    range = Math.max(50, Math.min(1500, Math.ceil((far * 1.3) / 50) * 50));
    zoom.value = String(range);
  }

  function draw(): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#14120e';
    ctx.fillRect(0, 0, VIEW, VIEW);

    ctx.strokeStyle = '#2a251d';
    ctx.fillStyle = '#5a5245';
    ctx.font = '9px monospace';
    const step = range > 700 ? 200 : 100;
    for (let dm = step; dm <= range; dm += step) {
      const r = (dm / range) * (VIEW / 2);
      ctx.beginPath(); ctx.arc(VIEW / 2, VIEW / 2, r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillText(`${dm}m·${(2 * dm / C_SOUND).toFixed(1)}s`, VIEW / 2 + 3, VIEW / 2 - r + 10);
    }

    const d = def();
    d?.reflectors.forEach((r, i) => {
      const [ax, ay] = toPx(r.a[0], r.a[1]);
      const [bx, by] = toPx(r.b[0], r.b[1]);
      ctx.lineWidth = Math.max(2, Math.min(10, r.height / 20));
      const light = Math.round(200 * (1 - r.absorb) + 40);
      ctx.strokeStyle = i === selected
        ? '#7fd8ff'
        : `rgb(${light},${Math.round(light * 0.82)},${Math.round(light * 0.45)})`;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.fillStyle = i === selected ? '#7fd8ff' : '#d9a05b';
      for (const [hx, hy] of [[ax, ay], [bx, by], [(ax + bx) / 2, (ay + by) / 2]]) {
        ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#8d8172';
      ctx.fillText(r.id ?? `#${i}`, (ax + bx) / 2 + 6, (ay + by) / 2 - 6);
    });

    // 作者摆的听者（可拖）
    if (d) {
      const [lx, ly] = toPx(d.listener.x, d.listener.z);
      ctx.fillStyle = '#7fd8ff';
      ctx.beginPath(); ctx.arc(lx, ly, 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#14120e'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    // 运行时听者（跟着玩家/相机走，不可拖）——两个点分开画，
    // 不然「我拖的那个」和「实际在听的那个」混为一谈
    const rt = deps.getRuntimeListener?.();
    if (rt && d && (Math.abs(rt.x - d.listener.x) > 0.5 || Math.abs(rt.z - d.listener.z) > 0.5)) {
      const [rx, ry] = toPx(rt.x, rt.z);
      ctx.strokeStyle = '#9be27f'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(rx, ry, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(rx - 3, ry); ctx.lineTo(rx + 3, ry);
      ctx.moveTo(rx, ry - 3); ctx.lineTo(rx, ry + 3); ctx.stroke();
    }
    zoomLabel.textContent = `半幅 ${range}m`;
  }

  function hitTest(px: number, py: number): typeof dragging {
    const d = def();
    if (!d) return null;
    const [lx, ly] = toPx(d.listener.x, d.listener.z);
    if (Math.hypot(px - lx, py - ly) <= 10) return { kind: 'listener' };
    for (let i = 0; i < d.reflectors.length; i++) {
      const r = d.reflectors[i];
      const [ax, ay] = toPx(r.a[0], r.a[1]);
      const [bx, by] = toPx(r.b[0], r.b[1]);
      const cands: Array<['a' | 'b' | 'mid', number, number]> = [
        ['a', ax, ay], ['b', bx, by], ['mid', (ax + bx) / 2, (ay + by) / 2],
      ];
      for (const [end, hx, hy] of cands) {
        if (Math.hypot(px - hx, py - hy) <= 10) {
          const [wx, wz] = toWorld(px, py);
          selected = i;
          return { kind: 'reflector', ri: i, end, ox: wx, oz: wz };
        }
      }
    }
    return null;
  }

  function apply(): void {
    const d = def();
    if (!d || !spaceId) { deps.setSpace(null); renderStatus(); draw(); return; }
    deps.applyDef(spaceId, d);
    renderStatus();
    draw();
  }

  canvas.addEventListener('pointerdown', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * VIEW;
    const py = ((ev.clientY - rect.top) / rect.height) * VIEW;
    const hit = hitTest(px, py);
    if (hit) {
      pushUndo();
      dragging = hit;
      dirty = true;
      canvas.setPointerCapture(ev.pointerId);
      renderList();
      draw();
    }
  });
  canvas.addEventListener('pointermove', (ev) => {
    const d = def();
    if (!dragging || !d) return;
    const rect = canvas.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * VIEW;
    const py = ((ev.clientY - rect.top) / rect.height) * VIEW;
    const [wx, wz] = toWorld(px, py);
    if (dragging.kind === 'listener') {
      d.listener = { ...d.listener, x: wx, z: wz };
      apply();
      return;
    }
    const r = d.reflectors[dragging.ri];
    if (dragging.end === 'mid') {
      const dx = wx - dragging.ox, dz = wz - dragging.oz;
      r.a = [r.a[0] + dx, r.a[1] + dz];
      r.b = [r.b[0] + dx, r.b[1] + dz];
      dragging.ox = wx; dragging.oz = wz;
    } else {
      r[dragging.end] = [wx, wz];
    }
    apply();
  });
  const endDrag = () => { if (dragging) { dragging = null; renderList(); } };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  function slider(
    label: string, min: number, max: number, step: number, value: number,
    onInput: (v: number) => void, onStart?: () => void,
  ): HTMLElement {
    const row = document.createElement('label');
    row.className = 'debug-acoustic__slider';
    const t = document.createElement('span');
    t.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = String(min); inp.max = String(max); inp.step = String(step);
    inp.value = String(value);
    const out = document.createElement('span');
    out.className = 'debug-acoustic__num';
    out.textContent = step >= 1 ? String(value) : value.toFixed(2);
    inp.addEventListener('pointerdown', () => onStart?.());
    inp.addEventListener('input', () => {
      const v = Number(inp.value);
      out.textContent = step >= 1 ? String(v) : v.toFixed(2);
      onInput(v);
    });
    row.append(t, inp, out);
    return row;
  }

  function renderList(): void {
    list.replaceChildren();
    const d = def();
    if (!d) {
      const e = document.createElement('div');
      e.className = 'debug-dock__hint';
      e.textContent = '（没有选中任何空间。用「＋空间」新建一个。）';
      list.appendChild(e);
      return;
    }
    d.reflectors.forEach((r, i) => {
      const card = document.createElement('div');
      card.className = 'debug-acoustic__card';
      if (i === selected) card.classList.add('is-selected');
      card.addEventListener('click', () => { selected = i; renderList(); draw(); });

      const head = document.createElement('div');
      head.className = 'debug-acoustic__cardhead';
      const name = document.createElement('input');
      name.type = 'text';
      name.value = r.id ?? `面${i + 1}`;
      name.title = '这一面的名字（只用于识别）';
      name.addEventListener('change', () => {
        pushUndo(); r.id = name.value.trim() || `面${i + 1}`; dirty = true; apply(); renderList();
      });
      const dist = Math.hypot((r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2);
      const meta = document.createElement('span');
      meta.textContent = `${dist.toFixed(0)}m · 回音 ${(2 * dist / C_SOUND).toFixed(2)}s`;
      head.append(name, meta);
      card.appendChild(head);

      const horiz = (r.tiltDeg ?? 0) >= 45;
      // 竖直崖壁 / 水平面（脚下的水面、头顶的岩檐）——两者的反射几何完全不同
      const kindRow = document.createElement('label');
      kindRow.className = 'debug-acoustic__slider';
      const kindTxt = document.createElement('span');
      kindTxt.textContent = '朝向';
      const kindSel = document.createElement('select');
      for (const [v, t] of [['0', '竖直崖壁'], ['90', '水平面（水/檐）']]) {
        const o = document.createElement('option');
        o.value = v; o.textContent = t; kindSel.appendChild(o);
      }
      kindSel.value = horiz ? '90' : '0';
      kindSel.style.flex = '1';
      kindSel.addEventListener('change', () => {
        pushUndo(); r.tiltDeg = Number(kindSel.value); dirty = true; apply(); renderList();
      });
      kindRow.append(kindTxt, kindSel);
      card.appendChild(kindRow);

      card.appendChild(slider(horiz ? '面高程' : '底高程', -200, 300, 5, r.y ?? 0,
        (v) => { r.y = v; dirty = true; apply(); }, pushUndo));
      card.appendChild(slider('高 m', 5, 300, 5, r.height,
        (v) => { r.height = v; dirty = true; apply(); }, pushUndo));
      card.appendChild(slider('吸收', 0, 1, 0.01, r.absorb,
        (v) => { r.absorb = v; dirty = true; apply(); }, pushUndo));
      card.appendChild(slider('粗糙', 0, 1, 0.01, r.rough,
        (v) => { r.rough = v; dirty = true; apply(); }, pushUndo));
      list.appendChild(card);
    });

    const g = document.createElement('div');
    g.className = 'debug-acoustic__card';
    const gh = document.createElement('div');
    gh.className = 'debug-acoustic__cardhead';
    gh.textContent = '整体';
    g.appendChild(gh);
    if (!d.tail) d.tail = { seconds: 0, gain: 0 };
    g.appendChild(slider('尾长 s', 0, 8, 0.1, d.tail.seconds,
      (v) => { d.tail!.seconds = v; dirty = true; apply(); }, pushUndo));
    g.appendChild(slider('尾强', 0, 0.6, 0.01, d.tail.gain,
      (v) => { d.tail!.gain = v; dirty = true; apply(); }, pushUndo));
    g.appendChild(slider('立体宽', 0, 1, 0.05, d.width ?? 0.8,
      (v) => { d.width = v; dirty = true; apply(); }, pushUndo));
    g.appendChild(slider('反射阶', 1, 2, 1, d.order ?? 2,
      (v) => { d.order = (v >= 2 ? 2 : 1); dirty = true; apply(); }, pushUndo));
    g.appendChild(slider('耳高 m', 0, 60, 0.5, d.listener.y ?? 1.6,
      (v) => { d.listener = { ...d.listener, y: v }; dirty = true; apply(); }, pushUndo));

    const occRow = document.createElement('label');
    occRow.className = 'debug-acoustic__slider';
    const occTxt = document.createElement('span');
    occTxt.textContent = '遮挡';
    const occChk = document.createElement('input');
    occChk.type = 'checkbox';
    occChk.checked = d.occlusion !== false;
    occChk.title = '被别的面挡住的反射会被压下去（二维射线判定）';
    occChk.addEventListener('change', () => {
      pushUndo(); d.occlusion = occChk.checked; dirty = true; apply(); renderList();
    });
    const occHint = document.createElement('span');
    occHint.className = 'debug-acoustic__num';
    occHint.textContent = occChk.checked ? '开' : '关';
    occChk.addEventListener('change', () => { occHint.textContent = occChk.checked ? '开' : '关'; });
    occRow.append(occTxt, occChk, occHint);
    g.appendChild(occRow);
    list.appendChild(g);
  }

  function renderStatus(): void {
    const taps = deps.getTaps();
    const scene = deps.getCurrentSceneId() ?? '?';
    const bound = deps.getSpaceId();
    const parts = [`场景 ${scene}`];
    parts.push(bound ? `运行时挂着「${bound}」` : '运行时无空间');
    const bind = deps.getListenerBinding?.();
    const mode = bind?.mode ?? 'player';
    parts.push(`听者跟${
      mode === 'camera' ? '相机' : mode === 'entity' ? (bind?.entityId || '实体')
      : mode === 'fixed' ? '固定点' : '玩家'}`);
    parts.push(`抽头 ${taps.length}`);
    const occN = taps.filter((t) => t.occluded).length;
    if (occN) parts.push(`被挡 ${occN}`);
    const perf = deps.getPerf?.();
    if (perf) {
      // 重算耗时是作者能改的（把最远的面拉近、尾巴调短），所以摆出来
      parts.push(`重算 ${perf.costMs.toFixed(0)}ms${perf.costMs > 25 ? ' ⚠' : ''}`);
      parts.push(`挪 ${perf.thresholdM.toFixed(0)}m 才重算`);
    }
    if (dirty) parts.push('● 未保存');
    status.textContent = parts.join(' · ');
    saveBtn.textContent = dirty ? '保存 ●' : '保存';

    if (!taps.length) { tapBox.textContent = '（没有反射面，试听只会听到干声）'; return; }
    const rows = taps.slice(0, 6).map((t) =>
      `${t.length.toFixed(0).padStart(5)}m  ${t.delay.toFixed(3)}s  `
      + `${((t.azimuth * 180) / Math.PI).toFixed(0).padStart(4)}°  ${t.gain.toFixed(4)}`);
    tapBox.textContent = `  距离    延迟     方位   增益\n${rows.join('\n')}`
      + (taps.length > 6 ? `\n… 共 ${taps.length} 个` : '');
  }

  function renderPicker(): void {
    picker.replaceChildren();
    const none = document.createElement('option');
    none.value = ''; none.textContent = '（无空间）';
    picker.appendChild(none);
    for (const id of Object.keys(lib)) {
      const o = document.createElement('option');
      o.value = id; o.textContent = id;
      picker.appendChild(o);
    }
    picker.value = spaceId ?? '';
  }

  function renderAll(): void {
    renderPicker(); renderStatus(); renderList(); draw();
  }

  async function save(): Promise<void> {
    saveBtn.disabled = true;
    try {
      const body = JSON.stringify({
        _comment: comment
          || '声学空间库。单位一律米。与视觉几何解耦——worldWidth 是可行走范围，不是画里的世界。场景用 acousticSpace 字段引用这里的 key。',
        spaces: lib,
      });
      const r = await fetch(API, { method: 'POST', body });
      if (!r.ok) { deps.log(`[声学] 保存失败：${r.status} ${await r.text()}`); return; }
      dirty = false;
      renderStatus();
      deps.log(`[声学] 已写回 acoustic_spaces.json（${Object.keys(lib).length} 个空间，旧版存为 .bak）`);
    } catch (err) {
      deps.log(`[声学] 保存失败（开发服没起？）：${String(err)}`);
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function load(): Promise<void> {
    // 优先从磁盘拉整份（这样新建/删除的空间也在库里），拉不到就退回运行时那份
    try {
      const r = await fetch(API);
      if (r.ok) {
        const doc = await r.json() as { spaces?: Record<string, AcousticSpaceDef>; _comment?: string };
        lib = clone(doc.spaces ?? {});
        comment = typeof doc._comment === 'string' ? doc._comment : '';
      } else throw new Error(String(r.status));
    } catch {
      lib = {};
      for (const id of deps.listSpaceIds()) {
        const d = deps.getSpaceDef(id);
        if (d) lib[id] = clone(d);
      }
    }
    if (disposed) return;
    spaceId = deps.getSpaceId() ?? Object.keys(lib)[0] ?? null;
    selected = 0;
    dirty = false;
    fitRange();
    renderAll();
  }

  void load();

  return {
    root: sec,
    refresh: () => {
      if (disposed) return;
      // 有未保存改动时不要拉盘上那份盖掉手上的活
      if (dirty) { renderStatus(); return; }
      void load();
    },
    destroy: () => {
      disposed = true;
      sec.replaceChildren();
      sec.remove();
    },
  };
}

export type { AcousticReflector };
