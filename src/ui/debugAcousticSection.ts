/**
 * F2「声学」页：**只看状态、只按试听**。
 *
 * 编辑与保存在声学工作台（`tools/acoustic_workbench`）——那边把场景在世界空间展开成 3D，
 * 反射面直接贴着画里的崖壁摆；游戏这一侧是**预览器**：工作台每动一下，这里下一拍就
 * 重算 IR（见 `src/dev/runtimeAcousticsSync.ts`）。
 *
 * 原来这页上的俯视小画布、参数滑条、存盘按钮 2026-09-08 一并撤了：两个作者面必然漂，
 * 而且在游戏里根本看不出"这几条线对着画里哪座崖"。
 *
 * 试听为什么留在这里：游戏才是放声音的那一端，工作台按试听键也是经通道让这里播。
 * 这四个按钮是没连工作台时的兜底。
 */

import type { AcousticSpaceDef, AcousticTap } from '../audio/acousticSpace';
import { metersPerWu } from '../audio/acousticSpace';
import type { AudioListenerSnapshot } from '../utils/audioSpace';

export interface DebugAcousticDeps {
  getCurrentSceneId: () => string | undefined;
  /** 总线上实际挂着的空间（可能是工作台推来的工作态，不一定是场景绑定） */
  getSpaceId: () => string | null;
  /** 场景 JSON 绑定的空间 */
  getBoundSpaceId?: () => string | null;
  getSpaceDef: (id: string) => AcousticSpaceDef | null;
  getTaps: () => AcousticTap[];
  /** 播一条试听音（走 playSfx；标了 spatial 的会进空间通道） */
  playProbe: (sfxId: string) => void;
  /** 运行时听者：地面点 + 耳点（wu）+ 绑定来源 + 是否真落在行走面上 */
  getRuntimeListener?: () => AudioListenerSnapshot | null;
  /** 最近几秒主输出峰值（dBFS）：试听按下去有没有真出声 */
  getOutputPeakDb?: () => number;
  /** 性能读数：重算一次 IR 的耗时与当前移动阈值 */
  getPerf?: () => { costMs: number; thresholdM: number } | null;
  /** 与工作台的联动状态行 */
  getSyncStatus?: () => string;
  /** 空间欠着没挂上（音频没解锁，总线建不出来） */
  hasPendingSpace?: () => boolean;
  log: (message: string) => void;
}

export interface DebugAcousticSectionHandle {
  root: HTMLElement;
  refresh(): void;
  destroy(): void;
}

/** 试听音：必须是**干声**，自带回音的素材会叠两层。与工作台 `/api/probes` 同一批。 */
export const ACOUSTIC_PROBES: ReadonlyArray<{ id: string; label: string; seconds: number }> = [
  { id: 'sfx_pebble_scatter_dry', label: '碎石 0.8s', seconds: 0.79 },
  { id: 'sfx_gibbon_dry_a', label: '猿啼 3.0s', seconds: 3.0 },
  { id: 'sfx_jump_takeoff_dry', label: '起跳 1.3s', seconds: 1.34 },
  { id: 'sfx_land_scree_dry', label: '落地 6.0s', seconds: 6.0 },
];

const REFRESH_MS = 1000;

export function createDebugAcousticSection(
  deps: DebugAcousticDeps,
): DebugAcousticSectionHandle {
  const sec = document.createElement('section');
  sec.className = 'debug-dock__section debug-acoustic__section';
  let disposed = false;

  const title = document.createElement('h3');
  title.textContent = '声学 · 预览器';
  sec.appendChild(title);

  const hint = document.createElement('div');
  hint.className = 'debug-dock__hint';
  hint.textContent =
    '回音几何在声学工作台里摆（sh scripts/py.sh -m tools.acoustic_workbench），那边改一下这里下一拍就重算。'
    + ' 这页只看状态、按试听。场景绑哪个空间去主编辑器的场景属性里选。';
  sec.appendChild(hint);

  const status = document.createElement('div');
  status.className = 'debug-acoustic__status';
  sec.appendChild(status);

  const listenerLine = document.createElement('div');
  listenerLine.className = 'debug-dock__hint';
  sec.appendChild(listenerLine);

  const syncLine = document.createElement('div');
  syncLine.className = 'debug-dock__hint';
  sec.appendChild(syncLine);

  const probeRow = document.createElement('div');
  probeRow.className = 'debug-acoustic__bar';
  const probeTip = document.createElement('div');
  probeTip.className = 'debug-dock__hint';
  for (const p of ACOUSTIC_PROBES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `▶ ${p.label}`;
    b.title = `试听 ${p.id}`;
    b.addEventListener('click', () => {
      deps.playProbe(p.id);
      const taps = deps.getTaps();
      const gap = taps.length ? taps[0].delay : null;
      probeTip.textContent = gap === null
        ? '（这个空间没有反射面，只会听到干声）'
        : gap > p.seconds
          ? `首回 ${gap.toFixed(2)}s > 干声 ${p.seconds}s：听得到「原声—空白—回音」三段`
          : `首回 ${gap.toFixed(2)}s ≤ 干声 ${p.seconds}s：回音压在原声上；想要空白就在工作台把崖壁拖远或加大距离缩放`;
    });
    probeRow.appendChild(b);
  }
  sec.appendChild(probeRow);
  sec.appendChild(probeTip);
  const outLine = document.createElement('div');
  outLine.className = 'debug-dock__hint';
  sec.appendChild(outLine);

  const tapBox = document.createElement('div');
  tapBox.className = 'debug-dock__hint';
  tapBox.style.whiteSpace = 'pre';
  sec.appendChild(tapBox);

  function render(): void {
    if (disposed) return;
    const taps = deps.getTaps();
    const scene = deps.getCurrentSceneId() ?? '?';
    const active = deps.getSpaceId();
    const bound = deps.getBoundSpaceId?.() ?? null;
    const parts = [`场景 ${scene}`];
    if (active) {
      parts.push(bound === active || !bound
        ? `挂着「${active}」`
        : `挂着「${active}」（场景绑定是「${bound}」，正在预览工作台那份）`);
    } else if (deps.hasPendingSpace?.()) {
      parts.push(`欠着「${bound ?? '工作台那份'}」没挂上：音频未解锁，点一下画面`);
    } else {
      parts.push(bound ? `绑定「${bound}」但库里没有它` : '无空间');
    }
    const def = active ? deps.getSpaceDef(active) : null;
    if (def) parts.push(`距离缩放 ×${(def.distanceScale ?? 1).toString()}`);
    parts.push(`抽头 ${taps.length}`);
    const occN = taps.filter((t) => t.occluded).length;
    if (occN) parts.push(`被挡 ${occN}`);
    const perf = deps.getPerf?.();
    if (perf) {
      parts.push(`重算 ${perf.costMs.toFixed(0)}ms${perf.costMs > 25 ? ' ⚠' : ''}`);
      parts.push(`挪 ${perf.thresholdM.toFixed(0)}m 才重算`);
    }
    status.textContent = parts.join(' · ');

    const rt = deps.getRuntimeListener?.();
    const mode = rt?.mode ?? 'player';
    const who = mode === 'camera' ? '相机' : mode === 'entity' ? (rt?.entityId || '实体')
      : mode === 'fixed' ? '固定点' : '玩家';
    const fromTxt = { runtime: '运行时覆盖', scene: '场景 JSON', space: '声学空间', footstep: '脚步配置', default: '缺省' }[rt?.from ?? 'default'];
    if (rt) {
      const k = def ? metersPerWu(def) : 1 / 88;
      listenerLine.textContent = `听者跟${who}（绑定来自${fromTxt}${rt.targetMissing ? '，实体不在场已回落玩家' : ''}）：`
        + `耳 (${(rt.ear[0] * k).toFixed(1)}, ${(rt.ear[1] * k).toFixed(1)}, ${(rt.ear[2] * k).toFixed(1)}) m`
        + `　地面 (${rt.world[0].toFixed(0)}, ${rt.world[1].toFixed(0)}, ${rt.world[2].toFixed(0)}) wu`
        + (rt.backWu ? `　相机后退 ${rt.backWu.toFixed(0)} wu` : '')
        + (rt.grounded ? '' : '　⚠ 没有行走面场，用的是平面映射');
    } else {
      listenerLine.textContent = `听者跟${who}`;
    }
    const pk = deps.getOutputPeakDb?.();
    if (typeof pk === 'number') {
      outLine.textContent = Number.isFinite(pk)
        ? `主输出（最近 3 秒峰值）${pk.toFixed(1)} dBFS —— 这才是"真出声了"的证据`
        : '主输出（最近 3 秒）：静默';
    }
    syncLine.textContent = deps.getSyncStatus?.() ?? '';

    if (!taps.length) { tapBox.textContent = '（没有反射面，试听只会听到干声）'; return; }
    const rows = taps.slice(0, 6).map((t) =>
      `${t.length.toFixed(0).padStart(5)}m  ${t.delay.toFixed(3)}s  `
      + `${((t.azimuth * 180) / Math.PI).toFixed(0).padStart(4)}°  ${t.gain.toFixed(4)}  ${t.reflectorIds.join('→')}`);
    tapBox.textContent = `  距离    延迟     方位   增益   反射面\n${rows.join('\n')}`
      + (taps.length > 6 ? `\n… 共 ${taps.length} 个` : '');
  }

  render();
  // 联动状态与听者位置是活的：页开着就每秒刷一次（不在 DOM 里时不做事）
  const timer = setInterval(() => { if (sec.isConnected) render(); }, REFRESH_MS);

  return {
    root: sec,
    refresh: render,
    destroy: () => {
      disposed = true;
      clearInterval(timer);
      sec.replaceChildren();
      sec.remove();
    },
  };
}
