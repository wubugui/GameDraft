/**
 * F2「粒子」页：**只看状态、按刺激**。
 *
 * 效果怎么调在粒子工作台（`tools/vfx_workbench`，`assets/data/vfx/` 的唯一写者）；
 * 实例摆在哪在主编辑器的场景页。这里是预览器那一侧——回答的是三个在游戏里才问得出的问题：
 *
 * 1. **这个场景的粒子跑在真 3D 场上，还是退化成平面近似了？** 平面近似下没有地面高低、
 *    没有墙，所有几何判据都**空成立**（不入地、不进壳全部假过）——这一行是唯一能分清的地方。
 * 2. **群现在是什么状态、恐惧攒到哪了？** 状态机是整群一个，肉眼只看得到"在飞"，
 *    分不出 airborne 与 fleeing。
 * 3. **代价多少？** 只数 / draw call / 模拟毫秒。
 *
 * 刺激按钮是没连工作台时的兜底：在玩家脚下发一个恐惧场，看群散不散。
 */
import type { VfxFieldDef, VfxFlockState } from '../data/types';

export interface DebugVfxDeps {
  getSceneId: () => string | undefined;
  /** 模拟空间：真 3D 场还是平面近似 */
  getSpaceInfo: () => { kind: 'field' | 'planar'; hasShell: boolean; wuPerQ: number } | null;
  getSnapshot: () => {
    id: string; effect: string; state: string; live: number; eligible: boolean;
    /** 限定了粒子区域才有 */
    confine?: {
      feather: number; ceiling: number | null;
      inner: number; band: number; outsideVisible: number; fading: number;
    } | null;
  }[];
  /** 粒子区域叠加层（框线 + 边带内沿）开关；没注入就不显示那个勾 */
  setConfineOverlay?: (on: boolean) => void;
  getConfineOverlay?: () => boolean;
  getStats: () => { instances: number; live: number; drawCalls: number; fields: number; simMs: number; beams?: number };
  /** 在玩家脚下发一个刺激场（走与物品用途同一条通道） */
  emitAtPlayer: (def: VfxFieldDef, heightWu: number) => void;
  /** 强制群状态（调试用；正常由状态机自己转） */
  setState: (instanceId: string, state: VfxFlockState) => void;
  log: (message: string) => void;
  /**
   * 场景风（可不注入）：场景 JSON 写的那份 + 当前调试覆盖。覆盖**不落盘**，
   * 调好了把读数抄回场景 JSON 的 `wind.speed` / `wind.gain`。
   */
  getWind?: () => {
    authored: {
      speed: number; gainVfx: number; gainSway: number; turbIntensity: number;
      waveSize: number; leafSize: number; leafHz: number;
    } | null;
    overrides: WindOverrideKeys;
    time: number;
  };
  setWindOverride?: (o: WindOverrideKeys) => void;
  /** 背景草木摆动的实时开销（没接上 ⇒ null）：与粒子的模拟耗时一起看"整套风"的预算 */
  getSwayStats?: () => { ms: number; verts: number; insts: number } | null;
}

type WindOverrideKeys = {
  speedMul?: number; gainVfx?: number; gainSway?: number; turbMul?: number;
  waveSize?: number; leafSize?: number; leafHz?: number;
};

export interface DebugVfxSectionHandle {
  root: HTMLElement;
  refresh(): void;
  destroy(): void;
}

/** 兜底刺激：与 `items.json` 里虫罐那份同尺度（半径 900 是量出来的，见机制卡） */
const PROBES: ReadonlyArray<{ label: string; def: VfxFieldDef; h: number }> = [
  { label: '放虫（恐惧）', def: { kind: 'fear', tag: 'item:bug', radius: 900, strength: 2.5, duration: 4 }, h: 100 },
  { label: '大声响', def: { kind: 'fear', tag: 'sfx:footstep', radius: 600, strength: 2.0, duration: 0.5 }, h: 60 },
  { label: '引诱', def: { kind: 'attract', tag: 'bait', radius: 700, strength: 1.5, duration: 5 }, h: 80 },
];

const REFRESH_MS = 500;

export function createDebugVfxSection(deps: DebugVfxDeps): DebugVfxSectionHandle {
  const sec = document.createElement('section');
  sec.className = 'debug-dock__section debug-vfx__section';
  let disposed = false;

  const title = document.createElement('h3');
  title.textContent = '粒子 / 群体 · 预览器';
  sec.appendChild(title);

  const hint = document.createElement('div');
  hint.className = 'debug-dock__hint';
  hint.textContent =
    '效果与布置（哪个场景、哪套时段外观、发射区域 / 范围区域）都在粒子工作台里做（sh scripts/py.sh -m tools.vfx_workbench）。'
    + ' 这页只看状态、按刺激。';
  sec.appendChild(hint);

  const spaceLine = document.createElement('div');
  spaceLine.className = 'debug-dock__hint';
  sec.appendChild(spaceLine);

  const statLine = document.createElement('div');
  statLine.className = 'debug-vfx__status';
  sec.appendChild(statLine);

  const list = document.createElement('div');
  list.className = 'debug-dock__hint';
  list.style.whiteSpace = 'pre';
  sec.appendChild(list);

  // ---- 粒子区域叠加层：框线（黄）+ 边带中线（淡黄）+ 边带内沿（白）
  let overlayBox: HTMLInputElement | null = null;
  if (deps.setConfineOverlay) {
    const row = document.createElement('label');
    row.className = 'debug-dock__hint';
    row.style.display = 'flex';
    row.style.gap = '6px';
    row.style.alignItems = 'center';
    overlayBox = document.createElement('input');
    overlayBox.type = 'checkbox';
    overlayBox.checked = deps.getConfineOverlay?.() ?? false;
    overlayBox.addEventListener('change', () => deps.setConfineOverlay?.(overlayBox!.checked));
    const txt = document.createElement('span');
    txt.textContent = '画出粒子区域（黄 = 范围区域框线，白 = 边带内沿：从这往外风变弱、纸变稀；青 = 发射区域）';
    row.append(overlayBox, txt);
    sec.appendChild(row);
  }

  const bar = document.createElement('div');
  bar.className = 'debug-vfx__bar';
  for (const p of PROBES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `▶ ${p.label}`;
    b.title = `在玩家脚下发一个 ${p.def.kind} 场：标签 ${p.def.tag}、半径 ${p.def.radius} wu、强度 ${p.def.strength}`;
    b.addEventListener('click', () => {
      deps.emitAtPlayer(p.def, p.h);
      deps.log(`[vfx] 发了一个 ${p.def.kind} 场：${p.def.tag} r=${p.def.radius} s=${p.def.strength}`);
      render();
    });
    bar.appendChild(b);
  }
  sec.appendChild(bar);

  const stateBar = document.createElement('div');
  stateBar.className = 'debug-vfx__bar';
  sec.appendChild(stateBar);

  // ---- 场景风：一份风、两路增益（粒子 / 背景草木），拖了立刻生效、不落盘
  const windBox = document.createElement('div');
  windBox.className = 'debug-dock__hint';
  const windLine = document.createElement('div');
  windBox.appendChild(windLine);
  const sliders: Array<{
    input: HTMLInputElement; out: HTMLSpanElement;
    key: 'speedMul' | 'gainVfx' | 'gainSway' | 'turbMul' | 'waveSize' | 'leafSize' | 'leafHz';
    digits: number;
  }> = [];
  for (const [key, label, min, max, step, digits] of [
    ['speedMul', '风速倍率', 0, 3, 0.05, 2], ['gainVfx', '粒子增益', 0, 3, 0.05, 2], ['turbMul', '湍流强度', 0, 3, 0.05, 2],
    // 草木增益 > 1 同时按倍数放开位移上限（越界档，会露出底板补带外的内容）——上限与
    // `backgroundSway.SWAY_GAIN_CAP_MAX` 同一个数
    ['gainSway', '草木增益', 0, 4, 0.05, 2],
    // 草木波浪尺寸（wu）：同一株上相距小于它的点一起动。调大 = 大植物整株一起弯
    ['waveSize', '波浪尺寸', 5, 2000, 5, 0],
    ['leafSize', '叶抖大小', 2, 80, 1, 0],
    ['leafHz', '叶抖速度', 0, 8, 0.1, 1],
  ] as const) {
    const row = document.createElement('label');
    row.style.display = 'flex';
    row.style.gap = '6px';
    row.style.alignItems = 'center';
    const name = document.createElement('span');
    name.textContent = label;
    name.style.minWidth = '4.5em';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const out = document.createElement('span');
    input.addEventListener('input', () => {
      deps.setWindOverride?.({ [key]: Number(input.value) });
      out.textContent = Number(input.value).toFixed(digits);
    });
    row.append(name, input, out);
    windBox.appendChild(row);
    sliders.push({ input, out, key, digits });
  }
  const windHint = document.createElement('div');
  windHint.style.opacity = '0.7';
  windHint.textContent = '草木增益 > 1 会放开位移上限（最多 4 倍，会露出底板补带外的内容）；'
    + '湍流强度 = 涡的脉动 / 平均风，调大 = 更多横风、上升气流与原地打圈；'
    + '波浪尺寸（wu）= 同一株上相距多远的点才开始各动各的，调大 = 大植物整株一起弯（单株要整体摆去草木工作台标）';
  windBox.appendChild(windHint);
  const windReset = document.createElement('button');
  windReset.type = 'button';
  windReset.textContent = '风：回到场景 JSON 的值';
  windReset.addEventListener('click', () => {
    deps.setWindOverride?.({
      speedMul: 1, gainVfx: undefined, gainSway: undefined, turbMul: 1,
      waveSize: undefined, leafSize: undefined, leafHz: undefined,
    });
    render();
  });
  windBox.appendChild(windReset);
  if (deps.getWind) sec.appendChild(windBox);

  function renderWind(): void {
    const w = deps.getWind?.();
    if (!w) return;
    const a = w.authored;
    if (!a) {
      windLine.textContent = '场景风：本场景没有 wind（纸钱不动、草木不摆）';
      return;
    }
    const o = w.overrides;
    const cur = {
      speedMul: o.speedMul ?? 1, gainVfx: o.gainVfx ?? a.gainVfx,
      gainSway: o.gainSway ?? a.gainSway, turbMul: o.turbMul ?? 1,
      waveSize: o.waveSize ?? a.waveSize, leafSize: o.leafSize ?? a.leafSize, leafHz: o.leafHz ?? a.leafHz,
    };
    windLine.textContent =
      `场景风：2 m 处 ${(a.speed * cur.speedMul).toFixed(0)} wu/s（≈${(a.speed * cur.speedMul / 88).toFixed(1)} m/s）`
      + `　钟 ${w.time.toFixed(1)} s　→ 抄回 JSON：speed ${(a.speed * cur.speedMul).toFixed(0)}、`
      + `gain {vfx: ${cur.gainVfx.toFixed(2)}, sway: ${cur.gainSway.toFixed(2)}}、`
      + `turbulence.intensity ${(a.turbIntensity * cur.turbMul).toFixed(2)}、`
      + `waveSize ${cur.waveSize.toFixed(0)}、leaf {size: ${cur.leafSize.toFixed(0)}, speed: ${cur.leafHz.toFixed(1)}}`;
    const sw = deps.getSwayStats?.();
    windLine.textContent += sw
      ? `　草木 ${sw.ms.toFixed(2)} ms/帧（${sw.insts} 株 / ${sw.verts} 顶点）`
      : '　草木：本场景没接摆动';
    for (const s of sliders) {
      if (document.activeElement === s.input) continue;
      s.input.value = String(cur[s.key]);
      s.out.textContent = cur[s.key].toFixed(s.digits);
    }
  }

  function render(): void {
    if (disposed) return;
    renderWind();
    const sp = deps.getSpaceInfo();
    if (!sp) {
      spaceLine.textContent = '空间：还没进场景';
    } else if (sp.kind === 'planar') {
      spaceLine.textContent =
        '⚠ 空间：平面近似（这个场景没有照明载荷 / 还没装完）——没有地面高低、没有墙，'
        + '粒子不会被崖壁挡住、也不会落在真地面上';
    } else {
      spaceLine.textContent =
        `空间：真 3D 场　墙${sp.hasShell ? '有' : '无（深度壳没解出来）'}　1 q = ${sp.wuPerQ.toFixed(1)} wu`;
    }
    const s = deps.getStats();
    statLine.textContent =
      `实例 ${s.instances}　活粒子 ${s.live}　光柱 ${s.beams ?? 0}　draw call ${s.drawCalls}　刺激场 ${s.fields}　模拟 ${s.simMs.toFixed(2)} ms/帧`;
    const rows = deps.getSnapshot();
    list.textContent = rows.length
      ? rows.map((r) => {
        const gate = r.eligible ? '' : '　（条件 / 时段不满足，不在场）';
        const c = r.confine;
        const region = c
          ? `\n      粒子区域 边带 ${c.feather.toFixed(0)}${c.ceiling !== null ? `、限高 ${c.ceiling.toFixed(0)}` : ''}`
            + `：深处 ${c.inner}　边带 ${c.band}　淡出中 ${c.fading}　框外还看得见 ${c.outsideVisible}`
          : '';
        return `  ${r.id}　「${r.effect}」　${r.state}　${r.live} 只${gate}${region}`;
      }).join('\n')
      : '  （本场景没有摆效果实例）';
    if (overlayBox && document.activeElement !== overlayBox) overlayBox.checked = deps.getConfineOverlay?.() ?? false;

    // 群状态快捷键：只给真有群的实例
    stateBar.replaceChildren();
    for (const r of rows) {
      if (!['roosting', 'airborne', 'fleeing', 'returning'].includes(r.state)) continue;
      for (const st of ['roosting', 'airborne', 'fleeing', 'returning'] as VfxFlockState[]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = st === r.state ? `●${st}` : st;
        b.title = `把「${r.id}」强制成 ${st}`;
        b.addEventListener('click', () => { deps.setState(r.id, st); render(); });
        stateBar.appendChild(b);
      }
      break;   // 一组就够（多群时用工作台）
    }
  }

  const timer = window.setInterval(render, REFRESH_MS);
  render();

  return {
    root: sec,
    refresh: render,
    destroy() {
      disposed = true;
      window.clearInterval(timer);
      sec.remove();
    },
  };
}
